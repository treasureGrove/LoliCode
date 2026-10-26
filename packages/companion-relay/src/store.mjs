import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_ACCOUNT_LIMITS, UUID, accountId, base64, publicKeyFingerprint, validEnvelope, validName } from './account-validation.mjs';

export const TOKEN = /^[a-f0-9]{64}$/;
export const ROOM_ID = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;

export function credentialHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function matchesCredential(token, expected) {
  if (!TOKEN.test(token) || !HASH.test(expected)) return false;
  return timingSafeEqual(Buffer.from(credentialHash(token), 'hex'), Buffer.from(expected, 'hex'));
}

// Room authentication tokens are never written to disk. Push addresses must be
// recoverable, so they are encrypted using a separate, server-local state key.
export class RoomStore {
  constructor(directory, { maxRooms = 1000, now = Date.now, ...accountOverrides } = {}) {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'rooms.json');
    this.maxRooms = maxRooms;
    this.now = now;
    this.accountLimits = { ...DEFAULT_ACCOUNT_LIMITS, ...accountOverrides };
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const keyPath = join(this.directory, 'push-state.key');
    if (!existsSync(keyPath)) {
      const fd = openSync(keyPath, 'wx', 0o600);
      try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); }
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid companion state key');
    this.rooms = new Map();
    this.devices = new Map();
    this.requests = new Map();
    if (!existsSync(this.path)) return;
    const bytes = readFileSync(this.path);
    if (bytes.length > 16 * 1024 * 1024) throw new Error('Companion state file exceeds limit');
    const value = JSON.parse(bytes.toString('utf8'));
    if (![1, 2].includes(value.v) || !Array.isArray(value.rooms) || value.rooms.length > maxRooms) {
      throw new Error('Invalid companion room state');
    }
    for (const room of value.rooms) {
      if (!room || typeof room.id !== 'string' || !ROOM_ID.test(room.id)
        || typeof room.desktopHash !== 'string' || !HASH.test(room.desktopHash)
        || typeof room.phoneHash !== 'string' || !HASH.test(room.phoneHash) || room.desktopHash === room.phoneHash
        || typeof room.revoked !== 'boolean' || !Number.isSafeInteger(room.createdAt)
        || typeof room.enrolled !== 'boolean' || this.rooms.has(room.id)) {
        throw new Error('Invalid companion room state');
      }
      if (room.push) this.unseal(room.push, room.id); // Corrupt state must fail closed.
      this.rooms.set(room.id, room);
    }
    if (value.v === 2) this.loadAccounts(value);
    // Account bindings are mandatory even when loading an older state shape.
    for (const room of this.rooms.values()) if (room.accountId !== undefined) {
      const desktop = this.devices.get(room.desktopDeviceId);
      const phone = this.devices.get(room.phoneDeviceId);
      if (!accountId(room.accountId) || desktop?.accountId !== room.accountId || desktop.kind !== 'desktop'
        || phone?.accountId !== room.accountId || phone.kind !== 'phone'
        || (!room.revoked && (desktop.revoked || phone.revoked))) throw new Error('Invalid companion account binding');
    }
  }

  loadAccounts(value) {
    const limits = this.accountLimits;
    if (!Array.isArray(value.devices) || value.devices.length > limits.maxDevices
      || !Array.isArray(value.requests) || value.requests.length > limits.maxRequests) throw new Error('Invalid companion account state');
    const accounts = new Map();
    for (const device of value.devices) {
      if (!device || typeof device.deviceId !== 'string' || !UUID.test(device.deviceId) || !accountId(device.accountId)
        || !validName(device.deviceName) || !['desktop', 'phone'].includes(device.kind)
        || publicKeyFingerprint(device.publicKey) !== device.fingerprint || !HASH.test(device.fingerprint ?? '')
        || typeof device.revoked !== 'boolean' || !Number.isSafeInteger(device.lastSeenAt) || device.lastSeenAt < 0
        || (device.generation !== undefined && (!Number.isSafeInteger(device.generation) || device.generation < 0))
        || this.devices.has(device.deviceId)) throw new Error('Invalid companion device state');
      const count = (accounts.get(device.accountId) ?? 0) + 1;
      accounts.set(device.accountId, count);
      if (count > limits.maxDevicesPerAccount || accounts.size > limits.maxAccounts) throw new Error('Companion device state exceeds limit');
      this.devices.set(device.deviceId, device);
    }
    const requestCounts = new Map();
    for (const request of value.requests) {
      const desktop = this.devices.get(request?.desktopDeviceId);
      const phone = this.devices.get(request?.phoneDeviceId);
      if (!request || typeof request.requestId !== 'string' || !UUID.test(request.requestId)
        || !accountId(request.accountId) || !base64(request.challenge, 32)
        || desktop?.accountId !== request.accountId || desktop.kind !== 'desktop'
        || phone?.accountId !== request.accountId || phone.kind !== 'phone'
        || !Number.isSafeInteger(request.createdAt) || request.createdAt < 0
        || !Number.isSafeInteger(request.expiresAt) || request.expiresAt !== request.createdAt + 300_000
        || !['pending', 'approved', 'rejected'].includes(request.status) || this.requests.has(request.requestId)) {
        throw new Error('Invalid companion enrollment state');
      }
      if (request.status === 'approved') {
        const room = this.rooms.get(request.roomId);
        if (!validEnvelope(request.envelope) || room?.accountId !== request.accountId
          || room.desktopDeviceId !== request.desktopDeviceId || room.phoneDeviceId !== request.phoneDeviceId) {
          throw new Error('Invalid companion enrollment binding');
        }
      } else if (request.roomId !== undefined || request.envelope !== undefined) throw new Error('Invalid companion enrollment state');
      const count = (requestCounts.get(request.accountId) ?? 0) + 1;
      requestCounts.set(request.accountId, count);
      if (count > limits.maxRequestsPerAccount) throw new Error('Companion enrollment state exceeds limit');
      this.requests.set(request.requestId, request);
    }
  }

  seal(token, roomId) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`lolicode-companion-push/1|${roomId}`));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  }

  unseal(value, roomId) {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length < 29 || bytes.length > 4124) throw new Error('Invalid push state');
    const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(`lolicode-companion-push/1|${roomId}`));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  }

  persist() {
    const encoded = JSON.stringify({ v: 2, rooms: [...this.rooms.values()],
      devices: [...this.devices.values()], requests: [...this.requests.values()] });
    if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new Error('Companion state file exceeds limit');
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    let committed = false;
    try {
      try { writeFileSync(fd, encoded); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, this.path);
      committed = true;
      if (process.platform !== 'win32') {
        chmodSync(this.path, 0o600);
        const directory = openSync(this.directory, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Keep original state. */ }
      // After rename, disk already contains this transaction. A directory
      // sync/metadata error must not restore stale authorizations in memory.
      if (committed) error.committed = true;
      throw error;
    }
  }

  // One atomic file replacement commits approval and its room together. Rollback
  // restores existing object identities because live sockets reference rooms.
  transaction(change) {
    const snapshots = [this.rooms, this.devices, this.requests].map(map => ({ map,
      entries: [...map].map(([id, value]) => [id, value, structuredClone(value)]) }));
    try { const result = change(); this.persist(); return result; }
    catch (error) {
      if (error.committed) throw error;
      for (const { map, entries } of snapshots) {
        map.clear();
        for (const [id, value, snapshot] of entries) {
          for (const key of Object.keys(value)) delete value[key];
          Object.assign(value, snapshot);
          map.set(id, value);
        }
      }
      throw error;
    }
  }

  create(id, desktopToken, phoneToken) {
    if (this.rooms.has(id) || this.rooms.size >= this.maxRooms || desktopToken === phoneToken) return null;
    const room = { id, desktopHash: credentialHash(desktopToken), phoneHash: credentialHash(phoneToken),
      createdAt: this.now(), enrolled: false, revoked: false };
    this.rooms.set(id, room);
    try { this.persist(); } catch (error) { if (!error.committed) this.rooms.delete(id); throw error; }
    return room;
  }

  enroll(room) {
    if (room.enrolled) return;
    room.enrolled = true;
    try { this.persist(); } catch (error) { if (!error.committed) room.enrolled = false; throw error; }
  }

  registerPush(room, token) {
    const previous = room.push;
    room.push = this.seal(token, room.id);
    try { this.persist(); } catch (error) { if (!error.committed) room.push = previous; throw error; }
  }

  pushToken(room) { return room.push ? this.unseal(room.push, room.id) : null; }

  revoke(room) {
    const revoked = room.revoked;
    const previous = room.push;
    room.revoked = true;
    delete room.push;
    try { this.persist(); } catch (error) { if (!error.committed) { room.revoked = revoked; room.push = previous; } throw error; }
  }
}
