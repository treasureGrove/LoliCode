import { useContext, useState } from "react";
import { X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { WindowControlsContext } from "@/components/shell/AppPageHeader";
import type { AgentCatalog, AgentSession } from "@/types/agent";
import { AgentWorkflowPanel } from "./AgentWorkflowPanel";
import { AgentAutomationPanel } from "./AgentAutomationPanel";
import { AgentRemotePanel } from "./AgentRemotePanel";

export function AgentOperationsPanel({
  open,
  onOpenChange,
  projectPath,
  catalog,
  working,
  onSession,
  onCompose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath?: string;
  catalog: AgentCatalog;
  working: boolean;
  onSession: (session: AgentSession) => void;
  onCompose: (text: string) => void;
}) {
  const [tab, setTab] = useState<"workflows" | "automation" | "remote">(
    "workflows",
  );
  const windowControls = useContext(WindowControlsContext);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="wb-extensions">
        <DialogHeader className="wb-extension-header">
          <div className="wb-extension-heading">
            <DialogTitle>工作流、自动化与远程项目</DialogTitle>
            <DialogDescription>
              使用 ZCode 原生工作流、任务调度与远程环境。
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <button
              type="button"
              className="wb-extension-close"
              aria-label="关闭项目与自动化弹窗"
            >
              <X size={18} />
            </button>
          </DialogClose>
        </DialogHeader>
        <div
          className="wb-extension-tabs"
          role="tablist"
          aria-label="项目与任务管理"
        >
          {(
            [
              ["workflows", "工作流"],
              ["automation", "自动化"],
              ["remote", "SSH / WSL"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="wb-extension-list" role="tabpanel">
          {open &&
            (tab === "remote" ? (
              <AgentRemotePanel
                catalog={catalog}
                projectOpen={Boolean(projectPath)}
              />
            ) : !projectPath ? (
              <p className="text-body">
                请先在工作台选择本地项目，然后管理该项目的工作流与自动化。
              </p>
            ) : tab === "workflows" ? (
              <AgentWorkflowPanel
                projectPath={projectPath}
                catalog={catalog}
                working={working}
                onSession={(session) => {
                  onSession(session);
                  onOpenChange(false);
                }}
                onCompose={(text) => {
                  onCompose(text);
                  onOpenChange(false);
                }}
              />
            ) : (
              <AgentAutomationPanel
                projectPath={projectPath}
                catalog={catalog}
                onSession={(session) => {
                  onSession(session);
                  onOpenChange(false);
                }}
              />
            ))}
        </div>
        <DialogFooter className="wb-extension-footer">
          {windowControls && (
            <div
              className="wb-extension-window-controls"
              role="group"
              aria-label="窗口操作"
            >
              <span>窗口</span>
              {windowControls}
            </div>
          )}
          <DialogClose asChild>
            <button type="button" className="wb-extension-dismiss">
              返回工作台
            </button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
