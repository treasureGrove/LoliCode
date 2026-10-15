import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, fieldClass } from "@/components/ui/input";
import { agentApi } from "@/lib/api/agent";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";
import type {
  AgentCatalog,
  AgentQuestion,
  AgentQuestionField,
} from "@/types/agent";
import { AgentQuestionCard } from "./AgentQuestionCard";
import {
  captureAgentDraft,
  clearSubmittedAgentDraft,
  saveAgentDraft,
  type AgentDraftToken,
} from "@/lib/agentInputLedger";
import {
  OperationError,
  useAgentOperation,
  useAgentResource,
} from "./AgentOperationShared";
type Connection = { id: string; kind: string; state: string };
type Task = { taskId: string; title: string; status?: string };
type Permission = {
  requestId: string;
  traceId: string;
  description: string;
  options: { optionId: string; name: string; response: unknown }[];
  raw?: { input?: unknown };
};
function permissionDetails(request: Permission): string {
  const input = request.raw?.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const labels: Record<string, string> = {
    command: "命令",
    filePath: "文件",
    path: "路径",
    cwd: "工作目录",
    workdir: "工作目录",
    directory: "目录",
  };
  return Object.entries(labels)
    .flatMap(([key, label]) => {
      const value = (input as Record<string, unknown>)[key];
      const text =
        typeof value === "string"
          ? value
          : Array.isArray(value) &&
              value.every((item) => typeof item === "string")
            ? value.join("\n")
            : "";
      return text ? [`${label}\n${text}`] : [];
    })
    .join("\n\n");
}
type Question = {
  requestId: string;
  traceId: string;
  message: string;
  questions?: {
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: { value: string; label: string; description?: string }[];
  }[];
  options?: { value: string; label: string }[];
  schema?: {
    interaction?: string;
    plan?: string;
    properties?: Record<
      string,
      { type?: string; title?: string; description?: string; enum?: string[] }
    >;
    required?: string[];
  };
};
type Snapshot = {
  meta: Task;
  messages: { id?: string; role: string; content: string }[];
  runtime?: {
    pendingPermissions?: Permission[];
    pendingElicitations?: Question[];
    pendingCommands?: unknown[];
  };
  admittedRequestId?: string;
  stoppedRequestId?: string;
};
type RemoteModel = {
  providerId: string;
  modelId: string;
  label: string;
  reasoningLevel: string;
};
type Receipt = {
  requestId: string;
  text: string;
  accepted?: boolean;
  draft?: AgentDraftToken;
  stopRequested?: boolean;
  stopAcknowledged?: boolean;
  stoppedAfterAdmission?: boolean;
};
const key = (remoteId: string, project: string, taskId: string) =>
  `lolicode.remote-input:${JSON.stringify([remoteId, project, taskId])}`;
function read(key: string): Receipt | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return typeof value?.requestId === "string" &&
      typeof value.text === "string"
      ? value
      : null;
  } catch {
    return null;
  }
}
function questionDto(taskId: string, question: Question): AgentQuestion {
  let fields: AgentQuestionField[];
  if (question.questions?.length)
    fields = question.questions.map((item, index) => ({
      key: `answer_${index}`,
      type: item.multiSelect ? "multiselect" : "string",
      title: item.header || item.question,
      description: item.question,
      required: true,
      options: item.options,
      custom: true,
    }));
  else if (question.schema?.properties)
    fields = Object.entries(question.schema.properties).map(
      ([name, field]) => ({
        key: name,
        type: ["boolean", "number", "integer"].includes(field.type || "")
          ? (field.type as "boolean" | "number" | "integer")
          : !field.type || ["string", "array", "object"].includes(field.type)
            ? "string"
            : "external",
        title: field.title || name,
        description: [
          field.description,
          field.type === "array"
            ? "请填写 JSON 数组"
            : field.type === "object"
              ? "请填写 JSON 对象"
              : "",
        ]
          .filter(Boolean)
          .join(" · "),
        required: question.schema?.required?.includes(name),
        options: field.enum?.map((value) => ({ value, label: value })),
      }),
    );
  else
    fields = [
      {
        key: "text",
        type: "string",
        title: question.message,
        required: true,
        options: question.options,
        custom: true,
      },
    ];
  return {
    id: question.requestId,
    sessionId: taskId,
    title: question.message,
    fields,
  };
}
export function AgentRemotePanel({
  catalog,
  projectOpen,
}: {
  catalog: AgentCatalog;
  projectOpen: boolean;
}) {
  const [kind, setKind] = useState<"ssh" | "wsl">("ssh");
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [port, setPort] = useState("");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [distros, setDistros] = useState<{ name: string }[]>([]);
  const [remoteId, setRemoteId] = useState("");
  const [directory, setDirectory] = useState("");
  const [project, setProject] = useState("");
  const [taskId, setTaskId] = useState("");
  const [freshTaskId, setFreshTaskId] = useState("");
  const [models, setModels] = useState<RemoteModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const stopPending = useRef(false);
  const { busy, error, run } = useAgentOperation();
  const connections = useAgentResource("native-remotes", () =>
    agentApi.remote<Connection[]>("list"),
  );
  const native = <T,>(method: string, args: unknown[] = []) =>
    agentApi.native<T>("IZCodeTaskService", method, args, { remoteId });
  const tasks = useAgentResource(
    project && remoteId ? `remote-tasks:${remoteId}:${project}` : "",
    () => native<Task[]>("listTasks", [{ workspacePath: project }]),
  );
  const snapshot = useAgentResource(
    taskId && project && remoteId && freshTaskId !== taskId
      ? `remote-task:${remoteId}:${project}:${taskId}`
      : "",
    async () => {
      let receipt = read(key(remoteId, project, taskId));
      let admitted = false;
      // Legacy task-message IDs are not V4 command IDs. Use the persisted
      // source anchor to prove this exact submitted input was admitted.
      if (receipt) {
        const requestId = receipt.requestId;
        const history = await agentApi.native<
          { info: { role: string; anchor?: { sourceCommandId?: string } } }[]
        >(
          "IZCodeAgentService",
          "readSessionMessages",
          [{ workspacePath: project, sessionId: taskId, limit: 200 }],
          { remoteId },
        );
        if (
          history.some(
            ({ info }) =>
              info.role === "user" &&
              info.anchor?.sourceCommandId === requestId,
          )
        )
          admitted = true;
      }
      if (
        receipt?.stopRequested &&
        admitted &&
        !receipt.stoppedAfterAdmission &&
        !stopPending.current
      ) {
        stopPending.current = true;
        try {
          await native("stopGeneration", [{ taskId, workspacePath: project }]);
          const latest = read(key(remoteId, project, taskId));
          if (latest?.requestId === receipt.requestId) {
            receipt = {
              ...latest,
              stopAcknowledged: true,
              stoppedAfterAdmission: true,
            };
            localStorage.setItem(
              key(remoteId, project, taskId),
              JSON.stringify(receipt),
            );
          }
        } finally {
          stopPending.current = false;
        }
      }
      // Read execution state after the admission proof, so an older idle
      // snapshot cannot be combined with a newly persisted input.
      const state = await native<Snapshot>("getTaskSnapshot", [
        {
          taskId,
          workspacePath: project,
          messageLimit: 200,
          clientMode: "desktop-continuous",
        },
      ]);
      if (receipt && admitted) state.admittedRequestId = receipt.requestId;
      if (receipt?.stopAcknowledged && receipt.stoppedAfterAdmission)
        state.stoppedRequestId = receipt.requestId;
      return state;
    },
    1000,
    true,
  );
  const storageKey = key(remoteId, project, taskId);
  const waiting =
    !!snapshot.data?.runtime?.pendingPermissions?.length ||
    !!snapshot.data?.runtime?.pendingElicitations?.length;
  const running =
    snapshot.data?.meta.status === "running" ||
    !!snapshot.data?.runtime?.pendingCommands?.length ||
    waiting;
  useEffect(() => {
    const receipt = read(storageKey);
    let saved = "";
    try {
      saved = sessionStorage.getItem(`${storageKey}:draft`) || "";
    } catch {
      /* Keep recoverable submitted text below. */
    }
    setDraft(saved || (receipt && !receipt.accepted ? receipt.text : ""));
    setStopping(Boolean(receipt?.stopRequested));
  }, [storageKey]);
  useEffect(() => {
    const state = snapshot.data;
    if (!state) return;
    const receipt = read(storageKey);
    const settled =
      !receipt?.stopRequested || state.stoppedRequestId === receipt.requestId;
    if (
      receipt &&
      state.admittedRequestId === receipt.requestId &&
      !running &&
      settled
    ) {
      localStorage.removeItem(storageKey);
      if (receipt.draft && clearSubmittedAgentDraft(receipt.draft))
        setDraft((current) => (current === receipt.draft?.text ? "" : current));
    }
    if (!running && !stopPending.current && settled) setStopping(false);
  }, [snapshot.data, storageKey, running]);
  const connect = () =>
    void run(async () => {
      if (!projectOpen)
        throw new Error(
          "请先打开一个本地项目，准备当前渠道目录后再连接远程项目。",
        );
      const id = `remote_${crypto.randomUUID().replace(/-/g, "")}`;
      const target =
        kind === "wsl"
          ? { kind, distro: host || undefined, user: username || undefined }
          : {
              kind,
              host: host.trim(),
              ...(username.trim() ? { username: username.trim() } : {}),
              sshConfigAlias: host.trim(),
              ...(port ? { port: Number(port) } : {}),
              ...(password ? { password } : {}),
              ...(privateKey ? { privateKeyPath: privateKey } : {}),
            };
      if (kind === "ssh" && !host.trim())
        throw new Error("请填写主机或 SSH 配置别名");
      if (
        port &&
        (!Number.isInteger(Number(port)) ||
          Number(port) < 1 ||
          Number(port) > 65535)
      )
        throw new Error("端口必须在 1–65535 之间");
      try {
        const connected = await agentApi.remote<Connection>("connect", [
          { id, target },
        ]);
        setRemoteId(connected.id);
        setProject("");
        setTaskId("");
        connections.reload();
      } catch (cause) {
        throw new Error(
          password
            ? agentErrorMessage(cause).split(password).join("[已隐藏]")
            : agentErrorMessage(cause),
        );
      } finally {
        setPassword("");
      }
    });
  const openProject = () =>
    void run(async () => {
      if (!remoteId || !directory.startsWith("/"))
        throw new Error(
          "远程目录须以 / 开头。当前支持 Linux x64 / 对应 WSL（glibc 2.34+），暂不支持 Windows 远端、macOS 或其他架构。",
        );
      const initialized = await agentApi.native<{
        available: boolean;
        reason?: string;
      }>("IZCodeAgentService", "initialize", [{ workspacePath: directory }], {
        remoteId,
      });
      if (initialized.available === false)
        throw new Error(initialized.reason || "远程运行时不可用");
      const view = await agentApi.native<{
        providers: {
          providerId: string;
          providerName: string;
          models: {
            modelId: string;
            config?: {
              enabled?: boolean;
              optionSpecs?: {
                reasoningLevel?: { values?: string[]; default?: string };
              };
            };
          }[];
        }[];
      }>("IModelSelectionService", "getView", [], { remoteId });
      const allowed = new Set(catalog.models.map((model) => model.modelId));
      const available = view.providers.flatMap((provider) =>
        provider.models
          .filter(
            (model) =>
              model.config?.enabled !== false && allowed.has(model.modelId),
          )
          .map((model) => {
            const entry = catalog.models.find(
              (item) => item.modelId === model.modelId,
            );
            const spec = model.config?.optionSpecs?.reasoningLevel;
            const values = spec?.values?.length
              ? spec.values
              : catalog.models.find((item) => item.modelId === model.modelId)
                  ?.reasoningEfforts;
            return {
              providerId: provider.providerId,
              modelId: model.modelId,
              label: entry
                ? `${entry.channelName} · ${entry.name}`
                : `${provider.providerName} · ${model.modelId}`,
              reasoningLevel:
                spec?.default && values?.includes(spec.default)
                  ? spec.default
                  : values?.[0] || "default",
            };
          }),
      );
      setModels(available);
      setModelId(
        available[0]
          ? JSON.stringify([available[0].providerId, available[0].modelId])
          : "",
      );
      setProject(directory);
      setTaskId("");
    });
  const create = () =>
    void run(async () => {
      const model = models.find(
        (item) => JSON.stringify([item.providerId, item.modelId]) === modelId,
      );
      if (!model) throw new Error("远程没有可用的渠道模型，请重新连接后重试");
      const task = await native<{ taskId: string }>("createTask", [
        {
          workspacePath: project,
          mode: "build",
          v4Create: true,
          deferPersistenceUntilFirstPrompt: true,
          modelSelection: {
            providerId: model.providerId,
            modelId: model.modelId,
            options: { reasoningLevel: model.reasoningLevel },
          },
        },
      ]);
      setTaskId(task.taskId);
      setFreshTaskId(task.taskId);
      tasks.reload();
    });
  const send = () =>
    void run(async () => {
      const old = read(storageKey);
      const text = draft.trim();
      if (!text) return;
      if (old && old.text !== text)
        throw new Error("上次输入尚未确认，只能按原内容和编号重试。");
      const draftToken = captureAgentDraft(`${storageKey}:draft`, draft);
      const receipt = old || {
        requestId: `remote_${crypto.randomUUID()}`,
        text,
        draft: draftToken,
      };
      localStorage.setItem(storageKey, JSON.stringify(receipt));
      try {
        await native("sendPrompt", [
          {
            taskId,
            workspacePath: project,
            traceId: receipt.requestId,
            messageId: receipt.requestId,
            content: text,
            clientMode: "desktop-continuous",
          },
        ]);
      } finally {
        setFreshTaskId("");
      }
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({ ...(read(storageKey) || receipt), accepted: true }),
        );
      } catch {
        /* Keep the original request identity. */
      }
      if (clearSubmittedAgentDraft(draftToken))
        setDraft((current) => (current === draftToken.text ? "" : current));
      snapshot.reload();
    });
  const stop = async () => {
    if (stopPending.current) return;
    stopPending.current = true;
    setStopping(true);
    setLocalError(null);
    try {
      const receipt = read(storageKey);
      if (receipt)
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            ...receipt,
            stopRequested: true,
            stopAcknowledged: false,
          }),
        );
      await native("stopGeneration", [{ taskId, workspacePath: project }]);
      if (receipt) {
        const latest = read(storageKey);
        if (latest?.requestId === receipt.requestId)
          localStorage.setItem(
            storageKey,
            JSON.stringify({
              ...latest,
              stopAcknowledged: true,
              stoppedAfterAdmission:
                snapshot.data?.admittedRequestId === receipt.requestId,
            }),
          );
      }
      snapshot.reload();
    } catch (cause) {
      setLocalError(agentErrorMessage(cause));
      setStopping(false);
    } finally {
      stopPending.current = false;
    }
  };
  const respond = (
    request: Permission,
    option: Permission["options"][number],
  ) =>
    void run(async () => {
      const answered = await native<boolean>("respondPermission", [
        {
          taskId,
          workspacePath: project,
          requestId: request.requestId,
          runId: request.traceId,
          optionId: option.optionId,
          response: option.response,
        },
      ]);
      if (!answered) throw new Error("请求已变化，请刷新远程会话");
      snapshot.reload();
    });
  return (
    <div className="space-y-4">
      <p className="text-caption text-fg-3">
        远程项目与会话在此面板中操作。连接使用原生 SSH / WSL
        和独立远端运行目录，当前提供 Linux x64 / 对应 WSL 运行组件（glibc
        2.34+）；Windows 远端、macOS、其他架构暂不可用。主聊天仍显示本地项目。
        连接期间沿用当前模型目录，渠道变更后请断开再重新连接。
      </p>
      <OperationError>
        {localError ||
          error ||
          connections.error ||
          tasks.error ||
          snapshot.error}
      </OperationError>
      <div className="flex flex-wrap gap-2">
        <Button variant="neutral" disabled={busy} onClick={connections.reload}>
          刷新连接
        </Button>
        <Button
          variant="neutral"
          disabled={busy}
          onClick={() =>
            void run(async () =>
              setDistros(await agentApi.remote<{ name: string }[]>("listWSL")),
            )
          }
        >
          发现 WSL 发行版
        </Button>
      </div>
      {connections.data?.map((connection) => (
        <div
          key={connection.id}
          className="flex flex-wrap items-center gap-2 rounded-control border p-3"
        >
          <span className="min-w-0 flex-1 break-all text-caption">
            {connection.kind.toUpperCase()} · {connection.id} ·{" "}
            {connection.state === "connected" ? "已连接" : "连接中"}
          </span>
          <Button
            variant="neutral"
            disabled={busy || connection.state !== "connected"}
            onClick={() => {
              setRemoteId(connection.id);
              setProject("");
              setTaskId("");
            }}
          >
            选择连接
          </Button>
          <Button
            variant="quiet"
            disabled={busy || running}
            onClick={() =>
              void run(async () => {
                await agentApi.remote("disconnect", [connection.id]);
                if (remoteId === connection.id) {
                  setRemoteId("");
                  setProject("");
                  setTaskId("");
                }
                connections.reload();
              })
            }
          >
            断开
          </Button>
        </div>
      ))}
      <form
        className="space-y-3 rounded-control border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          connect();
        }}
      >
        <h3 className="font-medium">连接远程环境</h3>
        <label className="block text-caption">
          方式
          <select
            aria-label="远程连接方式"
            className={fieldClass}
            value={kind}
            disabled={busy}
            onChange={(event) => {
              setKind(event.target.value as typeof kind);
              setHost("");
            }}
          >
            <option value="ssh">SSH</option>
            <option value="wsl">WSL</option>
          </select>
        </label>
        {kind === "ssh" ? (
          <>
            <label className="block text-caption">
              主机或 SSH 配置别名
              <Input
                aria-label="SSH 主机或别名"
                value={host}
                disabled={busy}
                onChange={(event) => setHost(event.target.value)}
              />
            </label>
            <label className="block text-caption">
              端口（留空使用 SSH 配置）
              <Input
                aria-label="SSH 端口"
                value={port}
                disabled={busy}
                onChange={(event) => setPort(event.target.value)}
              />
            </label>
            <label className="block text-caption">
              私钥路径（可选）
              <Input
                aria-label="SSH 私钥路径"
                value={privateKey}
                disabled={busy}
                onChange={(event) => setPrivateKey(event.target.value)}
              />
            </label>
            <label className="block text-caption">
              密码（可选，仅用于本次连接）
              <Input
                type="password"
                aria-label="SSH 密码"
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </>
        ) : (
          <label className="block text-caption">
            发行版
            <select
              aria-label="WSL 发行版"
              className={fieldClass}
              value={host}
              disabled={busy}
              onChange={(event) => setHost(event.target.value)}
            >
              <option value="">默认发行版</option>
              {distros.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block text-caption">
          用户名（可选）
          <Input
            aria-label="远程用户名"
            value={username}
            disabled={busy}
            onChange={(event) => setUsername(event.target.value)}
          />
        </label>
        <Button type="submit" disabled={busy || !projectOpen}>
          连接环境
        </Button>
        {!projectOpen && (
          <p className="text-caption text-fg-3">
            先打开本地项目以准备渠道模型。
          </p>
        )}
      </form>
      {remoteId && (
        <section className="space-y-3 rounded-control border p-3">
          <h3 className="font-medium">远程项目</h3>
          <label className="block text-caption">
            远程工作目录
            <Input
              aria-label="远程工作目录"
              value={directory}
              disabled={busy}
              placeholder="/home/user/project"
              onChange={(event) => setDirectory(event.target.value)}
            />
          </label>
          <Button
            variant="neutral"
            disabled={busy || !directory.trim()}
            onClick={openProject}
          >
            打开远程项目
          </Button>
          {project && (
            <>
              <p className="break-all text-caption">{project}</p>
              <select
                aria-label="远程模型"
                className={fieldClass}
                value={modelId}
                disabled={busy}
                onChange={(event) => setModelId(event.target.value)}
              >
                {models.map((model) => (
                  <option
                    key={JSON.stringify([model.providerId, model.modelId])}
                    value={JSON.stringify([model.providerId, model.modelId])}
                  >
                    {model.label}
                  </option>
                ))}
              </select>
              <Button disabled={busy || !models.length} onClick={create}>
                新建远程会话
              </Button>
              <select
                aria-label="远程会话"
                className={fieldClass}
                value={taskId}
                disabled={busy}
                onChange={(event) => setTaskId(event.target.value)}
              >
                <option value="">选择会话</option>
                {tasks.data?.map((task) => (
                  <option key={task.taskId} value={task.taskId}>
                    {task.title || task.taskId}
                  </option>
                ))}
              </select>
              {taskId &&
                !tasks.data?.some((task) => task.taskId === taskId) && (
                  <p className="text-caption">当前会话：{taskId}</p>
                )}
            </>
          )}
        </section>
      )}
      {taskId && (
        <section className="space-y-3" aria-label="远程会话内容">
          <p role="status" className="text-caption">
            {waiting
              ? "远程任务等待你的回应"
              : running
                ? "远程任务执行中"
                : freshTaskId === taskId
                  ? "尚未发送的远程草稿，首次发送后保存。"
                  : read(storageKey)
                    ? "输入接收状态确认中；停止后会等待该输入的真实终态。"
                    : snapshot.loading && !snapshot.data
                      ? "正在读取远程会话…"
                      : "远程会话已就绪"}
          </p>
          <div className="max-h-72 space-y-3 overflow-auto rounded-control border p-3">
            {snapshot.data?.messages.map((message, index) => (
              <div key={message.id || index}>
                <p className="text-caption font-medium">
                  {message.role === "user" ? "你" : "LoliCode · 远程"}
                </p>
                <pre className="whitespace-pre-wrap break-words text-body">
                  {message.content}
                </pre>
              </div>
            ))}
          </div>
          {snapshot.data?.runtime?.pendingPermissions?.map((request) => (
            <section
              key={request.requestId}
              className="space-y-2 rounded-control border p-3"
            >
              <h4 className="font-medium">远程请求许可</h4>
              <p className="whitespace-pre-wrap text-caption">
                {request.description}
              </p>
              {permissionDetails(request) && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-control border p-3 text-caption">
                  {permissionDetails(request)}
                </pre>
              )}
              <div className="flex flex-wrap gap-2">
                {request.options.map((option) => (
                  <Button
                    key={option.optionId}
                    variant="neutral"
                    disabled={busy}
                    onClick={() => respond(request, option)}
                  >
                    {option.name}
                  </Button>
                ))}
              </div>
            </section>
          ))}
          {snapshot.data?.runtime?.pendingElicitations?.map((request) => (
            <div key={request.requestId} className="space-y-2">
              {request.schema?.interaction === "plan_approval" &&
                typeof request.schema.plan === "string" && (
                  <section
                    className="rounded-control border p-3"
                    aria-label="待批准的远程计划"
                  >
                    <h4 className="font-medium">待批准的计划</h4>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-caption">
                      {request.schema.plan}
                    </pre>
                  </section>
                )}
              <AgentQuestionCard
                question={questionDto(taskId, request)}
                onReply={async (answer) => {
                  const content: Record<string, unknown> = { ...answer };
                  for (const [name, field] of Object.entries(
                    request.schema?.properties || {},
                  )) {
                    if (
                      (field.type === "array" || field.type === "object") &&
                      typeof content[name] === "string"
                    ) {
                      const parsed: unknown = JSON.parse(
                        content[name] as string,
                      );
                      if (
                        field.type === "array"
                          ? !Array.isArray(parsed)
                          : !parsed ||
                            typeof parsed !== "object" ||
                            Array.isArray(parsed)
                      )
                        throw new Error(
                          `${field.title || name} 的 JSON 类型不正确`,
                        );
                      content[name] = parsed;
                    }
                  }
                  const answered = await native<boolean>("respondElicitation", [
                    {
                      taskId,
                      workspacePath: project,
                      requestId: request.requestId,
                      runId: request.traceId,
                      action: "accept",
                      content,
                      clientMode: "desktop-continuous",
                    },
                  ]);
                  if (!answered) throw new Error("问题已变化，请刷新远程会话");
                  snapshot.reload();
                }}
                onReject={async () => {
                  const answered = await native<boolean>("respondElicitation", [
                    {
                      taskId,
                      workspacePath: project,
                      requestId: request.requestId,
                      runId: request.traceId,
                      action: "cancel",
                      clientMode: "desktop-continuous",
                    },
                  ]);
                  if (!answered) throw new Error("问题已变化，请刷新远程会话");
                  snapshot.reload();
                }}
              />
            </div>
          ))}
          <textarea
            aria-label="远程任务内容"
            className={fieldClass}
            rows={3}
            value={draft}
            disabled={busy}
            onChange={(event) => {
              saveAgentDraft(`${storageKey}:draft`, event.target.value);
              setDraft(event.target.value);
            }}
          />
          <div className="flex gap-2">
            <Button
              disabled={
                busy ||
                running ||
                stopping ||
                !draft.trim() ||
                (!snapshot.data && freshTaskId !== taskId && !read(storageKey))
              }
              onClick={send}
            >
              发送到远程会话
            </Button>
            <Button
              variant="neutral"
              disabled={stopping || (!snapshot.data && !read(storageKey))}
              onClick={() => void stop()}
            >
              停止远程任务
            </Button>
            <Button variant="quiet" onClick={snapshot.reload}>
              刷新会话
            </Button>
          </div>
          <p className="text-caption text-fg-3">
            远程内容按原生任务快照刷新；远程文件路径以文本显示，不会读取本机同名文件。
          </p>
        </section>
      )}
    </div>
  );
}
