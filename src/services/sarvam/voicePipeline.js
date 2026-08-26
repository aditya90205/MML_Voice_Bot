import { EventEmitter } from 'node:events';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { callStore } from '../callStore.js';
import { SarvamSttSession } from './sttSession.js';
import { synthesizeSpeech } from './ttsSession.js';
import {
  MATRIMONY_STEPS,
  MML_GREETING,
  MML_THANKS,
  createEmptyIntake,
} from '../matrimony/slots.js';
import { extractIntakeAnswer } from '../matrimony/extract.js';

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isEchoOf(assistantText, userText) {
  const a = normalizeText(assistantText);
  const u = normalizeText(userText);
  if (!a || !u) return false;
  if (u === a) return true;
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

function isWeakUtterance(text) {
  const t = normalizeText(text);
  if (!t) return true;
  if (t.replace(/\s/g, '').length < 2) return true;
  const fillers = new Set(['अ', 'उम्', 'हम्', 'hmm', 'uh', 'um', 'ah', 'aa']);
  const words = t.split(' ').filter(Boolean);
  return words.length === 1 && fillers.has(words[0]);
}

function pcmRms(audioBase64) {
  try {
    const buf = Buffer.from(audioBase64, 'base64');
    if (buf.length < 4) return 0;
    let sum = 0;
    const samples = Math.floor(buf.length / 2);
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const s = buf.readInt16LE(i);
      sum += s * s;
    }
    return Math.sqrt(sum / Math.max(1, samples));
  } catch {
    return 0;
  }
}

function estimatePlaybackMs(text, audioBase64Len = 0) {
  const audioBytes = Math.floor((audioBase64Len || 0) * 0.75);
  const fromAudio = audioBytes > 0 ? Math.ceil((audioBytes * 8) / 96000) * 1000 : 0;
  const fromText = Math.ceil(String(text || '').length * 65);
  const raw = Math.max(fromText, fromAudio);
  // Pace > 1 means shorter audio; scale wait slightly so listening opens sooner.
  const pace = Math.max(0.5, Number(env.SARVAM_TTS_PACE) || 1);
  const scaled = Math.floor(raw / pace);
  return Math.min(12000, Math.max(1000, Math.floor(scaled * 0.8) + 350));
}

/**
 * MML matrimony intake voice pipeline (half-duplex):
 * Greeting → name → gender → DOB → partner details → thanks → end call
 */
export class VoicePipeline extends EventEmitter {
  constructor(options) {
    super();
    this.callId = options.callId;
    this.language = options.language || env.SARVAM_STT_LANGUAGE;
    this.greetingText = options.greetingText || env.AI_GREETING_TEXT || MML_GREETING;
    this.stt = null;
    this.history = [];
    this.busy = false;
    this.closed = false;
    this.listeningEnabled = false;
    this.speaking = false;
    this.lastAssistantText = '';
    this.listenOpenedAt = 0;
    this.userSpeechDetected = false;
    this.lastActivityAt = Date.now();
    this._playbackDoneResolve = null;
    this.speakGeneration = 0;

    this.stepIndex = 0;
    this.intake = createEmptyIntake();
    this.interviewDone = false;
  }

  async start() {
    this.stt = new SarvamSttSession({ language: this.language });
    this.stt.on('transcript', (payload) => this.#onTranscript(payload));
    this.stt.on('vad', (payload) => {
      this.emit('vad', payload);
      const eventType = String(payload?.eventType || '');
      if (!this.listeningEnabled || this.closed) return;
      if (/START_SPEECH/i.test(eventType)) {
        this.userSpeechDetected = true;
        logger.info({ callId: this.callId }, 'User speech started (VAD)');
      }
      if (/END_SPEECH/i.test(eventType) && this.userSpeechDetected) {
        this.stt?.flush();
      }
    });
    this.stt.on('error', (err) => {
      logger.error({ err, callId: this.callId }, 'STT error');
      if (!/audio.*must not be None/i.test(err?.message || '')) {
        this.emit('error', err);
      }
    });
    this.stt.on('close', () => logger.info({ callId: this.callId }, 'STT closed'));

    await this.stt.connect();
    this.stt.setPaused(true);

    callStore.update(this.callId, {
      intake: { ...this.intake },
      interviewStep: MATRIMONY_STEPS[0]?.id || 'name',
    });

    await this.speakText(this.greetingText || MML_GREETING, { persist: true });
    const first = MATRIMONY_STEPS[0];
    if (first) {
      await this.speakText(first.question, { persist: true });
    }

    this.#openListening();
  }

  pushAudio(audioBase64, meta = {}) {
    if (this.closed || !this.stt) return;
    if (this.speaking || this.interviewDone) return;
    if (!this.listeningEnabled) return;

    const rms = pcmRms(audioBase64);
    if (rms > 500) {
      this.userSpeechDetected = true;
      this.lastActivityAt = Date.now();
    }

    this.stt.sendAudio(audioBase64, {
      ...meta,
      hasSpeechEnergy: rms > 500,
    });
  }

  flushAudio() {
    if (!this.listeningEnabled || !this.userSpeechDetected || this.interviewDone) return;
    this.stt?.flush();
  }

  notifyPlaybackDone() {
    if (typeof this._playbackDoneResolve === 'function') {
      logger.info({ callId: this.callId }, 'playback_done received from mobile');
      this._playbackDoneResolve('done');
    }
  }

  #openListening() {
    if (this.interviewDone || this.closed) return;
    this.busy = false;
    this.listeningEnabled = true;
    this.userSpeechDetected = false;
    this.listenOpenedAt = Date.now();
    this.stt?.setPaused(false);
    logger.info(
      { callId: this.callId, step: MATRIMONY_STEPS[this.stepIndex]?.id },
      'Listening for user response'
    );
    this.emit('listening', { callId: this.callId, listening: true });
  }

  async #onTranscript({ text, isFinal }) {
    if (this.closed || this.interviewDone || !this.listeningEnabled) return;
    if (this.busy) return;
    if (!isFinal || !text?.trim()) return;

    const trimmed = text.trim();
    const sinceListen = Date.now() - this.listenOpenedAt;

    if (!this.userSpeechDetected) {
      logger.info(
        { callId: this.callId, text: trimmed.slice(0, 80) },
        'Ignoring transcript before real user speech'
      );
      return;
    }

    if (sinceListen < 2000) {
      if (isEchoOf(this.lastAssistantText, trimmed) || isEchoOf(this.greetingText, trimmed)) {
        logger.info({ callId: this.callId, text: trimmed.slice(0, 80) }, 'Ignoring echo transcript');
        return;
      }
    }

    if (isWeakUtterance(trimmed)) {
      logger.info({ callId: this.callId, text: trimmed.slice(0, 80) }, 'Ignoring weak utterance');
      return;
    }

    logger.info({ callId: this.callId, text: trimmed.slice(0, 120) }, 'STT transcript (user)');
    this.emit('transcript', { role: 'user', text: trimmed, isFinal: true });
    this.lastActivityAt = Date.now();

    await this.#handleUserUtterance(trimmed);
  }

  async #handleUserUtterance(text) {
    if (this.closed || this.interviewDone) return;
    if (this.busy) return;

    this.busy = true;
    this.listeningEnabled = false;
    this.speaking = false;
    this.stt?.setPaused(true);
    this.emit('listening', { callId: this.callId, listening: false });

    try {
      callStore.appendTranscript(this.callId, { role: 'user', text });
      this.history.push({ role: 'user', content: text });

      const step = MATRIMONY_STEPS[this.stepIndex];
      if (!step) {
        await this.#finishInterview();
        return;
      }

      logger.info(
        { callId: this.callId, field: step.field, text: text.slice(0, 80) },
        'Extracting matrimony field'
      );

      const extracted = await extractIntakeAnswer({
        field: step.field,
        question: step.question,
        userText: text,
      });

      if (!extracted.ok) {
        const retry = `माफ़ कीजिए, मैं सही से समझ नहीं पाई। ${step.question}`;
        logger.info({ callId: this.callId, field: step.field }, 'Field extract failed — re-asking');
        await this.speakText(retry, { persist: true });
        return;
      }

      const saved = extracted.normalized || extracted.value;
      this.intake[step.field] = saved;

      callStore.update(this.callId, {
        intake: { ...this.intake },
        interviewStep: step.id,
      });

      this.emit('intake_updated', {
        callId: this.callId,
        field: step.field,
        value: saved,
        intake: { ...this.intake },
      });

      logger.info(
        { callId: this.callId, field: step.field, value: saved },
        'Matrimony field saved'
      );

      this.stepIndex += 1;

      if (this.stepIndex >= MATRIMONY_STEPS.length) {
        await this.#finishInterview();
        return;
      }

      const next = MATRIMONY_STEPS[this.stepIndex];
      callStore.update(this.callId, { interviewStep: next.id });
      await this.speakText(next.question, { persist: true });
    } catch (err) {
      logger.error({ err, callId: this.callId }, 'Failed to process matrimony utterance');
      this.emit('error', err);
    } finally {
      if (!this.interviewDone && !this.speaking && !this.listeningEnabled && !this.closed) {
        this.#openListening();
      } else if (!this.interviewDone) {
        this.busy = false;
      }
    }
  }

  async #finishInterview() {
    this.intake.completed = true;
    this.intake.completedAt = new Date().toISOString();
    this.interviewDone = true;
    this.listeningEnabled = false;
    this.stt?.setPaused(true);

    callStore.update(this.callId, {
      intake: { ...this.intake },
      interviewStep: 'completed',
    });

    logger.info({ callId: this.callId, intake: this.intake }, 'MML intake complete');

    await this.speakText(MML_THANKS, { persist: true });

    this.emit('interview_complete', {
      callId: this.callId,
      intake: { ...this.intake },
    });
  }

  async speakText(text, opts = {}) {
    if (!text?.trim() || this.closed) return 'aborted';

    const gen = ++this.speakGeneration;
    this.listeningEnabled = false;
    this.userSpeechDetected = false;
    this.speaking = true;
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
        if (this.closed || gen !== this.speakGeneration) break;
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
      const settleMs = waitMs + 800;
      logger.info({ callId: this.callId, waitMs: settleMs }, 'Waiting for AI playback to finish');
      return await this.#waitForPlayback(settleMs);
    } finally {
      this.speaking = false;
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
      this._playbackDoneResolve = (reason = 'done') => finish(reason);
    });
  }

  isIdle(idleMs) {
    if (!this.listeningEnabled || this.busy || this.speaking || this.interviewDone) return false;
    return Date.now() - this.lastActivityAt > idleMs;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.listeningEnabled = false;
    this.speaking = false;
    if (this._playbackDoneResolve) this._playbackDoneResolve('close');
    this.stt?.close();
    this.removeAllListeners();
  }
}

export default VoicePipeline;
