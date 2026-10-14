import { createContext, useContext, type ReactNode } from "react";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE } from "@/lib/platform";
import { cn } from "@/lib/utils";

/** Linux window controls follow the actions on every page. */
export const WindowControlsContext = createContext<ReactNode>(null);
const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

interface AppPageHeaderProps {
  leading?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
  /** Only client headers receive a client name as title and task name as subtitle. */
  variant?: "app" | "page" | "client";
  subtitle?: ReactNode;
  titleExtra?: ReactNode;
  actions?: ReactNode;
  truncateTitle?: boolean;
  className?: string;
}

/** Client context sits above the task title, with a stable desktop action lane. */
export function AppPageHeader({
  leading,
  icon,
  title,
  variant = "page",
  subtitle,
  titleExtra,
  actions,
  truncateTitle = false,
  className,
}: AppPageHeaderProps) {
  const windowControls = useContext(WindowControlsContext);
  const contextualTitle = variant === "client" && subtitle;
  return (
    <header
      className={cn("tai-shell-page-header", className)}
      {...DRAG_REGION_ATTR}
      style={DRAG_REGION_STYLE as React.CSSProperties}
    >
      <div {...DRAG_REGION_ATTR} className="tai-shell-heading">
        {leading && (
          <span className="flex shrink-0 items-center" style={NO_DRAG}>
            {leading}
          </span>
        )}
        {icon && (
          <span
            aria-hidden="true"
            className="tai-shell-heading-icon"
            {...DRAG_REGION_ATTR}
          >
            {icon}
          </span>
        )}
        <div className="tai-shell-heading-copy" {...DRAG_REGION_ATTR}>
          {contextualTitle && (
            <span
              className="tai-shell-heading-eyebrow truncate"
              {...DRAG_REGION_ATTR}
            >
              {title}
            </span>
          )}
          <h1
            className={cn(
              "tai-shell-heading-title",
              truncateTitle ? "truncate" : "whitespace-nowrap",
            )}
            {...DRAG_REGION_ATTR}
          >
            {contextualTitle ? subtitle : title}
          </h1>
          {!contextualTitle && subtitle && (
            <span
              className="tai-shell-heading-eyebrow truncate"
              {...DRAG_REGION_ATTR}
            >
              {subtitle}
            </span>
          )}
        </div>
        {titleExtra && (
          <div className="tai-shell-heading-extra" style={NO_DRAG}>
            {titleExtra}
          </div>
        )}
      </div>
      {actions && (
        <div className="tai-shell-header-actions" style={NO_DRAG}>
          {actions}
        </div>
      )}
      {windowControls && (
        <div className="tai-shell-window-controls" style={NO_DRAG}>
          {windowControls}
        </div>
      )}
    </header>
  );
}
