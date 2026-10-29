import { useEffect, useState } from "react";
import { Clock3, FolderOpen, Workflow } from "lucide-react";
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
import { AgentToolPanel } from "./AgentToolPanel";
import "./agent-workflows-panel.css";

export function AgentOperationsPanel({
  open,
  onOpenChange,
  projectPath,
  catalog,
  working,
  onSession,
  onCompose,
  onOpenProject,
  initialTab,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectPath?: string;
  catalog: AgentCatalog;
  working: boolean;
  onSession: (session: AgentSession) => void;
  onCompose: (text: string) => void;
  onOpenProject?: (path: string) => void | Promise<void>;
  initialTab?: "workflows" | "automation" | "remote";
}) {
  const [tab, setTab] = useState<"workflows" | "automation" | "remote">(
    "workflows",
  );
  useEffect(() => {
    if (open && initialTab) setTab(initialTab);
  }, [open, initialTab]);
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
  return (
    <AgentToolPanel
      open={open}
      onClose={() => onOpenChange(false)}
      title="工作流与自动化"
      description="把常用任务保存为工作流，按需运行，或安排在合适的时间自动执行。"
      icon={Workflow}
      projectPath={projectPath}
    >
      <div className="wb-operations-panel">
        <div
          className="wb-extension-tabs"
          role="tablist"
          aria-label="项目与任务管理"
        >
          {(
            [
              ["workflows", "工作流", Workflow],
              ["automation", "自动化", Clock3],
              ["remote", "SSH / WSL", FolderOpen],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`agent-operations-tab-${value}`}
              aria-controls="agent-operations-content"
              aria-selected={tab === value}
              disabled={!ready}
              title={
                ready && !supported(value)
                  ? "查看当前执行引擎的功能状态"
                  : undefined
              }
              onClick={() => setTab(value)}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
        <div
          className="wb-extension-list"
          role="tabpanel"
          id="agent-operations-content"
          aria-labelledby={`agent-operations-tab-${tab}`}
        >
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
          {open && ready && !supported(tab) && (
            <div className="wb-extension-hint" role="status">
              <strong>
                {tab === "remote"
                  ? "远端工程暂未接入当前 Rust 执行引擎"
                  : tab === "workflows"
                    ? "当前执行引擎未提供工作流"
                    : "当前执行引擎未提供自动化"}
              </strong>
              <p>
                {tab === "remote"
                  ? "本地工作流和定时任务可以正常使用；SSH / WSL 项目还没有远程任务执行接口，因此不会显示为可运行或可调度项目。已保存的远端配置会保留，也不会启动旧的 ZCode 服务。"
                  : "已保存的数据会保留。切换到支持此功能的执行引擎后即可继续管理。"}
              </p>
            </div>
          )}
          {open &&
            supported(tab) &&
            (tab === "remote" ? (
              <AgentRemotePanel
                onOpenProject={
                  onOpenProject
                    ? async (path) => {
                        onOpenChange(false);
                        await onOpenProject(path);
                      }
                    : undefined
                }
              />
            ) : !projectPath ? (
              <p className="wb-extension-hint">
                {tab === "workflows"
                  ? "请先在工作台打开一个项目，再管理或运行该项目的工作流。"
                  : "自动化任务按项目保存。请先在工作台打开一个项目。"}
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
                onCompose={(text) => {
                  onCompose(text);
                  onOpenChange(false);
                }}
              />
            ))}
        </div>
      </div>
    </AgentToolPanel>
  );
}
