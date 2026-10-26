import {
  useId,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  BookHeart,
  Bot,
  Boxes,
  ChartColumn,
  ChartNoAxesCombined,
  ChevronDown,
  Gift,
  Database,
  Folder,
  Globe,
  Info,
  PanelsTopLeft,
  Download,
  Plus,
  Pin,
  PinOff,
  Trash2,
  SlidersHorizontal,
} from "lucide-react";
import {
  BUILTIN_APP_IDS,
  builtinAppsApi,
  builtinAppsKey,
  useBuiltinApps,
  type BuiltinAppId,
  type BuiltinAppState,
} from "@/lib/api/builtin-apps";
import type { AppId } from "@/lib/api";
import type { VisibleApps } from "@/types";
import type { GlobalPage, SettingsSection, View } from "@/lib/navigation";
import { isAppPage } from "@/lib/navigation";
import { useUpdate } from "@/contexts/UpdateContext";
import { useSidebarStatus } from "@/hooks/useSidebarStatus";
import { useSidebarTools } from "@/hooks/useSidebarTools";
import { toast } from "@/lib/toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmtUsd } from "@/components/usage/format";
import { HoverTip } from "@/components/ui/hover-tip";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE, isMac } from "@/lib/platform";
import { motionTokens } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { SidebarProfileMenu } from "./SidebarProfileMenu";
import { APP_NAME } from "@/lib/branding";
import { productVersion } from "@/lib/productVersion";

type IconComponent = ComponentType<{ className?: string }>;

interface SidebarProps {
  activeApp: AppId;
  view: View;
  visibleApps: VisibleApps;
  settingsSection: SettingsSection;
  onSelectApp: (app: AppId) => void;
  onSelectPage: (page: GlobalPage | "settings") => void;
  onSelectSettingsSection: (section: SettingsSection) => void;
  onExitSettings: () => void;
  onOpenUpdates: () => void;
  appsUpdateAvailable?: boolean;
}

type DirectoryProps = SidebarProps & { collapsed: boolean };

/** The client is context; the task navigation keeps the same positions for every client. */
export function Sidebar(props: SidebarProps) {
  const { t, i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const collapsed = true;
  const { todayCost, authNeedsAttention } = useSidebarStatus();
  const { hasUpdate } = useUpdate();
  const tools = useSidebarTools();
  const currentView = useRef(props.view);
  currentView.current = props.view;

  return (
    <nav
      data-collapsed={collapsed}
      aria-label={t("nav.mainLabel")}
      className="tai-shell-sidebar lolicode-global-rail"
    >
      <a href="#main-content" className="tai-shell-skip">
        {t("nav.skipToContent")}
      </a>
      <SidebarTopBar />
      <LayoutGroup id="shell-navigation">
        {props.view === "settings" ? (
          <SettingsDirectory {...props} collapsed={collapsed} />
        ) : (
          <MainDirectory
            {...props}
            collapsed={collapsed}
            todayCost={todayCost}
            authNeedsAttention={authNeedsAttention}
            tools={tools}
            onToolRemoved={(id) => {
              if (currentView.current === id)
                props.onSelectPage("applications");
            }}
          />
        )}
        <div className="tai-shell-footer tai-shell-footer-with-profile">
          <NavItem
            collapsed={collapsed}
            selected={props.view === "applications"}
            icon={Plus}
            label={t("applications.title")}
            compactLabel={chinese ? "应用" : "Apps"}
            onClick={() => props.onSelectPage("applications")}
          />
          <NavItem
            collapsed={collapsed}
            selected={false}
            icon={Download}
            label={t("nav.softwareUpdates", { defaultValue: "软件更新" })}
            compactLabel={chinese ? "更新" : "Updates"}
            title={
              hasUpdate
                ? t("nav.softwareUpdatesAvailable", {
                    defaultValue: "发现 LoliCode 新版本",
                  })
                : undefined
            }
            dot={hasUpdate}
            dotTone="success"
            onClick={props.onOpenUpdates}
          />
          <SidebarProfileMenu
            hasUpdate={hasUpdate}
            selected={props.view === "settings"}
            onOpenSettings={() => props.onSelectPage("settings")}
            onOpenUpdates={props.onOpenUpdates}
          />
        </div>
      </LayoutGroup>
    </nav>
  );
}

function SidebarTopBar() {
  return (
    <div
      className={cn(
        "tai-shell-drag-spacer",
        isMac() && "tai-shell-drag-spacer-mac",
      )}
      {...DRAG_REGION_ATTR}
      style={DRAG_REGION_STYLE as React.CSSProperties}
    >
      <span className="sr-only">{APP_NAME}</span>
    </div>
  );
}

function MainDirectory({
  collapsed,
  view,
  onSelectPage,
  todayCost,
  authNeedsAttention,
  tools,
  onToolRemoved,
}: DirectoryProps & {
  todayCost: number;
  authNeedsAttention: boolean;
  tools: ReturnType<typeof useSidebarTools>;
  onToolRemoved: (id: BuiltinAppId) => void;
}) {
  const { t, i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const apps = useBuiltinApps();
  const client = useQueryClient();
  const toolsId = useId();
  const directoryRef = useRef<HTMLDivElement>(null);
  const [removing, setRemoving] = useState<BuiltinAppId | null>(null);
  const installed = (id: BuiltinAppId) =>
    apps.data?.some((app) => app.id === id && app.enabled) === true;
  const pinned = tools.pinned.filter(installed);
  const others = BUILTIN_APP_IDS.filter(
    (id) => installed(id) && !pinned.includes(id),
  );
  const focusTool = (id: BuiltinAppId) => {
    const directory = directoryRef.current;
    const tool = directory?.querySelector<HTMLButtonElement>(
      `[data-sidebar-tool="${id}"]`,
    );
    (
      (tool && !tool.closest("[hidden]") ? tool : null) ??
      directory?.querySelector<HTMLButtonElement>(".tai-shell-tools-toggle") ??
      directory?.querySelector<HTMLButtonElement>(".tai-shell-nav-item")
    )?.focus();
  };
  const removeTool = async (id: BuiltinAppId) => {
    if (removing) return;
    setRemoving(id);
    try {
      await builtinAppsApi.setEnabled(id, false);
      await client.cancelQueries({ queryKey: builtinAppsKey });
      client.setQueryData<BuiltinAppState[]>(builtinAppsKey, (current) =>
        current?.map((app) =>
          app.id === id ? { ...app, enabled: false } : app,
        ),
      );
      tools.unpin(id);
      onToolRemoved(id);
      await client.invalidateQueries({ queryKey: builtinAppsKey });
      requestAnimationFrame(() => focusTool(id));
    } catch (error) {
      toast.error(t("applications.changeFailed"), {
        description: String(error),
      });
    } finally {
      setRemoving(null);
    }
  };
  const renderTool = (id: BuiltinAppId) => {
    const meta = {
      tavern: { icon: BookHeart, short: ["酒馆", "Tavern"] },
      unreal: { icon: Boxes, short: ["虚幻", "Unreal"] },
      rankings: { icon: ChartNoAxesCombined, short: ["榜单", "Rankings"] },
      "free-ai": { icon: Gift, short: ["免费 AI", "Free AI"] },
    }[id];
    const label = t(
      id === "tavern" || id === "unreal"
        ? `nav.${id}`
        : `applications.${id}.title`,
    );
    const isPinned = pinned.includes(id);
    return (
      <NavItem
        key={id}
        toolId={id}
        collapsed={collapsed}
        selected={view === id}
        icon={meta.icon}
        label={label}
        compactLabel={meta.short[chinese ? 0 : 1]}
        pinned={isPinned}
        onClick={() => onSelectPage(id)}
        onMenuClose={() => focusTool(id)}
        contextMenu={
          <>
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            <DropdownMenuItem
              disabled={removing !== null}
              onSelect={() => tools.togglePinned(id)}
            >
              {isPinned ? <PinOff size={14} /> : <Pin size={14} />}
              {t(isPinned ? "nav.unpinTool" : "nav.pinTool")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={removing !== null}
              onSelect={() => void removeTool(id)}
            >
              <Trash2 size={14} />
              {t("nav.removeTool")}
            </DropdownMenuItem>
            <p className="max-w-48 px-2.5 py-1.5 text-xs text-fg-3">
              {t("nav.removeToolHint")}
            </p>
          </>
        }
      />
    );
  };
  const workbench = t("channelCenter.navigation", {
    defaultValue: chinese ? "渠道与模型" : "Channels & models",
  });
  return (
    <div ref={directoryRef} className="tai-shell-directory">
      <div
        role="group"
        aria-label={t("nav.appsGroup")}
        className="tai-shell-task-group"
      >
        <NavItem
          collapsed={collapsed}
          selected={view === "agent"}
          icon={Bot}
          label={chinese ? "编程工作台" : "Coding workspace"}
          compactLabel={chinese ? "工作台" : "Studio"}
          onClick={() => onSelectPage("agent")}
        />
        {pinned.length > 0 && (
          <div
            role="group"
            aria-label={t("nav.pinnedTools")}
            className="tai-shell-task-group"
          >
            {pinned.map(renderTool)}
          </div>
        )}
      </div>
      {(pinned.length > 0 || others.length > 0) && (
        <div className="tai-shell-tools-section">
          <button
            type="button"
            className="tai-shell-tools-toggle"
            aria-label={t(
              tools.collapsed ? "nav.expandTools" : "nav.collapseTools",
            )}
            aria-expanded={!tools.collapsed}
            aria-controls={toolsId}
            data-selected={tools.collapsed && others.some((id) => id === view)}
            onClick={tools.toggleCollapsed}
          >
            <span>{t("nav.tools")}</span>
            <ChevronDown
              aria-hidden="true"
              size={12}
              className={tools.collapsed ? "-rotate-90" : undefined}
            />
          </button>
          <div id={toolsId} hidden={tools.collapsed}>
            <div
              role="group"
              aria-label={t("nav.tools")}
              className="tai-shell-task-group"
            >
              {others.map(renderTool)}
            </div>
          </div>
        </div>
      )}
      <div role="group" aria-label={workbench} className="tai-shell-task-group">
        <NavItem
          collapsed={collapsed}
          selected={
            view === "channels" ||
            view === "auth" ||
            view === "apps" ||
            isAppPage(view)
          }
          icon={PanelsTopLeft}
          label={workbench}
          compactLabel={chinese ? "模型" : "Models"}
          alert={authNeedsAttention ? t("nav.authNeedsReauth") : undefined}
          onClick={() => onSelectPage("channels")}
        />
        <NavItem
          collapsed={collapsed}
          selected={view === "usage"}
          icon={ChartColumn}
          label={t("nav.usage")}
          compactLabel={chinese ? "用量" : "Usage"}
          trailing={todayCost > 0 ? fmtUsd(todayCost, 2) : undefined}
          title={
            todayCost > 0
              ? t("nav.todayCost", { cost: fmtUsd(todayCost, 2) })
              : undefined
          }
          onClick={() => onSelectPage("usage")}
        />
      </div>
    </div>
  );
}

function NavItem({
  collapsed,
  selected,
  icon: Icon,
  label,
  compactLabel,
  title,
  trailing,
  alert,
  dot,
  dotTone = "neutral",
  onClick,
  indicator = "task-selection",
  contextMenu,
  onMenuClose,
  toolId,
  pinned,
}: {
  collapsed: boolean;
  selected: boolean;
  icon: IconComponent;
  label: string;
  compactLabel?: string;
  title?: string;
  trailing?: string;
  alert?: string;
  dot?: boolean;
  dotTone?: "neutral" | "success";
  onClick: () => void;
  indicator?: string;
  contextMenu?: ReactNode;
  onMenuClose?: () => void;
  toolId?: BuiltinAppId;
  pinned?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const [menuOpen, setMenuOpen] = useState(false);
  const accessibleName = [
    label,
    trailing,
    alert,
    title !== label ? title : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const button = (
    <button
      type="button"
      onClick={onClick}
      data-sidebar-tool={toolId}
      data-pinned={pinned || undefined}
      onContextMenu={
        contextMenu
          ? (event) => {
              event.preventDefault();
              setMenuOpen(true);
            }
          : undefined
      }
      aria-label={accessibleName}
      aria-current={selected ? "page" : undefined}
      className="tai-shell-nav-item"
    >
      {selected && (
        <motion.span
          aria-hidden="true"
          className="tai-shell-selection"
          layoutId={indicator}
          transition={reducedMotion ? { duration: 0 } : motionTokens.spring}
        />
      )}
      <span className="tai-shell-nav-glyph" aria-hidden="true">
        <Icon className="h-[18px] w-[18px]" />
        {pinned && <Pin aria-hidden="true" className="tai-shell-tool-pin" />}
        {(dot || (collapsed && alert)) && (
          <span
            className={cn(
              "tai-shell-notice",
              alert ? "is-alert" : dotTone === "success" && "is-update",
            )}
          />
        )}
      </span>
      {collapsed && compactLabel && (
        <span className="tai-shell-nav-compact-label" aria-hidden="true">
          {compactLabel}
        </span>
      )}
      {!collapsed && (
        <>
          <span className="tai-shell-nav-label">{label}</span>
          {trailing && (
            <span className="tai-shell-nav-trailing">{trailing}</span>
          )}
          {alert && (
            <span
              role="img"
              aria-label={alert}
              className="tai-shell-alert-dot"
            />
          )}
        </>
      )}
    </button>
  );
  const target = contextMenu ? (
    <DropdownMenuTrigger
      asChild
      onPointerDown={(event) => {
        // Left click navigates; right click and keyboard menu gestures manage tools.
        if (event.button === 0) {
          event.preventDefault();
          event.currentTarget.focus();
        }
      }}
      onKeyDown={(event) => {
        if (
          event.key === "ContextMenu" ||
          (event.shiftKey && event.key === "F10")
        ) {
          event.preventDefault();
          setMenuOpen(true);
        } else if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
    >
      {button}
    </DropdownMenuTrigger>
  ) : (
    button
  );
  const item = (
    <HoverTip
      content={collapsed ? accessibleName : title}
      side="right"
      disableHoverableContent
    >
      {target}
    </HoverTip>
  );
  return contextMenu ? (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
      {item}
      <DropdownMenuContent
        side="right"
        align="start"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onMenuClose?.();
        }}
      >
        {contextMenu}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    item
  );
}

const SETTINGS_ITEMS: {
  section: SettingsSection;
  icon: IconComponent;
  compactLabel: [string, string];
}[] = [
  {
    section: "general",
    icon: SlidersHorizontal,
    compactLabel: ["通用", "General"],
  },
  { section: "appConfig", icon: Folder, compactLabel: ["配置", "Config"] },
  { section: "network", icon: Globe, compactLabel: ["网络", "Network"] },
  { section: "data", icon: Database, compactLabel: ["数据", "Data"] },
  { section: "about", icon: Info, compactLabel: ["关于", "About"] },
];

function SettingsDirectory({
  collapsed,
  settingsSection,
  onSelectSettingsSection,
  onExitSettings,
}: DirectoryProps) {
  const { t, i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const { hasUpdate } = useUpdate();
  const { data: version } = useQuery({
    queryKey: ["app-version"],
    queryFn: () => getVersion(),
    staleTime: Infinity,
  });
  return (
    <div className="tai-shell-directory">
      <NavItem
        collapsed={collapsed}
        selected={false}
        icon={ArrowLeft}
        label={t("nav.back")}
        compactLabel={chinese ? "返回" : "Back"}
        onClick={onExitSettings}
      />
      <div
        role="group"
        aria-label={t("nav.settings")}
        className="tai-shell-task-group"
      >
        {!collapsed && (
          <div className="tai-shell-caption">{t("nav.settings")}</div>
        )}
        {SETTINGS_ITEMS.map(({ section, icon, compactLabel }) => (
          <NavItem
            key={section}
            collapsed={collapsed}
            selected={settingsSection === section}
            icon={icon}
            label={t(`settings.sections.${section}`)}
            compactLabel={compactLabel[chinese ? 0 : 1]}
            indicator="settings-selection"
            dot={section === "about" && hasUpdate}
            dotTone="success"
            title={
              section === "about" && hasUpdate
                ? t("nav.settingsHasUpdate")
                : undefined
            }
            onClick={() => onSelectSettingsSection(section)}
          />
        ))}
      </div>
      {!collapsed && version && (
        <div className="tai-shell-version">
          {APP_NAME} v{productVersion(version)}
        </div>
      )}
    </div>
  );
}

export type { SidebarProps };
