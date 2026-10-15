import { invoke } from "@tauri-apps/api/core";
import type {
  AgentCatalog,
  AgentEngineStatus,
  AgentMode,
  AgentPermissionMode,
  AgentProject,
  AgentExtensions,
  AgentExtensionConfig,
  AgentPermissionDecision,
  AgentProjectResult,
  AgentQuestionAnswer,
  AgentSession,
  AgentSnapshot,
} from "@/types/agent";

/** Thin desktop transport. Engine state and credentials stay in the backend. */
export const agentApi = {
  native: <T = unknown>(
    service: string,
    method: string,
    args: unknown[] = [],
    scope?: { remoteId: string },
  ) =>
    invoke<T>("invoke_agent_native_service", { service, method, args, scope }),
  automation: <T = unknown>(method: string, args: unknown[] = []) =>
    invoke<T>("invoke_agent_automation", { method, args }),
  remote: <T = unknown>(method: string, args: unknown[] = []) =>
    invoke<T>("invoke_agent_remote", { method, args }),
  runSavedWorkflow: (
    sessionId: string,
    name: string,
    requestId: string,
    scope: "project" | "global",
    args: Record<string, unknown>,
  ) =>
    invoke<AgentSession>("run_agent_saved_workflow", {
      sessionId,
      name,
      requestId,
      scope,
      args,
    }),
  getCatalogRevision: () => invoke<number>("get_agent_catalog_revision"),
  getStatus: () => invoke<AgentEngineStatus>("get_agent_status"),
  getCatalog: () => invoke<AgentCatalog>("get_agent_catalog"),
  openProject: (path: string, refreshModels?: boolean) =>
    invoke<AgentProjectResult>("open_agent_project", { path, refreshModels }),
  listSessions: (projectPath?: string, includeArchived?: boolean) =>
    invoke<AgentSession[]>("list_agent_sessions", {
      projectPath,
      includeArchived,
    }),
  listProjects: () => invoke<AgentProject[]>("list_agent_projects"),
  setProjectMetadata: (path: string, pinned: boolean) =>
    invoke<AgentProject>("set_agent_project_metadata", { path, pinned }),
  removeProject: (path: string) =>
    invoke<void>("remove_agent_project", { path }),
  createSession: (
    modelId: string,
    mode: AgentMode,
    title?: string,
    permissionMode?: AgentPermissionMode,
  ) =>
    invoke<AgentSession>("create_agent_session", {
      modelId,
      mode,
      title,
      permissionMode,
    }),
  updateSession: (
    sessionId: string,
    patch: {
      modelId?: string;
      mode?: AgentMode;
      permissionMode?: AgentPermissionMode;
    },
  ) => invoke<AgentSession>("update_agent_session", { sessionId, ...patch }),
  renameSession: (sessionId: string, title: string) =>
    invoke<AgentSession>("rename_agent_session", { sessionId, title }),
  setSessionMetadata: (
    sessionId: string,
    patch: { pinned?: boolean; archived?: boolean },
  ) =>
    invoke<AgentSession>("set_agent_session_metadata", { sessionId, ...patch }),
  deleteSession: (sessionId: string) =>
    invoke<void>("delete_agent_session", { sessionId }),
  getSession: (sessionId: string) =>
    invoke<AgentSnapshot>("get_agent_session", { sessionId }),
  sendMessage: (sessionId: string, text: string, requestId: string) =>
    invoke<void>("send_agent_message", { sessionId, text, requestId }),
  queryCommand: (sessionId: string, requestId: string) =>
    invoke<{
      status: "unknown" | "accepted" | "rejected" | "failed";
      message?: string;
    }>("query_agent_command", { sessionId, requestId }),
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
  getExtensions: () => invoke<AgentExtensions>("get_agent_extensions"),
  setSkillEnabled: (id: string, enabled: boolean) =>
    invoke<AgentExtensions>("set_agent_skill_enabled", { id, enabled }),
  importSkill: (path: string) =>
    invoke<AgentExtensions>("import_agent_skill", { path }),
  removeSkill: (id: string) =>
    invoke<AgentExtensions>("remove_agent_skill", { id }),
  installPlugin: (path: string) =>
    invoke<AgentExtensions>("install_agent_plugin", { path }),
  setPluginEnabled: (id: string, enabled: boolean) =>
    invoke<AgentExtensions>("set_agent_plugin_enabled", { id, enabled }),
  uninstallPlugin: (id: string) =>
    invoke<AgentExtensions>("uninstall_agent_plugin", { id }),
  getExtensionConfig: () =>
    invoke<AgentExtensionConfig>("get_agent_extension_config"),
  saveExtensionConfig: (config: AgentExtensionConfig) =>
    invoke<AgentExtensions>("save_agent_extension_config", { config }),
};
