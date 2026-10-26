import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DeepLinkImportDialog } from "@/components/DeepLinkImportDialog";
import { FirstRunNoticeDialog } from "@/components/FirstRunNoticeDialog";
import { WhatsNewNotice } from "@/components/WhatsNewDialog";
import { AgentPage } from "@/components/agent/AgentPage";
import { BuiltinApplicationsPage } from "@/components/apps/BuiltinApplicationsPage";
import { isBuiltinApp, useBuiltinApps } from "@/lib/api/builtin-apps";
import { DiscoveryPage } from "@/components/discovery/DiscoveryPage";
import { TavernPage } from "@/components/tavern/TavernPage";
import { UnrealPage } from "@/components/unreal/UnrealPage";
import {
  checkToolUpdatesInBackground,
  useToolUpdatesAvailable,
} from "@/components/apps/useToolManagement";
import { ChannelCenterPanel } from "@/components/channels/ChannelCenterPanel";
import { EnvWarningBanner } from "@/components/env/EnvWarningBanner";
import { MotionSurface } from "@/components/motion/MotionSurface";
import { SettingsPage } from "@/components/settings/SettingsPage";
import {
  AppPageHeader,
  WindowControlsContext,
} from "@/components/shell/AppPageHeader";
import { Sidebar } from "@/components/shell/Sidebar";
import { WindowControls } from "@/components/shell/WindowControls";
import { SimpleUsagePage } from "@/components/usage/SimpleUsagePage";
import { APP_IDS, DEFAULT_VISIBLE_APPS } from "@/config/appConfig";
import { useUpdate } from "@/contexts/UpdateContext";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useTrayNavigation } from "@/hooks/useTrayNavigation";
import { useUsageCacheBridge } from "@/hooks/useUsageCacheBridge";
import { providersApi, type AppId } from "@/lib/api";
import { checkAllEnvConflicts, checkEnvConflicts } from "@/lib/api/env";
import { proxyApi } from "@/lib/api/proxy";
import {
  APP_STORAGE_KEY,
  productViewOf,
  readStoredView,
  storeView,
  type GlobalPage,
  type SettingsSection,
  type View,
} from "@/lib/navigation";
import { isLinux, isWindows } from "@/lib/platform";
import { proxyKeys, useSettingsQuery } from "@/lib/query";
import { toast } from "@/lib/toast";
import { discardUnsavedChanges, hasUnsavedChanges } from "@/lib/unsavedChanges";
import type { VisibleApps } from "@/types";
import type { EnvConflict } from "@/types/env";
import { isTextEditableTarget } from "@/utils/domUtils";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface SyncStatusUpdatedPayload {
  source?: string;
  status?: string;
  error?: string;
}

const getInitialApp = (): AppId => {
  const saved = localStorage.getItem(APP_STORAGE_KEY) as AppId | null;
  if (saved && APP_IDS.includes(saved)) {
    return saved;
  }
  return "claude";
};

function App() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { hasUpdate, checkUpdate } = useUpdate();
  const builtinApps = useBuiltinApps();

  const [activeApp, setActiveApp] = useState<AppId>(getInitialApp);
  const [currentView, setCurrentView] = useState<View>(readStoredView);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [appConfigScrollTarget, setAppConfigScrollTarget] = useState<AppId>();
  // 进设置前停留的页面：设置目录里的「← 返回」回到这里
  const settingsReturnViewRef = useRef<View>("channels");
  const [channelNavigationBusy, setChannelNavigationBusy] = useState(false);
  const [agentInitialProjectPath, setAgentInitialProjectPath] =
    useState<string>();

  useEffect(() => {
    storeView(currentView);
  }, [currentView]);

  const { data: settingsData } = useSettingsQuery();
  // Windows 一律去掉系统标题栏，用页头里的应用内窗口按钮；Linux 由设置决定
  const useAppWindowControls =
    isWindows() || (isLinux() && (settingsData?.useAppWindowControls ?? false));
  const visibleApps = useMemo<VisibleApps>(
    () => ({
      ...DEFAULT_VISIBLE_APPS,
      ...settingsData?.visibleApps,
    }),
    [settingsData?.visibleApps],
  );

  const getFirstVisibleApp = (): AppId => {
    return APP_IDS.find((app) => visibleApps[app]) ?? "claude";
  };

  useEffect(() => {
    if (!visibleApps[activeApp]) {
      setActiveApp(getFirstVisibleApp());
    }
  }, [visibleApps, activeApp]);

  // 「启动时检查应用更新」（默认关）：打开了才在后台查一次，查到新版本侧栏「应用」上出现圆点
  const checkToolUpdatesOnStartup =
    settingsData?.checkToolUpdatesOnStartup ?? false;
  const toolUpdatesAvailable = useToolUpdatesAvailable();
  const startupToolCheckDoneRef = useRef(false);
  useEffect(() => {
    if (!checkToolUpdatesOnStartup || startupToolCheckDoneRef.current) return;
    startupToolCheckDoneRef.current = true;
    void checkToolUpdatesInBackground();
  }, [checkToolUpdatesOnStartup]);

  // Recovery remains native; surface failures in the product shell instead
  // of keeping the retired per-client provider pages just to show a banner.
  useEffect(() => {
    void proxyApi
      .takeStartupAttachFailures()
      .then((failures) => {
        if (!failures?.length) return;
        toast.error(
          t("notifications.routingRestoreFailed", {
            defaultValue:
              "部分本地客户端路由未能恢复，请在渠道与模型中检查配置。",
          }),
          {
            description: failures.map((failure) => failure.appType).join("、"),
            duration: 8000,
          },
        );
      })
      .catch(() => undefined);
  }, [t]);

  const [envConflicts, setEnvConflicts] = useState<EnvConflict[]>([]);
  const [showEnvBanner, setShowEnvBanner] = useState(false);

  const mainScrollRef = useRef<HTMLElement>(null);
  useUsageCacheBridge();

  useTauriEvent("universal-provider-synced", async () => {
    await queryClient.invalidateQueries({ queryKey: ["providers"] });
    try {
      await providersApi.updateTrayMenu();
    } catch (error) {
      console.error("[App] Failed to update tray menu", error);
    }
  });

  // 兼容配置应用后刷新共享缓存；原生代理状态直接改 DB，需要显式刷新。
  useTauriEvent("profile-applied", async () => {
    await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    await queryClient.invalidateQueries({ queryKey: ["mcp", "all"] });
    await queryClient.invalidateQueries({ queryKey: ["skills"] });
    await queryClient.invalidateQueries({
      queryKey: proxyKeys.takeoverStatus,
    });
    await queryClient.invalidateQueries({ queryKey: proxyKeys.status });
    await queryClient.invalidateQueries({
      queryKey: ["providers", "claude-desktop"],
    });
  });

  useTauriEvent<SyncStatusUpdatedPayload | null | undefined>(
    "webdav-sync-status-updated",
    async (payload) => {
      const statusPayload = payload ?? {};
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (statusPayload.source !== "auto" || statusPayload.status !== "error") {
        return;
      }
      toast.error(
        t("settings.webdavSync.autoSyncFailedToast", {
          error: statusPayload.error || t("common.unknown"),
        }),
      );
    },
  );

  useTauriEvent<SyncStatusUpdatedPayload | null | undefined>(
    "s3-sync-status-updated",
    async (payload) => {
      const statusPayload = payload ?? {};
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (statusPayload.source !== "auto" || statusPayload.status !== "error") {
        return;
      }
      toast.error(
        t("settings.s3Sync.autoSyncFailedToast", {
          error: statusPayload.error || t("common.unknown"),
        }),
      );
    },
  );

  useTauriEvent<{ appType: string; providerName: string }>(
    "proxy-official-warning",
    (payload) => {
      toast.warning(
        t("notifications.proxyOfficialWarning", {
          name: payload.providerName,
          defaultValue: `当前供应商 ${payload.providerName} 是官方供应商，建议切换到第三方供应商后再使用代理接管`,
        }),
        { duration: 8000 },
      );
    },
  );

  useEffect(() => {
    // settingsData 未加载时跳过，避免用 fallback false 覆盖 Rust 侧已设好的装饰状态
    if (!settingsData) return;

    const syncWindowDecorations = async () => {
      try {
        await getCurrentWindow().setDecorations(!useAppWindowControls);
      } catch (error) {
        console.error("[App] Failed to update window decorations", error);
      }
    };

    void syncWindowDecorations();
  }, [useAppWindowControls, settingsData]);

  useEffect(() => {
    const checkEnvOnStartup = async () => {
      try {
        const allConflicts = await checkAllEnvConflicts();
        const flatConflicts = Object.values(allConflicts).flat();

        if (flatConflicts.length > 0) {
          setEnvConflicts(flatConflicts);
          const dismissed = sessionStorage.getItem("env_banner_dismissed");
          if (!dismissed) {
            setShowEnvBanner(true);
          }
        }
      } catch (error) {
        console.error(
          "[App] Failed to check environment conflicts on startup:",
          error,
        );
      }
    };

    checkEnvOnStartup();
  }, []);

  useEffect(() => {
    const checkMigration = async () => {
      try {
        const migrated = await invoke<boolean>("get_migration_result");
        if (migrated) {
          toast.success(
            t("migration.success", { defaultValue: "配置迁移成功" }),
            { closeButton: true },
          );
        }
      } catch (error) {
        console.error("[App] Failed to check migration result:", error);
      }
    };

    checkMigration();
  }, [t]);

  useEffect(() => {
    const checkSkillsMigration = async () => {
      try {
        const result = await invoke<{ count: number; error?: string } | null>(
          "get_skills_migration_result",
        );
        if (result?.error) {
          toast.error(t("migration.skillsFailed"), {
            description: t("migration.skillsFailedDescription"),
            closeButton: true,
          });
          console.error("[App] Skills SSOT migration failed:", result.error);
          return;
        }
        if (result && result.count > 0) {
          toast.success(t("migration.skillsSuccess", { count: result.count }), {
            closeButton: true,
          });
          await queryClient.invalidateQueries({ queryKey: ["skills"] });
        }
      } catch (error) {
        console.error("[App] Failed to check skills migration result:", error);
      }
    };

    checkSkillsMigration();
  }, [t, queryClient]);

  useEffect(() => {
    const checkEnvOnSwitch = async () => {
      try {
        if (activeApp === "mcode") return;
        const conflicts = await checkEnvConflicts(activeApp);

        if (conflicts.length > 0) {
          setEnvConflicts((prev) => {
            const existingKeys = new Set(
              prev.map((c) => `${c.varName}:${c.sourcePath}`),
            );
            const newConflicts = conflicts.filter(
              (c) => !existingKeys.has(`${c.varName}:${c.sourcePath}`),
            );
            return [...prev, ...newConflicts];
          });
          const dismissed = sessionStorage.getItem("env_banner_dismissed");
          if (!dismissed) {
            setShowEnvBanner(true);
          }
        }
      } catch (error) {
        console.error(
          "[App] Failed to check environment conflicts on app switch:",
          error,
        );
      }
    };

    checkEnvOnSwitch();
  }, [activeApp]);

  const currentViewRef = useRef(currentView);
  const managementBusy = channelNavigationBusy;
  const managementBusyRef = useRef(false);
  managementBusyRef.current = managementBusy;

  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

  // ─── 导航 ───────────────────────────────────────────────────────────────
  // 渠道保存和账户授权等操作期间保持面板挂载。

  // 整页编辑器里有未保存的修改：先确认，确认放弃后再执行这次导航
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const confirmLeave = (proceed: () => void) => {
    if (!hasUnsavedChanges()) return false;
    setPendingLeave(() => proceed);
    return true;
  };

  const openSettings = (
    section: SettingsSection = "general",
    appConfigTarget?: AppId,
  ) => {
    if (managementBusyRef.current) return;
    if (confirmLeave(() => openSettings(section, appConfigTarget))) return;
    if (currentViewRef.current !== "settings") {
      settingsReturnViewRef.current = currentViewRef.current;
    }
    setSettingsSection(section === "routing" ? "general" : section);
    setAppConfigScrollTarget(appConfigTarget);
    setCurrentView("settings");
  };

  const exitSettings = () => {
    setCurrentView(settingsReturnViewRef.current);
  };

  const selectApp = (app: AppId) => {
    if (managementBusyRef.current) return;
    if (confirmLeave(() => selectApp(app))) return;
    setActiveApp(app);
    localStorage.setItem(APP_STORAGE_KEY, app);
    // Legacy client actions now land in the shared channel center.
    setCurrentView(productViewOf("providers"));
  };

  const openPage = (page: GlobalPage | "settings") => {
    if (page === "settings") {
      openSettings("general");
      return;
    }
    if (managementBusyRef.current) return;
    if (confirmLeave(() => openPage(page))) return;
    setCurrentView(productViewOf(page));
  };

  const openUnrealProjectInAgent = (path: string) => {
    const navigate = () => openUnrealProjectInAgent(path);
    if (managementBusyRef.current || confirmLeave(navigate)) return;
    setAgentInitialProjectPath(path);
    setCurrentView("agent");
  };

  useTrayNavigation((navigation) => {
    const navigate = () => {
      if (navigation.section) {
        openSettings(navigation.section);
        return;
      }
      if (!navigation.app) return;
      selectApp(navigation.app);
      // Old tray intents do not reopen the retired provider editor.
    };
    if (managementBusyRef.current || !confirmLeave(navigate)) navigate();
  });

  const openPageFromNav = (page: GlobalPage | "settings") => {
    // 产品更新入口直接定位到关于页。
    if (page === "settings" && hasUpdate) {
      openSettings("about");
      return;
    }
    openPage(page);
  };

  const openSettingsRef = useRef(openSettings);
  openSettingsRef.current = openSettings;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key === ",") {
        event.preventDefault();
        openSettingsRef.current("general");
        return;
      }

      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.body.style.overflow === "hidden") return;
      if (managementBusyRef.current) return;
      if (isTextEditableTarget(event.target)) return;

      const view = currentViewRef.current;
      if (view === "settings") {
        event.preventDefault();
        setCurrentView(settingsReturnViewRef.current);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const handleImportSuccess = async () => {
    try {
      await queryClient.invalidateQueries({
        queryKey: ["providers"],
        refetchType: "all",
      });
      await queryClient.refetchQueries({
        queryKey: ["providers"],
        type: "all",
      });
    } catch (error) {
      console.error("[App] Failed to refresh providers after import", error);
    }
    try {
      await providersApi.updateTrayMenu();
    } catch (error) {
      console.error("[App] Failed to refresh tray menu", error);
    }
  };

  // ─── 全局页 ─────────────────────────────────────────────────────────────

  const renderGlobalPage = () => {
    if (
      isBuiltinApp(currentView) &&
      !builtinApps.data?.some((app) => app.id === currentView && app.enabled)
    ) {
      return <BuiltinApplicationsPage onOpen={openPage} />;
    }
    const productView = productViewOf(currentView);
    switch (productView) {
      case "applications":
        return <BuiltinApplicationsPage onOpen={openPage} />;
      case "agent":
        return (
          <>
            <div id="main-content" className="min-h-0 flex-1 overflow-hidden">
              <AgentPage
                initialProjectPath={agentInitialProjectPath}
                onInitialProjectConsumed={() =>
                  setAgentInitialProjectPath(undefined)
                }
                onOpenChannels={() => openPage("channels")}
                onOpenAbout={() => openSettings("about")}
                onCheckUpdate={() => {
                  void checkUpdate()
                    .then((available) => {
                      if (available) openSettings("about");
                      else toast.success(t("settings.upToDate"));
                    })
                    .catch((error: unknown) => {
                      toast.error(t("settings.checkUpdateFailed"), {
                        description:
                          error instanceof Error
                            ? error.message
                            : String(error),
                      });
                    });
                }}
              />
            </div>
          </>
        );
      case "channels":
      case "auth":
      case "apps":
        return (
          <>
            <AppPageHeader
              title={t("channelCenter.navigation", {
                defaultValue: "渠道与模型",
              })}
              subtitle={t("channelCenter.subtitle", {
                defaultValue: "添加一次，配置到你的 AI 工具",
              })}
            />
            <div
              id="main-content"
              className="min-h-0 flex-1 overflow-y-auto scroll-stable"
            >
              <div className="px-6 pb-10 pt-4">
                <ChannelCenterPanel
                  onNavigationBlockedChange={setChannelNavigationBusy}
                  initialAccountManagerOpen={currentView === "auth"}
                  initialToolsOpen={currentView === "apps"}
                />
              </div>
            </div>
          </>
        );
      case "usage":
        return <SimpleUsagePage />;
      case "tavern":
        return <TavernPage onOpenChannels={() => openPage("channels")} />;
      case "rankings":
      case "free-ai":
        return <DiscoveryPage key={productView} kind={productView} />;
      case "unreal":
        return (
          <UnrealPage
            onOpenChannels={() => openPage("channels")}
            onOpenAgentProject={openUnrealProjectInAgent}
          />
        );
      default:
        return null;
    }
  };

  const renderContent = () => {
    if (currentView === "settings") {
      return (
        <SettingsPage
          section={settingsSection}
          appConfigScrollTarget={appConfigScrollTarget}
          onImportSuccess={handleImportSuccess}
          onOpenApps={() => setCurrentView("apps")}
          onOpenApp={selectApp}
        />
      );
    }
    return renderGlobalPage();
  };

  return (
    <WindowControlsContext.Provider
      value={useAppWindowControls ? <WindowControls /> : null}
    >
      <div className="tai-shell flex h-screen overflow-hidden bg-app text-fg-1 selection:bg-action/25">
        <Sidebar
          activeApp={activeApp}
          view={currentView}
          visibleApps={visibleApps}
          settingsSection={settingsSection}
          onSelectApp={selectApp}
          onSelectPage={openPageFromNav}
          onOpenUpdates={() => openSettings("about")}
          onSelectSettingsSection={(section) => {
            setAppConfigScrollTarget(undefined);
            setSettingsSection(section);
          }}
          onExitSettings={exitSettings}
          appsUpdateAvailable={
            checkToolUpdatesOnStartup && toolUpdatesAvailable
          }
        />
        <main
          ref={mainScrollRef}
          id="content-area"
          data-view={currentView}
          className="tai-main relative isolate flex min-w-0 flex-1 flex-col overflow-hidden bg-app"
        >
          {showEnvBanner && envConflicts.length > 0 && (
            <EnvWarningBanner
              conflicts={envConflicts}
              onDismiss={() => {
                setShowEnvBanner(false);
                sessionStorage.setItem("env_banner_dismissed", "true");
              }}
              onDeleted={async () => {
                try {
                  const allConflicts = await checkAllEnvConflicts();
                  const flatConflicts = Object.values(allConflicts).flat();
                  setEnvConflicts(flatConflicts);
                  if (flatConflicts.length === 0) {
                    setShowEnvBanner(false);
                  }
                } catch (error) {
                  console.error(
                    "[App] Failed to re-check conflicts after deletion:",
                    error,
                  );
                }
              }}
            />
          )}
          <MotionSurface
            motionKey={`${currentView}:${activeApp}:${currentView === "settings" ? settingsSection : ""}`}
            className="tai-page flex min-h-0 flex-1 flex-col"
          >
            {/* Navigation owns business-page identity; motion does not remount it. */}
            <Fragment
              key={currentView === "settings" ? "settings" : currentView}
            >
              {renderContent()}
            </Fragment>
          </MotionSurface>
        </main>
      </div>

      <ConfirmDialog
        isOpen={pendingLeave !== null}
        title={t("common.unsavedLeaveTitle")}
        message={t("common.unsavedLeaveMessage")}
        confirmText={t("common.unsavedLeaveConfirm")}
        cancelText={t("common.unsavedLeaveCancel")}
        zIndex="top"
        onConfirm={() => {
          const proceed = pendingLeave;
          setPendingLeave(null);
          discardUnsavedChanges();
          proceed?.();
        }}
        onCancel={() => setPendingLeave(null)}
      />

      <DeepLinkImportDialog />
      <FirstRunNoticeDialog />
      <WhatsNewNotice />
    </WindowControlsContext.Provider>
  );
}

export default App;
