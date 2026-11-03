import type { AgentDraftToken } from "@/lib/agentInputLedger";

/** A pending withdrawal whose original editor must still be restored safely. */
export interface AgentQueueRecall {
  projectPath: string;
  sessionId: string;
  requestId: string;
  draft: AgentDraftToken;
  text: string;
}

const recallKey = (project: string, id: string) =>
  `lolicode.agent.queue-recall:${encodeURIComponent(project)}:${encodeURIComponent(id)}`;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function decode(
  value: unknown,
  project: string,
  id: string,
): AgentQueueRecall | null {
  if (
    !record(value) ||
    !identity(project) ||
    !identity(id) ||
    value.projectPath !== project ||
    value.sessionId !== id ||
    !identity(value.requestId) ||
    typeof value.text !== "string" ||
    !record(value.draft) ||
    !identity(value.draft.key) ||
    !identity(value.draft.revision) ||
    typeof value.draft.text !== "string"
  )
    return null;
  return {
    projectPath: project,
    sessionId: id,
    requestId: value.requestId,
    draft: {
      key: value.draft.key,
      revision: value.draft.revision,
      text: value.draft.text,
    },
    text: value.text,
  };
}

export function readAgentQueueRecall(
  project: string,
  id: string,
): AgentQueueRecall | null {
  try {
    return decode(
      JSON.parse(localStorage.getItem(recallKey(project, id)) || "null"),
      project,
      id,
    );
  } catch {
    return null;
  }
}

export function saveAgentQueueRecall(entry: AgentQueueRecall): void {
  let next = decode(entry, entry.projectPath, entry.sessionId);
  if (!next) throw new Error("待恢复的撤回记录无效，原消息尚未撤回。");
  const key = recallKey(next.projectPath, next.sessionId);
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    throw new Error("无法读取撤回恢复记录，请检查应用存储后重试。");
  }
  if (raw !== null) {
    let previous: AgentQueueRecall | null = null;
    try {
      previous = decode(JSON.parse(raw), next.projectPath, next.sessionId);
    } catch {
      /* Never replace malformed recovery evidence. */
    }
    if (!previous)
      throw new Error("已有撤回恢复记录无法读取，原始记录已保留。");
    if (previous.requestId !== next.requestId)
      throw new Error("上一条撤回消息尚未恢复，请先恢复编辑后再撤回其他消息。");
    // An explicit restore retry captures the currently empty editor. Refresh
    // only its CAS token in one atomic write; keep the original message text.
    if (JSON.stringify(previous.draft) === JSON.stringify(next.draft)) return;
    next = { ...previous, draft: next.draft };
  }
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    throw new Error("无法保存撤回恢复记录，请检查应用存储后重试。");
  }
}

export function clearAgentQueueRecall(
  project: string,
  id: string,
  requestId: string,
): void {
  const entry = readAgentQueueRecall(project, id);
  if (entry?.requestId !== requestId) return;
  try {
    localStorage.removeItem(recallKey(project, id));
  } catch {
    throw new Error("无法清除撤回恢复记录，请检查应用存储后重试。");
  }
}
