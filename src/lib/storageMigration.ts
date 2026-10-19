/** Read renamed device preferences without deleting the previous version's copy. */
export function readMigratedStorage(
  key: string,
  legacyKeys: string[] = [],
): string | null {
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;
    for (const legacy of legacyKeys) {
      const value = localStorage.getItem(legacy);
      if (value === null) continue;
      try {
        localStorage.setItem(key, value);
      } catch {
        /* A full store must not lose the saved preference. */
      }
      return value;
    }
  } catch {
    /* Unavailable storage behaves like a fresh preference. */
  }
  return null;
}
