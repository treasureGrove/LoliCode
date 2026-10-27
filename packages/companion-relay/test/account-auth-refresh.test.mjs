import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { api, authenticated, device, enroll, fixture, hello, peer, register, signal } from './account-support.mjs';

async function pair(relay) {
  const desktop = await register(relay);
  const phone = await register(relay, device('phone'));
  return { desktop, phone, enrollment: await enroll(relay, desktop, phone) };
}
const refresh = (session, extra = {}) => ({ type: 'auth.refresh', v: 1, requestId: randomUUID(), deviceToken: session.deviceToken, ...extra });
const text = epoch => ({ type: 'text', v: 1, id: randomUUID(), epoch,
  nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(64).toString('base64url') });
async function textSocket(relay, p, session) {
  const client = await peer(relay.url);
  client.send({ ...hello(p.enrollment, session), capabilities: ['text-v1'] });
  assert.deepEqual(await client.next('ready'), { type: 'ready', v: 1, authRefresh: true, textRelay: true });
  return { client, state: await client.next('peer') };
}

test('an acknowledged same-device refresh replaces the actual old expiry timer and retains account text epoch/replay/quota', async t => {
  let now = Date.now();
  const { relay, directory } = await fixture(t, { now: () => now });
  const p = await pair(relay);
  now = p.desktop.expiresAt - 200;
  const renewed = await register(relay, p.desktop);
  const renewedPhone = await register(relay, p.phone);
  const first = await textSocket(relay, p, p.desktop);
  const second = await textSocket(relay, p, renewedPhone);
  const state = await first.client.next('peer');
  assert.deepEqual(second.state, state);
  const frame = text(state.textEpoch);
  first.client.send(frame); await second.client.next('text');
  const ledger = readFileSync(join(directory, 'text-budget.json'));
  const request = refresh(renewed);
  first.client.send(request);
  assert.deepEqual(await first.client.next('auth.renewed'), { type: 'auth.renewed', v: 1,
    requestId: request.requestId, expiresAt: renewed.expiresAt });
  // A still-armed old timer would close this connection after 200 real ms even
  // with our controlled wall clock unchanged.
  await new Promise(resolve => setTimeout(resolve, 250));
  const after = text(state.textEpoch);
  first.client.send(after);
  assert.deepEqual(await second.client.next('text'), { ...after, from: 'desktop' });
  assert.deepEqual(readFileSync(join(directory, 'text-budget.json')), ledger);
  assert.equal(relay.metrics().textBudget.accountBuckets, 1);
  first.client.send(frame);
  assert.equal((await first.client.next('error')).code, 'replayed_text');
  assert.equal(relay.metrics().textsOut, 2);
});

test('signal sockets advertise refresh and preserve the original authenticated signal replay window', async t => {
  let now = Date.now();
  const { relay } = await fixture(t, { now: () => now });
  const p = await pair(relay);
  const desktop = await authenticated(relay, p.enrollment, p.desktop);
  const phone = await authenticated(relay, p.enrollment, p.phone);
  const offer = signal(); desktop.send(offer); await phone.next('signal');
  now += 1;
  const renewed = await register(relay, p.desktop);
  const request = refresh(renewed); desktop.send(request);
  assert.equal((await desktop.next('auth.renewed')).requestId, request.requestId);
  desktop.send(offer);
  assert.equal((await desktop.next('error')).code, 'replayed_packet');
  assert.equal(relay.metrics().signalsOut, 1);
});

test('refresh does not reset a drained shared account bucket or its durable monthly reservation', async t => {
  let now = Date.now();
  const packet = text('0'.repeat(32));
  const bytes = Buffer.byteLength(JSON.stringify({ ...packet, from: 'desktop' }));
  const { relay } = await fixture(t, { now: () => now, limits: { maxTextAccountBurstBytes: bytes, maxTextAccountBytesPerSecond: 1 } });
  const p = await pair(relay);
  const desktop = await textSocket(relay, p, p.desktop);
  const phone = await textSocket(relay, p, p.phone);
  const state = await desktop.client.next('peer');
  desktop.client.send(text(state.textEpoch)); await phone.client.next('text');
  now += 1;
  const renewed = await register(relay, p.desktop);
  desktop.client.send(refresh(renewed)); await desktop.client.next('auth.renewed');
  desktop.client.send(text(state.textEpoch));
  assert.equal((await desktop.client.next('error')).code, 'text_rate_limited');
  assert.equal(relay.metrics().textsOut, 1);
});

test('an expired old socket cannot be revived by a valid newer ticket, and logout/revoke remain immediate fences', async t => {
  for (const operation of ['expired', 'logout', 'revoke']) {
    let now = Date.now();
    const { relay } = await fixture(t, { now: () => now });
    const p = await pair(relay);
    const desktop = await authenticated(relay, p.enrollment, p.desktop);
    now += 1000;
    const renewed = await register(relay, p.desktop);
    if (operation === 'expired') {
      now = p.desktop.expiresAt + 1;
      desktop.send(refresh(renewed));
      assert.equal((await desktop.next('error')).code, 'unauthorized');
    } else if (operation === 'logout') {
      assert.equal((await api(relay, '/device', { method: 'DELETE', token: renewed.deviceToken })).status, 200);
    } else {
      assert.equal((await api(relay, `/rooms/${p.enrollment.body.roomId}/revoke`, { method: 'POST', token: p.phone.deviceToken, body: {} })).status, 200);
    }
    await desktop.closed();
    assert.equal(relay.metrics().textBytesOut, 0);
  }
});

test('refresh cannot replace account, device, role or an unchanged-expiry capability', async t => {
  for (const replacement of ['foreign', 'device', 'role', 'same']) {
    const { relay } = await fixture(t);
    const p = await pair(relay);
    const desktop = await authenticated(relay, p.enrollment, p.desktop);
    const session = replacement === 'foreign' ? await register(relay, device(), '2')
      : replacement === 'device' ? await register(relay) : replacement === 'role' ? p.phone : p.desktop;
    desktop.send(refresh(session));
    assert.equal((await desktop.next('error')).code, 'unauthorized');
    await desktop.closed();
  }
});

test('refresh has a strict control schema, canonical request IDs, deduplication and a bounded control rate', async t => {
  let now = Date.now();
  const { relay } = await fixture(t, { now: () => now, limits: { maxAuthRefreshPerMinute: 1 } });
  const p = await pair(relay);
  for (const extra of [{ from: 'desktop' }, { requestId: 'ABCDEF01-2345-4ABC-8DEF-0123456789AB' }, { v: 2 }]) {
    const socket = await authenticated(relay, p.enrollment, p.desktop);
    socket.send(refresh(p.desktop, extra));
    assert.equal((await socket.next('error')).code, 'invalid_auth_refresh');
    await socket.closed();
  }
  const socket = await authenticated(relay, p.enrollment, p.desktop);
  now += 1; const newer = await register(relay, p.desktop);
  socket.send(refresh(newer)); await socket.next('auth.renewed');
  now += 1; const newest = await register(relay, p.desktop);
  socket.send(refresh(newest));
  assert.equal((await socket.next('error')).code, 'auth_refresh_rate_limited');
  await socket.closed();

  const fresh = await authenticated(relay, p.enrollment, newest);
  now += 1; const last = await register(relay, p.desktop);
  const request = refresh(last); fresh.send(request); await fresh.next('auth.renewed');
  now += 60_000; fresh.send(request);
  assert.equal((await fresh.next('error')).code, 'replayed_auth_refresh');
});
