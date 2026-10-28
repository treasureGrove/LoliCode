import { invoke } from "@tauri-apps/api/core";
import { IS_DEVELOPMENT_BUILD } from "./buildChannel";
import { hasUnsavedChanges } from "./unsavedChanges";

export interface NativeDevelopmentBuildInfo {
  developmentBuildNumber?: string | null;
  sourceBranch?: string | null;
  sourceRevision?: string | null;
  builtAt?: string | null;
  workingTreeDirty?: boolean | null;
}

let rebuilding = false;
const listeners = new Set<() => void>();

export function subscribeDevelopmentFrontend(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isDevelopmentFrontendRebuilding() {
  return rebuilding;
}

function setRebuilding(value: boolean) {
  rebuilding = value;
  for (const listener of listeners) listener();
}

export function reloadDevelopmentFrontend() {
  window.location.reload();
}

export const developmentFrontendNavigation = {
  reload: reloadDevelopmentFrontend,
};

function reloadAfterConfirmedDiscard() {
  let timeout: number | undefined;
  const cleanup = () => {
    window.removeEventListener("beforeunload", approvedUnload, true);
    if (timeout !== undefined) window.clearTimeout(timeout);
  };
  const approvedUnload = (event: BeforeUnloadEvent) => {
    // Channel editors also install a native unload warning. The explicit
    // confirmation already authorized this reload, so consume only this event.
    event.stopImmediatePropagation();
    cleanup();
  };
  window.addEventListener("beforeunload", approvedUnload, {
    capture: true,
    once: true,
  });
  // Navigation can dispatch beforeunload asynchronously. If it never starts,
  // expire the approval while retaining every editor's dirty registration.
  timeout = window.setTimeout(cleanup, 5000);
  try {
    developmentFrontendNavigation.reload();
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function rebuildDevelopmentFrontend(
  confirmDiscard: () => boolean,
) {
  if (!IS_DEVELOPMENT_BUILD) throw new Error("此操作仅用于开发版。");
  if (rebuilding) return "busy";
  setRebuilding(true);
  try {
    await invoke("rebuild_development_frontend");
    // Recheck immediately before reloading: users can keep editing while Vite builds.
    if (hasUnsavedChanges()) {
      if (!confirmDiscard()) return "cancelled";
      reloadAfterConfirmedDiscard();
    } else developmentFrontendNavigation.reload();
    return "reloaded";
  } finally {
    setRebuilding(false);
  }
}

export function getNativeDevelopmentBuildInfo() {
  return invoke<NativeDevelopmentBuildInfo>("get_build_info");
}
