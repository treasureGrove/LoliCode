import { AccountError, deny, exact, registration } from './account-validation.mjs';
import { forumCredential, verifyForum } from './forum.mjs';

function authorization(request) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index].toLowerCase() === 'authorization') count++;
  if (count !== 1 || typeof request.headers.authorization !== 'string') deny('unauthorized', 401);
  return request.headers.authorization;
}

function readJson(request, limit, addBytes) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) deny('bad_request', 400);
  if (Number(request.headers['content-length']) > limit) deny('body_too_large', 413);
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => { clearTimeout(timer); request.removeListener('data', data); request.removeListener('end', end);
      request.removeListener('aborted', aborted); request.removeListener('error', aborted); };
    const fail = error => { cleanup(); request.pause(); reject(error); };
    const data = chunk => {
      addBytes(chunk.byteLength);
      size += chunk.byteLength;
      if (size > limit) { fail(new AccountError('body_too_large', 413)); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new AccountError('bad_request', 400)); }
    };
    const aborted = () => fail(new AccountError('bad_request', 400));
    const timer = setTimeout(() => fail(new AccountError('request_timeout', 408)), 5000);
    timer.unref();
    request.on('data', data); request.once('end', end); request.once('aborted', aborted); request.once('error', aborted);
  });
}

export function createAccountHandler({ accounts, limits, forumFetch, signal, context, ipState, addTraffic, now = Date.now }) {
  let inflight = 0;
  let forumInflight = 0;
  const metadataBudget = { at: now(), bytes: 0 };
  function reserveMutation(route, method) {
    if (!['POST', 'DELETE'].includes(method)) return;
    if (now() - metadataBudget.at >= 60_000) { metadataBudget.at = now(); metadataBudget.bytes = 0; }
    // Reserve a conservative maximum DTO before any mutation, so a bandwidth
    // rejection never consumes approval or silently issues a lost ticket.
    const reserve = route === '/v2/session' ? 2048 : route === '/v2/presence' || route === '/v2/device' || route.endsWith('/revoke') ? 64 : 8192;
    if (metadataBudget.bytes + reserve > limits.maxHttpMetadataBytesPerMinute) {
      addTraffic('httpBudgetRejected', 1); deny('rate_limited', 429);
    }
  }
  return async function handle(request, response) {
    let entered = false;
    const respond = (status, value) => {
      if (response.destroyed) return;
      if (now() - metadataBudget.at >= 60_000) { metadataBudget.at = now(); metadataBudget.bytes = 0; }
      let encoded = JSON.stringify(value);
      if (status < 400) {
        if (metadataBudget.bytes + Buffer.byteLength(encoded) > limits.maxHttpMetadataBytesPerMinute) {
          const failure = new AccountError('rate_limited', 429);
          status = 429;
          encoded = JSON.stringify({ error: { code: failure.code, message: failure.message } });
          addTraffic('httpBudgetRejected', 1);
        } else { metadataBudget.bytes += Buffer.byteLength(encoded); addTraffic('httpMetadataBytesOut', Buffer.byteLength(encoded)); }
      }
      addTraffic('httpBytesOut', Buffer.byteLength(encoded));
      response.setHeader('content-length', Buffer.byteLength(encoded));
      // Failed authentication/body validation never leaves an unread request on
      // a reusable connection. No request contents are logged.
      if (status >= 400) response.setHeader('connection', 'close');
      response.writeHead(status).end(encoded);
    };
    try {
      if (!request.url?.startsWith('/v2/')) deny('not_found', 404);
      if (request.headers.origin !== undefined || request.headers.cookie !== undefined) deny('forbidden', 403);
      const { secure, ip } = context(request);
      if (!secure) deny('secure_transport_required', 426);
      const rate = ipState(ip);
      if (++rate.http > limits.maxHttpRequestsPerMinute) deny('rate_limited', 429);
      if (inflight >= limits.maxConcurrentHttp) deny('capacity', 503);
      inflight++; entered = true;
      addTraffic('httpRequests', 1);
      const route = request.url;
      const session = request.method === 'POST' && route === '/v2/session';
      // Rate limiting happens before credential parsing, key parsing and forum IO.
      if (session && ++rate.sessions > limits.maxSessionsPerIpPerMinute) deny('rate_limited', 429);
      if (/[?#%]/.test(route)) deny('not_found', 404);
      reserveMutation(route, request.method);
      if (session) {
        const credential = forumCredential(authorization(request));
        const body = registration(await readJson(request, limits.maxHttpBodyBytes, bytes => addTraffic('httpBytesIn', bytes)));
        const generation = accounts.generation(body.deviceId);
        if (forumInflight >= limits.maxConcurrentForum) deny('capacity', 503);
        forumInflight++;
        try { await verifyForum(credential, { fetchImpl: forumFetch, signal }); }
        finally { forumInflight--; }
        if (signal.aborted) deny('internal_error', 503);
        reserveMutation(route, request.method);
        respond(200, accounts.session(credential.accountId, body, generation));
        return;
      }
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization(request));
      if (!match) deny('unauthorized', 401);
      const ticket = accounts.authorize(match[1]);
      const body = request.method === 'POST'
        ? await readJson(request, limits.maxHttpBodyBytes, bytes => addTraffic('httpBytesIn', bytes)) : undefined;
      if (request.method !== 'POST' && (Number(request.headers['content-length'] ?? 0) !== 0 || request.headers['transfer-encoding'])) deny('bad_request', 400);
      // Recheck after async body receipt: logout or expiry may have happened.
      accounts.authorizeHash(ticket.digest);
      reserveMutation(route, request.method);
      let result;
      if (request.method === 'GET' && route === '/v2/devices') result = accounts.devices(ticket);
      else if (request.method === 'POST' && route === '/v2/presence') {
        if (!exact(body, [])) deny('bad_request', 400);
        accounts.presence(ticket); result = { ok: true };
      } else if (request.method === 'DELETE' && route === '/v2/device') result = accounts.deleteDevice(ticket);
      else if (request.method === 'GET' && route === '/v2/requests') result = accounts.requests(ticket);
      else if (request.method === 'POST' && route === '/v2/requests') result = accounts.createRequest(ticket, body);
      else {
        const requestRoute = /^\/v2\/requests\/([0-9a-f-]{36})(?:\/(approve|reject))?$/.exec(route);
        const roomRoute = /^\/v2\/rooms\/([a-f0-9]{32})\/revoke$/.exec(route);
        if (requestRoute && request.method === 'GET' && !requestRoute[2]) result = accounts.requestDto(accounts.request(ticket, requestRoute[1]));
        else if (requestRoute && request.method === 'POST' && requestRoute[2] === 'approve') result = accounts.approve(ticket, requestRoute[1], body);
        else if (requestRoute && request.method === 'POST' && requestRoute[2] === 'reject') result = accounts.reject(ticket, requestRoute[1], body);
        else if (roomRoute && request.method === 'POST') result = accounts.revokeRoom(ticket, roomRoute[1], body);
        else deny('not_found', 404);
      }
      respond(200, result);
    } catch (error) {
      const failure = error instanceof AccountError ? error : new AccountError(error?.code === 'capacity' ? 'capacity' : 'internal_error', 503);
      respond(failure.status, { error: { code: failure.code, message: failure.message } });
    } finally { if (entered) inflight--; }
  };
}
