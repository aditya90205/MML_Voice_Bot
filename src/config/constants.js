export const SOCKET_EVENTS = Object.freeze({
  // Client → Server
  REGISTER: 'register',
  UNREGISTER: 'unregister',
  CALL_ACCEPT: 'call_accept',
  CALL_REJECT: 'call_reject',
  CALL_END: 'call_end',
  AUDIO_CHUNK: 'audio_chunk',
  AUDIO_FLUSH: 'audio_flush',
  PLAYBACK_DONE: 'playback_done',
  PING: 'client_ping',

  // Server → Client
  REGISTERED: 'registered',
  INCOMING_AI_CALL: 'incoming_ai_call',
  CALL_STARTED: 'call_started',
  CALL_ENDED: 'call_ended',
  CALL_REJECTED: 'call_rejected',
  CALL_MISSED: 'call_missed',
  CALL_ERROR: 'call_error',
  TRANSCRIPT: 'transcript',
  AI_AUDIO_CHUNK: 'ai_audio_chunk',
  AI_SPEAKING: 'ai_speaking',
  AI_INTERRUPTED: 'ai_interrupted',
  LISTENING: 'listening',
  INTAKE_UPDATED: 'intake_updated',
  INTERVIEW_COMPLETE: 'interview_complete',
  PONG: 'server_pong',
  ERROR: 'error',
});

export const CALL_STATUS = Object.freeze({
  RINGING: 'ringing',
  ACTIVE: 'active',
  ENDED: 'ended',
  REJECTED: 'rejected',
  MISSED: 'missed',
  FAILED: 'failed',
});

export const CALL_END_REASONS = Object.freeze({
  USER_HANGUP: 'user_hangup',
  ADMIN_HANGUP: 'admin_hangup',
  REJECTED: 'rejected',
  MISSED: 'missed',
  TIMEOUT: 'timeout',
  MAX_DURATION: 'max_duration',
  IDLE: 'idle',
  DISCONNECT: 'disconnect',
  ERROR: 'error',
  INTERVIEW_COMPLETE: 'interview_complete',
});
