import { type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  Bot,
  ChartColumn,
  Database,
  Folder,
  Globe,
  Info,
  LayoutGrid,
  PanelsTopLeft,
  Download,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
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
import { LolicodeMark } from "./LolicodeMark";
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
  const { t } = useTranslation();
  const collapsed = true;
  const { todayCost, authNeedsAttention } = useSidebarStatus();
  const { hasUpdate } = useUpdate();

  return (
    <nav
      data-collapsed={collapsed}
      aria-label={t("nav.mainLabel")}
      className="tai-shell-sidebar lolicode-global-rail"
      style={{ width: 56 }}
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
        <div className="tai-shell-footer">
          <NavItem
            collapsed={collapsed}
            selected={false}
            icon={Download}
            label={t("nav.softwareUpdates", { defaultValue: "软件更新" })}
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
          <NavItem
            collapsed={collapsed}
            selected={props.view === "apps"}
            icon={LayoutGrid}
            label={t("nav.apps")}
            title={
              props.appsUpdateAvailable
                ? t("nav.appsHasUpdate")
                : t("nav.appsTitle")
            }
            dot={props.appsUpdateAvailable}
            onClick={() => props.onSelectPage("apps")}
          />
          <NavItem
            collapsed={collapsed}
            selected={props.view === "settings"}
            icon={Settings}
            label={t("nav.settings")}
            title={hasUpdate ? t("nav.settingsHasUpdate") : undefined}
            dot={hasUpdate}
            dotTone="success"
            onClick={() => props.onSelectPage("settings")}
          />
        </div>
      </LayoutGroup>
    </nav>
  );
}

function SidebarTopBar() {
  return (
    <div
      className={cn("tai-shell-brand", isMac() && "tai-shell-brand-mac")}
      {...DRAG_REGION_ATTR}
      style={DRAG_REGION_STYLE as React.CSSProperties}
    >
      <div className="tai-shell-brand-lockup" {...DRAG_REGION_ATTR}>
        <LolicodeMark className="tai-shell-mark" />
        <span className="sr-only">{APP_NAME}</span>
      </div>
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
  const workbench = t("channelCenter.navigation", {
    defaultValue: chinese ? "渠道与模型" : "Channels & models",
  });
  return (
    <div className="tai-shell-directory">
      <div role="group" aria-label={workbench} className="tai-shell-task-group">
        <NavItem
          collapsed={collapsed}
          selected={view === "agent"}
          icon={Bot}
          label={chinese ? "编程工作台" : "Coding workspace"}
          onClick={() => onSelectPage("agent")}
        />
        <NavItem
          collapsed={collapsed}
          selected={view === "channels" || view === "auth" || isAppPage(view)}
          icon={PanelsTopLeft}
          label={workbench}
          alert={authNeedsAttention ? t("nav.authNeedsReauth") : undefined}
          onClick={() => onSelectPage("channels")}
        />
        <NavItem
          collapsed={collapsed}
          selected={view === "usage"}
          icon={ChartColumn}
          label={t("nav.usage")}
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

const SETTINGS_ITEMS: { section: SettingsSection; icon: IconComponent }[] = [
  { section: "general", icon: SlidersHorizontal },
  { section: "appConfig", icon: Folder },
  { section: "network", icon: Globe },
  { section: "data", icon: Database },
  { section: "about", icon: Info },
];

function SettingsDirectory({
  collapsed,
  settingsSection,
  onSelectSettingsSection,
  onExitSettings,
}: DirectoryProps) {
  const { t } = useTranslation();
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
        {SETTINGS_ITEMS.map(({ section, icon }) => (
          <NavItem
            key={section}
            collapsed={collapsed}
            selected={settingsSection === section}
            icon={icon}
            label={t(`settings.sections.${section}`)}
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
