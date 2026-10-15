/** Read-only V4 history hydration for the bounded renderer snapshot.
 * Matches native conversationProjectionStore.loadOlder/loadAllOlder: an
 * exclusive beforeRowId cursor, canonical rowId ordering and atomic watermarks.
 * Pure row.delta tokens do not bump V4 revision (projection-state.ts), so an
 * exact revision cache avoids refetching history on every streamed token. */
type Row = { rowId: number; [key: string]: unknown };
type Target = {
  workspacePath: string;
  sessionId: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  [key: string]: unknown;
};
type Snapshot = {
  revision: number;
  logEpoch: string;
  rows: { window: unknown[]; firstRowId?: number | null; totalCount?: number };
};
type Owner = {
  conversationRowsRangeV4(
    args: Target & { beforeRowId: number; limit: number },
  ): Promise<{
    rows: unknown[];
    atSeq: number;
    atRevision: number;
    atLogEpoch: string;
    hasMore: boolean;
  }>;
};
export interface NativeHistoryStatus {
  incomplete: boolean;
  truncated: boolean;
  retryable: boolean;
  loadedRows: number;
  limit: number;
  message?: string;
}
type Cache = {
  signature: string;
  prefix: Row[];
  complete: boolean;
  truncated: boolean;
  failed: boolean;
  inFlight?: Promise<void>;
  status: NativeHistoryStatus;
};

function canonical(rows: unknown[]): Row[] {
  const keyed = new Map<number, Row>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Row;
    if (Number.isSafeInteger(row.rowId) && row.rowId >= 0)
      keyed.set(row.rowId, row);
  }
  return [...keyed.values()].sort((a, b) => a.rowId - b.rowId);
}
const keyOf = (target: Target) =>
  JSON.stringify([
    target.workspacePath,
    target.workspaceIdentity ?? null,
    target.remoteSessionId ?? null,
    target.sessionId,
  ]);

export function createNativeHistoryCollector(
  agent: Owner,
  options: { maxRows?: number; maxSessions?: number } = {},
) {
  const maxRows = options.maxRows ?? 10_000;
  const maxSessions = options.maxSessions ?? 8;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100_000)
    throw new Error("Invalid native history row limit");
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 64)
    throw new Error("Invalid native history session limit");
  const caches = new Map<string, Cache>();
  let disposed = false;
  const isCurrent = (key: string, cache: Cache) =>
    !disposed && caches.get(key) === cache;
  const merge = (prefix: Row[], live: Row[]) =>
    canonical([...prefix, ...live]).slice(-maxRows);

  function status(cache: Cache, loadedRows: number): NativeHistoryStatus {
    return {
      incomplete: cache.failed || cache.truncated || !cache.complete,
      truncated: cache.truncated,
      retryable: cache.failed,
      loadedRows,
      limit: maxRows,
      ...(cache.failed
        ? { message: "部分历史暂未加载，下次刷新会重试。" }
        : cache.truncated
          ? { message: `当前显示最近 ${maxRows} 行，更早历史仍保存在会话中。` }
          : {}),
    };
  }

  return {
    async collect(target: Target, snapshot: Snapshot): Promise<Row[]> {
      if (disposed) return [];
      const live = canonical(snapshot.rows.window);
      const anchor = live[0];
      const first = snapshot.rows.firstRowId;
      const key = keyOf(target);
      const signature = JSON.stringify([
        snapshot.logEpoch,
        snapshot.revision,
        anchor?.rowId ?? null,
        anchor?.entityId ?? null,
        anchor?.kind ?? null,
        anchor?.turnId ?? null,
        first ?? null,
        snapshot.rows.totalCount ?? null,
      ]);
      let cache = caches.get(key);
      if (!cache || cache.signature !== signature) {
        cache = {
          signature,
          prefix: [],
          complete: false,
          truncated: false,
          failed: false,
          status: {
            incomplete: true,
            truncated: false,
            retryable: false,
            loadedRows: live.length,
            limit: maxRows,
          },
        };
      }
      // Bounded LRU: a late read of an evicted session cannot restore its cache.
      caches.delete(key);
      caches.set(key, cache);
      while (caches.size > maxSessions) {
        caches.delete(caches.keys().next().value!);
      }
      const current = cache;
      if (!current.complete && !current.truncated && !current.inFlight) {
        const operation = (async () => {
          current.failed = false;
          if (!anchor) {
            current.complete = !(snapshot.rows.totalCount ?? 0);
            current.failed = !current.complete;
            return;
          }
          if (first == null || !Number.isSafeInteger(first)) {
            // Native always supplies firstRowId. Do not silently claim complete
            // when a degraded snapshot says rows exist outside its tail window.
            current.complete =
              (snapshot.rows.totalCount ?? live.length) <= live.length;
            current.failed = !current.complete;
            return;
          }
          if (anchor.rowId < first) {
            current.failed = true;
            return;
          }
          if (anchor.rowId === first) {
            current.complete = true;
            current.truncated = live.length > maxRows;
            return;
          }
          let beforeRowId = current.prefix[0]?.rowId ?? anchor.rowId;
          try {
            while (isCurrent(key, current)) {
              const remaining = maxRows - live.length - current.prefix.length;
              if (remaining <= 0) {
                current.truncated = true;
                break;
              }
              const limit = Math.min(200, remaining);
              const page = await agent.conversationRowsRangeV4({
                ...target,
                beforeRowId,
                limit,
              });
              if (!isCurrent(key, current)) return;
              if (
                page.atLogEpoch !== snapshot.logEpoch ||
                page.atRevision !== snapshot.revision
              )
                throw new Error("Stale native history watermark");
              const older = canonical(page.rows).filter(
                (row) => row.rowId < beforeRowId,
              );
              const next = older[0]?.rowId;
              if (
                next === undefined ||
                next >= beforeRowId ||
                next < first ||
                older.length > limit
              )
                throw new Error("Native history cursor did not advance");
              // Commit only individually verified same-revision pages. A later
              // query failure keeps this valid prefix and retries its cursor.
              current.prefix = canonical([...older, ...current.prefix]);
              beforeRowId = next;
              if (!page.hasMore) {
                if (next !== first)
                  throw new Error("Native history ended before its first row");
                current.complete = true;
                break;
              }
              if (next === first)
                throw new Error("Native history hasMore contradicts first row");
            }
          } catch {
            if (isCurrent(key, current)) current.failed = true;
          }
        })();
        current.inFlight = operation;
        void operation.finally(() => {
          if (current.inFlight === operation) current.inFlight = undefined;
        });
      }
      await current.inFlight;
      if (!isCurrent(key, current)) return live.slice(-maxRows);
      const rows = merge(current.prefix, live);
      current.status = status(current, rows.length);
      return rows;
    },
    status(target: Target): NativeHistoryStatus {
      const cached = caches.get(keyOf(target));
      return cached
        ? { ...cached.status }
        : {
            incomplete: true,
            truncated: false,
            retryable: false,
            loadedRows: 0,
            limit: maxRows,
          };
    },
    dispose() {
      disposed = true;
      caches.clear();
    },
  };
}
