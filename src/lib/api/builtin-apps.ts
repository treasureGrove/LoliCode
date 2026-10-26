import { invoke } from "@tauri-apps/api/core";
import { useQuery } from "@tanstack/react-query";

export const BUILTIN_APP_IDS = [
  "tavern",
  "unreal",
  "rankings",
  "free-ai",
] as const;
export type BuiltinAppId = (typeof BUILTIN_APP_IDS)[number];
export const isBuiltinApp = (value: string): value is BuiltinAppId =>
  (BUILTIN_APP_IDS as readonly string[]).includes(value);
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
