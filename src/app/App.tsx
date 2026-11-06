import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DeepLinkImportDialog } from "@/components/DeepLinkImportDialog";
import { FirstRunNoticeDialog } from "@/components/FirstRunNoticeDialog";
import { WhatsNewNotice } from "@/components/WhatsNewDialog";
import { AgentPage } from "@/features/agent/AgentPage";
import { AgentCompanion } from "@/features/agent/AgentCompanion";
import type { SecretaryOpenTarget } from "@/hooks/useSecretaryActivity";
import type { AgentTool, AgentToolTab } from "@/features/agent/AgentToolPanel";
import { LayoutGroup } from "framer-motion";
import { BuiltinApplicationsPage } from "@/features/apps/BuiltinApplicationsPage";
import { isBuiltinApp, useBuiltinApps } from "@/lib/api/builtin-apps";
import { DiscoveryPage } from "@/features/discovery/DiscoveryPage";
import { TavernPage } from "@/features/tavern/TavernPage";
import { UnrealPage } from "@/features/unreal/UnrealPage";
import {
  checkToolUpdatesInBackground,
  useToolUpdatesAvailable,
} from "@/features/apps/useToolManagement";
import { ChannelCenterPanel } from "@/features/channels/ChannelCenterPanel";
import { EnvWarningBanner } from "@/features/env/EnvWarningBanner";
import { MotionSurface } from "@/components/motion/MotionSurface";
import { useWorkspaceEntryMotion } from "@/components/motion/useWorkspaceEntryMotion";
import { SettingsPage } from "@/features/settings/SettingsPage";
import {
  AppPageHeader,
  PageBackContext,
  WindowControlsContext,
} from "@/app/shell/AppPageHeader";
import {
  Sidebar,
  TavernNavigationSidebar,
  type SidebarProps,
} from "@/app/shell/Sidebar";
import { WindowControls } from "@/app/shell/WindowControls";
import { SimpleUsagePage } from "@/features/usage/SimpleUsagePage";
import { LolicodeAllowancePage } from "@/features/usage/LolicodeAllowancePage";
import { APP_IDS, DEFAULT_VISIBLE_APPS } from "@/config/appConfig";
import { useUpdate } from "@/contexts/UpdateContext";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useTrayNavigation } from "@/hooks/useTrayNavigation";
import { useUsageCacheBridge } from "@/hooks/useUsageCacheBridge";
import { providersApi, type AppId } from "@/lib/api";
import { checkAllEnvConflicts, checkEnvConflicts } from "@/lib/api/env";
import { proxyApi } from "@/lib/api/proxy";
import { tavernSnapshotQuery } from "@/lib/api/tavern";
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
import { cn } from "@/lib/utils";
import type { VisibleApps } from "@/types";
import type { EnvConflict } from "@/types/env";
import { isTextEditableTarget } from "@/utils/domUtils";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Fragment,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

type WorkspaceMode = "agent" | "tavern";

function WorkspaceModes({
  mode,
  agent,
  tavern,
  warmTavern,
}: {
  mode: WorkspaceMode;
  agent: ReactNode;
  tavern: ReactNode;
  warmTavern: boolean;
}) {
  const queryClient = useQueryClient();
  const surface = useRef<HTMLDivElement>(null);
  useWorkspaceEntryMotion(
    surface,
    mode,
    "[data-workspace-active] [data-workspace-entry]",
  );
  const [visited, setVisited] = useState(() => ({
    agent: mode === "agent",
    tavern: mode === "tavern",
  }));
  if (!visited[mode]) setVisited({ ...visited, [mode]: true });
  useEffect(() => {
    if (mode !== "agent" || visited.tavern || !warmTavern) return;
    const prepare = () => {
      void queryClient.prefetchQuery(tavernSnapshotQuery);
      startTransition(() =>
        setVisited((current) =>
          current.tavern ? current : { ...current, tavern: true },
        ),
      );
    };
    if (typeof window.requestIdleCallback === "function") {
      const task = window.requestIdleCallback(prepare);
      return () => window.cancelIdleCallback(task);
    }
    const timer = setTimeout(prepare, 80);
    return () => clearTimeout(timer);
  }, [mode, queryClient, visited.tavern, warmTavern]);
  const pages = { agent, tavern };
  return (
    <div
      ref={surface}
      className="tai-page relative flex min-h-0 flex-1 flex-col"
    >
      {(["agent", "tavern"] as const).map((view) => {
        if (!visited[view]) return null;
        const active = mode === view;
        return (
          <div
            key={view}
            id={active && view === "agent" ? "main-content" : undefined}
            data-workspace-active={active || undefined}
            aria-hidden={!active || undefined}
            ref={(node) => {
              if (node) node.inert = !active;
            }}
            className={cn(
              "min-h-0 flex-1",
              view === "agent" ? "overflow-hidden" : "flex flex-col",
              !active && "pointer-events-none absolute inset-0",
              // The Tavern rail sits outside this container. Keep Agent's
              // original width while parked so returning can reuse its layout.
              !active &&
                (view === "agent"
                  ? "w-screen opacity-0"
                  : "invisible [content-visibility:hidden]"),
            )}
          >
            {pages[view]}
          </div>
        );
      })}
    </div>
  );
}

function App() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { hasUpdate, checkUpdate } = useUpdate();
  const builtinApps = useBuiltinApps();
  const tavernEnabled = builtinApps.data?.some(
    (app) => app.id === "tavern" && app.enabled,
  );

  const [activeApp, setActiveApp] = useState<AppId>(getInitialApp);
  const [{ currentView, previousView }, setView] = useState<{
    currentView: View;
    previousView?: View;
  }>(() => ({ currentView: readStoredView() }));
  const setCurrentView = useCallback((nextView: View) => {
    setView((view) =>
      view.currentView === nextView
        ? view
        : { currentView: nextView, previousView: view.currentView },
    );
  }, []);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [appConfigScrollTarget, setAppConfigScrollTarget] = useState<AppId>();
  // 进设置前停留的页面：设置目录里的「← 返回」回到这里
  const settingsReturnViewRef = useRef<View>("agent");
  const pageReturnViewRef = useRef<View>("agent");
  const allowanceReturnViewRef = useRef<View>("agent");
  const [channelNavigationBusy, setChannelNavigationBusy] = useState(false);
  const [agentInitialProjectPath, setAgentInitialProjectPath] =
    useState<string>();
  const [secretaryRequest, setSecretaryRequest] = useState<{
    requestId: number;
    sessionId?: string;
    projectPath?: string;
    workerSessionId?: string;
  }>();
  const secretaryRequestSequence = useRef(0);
  useEffect(() => {
    // A pet navigation intent belongs to this visit. Leaving the workspace
    // must not replay a slow, unconsumed request on a later ordinary visit.
    if (currentView !== "agent" && secretaryRequest)
      setSecretaryRequest(undefined);
  }, [currentView, secretaryRequest]);
  const [agentToolRequest, setAgentToolRequest] = useState<{
    tool: AgentTool | null;
    id: number;
    initialTab?: AgentToolTab;
  }>();
  const [activeAgentTool, setActiveAgentTool] = useState<AgentTool | null>(
    null,
  );
  const [tavernCharacterId, setTavernCharacterId] = useState<string | null>(
    null,
  );
  const [workspaceSidebarCompact, setWorkspaceSidebarCompact] = useState(false);
  const sidebarModePosition = useRef<number>();
  const agentPreviewVisible = useRef(false);
  const rememberAgentPreview = useCallback((visible: boolean) => {
    agentPreviewVisible.current = visible;
  }, []);

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
    if (managementBusyRef.current || confirmLeave(exitSettings)) return;
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

  const openPage = (page: View, returning = false) => {
    if (page === "settings") {
      openSettings("general");
      return;
    }
    if (managementBusyRef.current) return;
    if (confirmLeave(() => openPage(page, returning))) return;
    setSecretaryRequest(undefined);
    const destination = productViewOf(page);
    const origin = currentViewRef.current;
    if (destination !== origin) {
      if (destination === "allowance") allowanceReturnViewRef.current = origin;
      pageReturnViewRef.current = returning
        ? "agent"
        : origin === "settings"
          ? settingsReturnViewRef.current
          : origin;
    }
    setActiveAgentTool(null);
    setAgentToolRequest((previous) =>
      activeAgentTool || previous?.tool
        ? { tool: null, id: (previous?.id ?? 0) + 1 }
        : previous,
    );
    setCurrentView(destination);
  };

  const backToPreviousPage = () => {
    const previous = pageReturnViewRef.current;
    openPage(previous === currentViewRef.current ? "agent" : previous, true);
  };

  const exitAllowance = () => {
    if (managementBusyRef.current) return;
    if (confirmLeave(exitAllowance)) return;
    setCurrentView(allowanceReturnViewRef.current);
  };

  const openUnrealProjectInAgent = (path: string) => {
    const navigate = () => openUnrealProjectInAgent(path);
    if (managementBusyRef.current || confirmLeave(navigate)) return;
    setSecretaryRequest(undefined);
    setActiveAgentTool(null);
    setAgentToolRequest((previous) => ({
      tool: null,
      id: (previous?.id ?? 0) + 1,
    }));
    setAgentInitialProjectPath(path);
    setCurrentView("agent");
  };

  const openAgentTool = (tool: AgentTool, initialTab?: AgentToolTab) => {
    if (managementBusyRef.current) return;
    if (confirmLeave(() => openAgentTool(tool, initialTab))) return;
    setSecretaryRequest(undefined);
    setActiveAgentTool(tool);
    setCurrentView("agent");
    setAgentToolRequest((previous) => ({
      tool,
      initialTab,
      id: (previous?.id ?? 0) + 1,
    }));
  };

  const openSecretaryFromCompanion = (target?: SecretaryOpenTarget) => {
    if (
      managementBusyRef.current ||
      confirmLeave(() => openSecretaryFromCompanion(target))
    )
      return;
    setActiveAgentTool(null);
    setAgentToolRequest((previous) => ({
      tool: null,
      id: (previous?.id ?? 0) + 1,
    }));
    setAgentInitialProjectPath(undefined);
    setSecretaryRequest({
      ...target,
      requestId: ++secretaryRequestSequence.current,
    });
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
  const exitSettingsRef = useRef(exitSettings);
  exitSettingsRef.current = exitSettings;
  const exitAllowanceRef = useRef(exitAllowance);
  exitAllowanceRef.current = exitAllowance;

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
        exitSettingsRef.current();
      } else if (view === "allowance") {
        event.preventDefault();
        exitAllowanceRef.current();
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

  const renderSidebar = (
    slots: Pick<
      SidebarProps,
      | "embedded"
      | "workspaceActions"
      | "workspaceContent"
      | "onCollapse"
      | "sidebarCompact"
    > = {},
    view = currentView,
  ) => {
    const props: SidebarProps = {
      ...slots,
      workspaceModePosition:
        view === currentView ? sidebarModePosition : undefined,
      workspaceModeSwitch:
        view === currentView &&
        ((view === "agent" && previousView === "tavern") ||
          (view === "tavern" && previousView === "agent")),
      sidebarCompact:
        slots.sidebarCompact ??
        ((view === "agent" || view === "tavern") && workspaceSidebarCompact),
      onOpenAgentTool: openAgentTool,
      activeAgentTool: view === "agent" ? activeAgentTool : null,
      selectedTavernCharacterId: tavernCharacterId,
      onSelectTavernCharacter: setTavernCharacterId,
      tavernEnabled: tavernEnabled === true,
      activeApp,
      view,
      visibleApps,
      settingsSection,
      onSelectApp: selectApp,
      onSelectPage: openPageFromNav,
      onOpenUpdates: () => openSettings("about"),
      onSelectSettingsSection: openSettings,
      onExitSettings: exitSettings,
      appsUpdateAvailable: checkToolUpdatesOnStartup && toolUpdatesAvailable,
    };
    return view === "tavern" ? (
      <TavernNavigationSidebar
        {...props}
        onCollapse={() => setWorkspaceSidebarCompact((value) => !value)}
        reservePreviewSpace={agentPreviewVisible.current}
      />
    ) : (
      <Sidebar {...props} />
    );
  };

  const renderAgentPage = (isActive: boolean) => (
    <AgentPage
      isActive={isActive}
      sidebarCompact={workspaceSidebarCompact}
      onSidebarCompactChange={setWorkspaceSidebarCompact}
      onPreviewVisibilityChange={rememberAgentPreview}
      renderSidebar={({ actions, workspace, onCollapse, compact }) =>
        renderSidebar(
          {
            embedded: true,
            workspaceActions: actions,
            workspaceContent: workspace,
            onCollapse,
            sidebarCompact: compact,
          },
          "agent",
        )
      }
      onWorkspaceNavigate={(action) => {
        if (managementBusyRef.current || confirmLeave(action)) return;
        action();
      }}
      toolRequest={isActive ? agentToolRequest : undefined}
      onToolRequestConsumed={() => setAgentToolRequest(undefined)}
      onActiveToolChange={setActiveAgentTool}
      initialProjectPath={agentInitialProjectPath}
      secretaryRequest={secretaryRequest}
      onSecretaryRequestConsumed={() => setSecretaryRequest(undefined)}
      onInitialProjectConsumed={() => setAgentInitialProjectPath(undefined)}
      onOpenChannels={() => openSettings("models")}
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
                error instanceof Error ? error.message : String(error),
            });
          });
      }}
    />
  );

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
      case "allowance":
        return <LolicodeAllowancePage onBack={exitAllowance} />;
      case "rankings":
      case "free-ai":
        return <DiscoveryPage key={productView} kind={productView} />;
      case "unreal":
        return (
          <UnrealPage
            onOpenChannels={() => openSettings("models")}
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
          onOpenApps={() => openPage("apps")}
          onOpenApp={selectApp}
          onChannelNavigationBlockedChange={setChannelNavigationBusy}
        />
      );
    }
    return renderGlobalPage();
  };

  return (
    <WindowControlsContext.Provider
      value={useAppWindowControls ? <WindowControls /> : null}
    >
      <PageBackContext.Provider
        value={
          currentView === "agent" ||
          currentView === "settings" ||
          currentView === "tavern"
            ? null
            : backToPreviousPage
        }
      >
        <LayoutGroup id="desktop-navigation">
          <div className="tai-shell lolicode-refreshed-shell flex h-screen overflow-hidden bg-app text-fg-1 selection:bg-action/25">
            {currentView !== "agent" && renderSidebar()}
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
              {currentView === "agent" || currentView === "tavern" ? (
                <WorkspaceModes
                  mode={currentView}
                  agent={renderAgentPage(currentView === "agent")}
                  warmTavern={tavernEnabled === true}
                  tavern={
                    tavernEnabled ? (
                      <TavernPage
                        isActive={currentView === "tavern"}
                        characterId={tavernCharacterId}
                        onCharacterChange={setTavernCharacterId}
                        onOpenChannels={() => openSettings("models")}
                      />
                    ) : currentView === "tavern" ? (
                      <BuiltinApplicationsPage onOpen={openPage} />
                    ) : null
                  }
                />
              ) : (
                <MotionSurface
                  motionKey={`${currentView}:${activeApp}:${currentView === "settings" ? settingsSection : ""}`}
                  className="tai-page flex min-h-0 flex-1 flex-col"
                >
                  <Fragment key={currentView}>{renderContent()}</Fragment>
                </MotionSurface>
              )}
            </main>
          </div>
        </LayoutGroup>
      </PageBackContext.Provider>
      <AgentCompanion onOpenSecretary={openSecretaryFromCompanion} />

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
