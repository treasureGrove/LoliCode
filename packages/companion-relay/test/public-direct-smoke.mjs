// Explicit smoke command; deliberately not named *.test.mjs. Unit tests never
// contact production. This uses no forum credentials or registered identities.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

function destinations(httpBase, wsUrl, local) {
  const http = new URL(httpBase);
  const ws = new URL(wsUrl);
  for (const url of [http, ws]) assert(!url.username && !url.password && !url.search && !url.hash, 'Credential-free fixed endpoints required');
  if (local) {
    for (const url of [http, ws]) assert(['127.0.0.1', '[::1]'].includes(url.hostname), 'Only explicit loopback development endpoints permitted');
    assert.equal(http.protocol, 'http:'); assert.equal(ws.protocol, 'ws:');
    assert.equal(http.origin.replace('http:', 'ws:'), ws.origin);
    assert.equal(ws.pathname, '/companion');
    assert.equal(http.pathname, '/v2');
  } else {
    assert.equal(http.href, 'https://lolicode.com/companion/v2');
    assert.equal(ws.href, 'wss://lolicode.com/companion/ws');
  }
  return { http, ws };
}

async function json(url, expectedStatus) {
  const response = await fetch(url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(5000),
    headers: { accept: 'application/json' } });
  assert.equal(response.status, expectedStatus);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('set-cookie'), null);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    assert(size <= 4096, 'Unexpected response size');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function rejection(url, frame, expectedCodes) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: 5000 });
    let rejected = false;
    const deadline = setTimeout(() => { socket.terminate(); reject(new Error('Control rejection timed out')); }, 5000);
    socket.on('open', () => socket.send(JSON.stringify(frame)));
    socket.on('error', () => { clearTimeout(deadline); reject(new Error('Control connection failed')); });
    socket.on('message', bytes => {
      try {
        const value = JSON.parse(bytes.toString());
        assert.equal(value.type, 'error');
        assert(expectedCodes.includes(value.code));
        rejected = true;
      } catch { socket.terminate(); clearTimeout(deadline); reject(new Error('Unexpected control acceptance/response')); }
    });
    socket.on('close', code => { clearTimeout(deadline); rejected && code === 1008 ? resolve() : reject(new Error('Expected policy rejection')); });
  });
}

export async function runDirectSmoke({ httpBase = 'https://lolicode.com/companion/v2',
  wsUrl = 'wss://lolicode.com/companion/ws', allowInsecureLocal = false } = {}) {
  const { http, ws } = destinations(httpBase, wsUrl, allowInsecureLocal);
  const healthUrl = new URL(allowInsecureLocal ? '/health' : '/companion/health', http);
  const health = await json(healthUrl, 200);
  assert.equal(health.accountProtocol, 2);
  assert.equal(health.transportPolicy, 'directPreferredTextFallback');
  assert.equal(health.textRelay, true);
  assert.equal(health.textLimits?.frameBytes, 8192);
  for (const [name, ceiling] of Object.entries({ bytesPerSecond: 8192, accountBytesPerSecond: 2048, monthlyBytes: 2 * 1024 ** 3 })) {
    assert(Number.isSafeInteger(health.textLimits?.[name]) && health.textLimits[name] > 0 && health.textLimits[name] <= ceiling);
  }
  assert.equal(health.legacyDataRelay, false);
  assert.equal(health.pushConfigured, false);
  assert.deepEqual(await json(`${http.href}/devices`, 401), { error: { code: 'unauthorized', message: 'Authentication required.' } });
  await rejection(ws, { type: 'hello', v: 1, role: 'desktop', roomId: randomBytes(16).toString('hex'),
    token: randomBytes(32).toString('hex'), phoneToken: randomBytes(32).toString('hex') }, ['direct_only']);
  await rejection(ws, { type: 'packet', v: 1, id: randomUUID(), nonce: randomBytes(12).toString('base64url'),
    ciphertext: randomBytes(16).toString('base64url') }, ['invalid_hello']);
  return { directPreferredTextFallback: true, accountProtocol: 2, unauthenticatedDirectory401: true,
    anonymousLegacyRejected: true, unauthenticatedPacketRejected: true, realAccountUsed: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.info(JSON.stringify(await runDirectSmoke())); }
  catch { console.error('Companion control smoke failed; no credentials or provider response logged.'); process.exitCode = 1; }
}
