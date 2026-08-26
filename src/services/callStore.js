import { CALL_STATUS } from '../config/constants.js';
import { createId } from '../utils/id.js';
import { createEmptyIntake } from './matrimony/slots.js';

/**
 * In-memory call state.
 * Swap for Redis/Postgres when you need multi-instance + durable history.
 */
class CallStore {
  constructor() {
    /** @type {Map<string, object>} */
    this.calls = new Map();
    /** @type {Map<string, string>} userId → active/ringing callId */
    this.activeByUser = new Map();
  }

  create({
    userId,
    socketId,
    language,
    systemPrompt,
    greetingText,
    metadata = {},
  }) {
    const callId = createId('call');
    const now = new Date().toISOString();
    const call = {
      callId,
      userId,
      socketId,
      status: CALL_STATUS.RINGING,
      language,
      systemPrompt,
      greetingText,
      metadata,
      intake: createEmptyIntake(),
      interviewStep: 'greeting',
      createdAt: now,
      updatedAt: now,
      ringingAt: now,
      answeredAt: null,
      endedAt: null,
      endReason: null,
      transcript: [],
    };

    this.calls.set(callId, call);
    this.activeByUser.set(userId, callId);
    return call;
  }

  get(callId) {
    return this.calls.get(callId) ?? null;
  }

  getActiveForUser(userId) {
    const callId = this.activeByUser.get(userId);
    return callId ? this.calls.get(callId) ?? null : null;
  }

  update(callId, patch) {
    const call = this.calls.get(callId);
    if (!call) return null;
    Object.assign(call, patch, { updatedAt: new Date().toISOString() });
    this.calls.set(callId, call);
    return call;
  }

  markActive(callId) {
    return this.update(callId, {
      status: CALL_STATUS.ACTIVE,
      answeredAt: new Date().toISOString(),
    });
  }

  appendTranscript(callId, entry) {
    const call = this.calls.get(callId);
    if (!call) return null;
    call.transcript.push({
      ...entry,
      at: new Date().toISOString(),
    });
    call.updatedAt = new Date().toISOString();
    return call;
  }

  end(callId, { status = CALL_STATUS.ENDED, reason } = {}) {
    const call = this.calls.get(callId);
    if (!call) return null;

    if (
      call.status === CALL_STATUS.ENDED ||
      call.status === CALL_STATUS.REJECTED ||
      call.status === CALL_STATUS.MISSED ||
      call.status === CALL_STATUS.FAILED
    ) {
      return call;
    }

    const ended = this.update(callId, {
      status,
      endReason: reason,
      endedAt: new Date().toISOString(),
    });

    const active = this.activeByUser.get(call.userId);
    if (active === callId) {
      this.activeByUser.delete(call.userId);
    }

    return ended;
  }

  list({ limit = 50 } = {}) {
    return Array.from(this.calls.values())
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }
}

export const callStore = new CallStore();
export default callStore;
