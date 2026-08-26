/**
 * In-memory presence store.
 * For multi-instance production, replace with Redis keyed by userId → socketId/device.
 */
class PresenceStore {
  constructor() {
    /** @type {Map<string, { userId: string, socketId: string, deviceId?: string, displayName?: string, fcmToken?: string, connectedAt: string, lastSeenAt: string }>} */
    this.byUserId = new Map();
    /** @type {Map<string, string>} socketId → userId */
    this.bySocketId = new Map();
  }

  upsert({ userId, socketId, deviceId, displayName, fcmToken }) {
    const existing = this.byUserId.get(userId);
    const now = new Date().toISOString();

    // If same user reconnects from a new socket, drop the old mapping.
    if (existing?.socketId && existing.socketId !== socketId) {
      this.bySocketId.delete(existing.socketId);
    }

    const record = {
      userId,
      socketId,
      deviceId: deviceId ?? existing?.deviceId,
      displayName: displayName ?? existing?.displayName,
      fcmToken: fcmToken ?? existing?.fcmToken,
      connectedAt: existing?.connectedAt ?? now,
      lastSeenAt: now,
      isOnline: true,
    };

    this.byUserId.set(userId, record);
    this.bySocketId.set(socketId, userId);
    return record;
  }

  touch(userId) {
    const record = this.byUserId.get(userId);
    if (!record) return null;
    record.lastSeenAt = new Date().toISOString();
    return record;
  }

  removeBySocketId(socketId) {
    const userId = this.bySocketId.get(socketId);
    if (!userId) return null;
    this.bySocketId.delete(socketId);
    const record = this.byUserId.get(userId);
    if (record?.socketId === socketId) {
      this.byUserId.delete(userId);
      return { ...record, isOnline: false };
    }
    return null;
  }

  getByUserId(userId) {
    return this.byUserId.get(userId) ?? null;
  }

  getBySocketId(socketId) {
    const userId = this.bySocketId.get(socketId);
    return userId ? this.byUserId.get(userId) ?? null : null;
  }

  isOnline(userId) {
    return this.byUserId.has(userId);
  }

  listOnline() {
    return Array.from(this.byUserId.values()).map((r) => ({
      userId: r.userId,
      deviceId: r.deviceId,
      displayName: r.displayName,
      socketId: r.socketId,
      connectedAt: r.connectedAt,
      lastSeenAt: r.lastSeenAt,
      isOnline: true,
    }));
  }

  size() {
    return this.byUserId.size;
  }
}

export const presenceStore = new PresenceStore();
export default presenceStore;
