import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { UpdateInfo } from "../lib/updater";
import { checkForUpdate } from "../lib/updater";
import { APP_UPDATES_ENABLED } from "../lib/branding";
import { settingsApi } from "@/lib/api";
import { useSettingsQuery } from "@/lib/query/queries";
import { extractErrorMessage } from "../utils/errorUtils";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "up_to_date"
  | "downloading"
  | "verifying"
  | "installing"
  | "error";
export interface UpdateDownloadProgress {
  downloaded: number;
  total?: number | null;
}
interface UpdateContextValue {
  hasUpdate: boolean;
  updateInfo: UpdateInfo | null;
  isChecking: boolean;
  isInstalling: boolean;
  phase: UpdatePhase;
  progress: UpdateDownloadProgress | null;
  error: string | null;
  isDismissed: boolean;
  dismissUpdate: () => void;
  checkUpdate: () => Promise<boolean>;
  installUpdate: () => Promise<boolean>;
  resetDismiss: () => void;
}
type Operation = { kind: "check" | "install"; promise: Promise<boolean> };
const UpdateContext = createContext<UpdateContextValue | undefined>(undefined);
const DISMISSED_VERSION_KEY = "ccswitch:update:dismissedVersion";
const LEGACY_DISMISSED_KEY = "dismissedUpdateVersion";

function dismissedVersion() {
  try {
    const current = localStorage.getItem(DISMISSED_VERSION_KEY);
    const legacy = localStorage.getItem(LEGACY_DISMISSED_KEY);
    if (!current && legacy) {
      localStorage.setItem(DISMISSED_VERSION_KEY, legacy);
      localStorage.removeItem(LEGACY_DISMISSED_KEY);
    }
    return current || legacy;
  } catch {
    return null;
  }
}

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const { data: settings, isSuccess: settingsLoaded } = useSettingsQuery();
  const [hasUpdate, setHasUpdate] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDismissed, setIsDismissed] = useState(false);
  const operation = useRef<Operation | null>(null);
  const mounted = useRef(true);
  const listeners = useRef(new Set<UnlistenFn>());
  const autoChecked = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const stop of listeners.current) stop();
      listeners.current.clear();
    };
  }, []);

  const clearAvailable = useCallback(() => {
    setHasUpdate(false);
    setUpdateInfo(null);
    setIsDismissed(false);
  }, []);

  const checkUpdate = useCallback((): Promise<boolean> => {
    if (!APP_UPDATES_ENABLED)
      return Promise.reject(new Error("当前构建未启用自动更新"));
    if (operation.current?.kind === "check") return operation.current.promise;
    if (operation.current)
      return Promise.reject(new Error("更新正在进行，请等待当前更新完成。"));
    setIsChecking(true);
    setError(null);
    setPhase("checking");
    const current: Operation = {
      kind: "check",
      promise: Promise.resolve(false),
    };
    const promise = Promise.resolve().then(async () => {
      try {
        const result = await checkForUpdate({ timeout: 30000 });
        if (mounted.current) {
          if (result.status === "available") {
            setHasUpdate(true);
            setUpdateInfo(result.info);
            setPhase("available");
            setIsDismissed(dismissedVersion() === result.info.availableVersion);
          } else {
            clearAvailable();
            setPhase("up_to_date");
          }
        }
        return result.status === "available";
      } catch (cause) {
        if (mounted.current) {
          setError(extractErrorMessage(cause) || "检查更新失败，请重试");
          setPhase("error");
        }
        throw cause;
      } finally {
        if (mounted.current) setIsChecking(false);
        if (operation.current === current) operation.current = null;
      }
    });
    current.promise = promise;
    operation.current = current;
    return promise;
  }, [clearAvailable]);

  const installUpdate = useCallback((): Promise<boolean> => {
    if (!APP_UPDATES_ENABLED)
      return Promise.reject(new Error("当前构建未启用自动更新"));
    if (operation.current?.kind === "install") return operation.current.promise;
    if (operation.current)
      return Promise.reject(new Error("正在检查更新，请等待检查完成。"));
    setIsInstalling(true);
    setError(null);
    setProgress(null);
    setPhase("checking");
    const current: Operation = {
      kind: "install",
      promise: Promise.resolve(false),
    };
    const stops: UnlistenFn[] = [];
    let dispatched = false;
    const promise = Promise.resolve().then(async () => {
      try {
        const onDownload = await listen<UpdateDownloadProgress>(
          "update-download-progress",
          ({ payload }) => {
            if (
              !mounted.current ||
              operation.current !== current ||
              !Number.isFinite(payload?.downloaded) ||
              payload.downloaded < 0
            )
              return;
            setProgress({
              downloaded: payload.downloaded,
              total:
                Number.isFinite(payload.total) && payload.total! > 0
                  ? payload.total
                  : null,
            });
            setPhase("downloading");
          },
        );
        stops.push(onDownload);
        listeners.current.add(onDownload);
        const onPhase = await listen<{ phase: UpdatePhase; message?: string }>(
          "app-update-progress",
          ({ payload }) => {
            if (
              !mounted.current ||
              operation.current !== current ||
              ![
                "checking",
                "downloading",
                "verifying",
                "installing",
                "error",
                "up_to_date",
              ].includes(payload?.phase)
            )
              return;
            setPhase(payload.phase);
            if (payload.phase === "error")
              setError(payload.message || "更新失败，请重试");
          },
        );
        stops.push(onPhase);
        listeners.current.add(onPhase);
        if (!mounted.current)
          throw new Error("更新界面已关闭，请重新打开后重试");
        // The backend checks every running project under its lifecycle lock.
        // A busy session or failed readiness check must reject, never return false.
        const installed = await settingsApi.installUpdateAndRestart();
        if (typeof installed !== "boolean")
          throw new Error("更新服务没有返回有效结果，请重试");
        dispatched = installed === true;
        if (mounted.current) {
          if (installed) setPhase("installing");
          else {
            clearAvailable();
            setPhase("up_to_date");
            setIsInstalling(false);
          }
        }
        return installed;
      } catch (cause) {
        if (mounted.current) {
          setError(extractErrorMessage(cause) || "更新失败，请重试");
          setPhase("error");
          setIsInstalling(false);
        }
        throw cause;
      } finally {
        for (const stop of stops) {
          if (listeners.current.delete(stop)) stop();
        }
        // Once native installation is dispatched, keep UI actions blocked until
        // the application restarts instead of allowing a second installer.
        if (!dispatched && operation.current === current)
          operation.current = null;
      }
    });
    current.promise = promise;
    operation.current = current;
    return promise;
  }, [clearAvailable]);

  const dismissUpdate = useCallback(() => {
    setIsDismissed(true);
    if (updateInfo?.availableVersion) {
      try {
        localStorage.setItem(
          DISMISSED_VERSION_KEY,
          updateInfo.availableVersion,
        );
        localStorage.removeItem(LEGACY_DISMISSED_KEY);
      } catch {}
    }
  }, [updateInfo?.availableVersion]);
  const resetDismiss = useCallback(() => {
    setIsDismissed(false);
    try {
      localStorage.removeItem(DISMISSED_VERSION_KEY);
      localStorage.removeItem(LEGACY_DISMISSED_KEY);
    } catch {}
  }, []);

  useEffect(() => {
    if (
      !APP_UPDATES_ENABLED ||
      !settingsLoaded ||
      settings?.checkUpdates === false
    )
      return;
    const automaticCheck = () => {
      void checkUpdate().catch(() => {});
    };
    const timer = autoChecked.current
      ? undefined
      : setTimeout(() => {
          autoChecked.current = true;
          automaticCheck(); // Automatic checks never install.
        }, 1000);
    const interval = setInterval(automaticCheck, 6 * 60 * 60 * 1000);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, [checkUpdate, settingsLoaded, settings?.checkUpdates]);

  return (
    <UpdateContext.Provider
      value={{
        hasUpdate,
        updateInfo,
        isChecking,
        isInstalling,
        phase,
        progress,
        error,
        isDismissed,
        dismissUpdate,
        checkUpdate,
        installUpdate,
        resetDismiss,
      }}
    >
      {children}
    </UpdateContext.Provider>
  );
}

export function useUpdate() {
  const context = useContext(UpdateContext);
  if (!context) throw new Error("useUpdate must be used within UpdateProvider");
  return context;
}
