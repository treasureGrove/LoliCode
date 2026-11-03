const requestIdentities = new Map<
  string,
  { fingerprint: string; id: string }
>();

/** Keep an uncertain submission's identity across retries and page reloads. */
export function requestIdentity(scope: string, fingerprint: string): string {
  const key = `lolicode.agent.secretary-request:${scope}`;
  const local = requestIdentities.get(key);
  if (local?.fingerprint === fingerprint) return local.id;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || "null");
    if (saved?.fingerprint === fingerprint && typeof saved.id === "string") {
      requestIdentities.set(key, saved);
      return saved.id;
    }
  } catch {
    // Storage may be unavailable; the backend still deduplicates this request ID.
  }
  const id = `secretary:${crypto.randomUUID()}`;
  requestIdentities.set(key, { fingerprint, id });
  try {
    sessionStorage.setItem(key, JSON.stringify({ fingerprint, id }));
  } catch {
    // A storage failure must not prevent ordinary work.
  }
  return id;
}

export function clearRequestIdentity(scope: string) {
  const key = `lolicode.agent.secretary-request:${scope}`;
  requestIdentities.delete(key);
  try {
    sessionStorage.removeItem(key);
  } catch {
    // The operation is already confirmed even if local cleanup fails.
  }
}

export async function bounded<T>(
  request: Promise<T>,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function safeGithubUrl(input: string): string | undefined {
  try {
    const url = new URL(input);
    if (url.origin === "https://github.com" && !url.username && !url.password)
      return url.href;
  } catch {
    // The source record remains usable when a link cannot be opened.
  }
}
