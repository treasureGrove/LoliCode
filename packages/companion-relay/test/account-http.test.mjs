import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import test from 'node:test';
import { createCompanionRelay } from '../src/server.mjs';
import { RoomStore } from '../src/store.mjs';
import { hash } from '../src/account-validation.mjs';
import { api, approval, device, enroll, fixture, forumBearer, forumFetch, profile, register } from './account-support.mjs';

test('sessions issue scoped 15-minute tickets; same-account directory exposes only public immutable identities', async t => {
  let now = 1_000_000;
  const { relay, directory } = await fixture(t, { now: () => now });
  const desktop = await register(relay);
  const phone = await register(relay, device('phone'));
  const other = await register(relay, device('phone'), '2');
  assert.equal(desktop.v, 2);
  assert.equal(desktop.expiresAt, now + 900_000);
  assert.match(desktop.deviceToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(desktop.device.fingerprint, hash(Buffer.from(desktop.body.publicKey, 'base64url')));
  const directoryResponse = await api(relay, '/devices', { token: desktop.deviceToken });
  assert.equal(directoryResponse.status, 200);
  assert.deepEqual(new Set(directoryResponse.body.devices.map(item => item.deviceId)), new Set([desktop.body.deviceId, phone.body.deviceId]));
  assert.equal((await api(relay, '/devices', { token: other.deviceToken })).body.devices.length, 1);
  assert.deepEqual(Object.keys(directoryResponse.body.devices[0]).sort(), ['deviceId', 'deviceName', 'fingerprint', 'kind', 'lastSeenAt', 'online', 'publicKey']);
  assert.equal((await api(relay, '/devices', { token: forumBearer() })).status, 401);
  const raw = readFileSync(join(directory, 'rooms.json'), 'utf8');
  for (const secret of [desktop.deviceToken, phone.deviceToken, other.deviceToken, 'A'.repeat(40), 'private@example.invalid']) assert.equal(raw.includes(secret), false);
  assert.equal(relay.accounts.tickets.has(hash(desktop.deviceToken)), true);
  assert.equal(JSON.stringify([...relay.accounts.tickets]).includes(desktop.deviceToken), false);
  now += 120_000;
  assert.equal((await api(relay, '/devices', { token: desktop.deviceToken })).body.devices.every(item => !item.online), true);
  assert.equal((await api(relay, '/presence', { method: 'POST', token: phone.deviceToken, body: {} })).status, 200);
  assert.equal((await api(relay, '/devices', { token: desktop.deviceToken })).body.devices.find(item => item.deviceId === phone.body.deviceId).online, true);
});

test('same device identity renews at most two tickets and cannot change account, kind or public key', async t => {
  const { relay } = await fixture(t);
  const identity = device();
  const first = await register(relay, identity);
  const second = await register(relay, identity);
  const third = await register(relay, { ...identity, body: { ...identity.body, deviceName: '重命名设备' } });
  assert.equal((await api(relay, '/devices', { token: first.deviceToken })).status, 401);
  for (const session of [second, third]) assert.equal((await api(relay, '/devices', { token: session.deviceToken })).status, 200);
  assert.equal(relay.accounts.tickets.size, 2);
  for (const [id, body] of [['2', identity.body], ['1', { ...identity.body, kind: 'phone' }],
    ['1', { ...identity.body, publicKey: device().body.publicKey }]]) {
    assert.equal((await api(relay, '/session', { method: 'POST', token: forumBearer(id), body })).status, 409);
  }
  assert.equal((await api(relay, '/devices', { token: third.deviceToken })).body.devices[0].deviceName, '重命名设备');
});

test('pending enrollment is reused, endpoint-only and bounded to the same account', async t => {
  const { relay } = await fixture(t);
  const desktop = await register(relay);
  const phone = await register(relay, device('phone'));
  const unrelated = await register(relay);
  const foreign = await register(relay, device('phone'), '2');
  const create = token => api(relay, '/requests', { method: 'POST', token, body: { desktopDeviceId: desktop.body.deviceId } });
  const first = await create(phone.deviceToken);
  assert.equal(first.status, 200);
  assert.equal(first.body.expiresAt - first.body.createdAt, 300_000);
  assert.equal(Buffer.from(first.body.challenge, 'base64url').length, 32);
  assert.equal((await create(phone.deviceToken)).body.requestId, first.body.requestId);
  assert.equal(relay.store.requests.size, 1);
  assert.equal((await create(desktop.deviceToken)).status, 403);
  assert.equal((await create(foreign.deviceToken)).status, 404);
  for (const session of [unrelated, foreign]) {
    assert.deepEqual((await api(relay, '/requests', { token: session.deviceToken })).body, { requests: [] });
    assert.equal((await api(relay, `/requests/${first.body.requestId}`, { token: session.deviceToken })).status, 404);
    assert.equal((await api(relay, `/requests/${first.body.requestId}/approve`, { method: 'POST', token: session.deviceToken, body: approval().body })).status, 404);
  }
  for (const session of [desktop, phone]) assert.equal((await api(relay, '/requests', { token: session.deviceToken })).body.requests[0].requestId, first.body.requestId);
  assert.equal((await api(relay, `/requests/${first.body.requestId}/approve`, { method: 'POST', token: phone.deviceToken, body: approval().body })).status, 403);
});

test('approval accepts only token hashes and opaque envelope; consumes request and room atomically', async t => {
  const { relay, directory } = await fixture(t);
  const desktop = await register(relay);
  const phone = await register(relay, device('phone'));
  const request = (await api(relay, '/requests', { method: 'POST', token: phone.deviceToken, body: { desktopDeviceId: desktop.body.deviceId } })).body;
  const keys = approval();
  const approve = body => api(relay, `/requests/${request.requestId}/approve`, { method: 'POST', token: desktop.deviceToken, body });
  for (const body of [{ ...keys.body, desktopToken: keys.desktopToken }, { ...keys.body, key: randomBytes(32).toString('base64url') },
    { ...keys.body, phoneTokenHash: keys.body.desktopTokenHash }, { ...keys.body, desktopTokenHash: keys.desktopToken.toUpperCase() },
    { ...keys.body, envelope: { ...keys.body.envelope, nonce: `${keys.body.envelope.nonce}=` } },
    { ...keys.body, envelope: { nonce: keys.body.envelope.nonce, ciphertext: 'abc' } }]) assert.equal((await approve(body)).status, 400);
  const persist = relay.store.persist;
  relay.store.persist = () => { throw new Error('disk full secret'); };
  assert.equal((await approve(keys.body)).status, 503);
  assert.equal(relay.store.rooms.has(keys.body.roomId), false);
  assert.equal(relay.store.requests.get(request.requestId).status, 'pending');
  relay.store.persist = persist;
  const response = await approve(keys.body);
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'approved');
  assert.deepEqual(response.body.envelope, keys.body.envelope);
  assert.deepEqual((await api(relay, `/requests/${request.requestId}`, { token: phone.deviceToken })).body.envelope, keys.body.envelope);
  assert.equal((await approve(keys.body)).status, 409);
  const second = (await api(relay, '/requests', { method: 'POST', token: phone.deviceToken, body: { desktopDeviceId: desktop.body.deviceId } })).body;
  assert.equal((await api(relay, `/requests/${second.requestId}/approve`, { method: 'POST', token: desktop.deviceToken, body: keys.body })).status, 409);
  const state = JSON.parse(readFileSync(join(directory, 'rooms.json'), 'utf8'));
  assert.equal(state.requests.find(item => item.requestId === request.requestId).status, 'approved');
  assert.equal(state.rooms.find(item => item.id === keys.body.roomId).desktopHash, keys.body.desktopTokenHash);
  for (const secret of [keys.desktopToken, keys.phoneToken, desktop.deviceToken]) assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal(readdirSync(directory).some(name => name.endsWith('.tmp')), false);
});

test('request expiration, rejection and capacity limits cannot create unbounded identities or pending requests', async t => {
  let now = Date.now();
  const { relay } = await fixture(t, { now: () => now, limits: { maxAccounts: 1, maxDevicesPerAccount: 3, maxDevices: 3, maxRequestsPerAccount: 1, maxRequests: 1 } });
  const desktop = await register(relay);
  const phone = await register(relay, device('phone'));
  const other = await register(relay);
  assert.equal((await api(relay, '/session', { method: 'POST', token: forumBearer('2'), body: device().body })).status, 503);
  assert.equal((await api(relay, '/session', { method: 'POST', token: forumBearer(), body: device().body })).status, 503);
  const create = target => api(relay, '/requests', { method: 'POST', token: phone.deviceToken, body: { desktopDeviceId: target.body.deviceId } });
  const request = (await create(desktop)).body;
  assert.equal((await create(other)).status, 503);
  assert.equal((await api(relay, `/requests/${request.requestId}/reject`, { method: 'POST', token: other.deviceToken, body: {} })).status, 404);
  assert.equal((await api(relay, `/requests/${request.requestId}/reject`, { method: 'POST', token: desktop.deviceToken, body: {} })).body.status, 'rejected');
  assert.equal((await api(relay, `/requests/${request.requestId}/approve`, { method: 'POST', token: desktop.deviceToken, body: approval().body })).status, 409);
  now += 300_000;
  assert.equal((await api(relay, `/requests/${request.requestId}`, { token: phone.deviceToken })).status, 410);
  assert.deepEqual((await api(relay, '/requests', { token: desktop.deviceToken })).body, { requests: [] });
  assert.equal((await create(other)).status, 200);
  assert.equal(relay.store.requests.size, 1);
});

test('persistent devices, pending requests and account bindings survive restart; device tickets never do', async t => {
  const { relay, directory } = await fixture(t);
  const desktopIdentity = device();
  const phoneIdentity = device('phone');
  const desktop = await register(relay, desktopIdentity);
  const phone = await register(relay, phoneIdentity);
  const enrolled = await enroll(relay, desktop, phone);
  const pending = (await api(relay, '/requests', { method: 'POST', token: phone.deviceToken, body: { desktopDeviceId: desktop.body.deviceId } })).body;
  await relay.close();
  const restarted = await createCompanionRelay({ stateDirectory: directory, allowInsecureLocal: true, forumFetch });
  t.after(() => restarted.close());
  assert.equal((await api(restarted, '/devices', { token: desktop.deviceToken })).status, 401);
  assert.equal(restarted.store.rooms.get(enrolled.body.roomId).accountId, '1');
  assert.equal(restarted.store.requests.get(pending.requestId).status, 'pending');
  const renewed = await register(restarted, desktopIdentity);
  assert.equal((await api(restarted, '/devices', { token: renewed.deviceToken })).body.devices.length, 2);
  assert.equal((await api(restarted, `/requests/${enrolled.request.requestId}`, { token: renewed.deviceToken })).body.status, 'approved');
  const state = JSON.parse(readFileSync(join(directory, 'rooms.json'), 'utf8'));
  state.rooms[0].phoneDeviceId = desktop.body.deviceId;
  writeFileSync(join(directory, 'rooms.json'), JSON.stringify(state));
  assert.throws(() => new RoomStore(directory), /Invalid companion/);
});

test('logout revokes tickets, requests and bound rooms while preserving immutable identity tombstones', async t => {
  const { relay } = await fixture(t);
  const desktop = await register(relay);
  const phone = await register(relay, device('phone'));
  const renewedPhone = await register(relay, phone);
  const enrolled = await enroll(relay, desktop, phone);
  assert.equal((await api(relay, '/device', { method: 'DELETE', token: phone.deviceToken })).status, 200);
  for (const session of [phone, renewedPhone]) assert.equal((await api(relay, '/devices', { token: session.deviceToken })).status, 401);
  assert.equal(relay.store.rooms.get(enrolled.body.roomId).revoked, true);
  assert.equal(relay.store.requests.size, 0);
  assert.equal((await api(relay, '/devices', { token: desktop.deviceToken })).body.devices.length, 1);
  assert.equal((await api(relay, '/session', { method: 'POST', token: forumBearer(), body: { ...phone.body, publicKey: device('phone').body.publicKey } })).status, 409);
  const reactivated = await register(relay, phone);
  assert.equal(reactivated.device.fingerprint, phone.device.fingerprint);
  assert.equal(relay.store.rooms.get(enrolled.body.roomId).revoked, true);
});

test('HTTP requires secure explicit transport and native clients; body and rate bounds precede expensive forum auth', async t => {
  let calls = 0;
  const { relay } = await fixture(t, { allowInsecureLocal: false, limits: { maxSessionsPerIpPerMinute: 2, maxHttpBodyBytes: 512 },
    async forumFetch(url, options) { calls++; return forumFetch(url, options); } });
  const body = device().body;
  assert.equal((await api(relay, '/session', { method: 'POST', token: forumBearer(), body })).status, 426);
  const secureHeaders = { 'x-forwarded-proto': 'https' };
  for (const headers of [{ ...secureHeaders, origin: 'https://lolicode.com' }, { ...secureHeaders, cookie: 'session=secret' }]) {
    assert.equal((await api(relay, '/session', { method: 'POST', token: forumBearer(), body, headers })).status, 403);
  }
  assert.equal(calls, 0);
  assert.equal((await api(relay, '/session', { method: 'POST', token: forumBearer(), body: { ...body, identityProvider: 'https://evil.invalid' }, headers: secureHeaders })).status, 400);
  assert.equal((await api(relay, '/session', { method: 'POST', token: forumBearer(), body: { ...body, deviceName: 'x'.repeat(600) }, headers: secureHeaders })).status, 413);
  assert.equal((await api(relay, '/session', { method: 'POST', token: forumBearer(), body, headers: secureHeaders })).status, 429);
  assert.equal(calls, 0);
});

test('public-profile HTTP 200 is rejected and forum exceptions expose no credentials or provider details', async t => {
  const { relay } = await fixture(t, { forumFetch: async () => Response.json({ data: { type: 'users', id: '1', attributes: { username: 'public' } } }) });
  const result = await api(relay, '/session', { method: 'POST', token: forumBearer(), body: device().body });
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: { code: 'unauthorized', message: 'Authentication required.' } });
  assert.equal(relay.store.devices.size, 0);
});

test('successful metadata has a shared output budget and mutations fail before changing durable state', async t => {
  let now = Date.now();
  const { relay } = await fixture(t, { now: () => now, limits: { maxHttpMetadataBytesPerMinute: 4096 } });
  const desktop = await register(relay);
  let rejected = false;
  for (let index = 0; index < 30; index++) {
    const response = await api(relay, '/devices', { token: desktop.deviceToken });
    if (response.status === 429) { rejected = true; break; }
    assert.equal(response.status, 200);
  }
  assert.equal(rejected, true);
  assert.equal(relay.metrics().httpBudgetRejected > 0, true);
  assert.equal(relay.metrics().httpMetadataBytesOut <= 4096, true);
  const priorTickets = relay.accounts.tickets.size;
  assert.equal((await api(relay, '/session', { method: 'POST', token: forumBearer(), body: desktop.body })).status, 429);
  assert.equal(relay.accounts.tickets.size, priorTickets);
  now += 60_000;
  assert.equal((await api(relay, '/devices', { token: desktop.deviceToken })).status, 200);
});

test('logout fences a session verification already in flight so it cannot resurrect access', async t => {
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  let pause = false;
  const { relay } = await fixture(t, { async forumFetch(url, options) {
    if (pause) { started(); await new Promise(resolve => { release = resolve; }); }
    return forumFetch(url, options);
  } });
  const desktop = await register(relay);
  pause = true;
  const renewing = api(relay, '/session', { method: 'POST', token: forumBearer(), body: desktop.body });
  await waiting;
  assert.equal((await api(relay, '/device', { method: 'DELETE', token: desktop.deviceToken })).status, 200);
  release();
  assert.equal((await renewing).status, 401);
  assert.equal(relay.accounts.tickets.size, 0);
});

test('malformed HTTP and oversized headers return fixed JSON without echoing inputs', async t => {
  const { relay } = await fixture(t);
  for (const request of ['INVALID PRIVATE_INPUT\r\n\r\n',
    `GET /v2/devices HTTP/1.1\r\nHost: localhost\r\nX-Private: ${'x'.repeat(9000)}\r\n\r\n`]) {
    const raw = await new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: relay.address.port });
      const chunks = [];
      socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('HTTP parser rejection timed out')); });
      socket.on('connect', () => socket.write(request));
      socket.on('data', chunk => chunks.push(chunk));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
      socket.on('error', reject);
    });
    assert.match(raw, /^HTTP\/1.1 400 /);
    assert.deepEqual(JSON.parse(raw.split('\r\n\r\n')[1]), { error: { code: 'bad_request', message: 'Invalid request.' } });
    assert.equal(raw.includes('PRIVATE_INPUT'), false);
    assert.equal(raw.includes('X-Private'), false);
  }
  assert.equal(relay.store.devices.size, 0);
});
