import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AgentTerminalOutput = {
  sessionId: string;
  terminalId: string;
  instance: string;
  cursor: number;
  data: string;
  exitCode: number | null;
};

type AgentTerminalSnapshot = Pick<
  AgentTerminalOutput,
  "cursor" | "data" | "exitCode"
> & {
  instance: string | null;
  running: boolean;
};

export const agentTerminalApi = {
  start: (sessionId: string, terminalId: string, cols: number, rows: number) =>
    invoke<void>("start_agent_terminal", { sessionId, terminalId, cols, rows }),
  snapshot: (sessionId: string, terminalId: string) =>
    invoke<AgentTerminalSnapshot>("get_agent_terminal", {
      sessionId,
      terminalId,
    }),
  write: (sessionId: string, terminalId: string, data: string) =>
    invoke<void>("write_agent_terminal", { sessionId, terminalId, data }),
  resize: (sessionId: string, terminalId: string, cols: number, rows: number) =>
    invoke<void>("resize_agent_terminal", {
      sessionId,
      terminalId,
      cols,
      rows,
    }),
  close: (sessionId: string, terminalId: string) =>
    invoke<void>("close_agent_terminal", { sessionId, terminalId }),
  listen: (receive: (event: AgentTerminalOutput) => void) =>
    listen<AgentTerminalOutput>("agent-terminal-output", ({ payload }) =>
      receive(payload),
    ),
};
