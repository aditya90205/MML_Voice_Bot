import { EventEmitter } from 'node:events';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { getSarvamClient } from './client.js';

/**
 * Streaming TTS via Sarvam WebSocket SDK.
 * Emits: 'audio' { audioBase64, codec }, 'done', 'error', 'close'
 *
 * Note: bulbul:v3 — English female voice `ishita` (not v2 `anushka`).
 */
export class SarvamTtsSession extends EventEmitter {
  /**
   * @param {{ language?: string, speaker?: string }} [options]
   */
  constructor(options = {}) {
    super();
    this.language = options.language || env.SARVAM_TTS_LANGUAGE;
    this.speaker = options.speaker || env.SARVAM_TTS_SPEAKER;
    this.socket = null;
    this.closed = false;
  }

  async connect() {
    const client = getSarvamClient();
    this.socket = await client.textToSpeechStreaming.connect({
      model: env.SARVAM_TTS_MODEL,
      send_completion_event: true,
    });

    if (typeof this.socket.waitForOpen === 'function') {
      await this.socket.waitForOpen();
    } else {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('TTS open timeout')), 10000);
        this.socket.once('open', () => {
          clearTimeout(timer);
          resolve();
        });
        this.socket.once('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    }

    this.socket.configureConnection({
      type: 'config',
      data: {
        speaker: this.speaker,
        language_code: this.language,
        pace: env.SARVAM_TTS_PACE,
        output_audio_codec: env.SARVAM_TTS_CODEC,
        min_buffer_size: 30,
        max_chunk_length: 180,
      },
    });

    this.socket.on('message', (message) => {
      if (message?.type === 'audio' && message?.data?.audio) {
        this.emit('audio', {
          audioBase64: message.data.audio,
          codec: env.SARVAM_TTS_CODEC,
        });
        return;
      }

      const eventType = message?.data?.event_type || message?.event_type;
      if (eventType === 'final' || message?.type === 'final') {
        this.emit('done');
      }
    });

    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => {
      this.closed = true;
      this.emit('close');
    });

    logger.info({ language: this.language, speaker: this.speaker }, 'Sarvam TTS connected');
  }

  /**
   * @param {string} text
   */
  speak(text) {
    if (!this.socket || this.closed) {
      throw new Error('TTS session is not connected');
    }
    this.socket.convert(text);
    if (typeof this.socket.flush === 'function') {
      this.socket.flush();
    }
  }

  close() {
    this.closed = true;
    try {
      this.socket?.close?.();
    } catch {
      // ignore
    }
  }
}

/**
 * One-shot helper using REST TTS (more reliable than WS for short greetings).
 */
export async function synthesizeSpeech(text, options = {}) {
  const client = getSarvamClient();
  const language = options.language || env.SARVAM_TTS_LANGUAGE;
  const speaker = options.speaker || env.SARVAM_TTS_SPEAKER;

  logger.info(
    { language, speaker, pace: env.SARVAM_TTS_PACE, chars: text.length },
    'Sarvam TTS REST convert'
  );

  const response = await client.textToSpeech.convert({
    text,
    target_language_code: language,
    model: env.SARVAM_TTS_MODEL,
    speaker,
    pace: env.SARVAM_TTS_PACE,
  });

  // SDK may return audios[] as base64 strings, or nested objects.
  const audios = response?.audios || response?.audio || [];
  const list = Array.isArray(audios) ? audios : [audios];

  const audioBase64Chunks = list
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'string') return item;
      return item.audio || item.data || null;
    })
    .filter(Boolean);

  if (audioBase64Chunks.length === 0) {
    logger.error({ responseKeys: Object.keys(response || {}) }, 'Empty TTS response');
    throw new Error('Empty TTS response from Sarvam');
  }

  return {
    audioBase64Chunks,
    codec: env.SARVAM_TTS_CODEC,
  };
}

export default SarvamTtsSession;
