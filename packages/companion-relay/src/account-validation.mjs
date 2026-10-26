import { createHash, createPublicKey } from 'node:crypto';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const DEVICE_TICKET = /^[A-Za-z0-9_-]{43}$/;
export const TICKET_TTL_MS = 15 * 60_000;
export const REQUEST_TTL_MS = 5 * 60_000;
export const PRESENCE_TTL_MS = 120_000;
export const DEFAULT_ACCOUNT_LIMITS = Object.freeze({ maxAccounts: 256, maxDevices: 4096,
  maxDevicesPerAccount: 16, maxRequests: 4096, maxRequestsPerAccount: 64,
  maxSocketsPerAccount: 16, maxHttpBodyBytes: 8192, maxHttpRequestsPerMinute: 240,
  maxSessionsPerIpPerMinute: 8, maxConcurrentHttp: 64, maxConcurrentForum: 8,
  maxHttpMetadataBytesPerMinute: 8 * 1024 * 1024 });

const MESSAGES = Object.freeze({ bad_request: 'Invalid request.', unauthorized: 'Authentication required.',
  forbidden: 'Operation not permitted.', not_found: 'Resource not found.', conflict: 'Resource conflicts with existing state.',
  expired: 'Enrollment request expired.', rate_limited: 'Too many requests.', capacity: 'Service capacity reached.',
  body_too_large: 'Request body exceeds limit.', request_timeout: 'Request timed out.',
  secure_transport_required: 'Secure transport required.', forum_unavailable: 'Account verification unavailable.',
  internal_error: 'Service unavailable.' });

export class AccountError extends Error {
  constructor(code, status = 400) { super(MESSAGES[code] ?? MESSAGES.internal_error); this.code = code; this.status = status; }
}
export const deny = (code, status) => { throw new AccountError(code, status); };
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
export const hash = value => createHash('sha256').update(value).digest('hex');

export function accountId(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
}
export function base64(value, min, max = min) {
  if (typeof value !== 'string' || value.length > Math.ceil(max * 4 / 3) + 2 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length >= min && bytes.length <= max && bytes.toString('base64url') === value;
}
export function publicKeyFingerprint(value) {
  if (!base64(value, 80, 160)) return null;
  try {
    const der = Buffer.from(value, 'base64url');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      || !key.export({ format: 'der', type: 'spki' }).equals(der)) return null;
    return hash(der);
  } catch { return null; }
}
export function validName(value) {
  return typeof value === 'string' && value === value.trim() && value.length > 0
    && Buffer.byteLength(value) <= 128 && !/[\p{Cc}\p{Cf}]/u.test(value);
}
export function registration(value) {
  if (!exact(value, ['deviceId', 'deviceName', 'kind', 'publicKey']) || typeof value.deviceId !== 'string'
    || !UUID.test(value.deviceId) || !validName(value.deviceName) || !['desktop', 'phone'].includes(value.kind)
    || !publicKeyFingerprint(value.publicKey)) deny('bad_request', 400);
  return value;
}
export function validEnvelope(value) {
  return exact(value, ['nonce', 'ciphertext']) && base64(value.nonce, 12) && base64(value.ciphertext, 16, 4096);
}
