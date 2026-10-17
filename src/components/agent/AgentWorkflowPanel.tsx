import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentApi } from "@/lib/api/agent";
import type { AgentCatalog, AgentSession } from "@/types/agent";
import {
  OperationError,
  useAgentOperation,
  useAgentResource,
} from "./AgentOperationShared";
type Workflow = {
  name: string;
  description: string;
  scope: "project" | "global";
  args?: Record<
    string,
    {
      type: string;
      description?: string;
      required?: boolean;
      default?: unknown;
    }
  >;
};
type Run = {
  runId: string;
  name?: string;
  status: string;
  cwd?: string;
  sessionId?: string;
  error?: string;
};
type Receipt = {
  key: string;
  sessionId: string;
  requestId: string;
  args: Record<string, unknown>;
};
const receiptKey = (path: string) =>
  `lolicode.workflow-run:${encodeURIComponent(path)}`;
const readReceipt = (path: string): Receipt | null => {
  try {
    const value = JSON.parse(localStorage.getItem(receiptKey(path)) || "null");
    return (value?.sessionId?.startsWith("zc:") ||
      value?.sessionId?.startsWith("lc:")) &&
      typeof value.requestId === "string" &&
      typeof value.key === "string" &&
      value.args &&
      typeof value.args === "object"
      ? value
      : null;
  } catch {
    return null;
  }
};
const STATUS: Record<string, string> = {
  pending: "等待运行",
  running: "执行中",
  completed: "已完成",
  errored: "执行失败",
  stopped: "已停止",
};
export function AgentWorkflowPanel({
  projectPath,
  catalog,
  working,
  onSession,
  onCompose,
}: {
  projectPath: string;
  catalog: AgentCatalog;
  working: boolean;
  onSession: (session: AgentSession) => void;
  onCompose: (text: string) => void;
}) {
  const [scope, setScope] = useState<"project" | "global">("project");
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [script, setScript] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [pendingReceipt, setPendingReceipt] = useState<Receipt | null>(() =>
    readReceipt(projectPath),
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<{
    name: string;
    baseDocument: string;
  } | null>(null);
  const editorContext = useRef("");
  editorContext.current = `${projectPath}\0${scope}`;
  const [name, setName] = useState("");
  const [document, setDocument] = useState(
    "---\ndescription: 检查当前项目并总结结果\n---\n1. 阅读项目说明和当前变更。\n2. 执行与变更相关的检查。\n3. 总结发现、验证结果与待处理问题。\n",
  );
  useEffect(() => {
    setSelected(null);
    setValues({});
    setScript(null);
    setConfirmDelete(null);
    setCreateOpen(false);
    setEditing(null);
    setPendingReceipt(readReceipt(projectPath));
  }, [projectPath]);
  const { busy, error, run } = useAgentOperation();
  const request = { workspacePath: projectPath, scope };
  const resource = useAgentResource(
    `workflows:${projectPath}:${scope}`,
    async () => {
      const [listing, history] = await Promise.all([
        agentApi.native<{
          workflows: Workflow[];
          invalid: { path: string; reason: string }[];
        }>("IZCodeAgentService", "listSavedWorkflows", [request]),
        agentApi.native<{ runs: Run[] }>(
          "IZCodeAgentService",
          "listSavedWorkflowRuns",
          [{ ...request, limit: 20 }],
        ),
      ]);
      return { ...listing, runs: history.runs };
    },
  );
  const start = () =>
    void run(async () => {
      if (!selected) return;
      const args = Object.fromEntries(
        Object.entries(selected.args || {})
          .map(([key, spec]) => {
            const value =
              values[key] ??
              (spec.default === undefined
                ? ""
                : typeof spec.default === "string"
                  ? spec.default
                  : JSON.stringify(spec.default));
            if (!value && spec.required) throw new Error(`请填写参数：${key}`);
            if (!value) return [key, spec.default];
            if (spec.type === "number") {
              const number = Number(value);
              if (!Number.isFinite(number))
                throw new Error(`${key} 必须是数字`);
              return [key, number];
            }
            if (
              spec.type === "boolean" &&
              value !== "true" &&
              value !== "false"
            )
              throw new Error(`${key} 请填写 true 或 false`);
            return [
              key,
              spec.type === "boolean" || spec.type === "json"
                ? JSON.parse(value)
                : value,
            ];
          })
          .filter(([, value]) => value !== undefined),
      );
      const identity = JSON.stringify([selected.name, scope, args]);
      let receipt = readReceipt(projectPath);
      if (receipt && receipt.key !== identity)
        throw new Error(
          "上次工作流的接收状态未确认，请先按原参数重试，避免重复运行。",
        );
      if (!receipt) {
        const model = catalog.defaultModel || catalog.models[0]?.id;
        if (!model) throw new Error("请先添加可用模型");
        const session = await agentApi.createSession(
          model,
          "build",
          `工作流 · ${selected.name}`,
          "ask",
          undefined,
          projectPath,
        );
        receipt = {
          key: identity,
          sessionId: session.id,
          requestId: `workflow_${crypto.randomUUID()}`,
          args,
        };
        localStorage.setItem(receiptKey(projectPath), JSON.stringify(receipt));
        setPendingReceipt(receipt);
      }
      const session = await agentApi.runSavedWorkflow(
        receipt.sessionId,
        selected.name,
        receipt.requestId,
        scope,
        receipt.args,
      );
      localStorage.removeItem(receiptKey(projectPath));
      setPendingReceipt(null);
      onSession(session);
      resource.reload();
    });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label>
          范围{" "}
          <select
            aria-label="工作流范围"
            className="rounded-control border bg-card p-2"
            value={scope}
            disabled={busy}
            onChange={(event) => {
              setScope(event.target.value as typeof scope);
              setSelected(null);
              setScript(null);
              setCreateOpen(false);
              setEditing(null);
            }}
          >
            <option value="project">当前项目</option>
            <option value="global">全局</option>
          </select>
        </label>
        <Button variant="neutral" disabled={busy} onClick={resource.reload}>
          刷新工作流
        </Button>
        <Button
          variant="neutral"
          disabled={busy}
          onClick={() => {
            if (editing) {
              setEditing(null);
              setName("");
            }
            setCreateOpen(!createOpen || editing !== null);
          }}
        >
          新建工作流
        </Button>
        <Button
          variant="neutral"
          onClick={() =>
            onCompose(
              "请根据当前项目帮我创建可复用工作流，保存为 .zcode/workflows/名称.md，使用 YAML frontmatter description 字段和 Markdown 步骤正文。任务步骤由当前 Agent 执行，不要输出依赖旧运行时的 JS 脚本。先和我确认具体任务。",
            )
          }
        >
          在会话中创建工作流
        </Button>
      </div>
      <OperationError>{error || resource.error}</OperationError>
      {pendingReceipt && (
        <div className="flex items-center gap-2 text-caption text-fg-3">
          <span>
            上次运行的接收状态待确认。检查会话后可继续运行其他工作流。
          </span>
          <Button
            variant="neutral"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const snapshot = await agentApi.getSession(
                  pendingReceipt.sessionId,
                );
                if (
                  ![
                    "running",
                    "waiting_permission",
                    "waiting_question",
                  ].includes(snapshot.status)
                ) {
                  localStorage.removeItem(receiptKey(projectPath));
                  setPendingReceipt(null);
                }
                onSession(snapshot.session);
              })
            }
          >
            检查上次运行
          </Button>
        </div>
      )}
      {createOpen && (
        <form
          className="space-y-3 rounded-control border border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const result = await agentApi.native<{
                ok: boolean;
                detail?: string;
              }>("IZCodeAgentService", "saveSavedWorkflow", [
                {
                  ...request,
                  name,
                  document,
                  ...(editing
                    ? {
                        overwrite: true,
                        expectedDocument: editing.baseDocument,
                      }
                    : {}),
                },
              ]);
              if (!result.ok)
                throw new Error(result.detail || "工作流保存失败");
              setName("");
              setCreateOpen(false);
              setEditing(null);
              setSelected(null);
              setScript(null);
              resource.reload();
            });
          }}
        >
          {editing && (
            <h3 className="font-medium">编辑工作流 · {editing.name}</h3>
          )}
          <label className="block text-caption">
            名称
            <Input
              aria-label="工作流名称"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy || editing !== null}
            />
          </label>
          <label className="block text-caption">
            工作流说明与步骤
            <textarea
              aria-label="工作流内容"
              rows={8}
              className="mt-1 w-full rounded-control border bg-card p-3 font-mono text-caption"
              value={document}
              onChange={(event) => setDocument(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !name.trim()}>
              {editing ? "保存修改" : "保存工作流"}
            </Button>
            <Button
              type="button"
              variant="neutral"
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
          </div>
        </form>
      )}
      {!resource.data?.workflows.length && (
        <p className="text-caption text-fg-3">
          {resource.loading
            ? "正在读取原生工作流…"
            : "这里还没有已保存的工作流，可先在会话中创建，然后刷新。"}
        </p>
      )}
      {resource.data?.workflows.map((item) => (
        <div
          key={item.name}
          className="rounded-control border border-border p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <strong className="mr-auto">{item.name}</strong>
            <Button
              variant="neutral"
              disabled={busy}
              onClick={() => {
                setSelected(item);
                setValues({});
                setScript(null);
              }}
            >
              配置与运行
            </Button>
            <Button
              variant="neutral"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const context = editorContext.current;
                  const detail = await agentApi.native<{
                    ok: boolean;
                    document?: string;
                    detail?: string;
                  }>("IZCodeAgentService", "getSavedWorkflow", [
                    { ...request, name: item.name },
                  ]);
                  if (editorContext.current !== context) return;
                  if (!detail.ok || typeof detail.document !== "string")
                    throw new Error(
                      detail.detail || "无法读取工作流原文，请刷新后重试",
                    );
                  setName(item.name);
                  setDocument(detail.document);
                  setEditing({
                    name: item.name,
                    baseDocument: detail.document,
                  });
                  setCreateOpen(true);
                })
              }
            >
              编辑工作流
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => setConfirmDelete(item.name)}
            >
              删除
            </Button>
          </div>
          <p className="mt-2 text-caption text-fg-3">{item.description}</p>
          {confirmDelete === item.name && (
            <div className="mt-2 flex gap-2">
              <Button variant="neutral" onClick={() => setConfirmDelete(null)}>
                取消删除
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await agentApi.native<{
                      ok: boolean;
                      detail?: string;
                    }>("IZCodeAgentService", "deleteSavedWorkflow", [
                      { ...request, name: item.name },
                    ]);
                    if (!result.ok)
                      throw new Error(result.detail || "工作流删除未完成");
                    setConfirmDelete(null);
                    setSelected(null);
                    resource.reload();
                  })
                }
              >
                确认删除工作流
              </Button>
            </div>
          )}
        </div>
      ))}
      {resource.data?.invalid.map((item) => (
        <p key={item.path} className="text-caption text-danger-text">
          无法加载 {item.path}：{item.reason}
        </p>
      ))}
      {selected && (
        <section
          className="space-y-3 rounded-control border border-border p-3"
          aria-label="工作流运行设置"
        >
          <h3 className="font-medium">运行 {selected.name}</h3>
          {Object.entries(selected.args || {}).map(([key, spec]) => (
            <label key={key} className="block text-caption">
              {key}
              {spec.required ? " *" : ""} · {spec.description || spec.type}
              <Input
                aria-label={`工作流参数 ${key}`}
                value={
                  values[key] ??
                  (spec.default === undefined
                    ? ""
                    : typeof spec.default === "string"
                      ? spec.default
                      : JSON.stringify(spec.default))
                }
                onChange={(event) =>
                  setValues((old) => ({ ...old, [key]: event.target.value }))
                }
                disabled={busy}
              />
            </label>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || working || !catalog.models.length}
              onClick={start}
            >
              在新会话运行工作流
            </Button>
            <Button
              variant="neutral"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const detail = await agentApi.native<{
                    ok: boolean;
                    script?: string;
                    detail?: string;
                  }>("IZCodeAgentService", "getSavedWorkflow", [
                    { ...request, name: selected.name },
                  ]);
                  if (!detail.ok)
                    throw new Error(detail.detail || "无法读取工作流");
                  setScript(detail.script || "");
                })
              }
            >
              查看脚本
            </Button>
          </div>
          {working && (
            <p className="text-caption text-fg-3">任务结束后可启动工作流。</p>
          )}
          {script !== null && (
            <pre className="max-h-64 overflow-auto rounded-control bg-subtle p-3 text-caption">
              {script}
            </pre>
          )}
        </section>
      )}
      {!!resource.data?.runs.length && (
        <section>
          <h3 className="mb-2 font-medium">工作流运行记录</h3>
          {resource.data.runs.map((item) => (
            <div
              key={item.runId}
              className="mb-2 flex items-center gap-2 text-caption"
            >
              <span className="mr-auto">
                {item.name || item.runId} · {STATUS[item.status] || item.status}
                {item.error && (
                  <span className="block text-danger-text">{item.error}</span>
                )}
              </span>
              {item.sessionId && (
                <Button
                  variant="neutral"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const snapshot = await agentApi.getSession(
                        item.sessionId!,
                      );
                      onSession(snapshot.session);
                    })
                  }
                >
                  打开会话
                </Button>
              )}
              {item.sessionId && item.status === "running" && (
                <Button
                  variant="neutral"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await agentApi.interruptSession(item.sessionId!);
                      resource.reload();
                    })
                  }
                >
                  停止
                </Button>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
