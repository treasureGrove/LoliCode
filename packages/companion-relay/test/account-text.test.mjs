import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { api, authenticated, device, enroll, fixture, hello, peer, register, signal } from './account-support.mjs';

async function pair(relay, accountId = '1') {
  const desktop = await register(relay, device(), accountId);
  const phone = await register(relay, device('phone'), accountId);
  return { desktop, phone, enrollment: await enroll(relay, desktop, phone) };
}
async function attach(relay, p, session, capabilities = ['text-v1']) {
  const client = await peer(relay.url);
  client.send({ ...hello(p.enrollment, session), capabilities });
  assert.deepEqual(await client.next('ready'), { type: 'ready', v: 1, authRefresh: true, textRelay: true });
  return { client, state: await client.next('peer') };
}
async function connect(relay, p) {
  const first = await attach(relay, p, p.desktop);
  assert.deepEqual(first.state, { type: 'peer', online: false, textRelay: false });
  const second = await attach(relay, p, p.phone);
  const state = await first.client.next('peer');
  assert.equal(state.textRelay, true);
  assert.match(state.textEpoch, /^[a-f0-9]{32}$/);
  assert.deepEqual(second.state, state);
  return { desktop: first.client, phone: second.client, epoch: state.textEpoch };
}
const text = (epoch, extra = {}) => ({ type: 'text', v: 1, id: randomUUID(), epoch,
  nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(64).toString('base64url'), ...extra });
const wireBytes = packet => Buffer.byteLength(JSON.stringify({ ...packet, from: 'desktop' }));

test('text-v1 is opt-in at both authenticated account endpoints and does not reopen legacy packet/push paths', async t => {
  const { relay } = await fixture(t);
  const p = await pair(relay);
  const old = await authenticated(relay, p.enrollment, p.desktop);
  const phone = await attach(relay, p, p.phone);
  assert.deepEqual(phone.state, { type: 'peer', online: true, textRelay: false });
  phone.client.send(text('a'.repeat(32)));
  assert.equal((await phone.client.next('error')).code, 'text_not_negotiated');
  await phone.client.closed();
  old.send(signal({ type: 'packet' }));
  assert.equal((await old.next('error')).code, 'direct_only');
  assert.equal(relay.metrics().textBytesOut, 0);
  assert.equal(relay.metrics().legacyDataRelay, false);
});

test('text uses only the bound opposite role, exact envelope and a fresh shared epoch after every disconnect', async t => {
  const { relay } = await fixture(t);
  const p = await pair(relay);
  const sockets = await connect(relay, p);
  const frame = text(sockets.epoch);
  sockets.desktop.send(frame);
  assert.deepEqual(await sockets.phone.next('text'), { ...frame, from: 'desktop' });
  assert.equal(relay.metrics().textBytesOut, wireBytes(frame));
  assert.equal(relay.metrics().signalBytesOut, 0);
  sockets.desktop.send(frame);
  assert.equal((await sockets.desktop.next('error')).code, 'replayed_text');
  await sockets.desktop.closed();
  assert.deepEqual(await sockets.phone.next('peer'), { type: 'peer', online: false, textRelay: false });
  const retry = await attach(relay, p, p.desktop);
  assert.notEqual(retry.state.textEpoch, sockets.epoch);
  assert.deepEqual(await sockets.phone.next('peer'), retry.state);
  retry.client.send(text(sockets.epoch));
  assert.equal((await retry.client.next('error')).code, 'text_epoch_invalid');
  assert.equal(relay.metrics().textsOut, 1);
  assert.equal(relay.metrics().queuedBytes, 0);
});

test('capabilities cannot bypass account/device/room approval and sender identity is always server-owned', async t => {
  const { relay } = await fixture(t);
  const p = await pair(relay);
  const foreign = await register(relay, device(), '2');
  const attack = await peer(relay.url);
  attack.send({ ...hello(p.enrollment, foreign), token: p.enrollment.desktopToken, capabilities: ['text-v1'] });
  assert.equal((await attack.next('error')).code, 'unauthorized');
  const sockets = await connect(relay, p);
  sockets.phone.send(text(sockets.epoch, { from: 'desktop' }));
  assert.equal((await sockets.phone.next('error')).code, 'invalid_text');
  assert.equal(relay.metrics().textsOut, 0);
});

test('both inbound and forwarded serialized UTF-8 frames are bounded, including the added sender field', async t => {
  const { relay } = await fixture(t, { limits: { maxTextFrameBytes: 512 } });
  const sockets = await connect(relay, await pair(relay));
  let frame;
  for (let size = 16; size < 512; size++) {
    const candidate = text(sockets.epoch, { ciphertext: randomBytes(size).toString('base64url') });
    if (Buffer.byteLength(JSON.stringify(candidate)) <= 512 && wireBytes(candidate) > 512) { frame = candidate; break; }
  }
  assert.ok(frame);
  sockets.desktop.send(frame);
  assert.equal((await sockets.desktop.next('error')).code, 'invalid_text');
  assert.equal(relay.metrics().textBytesOut, 0);
});

test('account budgets span multiple rooms and reconnects while the site bucket spans other accounts', async t => {
  const sample = text('0'.repeat(32));
  const bytes = wireBytes(sample);
  const { relay } = await fixture(t, { limits: { maxTextAccountBurstBytes: bytes, maxTextAccountBytesPerSecond: 1,
    maxTextBurstBytes: bytes * 2, maxTextBytesPerSecond: 1 } });
  const firstPair = await pair(relay);
  const first = await connect(relay, firstPair);
  const second = await connect(relay, await pair(relay));
  const third = await connect(relay, await pair(relay, '2'));
  const fourth = await connect(relay, await pair(relay, '3'));
  first.desktop.send(text(first.epoch)); await first.phone.next('text');
  first.desktop.ws.close(); await first.desktop.closed(); await first.phone.next('peer');
  const reconnected = await attach(relay, firstPair, firstPair.desktop);
  await first.phone.next('peer');
  reconnected.client.send(text(reconnected.state.textEpoch));
  assert.equal((await reconnected.client.next('error')).code, 'text_rate_limited');
  second.desktop.send(text(second.epoch));
  assert.equal((await second.desktop.next('error')).code, 'text_rate_limited');
  third.desktop.send(text(third.epoch)); await third.phone.next('text');
  fourth.desktop.send(text(fourth.epoch));
  assert.equal((await fourth.desktop.next('error')).code, 'text_rate_limited');
  assert.equal(relay.metrics().textsOut, 2);
  assert.equal(relay.metrics().textBudgetRejected, 3);
});

test('slow text peers are rejected before monthly reservation, without accumulating a business queue', async t => {
  const { relay } = await fixture(t, { limits: { maxTextBufferedBytes: 128 } });
  const sockets = await connect(relay, await pair(relay));
  sockets.desktop.send(text(sockets.epoch));
  assert.equal((await sockets.desktop.next('error')).code, 'text_slow_peer');
  assert.equal(relay.metrics().textBytesOut, 0);
  assert.equal(relay.metrics().textBudget.monthlyReservedBytes, 0);
  assert.equal(relay.metrics().queuedBytes, 0);
});

test('monthly exhaustion is explicit and filesystem reservation failure is fail-closed before any delivery', async t => {
  const { relay } = await fixture(t, { limits: { maxTextMonthlyBytes: wireBytes(text('0'.repeat(32))) } });
  const sockets = await connect(relay, await pair(relay));
  sockets.desktop.send(text(sockets.epoch)); await sockets.phone.next('text');
  sockets.desktop.send(text(sockets.epoch));
  assert.equal((await sockets.desktop.next('error')).code, 'text_monthly_quota_exhausted');
  assert.equal(relay.metrics().textsOut, 1);
  const failed = await fixture(t);
  const failedSockets = await connect(failed.relay, await pair(failed.relay));
  mkdirSync(join(failed.directory, 'text-budget.json'));
  failedSockets.desktop.send(text(failedSockets.epoch));
  assert.equal((await failedSockets.desktop.next('error')).code, 'text_budget_unavailable');
  assert.equal(failed.relay.metrics().textsOut, 0);
  assert.equal(failed.relay.metrics().textBudget.available, false);
});

test('text has no offline queue and ticket expiry, room revoke and device logout retain existing fences', async t => {
  for (const operation of ['expiry', 'revoke', 'logout']) {
    let now = Date.now();
    const { relay } = await fixture(t, { now: () => now, limits: { heartbeatMs: 10 } });
    const p = await pair(relay);
    const sockets = await connect(relay, p);
    if (operation === 'expiry') now += 900_000;
    else if (operation === 'revoke') assert.equal((await api(relay, `/rooms/${p.enrollment.body.roomId}/revoke`, { method: 'POST', token: p.phone.deviceToken, body: {} })).status, 200);
    else assert.equal((await api(relay, '/device', { method: 'DELETE', token: p.desktop.deviceToken })).status, 200);
    await Promise.all([sockets.desktop.closed(), sockets.phone.closed()]);
    assert.equal(relay.metrics().textBytesOut, 0);
    assert.equal(relay.metrics().queuedBytes, 0);
  }
  const { relay } = await fixture(t);
  const p = await pair(relay);
  const first = await attach(relay, p, p.desktop);
  first.client.send(text('0'.repeat(32)));
  assert.equal((await first.client.next('error')).code, 'peer_offline');
  assert.equal(relay.metrics().queuedBytes, 0);
});

test('a virtual minute of real loopback encrypted text syncs reports actual wire bytes without full snapshots', async t => {
  let now = Date.UTC(2026, 9, 27);
  const { relay } = await fixture(t, { now: () => now });
  const p = await pair(relay);
  const sockets = await connect(relay, p);
  const key = randomBytes(32); // Public test protocol, private ephemeral fixture only.
  const aad = (role, frame) => Buffer.from(`lolicode-companion-text/1|${p.enrollment.body.roomId}|${frame.epoch}|${role}|${frame.id}`);
  const seal = (role, payload) => {
    const frame = text(sockets.epoch);
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(frame.nonce, 'base64url'));
    cipher.setAAD(aad(role, frame));
    frame.ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64url');
    return frame;
  };
  const open = (role, frame) => {
    const bytes = Buffer.from(frame.ciphertext, 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(frame.nonce, 'base64url'));
    cipher.setAAD(aad(role, frame)); cipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(0, -16)), cipher.final()]).toString('utf8'));
  };
  let receivedWireBytes = 0;
  for (let seq = 0; seq < 60; seq++) {
    const requestId = randomUUID();
    sockets.phone.send(seal('phone', { type: 'request', requestId, method: 'session.sync',
      params: { sessionId: 'fixture-session', afterSeq: seq, maxBytes: 5500 }, sentAt: now }));
    const request = await sockets.desktop.next('text');
    receivedWireBytes += Buffer.byteLength(JSON.stringify(request));
    assert.equal(open('phone', request).requestId, requestId);
    sockets.desktop.send(seal('desktop', { type: 'response', requestId, ok: true, sentAt: now,
      result: { epoch: 'fixture-transcript', fromSeq: seq, toSeq: seq + 1, hasMore: false,
        ops: [{ type: 'text.append', messageId: 'm1', revision: seq + 1, offset: seq * 150, text: '文'.repeat(50) }] } }));
    const response = await sockets.phone.next('text');
    receivedWireBytes += Buffer.byteLength(JSON.stringify(response));
    assert.equal(open('desktop', response).result.ops[0].text, '文'.repeat(50));
    now += 1000;
  }
  const metrics = relay.metrics();
  assert.equal(metrics.textBytesOut, receivedWireBytes);
  assert.equal(metrics.textsOut, 120);
  assert.equal(metrics.textBudgetRejected, 0);
  assert.equal(metrics.textBytesOut < 120 * 1024, true);
  t.diagnostic(JSON.stringify({ virtualSeconds: 60, loopbackFrames: 120,
    actualSerializedTextEgressBytes: metrics.textBytesOut, utf8AnswerTextBytes: 60 * 50 * 3,
    monthlyReservedBytes: metrics.textBudget.monthlyReservedBytes, fullSnapshots: 0,
    realAccountUsed: false, nativeEndpointIntegrationClaimed: false }));
});
