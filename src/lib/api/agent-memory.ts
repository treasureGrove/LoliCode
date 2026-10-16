import { invoke } from "@tauri-apps/api/core";

export type AgentMemoryScope = "user" | "project";
export interface AgentMemoryEntry {
  id: string;
  content: string;
  updatedAt: number;
  source: string;
}
export interface AgentMemorySnapshot {
  revision: number;
  enabled: boolean;
  requireApproval: boolean;
  projectPath: string | null;
  user: { entries: AgentMemoryEntry[]; used: number; limit: number };
  project: { entries: AgentMemoryEntry[]; used: number; limit: number };
}

export const agentMemoryApi = {
  get: (projectPath?: string) =>
    invoke<AgentMemorySnapshot>("get_agent_memory", { projectPath }),
  edit: (
    input: {
      revision: number;
      scope: AgentMemoryScope;
      action: "add" | "patch" | "remove";
      content?: string;
      old_text?: string;
    },
    projectPath?: string,
  ) => invoke<AgentMemorySnapshot>("edit_agent_memory", { input, projectPath }),
  configure: (
    input: { revision: number; enabled?: boolean; requireApproval?: boolean },
    projectPath?: string,
  ) =>
    invoke<AgentMemorySnapshot>("configure_agent_memory", {
      input,
      projectPath,
    }),
  clear: (
    revision: number,
    scope: AgentMemoryScope | "all",
    projectPath?: string,
  ) =>
    invoke<AgentMemorySnapshot>("clear_agent_memory", {
      revision,
      scope,
      projectPath,
    }),
};
