import { z } from 'zod';
import { SOCKET_EVENTS } from '../config/constants.js';
import { logger } from '../config/logger.js';
import { presenceStore } from '../services/presenceStore.js';
import {
  acceptCall,
  endCall,
  endCallsForSocket,
  flushAudio,
  notifyPlaybackDone,
  pushAudioChunk,
  rejectCall,
} from '../services/callService.js';
import { CALL_END_REASONS, CALL_STATUS } from '../config/constants.js';

const registerSchema = z.object({
  userId: z.string().min(1),
  deviceId: z.string().optional(),
  displayName: z.string().optional(),
  fcmToken: z.string().optional(),
});

const callIdSchema = z.object({
  callId: z.string().min(1),
});

const audioSchema = z.object({
  callId: z.string().min(1),
  audio: z.string().min(1),
  encoding: z.string().optional(),
  sampleRate: z.coerce.number().int().positive().optional(),
});

export function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'Socket connected');

    socket.on(SOCKET_EVENTS.REGISTER, (payload, ack) => {
      try {
        const data = registerSchema.parse(payload || {});
        const record = presenceStore.upsert({
          userId: data.userId,
          socketId: socket.id,
          deviceId: data.deviceId,
          displayName: data.displayName,
          fcmToken: data.fcmToken,
        });

        socket.data.userId = data.userId;
        socket.join(`user:${data.userId}`);

        const response = {
          userId: record.userId,
          socketId: record.socketId,
          isOnline: true,
        };

        socket.emit(SOCKET_EVENTS.REGISTERED, response);
        if (typeof ack === 'function') ack({ success: true, data: response });
        logger.info({ userId: data.userId, socketId: socket.id }, 'User registered');
      } catch (err) {
        const message = err.message || 'Register failed';
        socket.emit(SOCKET_EVENTS.ERROR, { code: 'REGISTER_FAILED', message });
        if (typeof ack === 'function') ack({ success: false, error: message });
      }
    });

    socket.on(SOCKET_EVENTS.UNREGISTER, (_payload, ack) => {
      presenceStore.removeBySocketId(socket.id);
      if (typeof ack === 'function') ack({ success: true });
    });

    socket.on(SOCKET_EVENTS.CALL_ACCEPT, async (payload, ack) => {
      try {
        const { callId } = callIdSchema.parse(payload || {});
        const call = await acceptCall(callId, socket.id);
        if (typeof ack === 'function') {
          ack({ success: true, data: { callId: call.callId, status: call.status } });
        }
      } catch (err) {
        logger.error({ err, socketId: socket.id }, 'call_accept failed');
        socket.emit(SOCKET_EVENTS.CALL_ERROR, {
          callId: payload?.callId,
          message: err.message,
        });
        if (typeof ack === 'function') ack({ success: false, error: err.message });
      }
    });

    socket.on(SOCKET_EVENTS.CALL_REJECT, (payload, ack) => {
      try {
        const { callId } = callIdSchema.parse(payload || {});
        const call = rejectCall(callId, socket.id);
        if (typeof ack === 'function') {
          ack({ success: true, data: { callId: call.callId, status: call.status } });
        }
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, error: err.message });
      }
    });

    socket.on(SOCKET_EVENTS.CALL_END, async (payload, ack) => {
      try {
        const { callId } = callIdSchema.parse(payload || {});
        const call = await endCall(callId, {
          status: CALL_STATUS.ENDED,
          reason: CALL_END_REASONS.USER_HANGUP,
        });
        if (typeof ack === 'function') {
          ack({ success: true, data: { callId: call?.callId, status: call?.status } });
        }
      } catch (err) {
        if (typeof ack === 'function') ack({ success: false, error: err.message });
      }
    });

    socket.on(SOCKET_EVENTS.AUDIO_CHUNK, (payload) => {
      try {
        const data = audioSchema.parse(payload || {});
        // Throttled visibility so we can confirm mic uplink during testing
        const now = Date.now();
        if (!socket.data._lastAudioLogAt || now - socket.data._lastAudioLogAt > 2000) {
          socket.data._lastAudioLogAt = now;
          logger.info(
            {
              callId: data.callId,
              encoding: data.encoding || 'pcm_s16le',
              sampleRate: data.sampleRate || 16000,
              bytes: data.audio?.length || 0,
            },
            'Received audio_chunk from mobile'
          );
        }
        pushAudioChunk(data.callId, socket.id, {
          audio: data.audio,
          encoding: data.encoding,
          sampleRate: data.sampleRate,
        });
      } catch (err) {
        logger.warn(
          { err: err.message, socketId: socket.id, keys: Object.keys(payload || {}) },
          'audio_chunk rejected'
        );
      }
    });

    socket.on(SOCKET_EVENTS.AUDIO_FLUSH, (payload) => {
      try {
        const { callId } = callIdSchema.parse(payload || {});
        flushAudio(callId, socket.id);
      } catch {
        // ignore
      }
    });

    socket.on(SOCKET_EVENTS.PLAYBACK_DONE, (payload) => {
      try {
        const { callId } = callIdSchema.parse(payload || {});
        notifyPlaybackDone(callId, socket.id);
      } catch {
        // ignore
      }
    });

    socket.on(SOCKET_EVENTS.PING, (_payload, ack) => {
      const userId = socket.data.userId;
      if (userId) presenceStore.touch(userId);
      socket.emit(SOCKET_EVENTS.PONG, { ts: Date.now() });
      if (typeof ack === 'function') ack({ success: true, ts: Date.now() });
    });

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'Socket disconnected');
      endCallsForSocket(socket.id, CALL_END_REASONS.DISCONNECT);
      presenceStore.removeBySocketId(socket.id);
    });
  });
}
