import { invoke } from "@tauri-apps/api/core";

export const LOCAL_AGENT_IDS = [
  "workbuddy",
  "deepseek-harness",
  "zcode",
  "mimocode",
] as const;
export type LocalAgentId = (typeof LOCAL_AGENT_IDS)[number];
export interface LocalAgentTool {
  id: LocalAgentId;
  installed: boolean;
  path: string | null;
  version: string | null;
  customPath: boolean;
  configPaths: string[];
  configExists: boolean;
  configError: string | null;
}

export const localAgentToolsApi = {
  list: () => invoke<LocalAgentTool[]>("list_local_agent_tools"),
  setPath: (target: LocalAgentId, path: string | null) =>
    invoke<void>("set_local_agent_tool_path", { target, path }),
  reveal: (target: LocalAgentId) =>
    invoke<void>("reveal_local_agent_tool", { target }),
};

// Stable official entry points; installer versions and platform choices belong
// to the vendors. Never load a remote image or run an installation script here.
export const LOCAL_AGENT_DOWNLOADS: Record<LocalAgentId, string> = {
  workbuddy: "https://www.codebuddy.cn/work/",
  "deepseek-harness":
    "https://github.com/deepseek-ai/deepseek-harness/releases",
  zcode: "https://zcode.z.ai/",
  mimocode: "https://github.com/XiaomiMiMo/MiMo-Code",
};
