import { useContext, useEffect, useState } from "react";
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
import type {
  AgentCatalog,
  AgentNativeActivity,
  AgentSession,
} from "@/types/agent";
import { agentApi } from "@/lib/api/agent";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
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
  const [activity, setActivity] = useState<AgentNativeActivity | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [capabilityRevision, setCapabilityRevision] = useState(0);
  const legacyMock = typeof agentApi.getNativeActivity !== "function";
  useEffect(() => {
    setActivity(null);
    setCapabilityError(null);
    if (!open || legacyMock) return;
    let disposed = false;
    void agentApi
      .getNativeActivity()
      .then((value) => {
        if (!disposed) setActivity(value);
      })
      .catch((error) => {
        if (!disposed) setCapabilityError(agentErrorMessage(error));
      });
    return () => {
      disposed = true;
    };
  }, [open, capabilityRevision, legacyMock]);
  const ready = legacyMock || activity !== null;
  const supported = (feature: "workflows" | "automation" | "remote") => {
    if (!ready) return false;
    if (activity?.features) return activity.features[feature] === true;
    return activity?.inProcess !== true;
  };
  const unavailable =
    ready &&
    ["workflows", "automation", "remote"].some(
      (feature) => !supported(feature as "workflows" | "automation" | "remote"),
    );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="wb-extensions">
        <DialogHeader className="wb-extension-header">
          <div className="wb-extension-heading">
            <DialogTitle>工作流、自动化与远程项目</DialogTitle>
            <DialogDescription>
              管理工作流、定时任务与远程项目。可用功能由当前执行引擎决定。
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
              disabled={!supported(value)}
              title={
                ready && !supported(value)
                  ? "此功能正在迁移至应用本体，暂不可用"
                  : undefined
              }
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="wb-extension-list" role="tabpanel">
          {open && !ready && !capabilityError && (
            <p role="status" className="text-caption text-fg-3">
              正在读取当前引擎的可用功能…
            </p>
          )}
          {open && capabilityError && (
            <div className="space-y-2">
              <p role="alert" className="text-caption text-danger-text">
                {capabilityError}
              </p>
              <button
                className="wb-mode-button"
                onClick={() => setCapabilityRevision((value) => value + 1)}
              >
                重新读取可用功能
              </button>
            </div>
          )}
          {open && unavailable && (
            <p className="wb-extension-hint">
              部分功能正在迁移至 Rust
              本体，暂不可用。已保存的工作流、自动化及远程数据会保留，当前不会启动旧的
              ZCode 服务。
            </p>
          )}
          {open &&
            supported(tab) &&
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
