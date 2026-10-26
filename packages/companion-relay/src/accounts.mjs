import { randomBytes, randomUUID } from 'node:crypto';
import { ROOM_ID } from './store.mjs';
import { DEVICE_TICKET, HASH, PRESENCE_TTL_MS, REQUEST_TTL_MS, TICKET_TTL_MS, UUID,
  base64, deny, exact, hash, publicKeyFingerprint, registration, validEnvelope } from './account-validation.mjs';

export class Accounts {
  constructor(store, { limits, now = Date.now, onTicketsRevoked = () => {}, onRoomsRevoked = () => {} }) {
    this.store = store;
    this.limits = limits;
    this.now = now;
    this.tickets = new Map(); // Only SHA-256 digests, never raw bearer tickets.
    this.onTicketsRevoked = onTicketsRevoked;
    this.onRoomsRevoked = onRoomsRevoked;
  }

  deviceDto(device) {
    return { deviceId: device.deviceId, deviceName: device.deviceName, kind: device.kind,
      publicKey: device.publicKey, fingerprint: device.fingerprint,
      online: !device.revoked && this.now() - device.lastSeenAt < PRESENCE_TTL_MS,
      lastSeenAt: device.lastSeenAt };
  }

  generation(deviceId) { return this.store.devices.get(deviceId)?.generation ?? 0; }

  session(accountId, input, generation = this.generation(input.deviceId)) {
    registration(input);
    this.pruneTickets();
    if (this.generation(input.deviceId) !== generation) deny('unauthorized', 401);
    let device = this.store.devices.get(input.deviceId);
    if (device && (device.accountId !== accountId || device.kind !== input.kind || device.publicKey !== input.publicKey)) deny('conflict', 409);
    if (!device) {
      const devices = [...this.store.devices.values()];
      if (devices.length >= this.limits.maxDevices
        || devices.filter(item => item.accountId === accountId).length >= this.limits.maxDevicesPerAccount
        || (!devices.some(item => item.accountId === accountId)
          && new Set(devices.map(item => item.accountId)).size >= this.limits.maxAccounts)) deny('capacity', 503);
    }
    this.store.transaction(() => {
      if (!device) {
        device = { ...input, accountId, fingerprint: publicKeyFingerprint(input.publicKey),
          lastSeenAt: this.now(), revoked: false, generation: 0 };
        this.store.devices.set(device.deviceId, device);
      } else Object.assign(device, { deviceName: input.deviceName, revoked: false, lastSeenAt: this.now() });
    });
    const existing = [...this.tickets].filter(([, ticket]) => ticket.deviceId === device.deviceId);
    while (existing.length >= 2) this.removeTickets([existing.shift()[0]]);
    const deviceToken = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + TICKET_TTL_MS;
    this.tickets.set(hash(deviceToken), { accountId, deviceId: device.deviceId, kind: device.kind, expiresAt });
    return { v: 2, accountId, deviceToken, expiresAt, device: this.deviceDto(device) };
  }

  removeTickets(hashes) {
    for (const digest of hashes) this.tickets.delete(digest);
    if (hashes.length) this.onTicketsRevoked(hashes);
  }

  pruneTickets() {
    this.removeTickets([...this.tickets].filter(([, ticket]) => ticket.expiresAt <= this.now()
      || this.store.devices.get(ticket.deviceId)?.revoked !== false).map(([digest]) => digest));
  }

  authorizeHash(digest) {
    const ticket = this.tickets.get(digest);
    if (!ticket || ticket.expiresAt <= this.now() || this.store.devices.get(ticket.deviceId)?.revoked !== false) deny('unauthorized', 401);
    return ticket;
  }

  authorize(token) {
    if (typeof token !== 'string' || !DEVICE_TICKET.test(token) || !base64(token, 32)) deny('unauthorized', 401);
    const digest = hash(token);
    return { ...this.authorizeHash(digest), digest };
  }

  presence(ticket) {
    const device = this.store.devices.get(ticket.deviceId);
    // Repeated polls and pongs do not cause a disk write on every message.
    if (this.now() - device.lastSeenAt >= 60_000) this.store.transaction(() => { device.lastSeenAt = this.now(); });
  }

  devices(ticket) {
    return { devices: [...this.store.devices.values()].filter(device => device.accountId === ticket.accountId && !device.revoked)
      .map(device => this.deviceDto(device)).sort((a, b) => a.deviceId.localeCompare(b.deviceId)) };
  }

  requestDto(request) {
    return { requestId: request.requestId, accountId: request.accountId, challenge: request.challenge,
      desktop: this.deviceDto(this.store.devices.get(request.desktopDeviceId)),
      phone: this.deviceDto(this.store.devices.get(request.phoneDeviceId)),
      createdAt: request.createdAt, expiresAt: request.expiresAt, status: request.status,
      ...(request.status === 'approved' ? { roomId: request.roomId, envelope: { ...request.envelope } } : {}) };
  }

  request(ticket, requestId) {
    const request = this.store.requests.get(requestId);
    if (!request || request.accountId !== ticket.accountId
      || ![request.desktopDeviceId, request.phoneDeviceId].includes(ticket.deviceId)) deny('not_found', 404);
    if (request.expiresAt <= this.now()) deny('expired', 410);
    return request;
  }

  requests(ticket) {
    return { requests: [...this.store.requests.values()].filter(request => request.accountId === ticket.accountId
      && [request.desktopDeviceId, request.phoneDeviceId].includes(ticket.deviceId) && request.expiresAt > this.now())
      .map(request => this.requestDto(request)).sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId)) };
  }

  createRequest(ticket, input) {
    if (ticket.kind !== 'phone') deny('forbidden', 403);
    if (!exact(input, ['desktopDeviceId']) || typeof input.desktopDeviceId !== 'string' || !UUID.test(input.desktopDeviceId)) deny('bad_request', 400);
    const desktop = this.store.devices.get(input.desktopDeviceId);
    if (desktop?.accountId !== ticket.accountId || desktop.kind !== 'desktop' || desktop.revoked) deny('not_found', 404);
    const existing = [...this.store.requests.values()].find(request => request.status === 'pending'
      && request.expiresAt > this.now() && request.desktopDeviceId === desktop.deviceId && request.phoneDeviceId === ticket.deviceId);
    if (existing) return this.requestDto(existing);
    const active = [...this.store.requests.values()].filter(request => request.expiresAt > this.now());
    if (active.length >= this.limits.maxRequests
      || active.filter(request => request.accountId === ticket.accountId).length >= this.limits.maxRequestsPerAccount) deny('capacity', 503);
    const request = { requestId: randomUUID(), accountId: ticket.accountId, challenge: randomBytes(32).toString('base64url'),
      desktopDeviceId: desktop.deviceId, phoneDeviceId: ticket.deviceId,
      createdAt: this.now(), expiresAt: this.now() + REQUEST_TTL_MS, status: 'pending' };
    this.store.transaction(() => {
      for (const [id, item] of this.store.requests) if (item.expiresAt <= this.now()) this.store.requests.delete(id);
      this.store.requests.set(request.requestId, request);
    });
    return this.requestDto(request);
  }

  desktopRequest(ticket, requestId) {
    const request = this.request(ticket, requestId);
    if (ticket.kind !== 'desktop' || request.desktopDeviceId !== ticket.deviceId) deny('forbidden', 403);
    if (request.status !== 'pending') deny('conflict', 409);
    return request;
  }

  approve(ticket, requestId, input) {
    const request = this.desktopRequest(ticket, requestId);
    if (!exact(input, ['roomId', 'desktopTokenHash', 'phoneTokenHash', 'envelope'])
      || typeof input.roomId !== 'string' || !ROOM_ID.test(input.roomId)
      || typeof input.desktopTokenHash !== 'string' || !HASH.test(input.desktopTokenHash)
      || typeof input.phoneTokenHash !== 'string' || !HASH.test(input.phoneTokenHash)
      || input.desktopTokenHash === input.phoneTokenHash || !validEnvelope(input.envelope)) deny('bad_request', 400);
    if (this.store.rooms.has(input.roomId)) deny('conflict', 409);
    if (this.store.rooms.size >= this.store.maxRooms) deny('capacity', 503);
    this.store.transaction(() => {
      this.store.rooms.set(input.roomId, { id: input.roomId, desktopHash: input.desktopTokenHash, phoneHash: input.phoneTokenHash,
        accountId: ticket.accountId, desktopDeviceId: request.desktopDeviceId, phoneDeviceId: request.phoneDeviceId,
        createdAt: this.now(), enrolled: true, revoked: false });
      Object.assign(request, { status: 'approved', roomId: input.roomId, envelope: { ...input.envelope } });
    });
    return this.requestDto(request);
  }

  reject(ticket, requestId, input) {
    if (!exact(input, [])) deny('bad_request', 400);
    const request = this.desktopRequest(ticket, requestId);
    this.store.transaction(() => { request.status = 'rejected'; });
    return this.requestDto(request);
  }

  revokeRoom(ticket, roomId, input) {
    if (!exact(input, [])) deny('bad_request', 400);
    const room = this.store.rooms.get(roomId);
    if (room?.accountId !== ticket.accountId || ![room.desktopDeviceId, room.phoneDeviceId].includes(ticket.deviceId)) deny('not_found', 404);
    try { if (!room.revoked) this.store.revoke(room); }
    finally { if (room.revoked) this.onRoomsRevoked([roomId]); }
    return { ok: true };
  }

  deleteDevice(ticket) {
    const rooms = [...this.store.rooms.values()].filter(room => room.accountId === ticket.accountId
      && [room.desktopDeviceId, room.phoneDeviceId].includes(ticket.deviceId));
    try { this.store.transaction(() => {
      // Keep immutable identity tombstones; logout cannot allow silent key replacement.
      const device = this.store.devices.get(ticket.deviceId);
      device.revoked = true;
      device.generation = (device.generation ?? 0) + 1;
      for (const [id, request] of this.store.requests) if ([request.desktopDeviceId, request.phoneDeviceId].includes(ticket.deviceId)) this.store.requests.delete(id);
      for (const room of rooms) { room.revoked = true; delete room.push; }
    }); } finally {
      if (this.store.devices.get(ticket.deviceId).revoked) {
        this.removeTickets([...this.tickets].filter(([, item]) => item.deviceId === ticket.deviceId).map(([digest]) => digest));
        this.onRoomsRevoked(rooms.map(room => room.id));
      }
    }
    return { ok: true };
  }
}
