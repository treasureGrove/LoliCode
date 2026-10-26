import { AccountError, accountId, deny, object } from './account-validation.mjs';

const MAX_PROFILE_BYTES = 131_072;

export function forumCredential(authorization) {
  const match = typeof authorization === 'string' && /^Bearer lc1\.([1-9][0-9]{0,19})\.([A-Za-z0-9]{40})$/.exec(authorization);
  if (!match || !accountId(match[1])) deny('unauthorized', 401);
  return { accountId: match[1], token: match[2] };
}

// A public Flarum profile can return 200 even when it ignores a bad token.
// Only CurrentUserSerializer supplies all three private fields below.
export function verifySelfProfile(value, expectedAccountId) {
  const data = value?.data;
  const id = typeof data?.id === 'number' && Number.isSafeInteger(data.id) ? String(data.id) : data?.id;
  const attributes = data?.attributes;
  if (!object(data) || data.type !== 'users' || !accountId(id) || id !== expectedAccountId
    || !object(attributes) || typeof attributes.isEmailConfirmed !== 'boolean'
    || typeof attributes.email !== 'string' || typeof attributes.isAdmin !== 'boolean') deny('unauthorized', 401);
  return expectedAccountId;
}

export async function verifyForum(credential, { fetchImpl = fetch, signal } = {}) {
  try {
    if (!accountId(credential?.accountId) || typeof credential.token !== 'string'
      || !/^[A-Za-z0-9]{40}$/.test(credential.token)) deny('unauthorized', 401);
    const response = await fetchImpl(`https://lolicode.com/api/users/${credential.accountId}`, {
      method: 'GET', headers: { accept: 'application/json', authorization: `Token ${credential.token}` },
      redirect: 'error', credentials: 'omit', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]) });
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); deny('unauthorized', 401); }
    if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > MAX_PROFILE_BYTES) {
      await response.body?.cancel(); deny('forum_unavailable', 503);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_PROFILE_BYTES) deny('forum_unavailable', 503);
      chunks.push(Buffer.from(chunk));
    }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { deny('forum_unavailable', 503); }
    return verifySelfProfile(value, credential.accountId);
  } catch (error) {
    if (error instanceof AccountError) throw error;
    deny('forum_unavailable', 503);
  }
}
