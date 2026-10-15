import assert from "node:assert/strict";
import { test } from "node:test";
import { CompatibilityAgent } from "./compat.js";
import { createNativeHistoryCollector } from "./native-history.js";

const id = "zc:history-owned";
const row = (rowId: number, text = `message-${rowId}`) => ({
  rowId,
  kind: "assistantText",
  entityId: `entity-${rowId}`,
  text,
  createdAt: rowId,
  state: "complete",
});
const messageText = (message: { parts: { type: string }[] }) => {
  const part = message.parts[0];
  assert.ok(
    part.type === "text" && "text" in part && typeof part.text === "string",
  );
  return part.text;
};
function fixture() {
  let state = {
    revision: 3,
    logEpoch: "epoch-owned",
    meta: { title: "Owned history" },
    config: { mode: "guarded", planEnabled: false },
    control: { phase: "idle", canStop: false },
    pendingInteractions: [],
    rows: { window: [row(5), row(6)], firstRowId: 1, totalCount: 6 },
  };
  let fail = false;
  const agent = {
    async readSession() {
      return {
        session: { sessionId: "history-owned", createdAt: 1, updatedAt: 6 },
      };
    },
    async conversationRowsRangeV4() {
      if (fail) throw new Error("temporary query failure");
      return {
        rows: [row(1), row(2), row(3), row(4)],
        atRevision: state.revision,
        atLogEpoch: state.logEpoch,
        atSeq: 10,
        hasMore: false,
      };
    },
  };
  const compat = new CompatibilityAgent({
    privateRoot: "D:/owned/private-unused",
    clientId: "history-fixture",
    agent,
    v4: {},
    configureCatalog: async () => {},
    extraBusy: () => false,
  });
  // Test only the real getSession boundary without starting any runtime,
  // subscription, file write, model request or project initialization.
  const internal = compat as any;
  internal.entries[id] = {
    workspacePath: "D:/owned/project",
    mode: "build",
    permissionMode: "auto",
  };
  internal.state = async () => state;
  return {
    compat,
    agent,
    internal,
    setRevision: (revision: number) => {
      state = { ...state, revision };
    },
    setFailure: (value: boolean) => {
      fail = value;
    },
  };
}

test("compat getSession renders authoritative older messages alongside the live native window", async () => {
  const { compat } = fixture();
  try {
    const snapshot = await compat.getSession({ sessionId: id });
    assert.deepEqual(snapshot.messages.map(messageText), [
      "message-1",
      "message-2",
      "message-3",
      "message-4",
      "message-5",
      "message-6",
    ]);
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.session.mode, "build");
    assert.equal(snapshot.streamGap, false);
  } finally {
    await compat.dispose();
  }
});

test("compat exposes a recoverable system notice and gap while a new revision cannot load history", async () => {
  const fixtureValue = fixture();
  const { compat } = fixtureValue;
  try {
    await compat.getSession({ sessionId: id });
    fixtureValue.setRevision(4);
    fixtureValue.setFailure(true);
    const failed = await compat.getSession({ sessionId: id });
    assert.equal(failed.messages[0].id, "lolicode-history-notice");
    assert.equal(failed.messages[0].role, "system");
    assert.match(messageText(failed.messages[0]), /历史暂未加载/);
    assert.deepEqual(failed.messages.slice(1).map(messageText), [
      "message-5",
      "message-6",
    ]);
    assert.equal(failed.streamGap, true);
    assert.equal(failed.status, "idle");
    fixtureValue.setFailure(false);
    const recovered = await compat.getSession({ sessionId: id });
    assert.equal(recovered.messages.length, 6);
    assert.equal(recovered.streamGap, false);
    assert.ok(!recovered.messages.some((message) => message.role === "system"));
  } finally {
    await compat.dispose();
  }
});

test("compat makes the explicit history limit visible without pretending a reconnect is needed", async () => {
  const { compat, internal } = fixture();
  internal.history.dispose();
  internal.history = createNativeHistoryCollector(
    {
      async conversationRowsRangeV4() {
        return {
          rows: [row(4)],
          atRevision: 3,
          atLogEpoch: "epoch-owned",
          atSeq: 10,
          hasMore: true,
        };
      },
    },
    { maxRows: 3 },
  );
  try {
    const snapshot = await compat.getSession({ sessionId: id });
    assert.equal(snapshot.messages[0].role, "system");
    assert.match(messageText(snapshot.messages[0]), /最近 3 行/);
    assert.equal(snapshot.messages.length, 4);
    assert.equal(snapshot.streamGap, false);
  } finally {
    await compat.dispose();
  }
});
