// Type-only public upstream contract. The desktop passes these values unchanged.
import type {
  SessionEventsPage,
  SessionProjectionsValue,
  SessionState,
} from "@deepseek-ai/dsh-api-session-controller/types";

export type { SessionWireEvent } from "@deepseek-ai/dsh-api-session-controller/types";

export interface AgentNativeSessionRead {
  page: SessionEventsPage;
  projections: SessionProjectionsValue;
  state: SessionState;
}

export interface AgentNativeSessionPageOptions {
  beforeSeq?: number;
  throughSeq?: number;
  maxMessages?: number;
}
