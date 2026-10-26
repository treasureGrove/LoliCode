import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { AccountError, publicKeyFingerprint, registration } from '../src/account-validation.mjs';
import { forumCredential, verifyForum, verifySelfProfile } from '../src/forum.mjs';
import { device, forumBearer, forumFetch, profile } from './account-support.mjs';

test('forum credentials are canonical positive u64 IDs and exactly 40 alphanumeric token bytes', () => {
  assert.deepEqual(forumCredential(`Bearer ${forumBearer()}`), { accountId: '1', token: 'A'.repeat(40) });
  for (const value of [undefined, 'Bearer token', `Bearer ${forumBearer('01')}`, `Bearer ${forumBearer('0')}`,
    `Bearer ${forumBearer('18446744073709551616')}`, `Bearer ${forumBearer('../1')}`, `Bearer lc1.1.${'A'.repeat(39)}_`]) {
    assert.throws(() => forumCredential(value), error => error.code === 'unauthorized');
  }
});

test('public profile 200, wrong account and missing private fields cannot authenticate', () => {
  assert.equal(verifySelfProfile(profile(), '1'), '1');
  for (const value of [profile('2'), { data: { type: 'users', id: '1', attributes: { username: 'public' } } },
    profile('01'), profile('1', { email: null }), profile('1', { isAdmin: 'false' }), profile('1', { isEmailConfirmed: undefined }),
    { ...profile(), data: { ...profile().data, type: 'posts' } }]) {
    assert.throws(() => verifySelfProfile(value, '1'), error => error.code === 'unauthorized');
  }
});

test('forum verification uses only trusted fixed HTTPS endpoint, private fields and no redirects/cookies', async () => {
  assert.equal(await verifyForum(forumCredential(`Bearer ${forumBearer()}`), { fetchImpl: forumFetch }), '1');
  for (const status of [401, 403, 302, 500]) {
    await assert.rejects(verifyForum({ accountId: '1', token: 'A'.repeat(40) }, {
      fetchImpl: async () => new Response('SECRET PROVIDER BODY', { status }) }),
    error => error instanceof AccountError && !error.message.includes('SECRET') && error.status === ([401, 403].includes(status) ? 401 : 503));
  }
  await assert.rejects(verifyForum({ accountId: '1', token: 'A'.repeat(40) }, {
    fetchImpl: async () => Response.json({ data: { type: 'users', id: '1', attributes: { username: 'public' } } }) }),
  error => error.code === 'unauthorized');
});

test('oversized, streamed, malformed and network profile responses fail with fixed errors', async () => {
  for (const fetchImpl of [async () => new Response('x'.repeat(131073)),
    async () => new Response('', { headers: { 'content-length': '131073' } }),
    async () => new Response('{bad'), async () => { throw new Error('secret credential and body'); }]) {
    await assert.rejects(verifyForum({ accountId: '1', token: 'A'.repeat(40) }, { fetchImpl }),
      error => error.code === 'forum_unavailable' && !error.message.includes('secret'));
  }
});

test('registration accepts canonical P-256 SPKI only, rejects key substitution and malformed display names', () => {
  const good = device().body;
  assert.equal(publicKeyFingerprint(good.publicKey).length, 64);
  assert.equal(registration(good), good);
  const otherCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  for (const body of [{ ...good, publicKey: `${good.publicKey}=` }, { ...good, publicKey: otherCurve },
    { ...good, publicKey: Buffer.from('invalid').toString('base64url') }, { ...good, deviceName: 'bad\nname' },
    { ...good, deviceName: 'x'.repeat(129) }, { ...good, deviceId: 'not-uuid' }, { ...good, identityProvider: 'https://evil.invalid' },
    { ...good, deviceName: ' key ' }, { ...good, kind: 'server' }]) assert.throws(() => registration(body), AccountError);
});
