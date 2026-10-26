import { useEffect, useState } from "react";
import { isBuiltinApp, type BuiltinAppId } from "@/lib/api/builtin-apps";

export const SIDEBAR_TOOLS_KEY = "lolicode-sidebar-tools-v1";

interface SidebarToolsPreferences {
  collapsed: boolean;
  pinned: BuiltinAppId[];
}

function readPreferences(): SidebarToolsPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(SIDEBAR_TOOLS_KEY) ?? "null");
    return {
      collapsed: value?.collapsed === true,
      pinned: Array.isArray(value?.pinned)
        ? ([
            ...new Set(
              value.pinned.filter(
                (id: unknown): id is BuiltinAppId =>
                  typeof id === "string" && isBuiltinApp(id),
              ),
            ),
          ] as BuiltinAppId[])
        : [],
    };
  } catch {
    return { collapsed: false, pinned: [] };
  }
}

export function useSidebarTools() {
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_TOOLS_KEY, JSON.stringify(preferences));
    } catch {
      // The current window remains usable when persistent storage is unavailable.
    }
  }, [preferences]);
  return {
    ...preferences,
    toggleCollapsed: () =>
      setPreferences((current) => ({
        ...current,
        collapsed: !current.collapsed,
      })),
    togglePinned: (id: BuiltinAppId) =>
      setPreferences((current) => ({
        ...current,
        pinned: current.pinned.includes(id)
          ? current.pinned.filter((item) => item !== id)
          : [id, ...current.pinned],
      })),
    unpin: (id: BuiltinAppId) =>
      setPreferences((current) => ({
        ...current,
        pinned: current.pinned.filter((item) => item !== id),
      })),
  };
}
