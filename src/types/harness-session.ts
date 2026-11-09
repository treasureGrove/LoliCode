// Type-only public upstream contract. The desktop passes these values unchanged.
import type {
  SessionEventsPage,
  SessionFollowFrame,
  SessionProjectionsValue,
  SessionState,
} from "@deepseek-ai/dsh-api-session-controller/types";

export type {
  SessionAssistantStreamAttempt,
  SessionAssistantStreamBaseline,
  SessionAssistantStreamFrame,
  SessionWireEvent,
} from "@deepseek-ai/dsh-api-session-controller/types";

export type AgentNativeSessionWatchMessage =
  | { subscriptionId: string; deliveryId?: number; frame: SessionFollowFrame }
  | { subscriptionId: string; deliveryId?: number; error: string };

export interface AgentNativeSessionRead {
  page: SessionEventsPage;
  projections: SessionProjectionsValue;
  state: SessionState;
  /** Desktop upload/send identity metadata, separate from the upstream journal. */
  messageAliases?: Record<string, string>;
}

export interface AgentNativeSessionPageOptions {
  beforeSeq?: number;
  throughSeq?: number;
  maxMessages?: number;
}
