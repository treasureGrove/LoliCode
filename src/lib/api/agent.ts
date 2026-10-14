import { invoke } from "@tauri-apps/api/core";
import type {
  AgentCatalog,
  AgentEngineStatus,
  AgentMode,
  AgentPermissionDecision,
  AgentProjectResult,
  AgentQuestionAnswer,
  AgentSession,
  AgentSnapshot,
} from "@/types/agent";

/** Thin desktop transport. Engine state and credentials stay in the backend. */
export const agentApi = {
  getStatus: () => invoke<AgentEngineStatus>("get_agent_status"),
  getCatalog: () => invoke<AgentCatalog>("get_agent_catalog"),
  openProject: (path: string) =>
    invoke<AgentProjectResult>("open_agent_project", { path }),
  listSessions: () => invoke<AgentSession[]>("list_agent_sessions"),
  createSession: (modelId: string, mode: AgentMode, title?: string) =>
    invoke<AgentSession>("create_agent_session", { modelId, mode, title }),
  getSession: (sessionId: string) =>
    invoke<AgentSnapshot>("get_agent_session", { sessionId }),
  sendMessage: (sessionId: string, text: string, requestId: string) =>
    invoke<void>("send_agent_message", { sessionId, text, requestId }),
  interruptSession: (sessionId: string) =>
    invoke<void>("interrupt_agent_session", { sessionId }),
  replyPermission: (
    sessionId: string,
    requestId: string,
    decision: AgentPermissionDecision,
  ) =>
    invoke<void>("reply_agent_permission", { sessionId, requestId, decision }),
  replyQuestion: (
    sessionId: string,
    requestId: string,
    answer: AgentQuestionAnswer,
  ) => invoke<void>("reply_agent_question", { sessionId, requestId, answer }),
  rejectQuestion: (sessionId: string, requestId: string) =>
    invoke<void>("reject_agent_question", { sessionId, requestId }),
  closeProject: () => invoke<void>("close_agent_project"),
};
