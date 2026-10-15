import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeHistoryCollector } from "./native-history.js";

const target = { workspacePath: "D:/owned/project", sessionId: "native-owned" };
const row = (rowId: number, text = `row-${rowId}`) => ({
  rowId,
  kind: "assistantText",
  entityId: `entity-${rowId}`,
  text,
});
const range = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, offset) => row(first + offset));
const snapshot = (
  window = [row(5), row(6)],
  revision = 3,
  epoch = "epoch-1",
) => ({
  revision,
  logEpoch: epoch,
  rows: { window, firstRowId: 1, totalCount: 6 },
});
const page = (
  rows: ReturnType<typeof row>[],
  hasMore = false,
  revision = 3,
  epoch = "epoch-1",
) => ({
  rows,
  hasMore,
  atRevision: revision,
  atLogEpoch: epoch,
  atSeq: 10,
});
const ids = (rows: { rowId: number }[]) => rows.map((item) => item.rowId);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};

test("hydrates exclusive native pages with a bounded cursor, canonical order and live row priority", async () => {
  const calls: { beforeRowId: number; limit: number }[] = [];
  const collector = createNativeHistoryCollector({
    async conversationRowsRangeV4(args) {
      calls.push(args);
      if (args.beforeRowId === 405) return page(range(205, 404), true);
      if (args.beforeRowId === 205) return page(range(5, 204), true);
      assert.equal(args.beforeRowId, 5);
      return page([
        row(4),
        row(2),
        row(1),
        row(3),
        row(4),
        row(5, "stale-overlap"),
      ]);
    },
  });
  const state = snapshot([row(405, "live"), row(406)]);
  state.rows.totalCount = 406;
  const rows = await collector.collect(target, state);
  assert.deepEqual(
    ids(rows),
    Array.from({ length: 406 }, (_, i) => i + 1),
  );
  assert.equal(rows.find((item) => item.rowId === 405)?.text, "live");
  assert.deepEqual(
    calls.map((call) => call.limit),
    [200, 200, 200],
  );
  assert.equal(collector.status(target).incomplete, false);
});

test("streamed text reuses the exact revision prefix and returns each caller's latest live rows", async () => {
  let calls = 0;
  const collector = createNativeHistoryCollector({
    async conversationRowsRangeV4() {
      calls++;
      return page(range(1, 4));
    },
  });
  await collector.collect(target, snapshot());
  const rows = await collector.collect(
    target,
    snapshot([row(5), row(6, "new token")]),
  );
  assert.equal(calls, 1);
  assert.equal(rows.at(-1)?.text, "new token");
});

test("a terminal revision refresh replaces history so removed branch rows never revive", async () => {
  let calls = 0;
  const collector = createNativeHistoryCollector({
    async conversationRowsRangeV4() {
      calls++;
      return calls === 1
        ? page(range(1, 4))
        : page([row(1), row(2), row(4)], false, 4);
    },
  });
  assert.equal((await collector.collect(target, snapshot())).length, 6);
  const rows = await collector.collect(target, snapshot(undefined, 4));
  assert.deepEqual(ids(rows), [1, 2, 4, 5, 6]);
  assert.equal(calls, 2);
});

test("epoch or revision mismatches keep only the current live window and remain retryable", async () => {
  let response = page(range(1, 4));
  const collector = createNativeHistoryCollector({
    async conversationRowsRangeV4() {
      return response;
    },
  });
  await collector.collect(target, snapshot());
  response = page(range(1, 4), false, 3, "wrong-epoch");
  assert.deepEqual(
    ids(await collector.collect(target, snapshot(undefined, 4))),
    [5, 6],
  );
  assert.equal(collector.status(target).retryable, true);
  response = page(range(1, 4), false, 4, "epoch-2");
  assert.deepEqual(
    ids(await collector.collect(target, snapshot(undefined, 4, "epoch-2"))),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(collector.status(target).incomplete, false);
});

test("a failed later page retains verified same-revision history and resumes its cursor", async () => {
  const cursors: number[] = [];
  let fail = true;
  const collector = createNativeHistoryCollector({
    async conversationRowsRangeV4(args) {
      cursors.push(args.beforeRowId);
      if (args.beforeRowId === 405) return page(range(205, 404), true);
      if (fail) {
        fail = false;
        throw new Error("temporary read failure");
      }
      if (args.beforeRowId === 205) return page(range(5, 204), true);
      return page(range(1, 4));
    },
  });
  const state = snapshot([row(405), row(406)]);
  state.rows.totalCount = 406;
  assert.equal((await collector.collect(target, state)).length, 202);
  assert.equal(collector.status(target).retryable, true);
  assert.equal((await collector.collect(target, state)).length, 406);
  assert.deepEqual(cursors, [405, 205, 205, 5]);
  assert.equal(collector.status(target).incomplete, false);
});

test("the explicit row limit bounds hydration and reports older history instead of pretending complete", async () => {
  let calls = 0;
  const collector = createNativeHistoryCollector(
    {
      async conversationRowsRangeV4(args) {
        calls++;
        assert.equal(args.limit, 3);
        return page(range(6, 8), true);
      },
    },
    { maxRows: 5 },
  );
  const state = snapshot([row(9), row(10)]);
  state.rows.totalCount = 10;
  assert.deepEqual(
    ids(await collector.collect(target, state)),
    [6, 7, 8, 9, 10],
  );
  assert.equal(collector.status(target).truncated, true);
  assert.equal(collector.status(target).retryable, false);
  assert.match(collector.status(target).message!, /5 行/);
  await collector.collect(target, state);
  assert.equal(calls, 1);
});

test("same-watermark requests are single-flight while each merges its own current text", async () => {
  const pending = deferred<ReturnType<typeof page>>();
  let calls = 0;
  const collector = createNativeHistoryCollector({
    async conversationRowsRangeV4() {
      calls++;
      return pending.promise;
    },
  });
  const first = collector.collect(target, snapshot());
  const second = collector.collect(
    target,
    snapshot([row(5), row(6, "latest")]),
  );
  pending.resolve(page(range(1, 4)));
  assert.equal((await first).at(-1)?.text, "row-6");
  assert.equal((await second).at(-1)?.text, "latest");
  assert.equal(calls, 1);
});

test("late older-epoch reads and disposed reads cannot overwrite the new cache", async () => {
  const pending = deferred<ReturnType<typeof page>>();
  let calls = 0;
  const collector = createNativeHistoryCollector({
    async conversationRowsRangeV4() {
      return ++calls === 1
        ? pending.promise
        : page([row(1), row(4)], false, 4, "epoch-2");
    },
  });
  const old = collector.collect(target, snapshot());
  assert.deepEqual(
    ids(await collector.collect(target, snapshot(undefined, 4, "epoch-2"))),
    [1, 4, 5, 6],
  );
  pending.resolve(page(range(1, 4)));
  assert.deepEqual(ids(await old), [5, 6]);
  assert.equal(collector.status(target).loadedRows, 4);
  collector.dispose();
  assert.deepEqual(await collector.collect(target, snapshot()), []);
  assert.equal(calls, 2);
});

test("failed terminal refresh drops the previous revision and retries without silently calling it complete", async () => {
  let calls = 0;
  const collector = createNativeHistoryCollector({
    async conversationRowsRangeV4() {
      if (++calls === 2) throw new Error("read unavailable");
      return page(range(1, 4), false, calls === 1 ? 3 : 4);
    },
  });
  await collector.collect(target, snapshot());
  assert.deepEqual(
    ids(await collector.collect(target, snapshot(undefined, 4))),
    [5, 6],
  );
  assert.equal(collector.status(target).retryable, true);
  assert.equal(
    (await collector.collect(target, snapshot(undefined, 4))).length,
    6,
  );
  assert.equal(collector.status(target).incomplete, false);
});

test("a stalled native cursor fails once and target identity plus LRU isolate histories", async () => {
  let calls = 0;
  const collector = createNativeHistoryCollector(
    {
      async conversationRowsRangeV4() {
        calls++;
        return calls === 1 ? page([row(5)], true) : page(range(1, 4));
      },
    },
    { maxSessions: 1 },
  );
  assert.deepEqual(ids(await collector.collect(target, snapshot())), [5, 6]);
  assert.equal(calls, 1);
  assert.equal(collector.status(target).retryable, true);
  const remote = { ...target, workspaceIdentity: "remote:owned" };
  await collector.collect(remote, snapshot());
  assert.equal(collector.status(target).loadedRows, 0);
  await collector.collect(target, snapshot());
  assert.equal(calls, 3);
});

test("a complete live window needs no query and is still bounded by the configured limit", async () => {
  let calls = 0;
  const collector = createNativeHistoryCollector(
    {
      async conversationRowsRangeV4() {
        calls++;
        return page([]);
      },
    },
    { maxRows: 3 },
  );
  const rows = await collector.collect(target, snapshot(range(1, 6)));
  assert.deepEqual(ids(rows), [4, 5, 6]);
  assert.equal(calls, 0);
  assert.equal(collector.status(target).truncated, true);
});

test("an over-limit native response is rejected rather than exceeding the retained row bound", async () => {
  const collector = createNativeHistoryCollector(
    {
      async conversationRowsRangeV4() {
        return page(range(1, 8));
      },
    },
    { maxRows: 5 },
  );
  const state = snapshot([row(9), row(10)]);
  state.rows.totalCount = 10;
  assert.deepEqual(ids(await collector.collect(target, state)), [9, 10]);
  assert.equal(collector.status(target).retryable, true);
  assert.equal(collector.status(target).loadedRows, 2);
});
