import { describe, expect, it, vi } from "vitest";
import { createNativeDiffCollector } from "../../packages/lolicode-zcode-runtime/src/native-diffs";

const target = { workspacePath: "D:/owned/project", sessionId: "native-owned" };
const header = (id: string, rowId: number, state = "active") => ({
  kind: "turnHeader",
  entityId: id,
  rowId,
  fileChanges: { files: 1, additions: 2, deletions: 1, state },
});
const snapshot = (rows: unknown[], revision = 3, logEpoch = "owned-epoch") => ({
  revision,
  logEpoch,
  rows: { window: rows },
});
const changes = (path = "src/owned.ts", text = "actual") => ({
  state: "active" as const,
  items: [
    {
      path,
      additions: 2,
      deletions: 1,
      writeCount: 1,
      toolNames: ["edit"],
      patches: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: ["-before", `+${text}`, "+after"],
        },
      ],
    },
  ],
});

describe("native V4 authoritative file changes", () => {
  it("uses the stable turn row and exact native revision/epoch without invoking rewind", async () => {
    const owner = {
      conversationFileChangesV4: vi.fn().mockResolvedValue(changes()),
    };
    const collector = createNativeDiffCollector(owner);
    const result = await collector.collect(
      target,
      snapshot([header("turn-a", 7)]),
    );
    expect(owner.conversationFileChangesV4).toHaveBeenCalledWith({
      ...target,
      target: { rowId: 7, entityId: "turn-a" },
      baseRevision: 3,
      baseLogEpoch: "owned-epoch",
    });
    expect(result).toEqual([
      {
        path: "src/owned.ts",
        additions: 2,
        deletions: 1,
        status: "modified",
        patch:
          "diff --git a/src/owned.ts b/src/owned.ts\n--- a/src/owned.ts\n+++ b/src/owned.ts\n@@ -1,1 +1,2 @@\n-before\n+actual\n+after\n",
      },
    ]);
  });

  it("aggregates real patches by path and skips reverted turn changes", async () => {
    const owner = {
      conversationFileChangesV4: vi
        .fn()
        .mockResolvedValueOnce(changes("same.ts", "first"))
        .mockResolvedValueOnce(changes("same.ts", "second")),
    };
    const result = await createNativeDiffCollector(owner).collect(
      target,
      snapshot([
        header("a", 1),
        header("reverted", 2, "reverted"),
        header("b", 3),
      ]),
    );
    expect(owner.conversationFileChangesV4).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0].additions).toBe(4);
    expect(result[0].deletions).toBe(2);
    expect(result[0].patch).toContain("+first");
    expect(result[0].patch).toContain("+second");
  });

  it("caches the same snapshot while keeping workspace/session identity isolated", async () => {
    const owner = {
      conversationFileChangesV4: vi.fn().mockResolvedValue(changes()),
    };
    const collector = createNativeDiffCollector(owner);
    const state = snapshot([header("a", 1)]);
    await collector.collect(target, state);
    await collector.collect(target, state);
    expect(owner.conversationFileChangesV4).toHaveBeenCalledTimes(1);
    await collector.collect(
      { ...target, workspacePath: "D:/owned/other" },
      state,
    );
    expect(owner.conversationFileChangesV4).toHaveBeenCalledTimes(2);
  });

  it("retains a previously successful patch after a stale read then retries that revision", async () => {
    const owner = {
      conversationFileChangesV4: vi
        .fn()
        .mockResolvedValueOnce(changes())
        .mockRejectedValueOnce(new Error("proto.staleRevision"))
        .mockResolvedValueOnce(changes("src/owned.ts", "updated")),
    };
    const collector = createNativeDiffCollector(owner);
    const previous = await collector.collect(
      target,
      snapshot([header("a", 1)]),
    );
    expect(
      await collector.collect(target, snapshot([header("a", 1)], 4)),
    ).toEqual(previous);
    const recovered = await collector.collect(
      target,
      snapshot([header("a", 1)], 4),
    );
    expect(recovered[0].patch).toContain("+updated");
    expect(owner.conversationFileChangesV4).toHaveBeenCalledTimes(3);
  });

  it("does not leak reverted or previous-epoch patches into a changed history", async () => {
    const owner = {
      conversationFileChangesV4: vi
        .fn()
        .mockResolvedValueOnce(changes())
        .mockRejectedValueOnce(new Error("unavailable")),
    };
    const collector = createNativeDiffCollector(owner);
    await collector.collect(target, snapshot([header("a", 1)]));
    expect(
      await collector.collect(
        target,
        snapshot([header("a", 1, "reverted")], 4),
      ),
    ).toEqual([]);
    expect(
      await collector.collect(
        target,
        snapshot([header("a", 1)], 5, "new-epoch"),
      ),
    ).toEqual([]);
  });

  it("coalesces duplicate in-flight reads instead of issuing a second native request", async () => {
    let resolve!: (value: ReturnType<typeof changes>) => void;
    const owner = {
      conversationFileChangesV4: vi.fn().mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      ),
    };
    const collector = createNativeDiffCollector(owner);
    const state = snapshot([header("a", 1)]);
    const first = collector.collect(target, state);
    const second = collector.collect(target, state);
    resolve(changes());
    expect(await first).toEqual(await second);
    expect(owner.conversationFileChangesV4).toHaveBeenCalledOnce();
  });
});
