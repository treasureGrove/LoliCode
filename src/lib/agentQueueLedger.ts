import type { AgentDraftToken } from "@/lib/agentInputLedger";

/** Recovery evidence for an enqueue ACK, separate from the active send lane. */
export interface AgentQueueSubmission {
  version: 1;
  projectPath: string;
  sessionId: string;
  requestId: string;
  text: string;
  draft: AgentDraftToken;
  imageIds: string[];
  documentIds: string[];
  delivery?: "steer";
}

const submissionKey = (project: string, id: string) =>
  `lolicode.agent.queue-input:${encodeURIComponent(project)}:${encodeURIComponent(id)}`;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(identity);

function decode(
  value: unknown,
  project: string,
  id: string,
): AgentQueueSubmission | null {
  if (
    !record(value) ||
    value.version !== 1 ||
    !identity(project) ||
    !identity(id) ||
    value.projectPath !== project ||
    value.sessionId !== id ||
    !identity(value.requestId) ||
    typeof value.text !== "string" ||
    !record(value.draft) ||
    !identity(value.draft.key) ||
    !identity(value.draft.revision) ||
    typeof value.draft.text !== "string" ||
    !ids(value.imageIds) ||
    !ids(value.documentIds) ||
    (value.delivery !== undefined && value.delivery !== "steer")
  )
    return null;
  // Project only metadata so an accidentally attached image/document body is
  // never copied into this small recovery record.
  return {
    version: 1,
    projectPath: project,
    sessionId: id,
    requestId: value.requestId,
    text: value.text,
    draft: {
      key: value.draft.key,
      revision: value.draft.revision,
      text: value.draft.text,
    },
    imageIds: [...value.imageIds],
    documentIds: [...value.documentIds],
    ...(value.delivery === "steer" && { delivery: value.delivery }),
  };
}

export function readAgentQueueSubmission(
  project: string,
  id: string,
): AgentQueueSubmission | null {
  try {
    return decode(
      JSON.parse(localStorage.getItem(submissionKey(project, id)) || "null"),
      project,
      id,
    );
  } catch {
    // Corrupt or inaccessible evidence must never authorize a resend/deletion.
    return null;
  }
}

export function saveAgentQueueSubmission(entry: AgentQueueSubmission): void {
  const next = decode(entry, entry.projectPath, entry.sessionId);
  if (!next) throw new Error("待发送消息的恢复记录无效，尚未加入队列。");
  const key = submissionKey(next.projectPath, next.sessionId);
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    throw new Error("无法读取待发送恢复记录，请检查应用存储后重试。");
  }
  if (raw !== null) {
    let previous: AgentQueueSubmission | null = null;
    try {
      previous = decode(JSON.parse(raw), next.projectPath, next.sessionId);
    } catch {
      /* Preserve malformed evidence instead of overwriting it below. */
    }
    if (!previous)
      throw new Error("已有待发送恢复记录无法读取，原始记录已保留。");
    if (previous.requestId !== next.requestId)
      throw new Error("上一条消息的入队状态尚未确认，请先等待确认后再发送。");
    if (JSON.stringify(previous) !== JSON.stringify(next))
      throw new Error("此请求标识已用于另一条待发送消息，原始记录已保留。");
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    throw new Error("无法保存待发送恢复记录，请检查应用存储后重试。");
  }
}

export function clearAgentQueueSubmission(
  project: string,
  id: string,
  requestId: string,
): void {
  const entry = readAgentQueueSubmission(project, id);
  if (entry?.requestId !== requestId) return;
  try {
    localStorage.removeItem(submissionKey(project, id));
  } catch {
    throw new Error("无法清除待发送恢复记录，请检查应用存储后重试。");
  }
}
