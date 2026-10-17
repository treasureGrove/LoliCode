import { invoke } from "@tauri-apps/api/core";

export interface UnrealProject {
  id: string;
  name: string;
  path: string;
  engineAssociation?: string | null;
  pluginInstalled: boolean;
  pluginEnabled: boolean;
  addedAt: number;
}

export interface UnrealEngine {
  version: string;
  associationId?: string | null;
  path: string;
  editorExecutable: string;
  source: string;
}

export interface UnrealBridgeStatus {
  listening: boolean;
  port: number;
  error?: string | null;
  editors: Array<{
    projectPath: string;
    projectName: string;
    engineVersion?: string | null;
    connectedAt: number;
    lastSeenAt: number;
  }>;
}

export interface UnrealSnapshot {
  projects: UnrealProject[];
  engines: UnrealEngine[];
  bridge: UnrealBridgeStatus;
  sourceRevision: string;
}

export const unrealApi = {
  snapshot: () => invoke<UnrealSnapshot>("get_unreal_snapshot"),
  addProject: (path: string) =>
    invoke<UnrealProject>("add_unreal_project", { path }),
  removeProject: (projectId: string) =>
    invoke<void>("remove_unreal_project", { projectId }),
  launchProject: (projectId: string) =>
    invoke<{ projectId: string; projectName: string; processId?: number }>(
      "launch_unreal_project",
      { projectId },
    ),
  installAgentLink: (projectId: string) =>
    invoke<UnrealProject>("install_unreal_agent_link", { projectId }),
};
