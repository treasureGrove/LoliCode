// Renderer recovery evidence, never a replacement for native session state.
// Keep one submission per session until receipt/settlement is observed. A lost
// response must not turn the same user submission into a new request ID.
export interface AgentDraftToken {
  key: string;
  revision: string;
  text: string;
}
export interface AgentSubmission {
  version: 1;
  projectPath: string;
  sessionId: string;
  requestId: string;
  text: string;
  draft: AgentDraftToken;
  assistantIds: string[];
  phase: "submitting" | "accepted" | "uncertain";
  observed: boolean;
  stopRequested: boolean;
  stopAcknowledged?: boolean;
}
const PREFIX = "lolicode.agent.input:";
const revisionKey = (key: string) => `${key}:revision`;
const submissionKey = (project: string, id: string) =>
  `${PREFIX}${encodeURIComponent(project)}:${encodeURIComponent(id)}`;
const submissionsInFlight = new Set<string>();
const stopsInFlight = new Map<string, Promise<void>>();

export function saveAgentDraft(key: string, text: string): AgentDraftToken {
  const token = { key, text, revision: crypto.randomUUID() };
  try {
    sessionStorage.setItem(revisionKey(key), JSON.stringify(token));
    if (text) sessionStorage.setItem(key, text);
    else sessionStorage.removeItem(key);
  } catch {
    /* Keep the editor's in-memory draft if browser storage is unavailable. */
  }
  return token;
}

export function captureAgentDraft(key: string, text: string): AgentDraftToken {
  try {
    const token = JSON.parse(
      sessionStorage.getItem(revisionKey(key)) || "null",
    ) as AgentDraftToken | null;
    if (
      token?.key === key &&
      token.text === text &&
      typeof token.revision === "string" &&
      sessionStorage.getItem(key) === text
    )
      return token;
  } catch {
    /* Upgrade an old plain-text draft below. */
  }
  return saveAgentDraft(key, text);
}

export function clearSubmittedAgentDraft(token: AgentDraftToken): boolean {
  try {
    const current = JSON.parse(
      sessionStorage.getItem(revisionKey(token.key)) || "null",
    ) as AgentDraftToken | null;
    if (
      current?.revision !== token.revision ||
      sessionStorage.getItem(token.key) !== token.text
    )
      return false;
    sessionStorage.removeItem(token.key);
    sessionStorage.removeItem(revisionKey(token.key));
    return true;
  } catch {
    return false;
  }
}

export function readAgentSubmission(
  project: string,
  id: string,
): AgentSubmission | null {
  try {
    const entry = JSON.parse(
      localStorage.getItem(submissionKey(project, id)) || "null",
    ) as Partial<AgentSubmission> | null;
    if (
      entry?.version !== 1 ||
      entry.sessionId !== id ||
      entry.projectPath !== project ||
      typeof entry.requestId !== "string" ||
      typeof entry.text !== "string" ||
      !entry.draft ||
      typeof entry.draft.key !== "string" ||
      typeof entry.draft.revision !== "string" ||
      typeof entry.draft.text !== "string" ||
      !Array.isArray(entry.assistantIds) ||
      !entry.assistantIds.every((value) => typeof value === "string") ||
      !["submitting", "accepted", "uncertain"].includes(String(entry.phase))
    )
      return null;
    return entry as AgentSubmission;
  } catch {
    return null;
  }
}

export function saveAgentSubmission(entry: AgentSubmission): void {
  try {
    localStorage.setItem(
      submissionKey(entry.projectPath, entry.sessionId),
      JSON.stringify(entry),
    );
  } catch {
    throw new Error("无法保存发送恢复记录，请检查应用存储后重试。");
  }
}

export function updateAgentSubmission(
  project: string,
  id: string,
  requestId: string,
  patch: Partial<
    Pick<
      AgentSubmission,
      "phase" | "observed" | "stopRequested" | "stopAcknowledged"
    >
  >,
): AgentSubmission | null {
  const entry = readAgentSubmission(project, id);
  if (!entry || entry.requestId !== requestId) return null;
  const next = { ...entry, ...patch };
  saveAgentSubmission(next);
  return next;
}

export function clearAgentSubmission(
  project: string,
  id: string,
  requestId: string,
): void {
  const entry = readAgentSubmission(project, id);
  if (entry?.requestId === requestId)
    localStorage.removeItem(submissionKey(project, id));
}

export function beginAgentSubmission(id: string): void {
  submissionsInFlight.add(id);
}
export function endAgentSubmission(id: string): void {
  submissionsInFlight.delete(id);
}
export function agentSubmissionInFlight(id: string): boolean {
  return submissionsInFlight.has(id);
}
export function agentStopInFlight(id: string): boolean {
  return stopsInFlight.has(id);
}

// Stop has a separate lane from send/configure. A stop issued before admission
// must be repeated after that admission; the first idle response is insufficient.
export function dispatchAgentStop(
  id: string,
  invoke: (id: string) => Promise<void>,
  afterAdmission = false,
): Promise<void> {
  const previous = stopsInFlight.get(id);
  if (previous && !afterAdmission) return previous;
  const task = (previous ? previous.catch(() => {}) : Promise.resolve()).then(
    () => invoke(id),
  );
  stopsInFlight.set(id, task);
  void task
    .finally(() => {
      if (stopsInFlight.get(id) === task) stopsInFlight.delete(id);
    })
    .catch(() => {});
  return task;
}
