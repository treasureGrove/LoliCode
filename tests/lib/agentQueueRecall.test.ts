import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentQueueRecall,
  readAgentQueueRecall,
  saveAgentQueueRecall,
  type AgentQueueRecall,
} from "@/lib/agentQueueRecall";

const project = "D:/fixture/queue:recall";
const id = "lc:recall-fixture";
const key = (path = project, session = id) =>
  `lolicode.agent.queue-recall:${encodeURIComponent(path)}:${encodeURIComponent(session)}`;
const fixture = (): AgentQueueRecall => ({
  projectPath: project,
  sessionId: id,
  requestId: "recall-request-1",
  draft: {
    key: "recall-fixture-draft",
    revision: "original-revision",
    text: "",
  },
  text: "Review this change",
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("queued message withdrawal recovery", () => {
  it("stores metadata separately and supports attachment-only withdrawals", () => {
    const entry = { ...fixture(), text: "" };
    localStorage.setItem("lolicode.agent.input:existing", "active evidence");
    localStorage.setItem(
      "lolicode.agent.queue-input:existing",
      "enqueue evidence",
    );
    saveAgentQueueRecall({
      ...entry,
      attachments: "private-body",
    } as AgentQueueRecall);
    expect(readAgentQueueRecall(project, id)).toEqual(entry);
    expect(localStorage.getItem(key())).not.toContain("private-body");
    expect(localStorage.getItem("lolicode.agent.input:existing")).toBe(
      "active evidence",
    );
    expect(localStorage.getItem("lolicode.agent.queue-input:existing")).toBe(
      "enqueue evidence",
    );
  });

  it("refreshes the same withdrawal's CAS token atomically for an explicit restore retry", () => {
    const entry = fixture();
    saveAgentQueueRecall(entry);
    const write = vi.spyOn(Storage.prototype, "setItem");
    const draft = {
      key: entry.draft.key,
      revision: "new-revision",
      text: "",
    };
    saveAgentQueueRecall({
      ...entry,
      draft,
    });
    expect(write).toHaveBeenCalledOnce();
    expect(readAgentQueueRecall(project, id)).toEqual({ ...entry, draft });
    saveAgentQueueRecall({ ...entry, draft });
    expect(write).toHaveBeenCalledOnce();
  });

  it("rejects a second withdrawal before its predecessor has been restored", () => {
    const entry = fixture();
    saveAgentQueueRecall(entry);
    expect(() =>
      saveAgentQueueRecall({ ...entry, requestId: "recall-request-2" }),
    ).toThrow("尚未恢复");
    expect(readAgentQueueRecall(project, id)).toEqual(entry);
  });

  it("keeps the original withdrawn text when refreshing the recovery token", () => {
    const entry = fixture();
    saveAgentQueueRecall(entry);
    const draft = { ...entry.draft, revision: "new-empty-editor-revision" };
    saveAgentQueueRecall({
      ...entry,
      text: "Stale text from another snapshot",
      draft,
    });
    expect(readAgentQueueRecall(project, id)).toEqual({ ...entry, draft });
  });

  it("clears only the matching withdrawal in its original project and session", () => {
    const entry = fixture();
    saveAgentQueueRecall(entry);
    saveAgentQueueRecall({ ...entry, sessionId: "lc:another-session" });
    clearAgentQueueRecall(project, id, "older-request");
    clearAgentQueueRecall("D:/another-project", id, entry.requestId);
    expect(readAgentQueueRecall(project, id)).toEqual(entry);
    clearAgentQueueRecall(project, id, entry.requestId);
    expect(readAgentQueueRecall(project, id)).toBeNull();
    expect(readAgentQueueRecall(project, "lc:another-session")?.requestId).toBe(
      entry.requestId,
    );
  });

  it.each([
    "not-json",
    "null",
    "[]",
    JSON.stringify({ ...fixture(), projectPath: "D:/wrong-project" }),
    JSON.stringify({ ...fixture(), sessionId: "lc:wrong-session" }),
    JSON.stringify({ ...fixture(), requestId: " " }),
    JSON.stringify({ ...fixture(), text: null }),
    JSON.stringify({ ...fixture(), draft: null }),
    JSON.stringify({
      ...fixture(),
      draft: { key: "key", revision: 7, text: "" },
    }),
    JSON.stringify({
      ...fixture(),
      draft: { key: "", revision: "revision", text: "" },
    }),
  ])("preserves malformed or mismatched evidence (%s)", (raw) => {
    localStorage.setItem(key(), raw);
    expect(readAgentQueueRecall(project, id)).toBeNull();
    clearAgentQueueRecall(project, id, fixture().requestId);
    expect(() => saveAgentQueueRecall(fixture())).toThrow("原始记录已保留");
    expect(localStorage.getItem(key())).toBe(raw);
  });

  it("fails closed if recovery storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(readAgentQueueRecall(project, id)).toBeNull();
    expect(() => saveAgentQueueRecall(fixture())).toThrow(
      "无法读取撤回恢复记录",
    );
    expect(write).not.toHaveBeenCalled();
  });

  it("reports failed persistence before issuing the withdrawal", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    expect(() => saveAgentQueueRecall(fixture())).toThrow(
      "无法保存撤回恢复记录",
    );
    expect(readAgentQueueRecall(project, id)).toBeNull();
  });

  it("preserves the previous recovery token when its atomic refresh fails", () => {
    const entry = fixture();
    saveAgentQueueRecall(entry);
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    expect(() =>
      saveAgentQueueRecall({
        ...entry,
        draft: { ...entry.draft, revision: "restore-retry-revision" },
      }),
    ).toThrow("无法保存撤回恢复记录");
    expect(remove).not.toHaveBeenCalled();
    expect(readAgentQueueRecall(project, id)).toEqual(entry);
  });

  it("retains the recovery token if clearing it fails", () => {
    const entry = fixture();
    saveAgentQueueRecall(entry);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    expect(() => clearAgentQueueRecall(project, id, entry.requestId)).toThrow(
      "无法清除撤回恢复记录",
    );
    expect(readAgentQueueRecall(project, id)).toEqual(entry);
  });
});
