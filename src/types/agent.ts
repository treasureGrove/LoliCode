export type AgentMode = "build" | "plan";
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

export interface AgentModel {
  /** Opaque engine model identity. Do not split it into route segments. */
  id: string;
  providerId: string;
  modelId: string;
  name: string;
  channelName: string;
  contextLimit?: number | null;
  outputLimit?: number | null;
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

export interface AgentSession {
  id: string;
  title: string;
  projectPath: string;
  model?: { providerId: string; modelId: string } | null;
  mode?: AgentMode | string;
  createdAt: number;
  updatedAt: number;
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

export interface AgentPermission {
  id: string;
  sessionId: string;
  action: string;
  resources: string[];
  description?: string | null;
  toolName?: string | null;
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
}

export interface AgentProjectResult {
  workspace: AgentWorkspace;
  catalog: AgentCatalog;
  sessions: AgentSession[];
}

export type AgentPermissionDecision = "once" | "always" | "reject";
