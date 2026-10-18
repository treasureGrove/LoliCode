import { invoke } from "@tauri-apps/api/core";
export interface RendererPackState {
  activeId: string | null;
  activeVersion: number | null;
  stagedVersion: number | null;
  restartRequired: boolean;
  pendingConfirmation: boolean;
  highestVersion: number;
  canRollback: boolean;
}
export interface RendererStatus {
  runningId: string | null;
  runningVersion: number | null;
  bootTicket: string | null;
  development: boolean;
  warning: string | null;
  state: RendererPackState;
}
export const rendererStatusKey = ["renderer-update-status"] as const;
export const rendererUpdatesApi = {
  local: () => invoke<RendererStatus>("get_renderer_status"),
  check: () => invoke<number | null>("check_renderer_update"),
  install: () => invoke<RendererPackState>("install_renderer_update"),
  confirm: (id: string, ticket: string) =>
    invoke<void>("confirm_renderer_boot", { id, ticket }),
  rollback: (id: string) =>
    invoke<RendererPackState>("rollback_renderer_update", { id }),
  restart: () => invoke<void>("restart_renderer"),
};
