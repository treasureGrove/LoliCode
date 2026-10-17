import { invoke } from "@tauri-apps/api/core";
export interface ResourcePack {
  id: string | null;
  version: number | null;
  canRollback: boolean;
  pendingConfirmation: boolean;
  assets: Partial<Record<"companion" | "scene" | "sidebar" | "brooch", string>>;
  warning: string | null;
}
export const resourcePackKey = ["presentation-resource-pack"] as const;
export const resourceUpdatesApi = {
  local: () => invoke<ResourcePack>("get_resource_pack"),
  check: () => invoke<number | null>("check_resource_update"),
  install: () => invoke<ResourcePack>("install_resource_update"),
  confirm: (id: string) => invoke<void>("confirm_resource_pack", { id }),
  rollback: (id: string) =>
    invoke<ResourcePack>("rollback_resource_pack", { id }),
};
