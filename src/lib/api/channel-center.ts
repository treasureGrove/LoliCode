import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";

export type ChannelTarget =
  | AppId
  | "workbuddy"
  | "deepseek-harness"
  | "zcode"
  | "mimocode"
  | "codebuddy";

export type ChannelProtocol =
  | "openai_chat"
  | "openai_responses"
  | "anthropic"
  | "gemini_native";

export interface ChannelModel {
  id: string;
  name?: string;
  contextLimit?: number;
  selectedContextLimit?: number;
  /** Window sizes explicitly advertised by this channel. */
  contextLimits?: number[] | null;
  outputLimit?: number;
  /** Exact effort values advertised by the upstream catalog; absent is unknown. */
  reasoningEfforts?: string[];
  reasoningEffortSource?: string;
  reasoningEffortTransport?: "declared" | "unconfirmed" | "mixed";
  supportsTools?: boolean;
  inputModalities?: string[];
  protocol?: ChannelProtocol;
  /** Missing means selected; discovery can exclude unsupported models. */
  enabled?: boolean;
}

export interface ChannelSource {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  authKind:
    | "api_key"
    | "github_copilot"
    | "zhipu_oauth"
    | "codex_oauth"
    | "xai_oauth"
    | "claude_subscription"
    | "gemini_subscription";
  accountId?: string;
  protocol: ChannelProtocol;
  models: ChannelModel[];
  enabled: boolean;
}

export interface ChannelCenterSnapshot {
  /** Protects saved channels against a stale editor overwriting newer changes. */
  revision?: number;
  channels: ChannelSource[];
  targets: ChannelTarget[];
  /** Stable identity, including channel so duplicate upstream names stay distinct. */
  defaultModel?: string;
}

export interface ChannelUsageLabel {
  providerId: string;
  name: string;
}

export interface ChannelApplyResult {
  app: ChannelTarget;
  status: "success" | "skipped" | "error";
  message: string;
}

export interface ChannelApplyResponse {
  results: ChannelApplyResult[];
  requiresBackground: boolean;
}

export interface ChannelConnection {
  app: "codex" | "claude";
  mode: "native" | "lolicode" | "unknown";
  configured: boolean;
  hasNativeProfile: boolean;
  message?: string | null;
}

export type ZhipuLoginProvider = "bigmodel" | "zai";

export interface ZhipuLoginFlow {
  flowId: string;
  url: string;
  expiresIn: number;
}

export interface ZhipuLoginStatus {
  status: "pending" | "success" | "error";
  channel?: ChannelSource;
  message?: string;
}

export const channelCenterApi = {
  get: () => invoke<ChannelCenterSnapshot>("get_channel_center"),
  listUsageLabels: () =>
    invoke<ChannelUsageLabel[]>("list_channel_usage_labels"),
  save: (snapshot: ChannelCenterSnapshot) =>
    invoke<void>("save_channel_center", { snapshot }),
  discover: (channel: ChannelSource) =>
    invoke<ChannelSource>("discover_channel_models", { channel }),
  apply: (expectedRevision?: number) =>
    invoke<ChannelApplyResponse>("apply_channel_center", { expectedRevision }),
  getConnections: () => invoke<ChannelConnection[]>("get_channel_connections"),
  setConnection: (
    target: ChannelConnection["app"],
    mode: "native" | "lolicode",
    expectedRevision?: number,
  ) =>
    invoke<ChannelConnection>("set_channel_connection", {
      target,
      mode,
      expectedRevision,
    }),
  startZhipuLogin: (provider: ZhipuLoginProvider) =>
    invoke<ZhipuLoginFlow>("start_zhipu_login", { provider }),
  pollZhipuLogin: (flowId: string) =>
    invoke<ZhipuLoginStatus>("poll_zhipu_login", { flowId }),
  cancelZhipuLogin: (flowId: string) =>
    invoke<void>("cancel_zhipu_login", { flowId }),
  openNativeSubscriptionLogin: (tool: "claude" | "gemini") =>
    invoke<void>("open_native_subscription_login", { tool }),
  discoverNativeSubscription: (tool: "claude" | "gemini") =>
    invoke<ChannelSource>("discover_native_subscription_channel", { tool }),
};
