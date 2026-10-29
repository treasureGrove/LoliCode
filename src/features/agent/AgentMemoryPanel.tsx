import { useEffect, useId, useRef, useState } from "react";
import { BUILTIN_AGENT_NAME, BUILTIN_AGENT_NICKNAME } from "@/lib/branding";
import {
  Brain,
  RefreshCw,
  Trash2,
  Pencil,
  Check,
  X,
  Plus,
  LoaderCircle,
} from "lucide-react";
import {
  agentMemoryApi,
  type AgentMemoryEntry,
  type AgentMemoryScope,
  type AgentMemorySnapshot,
} from "@/lib/api/agent-memory";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAgentToolDraft } from "./AgentToolDrafts";
import "./agent-memory-panel.css";

/** Main-Agent memory surface. Can be embedded in a settings dialog or app panel. */
export function AgentMemoryPanel({
  projectPath,
  onClose,
  embedded = false,
}: {
  projectPath?: string;
  /** The host already provides the page heading. */
  embedded?: boolean;
  /**
   * Renders a close affordance when the panel is hosted in a dismissable
   * surface (for example a Dialog). Omit it for embedded, non-dismissable use.
   */
  onClose?: () => void;
}) {
  const [memory, setMemory] = useState<AgentMemorySnapshot>();
  const draftKey = `memory:${projectPath ?? ""}`;
  const [scope, setScope] = useAgentToolDraft<AgentMemoryScope>(
    `${draftKey}:scope`,
    "user",
  );
  const [content, setContent] = useAgentToolDraft(`${draftKey}:content`, "");
  const [editing, setEditing] = useAgentToolDraft<AgentMemoryEntry | undefined>(
    `${draftKey}:editing`,
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [clearPending, setClearPending] = useState(false);
  const generation = useRef(0);
  const scopeId = useId();

  useEffect(() => {
    let alive = true;
    generation.current += 1;
    setMemory(undefined);
    setError("");
    setBusy(false);
    setClearPending(false);
    void agentMemoryApi
      .get(projectPath)
      .then((value) => {
        if (alive) setMemory(value);
      })
      .catch((reason) => {
        if (alive) setError(String(reason));
      });
    return () => {
      alive = false;
      generation.current += 1;
    };
  }, [projectPath]);

  async function perform(operation: () => Promise<AgentMemorySnapshot>) {
    if (busy) return;
    setBusy(true);
    setError("");
    const started = generation.current;
    try {
      const value = await operation();
      if (started !== generation.current) return false;
      setMemory(value);
      return true;
    } catch (reason) {
      if (started === generation.current) setError(String(reason));
      return false;
    } finally {
      if (started === generation.current) setBusy(false);
    }
  }
  function changeScope(value: AgentMemoryScope) {
    setScope(value);
    setContent("");
    setEditing(undefined);
    setClearPending(false);
  }
  const store = memory?.[scope];
  const usedPercent = store?.limit
    ? Math.min(100, (store.used / store.limit) * 100)
    : 0;

  return (
    <section
      className={`wb-memory${embedded ? " wb-memory-embedded" : ""}`}
      aria-label="主 Agent 记忆"
    >
      <header className="wb-memory-header">
        <div>
          {!embedded && (
            <>
              <h2 className="flex items-center gap-2 text-lg font-semibold">
                <Brain className="h-5 w-5" />
                Agent 记忆
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                记住你的偏好和项目约定，跨会话继续使用。
              </p>
            </>
          )}
          <p className="wb-memory-character">
            默认角色：{BUILTIN_AGENT_NAME}（{BUILTIN_AGENT_NICKNAME}
            ）。内置预设可编辑或删除，修改后不会自动恢复。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label="刷新记忆"
            disabled={busy}
            onClick={() => void perform(() => agentMemoryApi.get(projectPath))}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭记忆面板"
              title="关闭记忆面板"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      </header>
      {error && (
        <div className="wb-memory-error">
          <p role="alert">{error}</p>
          {!memory && (
            <Button
              variant="neutral"
              disabled={busy}
              onClick={() =>
                void perform(() => agentMemoryApi.get(projectPath))
              }
            >
              重新读取记忆
            </Button>
          )}
        </div>
      )}
      {!memory && !error && (
        <div className="wb-memory-loading" role="status">
          <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
          正在读取记忆…
        </div>
      )}
      {memory && (
        <>
          <div className="wb-memory-settings">
            <div className="wb-memory-setting">
              <div>
                <div className="text-sm font-medium">启用记忆</div>
                <div className="text-xs text-muted-foreground">
                  关闭后停止读取和自动写入，已有内容保留。
                </div>
              </div>
              <Switch
                aria-label="启用记忆"
                checked={memory.enabled}
                disabled={busy}
                onCheckedChange={(enabled) =>
                  void perform(() =>
                    agentMemoryApi.configure(
                      { revision: memory.revision, enabled },
                      projectPath,
                    ),
                  )
                }
              />
            </div>
            <div className="wb-memory-setting">
              <div>
                <div className="text-sm font-medium">写入前确认</div>
                <div className="text-xs text-muted-foreground">
                  Agent 更新记忆时询问；完整权限会沿用你的授权。
                </div>
              </div>
              <Switch
                aria-label="写入前确认"
                checked={memory.requireApproval}
                disabled={busy || !memory.enabled}
                onCheckedChange={(requireApproval) =>
                  void perform(() =>
                    agentMemoryApi.configure(
                      { revision: memory.revision, requireApproval },
                      projectPath,
                    ),
                  )
                }
              />
            </div>
          </div>
          <div className="wb-memory-layout">
            <div className="wb-memory-library">
              <div className="wb-memory-library-heading">
                <div
                  className="wb-memory-tabs"
                  role="tablist"
                  aria-label="记忆范围"
                >
                  <Button
                    role="tab"
                    id={`${scopeId}-user`}
                    aria-controls={`${scopeId}-entries`}
                    aria-selected={scope === "user"}
                    variant={scope === "user" ? "secondary" : "ghost"}
                    disabled={busy}
                    onClick={() => changeScope("user")}
                  >
                    用户偏好
                  </Button>
                  <Button
                    role="tab"
                    id={`${scopeId}-project`}
                    aria-controls={`${scopeId}-entries`}
                    aria-selected={scope === "project"}
                    variant={scope === "project" ? "secondary" : "ghost"}
                    onClick={() => changeScope("project")}
                    disabled={busy || !memory.projectPath}
                  >
                    当前项目
                  </Button>
                </div>
                <span className="wb-memory-count">
                  {store?.entries.length ?? 0} 条记忆
                </span>
              </div>
              <div className="wb-memory-capacity">
                <div className="wb-memory-capacity-label">
                  <span>
                    {scope === "user"
                      ? "用户偏好会在所有项目中使用"
                      : "仅在当前项目中使用"}
                  </span>
                  <span>
                    {store?.used} / {store?.limit} 字符
                  </span>
                </div>
                <div
                  className="wb-memory-capacity-track"
                  role="meter"
                  aria-label="记忆容量"
                  aria-valuemin={0}
                  aria-valuemax={store?.limit ?? 0}
                  aria-valuenow={store?.used ?? 0}
                  aria-valuetext={`${store?.used ?? 0} / ${store?.limit ?? 0} 字符`}
                >
                  <span style={{ width: `${usedPercent}%` }} />
                </div>
              </div>
              <div
                className="wb-memory-entries"
                role="tabpanel"
                id={`${scopeId}-entries`}
                aria-labelledby={`${scopeId}-${scope}`}
              >
                {store?.entries.length === 0 && (
                  <div className="wb-memory-empty">
                    <Brain className="h-7 w-7" aria-hidden="true" />
                    <h3>让下一次对话更懂你</h3>
                    <p>还没有记忆，可以在这里添加，或让 Agent 记住一条偏好。</p>
                  </div>
                )}
                {store?.entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="wb-memory-entry"
                    data-editing={editing?.id === entry.id || undefined}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="whitespace-pre-wrap break-words text-sm">
                        {entry.content}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        {entry.source === "preset:sillyDog:v1"
                          ? "内置预设"
                          : entry.source === "user"
                            ? "手动添加"
                            : "Agent 记录"}{" "}
                        · {new Date(entry.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="wb-memory-entry-actions">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="编辑记忆"
                        disabled={busy}
                        onClick={() => {
                          setEditing(entry);
                          setContent(entry.content);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="删除记忆"
                        disabled={busy}
                        onClick={() =>
                          void perform(() =>
                            agentMemoryApi.edit(
                              {
                                revision: memory.revision,
                                scope,
                                action: "remove",
                                old_text: entry.content,
                              },
                              projectPath,
                            ),
                          )
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <form
              className="wb-memory-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void (async () => {
                  if (
                    await perform(() =>
                      agentMemoryApi.edit(
                        {
                          revision: memory.revision,
                          scope,
                          action: editing ? "patch" : "add",
                          ...(editing ? { old_text: editing.content } : {}),
                          content,
                        },
                        projectPath,
                      ),
                    )
                  ) {
                    setContent("");
                    setEditing(undefined);
                  }
                })();
              }}
            >
              <div className="wb-memory-editor-heading">
                <span className="wb-memory-editor-icon">
                  {editing ? <Pencil size={16} /> : <Plus size={16} />}
                </span>
                <h3>{editing ? "编辑这条记忆" : "添加一条记忆"}</h3>
              </div>
              <p className="wb-memory-editor-description">
                {scope === "user"
                  ? "记录你的习惯和偏好，让所有项目中的对话沿用。"
                  : "记录技术栈、代码规范或项目背景，供当前项目使用。"}
              </p>
              <textarea
                aria-label={editing ? "编辑记忆内容" : "添加记忆内容"}
                className="wb-memory-textarea"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder={
                  scope === "user"
                    ? "例如：默认用中文回答，先给结论。"
                    : "例如：使用 pnpm，提交前运行类型检查。"
                }
                maxLength={store?.limit}
                disabled={busy}
              />
              <div className="wb-memory-editor-footer">
                <span>{content.length} 字符</span>
                <div className="flex items-center gap-2">
                  {editing && (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setEditing(undefined);
                        setContent("");
                      }}
                    >
                      <X className="mr-1 h-4 w-4" />
                      取消
                    </Button>
                  )}
                  <Button type="submit" disabled={busy || !content.trim()}>
                    <Check className="mr-1 h-4 w-4" />
                    {editing ? "保存修改" : "添加记忆"}
                  </Button>
                </div>
              </div>
            </form>
          </div>
          <footer className="wb-memory-footer">
            <p className="text-xs leading-relaxed text-muted-foreground">
              记忆只保存在本机。不会保存 API
              Key、口令或令牌。启用后，当前项目事实与用户偏好会随模型请求发送；更改在下一次模型请求生效。
            </p>
            {clearPending ? (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span>清除全部用户和所有项目记忆？</span>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setClearPending(false)}
                  >
                    取消
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        if (
                          await perform(() =>
                            agentMemoryApi.clear(
                              memory.revision,
                              "all",
                              projectPath,
                            ),
                          )
                        ) {
                          setClearPending(false);
                          setEditing(undefined);
                          setContent("");
                        }
                      })()
                    }
                  >
                    确认清除
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="ghost"
                className="text-muted-foreground"
                disabled={busy}
                onClick={() => setClearPending(true)}
              >
                <Trash2 className="mr-1 h-4 w-4" />
                清除全部记忆
              </Button>
            )}
          </footer>
        </>
      )}
    </section>
  );
}
