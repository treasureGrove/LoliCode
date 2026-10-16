export type AgentMode = "build" | "plan";
export type AgentPermissionMode = "ask" | "auto" | "full_access";
export type AgentStatus =
  | "idle"
  | "running"
  | "waiting_permission"
  | "waiting_question"
  | "error";

export interface AgentEngineStatus {
  available: boolean;
  version?: string | null;
  running: boolean;
  projectPath?: string | null;
}
export interface AgentNativeActivity {
  engine?: string;
  inProcess?: boolean;
  features?: { workflows?: boolean; automation?: boolean; remote?: boolean };
}

export interface AgentModel {
  /** Opaque engine model identity. Do not split it into route segments. */
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  channelName: string;
  contextLimit?: number | null;
  outputLimit?: number | null;
  reasoningEfforts?: string[] | null;
  defaultReasoningEffort?: string | null;
  reasoningEffortSource?: string | null;
  reasoningEffortTransport?: "declared" | "unconfirmed" | "mixed" | null;
}

export interface AgentCatalog {
  revision: number;
  models: AgentModel[];
  defaultModel?: string | null;
  excludedSources: string[];
}

export interface AgentWorkspace {
  path: string;
  name: string;
}

export interface AgentProject extends AgentWorkspace {
  pinned: boolean;
  lastOpenedAt: number;
}

export interface AgentSession {
  id: string;
  title: string;
  projectPath: string;
  model?: { providerId: string; modelId: string } | null;
  mode?: AgentMode | string;
  permissionMode?: AgentPermissionMode | "custom" | string;
  reasoningEffort?: string | null;
  pinned?: boolean;
  archived?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Lightweight list metadata; subsequent snapshots remain authoritative. */
  activity?: { status: AgentStatus; titlePending: boolean };
}

export type AgentPart =
  | { type: "text" | "reasoning"; id?: string; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      state: "pending" | "running" | "completed" | "error";
      input: unknown;
      output?: string | null;
      error?: string | null;
    };

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: number;
  completedAt?: number | null;
  parts: AgentPart[];
}

export interface AgentImageAttachment {
  id: string;
  fileName: string;
  mime: string;
  bytes: number;
  dataUrl: string;
}

export interface AgentDocumentAttachment {
  id: string;
  fileName: string;
  mime: string;
  bytes: number;
  dataBase64?: string;
  localPath?: string;
}

export interface AgentPermission {
  id: string;
  sessionId: string;
  action: string;
  resources: string[];
  description?: string | null;
  toolName?: string | null;
  toolInput?: unknown | null;
  approvalMode?: "user-once";
}

export type AgentAnswerValue = string | number | boolean | string[];
export type AgentQuestionAnswer = Record<string, AgentAnswerValue>;
export interface AgentQuestionField {
  key: string;
  type:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "multiselect"
    | "external";
  title?: string | null;
  description?: string | null;
  required?: boolean;
  options?: { value: string; label: string; description?: string | null }[];
  custom?: boolean;
  default?: unknown;
  hidden?: boolean;
  when?: unknown[];
  format?: string | null;
  placeholder?: string | null;
  minLength?: number | null;
  maxLength?: number | null;
  pattern?: string | null;
  minItems?: number | null;
  maxItems?: number | null;
  minimum?: number | null;
  maximum?: number | null;
  url?: string | null;
}

export interface AgentQuestion {
  id: string;
  sessionId: string;
  title: string;
  fields: AgentQuestionField[];
}

export interface AgentDiff {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

export interface AgentTokenUsage {
  totalTokens?: number;
  tokenReportedRequests?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheHitRate?: number;
  modelRequests: number;
  reportedRequests: number;
}

export interface AgentUsage {
  task?: AgentTokenUsage & {
    startedAt: number;
    completedAt?: number;
    elapsedMs: number;
    generationMs?: number;
  };
  session?: AgentTokenUsage & { since: number; complete: boolean };
}

export interface AgentSnapshot {
  session: AgentSession;
  status: AgentStatus;
  messages: AgentMessage[];
  permissions: AgentPermission[];
  questions: AgentQuestion[];
  diffs: AgentDiff[];
  error?: string | null;
  streamConnected?: boolean;
  streamGap?: boolean;
  /** A background title job is queued/running; it does not block another prompt. */
  titlePending?: boolean;
  /** True only while the engine is building an automatic context checkpoint. */
  compacting?: boolean;
  modelPhase?: "waiting" | "streaming" | "finishing";
  /** Actual upstream usage; missing counters remain unknown. */
  usage?: AgentUsage;
}

export interface AgentProjectResult {
  workspace: AgentWorkspace;
  catalog: AgentCatalog;
  sessions: AgentSession[];
  warnings?: string[];
}

export type AgentPermissionDecision = "once" | "always" | "reject";

export interface AgentSkill {
  id: string;
  name: string;
  description: string | null;
  source: "bundled" | "local" | "marketplace";
  installed: boolean;
  enabled: boolean;
  license?: string | null;
  sourceUrl?: string | null;
  requirements: string[];
  loaded?: boolean | null;
  runtimeStatus?: string;
  runtimeId?: string | null;
  error?: string | null;
}

export interface AgentPlugin {
  id: string;
  name: string;
  entry: string;
  enabled: boolean;
  source: "local";
  loaded?: boolean | null;
  runtimeStatus?: string;
  runtimeId?: string | null;
  error?: string | null;
}

export interface AgentExtensions {
  revision: number;
  skills: AgentSkill[];
  plugins: AgentPlugin[];
  mcpServers: {
    id: string;
    type: "local" | "remote";
    enabled: boolean;
    loaded?: boolean | null;
    runtimeStatus?: string;
    runtimeId?: string | null;
    error?: string | null;
  }[];
  runtimeRevision?: number | null;
  runtimeRunning?: boolean;
  pendingReload?: boolean;
  loadedSkills?: {
    id: string;
    name: string;
    description?: string | null;
    autoinvoke?: boolean | null;
  }[];
  loadedPlugins?: {
    id?: string | null;
    sourceType: string;
    target?: string | null;
    version?: string | null;
    server: boolean;
    tui: boolean;
    rpc: boolean;
    status: string;
    error?: string | null;
  }[];
  loadedMcpServers?: { name: string; status: string; error?: string | null }[];
}

export interface AgentPluginStoreListing {
  displayName?: string;
  displayNameI18n?: Record<string, string>;
  descriptionI18n?: Record<string, string>;
  icon?: string;
  category?: string;
  author?: string;
  authorUrl?: string;
  homepage?: string;
  privacyPolicy?: string;
  termsOfService?: string;
  heroImage?: string;
  examplePrompts?: string[];
  requiresPaidPlan?: boolean;
}

export interface AgentPluginMarketplace {
  id: string;
  name: string;
  description?: string;
  lastUpdated?: string;
  pluginCount: number;
  isOfficial?: boolean;
  featured?: string[];
  source?: Record<string, unknown>;
}

export interface AgentAvailablePlugin {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  installed: boolean;
  componentTypes?: string[];
  listing?: AgentPluginStoreListing;
}

export interface AgentInstalledPlugin {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  enabled: boolean;
  scope?: "user" | "workspace";
  installedAt?: string;
  componentTypes?: string[];
  updateStatus?: "none" | "update-available" | "version-changed";
  latestVersion?: string;
  listing?: AgentPluginStoreListing;
}

export interface AgentPluginStore {
  marketplaces: AgentPluginMarketplace[];
  availablePlugins: AgentAvailablePlugin[];
  installedPlugins: AgentInstalledPlugin[];
  restorableBuiltins: AgentAvailablePlugin[];
  diagnostics: { severity?: string; message?: string; pluginId?: string }[];
  capability: {
    supported: boolean;
    reason?: string;
    customSources?: boolean;
    localPluginRuntime?: boolean;
    mcpRuntime?: boolean;
  };
}

export interface AgentExtensionConfig {
  revision: number;
  mcp: Record<string, unknown>;
  pluginOptions: Record<string, unknown>;
}
