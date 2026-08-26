import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';

function pcmToWavBuffer(pcmBuffer, sampleRate = 16000, channels = 1, bitDepth = 16) {
  const blockAlign = (channels * bitDepth) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function looksLikeWavBase64(audioBase64) {
  try {
    const head = Buffer.from(audioBase64.slice(0, 16), 'base64').toString('ascii');
    return head.startsWith('RIFF');
  } catch {
    return false;
  }
}

/**
 * Sarvam STT session with PCM buffering + silence auto-flush.
 * Sending many tiny WAV frames is unreliable; we batch ~600ms of PCM.
 */
export class SarvamSttSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.language = options.language || env.SARVAM_STT_LANGUAGE;
    this.mode = options.mode || env.SARVAM_STT_MODE;
    this.sampleRate = options.sampleRate || env.SARVAM_STT_SAMPLE_RATE;
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.keepAliveTimer = null;
    this.paused = false;
    this.pcmChunks = [];
    this.pcmBytes = 0;
    this.flushTimer = null;
    // ~600ms of 16kHz s16le mono
    this.targetBatchBytes = Math.floor(this.sampleRate * 2 * 0.6);
  }

  async connect() {
    const params = new URLSearchParams({
      'language-code': this.language,
      model: env.SARVAM_STT_MODEL,
      mode: this.mode,
      sample_rate: String(this.sampleRate),
      high_vad_sensitivity: 'true',
      vad_signals: 'true',
      flush_signal: 'true',
      input_audio_codec: 'wav',
    });

    const url = `wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`;

    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          'Api-Subscription-Key': env.SARVAM_API_KEY,
        },
      });

      const onOpen = () => {
        cleanup();
        this.ready = true;
        this.#startKeepAlive();
        logger.info({ language: this.language, mode: this.mode }, 'Sarvam STT connected');
        resolve();
      };

      const onError = (err) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        this.ws?.off('open', onOpen);
        this.ws?.off('error', onError);
      };

      this.ws.on('open', onOpen);
      this.ws.on('error', onError);
      this.ws.on('message', (data) => this.#onMessage(data));
      this.ws.on('close', (code, reason) => {
        this.ready = false;
        this.closed = true;
        this.#stopKeepAlive();
        this.#clearFlushTimer();
        this.emit('close', { code, reason: reason?.toString() });
      });
    });
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    if (this.paused) {
      this.#clearFlushTimer();
      this.pcmChunks = [];
      this.pcmBytes = 0;
    }
  }

  sendAudio(audioBase64, meta = {}) {
    if (this.paused) return;
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!audioBase64 || typeof audioBase64 !== 'string') return;

    const sampleRate = Number(meta.sampleRate || this.sampleRate);
    const encodingHint = String(meta.encoding || 'pcm_s16le').toLowerCase();
    const alreadyWav = encodingHint.includes('wav') || looksLikeWavBase64(audioBase64);

    if (alreadyWav) {
      this.#sendWavBase64(audioBase64, sampleRate);
      if (meta.hasSpeechEnergy) this.#armSilenceFlush();
      return;
    }

    const pcm = Buffer.from(audioBase64, 'base64');
    if (pcm.length < 2) return;

    this.pcmChunks.push(pcm);
    this.pcmBytes += pcm.length;

    if (this.pcmBytes >= this.targetBatchBytes) {
      this.#flushPcmBatch(sampleRate);
    }

    // Only start end-of-utterance timer when chunk had speech energy.
    if (meta.hasSpeechEnergy) {
      this.#armSilenceFlush();
    }
  }

  flush() {
    if (this.paused) return;
    if (this.pcmBytes > 0) {
      this.#flushPcmBatch(this.sampleRate);
    }
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'flush' }));
  }

  close() {
    this.#stopKeepAlive();
    this.#clearFlushTimer();
    this.ready = false;
    this.closed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'client_close');
    }
  }

  #flushPcmBatch(sampleRate) {
    if (this.pcmBytes < 2) {
      this.pcmChunks = [];
      this.pcmBytes = 0;
      return;
    }
    const pcm = Buffer.concat(this.pcmChunks, this.pcmBytes);
    this.pcmChunks = [];
    this.pcmBytes = 0;
    const wavBase64 = pcmToWavBuffer(pcm, sampleRate).toString('base64');
    this.#sendWavBase64(wavBase64, sampleRate);
  }

  #sendWavBase64(wavBase64, sampleRate) {
    this.ws.send(
      JSON.stringify({
        audio: {
          data: wavBase64,
          sample_rate: String(sampleRate),
          encoding: 'audio/wav',
        },
      })
    );
  }

  #armSilenceFlush() {
    this.#clearFlushTimer();
    // Allow 1–2s user thinking pause mid-phrase before finalizing.
    this.flushTimer = setTimeout(() => {
      if (this.paused || !this.ready) return;
      this.flush();
    }, 2000);
  }

  #clearFlushTimer() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  #onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      logger.warn({ raw: raw.toString().slice(0, 200) }, 'Non-JSON STT message');
      return;
    }

    const type = message.type;

    if (type === 'events') {
      const eventType =
        message?.data?.signal_type ||
        message?.data?.event_type ||
        message?.signal_type;
      this.emit('vad', { eventType, raw: message });
      return;
    }

    if (type === 'data' || message?.data?.transcript) {
      if (this.paused) return;
      const transcript =
        message?.data?.transcript ??
        message?.transcript ??
        message?.data?.text ??
        null;

      if (transcript) {
        this.emit('transcript', {
          text: transcript,
          isFinal: true,
          language: message?.data?.language_code || this.language,
          raw: message,
        });
      }
      return;
    }

    if (type === 'error' || message?.error) {
      const errMsg =
        message.error || message.message || message?.data?.message || 'STT error';

      if (/audio.*must not be None/i.test(String(errMsg))) {
        logger.warn({ message }, 'Ignoring non-fatal STT validation error');
        return;
      }

      logger.error({ message }, 'Sarvam STT error frame');
      this.emit('error', new Error(errMsg));
      return;
    }

    logger.debug({ message }, 'Unhandled STT message');
  }

  #startKeepAlive() {
    this.keepAliveTimer = setInterval(() => {
      if (!this.ready || this.paused) return;
      const silence = Buffer.alloc(3200);
      this.sendAudio(silence.toString('base64'), {
        encoding: 'pcm_s16le',
        sampleRate: this.sampleRate,
      });
    }, 20000);
  }

  #stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}

export default SarvamSttSession;
