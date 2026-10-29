import { invoke } from "@tauri-apps/api/core";
import type {
  AgentDocumentAttachment,
  AgentImageAttachment,
} from "@/types/agent";
import i18n from "@/i18n";
import type {
  AgentCatalog,
  AgentEngineStatus,
  AgentNativeActivity,
  AgentMode,
  AgentPermissionMode,
  AgentProject,
  AgentExtensions,
  AgentExtensionConfig,
  AgentPluginStore,
  AgentPermissionDecision,
  AgentProjectResult,
  AgentQuestionAnswer,
  AgentSession,
  AgentSnapshot,
} from "@/types/agent";

/** Thin desktop transport. Engine state and credentials stay in the backend. */
export const agentApi = {
  getNativeActivity: () =>
    invoke<AgentNativeActivity>("get_agent_native_activity"),
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
  openStandalone: () => invoke<AgentProjectResult>("open_agent_standalone"),
  openProjectDirectory: (path: string) =>
    invoke<void>("open_agent_project_directory", { path }),
  listSessions: (projectPath?: string, includeArchived?: boolean) =>
    invoke<AgentSession[]>("list_agent_sessions", {
      projectPath,
      includeArchived,
    }),
  listProjects: () => invoke<AgentProject[]>("list_agent_projects"),
  setProjectMetadata: (path: string, pinned: boolean) =>
    invoke<AgentProject>("set_agent_project_metadata", { path, pinned }),
  renameProject: (path: string, name: string) =>
    invoke<AgentProject>("set_agent_project_metadata", { path, name }),
  removeProject: (path: string) =>
    invoke<void>("remove_agent_project", { path }),
  createSession: (
    modelId: string,
    mode: AgentMode,
    title?: string,
    permissionMode?: AgentPermissionMode,
    reasoningEffort?: string,
    projectPath?: string,
    contextLimit?: number,
  ) =>
    invoke<AgentSession>("create_agent_session", {
      modelId,
      mode,
      title,
      permissionMode,
      reasoningEffort,
      ...(contextLimit !== undefined ? { contextLimit } : {}),
      ...(projectPath ? { projectPath } : {}),
    }),
  updateSession: (
    sessionId: string,
    patch: {
      modelId?: string;
      mode?: AgentMode;
      permissionMode?: AgentPermissionMode;
      reasoningEffort?: string;
      contextLimit?: number | null;
    },
  ) =>
    invoke<AgentSession>("update_agent_session", {
      sessionId,
      ...patch,
      ...(patch.contextLimit === null
        ? { contextLimit: undefined, resetContextLimit: true }
        : {}),
    }),
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
  inspectDocument: (path: string) =>
    invoke<{ fileName: string; mime: string; bytes: number }>(
      "inspect_agent_document",
      { path },
    ),
  sendMessage: (
    sessionId: string,
    text: string,
    requestId: string,
    images: AgentImageAttachment[] = [],
    documents: AgentDocumentAttachment[] = [],
  ) =>
    invoke<void>("send_agent_message", {
      sessionId,
      text,
      requestId,
      ...(images.length || documents.length
        ? {
            attachments: [
              ...images.map(({ dataUrl, fileName, mime, bytes }) => ({
                ref: dataUrl,
                fileName,
                mime,
                bytes,
              })),
              ...documents.map(
                ({ dataBase64, localPath, fileName, mime, bytes }) => ({
                  ...(dataBase64 ? { dataBase64 } : {}),
                  ...(localPath ? { localPath } : {}),
                  fileName,
                  mime,
                  bytes,
                }),
              ),
            ],
          }
        : {}),
      locale: ["zh", "zh-TW", "en", "ja"].includes(
        i18n.resolvedLanguage || i18n.language,
      )
        ? i18n.resolvedLanguage || i18n.language
        : undefined,
    }),
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
  connectMcp: () => invoke<AgentExtensions>("connect_agent_mcp"),
  getPluginStore: () => invoke<AgentPluginStore>("get_agent_plugin_store"),
  addPluginMarketplace: (source: string) =>
    invoke<AgentPluginStore>("add_agent_plugin_marketplace", { source }),
  updatePluginMarketplace: (marketplace?: string) =>
    invoke<AgentPluginStore>("update_agent_plugin_marketplace", {
      ...(marketplace ? { marketplace } : {}),
    }),
  removePluginMarketplace: (marketplace: string) =>
    invoke<AgentPluginStore>("remove_agent_plugin_marketplace", {
      marketplace,
    }),
  installMarketplacePlugin: (marketplace: string, pluginName: string) =>
    invoke<AgentPluginStore>("install_agent_marketplace_plugin", {
      marketplace,
      pluginName,
    }),
  restoreBuiltinPlugin: (pluginId: string) =>
    invoke<AgentPluginStore>("restore_agent_builtin_plugin", { pluginId }),
  updateMarketplacePlugin: (pluginId: string) =>
    invoke<AgentPluginStore>("update_agent_marketplace_plugin", { pluginId }),
  uninstallMarketplacePlugin: (pluginId: string) =>
    invoke<AgentPluginStore>("uninstall_agent_marketplace_plugin", {
      pluginId,
    }),
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
