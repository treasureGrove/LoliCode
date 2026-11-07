import {
  useId,
  useState,
  type ComponentType,
  type ReactNode,
  type RefCallback,
} from "react";
import { useTranslation } from "react-i18next";
import { LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  Blocks,
  Brain,
  ChartColumn,
  Database,
  Folder,
  Globe,
  Grid2X2,
  Info,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  SlidersHorizontal,
  Workflow,
} from "lucide-react";
import { isBuiltinApp } from "@/lib/api/builtin-apps";
import type { AppId } from "@/lib/api";
import type { VisibleApps } from "@/types";
import type { GlobalPage, SettingsSection, View } from "@/lib/navigation";
import { useUpdate } from "@/contexts/UpdateContext";
import { useSidebarStatus } from "@/hooks/useSidebarStatus";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { TavernSidebar } from "@/features/tavern/TavernSidebar";
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
  workspaceSlots?: {
    actions: RefCallback<HTMLDivElement>;
    content: RefCallback<HTMLDivElement>;
  };
  onCollapse?: () => void;
  sidebarCompact?: boolean;
  onOpenAgentTool?: (tool: AgentTool, initialTab?: AgentToolTab) => void;
  activeAgentTool?: AgentTool | null;
  selectedTavernCharacterId?: string | null;
  onSelectTavernCharacter?: (id: string) => void;
  onAddTavernCharacter?: (source: "preset" | "card") => void;
  tavernEnabled?: boolean;
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
  const layoutId = useId();
  const { t, i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const status = useSidebarStatus();
  const { hasUpdate } = useUpdate();
  const [tavernCompact, setTavernCompact] = useState(false);
  const compact =
    props.sidebarCompact ?? (props.view === "tavern" && tavernCompact);

  return (
    <LayoutGroup id={layoutId}>
      <nav
        data-collapsed="false"
        data-embedded={Boolean(props.embedded)}
        data-sidebar-compact={compact}
        data-workspace-mode={
          props.view === "agent" || props.view === "tavern"
            ? props.view
            : undefined
        }
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
          {(props.onCollapse || props.view === "tavern") && (
            <HoverTip
              content={
                compact
                  ? chinese
                    ? "展开侧栏"
                    : "Expand sidebar"
                  : chinese
                    ? "收起侧栏"
                    : "Collapse sidebar"
              }
              side="right"
            >
              <button
                type="button"
                className="lolicode-sidebar-icon-button"
                data-workspace-sidebar-toggle
                aria-label={
                  compact
                    ? chinese
                      ? "展开侧栏"
                      : "Expand sidebar"
                    : chinese
                      ? "收起侧栏"
                      : "Collapse sidebar"
                }
                onClick={
                  props.onCollapse ??
                  (() => setTavernCompact((value) => !value))
                }
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                {compact ? (
                  <PanelLeftOpen aria-hidden="true" />
                ) : (
                  <PanelLeftClose aria-hidden="true" />
                )}
              </button>
            </HoverTip>
          )}
        </div>
        {props.view === "settings" ? (
          <SettingsDirectory
            {...props}
            authNeedsAttention={status.authNeedsAttention}
          />
        ) : (
          <>
            <MainDirectory {...props} />
            {props.view === "tavern" && props.tavernEnabled !== false && (
              <TavernSidebar
                compact={compact}
                selectedId={props.selectedTavernCharacterId ?? null}
                onSelect={(id) => props.onSelectTavernCharacter?.(id)}
                onAdd={
                  props.onAddTavernCharacter ??
                  ((source) =>
                    window.dispatchEvent(
                      new CustomEvent("lolicode:tavern-add", {
                        detail: source,
                      }),
                    ))
                }
              />
            )}
          </>
        )}
        <div className="lolicode-sidebar-footer">
          <div className="lolicode-sidebar-account">
            <SidebarProfileMenu
              expanded={!compact}
              hasUpdate={hasUpdate}
              selected={
                props.view === "settings" ||
                props.view === "usage" ||
                props.view === "allowance" ||
                props.view === "applications" ||
                (props.view !== "tavern" && isBuiltinApp(props.view)) ||
                (props.view === "agent" && Boolean(props.activeAgentTool))
              }
              navigationItems={
                <NavigationItems {...props} todayCost={status.todayCost} />
              }
              onOpenSettings={() => props.onSelectPage("settings")}
              onOpenUpdates={props.onOpenUpdates}
              onOpenAllowance={() => props.onSelectPage("allowance")}
            />
          </div>
        </div>
      </nav>
    </LayoutGroup>
  );
}

function MainDirectory({
  view,
  onSelectPage,
  onOpenAgentTool,
  activeAgentTool,
  workspaceActions,
  workspaceContent,
  workspaceSlots,
}: SidebarProps) {
  const { i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const agent = view === "agent";
  return (
    <>
      <div
        role="group"
        aria-label={chinese ? "主要导航" : "Main navigation"}
        className="lolicode-sidebar-segments"
      >
        <NavItem
          selected={view === "agent"}
          icon={ModelsGlyph}
          selectionLayout={null}
          label={chinese ? "编程工作台" : "Coding workspace"}
          visibleLabel={chinese ? "代理" : "Agent"}
          onClick={() => onSelectPage("agent")}
        />
        <NavItem
          selected={view === "tavern"}
          icon={ChatGlyph}
          selectionLayout={null}
          label={chinese ? "角色对话" : "Character chat"}
          visibleLabel={chinese ? "对话" : "Chat"}
          onClick={() => onSelectPage("tavern")}
        />
      </div>
      {(agent || workspaceSlots) && (
        <>
          <div
            ref={workspaceSlots?.actions}
            className="lolicode-sidebar-actions"
            hidden={!agent}
          >
            {!workspaceSlots &&
              (workspaceActions ?? (
                <button
                  type="button"
                  className="lolicode-sidebar-new-chat"
                  onClick={() => onSelectPage("agent")}
                >
                  <Plus aria-hidden="true" />
                  {chinese ? "开始对话" : "Start a chat"}
                </button>
              ))}
          </div>
          <div
            ref={workspaceSlots?.content}
            className="lolicode-sidebar-workspaces"
            hidden={!agent}
          >
            {!workspaceSlots && workspaceContent}
          </div>
        </>
      )}
      {view === "agent" && (
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
            label={chinese ? "插件" : "Plugins"}
            title={chinese ? "插件" : "Plugins"}
            disabled={!onOpenAgentTool}
            onClick={() => onOpenAgentTool?.("skills", "plugins")}
          />
        </div>
      )}
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

function NavigationItems({
  view,
  activeAgentTool,
  onOpenAgentTool,
  onSelectPage,
  todayCost,
}: SidebarProps & { todayCost: number }) {
  const { t, i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const activeTool = view === "agent" ? activeAgentTool : null;
  const applicationsSelected =
    view === "applications" || (view !== "tavern" && isBuiltinApp(view));
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
    <>
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
    </>
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
  selectionLayout?: string | null;
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
      {selected && selectionLayout && (
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
  { section: "models", icon: ModelsGlyph },
  { section: "appConfig", icon: Folder },
  { section: "network", icon: Globe },
  { section: "data", icon: Database },
  { section: "about", icon: Info },
];

function SettingsDirectory(
  props: SidebarProps & { authNeedsAttention: boolean },
) {
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
            label={
              section === "models"
                ? t("channelCenter.navigation", { defaultValue: "渠道与模型" })
                : t(`settings.sections.${section}`)
            }
            alert={
              section === "models" && props.authNeedsAttention
                ? t("nav.authNeedsReauth")
                : undefined
            }
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
