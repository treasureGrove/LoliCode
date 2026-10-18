import { invoke } from "@tauri-apps/api/core";

export interface AgentFilePreview {
  kind: "html" | "image" | "text";
  path: string;
  name: string;
  mimeType: string;
  content?: string;
  dataUrl?: string;
  truncated: boolean;
  sizeBytes: number;
  remote?: boolean;
}

export const agentFilesApi = {
  preview: (sessionId: string, path: string) =>
    invoke<AgentFilePreview>("preview_agent_file", { sessionId, path }),
  open: (sessionId: string, path: string, action: "file" | "directory") =>
    invoke<void>("open_agent_path", { sessionId, path, action }),
};
