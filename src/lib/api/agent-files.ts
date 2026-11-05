import { invoke } from "@tauri-apps/api/core";
import type { AgentPreviewHint } from "@/types/agent";

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

export interface AgentWorkspaceDirectory {
  entries: {
    name: string;
    path: string;
    kind: "directory" | "file" | "other";
  }[];
  truncated: boolean;
}

export type AgentBrowserPreviewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AgentBrowserPreviewPresentation = {
  slot: 0 | 1;
  revision: number;
};

export type AgentBrowserPreviewState = {
  sessionId: string;
  browserId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
};

export type AgentBrowserHistoryAction = "back" | "forward";
type AgentBrowserNavigation = AgentBrowserHistoryAction | { url: string };

export const agentFilesApi = {
  listDirectory: (sessionId: string, path: string) =>
    invoke<AgentWorkspaceDirectory>("list_agent_workspace_directory", {
      sessionId,
      path,
    }),
  preview: (sessionId: string, path: string) =>
    invoke<AgentFilePreview>("preview_agent_file", { sessionId, path }),
  openBrowser: (sessionId: string, url: string) =>
    invoke<Extract<AgentPreviewHint, { kind: "browser" }>>(
      "open_agent_browser_preview",
      { sessionId, url },
    ),
  browserFrame: (sessionId: string, browserId: string) =>
    invoke<string>("preview_agent_browser_frame", { sessionId, browserId }),
  syncBrowserWebview: (
    sessionId: string,
    browserId: string,
    bounds: AgentBrowserPreviewBounds | null,
    reload: boolean,
    presentation: AgentBrowserPreviewPresentation,
  ) =>
    invoke<void>("sync_agent_browser_preview_webview", {
      sessionId,
      browserId,
      bounds,
      reload,
      presentation,
    }),
  navigateBrowser: (
    sessionId: string,
    browserId: string,
    action: AgentBrowserNavigation,
  ) =>
    invoke<void>("navigate_agent_browser_preview", {
      sessionId,
      browserId,
      action,
    }),
  closeBrowser: (sessionId: string, browserId: string) =>
    invoke<void>("close_agent_browser_preview", { sessionId, browserId }),
  open: (sessionId: string, path: string, action: "file" | "directory") =>
    invoke<void>("open_agent_path", { sessionId, path, action }),
};
