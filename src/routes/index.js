import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { requireApiKey } from '../middleware/apiKeyAuth.js';
import { presenceStore } from '../services/presenceStore.js';
import {
  endCall,
  getCall,
  listCalls,
  triggerAiCall,
} from '../services/callService.js';
import { CALL_END_REASONS, CALL_STATUS } from '../config/constants.js';
import { AppError } from '../utils/errors.js';

const router = Router();

const triggerSchema = z.object({
  userId: z.string().min(1),
  language: z.string().min(2).optional(),
  systemPrompt: z.string().min(1).max(4000).optional(),
  greetingText: z.string().min(1).max(500).optional(),
  metadata: z.record(z.any()).optional(),
});

router.get('/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      service: 'mml-voice-backend',
      env: env.NODE_ENV,
      onlineUsers: presenceStore.size(),
      uptimeSec: Math.round(process.uptime()),
    },
  });
});

router.get('/v1/presence/online', requireApiKey, (_req, res) => {
  res.json({
    success: true,
    data: {
      count: presenceStore.size(),
      users: presenceStore.listOnline(),
    },
  });
});

router.get('/v1/presence/:userId', requireApiKey, (req, res) => {
  const user = presenceStore.getByUserId(req.params.userId);
  res.json({
    success: true,
    data: user
      ? { ...user, isOnline: true }
      : { userId: req.params.userId, isOnline: false },
  });
});

/**
 * POST /api/v1/calls
 * Trigger an in-app AI voice call to a connected mobile user.
 */
router.post('/v1/calls', requireApiKey, (req, res, next) => {
  try {
    const body = triggerSchema.parse(req.body);
    const call = triggerAiCall(body);
    res.status(201).json({
      success: true,
      data: {
        callId: call.callId,
        userId: call.userId,
        status: call.status,
        language: call.language,
        createdAt: call.createdAt,
        ringTimeoutMs: env.CALL_RING_TIMEOUT_MS,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(
        new AppError('Validation failed', {
          statusCode: 400,
          code: 'VALIDATION_ERROR',
          details: err.flatten(),
        })
      );
    }
    return next(err);
  }
});

router.get('/v1/calls', requireApiKey, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json({
    success: true,
    data: listCalls(limit),
  });
});

router.get('/v1/calls/:callId', requireApiKey, (req, res, next) => {
  const call = getCall(req.params.callId);
  if (!call) {
    return next(
      new AppError('Call not found', { statusCode: 404, code: 'CALL_NOT_FOUND' })
    );
  }
  res.json({ success: true, data: call });
});

router.post('/v1/calls/:callId/end', requireApiKey, async (req, res, next) => {
  try {
    const call = getCall(req.params.callId);
    if (!call) {
      throw new AppError('Call not found', { statusCode: 404, code: 'CALL_NOT_FOUND' });
    }
    const ended = await endCall(req.params.callId, {
      status: CALL_STATUS.ENDED,
      reason: CALL_END_REASONS.ADMIN_HANGUP,
    });
    res.json({ success: true, data: ended });
  } catch (err) {
    next(err);
  }
});

export default router;
