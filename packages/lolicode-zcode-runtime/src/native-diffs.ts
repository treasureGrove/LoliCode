/** Read-only V4 file-change projection. Rewind is never invoked here.
 * Pinned contract: shared/zcode-protocol-v4/transport.ts fileChanges;
 * the turnHeader row's stable {rowId,entityId} identifies its change set. */
export interface NativeAgentDiff {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "modified";
}
type Target = {
  workspacePath: string;
  sessionId: string;
  [key: string]: unknown;
};
type Header = {
  rowId: number;
  entityId: string;
  fileChanges: {
    files: number;
    additions: number;
    deletions: number;
    state?: string;
  };
};
type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};
type Changes = {
  state?: "active" | "reverted";
  items: {
    path: string;
    additions: number;
    deletions: number;
    patches: Hunk[];
  }[];
};
type Snapshot = {
  revision: number;
  logEpoch: string;
  rows: { window: unknown[] };
};
type Owner = {
  conversationFileChangesV4(
    args: Target & {
      target: { rowId: number; entityId: string };
      baseRevision: number;
      baseLogEpoch: string;
    },
  ): Promise<Changes>;
};
type Cache = {
  epoch: string;
  signature?: string;
  turns: Map<string, NativeAgentDiff[]>;
  inFlight?: { signature: string; result: Promise<NativeAgentDiff[]> };
  generation: number;
};

function headers(snapshot: Snapshot): Header[] {
  return snapshot.rows.window.filter(
    (raw): raw is Header & { kind: string } => {
      if (!raw || typeof raw !== "object") return false;
      const row = raw as Header & { kind: string };
      return (
        row.kind === "turnHeader" &&
        Number.isSafeInteger(row.rowId) &&
        typeof row.entityId === "string" &&
        !!row.entityId &&
        row.fileChanges?.files > 0 &&
        row.fileChanges.state !== "reverted"
      );
    },
  );
}
function patch(path: string, hunks: Hunk[]): string {
  if (!hunks.length) return "";
  const name = (prefix: string) =>
    /[\s"\\]/.test(path)
      ? JSON.stringify(`${prefix}/${path}`)
      : `${prefix}/${path}`;
  return (
    [
      `diff --git ${name("a")} ${name("b")}`,
      `--- ${name("a")}`,
      `+++ ${name("b")}`,
      ...hunks.flatMap((hunk) => [
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...hunk.lines,
      ]),
    ].join("\n") + "\n"
  );
}
export function projectNativeFileChanges(changes: Changes): NativeAgentDiff[] {
  if (changes.state === "reverted") return [];
  return changes.items.map((item) => ({
    path: item.path,
    additions: item.additions,
    deletions: item.deletions,
    patch: patch(item.path, item.patches),
    status: "modified",
  }));
}
function combine(turns: Iterable<NativeAgentDiff[]>): NativeAgentDiff[] {
  const files = new Map<string, NativeAgentDiff>();
  for (const diffs of turns)
    for (const diff of diffs) {
      const previous = files.get(diff.path);
      files.set(
        diff.path,
        previous
          ? {
              ...previous,
              patch: previous.patch + diff.patch,
              additions: previous.additions + diff.additions,
              deletions: previous.deletions + diff.deletions,
            }
          : { ...diff },
      );
    }
  return [...files.values()];
}

export function createNativeDiffCollector(agent: Owner) {
  const caches = new Map<string, Cache>();
  return {
    async collect(
      target: Target,
      snapshot: Snapshot,
    ): Promise<NativeAgentDiff[]> {
      const key = JSON.stringify([target.workspacePath, target.sessionId]);
      let cache = caches.get(key);
      if (!cache || cache.epoch !== snapshot.logEpoch) {
        cache = { epoch: snapshot.logEpoch, turns: new Map(), generation: 0 };
        caches.set(key, cache);
      }
      const rows = headers(snapshot);
      const signature = JSON.stringify([
        snapshot.revision,
        rows.map((row) => [row.rowId, row.entityId, row.fileChanges]),
      ]);
      if (cache.signature === signature) return combine(cache.turns.values());
      if (cache.inFlight?.signature === signature) return cache.inFlight.result;
      const generation = ++cache.generation;
      const current = cache;
      const operation = (async () => {
        const turns = new Map<string, NativeAgentDiff[]>();
        let failed = false;
        for (const row of rows) {
          try {
            const changes = await agent.conversationFileChangesV4({
              ...target,
              target: { rowId: row.rowId, entityId: row.entityId },
              baseRevision: snapshot.revision,
              baseLogEpoch: snapshot.logEpoch,
            });
            turns.set(row.entityId, projectNativeFileChanges(changes));
          } catch {
            // A row can advance between snapshot and this read. Keep only that
            // same turn's last authoritative patch and retry next collection.
            failed = true;
            const previous = current.turns.get(row.entityId);
            if (previous) turns.set(row.entityId, previous);
          }
        }
        if (current.generation === generation) {
          current.turns = turns;
          current.signature = failed ? undefined : signature;
        }
        return combine(turns.values());
      })();
      current.inFlight = { signature, result: operation };
      try {
        return await operation;
      } finally {
        if (current.inFlight?.result === operation)
          current.inFlight = undefined;
      }
    },
    dispose() {
      caches.clear();
    },
  };
}
