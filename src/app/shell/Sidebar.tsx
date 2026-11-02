import { useId, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  Blocks,
  Brain,
  ChartColumn,
  Database,
  Download,
  Folder,
  Globe,
  Grid2X2,
  Info,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  SlidersHorizontal,
  Workflow,
} from "lucide-react";
import { isBuiltinApp } from "@/lib/api/builtin-apps";
import type { AppId } from "@/lib/api";
import type { VisibleApps } from "@/types";
import type { GlobalPage, SettingsSection, View } from "@/lib/navigation";
import { isAppPage } from "@/lib/navigation";
import { useUpdate } from "@/contexts/UpdateContext";
import { useSidebarStatus } from "@/hooks/useSidebarStatus";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fmtUsd } from "@/features/usage/format";
import { HoverTip } from "@/components/ui/hover-tip";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE, isMac } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { motionTokens } from "@/lib/motion";
import { SidebarProfileMenu } from "./SidebarProfileMenu";
import { APP_NAME } from "@/lib/branding";
import { WorkspaceGlyph } from "./WorkspaceGlyph";
import type { AgentTool, AgentToolTab } from "@/features/agent/AgentToolPanel";
import "./unified-sidebar.css";

type IconComponent = ComponentType<{ className?: string }>;
const ModelsGlyph: IconComponent = (props) => (
  <WorkspaceGlyph kind="models" {...props} />
);
const ChatGlyph: IconComponent = (props) => (
  <WorkspaceGlyph kind="chat" {...props} />
);
const AutomationGlyph: IconComponent = (props) => (
  <WorkspaceGlyph kind="automation" {...props} />
);
const PluginsGlyph: IconComponent = (props) => (
  <WorkspaceGlyph kind="plugins" {...props} />
);

interface SidebarProps {
  embedded?: boolean;
  workspaceActions?: ReactNode;
  workspaceContent?: ReactNode;
  onCollapse?: () => void;
  onOpenAgentTool?: (tool: AgentTool, initialTab?: AgentToolTab) => void;
  activeAgentTool?: AgentTool | null;
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

/** The same navigation surrounds the workspace tree and other application pages. */
export function Sidebar(props: SidebarProps) {
  const { t, i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const status = useSidebarStatus();
  const { hasUpdate } = useUpdate();

  return (
    <LayoutGroup id="unified-sidebar">
      <nav
        data-collapsed="false"
        data-embedded={Boolean(props.embedded)}
        aria-label={t("nav.mainLabel")}
        className="lolicode-unified-sidebar"
      >
        <a href="#main-content" className="tai-shell-skip">
          {t("nav.skipToContent")}
        </a>
        <div
          className={cn("lolicode-sidebar-brand", isMac() && "is-mac")}
          {...DRAG_REGION_ATTR}
          style={DRAG_REGION_STYLE as React.CSSProperties}
        >
          <span className="lolicode-sidebar-wordmark" aria-label={APP_NAME}>
            Loli<span>code</span>
            <i aria-hidden="true" />
          </span>
          {props.onCollapse && (
            <HoverTip
              content={chinese ? "收起侧栏" : "Collapse sidebar"}
              side="right"
            >
              <button
                type="button"
                className="lolicode-sidebar-icon-button"
                aria-label={chinese ? "收起侧栏" : "Collapse sidebar"}
                onClick={props.onCollapse}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <PanelLeftClose aria-hidden="true" />
              </button>
            </HoverTip>
          )}
        </div>
        {props.view === "settings" ? (
          <SettingsDirectory {...props} />
        ) : (
          <MainDirectory {...props} {...status} />
        )}
        <div className="lolicode-sidebar-footer">
          <div className="lolicode-sidebar-account">
            <SidebarProfileMenu
              expanded
              hasUpdate={hasUpdate}
              selected={props.view === "settings"}
              onOpenSettings={() => props.onSelectPage("settings")}
              onOpenUpdates={props.onOpenUpdates}
              onOpenAllowance={() => props.onSelectPage("allowance")}
            />
          </div>
          <MoreMenu {...props} {...status} hasUpdate={hasUpdate} />
        </div>
      </nav>
    </LayoutGroup>
  );
}

function MainDirectory({
  view,
  onSelectPage,
  authNeedsAttention,
  onOpenAgentTool,
  activeAgentTool,
  workspaceActions,
  workspaceContent,
}: SidebarProps & ReturnType<typeof useSidebarStatus>) {
  const { t, i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const channels = t("channelCenter.navigation", {
    defaultValue: chinese ? "渠道与模型" : "Channels & models",
  });
  return (
    <>
      <div
        role="group"
        aria-label={chinese ? "主要导航" : "Main navigation"}
        className="lolicode-sidebar-segments"
      >
        <NavItem
          selected={
            view === "channels" ||
            view === "auth" ||
            view === "apps" ||
            isAppPage(view)
          }
          icon={ModelsGlyph}
          selectionLayout="mode-selection"
          label={channels}
          visibleLabel={chinese ? "模型" : "Models"}
          alert={authNeedsAttention ? t("nav.authNeedsReauth") : undefined}
          onClick={() => onSelectPage("channels")}
        />
        <NavItem
          selected={view === "agent"}
          icon={ChatGlyph}
          selectionLayout="mode-selection"
          label={chinese ? "编程工作台" : "Coding workspace"}
          visibleLabel={chinese ? "对话" : "Chat"}
          onClick={() => onSelectPage("agent")}
        />
      </div>
      <div className="lolicode-sidebar-actions">
        {workspaceActions ?? (
          <button
            type="button"
            className="lolicode-sidebar-new-chat"
            onClick={() => onSelectPage("agent")}
          >
            <Plus aria-hidden="true" />
            {chinese ? "开始对话" : "Start a chat"}
          </button>
        )}
      </div>
      <div className="lolicode-sidebar-workspaces">{workspaceContent}</div>
      <div
        className="lolicode-sidebar-shortcuts"
        role="group"
        aria-label={chinese ? "工作台工具" : "Workspace tools"}
      >
        <NavItem
          selected={view === "agent" && activeAgentTool === "workflows"}
          icon={AutomationGlyph}
          label={chinese ? "自动化" : "Automation"}
          title={chinese ? "自动化" : "Automation"}
          disabled={!onOpenAgentTool}
          onClick={() => onOpenAgentTool?.("workflows", "automation")}
        />
        <NavItem
          selected={view === "agent" && activeAgentTool === "skills"}
          icon={PluginsGlyph}
          label={chinese ? "插件市场" : "Plugins"}
          visibleLabel={chinese ? "插件" : "Plugins"}
          title={chinese ? "插件市场" : "Plugins"}
          disabled={!onOpenAgentTool}
          onClick={() => onOpenAgentTool?.("skills", "plugins")}
        />
      </div>
    </>
  );
}

const AGENT_TOOLS: {
  id: AgentTool;
  icon: IconComponent;
  label: [string, string];
}[] = [
  { id: "skills", icon: Blocks, label: ["技能", "Skills"] },
  {
    id: "workflows",
    icon: Workflow,
    label: ["工作流与自动化", "Workflows and automation"],
  },
  { id: "memory", icon: Brain, label: ["记忆", "Memory"] },
];

function MoreMenu({
  view,
  activeAgentTool,
  onOpenAgentTool,
  hasUpdate,
  onOpenUpdates,
  onSelectPage,
  todayCost,
}: SidebarProps &
  ReturnType<typeof useSidebarStatus> & { hasUpdate: boolean }) {
  const { t, i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const noticeId = useId();
  const activeTool = view === "agent" ? activeAgentTool : null;
  const applicationsSelected = view === "applications" || isBuiltinApp(view);
  const usageSelected = view === "usage" || view === "allowance";
  const usageLabel = t("nav.usage");
  const costLabel =
    todayCost > 0
      ? t("nav.todayCost", {
          cost: fmtUsd(todayCost, 2),
          defaultValue: `${chinese ? "今日花费" : "Today's cost"} ${fmtUsd(todayCost, 2)}`,
        })
      : undefined;
  return (
    <DropdownMenu>
      <HoverTip content={t("common.more")} side="right" disableHoverableContent>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="lolicode-sidebar-icon-button lolicode-sidebar-more"
            aria-label={t("common.more")}
            aria-describedby={hasUpdate ? noticeId : undefined}
            data-selected={
              Boolean(activeTool) || applicationsSelected || usageSelected
            }
          >
            <MoreHorizontal aria-hidden="true" />
            {hasUpdate && (
              <span className="lolicode-sidebar-notice" aria-hidden="true" />
            )}
          </button>
        </DropdownMenuTrigger>
      </HoverTip>
      {hasUpdate && (
        <span id={noticeId} className="sr-only">
          {t("nav.softwareUpdatesAvailable")}
        </span>
      )}
      <DropdownMenuContent
        side="right"
        align="end"
        className="tai-shell-more-menu"
        collisionPadding={12}
      >
        <DropdownMenuItem
          aria-current={usageSelected ? "page" : undefined}
          aria-label={[usageLabel, costLabel].filter(Boolean).join(" · ")}
          onSelect={() => onSelectPage("usage")}
        >
          <ChartColumn className="h-4 w-4" aria-hidden="true" />
          {usageLabel}
          {todayCost > 0 && (
            <span className="lolicode-sidebar-menu-detail">
              {fmtUsd(todayCost, 2)}
            </span>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem
          aria-current={applicationsSelected ? "page" : undefined}
          onSelect={() => onSelectPage("applications")}
        >
          <Grid2X2 className="h-4 w-4" aria-hidden="true" />
          {t("applications.title")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {chinese ? "工作台工具" : "Workspace tools"}
        </DropdownMenuLabel>
        {AGENT_TOOLS.map(({ id, icon: Icon, label }) => (
          <DropdownMenuItem
            key={id}
            disabled={!onOpenAgentTool}
            aria-current={activeTool === id ? "page" : undefined}
            onSelect={() => onOpenAgentTool?.(id)}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {label[chinese ? 0 : 1]}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onOpenUpdates}
          aria-label={
            hasUpdate
              ? `${t("nav.softwareUpdates", { defaultValue: chinese ? "软件更新" : "Software updates" })} · ${t("nav.softwareUpdatesAvailable")}`
              : undefined
          }
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          {t("nav.softwareUpdates", {
            defaultValue: chinese ? "软件更新" : "Software updates",
          })}
          {hasUpdate && (
            <span className="tai-shell-menu-notice" aria-hidden="true" />
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NavItem({
  selected,
  icon: Icon,
  label,
  visibleLabel = label,
  title,
  alert,
  dot,
  disabled,
  onClick,
  selectionLayout = "tool-selection",
}: {
  selected: boolean;
  icon: IconComponent;
  label: string;
  visibleLabel?: string;
  title?: string;
  alert?: string;
  dot?: boolean;
  disabled?: boolean;
  onClick: () => void;
  selectionLayout?: string;
}) {
  const reducedMotion = useReducedMotion();
  const accessibleName = [label, alert, title !== label ? title : undefined]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={accessibleName}
      aria-current={selected ? "page" : undefined}
      title={title || alert}
      className="lolicode-sidebar-nav-item"
    >
      {selected && (
        <motion.span
          aria-hidden="true"
          className="lolicode-sidebar-selection"
          layoutId={selectionLayout}
          initial={false}
          transition={reducedMotion ? { duration: 0 } : motionTokens.spring}
        />
      )}
      <Icon className="lolicode-sidebar-nav-icon" />
      <span className="lolicode-sidebar-nav-label">{visibleLabel}</span>
      {(dot || alert) && (
        <span
          className={cn("lolicode-sidebar-status", alert && "is-alert")}
          aria-hidden="true"
        />
      )}
    </button>
  );
}

const SETTINGS_ITEMS: { section: SettingsSection; icon: IconComponent }[] = [
  { section: "general", icon: SlidersHorizontal },
  { section: "appConfig", icon: Folder },
  { section: "network", icon: Globe },
  { section: "data", icon: Database },
  { section: "about", icon: Info },
];

function SettingsDirectory(props: SidebarProps) {
  const { t } = useTranslation();
  const { hasUpdate } = useUpdate();
  return (
    <div className="lolicode-sidebar-settings">
      <NavItem
        selected={false}
        icon={ArrowLeft}
        label={t("nav.back")}
        onClick={props.onExitSettings}
      />
      <div className="lolicode-sidebar-divider" role="separator" />
      <div
        role="group"
        aria-label={t("nav.settings")}
        className="lolicode-sidebar-settings-items"
      >
        {SETTINGS_ITEMS.map(({ section, icon }) => (
          <NavItem
            key={section}
            selected={props.settingsSection === section}
            icon={icon}
            selectionLayout="settings-selection"
            label={t(`settings.sections.${section}`)}
            dot={section === "about" && hasUpdate}
            title={
              section === "about" && hasUpdate
                ? t("nav.settingsHasUpdate")
                : undefined
            }
            onClick={() => props.onSelectSettingsSection(section)}
          />
        ))}
      </div>
    </div>
  );
}

export type { SidebarProps };
