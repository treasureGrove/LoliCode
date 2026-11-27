import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ChevronRight, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAgentNativeSession } from "@/hooks/useAgentNativeSession";
import { agentApi } from "@/lib/api/agent";
import type { AgentNativeSessionRead } from "@/types/harness-session";
import {
  AgentNativeTranscript,
  hasNativeTranscriptContent,
} from "./AgentNativeTranscript";

type Projections = Extract<
  AgentNativeSessionRead["projections"],
  { kind: "sequenced" }
>;
type CatalogMode = "one-shot" | "continuable" | "external" | "unknown";
type Child = { id: string; label: string; mode: CatalogMode };
const modeLabels = {
  "one-shot": "单次任务",
  continuable: "可继续的子代理",
  external: "外部执行",
  unknown: "会话类型未知",
};
const canOpen = ({ mode }: Child) =>
  mode === "one-shot" || mode === "continuable";
const appRegion = { WebkitAppRegion: "no-drag" } as CSSProperties;

function childrenFromCatalog(projections?: Projections): Child[] {
  const catalog = projections?.values.subagentCatalog;
  if (!Array.isArray(catalog)) return [];
  const children = new Map<string, Child>();
  for (const entry of catalog) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { id, label, name, mode } = entry;
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
      (mode !== "one-shot" &&
        mode !== "continuable" &&
        mode !== "external" &&
        mode !== "unknown")
    )
      continue;
    children.set(id, {
      id: `lc:${id}`,
      label:
        (typeof label === "string" && label.trim()) ||
        (typeof name === "string" && name.trim()) ||
        `子代理 ${id.slice(0, 8)}`,
      mode,
    });
  }
  return [...children.values()];
}

function ChildTranscript({
  rootSessionId,
  childId,
  projectPath,
}: {
  rootSessionId: string;
  childId: string;
  projectPath: string;
}) {
  const native = useAgentNativeSession(childId, { rootSessionId });
  const display = hasNativeTranscriptContent(
    native.events,
    native.activeAttempt,
  );
  return (
    <div className="wb-chat min-h-0">
      <div className="wb-chat-content">
        {native.error && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 text-sm"
          >
            <span>{native.error}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void native.refresh()}
            >
              重新读取
            </Button>
          </div>
        )}
        {!display && !native.error && (
          <p role="status" className="text-sm text-fg-3">
            {native.ready
              ? "暂时没有可显示的会话消息。"
              : "正在读取子代理会话…"}
          </p>
        )}
        {display && (
          <AgentNativeTranscript
            projectPath={projectPath}
            events={native.events}
            activeAttempt={native.activeAttempt}
            hasMore={native.hasMore}
            loadingEarlier={native.loading}
            onLoadOlder={native.loadOlder}
          />
        )}
      </div>
    </div>
  );
}

export function AgentTaskProgress({
  active,
  rootSessionId,
  projectPath,
  projections,
  catalogEventSeq,
  showProgress,
  progressId,
  onJumpToProgress,
}: {
  active: boolean;
  rootSessionId?: string;
  projectPath: string;
  projections: AgentNativeSessionRead["projections"] | undefined;
  catalogEventSeq?: number;
  showProgress: boolean;
  progressId: string;
  onJumpToProgress: () => void;
}) {
  const baseline = projections?.kind === "sequenced" ? projections : undefined;
  const baselineSeq = baseline?.asOfSeq ?? -1;
  const [loaded, setLoaded] = useState<{ root: string; value: Projections }>();
  const [openRoot, setOpenRoot] = useState<string>();
  const [childId, setChildId] = useState<string>();
  const jumpOnClose = useRef(false);
  useEffect(() => {
    if (active && openRoot === rootSessionId) return;
    setOpenRoot(undefined);
    setChildId(undefined);
  }, [active, openRoot, rootSessionId]);
  useEffect(() => {
    if (
      !active ||
      !rootSessionId ||
      catalogEventSeq === undefined ||
      catalogEventSeq <= baselineSeq
    )
      return;
    // Follow only sends projection values in its opening snapshot. A new catalog
    // event asks for the upstream projection without restarting the root observer.
    let obsolete = false;
    void agentApi
      .readSessionNative(rootSessionId, { maxMessages: 1 })
      .then(({ projections }) => {
        if (
          !obsolete &&
          projections?.kind === "sequenced" &&
          projections.asOfSeq >= catalogEventSeq
        )
          setLoaded({ root: rootSessionId, value: projections });
      })
      .catch(() => {
        // The original root history and jump target remain usable during a rollover.
      });
    return () => {
      obsolete = true;
    };
  }, [active, rootSessionId, catalogEventSeq, baselineSeq]);
  const catalog =
    rootSessionId &&
    loaded?.root === rootSessionId &&
    loaded.value.asOfSeq > baselineSeq
      ? loaded.value
      : baseline;
  const children = useMemo(
    () => (rootSessionId ? childrenFromCatalog(catalog) : []),
    [rootSessionId, catalog],
  );
  if (!rootSessionId || !children.length) {
    return showProgress ? (
      <button
        type="button"
        className="wb-task-progress"
        aria-controls={progressId}
        title="查看当前任务进度"
        onClick={onJumpToProgress}
        style={appRegion}
      >
        <ListChecks aria-hidden="true" />
        任务进度
      </button>
    ) : null;
  }
  const open = active && rootSessionId === openRoot;
  const child = open
    ? children.find((entry) => entry.id === childId && canOpen(entry))
    : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpenRoot(next ? rootSessionId : undefined);
        if (!next) setChildId(undefined);
      }}
    >
      <DialogTrigger asChild>
        <button
          type="button"
          className="wb-task-progress"
          title="查看子代理会话"
          style={appRegion}
        >
          <ListChecks aria-hidden="true" />
          任务进度
        </button>
      </DialogTrigger>
      <DialogContent
        className="max-w-3xl"
        onCloseAutoFocus={(event) => {
          if (!jumpOnClose.current) return;
          jumpOnClose.current = false;
          event.preventDefault();
          onJumpToProgress();
        }}
      >
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>子代理会话</DialogTitle>
            <DialogClose asChild>
              <Button type="button" size="sm" variant="quiet">
                关闭
              </Button>
            </DialogClose>
          </div>
          <DialogDescription>
            {child
              ? `正在查看 ${child.label} 的会话记录`
              : "选择子代理查看会话记录。"}
          </DialogDescription>
          {child && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              onClick={() => setChildId(undefined)}
            >
              返回子代理列表
            </Button>
          )}
        </DialogHeader>
        {child ? (
          <div className="lolicode-workbench wb-unified flex min-h-0 flex-col border-t border-border">
            <ChildTranscript
              key={child.id}
              rootSessionId={rootSessionId}
              childId={child.id}
              projectPath={projectPath}
            />
          </div>
        ) : (
          <div className="min-h-0 overflow-y-auto px-6 pb-6">
            <ul className="divide-y divide-border">
              {children.map((entry) => (
                <li key={entry.id} className="py-1">
                  <button
                    type="button"
                    disabled={!canOpen(entry)}
                    onClick={() => setChildId(entry.id)}
                    aria-label={entry.label}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-subtle disabled:text-fg-3 disabled:hover:bg-transparent"
                  >
                    <span className="min-w-0 flex-1 break-words">
                      {entry.label}
                    </span>
                    <span className="text-caption text-fg-3">
                      {modeLabels[entry.mode]}
                    </span>
                    {canOpen(entry) && (
                      <ChevronRight
                        className="size-4 shrink-0"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
            {showProgress && (
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="quiet"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    jumpOnClose.current = true;
                  }}
                >
                  定位到当前进度
                </Button>
              </DialogClose>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
