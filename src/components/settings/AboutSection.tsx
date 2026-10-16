import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  Github,
  Globe,
  Info,
  Loader2,
  RefreshCw,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { getVersion } from "@tauri-apps/api/app";
import { settingsApi } from "@/lib/api";
import { useUpdate } from "@/contexts/UpdateContext";
import { Badge } from "@/components/ui/badge";
import { WhatsNewDialog } from "@/components/WhatsNewDialog";
import { WHATS_NEW_ENTRIES, entriesUpTo } from "@/lib/whatsNew";
import appIcon from "@/assets/brand/lolicode.svg";
import { extractErrorMessage } from "@/utils/errorUtils";
import {
  APP_CHANGELOG,
  APP_NAME,
  APP_REPOSITORY,
  APP_UPDATES_ENABLED,
  APP_WEBSITE,
} from "@/lib/branding";

interface AboutSectionProps {
  isPortable: boolean | null;
}

// 应用自身版本（getVersion，本地毫秒级、无网络）也缓存一份，纯为重挂时免去 loading 闪烁。
let appVersionCache: string | null = null;

// 邀 Star 条关掉后记在本机（纯界面偏好，不进库、不随云同步）
const STAR_PROMPT_DISMISSED_KEY = "ccswitch:about:starPromptDismissed";

function readStarPromptDismissed(): boolean {
  try {
    return localStorage.getItem(STAR_PROMPT_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 设置 → 关于：版本、便携模式、检查更新 / 安装并重启、项目链接。
 * 命令行应用的安装与升级在侧栏「应用」页。
 */
export function AboutSection({ isPortable }: AboutSectionProps) {
  const { t } = useTranslation();
  // Unknown installation mode must never authorize the native installer.
  const requiresManualDownload = isPortable !== false;
  // 惰性初始化自模块缓存：重挂时首帧即渲染上次的值，避免 loading 闪烁；首次挂载缓存
  // 为空则回退到原始初值（null / loading）。
  const [version, setVersion] = useState<string | null>(() => appVersionCache);
  const [isLoadingVersion, setIsLoadingVersion] = useState(
    () => appVersionCache === null,
  );
  const [openingDownloadPage, setOpeningDownloadPage] = useState(false);
  const openingDownload = useRef(false);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  const [starPromptDismissed, setStarPromptDismissed] = useState(
    readStarPromptDismissed,
  );
  const recentEntries = useMemo(
    () => (version ? entriesUpTo(WHATS_NEW_ENTRIES, version) : []),
    [version],
  );

  const {
    hasUpdate,
    updateInfo,
    checkUpdate,
    installUpdate,
    resetDismiss,
    isChecking,
    isInstalling,
    phase,
    progress,
    error,
  } = useUpdate();

  useEffect(() => {
    let active = true;
    const loadAppVersion = async () => {
      try {
        const appVersion = await getVersion();
        appVersionCache = appVersion;
        if (active) {
          setVersion(appVersion);
        }
      } catch (error) {
        console.error("[AboutSection] Failed to load app version", error);
        if (active) {
          setVersion(null);
        }
      } finally {
        if (active) {
          setIsLoadingVersion(false);
        }
      }
    };

    void loadAppVersion();
    return () => {
      active = false;
    };
  }, []);

  const handleOpenReleaseNotes = useCallback(async () => {
    try {
      await settingsApi.openExternal(APP_CHANGELOG);
    } catch (error) {
      console.error("[AboutSection] Failed to open release notes", error);
      toast.error(t("settings.openReleaseNotesFailed"));
    }
  }, [t]);

  const handleOpenGithub = useCallback(() => {
    void settingsApi.openExternal(APP_REPOSITORY);
  }, []);

  const handleDismissStarPrompt = useCallback(() => {
    setStarPromptDismissed(true);
    try {
      localStorage.setItem(STAR_PROMPT_DISMISSED_KEY, "1");
    } catch {
      // 存不下就只在本次会话里隐藏
    }
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    try {
      const available = await checkUpdate();
      if (!available) {
        toast.success(t("settings.upToDate"), { closeButton: true });
      }
    } catch (error) {
      console.error("[AboutSection] Check update failed", error);
      toast.error(t("settings.checkUpdateFailed"), {
        description: extractErrorMessage(error) || undefined,
        closeButton: true,
      });
    }
  }, [checkUpdate, t]);

  const handleInstallUpdate = useCallback(async () => {
    if (requiresManualDownload) {
      if (openingDownload.current) return;
      openingDownload.current = true;
      setOpeningDownloadPage(true);
      try {
        await settingsApi.openExternal(APP_WEBSITE);
      } catch (cause) {
        toast.error(t("settings.openReleaseNotesFailed"), {
          description: extractErrorMessage(cause) || undefined,
        });
      } finally {
        openingDownload.current = false;
        setOpeningDownloadPage(false);
      }
      return;
    }
    try {
      resetDismiss();
      const installed = await installUpdate();
      if (!installed)
        toast.success(t("settings.upToDate"), { closeButton: true });
    } catch (cause) {
      toast.error(
        t("settings.appUpdate.installFailed", {
          defaultValue: "更新未完成，请查看原因后重试。",
        }),
        {
          description: extractErrorMessage(cause) || undefined,
          closeButton: true,
        },
      );
    }
  }, [installUpdate, requiresManualDownload, resetDismiss, t]);

  const downloadPercent =
    progress?.total && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : undefined;
  const phaseLabel = {
    checking: t("settings.checking"),
    downloading: t("settings.appUpdate.downloading", {
      defaultValue: "正在下载更新包…",
    }),
    verifying: t("settings.appUpdate.verifying", {
      defaultValue: "正在校验更新包…",
    }),
    installing: t("settings.appUpdate.installing", {
      defaultValue: "正在安装并重启…",
    }),
    up_to_date: t("settings.upToDate"),
  }[
    phase as
      | "checking"
      | "downloading"
      | "verifying"
      | "installing"
      | "up_to_date"
  ];

  const displayVersion = version ?? t("common.unknown");

  return (
    <div className="divide-y divide-border overflow-hidden rounded-panel border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-4 px-5 py-4">
        <img src={appIcon} alt="" className="h-10 w-10 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-title text-fg-1">{APP_NAME}</div>
          <div className="text-caption text-fg-2">
            {t("settings.forkAttribution", {
              defaultValue: "Based on CC Switch · MIT · Jason Young",
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-caption text-fg-2">
            {isLoadingVersion ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <span className="tabular-nums">{`${t("common.version")} v${displayVersion}`}</span>
            )}
            {isPortable && (
              <Badge
                variant="secondary"
                className="gap-1 px-1.5 py-0 text-badge"
              >
                <Info className="h-3 w-3" />
                {t("settings.portableMode")}
              </Badge>
            )}
          </div>
        </div>
      </div>
      <section
        aria-label={t("nav.softwareUpdates", { defaultValue: "软件更新" })}
        className="space-y-3 px-5 py-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-body font-semibold text-fg-1">
            {t("nav.softwareUpdates", { defaultValue: "软件更新" })}
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="neutral"
              size="regular"
              onClick={handleCheckUpdate}
              disabled={
                !APP_UPDATES_ENABLED ||
                isChecking ||
                isInstalling ||
                openingDownloadPage
              }
            >
              {!APP_UPDATES_ENABLED ? (
                t("settings.manualUpdateOnly", {
                  defaultValue: "Test build · manual updates",
                })
              ) : isChecking ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  {t("settings.checking")}
                </>
              ) : (
                <>
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("settings.checkForUpdates")}
                </>
              )}
            </Button>
            {hasUpdate && (
              <Button
                type="button"
                variant="solid"
                size="regular"
                onClick={() => void handleInstallUpdate()}
                disabled={
                  !APP_UPDATES_ENABLED ||
                  isChecking ||
                  isInstalling ||
                  openingDownloadPage
                }
              >
                {isInstalling || openingDownloadPage ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {requiresManualDownload
                  ? t("settings.appUpdate.downloadPage", {
                      defaultValue: "打开下载页面",
                    })
                  : isInstalling
                    ? phaseLabel
                    : phase === "error"
                      ? t("settings.appUpdate.retryInstall", {
                          defaultValue: "重试下载并安装",
                        })
                      : t("settings.appUpdate.install", {
                          defaultValue: "下载并安装",
                        })}
              </Button>
            )}
          </div>
        </div>
        <p className="text-caption text-fg-2">
          {isPortable === null
            ? t("settings.appUpdate.unknownModeHelp", {
                defaultValue:
                  "尚未确认安装方式，请从下载页面获取新版本，完成任务后手动安装。",
              })
            : isPortable
              ? t("settings.appUpdate.portableHelp", {
                  defaultValue:
                    "便携版请从下载页面获取新版本，完成任务后替换程序。",
                })
              : t("settings.appUpdate.restartHelp", {
                  defaultValue:
                    "检查更新不会中断任务。安装会重启 LoliCode；请先完成正在运行的任务和待处理的授权。",
                })}
        </p>
        {phaseLabel && (
          <p role="status" className="text-caption text-fg-2">
            {phaseLabel}
          </p>
        )}
        {isInstalling && progress && (
          <div className="space-y-1">
            <div
              role="progressbar"
              aria-label={t("settings.appUpdate.downloadProgress", {
                defaultValue: "下载更新包",
              })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={downloadPercent}
              className="h-2 overflow-hidden rounded-full bg-subtle"
            >
              <div
                className="h-full rounded-full bg-action"
                style={{
                  width:
                    downloadPercent === undefined
                      ? "0%"
                      : `${downloadPercent}%`,
                }}
              />
            </div>
            <p className="text-caption tabular-nums text-fg-2">
              {downloadPercent !== undefined ? `${downloadPercent}% · ` : ""}
              {(progress.downloaded / (1024 * 1024)).toFixed(1)} MB
              {progress.total
                ? ` / ${(progress.total / (1024 * 1024)).toFixed(1)} MB`
                : ""}
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="break-words text-caption text-danger-text">
            {error}
          </p>
        )}
      </section>

      {hasUpdate && updateInfo && (
        <div className="space-y-1 px-5 py-4 text-body">
          <p className="font-medium text-fg-1">
            {t("settings.updateAvailable", {
              version: updateInfo.availableVersion,
            })}
          </p>
          {updateInfo.notes && (
            <p className="line-clamp-3 text-fg-2">{updateInfo.notes}</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 px-5 py-4">
        {starPromptDismissed && (
          <Button
            type="button"
            variant="neutral"
            size="compact"
            onClick={handleOpenGithub}
          >
            <Github className="h-3.5 w-3.5" />
            {t("settings.github")}
          </Button>
        )}
        <Button
          type="button"
          variant="neutral"
          size="compact"
          onClick={() => settingsApi.openExternal(APP_WEBSITE)}
        >
          <Globe className="h-3.5 w-3.5" />
          {t("settings.officialWebsite")}
        </Button>
        <Button
          type="button"
          variant="neutral"
          size="compact"
          onClick={handleOpenReleaseNotes}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t("settings.releaseNotes")}
        </Button>
        {recentEntries.length > 0 && (
          <Button
            type="button"
            variant="neutral"
            size="compact"
            onClick={() => setWhatsNewOpen(true)}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t("whatsNew.recentTitle")}
          </Button>
        )}
      </div>

      {/* 项目仓库入口与软件更新入口各自独立。 */}
      {!starPromptDismissed && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 bg-action-soft py-3.5 ps-5 pe-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Star
              aria-hidden="true"
              className="h-5 w-5 shrink-0 animate-[spin_6s_linear_infinite] fill-amber-500 text-amber-500 motion-reduce:animate-none"
            />
            <p className="min-w-0 text-body text-fg-1">
              {t("settings.starPrompt")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="neutral"
              size="compact"
              onClick={handleOpenGithub}
            >
              <Github className="h-3.5 w-3.5" />
              {t("settings.starOnGithub")}
            </Button>
            <Button
              type="button"
              variant="quiet"
              size="icon-compact"
              onClick={handleDismissStarPrompt}
              aria-label={t("common.close")}
              title={t("common.close")}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}

      <WhatsNewDialog
        open={whatsNewOpen}
        onClose={() => setWhatsNewOpen(false)}
        entries={recentEntries}
      />
    </div>
  );
}
