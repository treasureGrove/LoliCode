import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createCompanionRelay } from '../src/server.mjs';

const credentials = () => ({ roomId: randomBytes(16).toString('hex'), token: randomBytes(32).toString('hex'),
  phoneToken: randomBytes(32).toString('hex') });
const packet = (extra = {}) => ({ type: 'packet', v: 1, id: randomUUID(),
  nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(48).toString('base64url'), ...extra });
const greeting = (keys, role) => ({ type: 'hello', v: 1, role, roomId: keys.roomId,
  token: role === 'phone' ? keys.phoneToken : keys.token, ...(role === 'desktop' ? { phoneToken: keys.phoneToken } : {}) });

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lolicode-relay-test-'));
  const relay = await createCompanionRelay({ stateDirectory: directory, allowInsecureLocal: true, allowLegacyDataRelay: true, ...options });
  t.after(async () => { await relay.close(); rmSync(directory, { recursive: true, force: true }); });
  return { relay, directory };
}

async function connect(url, headers) {
  const ws = new WebSocket(url, { headers });
  const messages = [];
  const waiters = [];
  let closed;
  ws.on('message', bytes => {
    const value = JSON.parse(bytes.toString());
    messages.push(value);
    for (const waiter of [...waiters]) waiter();
  });
  ws.on('error', () => {});
  ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; for (const waiter of [...waiters]) waiter(); });
  await once(ws, 'open');
  return { ws, send(value) { ws.send(JSON.stringify(value)); },
    async next(type) {
      const read = () => { const index = messages.findIndex(item => item.type === type); return index < 0 ? undefined : messages.splice(index, 1)[0]; };
      const immediate = read();
      if (immediate) return immediate;
      return await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); const index = waiters.indexOf(check); if (index >= 0) waiters.splice(index, 1); };
        const check = () => { const result = read(); if (result) { cleanup(); resolve(result); }
          else if (closed) { cleanup(); reject(new Error(`Closed before ${type}: ${closed.code}/${closed.reason}`)); } };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, 3000);
        waiters.push(check); check();
      });
    },
    async closed() {
      if (closed) return closed;
      const [code, reason] = await once(ws, 'close');
      return { code, reason: reason.toString() };
    } };
}

async function authenticate(relay, keys, role) {
  const client = await connect(relay.url);
  client.send(greeting(keys, role));
  assert.deepEqual(await client.next('ready'), { type: 'ready', v: 1 });
  return client;
}

test('role-specific credentials authenticate; one connection per role and no unknown phone enrollment', async t => {
  const { relay } = await fixture(t);
  const keys = credentials();
  const missing = await connect(relay.url);
  missing.send(greeting(keys, 'phone'));
  assert.equal((await missing.next('error')).code, 'unauthorized');
  const desktop = await authenticate(relay, keys, 'desktop');
  const impostor = await connect(relay.url);
  impostor.send({ ...greeting(keys, 'phone'), token: keys.token });
  assert.equal((await impostor.next('error')).code, 'unauthorized');
  const phone = await authenticate(relay, keys, 'phone');
  const duplicate = await connect(relay.url);
  duplicate.send(greeting(keys, 'phone'));
  assert.equal((await duplicate.next('error')).code, 'role_connected');
  phone.send(packet());
  assert.equal((await desktop.next('packet')).from, 'phone');
});

test('only opaque packet bytes are forwarded, including bounded offline queue', async t => {
  const { relay } = await fixture(t);
  const keys = credentials();
  const desktop = await authenticate(relay, keys, 'desktop');
  const queued = packet();
  desktop.send(queued);
  const phone = await authenticate(relay, keys, 'phone');
  assert.deepEqual(await phone.next('packet'), { ...queued, from: 'desktop' });
  const reply = packet();
  phone.send(reply);
  assert.deepEqual(await desktop.next('packet'), { ...reply, from: 'phone' });
  phone.send(reply);
  assert.equal((await phone.next('error')).code, 'replayed_packet');
});

test('plaintext commands and sender impersonation are rejected', async t => {
  for (const invalid of [{ type: 'request', method: 'run_command', params: { command: 'whoami' } }, packet({ from: 'desktop' })]) {
    const { relay } = await fixture(t);
    const keys = credentials();
    await authenticate(relay, keys, 'desktop');
    const phone = await authenticate(relay, keys, 'phone');
    phone.send(invalid);
    assert.match((await phone.next('error')).code, /unsupported_message|invalid_packet/);
  }
});

test('phone cannot revoke, push notices, register as desktop, or use desktop push registration', async t => {
  for (const forbidden of [{ type: 'room.revoke' }, { type: 'push.notice', eventId: 'evt1', kind: 'task_completed', sessionId: 'session1' }]) {
    const { relay } = await fixture(t);
    const keys = credentials();
    await authenticate(relay, keys, 'desktop');
    const phone = await authenticate(relay, keys, 'phone');
    phone.send(forbidden);
    assert.equal((await phone.next('error')).code, 'forbidden');
  }
  const { relay } = await fixture(t);
  const keys = credentials();
  const desktop = await authenticate(relay, keys, 'desktop');
  desktop.send({ type: 'push.register', provider: 'fcm', token: 'registration_token_1234567890' });
  assert.equal((await desktop.next('error')).code, 'forbidden');
});

test('desktop revocation closes phone, removes push binding and persists tombstone across restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'lolicode-revoke-test-'));
  let relay = await createCompanionRelay({ stateDirectory: directory, allowInsecureLocal: true, allowLegacyDataRelay: true });
  t.after(async () => { await relay.close(); rmSync(directory, { recursive: true, force: true }); });
  const keys = credentials();
  const desktop = await authenticate(relay, keys, 'desktop');
  const phone = await authenticate(relay, keys, 'phone');
  phone.send({ type: 'push.register', provider: 'fcm', token: 'registration_token_1234567890' });
  await phone.next('push.status');
  desktop.send({ type: 'room.revoke' });
  await desktop.next('room.revoked');
  assert.equal((await phone.closed()).reason, 'revoked');
  assert.equal(relay.store.rooms.get(keys.roomId).push, undefined);
  await relay.close();
  relay = await createCompanionRelay({ stateDirectory: directory, allowInsecureLocal: true, allowLegacyDataRelay: true });
  for (const role of ['phone', 'desktop']) {
    const client = await connect(relay.url);
    client.send(greeting(keys, role));
    assert.equal((await client.next('error')).code, 'unauthorized');
  }
});

test('room credentials are hashed, push address encrypted, both survive server restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'lolicode-persist-test-'));
  let relay = await createCompanionRelay({ stateDirectory: directory, allowInsecureLocal: true, allowLegacyDataRelay: true });
  t.after(async () => { await relay.close(); rmSync(directory, { recursive: true, force: true }); });
  const keys = credentials();
  await authenticate(relay, keys, 'desktop');
  const phone = await authenticate(relay, keys, 'phone');
  const pushToken = 'registration_token_1234567890';
  phone.send({ type: 'push.register', provider: 'fcm', token: pushToken });
  assert.deepEqual(await phone.next('push.status'), { type: 'push.status', configured: false, registered: true });
  const raw = readFileSync(join(directory, 'rooms.json'), 'utf8');
  for (const secret of [keys.token, keys.phoneToken, pushToken]) assert.equal(raw.includes(secret), false);
  await relay.close();
  relay = await createCompanionRelay({ stateDirectory: directory, allowInsecureLocal: true, allowLegacyDataRelay: true });
  await authenticate(relay, keys, 'phone');
  assert.equal(relay.store.pushToken(relay.store.rooms.get(keys.roomId)), pushToken);
});

test('new enrollment expires after five minutes; prior enrolled phone may reconnect', async t => {
  let time = Date.now();
  const { relay } = await fixture(t, { now: () => time });
  const staleKeys = credentials();
  await authenticate(relay, staleKeys, 'desktop');
  const validKeys = credentials();
  await authenticate(relay, validKeys, 'desktop');
  const phone = await authenticate(relay, validKeys, 'phone');
  phone.ws.close();
  await phone.closed();
  time += 300_001;
  const stale = await connect(relay.url);
  stale.send(greeting(staleKeys, 'phone'));
  assert.equal((await stale.next('error')).code, 'pairing_expired');
  await authenticate(relay, validKeys, 'phone');
});

test('message, ciphertext, queue and room bounds fail closed', async t => {
  const { relay } = await fixture(t, { limits: { maxRooms: 1, maxQueuePackets: 1, maxCipherBytes: 64 } });
  const keys = credentials();
  const desktop = await authenticate(relay, keys, 'desktop');
  const firstPhone = await authenticate(relay, keys, 'phone');
  firstPhone.ws.close();
  await firstPhone.closed();
  desktop.send(packet());
  desktop.send(packet());
  assert.equal((await desktop.next('error')).code, 'queue_full');
  await desktop.closed();
  const excess = await connect(relay.url);
  excess.send(greeting(credentials(), 'desktop'));
  assert.equal((await excess.next('error')).code, 'capacity');
  const phone = await authenticate(relay, keys, 'phone');
  phone.send(packet({ ciphertext: randomBytes(65).toString('base64url') }));
  assert.equal((await phone.next('error')).code, 'invalid_packet');
  const { relay: frameRelay } = await fixture(t, { limits: { maxFrameBytes: 1024 } });
  const oversized = await connect(frameRelay.url);
  oversized.ws.send('x'.repeat(1025));
  assert.equal((await oversized.closed()).code, 1009);
});

test('per-connection rate limit and hello deadline are enforced', async t => {
  const { relay } = await fixture(t, { limits: { maxMessagesPerMinute: 2, helloTimeoutMs: 50 } });
  const silent = await connect(relay.url);
  assert.equal((await silent.next('error')).code, 'hello_timeout');
  const keys = credentials();
  const desktop = await authenticate(relay, keys, 'desktop');
  desktop.send(packet());
  desktop.send(packet());
  assert.equal((await desktop.next('error')).code, 'rate_limited');
});

test('aggregate queue is bounded across rooms, expired packets are not replayed, health contains no device metadata', async t => {
  let time = Date.now();
  const { relay } = await fixture(t, { now: () => time, limits: { maxTotalQueueBytes: 300 } });
  const keys = credentials();
  const desktop = await authenticate(relay, keys, 'desktop');
  const enrolled = await authenticate(relay, keys, 'phone');
  enrolled.ws.close();
  await enrolled.closed();
  desktop.send(packet());
  const other = await authenticate(relay, credentials(), 'desktop');
  other.send(packet());
  assert.equal((await other.next('error')).code, 'queue_full');
  time += 300_001;
  const phone = await authenticate(relay, keys, 'phone');
  const fresh = packet();
  desktop.send(fresh);
  assert.deepEqual(await phone.next('packet'), { ...fresh, from: 'desktop' });
  const health = await fetch(relay.url.replace('ws:', 'http:').replace('/companion', '/health'));
  assert.deepEqual(await health.json(), { ok: true, ready: true, protocol: 1, accountProtocol: 2,
    transportPolicy: 'directOnly', legacyDataRelay: true, pushConfigured: false });
});

test('cleartext websocket is refused by default, secure loopback proxy is accepted', async t => {
  const { relay } = await fixture(t, { allowInsecureLocal: false });
  const failed = new WebSocket(relay.url);
  const [error] = await once(failed, 'error');
  assert.match(error.message, /426/);
  const proxy = await connect(relay.url, { 'x-forwarded-proto': 'https' });
  proxy.send(greeting(credentials(), 'desktop'));
  await proxy.next('ready');
});

test('missing FCM configuration is explicit and never reports delivery', async t => {
  const { relay } = await fixture(t);
  const keys = credentials();
  const desktop = await authenticate(relay, keys, 'desktop');
  const phone = await authenticate(relay, keys, 'phone');
  phone.send({ type: 'push.register', provider: 'fcm', token: 'registration_token_1234567890' });
  assert.equal((await phone.next('push.status')).configured, false);
  desktop.send({ type: 'push.notice', eventId: 'event-1', kind: 'approval_required', sessionId: 'session-1' });
  assert.deepEqual(await desktop.next('push.result'), { type: 'push.result', eventId: 'event-1',
    accepted: false, delivered: false, status: 'unconfigured' });
});

test('push targets are isolated by room and duplicate events do not send twice', async t => {
  const calls = [];
  const pushProvider = { configured: true, async send(token, notice) { calls.push({ token, notice });
    return { accepted: true, delivered: false, status: 'accepted' }; } };
  const { relay } = await fixture(t, { pushProvider });
  const senders = [];
  for (let index = 0; index < 2; index++) {
    const keys = credentials();
    const desktop = await authenticate(relay, keys, 'desktop');
    const phone = await authenticate(relay, keys, 'phone');
    phone.send({ type: 'push.register', provider: 'fcm', token: `registration_token_room_${index}` });
    await phone.next('push.status');
    senders.push({ keys, desktop });
  }
  for (const { desktop } of senders) {
    desktop.send({ type: 'push.notice', eventId: 'event-1', kind: 'task_completed', sessionId: 'lc:123e4567-e89b-42d3-a456-426614174000' });
    assert.equal((await desktop.next('push.result')).status, 'accepted');
  }
  senders[0].desktop.send({ type: 'push.notice', eventId: 'event-1', kind: 'task_completed', sessionId: 'lc:123e4567-e89b-42d3-a456-426614174000' });
  await senders[0].desktop.next('push.result');
  assert.equal(calls.length, 2);
  for (let index = 0; index < 2; index++) {
    assert.equal(calls[index].token, `registration_token_room_${index}`);
    assert.equal(calls[index].notice.roomId, senders[index].keys.roomId);
  }
});
