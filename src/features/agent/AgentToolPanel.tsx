import type { ReactNode } from "react";
import { FolderOpen, type LucideIcon } from "lucide-react";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import "./agent-tool-panels.css";

export type AgentTool = "skills" | "workflows" | "memory";

/** A workspace tool replaces the content surface while keeping the global rail usable. */
export function AgentToolPanel({
  open,
  onClose,
  title,
  description,
  icon: Icon,
  projectPath,
  actions,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  icon: LucideIcon;
  projectPath?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const projectName = projectPath
    ?.replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();

  return (
    <FullScreenPanel
      isOpen={open}
      title={title}
      backLabel="返回工作台"
      onClose={onClose}
      actions={actions}
      motionPreset="none"
      contentClassName="wb-tool-panel-content space-y-0 p-0"
    >
      <div className="wb-extensions wb-tool-panel">
        <header className="wb-tool-panel-intro">
          <span className="wb-tool-panel-icon" aria-hidden="true">
            <Icon size={25} strokeWidth={1.5} />
          </span>
          <div className="wb-tool-panel-copy">
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <span className="wb-tool-panel-project" title={projectPath}>
            <FolderOpen size={14} aria-hidden="true" />
            <span>{projectName || "未打开项目"}</span>
          </span>
        </header>
        {children}
      </div>
    </FullScreenPanel>
  );
}
