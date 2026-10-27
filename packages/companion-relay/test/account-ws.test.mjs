import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { api, authenticated, device, enroll, fixture, hello, peer, register, signal } from './account-support.mjs';

async function pair(relay, accountId = '1') {
  const desktop = await register(relay, device(), accountId);
  const phone = await register(relay, device('phone'), accountId);
  return { desktop, phone, enrollment: await enroll(relay, desktop, phone) };
}

test('account hello requires the exact room, bound account/device/role ticket and role token', async t => {
  const { relay } = await fixture(t);
  const { desktop, phone, enrollment } = await pair(relay);
  const foreign = await register(relay, device(), '2');
  const unbound = await register(relay);
  const valid = hello(enrollment, desktop);
  const mutate = token => `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`;
  const cases = [{ ...valid, deviceToken: undefined }, { ...valid, deviceToken: mutate(desktop.deviceToken) },
    { ...valid, deviceToken: foreign.deviceToken }, { ...valid, deviceToken: unbound.deviceToken },
    { ...valid, deviceToken: phone.deviceToken }, { ...valid, phoneToken: enrollment.phoneToken },
    { ...valid, token: enrollment.phoneToken }, { ...valid, deviceId: desktop.body.deviceId }];
  for (const greeting of cases) {
    const client = await peer(relay.url);
    client.send(greeting);
    assert.match((await client.next('error')).code, /unauthorized|invalid_hello/);
    await client.closed();
  }
  const desktopSocket = await authenticated(relay, enrollment, desktop);
  const duplicate = await peer(relay.url);
  duplicate.send(valid);
  assert.equal((await duplicate.next('error')).code, 'role_connected');
  const phoneSocket = await authenticated(relay, enrollment, phone);
  const offer = signal();
  desktopSocket.send(offer);
  assert.deepEqual(await phoneSocket.next('signal'), { ...offer, from: 'desktop' });
});

test('account signal forwards only opaque opposite-role frames; replay and sender impersonation fail closed', async t => {
  const { relay } = await fixture(t);
  const { desktop, phone, enrollment } = await pair(relay);
  const desktopSocket = await authenticated(relay, enrollment, desktop);
  const phoneSocket = await authenticated(relay, enrollment, phone);
  const offer = signal();
  desktopSocket.send(offer);
  assert.deepEqual(await phoneSocket.next('signal'), { ...offer, from: 'desktop' });
  const answer = signal();
  phoneSocket.send(answer);
  assert.deepEqual(await desktopSocket.next('signal'), { ...answer, from: 'phone' });
  desktopSocket.send(offer);
  assert.equal((await desktopSocket.next('error')).code, 'replayed_packet');
  await desktopSocket.closed();
  const reconnected = await authenticated(relay, enrollment, desktop);
  reconnected.send(offer);
  assert.equal((await reconnected.next('error')).code, 'replayed_packet');
  phoneSocket.send(signal({ from: 'desktop' }));
  assert.equal((await phoneSocket.next('error')).code, 'invalid_signal');
  const metrics = relay.metrics();
  assert.equal(metrics.signalBytesOut > 0, true);
  assert.equal(metrics.signalsOut, 2);
  assert.equal(metrics.relayPacketBytesOut, 0);
  assert.equal(metrics.queuedBytes, 0);
});

test('direct-only account rooms reject task packets and all push controls even when legacy compatibility is explicitly enabled', async t => {
  const { relay } = await fixture(t, { allowLegacyDataRelay: true });
  const { desktop, phone, enrollment } = await pair(relay);
  for (const [session, value] of [[desktop, signal({ type: 'packet' })],
    [desktop, { type: 'push.notice', eventId: 'event', kind: 'task_completed', sessionId: 'session' }],
    [phone, { type: 'push.register', provider: 'fcm', token: 'private_push_token_1234567890' }]]) {
    const client = await authenticated(relay, enrollment, session);
    client.send(value);
    assert.equal((await client.next('error')).code, 'direct_only');
    await client.closed();
  }
  assert.equal(relay.metrics().relayPacketBytesOut, 0);
  assert.equal(relay.store.rooms.get(enrollment.body.roomId).push, undefined);
});

test('deployment defaults reject anonymous legacy hello without persisting rooms or consuming capacity', async t => {
  const { relay } = await fixture(t);
  let writes = 0;
  const persist = relay.store.persist;
  relay.store.persist = function () { writes++; return persist.call(this); };
  const keys = { roomId: randomBytes(16).toString('hex'), token: randomBytes(32).toString('hex'), phoneToken: randomBytes(32).toString('hex') };
  for (let index = 0; index < 3; index++) {
    const legacy = await peer(relay.url);
    legacy.send({ type: 'hello', v: 1, role: 'desktop', ...keys, roomId: randomBytes(16).toString('hex') });
    assert.equal((await legacy.next('error')).code, 'direct_only');
    await legacy.closed();
  }
  assert.equal(writes, 0);
  assert.equal(relay.store.rooms.size, 0);
  // Even an existing legacy record cannot be joined in the production profile.
  relay.store.create(keys.roomId, keys.token, keys.phoneToken);
  const retry = await peer(relay.url);
  retry.send({ type: 'hello', v: 1, role: 'desktop', ...keys });
  assert.equal((await retry.next('error')).code, 'direct_only');
  const { enrollment } = await pair(relay);
  const attack = await peer(relay.url);
  attack.send({ type: 'hello', v: 1, role: 'desktop', roomId: enrollment.body.roomId,
    token: enrollment.desktopToken, phoneToken: enrollment.phoneToken });
  assert.equal((await attack.next('error')).code, 'invalid_hello');
  assert.equal(relay.metrics().legacyDataRelay, false);
  assert.equal(relay.metrics().relayPacketsOut, 0);
});

test('global signaling budget is shared by all rooms and cannot be reset by reconnecting', async t => {
  let now = Date.now();
  const { relay } = await fixture(t, { now: () => now, limits: { maxTotalSignalsPerMinute: 2, maxTotalSignalBytesPerMinute: 600 } });
  const first = await pair(relay);
  const second = await pair(relay);
  const a = await authenticated(relay, first.enrollment, first.desktop);
  const b = await authenticated(relay, first.enrollment, first.phone);
  const c = await authenticated(relay, second.enrollment, second.desktop);
  const d = await authenticated(relay, second.enrollment, second.phone);
  a.send(signal()); await b.next('signal');
  c.send(signal()); await d.next('signal');
  c.send(signal());
  assert.equal((await c.next('error')).code, 'signal_budget_exhausted');
  await c.closed();
  const retry = await authenticated(relay, second.enrollment, second.desktop);
  retry.send(signal());
  assert.equal((await retry.next('error')).code, 'signal_budget_exhausted');
  assert.equal(relay.metrics().signalBudgetRejected, 2);
  assert.equal(relay.metrics().signalsOut, 2);
  assert.equal(relay.metrics().signalBytesOut <= 600, true);
  assert.equal(relay.metrics().taskForwardedBytes, 0);
  assert.equal(relay.metrics().transportPolicy, 'directPreferredTextFallback');
  now += 60_000;
  a.send(signal()); await b.next('signal');
  assert.equal(relay.metrics().signalsOut, 3);
});

test('global signaling byte budget applies across rooms even below the frame count limit', async t => {
  const { relay } = await fixture(t, { limits: { maxTotalSignalsPerMinute: 512, maxTotalSignalBytesPerMinute: 400 } });
  const first = await pair(relay);
  const second = await pair(relay);
  const a = await authenticated(relay, first.enrollment, first.desktop);
  const b = await authenticated(relay, first.enrollment, first.phone);
  const c = await authenticated(relay, second.enrollment, second.desktop);
  await authenticated(relay, second.enrollment, second.phone);
  a.send(signal()); await b.next('signal');
  c.send(signal({ ciphertext: randomBytes(128).toString('base64url') }));
  assert.equal((await c.next('error')).code, 'signal_budget_exhausted');
  assert.equal(relay.metrics().signalsOut, 1);
  assert.equal(relay.metrics().signalBytesOut <= 400, true);
});

test('offline offers are never queued or replayed on reconnect', async t => {
  const { relay } = await fixture(t);
  const { desktop, phone, enrollment } = await pair(relay);
  const first = await authenticated(relay, enrollment, desktop);
  first.send(signal());
  assert.equal((await first.next('error')).code, 'peer_offline');
  await first.closed();
  assert.equal(relay.metrics().queuedBytes, 0);
  const phoneSocket = await authenticated(relay, enrollment, phone);
  const desktopSocket = await authenticated(relay, enrollment, desktop);
  const fresh = signal();
  desktopSocket.send(fresh);
  assert.deepEqual(await phoneSocket.next('signal'), { ...fresh, from: 'desktop' });
  assert.equal(relay.metrics().signalsOut, 1);
});

test('signal wire size, room-wide frame and byte rate limits are enforced in both directions', async t => {
  const { relay } = await fixture(t);
  const { desktop, phone, enrollment } = await pair(relay);
  const desktopSocket = await authenticated(relay, enrollment, desktop);
  const phoneSocket = await authenticated(relay, enrollment, phone);
  for (let index = 0; index < 32; index++) {
    const [sender, receiver] = index % 2 ? [phoneSocket, desktopSocket] : [desktopSocket, phoneSocket];
    sender.send(signal());
    await receiver.next('signal');
  }
  desktopSocket.send(signal());
  assert.equal((await desktopSocket.next('error')).code, 'signal_rate_limited');
  assert.equal(relay.metrics().signalsOut, 32);

  const { relay: bytesRelay } = await fixture(t);
  const bytesPair = await pair(bytesRelay);
  const sender = await authenticated(bytesRelay, bytesPair.enrollment, bytesPair.desktop);
  const receiver = await authenticated(bytesRelay, bytesPair.enrollment, bytesPair.phone);
  for (let index = 0; index < 16; index++) { sender.send(signal({ ciphertext: randomBytes(12000).toString('base64url') })); await receiver.next('signal'); }
  sender.send(signal({ ciphertext: randomBytes(12000).toString('base64url') }));
  assert.equal((await sender.next('error')).code, 'signal_rate_limited');
  assert.equal(bytesRelay.metrics().signalBytesOut <= 256 * 1024, true);

  const { relay: sizeRelay } = await fixture(t);
  const sizePair = await pair(sizeRelay);
  const largeSender = await authenticated(sizeRelay, sizePair.enrollment, sizePair.desktop);
  await authenticated(sizeRelay, sizePair.enrollment, sizePair.phone);
  largeSender.send(signal({ ciphertext: randomBytes(12300).toString('base64url') }));
  assert.equal((await largeSender.next('error')).code, 'invalid_signal');
  assert.equal(sizeRelay.metrics().signalsOut, 0);
});

test('room signal rate state survives disconnect so reconnect cannot reset the limit', async t => {
  const { relay } = await fixture(t, { limits: { heartbeatMs: 10, maxSignalsPerMinute: 1 } });
  const { desktop, phone, enrollment } = await pair(relay);
  const sender = await authenticated(relay, enrollment, desktop);
  const receiver = await authenticated(relay, enrollment, phone);
  sender.send(signal()); await receiver.next('signal');
  sender.ws.close(); receiver.ws.close();
  await Promise.all([sender.closed(), receiver.closed()]);
  await new Promise(resolve => setTimeout(resolve, 25));
  const retry = await authenticated(relay, enrollment, desktop);
  await authenticated(relay, enrollment, phone);
  retry.send(signal());
  assert.equal((await retry.next('error')).code, 'signal_rate_limited');
});

test('ticket expiry closes live sockets, and expired tickets cannot reconnect or use HTTP', async t => {
  let now = Date.now();
  const { relay } = await fixture(t, { now: () => now, limits: { heartbeatMs: 10 } });
  const { desktop, phone, enrollment } = await pair(relay);
  const desktopSocket = await authenticated(relay, enrollment, desktop);
  const phoneSocket = await authenticated(relay, enrollment, phone);
  now += 900_000;
  assert.equal((await desktopSocket.next('error')).code, 'unauthorized');
  assert.equal((await phoneSocket.next('error')).code, 'unauthorized');
  assert.equal((await api(relay, '/devices', { token: desktop.deviceToken })).status, 401);
  const retry = await peer(relay.url);
  retry.send(hello(enrollment, phone));
  assert.equal((await retry.next('error')).code, 'unauthorized');
});

test('renewal evicts oldest third ticket and closes only its sockets; request revocation closes both endpoints', async t => {
  const { relay } = await fixture(t);
  const { desktop, phone, enrollment } = await pair(relay);
  const desktopSocket = await authenticated(relay, enrollment, desktop);
  const phoneSocket = await authenticated(relay, enrollment, phone);
  await register(relay, desktop);
  const renewed = await register(relay, desktop);
  assert.equal((await desktopSocket.next('error')).code, 'unauthorized');
  await desktopSocket.closed();
  const newSocket = await authenticated(relay, enrollment, renewed);
  const foreign = await register(relay, device(), '2');
  assert.equal((await api(relay, `/rooms/${enrollment.body.roomId}/revoke`, { method: 'POST', token: foreign.deviceToken, body: {} })).status, 404);
  assert.equal((await api(relay, `/rooms/${enrollment.body.roomId}/revoke`, { method: 'POST', token: phone.deviceToken, body: {} })).status, 200);
  assert.equal((await newSocket.closed()).reason, 'revoked');
  assert.equal((await phoneSocket.closed()).reason, 'revoked');
  const retry = await peer(relay.url); retry.send(hello(enrollment, renewed));
  assert.equal((await retry.next('error')).code, 'unauthorized');
});

test('device logout closes its account room and cannot leave a live signaling peer', async t => {
  const { relay } = await fixture(t);
  const { desktop, phone, enrollment } = await pair(relay);
  const desktopSocket = await authenticated(relay, enrollment, desktop);
  const phoneSocket = await authenticated(relay, enrollment, phone);
  assert.equal((await api(relay, '/device', { method: 'DELETE', token: desktop.deviceToken })).status, 200);
  assert.match((await desktopSocket.closed()).reason, /revoked|unauthorized/);
  assert.equal((await phoneSocket.closed()).reason, 'revoked');
  assert.equal(relay.metrics().queuedBytes, 0);
});

test('post-rename sync failure cannot restore old authorizations or leave logged-out sockets alive', async t => {
  const { relay } = await fixture(t);
  const { desktop, phone, enrollment } = await pair(relay);
  const desktopSocket = await authenticated(relay, enrollment, desktop);
  const phoneSocket = await authenticated(relay, enrollment, phone);
  const persist = relay.store.persist;
  relay.store.persist = function () {
    persist.call(this);
    const error = new Error('Injected directory sync failure after commit');
    error.committed = true;
    throw error;
  };
  assert.equal((await api(relay, '/device', { method: 'DELETE', token: desktop.deviceToken })).status, 503);
  relay.store.persist = persist;
  assert.equal(relay.store.devices.get(desktop.body.deviceId).revoked, true);
  assert.equal(relay.store.rooms.get(enrollment.body.roomId).revoked, true);
  assert.equal((await api(relay, '/devices', { token: desktop.deviceToken })).status, 401);
  assert.match((await desktopSocket.closed()).reason, /revoked|unauthorized/);
  assert.equal((await phoneSocket.closed()).reason, 'revoked');
});

test('account socket capacity is bounded and scoped independently of other accounts', async t => {
  const { relay } = await fixture(t, { limits: { maxSocketsPerAccount: 2 } });
  const first = await pair(relay);
  await authenticated(relay, first.enrollment, first.desktop);
  await authenticated(relay, first.enrollment, first.phone);
  const second = await pair(relay);
  const excess = await peer(relay.url); excess.send(hello(second.enrollment, second.desktop));
  assert.equal((await excess.next('error')).code, 'capacity');
  const foreign = await pair(relay, '2');
  await authenticated(relay, foreign.enrollment, foreign.desktop);
  assert.equal(relay.metrics().connections >= 3, true);
});
