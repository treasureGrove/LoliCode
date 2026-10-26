import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import { FcmProvider } from '../src/fcm.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const credential = { type: 'service_account', project_id: 'lolicode-test',
  client_email: 'relay@lolicode-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
const notice = { roomId: 'a'.repeat(32), eventId: 'evt1', kind: 'approval_required', sessionId: 'session1' };

test('unconfigured FCM makes no requests', async () => {
  const provider = new FcmProvider({ fetchImpl: () => assert.fail('Network must not be called') });
  assert.equal(provider.configured, false);
  assert.deepEqual(await provider.send('token', notice), { accepted: false, delivered: false, status: 'unconfigured' });
});

test('FCM HTTP v1 uses signed OAuth assertion, generic high priority private notification and cached access token', async () => {
  const requests = [];
  const provider = new FcmProvider({ serviceAccount: credential, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify(url.includes('oauth2')
      ? { access_token: 'test-access', expires_in: 3600 }
      : { name: 'projects/lolicode-test/messages/test-receipt' }), { status: 200 });
  } });
  assert.deepEqual(await provider.send('test-registration', notice), { accepted: true, delivered: false, status: 'accepted' });
  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/token');
  const assertion = requests[0].options.body.get('assertion');
  const [header, payload, signature] = assertion.split('.');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')), true);
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).scope, 'https://www.googleapis.com/auth/firebase.messaging');
  const request = requests[1];
  assert.equal(request.url, 'https://fcm.googleapis.com/v1/projects/lolicode-test/messages:send');
  assert.equal(request.options.headers.authorization, 'Bearer test-access');
  const message = JSON.parse(request.options.body).message;
  assert.deepEqual(message.data, notice);
  assert.equal(message.token, 'test-registration');
  assert.equal(message.android.priority, 'HIGH');
  assert.equal(message.android.ttl, '300s');
  assert.equal(message.android.notification.visibility, 'PRIVATE');
  assert.equal(message.android.notification.channel_id, 'lolicode_tasks');
  assert.match(message.notification.body, /解锁/);
  assert.equal(request.options.redirect, 'error');
  await provider.send('test-registration', notice);
  assert.equal(requests.length, 3);
});

test('FCM provider failures never report acceptance or delivery and never expose provider body', async () => {
  for (const status of [401, 403, 429, 500]) {
    const provider = new FcmProvider({ serviceAccount: credential, fetchImpl: async url => new Response(JSON.stringify(url.includes('oauth2')
      ? { access_token: 'private-oauth', expires_in: 3600 } : { secret: 'not-for-client' }), { status: url.includes('oauth2') ? 200 : status }) });
    assert.deepEqual(await provider.send('token', notice), { accepted: false, delivered: false, status: 'failed' });
  }
  const provider = new FcmProvider({ serviceAccount: credential, fetchImpl: async () => { throw new Error('private credential in arbitrary error'); } });
  assert.deepEqual(await provider.send('token', notice), { accepted: false, delivered: false, status: 'failed' });
});

test('FCM refuses alternate credential endpoints and malformed identity', () => {
  assert.throws(() => new FcmProvider({ serviceAccount: { ...credential, token_uri: 'https://attacker.invalid' } }), /Invalid FCM/);
  assert.throws(() => new FcmProvider({ serviceAccount: { ...credential, project_id: '../bad' } }), /Invalid FCM/);
});
