import { EventEmitter } from 'node:events';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { callStore } from '../callStore.js';
import { generateChatReply } from './chat.js';
import { SarvamSttSession } from './sttSession.js';
import { synthesizeSpeech } from './ttsSession.js';

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Only treat as echo when user text is basically the AI line (not shared common words).
 */
function isEchoOf(assistantText, userText) {
  const a = normalizeText(assistantText);
  const u = normalizeText(userText);
  if (!a || !u) return false;
  if (u === a) return true;
  // User repeated a long chunk of AI speech
  if (u.length >= 12 && a.includes(u)) return true;
  if (a.length >= 12 && u.includes(a) && Math.abs(a.length - u.length) < 8) return true;

  const aWords = a.split(' ').filter((w) => w.length > 1);
  const uWords = u.split(' ').filter((w) => w.length > 1);
  if (uWords.length < 3 || aWords.length < 3) return false;

  const similarLen =
    Math.abs(aWords.length - uWords.length) / Math.max(aWords.length, uWords.length) < 0.3;
  if (!similarLen) return false;

  const set = new Set(aWords);
  const overlap = uWords.filter((w) => set.has(w)).length / uWords.length;
  return overlap >= 0.9;
}

function estimatePlaybackMs(text, audioBase64Len = 0) {
  const audioBytes = Math.floor((audioBase64Len || 0) * 0.75);
  // MP3 bitrate varies; use 96kbps estimate and slight under-wait so we listen sooner.
  const fromAudio = audioBytes > 0 ? Math.ceil((audioBytes * 8) / 96000) * 1000 : 0;
  const fromText = Math.ceil(String(text || '').length * 65);
  const raw = Math.max(fromText, fromAudio);
  return Math.min(9000, Math.max(1000, Math.floor(raw * 0.8) + 350));
}

/**
 * Turn-based voice pipeline:
 * AI greets → wait for user → reply → wait again (repeat).
 */
export class VoicePipeline extends EventEmitter {
  constructor(options) {
    super();
    this.callId = options.callId;
    this.language = options.language || env.SARVAM_STT_LANGUAGE;
    this.systemPrompt = options.systemPrompt || env.AI_SYSTEM_PROMPT;
    this.greetingText = options.greetingText || env.AI_GREETING_TEXT;
    this.stt = null;
    this.history = [];
    this.busy = false;
    this.closed = false;
    this.listeningEnabled = false;
    this.lastAssistantText = '';
    this.listenOpenedAt = 0;
    this.lastActivityAt = Date.now();
    this._playbackDoneResolve = null;
  }

  async start() {
    this.stt = new SarvamSttSession({ language: this.language });
    this.stt.on('transcript', (payload) => this.#onTranscript(payload));
    this.stt.on('vad', (payload) => {
      this.emit('vad', payload);
      // End of user speech → force finalize transcript
      if (
        this.listeningEnabled &&
        !this.busy &&
        (payload?.eventType === 'END_SPEECH' || payload?.eventType === 'end_speech')
      ) {
        this.stt?.flush();
      }
    });
    this.stt.on('error', (err) => {
      logger.error({ err, callId: this.callId }, 'STT error');
      if (!/audio.*must not be None/i.test(err?.message || '')) {
        this.emit('error', err);
      }
    });
    this.stt.on('close', () => {
      logger.info({ callId: this.callId }, 'STT closed');
    });

    await this.stt.connect();
    this.stt.setPaused(true);
    this.listeningEnabled = false;

    if (this.greetingText) {
      try {
        await this.speakText(this.greetingText, { persist: true });
      } catch (err) {
        logger.error({ err, callId: this.callId }, 'Greeting TTS failed (call continues)');
        this.emit('error', err);
      }
    }

    this.#openListening();
  }

  pushAudio(audioBase64, meta = {}) {
    if (this.closed || !this.stt || !this.listeningEnabled || this.busy) return;
    this.lastActivityAt = Date.now();
    this.stt.sendAudio(audioBase64, meta);
  }

  flushAudio() {
    if (!this.listeningEnabled || this.busy) return;
    this.stt?.flush();
  }

  /** Mobile should emit this when AI MP3 finished playing. */
  notifyPlaybackDone() {
    if (typeof this._playbackDoneResolve === 'function') {
      logger.info({ callId: this.callId }, 'playback_done received from mobile');
      this._playbackDoneResolve('done');
    }
  }

  #openListening() {
    this.busy = false;
    this.listeningEnabled = true;
    this.listenOpenedAt = Date.now();
    this.stt?.setPaused(false);
    logger.info({ callId: this.callId }, 'Listening for user response');
    this.emit('listening', { callId: this.callId, listening: true });
  }

  async #onTranscript({ text, isFinal }) {
    if (!this.listeningEnabled || this.busy || this.closed) return;
    if (!isFinal || !text?.trim()) return;

    const trimmed = text.trim();
    const sinceListen = Date.now() - this.listenOpenedAt;

    // Only apply echo filter briefly after we reopen the mic.
    if (sinceListen < 1200) {
      if (isEchoOf(this.lastAssistantText, trimmed) || isEchoOf(this.greetingText, trimmed)) {
        logger.info({ callId: this.callId, text: trimmed.slice(0, 80) }, 'Ignoring echo transcript');
        return;
      }
    }

    const words = normalizeText(trimmed).split(' ').filter(Boolean);
    if (words.length < 1) return;

    logger.info({ callId: this.callId, text: trimmed.slice(0, 120) }, 'STT transcript (user)');
    this.emit('transcript', { role: 'user', text: trimmed, isFinal: true });
    this.lastActivityAt = Date.now();

    await this.#handleUserUtterance(trimmed);
  }

  async #handleUserUtterance(text) {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.listeningEnabled = false;
    this.stt?.setPaused(true);
    this.emit('listening', { callId: this.callId, listening: false });

    try {
      callStore.appendTranscript(this.callId, { role: 'user', text });
      this.history.push({ role: 'user', content: text });

      const reply = await generateChatReply({
        messages: this.history,
        systemPrompt: this.systemPrompt,
      });

      logger.info({ callId: this.callId, reply: reply.slice(0, 120) }, 'Chat reply ready');

      this.history.push({ role: 'assistant', content: reply });
      callStore.appendTranscript(this.callId, { role: 'assistant', text: reply });
      this.emit('transcript', { role: 'assistant', text: reply, isFinal: true });

      await this.speakText(reply, { persist: false });
    } catch (err) {
      logger.error({ err, callId: this.callId }, 'Failed to process utterance');
      this.emit('error', err);
    } finally {
      this.#openListening();
    }
  }

  async speakText(text, opts = {}) {
    if (!text?.trim() || this.closed) return;

    this.listeningEnabled = false;
    this.stt?.setPaused(true);
    this.emit('ai_speaking', { speaking: true });
    this.emit('listening', { callId: this.callId, listening: false });

    let totalAudioChars = 0;
    try {
      const { audioBase64Chunks, codec } = await synthesizeSpeech(text, {
        language: this.language,
        speaker: env.SARVAM_TTS_SPEAKER,
      });

      for (const audioBase64 of audioBase64Chunks) {
        if (this.closed) break;
        totalAudioChars += audioBase64?.length || 0;
        this.emit('audio', { audioBase64, codec });
      }

      this.lastAssistantText = text;

      if (opts.persist) {
        this.history.push({ role: 'assistant', content: text });
        callStore.appendTranscript(this.callId, { role: 'assistant', text });
        this.emit('transcript', { role: 'assistant', text, isFinal: true });
      }

      const waitMs = estimatePlaybackMs(text, totalAudioChars);
      logger.info({ callId: this.callId, waitMs }, 'Waiting for AI playback to finish');
      await this.#waitForPlayback(waitMs);
    } finally {
      this.emit('ai_speaking', { speaking: false });
      this.lastActivityAt = Date.now();
    }
  }

  #waitForPlayback(maxMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._playbackDoneResolve = null;
        resolve(reason);
      };

      const timer = setTimeout(() => finish('timeout'), maxMs);
      this._playbackDoneResolve = () => finish('done');
    });
  }

  isIdle(idleMs) {
    return Date.now() - this.lastActivityAt > idleMs;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.listeningEnabled = false;
    if (this._playbackDoneResolve) this._playbackDoneResolve('close');
    this.stt?.close();
    this.removeAllListeners();
  }
}

export default VoicePipeline;
