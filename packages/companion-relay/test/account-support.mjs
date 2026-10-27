import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createCompanionRelay } from '../src/server.mjs';
import { hash } from '../src/account-validation.mjs';

export const forumBearer = (id = '1') => `lc1.${id}.${'A'.repeat(40)}`;
export const profile = (id = '1', attributes = {}) => ({ data: { type: 'users', id,
  attributes: { isEmailConfirmed: true, email: 'private@example.invalid', isAdmin: false, ...attributes } } });
export async function forumFetch(url, options) {
  assert.match(url, /^https:\/\/lolicode\.com\/api\/users\/[1-9][0-9]*$/);
  assert.equal(options.headers.authorization, `Token ${'A'.repeat(40)}`);
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  return Response.json(profile(url.split('/').at(-1)));
}
export function device(kind = 'desktop', extra = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { body: { deviceId: randomUUID(), deviceName: kind === 'desktop' ? '桌面电脑' : '我的手机', kind,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), ...extra }, privateKey };
}
export async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lolicode-account-test-'));
  const relay = await createCompanionRelay({ stateDirectory: directory, allowInsecureLocal: true,
    forumFetch, ...options, limits: { maxSessionsPerIpPerMinute: 100, ...options.limits } });
  t.after(async () => { await relay.close(); rmSync(directory, { recursive: true, force: true }); });
  return { relay, directory };
}
export async function api(relay, path, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${relay.address.port}/v2${path}`, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('set-cookie'), null);
  return { status: response.status, body: await response.json(), headers: response.headers };
}
export async function register(relay, identity = device(), id = '1') {
  const response = await api(relay, '/session', { method: 'POST', token: forumBearer(id), body: identity.body });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return { ...identity, ...response.body };
}
export function approval(extra = {}) {
  const desktopToken = randomBytes(32).toString('hex');
  const phoneToken = randomBytes(32).toString('hex');
  return { desktopToken, phoneToken, body: { roomId: randomBytes(16).toString('hex'),
    desktopTokenHash: hash(desktopToken), phoneTokenHash: hash(phoneToken),
    envelope: { nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(64).toString('base64url') }, ...extra } };
}
export async function enroll(relay, desktop, phone, supplied = approval()) {
  const created = await api(relay, '/requests', { method: 'POST', token: phone.deviceToken, body: { desktopDeviceId: desktop.device.deviceId } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const approved = await api(relay, `/requests/${created.body.requestId}/approve`, {
    method: 'POST', token: desktop.deviceToken, body: supplied.body });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return { ...supplied, request: approved.body };
}
export async function peer(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = new Set();
  let closed;
  const wake = () => { for (const waiter of waiters) waiter(); };
  ws.on('message', bytes => { messages.push(JSON.parse(bytes.toString())); wake(); });
  ws.on('error', () => {});
  ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; wake(); });
  await once(ws, 'open');
  return { ws, send(value) { ws.send(JSON.stringify(value)); },
    next(type) {
      return new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); waiters.delete(check); };
        const check = () => {
          const index = messages.findIndex(item => item.type === type);
          if (index >= 0) { cleanup(); resolve(messages.splice(index, 1)[0]); }
          else if (closed) { cleanup(); reject(new Error(`Socket closed before ${type}: ${closed.reason}`)); }
        };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${type}`)); }, 3000);
        waiters.add(check); check();
      });
    }, async closed() { if (closed) return closed; const [code, reason] = await once(ws, 'close'); return { code, reason: reason.toString() }; } };
}
export function hello(enrollment, session, role = session.device.kind) {
  return { type: 'hello', v: 1, role, roomId: enrollment.body.roomId,
    token: role === 'desktop' ? enrollment.desktopToken : enrollment.phoneToken, deviceToken: session.deviceToken };
}
export async function authenticated(relay, enrollment, session) {
  const client = await peer(relay.url);
  client.send(hello(enrollment, session));
  assert.deepEqual(await client.next('ready'), { type: 'ready', v: 1, authRefresh: true });
  return client;
}
export const signal = (extra = {}) => ({ type: 'signal', v: 1, id: randomUUID(),
  nonce: randomBytes(12).toString('base64url'), ciphertext: randomBytes(64).toString('base64url'), ...extra });
