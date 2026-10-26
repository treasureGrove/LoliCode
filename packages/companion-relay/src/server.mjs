import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { FcmProvider, NOTICE_KINDS } from './fcm.mjs';
import { matchesCredential, ROOM_ID, RoomStore, TOKEN } from './store.mjs';
import { Accounts } from './accounts.mjs';
import { createAccountHandler } from './account-http.mjs';
import { AccountError, DEFAULT_ACCOUNT_LIMITS } from './account-validation.mjs';

const ID = /^[A-Za-z0-9_-]{1,180}$/;
const SESSION_ID = /^[A-Za-z0-9_:-]{1,180}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUSH_TOKEN = /^[A-Za-z0-9_:.\-]{16,4096}$/;
const FIVE_MINUTES = 300_000;
const opposite = role => role === 'desktop' ? 'phone' : 'desktop';
const loopback = address => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
const exactKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const stringMatches = (value, expression) => typeof value === 'string' && expression.test(value);

export const DEFAULT_LIMITS = Object.freeze({ ...DEFAULT_ACCOUNT_LIMITS, maxFrameBytes: 64 * 1024, maxCipherBytes: 48 * 1024,
  maxRooms: 1000, maxConnections: 256, maxQueuePackets: 32, maxQueueBytes: 512 * 1024,
  maxTotalQueueBytes: 16 * 1024 * 1024,
  maxBufferedBytes: 512 * 1024, maxMessagesPerMinute: 600, maxBytesPerMinute: 8 * 1024 * 1024,
  maxIpEntries: 2048, maxHandshakesPerMinute: 60, maxCreatesPerIpPerHour: 20,
  maxSignalFrameBytes: 16 * 1024, maxSignalsPerMinute: 32, maxSignalBytesPerMinute: 256 * 1024,
  maxTotalSignalsPerMinute: 512, maxTotalSignalBytesPerMinute: 2 * 1024 * 1024,
  helloTimeoutMs: 5000, heartbeatMs: 30_000, queueTtlMs: FIVE_MINUTES, replayTtlMs: FIVE_MINUTES });

class ProtocolError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function reject(code) { throw new ProtocolError(code); }

function canonicalBase64(value, min, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) + 2 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length >= min && bytes.length <= max && bytes.toString('base64url') === value;
}

export async function createCompanionRelay({ stateDirectory, host = '127.0.0.1', port = 0,
  allowInsecureLocal = false, trustProxy = true, limits: overrides = {}, now = Date.now,
  pushProvider = new FcmProvider(), store: suppliedStore, forumFetch = fetch, allowLegacyDataRelay = false } = {}) {
  if (!stateDirectory && !suppliedStore) throw new Error('Companion state directory is required');
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid relay limit');
  const store = suppliedStore ?? new RoomStore(stateDirectory, { ...limits, now });
  const connections = new Set();
  const rooms = new Map();
  const ips = new Map();
  let shuttingDown = false;
  let queuedBytes = 0;
  const shutdown = new AbortController();
  const traffic = { httpRequests: 0, httpBytesIn: 0, httpBytesOut: 0, httpMetadataBytesOut: 0, wsControlBytesIn: 0,
    wsControlBytesOut: 0, signalBytesIn: 0, signalBytesOut: 0, signalsOut: 0,
    signalBudgetRejected: 0, httpBudgetRejected: 0,
    relayPacketBytesIn: 0, relayPacketBytesOut: 0, relayPacketsOut: 0 };
  const signalBudget = { at: now(), frames: 0, bytes: 0 };
  const addTraffic = (key, value) => { traffic[key] = Math.min(Number.MAX_SAFE_INTEGER, traffic[key] + value); };
  const accounts = new Accounts(store, { limits, now,
    onTicketsRevoked(hashes) {
      const revoked = new Set(hashes);
      for (const connection of connections) if (revoked.has(connection.ticketHash)) fail(connection, 'unauthorized');
    },
    onRoomsRevoked(ids) { for (const id of ids) revokeRuntime(rooms.get(id)); } });
  function context(request) {
    const local = loopback(request.socket.remoteAddress);
    const forwarded = request.headers['x-forwarded-for'];
    return { secure: Boolean(request.socket.encrypted || (local && trustProxy && request.headers['x-forwarded-proto'] === 'https')
      || (allowInsecureLocal && local)),
    ip: local && trustProxy && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : request.socket.remoteAddress };
  }
  const accountHttp = createAccountHandler({ accounts, limits, forumFetch, signal: shutdown.signal, context, ipState, addTraffic, now });

  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-content-type-options', 'nosniff');
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200).end(JSON.stringify({ ok: true, ready: true, protocol: 1,
        accountProtocol: 2, transportPolicy: 'directOnly', legacyDataRelay: Boolean(allowLegacyDataRelay),
        pushConfigured: Boolean(pushProvider.configured) }));
    } else void accountHttp(request, response);
  });
  server.maxConnections = Math.min(Number.MAX_SAFE_INTEGER, limits.maxConnections + limits.maxConcurrentHttp);
  server.on('clientError', (error, socket) => {
    if (!socket.writable) { socket.destroy(); return; }
    const timeout = error.code === 'ERR_HTTP_REQUEST_TIMEOUT';
    const failure = new AccountError(timeout ? 'request_timeout' : 'bad_request', timeout ? 408 : 400);
    const body = JSON.stringify({ error: { code: failure.code, message: failure.message } });
    addTraffic('httpBytesOut', Buffer.byteLength(body));
    socket.end(`HTTP/1.1 ${failure.status} ${timeout ? 'Request Timeout' : 'Bad Request'}\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxFrameBytes,
    perMessageDeflate: false, clientTracking: false });

  function ipState(ip) {
    const time = now();
    let state = ips.get(ip);
    if (!state) {
      if (ips.size >= limits.maxIpEntries) reject('capacity');
      state = { minute: time, hour: time, handshakes: 0, creates: 0, http: 0, sessions: 0, last: time };
      ips.set(ip, state);
    }
    if (time - state.minute >= 60_000) { state.minute = time; state.handshakes = 0; state.http = 0; state.sessions = 0; }
    if (time - state.hour >= 3_600_000) { state.hour = time; state.creates = 0; }
    state.last = time;
    return state;
  }

  function runtime(room) {
    let state = rooms.get(room.id);
    if (!state) {
      state = { record: room, desktop: null, phone: null, queues: { desktop: [], phone: [] },
        seen: new Map(), notices: new Map(), pendingPush: 0, signalWindow: now(), signalCount: 0, signalBytes: 0 };
      rooms.set(room.id, state);
    }
    return state;
  }

  function send(connection, value) {
    if (connection.ws.readyState !== WebSocket.OPEN) return false;
    if (connection.ticketHash && !connection.failed) {
      try { accounts.authorizeHash(connection.ticketHash); } catch { fail(connection, 'unauthorized'); return false; }
    }
    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
    if (connection.ws.bufferedAmount + Buffer.byteLength(encoded) > limits.maxBufferedBytes) {
      connection.ws.close(1008, 'slow_peer');
      return false;
    }
    connection.ws.send(encoded, error => { if (error) connection.ws.terminate(); });
    const envelope = typeof value === 'string' || value.type === 'packet' || value.type === 'signal';
    const signal = envelope && connection.room?.record.accountId !== undefined;
    addTraffic(signal ? 'signalBytesOut' : envelope ? 'relayPacketBytesOut' : 'wsControlBytesOut', Buffer.byteLength(encoded));
    if (envelope) addTraffic(signal ? 'signalsOut' : 'relayPacketsOut', 1);
    return true;
  }

  function fail(connection, code) {
    if (connection.failed) return;
    connection.failed = true;
    send(connection, { type: 'error', code });
    connection.ws.close(1008, code);
  }

  function revokeRuntime(state, initiator) {
    if (!state) return;
    for (const role of ['phone', 'desktop']) {
      for (const item of state.queues[role]) queuedBytes -= item.bytes;
      state[role]?.ws.close(state[role] === initiator ? 1000 : 1008, 'revoked');
    }
    state.queues = { phone: [], desktop: [] };
    state.seen.clear();
  }

  function prune(state) {
    const time = now();
    for (const role of ['phone', 'desktop']) state.queues[role] = state.queues[role].filter(item => {
      if (time - item.at < (state.record.accountId !== undefined ? Math.min(60_000, limits.queueTtlMs) : limits.queueTtlMs)) return true;
      queuedBytes -= item.bytes;
      return false;
    });
    for (const [id, at] of state.seen) if (time - at >= limits.replayTtlMs) state.seen.delete(id);
    for (const [id, result] of state.notices) if (time - result.at >= FIVE_MINUTES && !result.pending) state.notices.delete(id);
  }

  function forward(connection, value) {
    const state = connection.room;
    const signal = state.record.accountId !== undefined;
    if (!exactKeys(value, ['type', 'v', 'id', 'nonce', 'ciphertext']) || value.v !== 1
      || !stringMatches(value.id, UUID) || !canonicalBase64(value.nonce, 12, 12)
      || !canonicalBase64(value.ciphertext, 16, signal ? limits.maxSignalFrameBytes : limits.maxCipherBytes)) reject(signal ? 'invalid_signal' : 'invalid_packet');
    prune(state);
    const replayKey = `${connection.role}:${value.id}`;
    if (state.seen.has(replayKey)) reject('replayed_packet');
    if (state.seen.size >= 2048) reject('replay_capacity');
    const targetRole = opposite(connection.role);
    const encoded = JSON.stringify({ type: signal ? 'signal' : 'packet', v: 1, id: value.id, nonce: value.nonce,
      ciphertext: value.ciphertext, from: connection.role });
    if (signal) {
      if (Buffer.byteLength(encoded) > limits.maxSignalFrameBytes) reject('invalid_signal');
      if (now() - state.signalWindow >= 60_000) { state.signalWindow = now(); state.signalCount = 0; state.signalBytes = 0; }
      if (++state.signalCount > limits.maxSignalsPerMinute || (state.signalBytes += Buffer.byteLength(encoded)) > limits.maxSignalBytesPerMinute) reject('signal_rate_limited');
      if (now() - signalBudget.at >= 60_000) { signalBudget.at = now(); signalBudget.frames = 0; signalBudget.bytes = 0; }
      if (signalBudget.frames + 1 > limits.maxTotalSignalsPerMinute
        || signalBudget.bytes + Buffer.byteLength(encoded) > limits.maxTotalSignalBytesPerMinute) {
        addTraffic('signalBudgetRejected', 1); reject('signal_budget_exhausted');
      }
      signalBudget.frames++;
      signalBudget.bytes += Buffer.byteLength(encoded);
    }
    const target = state[targetRole];
    if (target && send(target, encoded)) {
      state.seen.set(replayKey, now());
      return;
    }
    // Offers belong to the current live negotiation, never an offline queue.
    if (signal) reject('peer_offline');
    const queue = state.queues[targetRole];
    if (queue.length >= limits.maxQueuePackets || queuedBytes + Buffer.byteLength(encoded) > limits.maxTotalQueueBytes
      || queue.reduce((sum, item) => sum + item.bytes, 0) + Buffer.byteLength(encoded) > limits.maxQueueBytes) reject('queue_full');
    queue.push({ encoded, bytes: Buffer.byteLength(encoded), at: now() });
    queuedBytes += Buffer.byteLength(encoded);
    state.seen.set(replayKey, now());
  }

  function greet(connection, value) {
    if (value.type !== 'hello' || value.v !== 1 || !['desktop', 'phone'].includes(value.role)
      || !exactKeys(value, ['type', 'v', 'role', 'roomId', 'token', 'phoneToken', 'deviceToken'])
      || !stringMatches(value.roomId, ROOM_ID) || !stringMatches(value.token, TOKEN)
      || (value.role === 'phone' && 'phoneToken' in value)) reject('invalid_hello');
    let record = store.rooms.get(value.roomId);
    if (!allowLegacyDataRelay && record?.accountId === undefined) reject('direct_only');
    if (!record) {
      if ('deviceToken' in value) reject('unauthorized');
      if (value.role !== 'desktop' || !stringMatches(value.phoneToken, TOKEN) || value.phoneToken === value.token) reject('unauthorized');
      const ip = ipState(connection.ip);
      if (++ip.creates > limits.maxCreatesPerIpPerHour) reject('rate_limited');
      record = store.create(value.roomId, value.token, value.phoneToken);
      if (!record) reject('capacity');
    }
    let ticket;
    if (record.accountId !== undefined) {
      if ('phoneToken' in value) reject('invalid_hello');
      try { ticket = accounts.authorize(value.deviceToken); } catch { reject('unauthorized'); }
      if (ticket.accountId !== record.accountId || ticket.kind !== value.role
        || ticket.deviceId !== record[value.role === 'desktop' ? 'desktopDeviceId' : 'phoneDeviceId']) reject('unauthorized');
      if ([...connections].filter(peer => peer.accountId === ticket.accountId && !peer.failed).length >= limits.maxSocketsPerAccount) reject('capacity');
    } else if ('deviceToken' in value) reject('unauthorized');
    if (record.revoked || !matchesCredential(value.token, value.role === 'desktop' ? record.desktopHash : record.phoneHash)) reject('unauthorized');
    if (value.role === 'desktop' && value.phoneToken !== undefined
      && !matchesCredential(value.phoneToken, record.phoneHash)) reject('unauthorized');
    if (value.role === 'phone' && !record.enrolled && now() - record.createdAt >= FIVE_MINUTES) reject('pairing_expired');
    const state = runtime(record);
    if (state[value.role]) reject('role_connected');
    if (value.role === 'phone') store.enroll(record);
    state[value.role] = connection;
    connection.room = state;
    connection.role = value.role;
    if (ticket) {
      connection.ticketHash = ticket.digest;
      connection.accountId = ticket.accountId;
      connection.ticketTimer = setTimeout(() => fail(connection, 'unauthorized'), Math.max(1, ticket.expiresAt - now()));
      connection.ticketTimer.unref();
      accounts.presence(ticket);
    }
    clearTimeout(connection.helloTimer);
    send(connection, { type: 'ready', v: 1 });
    send(connection, { type: 'peer', online: Boolean(state[opposite(value.role)]) });
    if (state[opposite(value.role)]) send(state[opposite(value.role)], { type: 'peer', online: true });
    prune(state);
    const pending = state.queues[value.role];
    while (pending.length && send(connection, pending[0].encoded)) queuedBytes -= pending.shift().bytes;
  }

  async function pushNotice(connection, value) {
    if (connection.role !== 'desktop') reject('forbidden');
    if (!exactKeys(value, ['type', 'eventId', 'kind', 'sessionId']) || !stringMatches(value.eventId, ID)
      || !stringMatches(value.sessionId, SESSION_ID) || !NOTICE_KINDS.has(value.kind)) reject('invalid_notice');
    const state = connection.room;
    prune(state);
    const existing = state.notices.get(value.eventId);
    if (existing) {
      if (existing.kind !== value.kind || existing.sessionId !== value.sessionId) reject('event_conflict');
      send(connection, { type: 'push.result', eventId: value.eventId, ...existing.result,
        status: existing.pending ? 'pending' : existing.result.status });
      return;
    }
    if (state.notices.size >= 512 || state.pendingPush >= 4) reject('push_capacity');
    const token = store.pushToken(state.record);
    const result = { accepted: false, delivered: false, status: !pushProvider.configured ? 'unconfigured' : 'unregistered' };
    const entry = { at: now(), kind: value.kind, sessionId: value.sessionId, result, pending: false };
    state.notices.set(value.eventId, entry);
    if (pushProvider.configured && token) {
      entry.pending = true;
      state.pendingPush++;
      try {
        entry.result = await pushProvider.send(token, { roomId: state.record.id,
          eventId: value.eventId, kind: value.kind, sessionId: value.sessionId });
      } catch { entry.result = { accepted: false, delivered: false, status: 'failed' }; }
      finally { entry.pending = false; state.pendingPush--; }
    }
    if (!state.record.revoked) send(connection, { type: 'push.result', eventId: value.eventId, ...entry.result, delivered: false });
  }

  async function message(connection, data, binary) {
    if (connection.failed || connection.ws.readyState !== WebSocket.OPEN) return;
    if (binary || data.byteLength > limits.maxFrameBytes) reject('invalid_frame');
    const time = now();
    if (time - connection.windowAt >= 60_000) { connection.windowAt = time; connection.messages = 0; connection.bytes = 0; }
    if (++connection.messages > limits.maxMessagesPerMinute || (connection.bytes += data.byteLength) > limits.maxBytesPerMinute) reject('rate_limited');
    let value;
    try { value = JSON.parse(data.toString('utf8')); } catch { reject('invalid_json'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject('invalid_message');
    addTraffic(value.type === 'signal' ? 'signalBytesIn' : value.type === 'packet' ? 'relayPacketBytesIn' : 'wsControlBytesIn', data.byteLength);
    if (!connection.room) { greet(connection, value); return; }
    if (connection.room.record.revoked) reject('unauthorized');
    if (connection.ticketHash) {
      try { accounts.authorizeHash(connection.ticketHash); } catch { reject('unauthorized'); }
    }
    switch (value.type) {
      case 'packet':
        if (connection.room.record.accountId !== undefined || !allowLegacyDataRelay) reject('direct_only');
        forward(connection, value); break;
      case 'signal':
        if (connection.room.record.accountId === undefined) reject('unsupported_message');
        forward(connection, value); break;
      case 'push.register':
        if (connection.room.record.accountId !== undefined || !allowLegacyDataRelay) reject('direct_only');
        if (connection.role !== 'phone') reject('forbidden');
        if (!exactKeys(value, ['type', 'provider', 'token']) || value.provider !== 'fcm' || !stringMatches(value.token, PUSH_TOKEN)) reject('invalid_registration');
        store.registerPush(connection.room.record, value.token);
        send(connection, { type: 'push.status', configured: Boolean(pushProvider.configured), registered: true });
        break;
      case 'push.notice':
        if (connection.room.record.accountId !== undefined || !allowLegacyDataRelay) reject('direct_only');
        await pushNotice(connection, value); break;
      case 'room.revoke': {
        if (connection.role !== 'desktop') reject('forbidden');
        if (!exactKeys(value, ['type'])) reject('invalid_message');
        const state = connection.room;
        store.revoke(state.record);
        send(connection, { type: 'room.revoked' });
        // Account rooms use the same persisted revoke and ciphertext cleanup.
        revokeRuntime(state, connection);
        break;
      }
      default: reject('unsupported_message');
    }
  }

  server.on('upgrade', (request, socket, head) => {
    const deny = status => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (shuttingDown || connections.size >= limits.maxConnections) { deny('503 Service Unavailable'); return; }
    if (request.url !== '/companion' || request.headers.origin !== undefined || request.headers.cookie !== undefined) { deny('403 Forbidden'); return; }
    const { secure, ip } = context(request);
    if (!secure) { deny('426 Upgrade Required'); return; }
    try {
      if (++ipState(ip).handshakes > limits.maxHandshakesPerMinute) reject('rate_limited');
    } catch { deny('429 Too Many Requests'); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      const connection = { ws, ip, room: null, role: null, alive: true, messages: 0, bytes: 0, windowAt: now() };
      connections.add(connection);
      connection.helloTimer = setTimeout(() => fail(connection, 'hello_timeout'), limits.helloTimeoutMs);
      connection.helloTimer.unref();
      ws.on('pong', () => {
        connection.alive = true;
        if (connection.ticketHash) {
          try { accounts.presence(accounts.authorizeHash(connection.ticketHash)); } catch { fail(connection, 'unauthorized'); }
        }
      });
      ws.on('error', () => { /* No payloads or credentials in logs. */ });
      ws.on('message', (data, binary) => { message(connection, data, binary).catch(error => fail(connection,
        error instanceof ProtocolError || error instanceof AccountError ? error.code : 'internal_error')); });
      ws.on('close', () => {
        clearTimeout(connection.helloTimer);
        clearTimeout(connection.ticketTimer);
        connections.delete(connection);
        const state = connection.room;
        if (state && state[connection.role] === connection) {
          state[connection.role] = null;
          const peer = state[opposite(connection.role)];
          if (peer) send(peer, { type: 'peer', online: false });
        }
      });
    });
  });
  const heartbeat = setInterval(() => {
    accounts.pruneTickets();
    for (const connection of connections) {
      if (!connection.alive) { connection.ws.terminate(); continue; }
      connection.alive = false;
      connection.ws.ping();
    }
    for (const [id, state] of rooms) {
      prune(state);
      if (!state.desktop && !state.phone && !state.queues.desktop.length && !state.queues.phone.length && !state.pendingPush
        && (state.record.accountId === undefined || (!state.seen.size && now() - state.signalWindow >= 60_000))) rooms.delete(id);
    }
    for (const [ip, state] of ips) if (now() - state.last >= 3_600_000) ips.delete(ip);
  }, limits.heartbeatMs);
  heartbeat.unref();

  try { await new Promise((resolve, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => { server.removeListener('error', rejectPromise); resolve(); });
  }); } catch (error) { clearInterval(heartbeat); throw error; }
  const address = server.address();
  return { server, store, accounts, address, url: `ws://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}/companion`,
    // Aggregate process counters distinguish discovery/control from actual
    // relayed ciphertext. They reveal no identities, room IDs or payloads.
    metrics() { return { transportPolicy: 'directOnly', legacyDataRelay: Boolean(allowLegacyDataRelay),
      ...traffic, taskForwardedBytes: traffic.relayPacketBytesOut, queuedBytes, connections: connections.size,
      budgets: { signalFramesPerMinute: limits.maxTotalSignalsPerMinute,
        signalBytesPerMinute: limits.maxTotalSignalBytesPerMinute, httpMetadataBytesPerMinute: limits.maxHttpMetadataBytesPerMinute } }; },
    async close() {
      shuttingDown = true;
      shutdown.abort();
      clearInterval(heartbeat);
      for (const connection of connections) { clearTimeout(connection.helloTimer); clearTimeout(connection.ticketTimer); connection.ws.terminate(); }
      await Promise.all([new Promise(resolve => wss.close(resolve)), new Promise(resolve => server.close(resolve))]);
    } };
}
