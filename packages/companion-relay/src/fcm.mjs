import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
export const NOTICE_KINDS = new Set(['approval_required', 'question_required', 'task_completed', 'task_failed']);

const copy = {
  approval_required: ['LoliCode 需要审批', '有一项操作等待处理，请解锁手机查看。'],
  question_required: ['LoliCode 需要回复', '有一项问题等待处理，请解锁手机查看。'],
  task_completed: ['LoliCode 任务已完成', '任务结果已就绪，请解锁手机查看。'],
  task_failed: ['LoliCode 任务未完成', '请解锁手机查看任务状态。'],
};

async function boundedJson(response) {
  if (!response.body) throw new Error('Provider response unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) { await reader.cancel(); throw new Error('Provider response too large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// Deliberately supports only an explicitly selected service account file. Never
// searches the developer's home directory, logs credentials, or returns bodies.
export class FcmProvider {
  constructor({ serviceAccountPath, serviceAccount, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
    this.credential = serviceAccount ?? (serviceAccountPath ? JSON.parse(readFileSync(serviceAccountPath, 'utf8')) : null);
    this.configured = Boolean(this.credential);
    if (!this.configured) return;
    const c = this.credential;
    if (c.type !== 'service_account' || !/^[a-z][a-z0-9-]{4,62}$/.test(c.project_id)
      || typeof c.client_email !== 'string' || c.client_email.length > 320
      || !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(c.client_email)
      || (c.token_uri && c.token_uri !== TOKEN_ENDPOINT)) throw new Error('Invalid FCM service account configuration');
    try { this.privateKey = createPrivateKey(c.private_key); }
    catch { throw new Error('Invalid FCM service account key'); }
    if (this.privateKey.asymmetricKeyType !== 'rsa') throw new Error('FCM service account must use RSA');
  }

  async accessToken() {
    if (this.cached && this.cached.expiresAt > this.now() + 60_000) return this.cached.token;
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshAccessToken();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }

  async refreshAccessToken() {
    const iat = Math.floor(this.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iss: this.credential.client_email, scope: SCOPE,
      aud: TOKEN_ENDPOINT, iat, exp: iat + 3600 })).toString('base64url');
    const unsigned = `${header}.${payload}`;
    const signature = sign('RSA-SHA256', Buffer.from(unsigned), this.privateKey).toString('base64url');
    const response = await this.fetch(TOKEN_ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('FCM authorization failed'); }
    const value = await boundedJson(response);
    if (typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 8192
      || !Number.isFinite(value.expires_in) || value.expires_in < 60) throw new Error('FCM authorization response invalid');
    this.cached = { token: value.access_token, expiresAt: this.now() + Math.min(value.expires_in, 3600) * 1000 };
    return value.access_token;
  }

  async send(token, notice) {
    if (!this.configured) return { accepted: false, delivered: false, status: 'unconfigured' };
    try {
      const access = await this.accessToken();
      const [title, body] = copy[notice.kind];
      const response = await this.fetch(`https://fcm.googleapis.com/v1/projects/${this.credential.project_id}/messages:send`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token, data: { roomId: notice.roomId, eventId: notice.eventId,
          kind: notice.kind, sessionId: notice.sessionId }, notification: { title, body },
          android: { priority: 'HIGH', ttl: '300s', notification: { channel_id: 'lolicode_tasks',
            visibility: 'PRIVATE', tag: notice.eventId } } } }),
      });
      if (!response.ok) {
        this.cached = response.status === 401 ? null : this.cached;
        await response.body?.cancel();
        return { accepted: false, delivered: false, status: 'failed' };
      }
      const result = await boundedJson(response);
      return typeof result.name === 'string' && result.name.length <= 1024
        ? { accepted: true, delivered: false, status: 'accepted' }
        : { accepted: false, delivered: false, status: 'failed' };
    } catch { return { accepted: false, delivered: false, status: 'failed' }; }
  }
}
