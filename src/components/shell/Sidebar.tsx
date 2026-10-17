import { type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  BookHeart,
  Bot,
  Boxes,
  ChartColumn,
  Database,
  Folder,
  Globe,
  Info,
  PanelsTopLeft,
  Download,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import { useBuiltinApps } from "@/lib/api/builtin-apps";
import type { AppId } from "@/lib/api";
import type { VisibleApps } from "@/types";
import type { GlobalPage, SettingsSection, View } from "@/lib/navigation";
import { isAppPage } from "@/lib/navigation";
import { useUpdate } from "@/contexts/UpdateContext";
import { useSidebarStatus } from "@/hooks/useSidebarStatus";
import { fmtUsd } from "@/components/usage/format";
import { HoverTip } from "@/components/ui/hover-tip";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE, isMac } from "@/lib/platform";
import { motionTokens } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { SidebarProfileMenu } from "./SidebarProfileMenu";
import { APP_NAME } from "@/lib/branding";

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
          />
        )}
        <div className="tai-shell-footer tai-shell-footer-with-profile">
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
}: DirectoryProps & { todayCost: number; authNeedsAttention: boolean }) {
  const { t, i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const apps = useBuiltinApps();
  const installed = (id: string) =>
    apps.data?.some((app) => app.id === id && app.enabled) === true;
  const workbench = t("channelCenter.navigation", {
    defaultValue: chinese ? "渠道与模型" : "Channels & models",
  });
  return (
    <div className="tai-shell-directory">
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
        {installed("tavern") && (
          <NavItem
            collapsed={collapsed}
            selected={view === "tavern"}
            icon={BookHeart}
            label={t("nav.tavern", {
              defaultValue: chinese ? "酒馆" : "Tavern",
            })}
            compactLabel={chinese ? "酒馆" : "Tavern"}
            onClick={() => onSelectPage("tavern")}
          />
        )}
        {installed("unreal") && (
          <NavItem
            collapsed={collapsed}
            selected={view === "unreal"}
            icon={Boxes}
            label={t("nav.unreal", {
              defaultValue: chinese ? "虚幻工作台" : "Unreal workspace",
            })}
            compactLabel={chinese ? "虚幻" : "Unreal"}
            onClick={() => onSelectPage("unreal")}
          />
        )}
        <NavItem
          collapsed={collapsed}
          selected={view === "applications"}
          icon={Plus}
          label={t("applications.title")}
          compactLabel={chinese ? "应用" : "Apps"}
          onClick={() => onSelectPage("applications")}
        />
      </div>
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
}) {
  const reducedMotion = useReducedMotion();
  const accessibleName = [
    label,
    trailing,
    alert,
    title !== label ? title : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <HoverTip
      content={collapsed ? accessibleName : title}
      side="right"
      disableHoverableContent
    >
      <button
        type="button"
        onClick={onClick}
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
    </HoverTip>
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
          {APP_NAME} v{version}
        </div>
      )}
    </div>
  );
}

export type { SidebarProps };
