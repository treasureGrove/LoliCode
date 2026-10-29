import { useEffect, useRef, useState } from "react";
import { FolderOpen, RefreshCw, Server, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, fieldClass } from "@/components/ui/input";
import { agentApi } from "@/lib/api/agent";
import {
  OperationError,
  useAgentOperation,
  useAgentResource,
} from "./AgentOperationShared";

type Target =
  | {
      kind: "ssh";
      host: string;
      port?: number;
      username?: string;
      identityFile?: string;
    }
  | { kind: "wsl"; distribution: string; username?: string };
type Connection = {
  id: string;
  name: string;
  target: Target;
  enabled: boolean;
};
type RemoteProject = {
  id: string;
  connectionId: string;
  name: string;
  root: string;
  path: string;
};
type RemoteList = { connections: Connection[]; projects: RemoteProject[] };

export function AgentRemotePanel({
  onOpenProject,
}: {
  onOpenProject?: (path: string) => void | Promise<void>;
}) {
  const operation = useAgentOperation();
  const list = useAgentResource<RemoteList>(
    "native-remote-projects",
    () => agentApi.remote("list"),
    0,
  );
  const [kind, setKind] = useState<"ssh" | "wsl">("ssh");
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [port, setPort] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [selected, setSelected] = useState("");
  const [root, setRoot] = useState("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const wsl = useAgentResource<string[]>(
    kind === "wsl" ? "native-wsl-distributions" : "",
    () => agentApi.remote("listWSL"),
    0,
  );
  const connections = list.data?.connections || [];
  const connection = connections.find((c) => c.id === selected);
  useEffect(() => {
    if (!list.data) return;
    setSelected((id) =>
      connections.some((c) => c.id === id) ? id : connections[0]?.id || "",
    );
  }, [list.data]);
  const mutate = async (method: string, args: unknown[]) => {
    await operation.run(async () => {
      await agentApi.remote(method, args);
      if (mounted.current) list.reload();
    });
  };
  const openSaved = (project: RemoteProject) =>
    operation.run(async () => {
      const opened = await agentApi.remote<RemoteProject>("openProject", [
        project.connectionId,
        project.root,
      ]);
      if (mounted.current) await onOpenProject?.(opened.path);
    });
  return (
    <div className="space-y-5">
      <p className="wb-extension-hint">
        远程项目在主工作台中对话，模型、记忆和账户配置共用。SSH
        使用系统配置或密钥文件；首次连接请先在终端确认主机指纹。远端需要 Python
        3.9+。
      </p>
      <OperationError>{operation.error || list.error}</OperationError>
      <section
        className="space-y-3 rounded-xl border border-border p-4"
        aria-label="添加远程连接"
      >
        <h3 className="font-medium">添加连接</h3>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            void operation.run(async () => {
              const optional = username.trim()
                ? { username: username.trim() }
                : {};
              const target: Target =
                kind === "ssh"
                  ? {
                      kind,
                      host: host.trim(),
                      ...optional,
                      ...(port ? { port: Number(port) } : {}),
                      ...(identityFile.trim()
                        ? { identityFile: identityFile.trim() }
                        : {}),
                    }
                  : { kind, distribution: host.trim(), ...optional };
              const saved = await agentApi.remote<Connection>("connect", [
                { name: name.trim() || host.trim(), target },
              ]);
              if (mounted.current) {
                setSelected(saved.id);
                list.reload();
              }
            });
          }}
        >
          <label className="space-y-1 text-caption">
            连接类型
            <select
              className={fieldClass}
              aria-label="远程连接类型"
              value={kind}
              disabled={operation.busy}
              onChange={(e) => {
                setKind(e.target.value as "ssh" | "wsl");
                setHost("");
              }}
            >
              <option value="ssh">SSH</option>
              <option value="wsl">WSL</option>
            </select>
          </label>
          <label className="space-y-1 text-caption">
            显示名称
            <Input
              aria-label="远程连接名称"
              value={name}
              maxLength={128}
              disabled={operation.busy}
              placeholder="例如：开发服务器"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="space-y-1 text-caption sm:col-span-2">
            {kind === "ssh" ? "SSH 主机或别名" : "WSL 发行版"}
            <Input
              aria-label={kind === "ssh" ? "SSH 主机或别名" : "WSL 发行版"}
              list={kind === "wsl" ? "native-wsl-names" : undefined}
              value={host}
              required
              disabled={operation.busy}
              placeholder={
                kind === "ssh" ? "my-dev-server 或 example.com" : "Ubuntu"
              }
              onChange={(e) => setHost(e.target.value)}
            />
          </label>
          {kind === "wsl" && (
            <div className="sm:col-span-2">
              <datalist id="native-wsl-names">
                {wsl.data?.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <OperationError>{wsl.error}</OperationError>
            </div>
          )}
          <details className="sm:col-span-2">
            <summary className="cursor-pointer text-caption text-fg-3">
              高级连接选项
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-caption">
                用户名
                <Input
                  aria-label="远程用户名"
                  value={username}
                  disabled={operation.busy}
                  placeholder="使用系统配置"
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              {kind === "ssh" && (
                <>
                  <label className="space-y-1 text-caption">
                    端口
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      aria-label="SSH 端口"
                      value={port}
                      disabled={operation.busy}
                      placeholder="使用系统配置"
                      onChange={(e) => setPort(e.target.value)}
                    />
                  </label>
                  <label className="space-y-1 text-caption sm:col-span-2">
                    私钥文件路径
                    <Input
                      aria-label="SSH 私钥文件路径"
                      value={identityFile}
                      disabled={operation.busy}
                      placeholder="使用 ssh-agent 或系统配置；可填写绝对路径"
                      onChange={(e) => setIdentityFile(e.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
          </details>
          <Button
            type="submit"
            disabled={operation.busy || !host.trim()}
            className="sm:col-span-2"
          >
            {operation.busy ? "正在处理…" : "验证并保存连接"}
          </Button>
        </form>
      </section>
      <section className="space-y-3" aria-label="远程工程">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">连接与工程</h3>
          <Button
            variant="ghost"
            size="sm"
            disabled={operation.busy || list.loading}
            onClick={list.reload}
          >
            <RefreshCw size={14} />
            刷新连接
          </Button>
        </div>
        {list.loading && !list.data && <p role="status">正在读取连接…</p>}
        {!list.loading && !connections.length && (
          <p className="text-caption text-fg-3">还没有保存的远程连接。</p>
        )}
        {connections.map((c) => (
          <div
            key={c.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
          >
            <button
              type="button"
              aria-pressed={selected === c.id}
              disabled={operation.busy}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => setSelected(c.id)}
            >
              {c.target.kind === "ssh" ? (
                <Server size={16} />
              ) : (
                <Terminal size={16} />
              )}
              <span className="truncate">{c.name}</span>
              <span className="text-caption text-fg-3">
                {c.enabled ? "已保存" : "已断开"}
              </span>
            </button>
            <Button
              variant="ghost"
              size="sm"
              disabled={operation.busy}
              onClick={() => void mutate("reconnect", [c.id])}
            >
              {c.enabled ? "检查连接" : "重新连接"}
            </Button>
            {c.enabled && (
              <Button
                variant="ghost"
                size="sm"
                disabled={operation.busy}
                onClick={() => void mutate("disconnect", [c.id])}
              >
                断开
              </Button>
            )}
          </div>
        ))}
        {connection && (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void operation.run(async () => {
                const project = await agentApi.remote<RemoteProject>(
                  "openProject",
                  [selected, root.trim()],
                );
                if (mounted.current) {
                  list.reload();
                  await onOpenProject?.(project.path);
                }
              });
            }}
          >
            <Input
              aria-label="远程项目目录"
              className="min-w-40 flex-1"
              placeholder="绝对目录，例如 /home/user/project"
              value={root}
              disabled={operation.busy || !connection.enabled}
              required
              onChange={(e) => setRoot(e.target.value)}
            />
            <Button
              type="submit"
              disabled={
                operation.busy ||
                !connection.enabled ||
                !root.trim() ||
                !onOpenProject
              }
            >
              <FolderOpen size={15} />
              在工作台打开
            </Button>
          </form>
        )}
        {list.data?.projects
          .filter((p) => p.connectionId === selected)
          .map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate">{p.name}</p>
                <p className="truncate text-caption text-fg-3" title={p.root}>
                  {p.root}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  operation.busy || !connection?.enabled || !onOpenProject
                }
                onClick={() => void openSaved(p)}
              >
                打开工程
              </Button>
            </div>
          ))}
      </section>
    </div>
  );
}
