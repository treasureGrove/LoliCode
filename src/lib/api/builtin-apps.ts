import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";

export type BuiltinAppId = "tavern" | "unreal";
export interface BuiltinAppState {
  id: BuiltinAppId;
  enabled: boolean;
}
export const builtinAppsKey = ["builtin-apps"] as const;
export const builtinAppsApi = {
  list: () => invoke<BuiltinAppState[]>("list_builtin_apps"),
  setEnabled: (app: BuiltinAppId, enabled: boolean) =>
    invoke<void>("set_builtin_app_enabled", { app, enabled }),
};
export const useBuiltinApps = () =>
  useQuery({
    queryKey: builtinAppsKey,
    queryFn: builtinAppsApi.list,
    retry: false,
  });
