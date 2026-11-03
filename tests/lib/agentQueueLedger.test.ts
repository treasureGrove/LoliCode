import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAgentQueueSubmission,
  readAgentQueueSubmission,
  saveAgentQueueSubmission,
  type AgentQueueSubmission,
} from "@/lib/agentQueueLedger";

const project = "D:/fixture/project:queue";
const id = "lc:queue-fixture";
const key = (path = project, session = id) =>
  `lolicode.agent.queue-input:${encodeURIComponent(path)}:${encodeURIComponent(session)}`;
const fixture = (): AgentQueueSubmission => ({
  version: 1,
  projectPath: project,
  sessionId: id,
  requestId: "queue-request-1",
  text: "Review this change",
  draft: {
    key: "queue-fixture-draft",
    revision: "draft-revision-1",
    text: "Review this change ",
  },
  imageIds: ["image-1"],
  documentIds: ["document-1"],
});

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("queue admission recovery ledger", () => {
  it("stores only metadata in a lane separate from active sends", () => {
    const inputKey = `lolicode.agent.input:${encodeURIComponent(project)}:${encodeURIComponent(id)}`;
    localStorage.setItem(inputKey, "existing active send evidence");
    const entry = fixture();
    entry.text = ""; // An attachment-only enqueue still needs recovery evidence.
    saveAgentQueueSubmission({
      ...entry,
      imageBody: "private-image-body",
    } as AgentQueueSubmission);
    expect(readAgentQueueSubmission(project, id)).toEqual(entry);
    expect(localStorage.getItem(key())).not.toContain("private-image-body");
    expect(localStorage.getItem(inputKey)).toBe(
      "existing active send evidence",
    );
  });

  it("keeps exact retries idempotent without rewriting existing evidence", () => {
    const entry = fixture();
    saveAgentQueueSubmission(entry);
    const write = vi.spyOn(Storage.prototype, "setItem");
    saveAgentQueueSubmission(structuredClone(entry));
    expect(write).not.toHaveBeenCalled();
    expect(readAgentQueueSubmission(project, id)).toEqual(entry);
  });

  it("rejects another unconfirmed request for the same conversation", () => {
    const entry = fixture();
    saveAgentQueueSubmission(entry);
    expect(() =>
      saveAgentQueueSubmission({ ...entry, requestId: "queue-request-2" }),
    ).toThrow("入队状态尚未确认");
    expect(readAgentQueueSubmission(project, id)).toEqual(entry);
  });

  it.each([
    { text: "Different input" },
    { imageIds: ["another-image"] },
    { documentIds: ["another-document"] },
    { draft: { key: "new-key", revision: "new-revision", text: "new draft" } },
  ])("does not repurpose an existing request identity (%j)", (patch) => {
    const entry = fixture();
    saveAgentQueueSubmission(entry);
    expect(() => saveAgentQueueSubmission({ ...entry, ...patch })).toThrow(
      "原始记录已保留",
    );
    expect(readAgentQueueSubmission(project, id)).toEqual(entry);
  });

  it("clears only the exact request within its original project and session", () => {
    const entry = fixture();
    saveAgentQueueSubmission(entry);
    const other = { ...entry, projectPath: "D:/another-project" };
    saveAgentQueueSubmission(other);
    clearAgentQueueSubmission(project, id, "older-request");
    clearAgentQueueSubmission(project, "lc:another-session", entry.requestId);
    expect(readAgentQueueSubmission(project, id)).toEqual(entry);
    clearAgentQueueSubmission(project, id, entry.requestId);
    expect(readAgentQueueSubmission(project, id)).toBeNull();
    expect(readAgentQueueSubmission(other.projectPath, id)).toEqual(other);
  });

  it.each([
    "not-json",
    "null",
    "[]",
    JSON.stringify({ ...fixture(), version: 2 }),
    JSON.stringify({ ...fixture(), projectPath: "D:/wrong-project" }),
    JSON.stringify({ ...fixture(), sessionId: "lc:wrong-session" }),
    JSON.stringify({ ...fixture(), requestId: " " }),
    JSON.stringify({ ...fixture(), text: null }),
    JSON.stringify({ ...fixture(), draft: null }),
    JSON.stringify({
      ...fixture(),
      draft: { key: "key", revision: 7, text: "text" },
    }),
    JSON.stringify({ ...fixture(), imageIds: [false] }),
    JSON.stringify({ ...fixture(), imageIds: [""] }),
    JSON.stringify({ ...fixture(), documentIds: "document-1" }),
  ])("preserves invalid evidence without authorizing recovery (%s)", (raw) => {
    localStorage.setItem(key(), raw);
    expect(readAgentQueueSubmission(project, id)).toBeNull();
    clearAgentQueueSubmission(project, id, fixture().requestId);
    expect(() => saveAgentQueueSubmission(fixture())).toThrow("原始记录已保留");
    expect(localStorage.getItem(key())).toBe(raw);
  });

  it("fails closed when browser storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(readAgentQueueSubmission(project, id)).toBeNull();
    expect(() => saveAgentQueueSubmission(fixture())).toThrow("检查应用存储");
    expect(write).not.toHaveBeenCalled();
  });

  it("reports storage exhaustion before claiming the enqueue was recorded", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    expect(() => saveAgentQueueSubmission(fixture())).toThrow(
      "无法保存待发送恢复记录",
    );
    expect(readAgentQueueSubmission(project, id)).toBeNull();
  });

  it("preserves evidence and reports a failed exact removal", () => {
    const entry = fixture();
    saveAgentQueueSubmission(entry);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    expect(() =>
      clearAgentQueueSubmission(project, id, entry.requestId),
    ).toThrow("无法清除待发送恢复记录");
    expect(readAgentQueueSubmission(project, id)).toEqual(entry);
  });
});
