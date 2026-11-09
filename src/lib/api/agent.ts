import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AgentDocumentAttachment,
  AgentImageAttachment,
} from "@/types/agent";
import i18n from "@/i18n";
import type {
  AgentNativeSessionPageOptions,
  AgentNativeSessionRead,
  AgentNativeSessionWatchMessage,
} from "@/types/harness-session";
import type {
  AgentCatalog,
  AgentEngineStatus,
  AgentNativeActivity,
  AgentMode,
  AgentPermissionMode,
  AgentProject,
  AgentExtensions,
  AgentExtensionConfig,
  AgentHarnessPluginCatalog,
  AgentPluginStore,
  AgentPermissionDecision,
  AgentProjectResult,
  AgentQuestionAnswer,
  AgentQueuedInput,
  AgentSecretaryActivity,
  AgentSecretaryDraftPr,
  AgentSecretaryDraftPrReceipt,
  AgentSecretaryExecutionMode,
  AgentSecretaryGithubRule,
  AgentSecretaryGithubReplyReceipt,
  AgentSecretaryGithubState,
  AgentSecretaryState,
  AgentSecretaryTask,
  AgentSession,
  AgentSnapshot,
} from "@/types/agent";

const messageLocale = () => {
  const locale = i18n.resolvedLanguage || i18n.language;
  return ["zh", "zh-TW", "en", "ja"].includes(locale) ? locale : undefined;
};

const messagePayload = (
  sessionId: string,
  text: string,
  requestId: string,
  images: AgentImageAttachment[] = [],
  documents: AgentDocumentAttachment[] = [],
) => ({
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
  locale: messageLocale(),
});

/** Thin desktop transport. Engine state and credentials stay in the backend. */
export type AgentSessionSyncDirection = "both" | "import" | "export";

export interface AgentSessionSyncResult {
  imported: number;
  exported: number;
  duplicates: number;
  conflicts: number;
  skippedBusy: number;
  skippedUnsupported: number;
  peerName: string;
  warnings: string[];
}

const ackSessionNative = (subscriptionId: string, deliveryId: number) =>
  invoke<void>("ack_agent_session_native", { subscriptionId, deliveryId });

export const agentApi = {
  ackSessionNative,
  watchSessionNative: (
    sessionId: string,
    subscriptionId: string,
    onMessage: (message: AgentNativeSessionWatchMessage) => void,
    options: { maxMessages?: number } = {},
  ) => {
    const onFrame = new Channel<AgentNativeSessionWatchMessage>();
    onFrame.onmessage = (message) => {
      try {
        onMessage(message);
      } finally {
        if (message.deliveryId !== undefined) {
          void ackSessionNative(subscriptionId, message.deliveryId).catch(
            () => {
              // The hook ignores this after cancellation or a generation change.
              onMessage({
                subscriptionId,
                error: "实时记录确认失败，请重新连接。",
              });
            },
          );
        }
      }
    };
    return invoke<boolean>("watch_agent_session_native", {
      sessionId,
      subscriptionId,
      onFrame,
      ...options,
    });
  },
  stopSessionNative: (subscriptionId: string) =>
    invoke<void>("stop_agent_session_native", { subscriptionId }),
  readSessionNative: (
    sessionId: string,
    options: AgentNativeSessionPageOptions = {},
  ) =>
    invoke<AgentNativeSessionRead>("read_agent_session_native", {
      sessionId,
      ...options,
    }),
  readNativeMessageAliases: (sessionId: string) =>
    invoke<Record<string, string>>("read_agent_native_message_aliases", {
      sessionId,
    }),
  readSessionMarkdown: (sessionId: string) =>
    invoke<string>("read_agent_session_markdown", { sessionId }),
  syncSessions: (direction: AgentSessionSyncDirection = "both") =>
    invoke<AgentSessionSyncResult>("sync_agent_sessions", { direction }),
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
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      reasoningEffort,
      ...(contextLimit !== undefined ? { contextLimit } : {}),
      ...(projectPath ? { projectPath } : {}),
    }),
  openSecretary: (
    modelId: string,
    permissionMode?: AgentPermissionMode,
    reasoningEffort?: string,
    projectPath?: string,
    contextLimit?: number,
  ) =>
    invoke<AgentSession>("open_agent_secretary", {
      modelId,
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      reasoningEffort,
      ...(projectPath ? { projectPath } : {}),
      ...(contextLimit !== undefined ? { contextLimit } : {}),
      locale: messageLocale(),
    }),
  getSecretary: (sessionId: string) =>
    invoke<AgentSecretaryState>("get_agent_secretary", { sessionId }),
  getSecretaryActivity: () =>
    invoke<AgentSecretaryActivity[]>("get_agent_secretary_activity"),
  delegateSecretaryTask: (
    sessionId: string,
    title: string,
    instructions: string,
    requestId: string,
    executionMode?: AgentSecretaryExecutionMode,
    projectPath?: string,
  ) =>
    invoke<AgentSecretaryTask>("delegate_agent_secretary_task", {
      sessionId,
      title,
      instructions,
      requestId,
      ...(executionMode ? { executionMode } : {}),
      ...(projectPath ? { projectPath } : {}),
      locale: messageLocale(),
    }),
  getSecretaryGithub: (sessionId: string) =>
    invoke<AgentSecretaryGithubState>("get_agent_secretary_github", {
      sessionId,
    }),
  bindSecretaryGithub: (sessionId: string, repository: string) =>
    invoke<AgentSecretaryGithubState>("bind_agent_secretary_github", {
      sessionId,
      repository,
    }),
  refreshSecretaryGithub: (sessionId: string) =>
    invoke<AgentSecretaryGithubState>("refresh_agent_secretary_github", {
      sessionId,
    }),
  setSecretaryGithubMonitoring: (sessionId: string, enabled: boolean) =>
    invoke<AgentSecretaryGithubState>("set_agent_secretary_github_monitoring", {
      sessionId,
      enabled,
    }),
  setSecretaryGithubPolicy: (
    sessionId: string,
    enabled: boolean,
    rules: AgentSecretaryGithubRule[],
    expectedRevision?: number,
  ) =>
    invoke<AgentSecretaryGithubState>("set_agent_secretary_github_policy", {
      sessionId,
      enabled,
      rules,
      expectedRevision,
    }),
  getSecretaryDraftPr: (sessionId: string, taskId: string) =>
    invoke<AgentSecretaryDraftPr>("get_agent_secretary_draft_pr", {
      sessionId,
      taskId,
    }),
  publishSecretaryDraftPr: (
    sessionId: string,
    taskId: string,
    preview: Pick<
      AgentSecretaryDraftPr,
      "headRevision" | "baseRevision" | "treeRevision" | "title" | "body"
    >,
  ) =>
    invoke<AgentSecretaryDraftPrReceipt>("publish_agent_secretary_draft_pr", {
      sessionId,
      taskId,
      ...preview,
    }),
  disconnectSecretaryGithub: (sessionId: string) =>
    invoke<AgentSecretaryGithubState>("disconnect_agent_secretary_github", {
      sessionId,
    }),
  delegateSecretaryGithubItem: (
    sessionId: string,
    itemId: string,
    instructions: string,
    requestId: string,
  ) =>
    invoke<AgentSecretaryTask>("delegate_agent_secretary_github_item", {
      sessionId,
      itemId,
      instructions,
      requestId,
      locale: messageLocale(),
    }),
  getSecretaryGithubReply: (sessionId: string, itemId: string) =>
    invoke<AgentSecretaryGithubReplyReceipt | null>(
      "get_agent_secretary_github_reply",
      { sessionId, itemId },
    ),
  sendSecretaryGithubReply: (sessionId: string, itemId: string, body: string) =>
    invoke<AgentSecretaryGithubReplyReceipt>(
      "send_agent_secretary_github_reply",
      { sessionId, itemId, body },
    ),
  sendSecretaryTaskMessage: (
    sessionId: string,
    taskId: string,
    text: string,
    requestId: string,
    images: AgentImageAttachment[] = [],
    documents: AgentDocumentAttachment[] = [],
  ) =>
    invoke<AgentSecretaryTask>("send_agent_secretary_task_message", {
      ...messagePayload(sessionId, text, requestId, images, documents),
      taskId,
    }),
  cancelSecretaryTask: (sessionId: string, taskId: string) =>
    invoke<AgentSecretaryTask>("cancel_agent_secretary_task", {
      sessionId,
      taskId,
    }),
  deleteSecretaryTask: (sessionId: string, taskId: string) =>
    invoke<void>("delete_agent_secretary_task", { sessionId, taskId }),
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
    invoke<void>(
      "send_agent_message",
      messagePayload(sessionId, text, requestId, images, documents),
    ),
  enqueueMessage: (
    sessionId: string,
    text: string,
    requestId: string,
    images: AgentImageAttachment[] = [],
    documents: AgentDocumentAttachment[] = [],
    delivery?: "steer",
  ) =>
    invoke<{ status: "accepted" | "rejected"; message?: string }>(
      "enqueue_agent_message",
      {
        ...messagePayload(sessionId, text, requestId, images, documents),
        ...(delivery && { delivery }),
      },
    ),
  removeQueuedMessage: (sessionId: string, requestId: string) =>
    invoke<AgentQueuedInput>("remove_queued_agent_message", {
      sessionId,
      requestId,
    }),
  sendQueuedMessageNow: (
    sessionId: string,
    requestId: string,
    steerOnly?: true,
  ) =>
    invoke<void>("send_queued_agent_message_now", {
      sessionId,
      requestId,
      ...(steerOnly && { steerOnly }),
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
  getHarnessPlugins: () =>
    invoke<AgentHarnessPluginCatalog>("get_agent_harness_plugins"),
  setHarnessPluginEnabled: (id: string, enabled: boolean) =>
    invoke<AgentHarnessPluginCatalog>("set_agent_harness_plugin_enabled", {
      id,
      enabled,
    }),
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
