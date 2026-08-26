import { env } from '../config/env.js';
import {
  CALL_END_REASONS,
  CALL_STATUS,
  SOCKET_EVENTS,
} from '../config/constants.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/errors.js';
import { callStore } from './callStore.js';
import { presenceStore } from './presenceStore.js';
import { VoicePipeline } from './sarvam/voicePipeline.js';

/** @type {import('socket.io').Server | null} */
let ioRef = null;

/** @type {Map<string, VoicePipeline>} */
const pipelines = new Map();

/** @type {Map<string, NodeJS.Timeout[]>} */
const timers = new Map();

export function bindCallService(io) {
  ioRef = io;
}

function requireIo() {
  if (!ioRef) {
    throw new Error('Socket.IO not bound to call service');
  }
  return ioRef;
}

function clearCallTimers(callId) {
  const list = timers.get(callId) || [];
  for (const t of list) clearTimeout(t);
  timers.delete(callId);
}

function addCallTimer(callId, timer) {
  const list = timers.get(callId) || [];
  list.push(timer);
  timers.set(callId, list);
}

function emitToUser(userId, event, payload) {
  const presence = presenceStore.getByUserId(userId);
  if (!presence) return false;
  requireIo().to(presence.socketId).emit(event, payload);
  return true;
}

function emitToCallSocket(call, event, payload) {
  if (!call?.socketId) return false;
  requireIo().to(call.socketId).emit(event, payload);
  return true;
}

/**
 * Trigger an AI call to an online app user.
 */
export function triggerAiCall({
  userId,
  language,
  systemPrompt,
  greetingText,
  metadata,
}) {
  const presence = presenceStore.getByUserId(userId);
  if (!presence) {
    throw new AppError('User is offline or app is not connected', {
      statusCode: 409,
      code: 'USER_OFFLINE',
      details: {
        hint: 'Ensure the React Native app is open and has emitted the register event over Socket.IO.',
      },
    });
  }

  const existing = callStore.getActiveForUser(userId);
  if (existing) {
    throw new AppError('User already has an active or ringing call', {
      statusCode: 409,
      code: 'CALL_IN_PROGRESS',
      details: { callId: existing.callId, status: existing.status },
    });
  }

  const call = callStore.create({
    userId,
    socketId: presence.socketId,
    language: language || env.SARVAM_STT_LANGUAGE,
    systemPrompt: systemPrompt || env.AI_SYSTEM_PROMPT,
    greetingText: greetingText || env.AI_GREETING_TEXT,
    metadata: metadata || {},
  });

  const payload = {
    callId: call.callId,
    userId: call.userId,
    type: 'INCOMING_AI_CALL',
    callerName: 'Make My Lagan',
    language: call.language,
    ringTimeoutMs: env.CALL_RING_TIMEOUT_MS,
    createdAt: call.createdAt,
  };

  const delivered = emitToUser(userId, SOCKET_EVENTS.INCOMING_AI_CALL, payload);
  if (!delivered) {
    callStore.end(call.callId, {
      status: CALL_STATUS.FAILED,
      reason: CALL_END_REASONS.ERROR,
    });
    throw new AppError('Failed to deliver incoming call event', {
      statusCode: 500,
      code: 'SIGNAL_FAILED',
    });
  }

  const ringTimer = setTimeout(() => {
    const current = callStore.get(call.callId);
    if (current?.status === CALL_STATUS.RINGING) {
      endCall(call.callId, {
        status: CALL_STATUS.MISSED,
        reason: CALL_END_REASONS.MISSED,
      });
    }
  }, env.CALL_RING_TIMEOUT_MS);
  addCallTimer(call.callId, ringTimer);

  logger.info({ callId: call.callId, userId }, 'AI call ringing');
  return call;
}

export async function acceptCall(callId, socketId) {
  const call = callStore.get(callId);
  if (!call) {
    throw new AppError('Call not found', { statusCode: 404, code: 'CALL_NOT_FOUND' });
  }
  if (call.status !== CALL_STATUS.RINGING) {
    throw new AppError(`Call cannot be accepted in status ${call.status}`, {
      statusCode: 409,
      code: 'INVALID_CALL_STATE',
    });
  }
  if (call.socketId !== socketId) {
    throw new AppError('Socket does not own this call', {
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  }

  clearCallTimers(callId);
  callStore.markActive(callId);

  const pipeline = new VoicePipeline({
    callId,
    language: call.language,
    systemPrompt: call.systemPrompt,
    greetingText: call.greetingText,
  });

  pipeline.on('transcript', (entry) => {
    emitToCallSocket(call, SOCKET_EVENTS.TRANSCRIPT, { callId, ...entry });
  });

  pipeline.on('audio', ({ audioBase64, codec }) => {
    logger.info(
      { callId, codec, bytes: audioBase64?.length || 0 },
      'Sending ai_audio_chunk to mobile'
    );
    emitToCallSocket(call, SOCKET_EVENTS.AI_AUDIO_CHUNK, {
      callId,
      audio: audioBase64,
      encoding: codec,
      format: codec,
      mimeType: codec === 'mp3' ? 'audio/mpeg' : `audio/${codec}`,
    });
  });

  pipeline.on('ai_speaking', ({ speaking }) => {
    emitToCallSocket(call, SOCKET_EVENTS.AI_SPEAKING, { callId, speaking });
  });

  pipeline.on('ai_interrupted', () => {
    logger.info({ callId }, 'Notifying mobile: AI interrupted (barge-in)');
    emitToCallSocket(call, SOCKET_EVENTS.AI_INTERRUPTED, { callId });
    emitToCallSocket(call, SOCKET_EVENTS.AI_SPEAKING, { callId, speaking: false });
    emitToCallSocket(call, SOCKET_EVENTS.LISTENING, { callId, listening: true });
  });

  pipeline.on('listening', ({ listening }) => {
    emitToCallSocket(call, SOCKET_EVENTS.LISTENING, { callId, listening });
  });

  pipeline.on('intake_updated', (payload) => {
    emitToCallSocket(call, SOCKET_EVENTS.INTAKE_UPDATED, payload);
  });

  pipeline.on('interview_complete', (payload) => {
    logger.info({ callId, intake: payload?.intake }, 'MML interview complete — ending call');
    emitToCallSocket(call, SOCKET_EVENTS.INTERVIEW_COMPLETE, payload);
    // Hang up after thank-you audio finishes
    setTimeout(() => {
      endCall(callId, {
        status: CALL_STATUS.ENDED,
        reason: CALL_END_REASONS.INTERVIEW_COMPLETE,
      });
    }, 400);
  });

  pipeline.on('error', (err) => {
    emitToCallSocket(call, SOCKET_EVENTS.CALL_ERROR, {
      callId,
      message: err.message || 'Voice pipeline error',
    });
  });

  pipelines.set(callId, pipeline);

  const updated = callStore.get(callId);

  // Tell the app the call is live FIRST, so it can attach audio players
  // before we push the Sarvam greeting on `ai_audio_chunk`.
  emitToCallSocket(updated, SOCKET_EVENTS.CALL_STARTED, {
    callId,
    language: updated.language,
    sampleRate: env.SARVAM_STT_SAMPLE_RATE,
    inputEncoding: 'pcm_s16le',
    outputEncoding: env.SARVAM_TTS_CODEC,
    startedAt: updated.answeredAt,
  });

  // Brief pause so RN can subscribe / open the speaker before greeting arrives.
  await new Promise((resolve) => setTimeout(resolve, 400));

  try {
    await pipeline.start();
  } catch (err) {
    pipelines.delete(callId);
    endCall(callId, {
      status: CALL_STATUS.FAILED,
      reason: CALL_END_REASONS.ERROR,
    });
    throw err;
  }

  // Max call duration
  const maxTimer = setTimeout(() => {
    endCall(callId, {
      status: CALL_STATUS.ENDED,
      reason: CALL_END_REASONS.MAX_DURATION,
    });
  }, env.CALL_MAX_DURATION_MS);
  addCallTimer(callId, maxTimer);

  // Idle watchdog
  const idleTimer = setInterval(() => {
    const p = pipelines.get(callId);
    if (p?.isIdle(env.CALL_IDLE_TIMEOUT_MS)) {
      endCall(callId, {
        status: CALL_STATUS.ENDED,
        reason: CALL_END_REASONS.IDLE,
      });
    }
  }, 10000);
  addCallTimer(callId, idleTimer);

  logger.info({ callId, userId: call.userId }, 'AI call active');
  return updated;
}

export function rejectCall(callId, socketId) {
  const call = callStore.get(callId);
  if (!call) {
    throw new AppError('Call not found', { statusCode: 404, code: 'CALL_NOT_FOUND' });
  }
  if (call.socketId !== socketId) {
    throw new AppError('Socket does not own this call', {
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  }
  return endCall(callId, {
    status: CALL_STATUS.REJECTED,
    reason: CALL_END_REASONS.REJECTED,
  });
}

export function pushAudioChunk(callId, socketId, { audio, encoding, sampleRate }) {
  const call = callStore.get(callId);
  if (!call) {
    throw new AppError('Call not found', { statusCode: 404, code: 'CALL_NOT_FOUND' });
  }
  if (call.status !== CALL_STATUS.ACTIVE) {
    throw new AppError('Call is not active', {
      statusCode: 409,
      code: 'INVALID_CALL_STATE',
    });
  }
  if (call.socketId !== socketId) {
    throw new AppError('Socket does not own this call', {
      statusCode: 403,
      code: 'FORBIDDEN',
    });
  }

  const pipeline = pipelines.get(callId);
  if (!pipeline) {
    throw new AppError('Voice pipeline not ready', {
      statusCode: 409,
      code: 'PIPELINE_NOT_READY',
    });
  }

  pipeline.pushAudio(audio, { encoding, sampleRate });
}

export function flushAudio(callId, socketId) {
  const call = callStore.get(callId);
  if (!call || call.socketId !== socketId) return;
  pipelines.get(callId)?.flushAudio();
}

export function notifyPlaybackDone(callId, socketId) {
  const call = callStore.get(callId);
  if (!call || call.socketId !== socketId) return;
  pipelines.get(callId)?.notifyPlaybackDone();
}

export async function endCall(
  callId,
  { status = CALL_STATUS.ENDED, reason = CALL_END_REASONS.USER_HANGUP } = {}
) {
  const call = callStore.get(callId);
  if (!call) return null;

  if (
    [CALL_STATUS.ENDED, CALL_STATUS.REJECTED, CALL_STATUS.MISSED, CALL_STATUS.FAILED].includes(
      call.status
    )
  ) {
    return call;
  }

  clearCallTimers(callId);

  const pipeline = pipelines.get(callId);
  if (pipeline) {
    await pipeline.close();
    pipelines.delete(callId);
  }

  const ended = callStore.end(callId, { status, reason });

  const event =
    status === CALL_STATUS.MISSED
      ? SOCKET_EVENTS.CALL_MISSED
      : status === CALL_STATUS.REJECTED
        ? SOCKET_EVENTS.CALL_REJECTED
        : SOCKET_EVENTS.CALL_ENDED;

  emitToCallSocket(ended, event, {
    callId,
    status: ended.status,
    reason: ended.endReason,
    endedAt: ended.endedAt,
    intake: ended.intake || null,
  });

  logger.info({ callId, status: ended.status, reason: ended.endReason }, 'AI call ended');
  return ended;
}

export function endCallsForSocket(socketId, reason = CALL_END_REASONS.DISCONNECT) {
  for (const call of callStore.list({ limit: 1000 })) {
    if (
      call.socketId === socketId &&
      (call.status === CALL_STATUS.RINGING || call.status === CALL_STATUS.ACTIVE)
    ) {
      endCall(call.callId, { status: CALL_STATUS.ENDED, reason });
    }
  }
}

export function getCall(callId) {
  return callStore.get(callId);
}

export function listCalls(limit) {
  return callStore.list({ limit });
}
