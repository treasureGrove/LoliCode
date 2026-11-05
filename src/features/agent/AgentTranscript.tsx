import {
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ViewActivityContext } from "@/components/ViewActivityContext";
import { AgentFileActionsContext } from "./AgentFilePath";
import { ChevronRight, CircleAlert, Loader2, Wrench } from "lucide-react";
import type {
  AgentDocumentAttachment,
  AgentImageAttachment,
  AgentMessage,
  AgentPart,
  AgentStatus,
} from "@/types/agent";
import {
  AgentDisclosure,
  createAgentDisclosureState,
  type AgentDisclosureState,
} from "./AgentDisclosure";
import {
  AgentMessageView,
  AgentReasoningPart,
  AgentTextPart,
  AgentToolPart,
  agentMessageParts,
} from "./AgentParts";
import { isAgentCancellation } from "./AgentRunError";
import {
  AgentMessageFrame,
  type AgentMessageIdentity,
} from "./AgentMessageFrame";

type ActivityEntry = { key: string; part: AgentPart };
type TranscriptBlock =
  | { kind: "message"; key: string; message: AgentMessage }
  | { kind: "text"; key: string; text: string }
  | {
      kind: "proposal";
      key: string;
      part: Extract<AgentPart, { type: "tool" }>;
    }
  | { kind: "activity"; key: string; entries: ActivityEntry[] };

/** Text and user/system messages are ordering boundaries, even within a reply. */
export function groupAgentTranscript(
  messages: AgentMessage[],
): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  let activity: Extract<TranscriptBlock, { kind: "activity" }> | undefined;
  for (const message of messages) {
    if (message.role !== "assistant") {
      activity = undefined;
      blocks.push({ kind: "message", key: `message:${message.id}`, message });
      continue;
    }
    for (const { part, key } of agentMessageParts(message)) {
      if (part.type === "text") {
        if (!part.text.trim()) continue;
        activity = undefined;
        blocks.push({ kind: "text", key, text: part.text });
      } else if (part.type === "tool" && part.name === "propose_automation") {
        activity = undefined;
        blocks.push({ kind: "proposal", key, part });
      } else {
        if (!activity) {
          activity = { kind: "activity", key: `activity:${key}`, entries: [] };
          blocks.push(activity);
        }
        activity.entries.push({ key, part });
      }
    }
  }
  return blocks;
}

const MUTATING_TOOLS = new Set([
  "edit",
  "write",
  "edit_file",
  "write_file",
  "apply_patch",
  "multiedit",
  "multi_edit",
]);
function modifiedPaths(part: Extract<AgentPart, { type: "tool" }>): string[] {
  if (
    part.state !== "completed" ||
    !MUTATING_TOOLS.has(part.name) ||
    !part.input ||
    typeof part.input !== "object"
  )
    return [];
  const input = part.input as Record<string, unknown>;
  const path = [input.path, input.filePath, input.file_path].find(
    (value): value is string =>
      typeof value === "string" && Boolean(value.trim()),
  );
  if (path) return [path.replace(/\\/g, "/")];
  const patch =
    typeof input.patch === "string"
      ? input.patch
      : typeof input.patchText === "string"
        ? input.patchText
        : "";
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(
    (match) => match[1].trim().replace(/\\/g, "/"),
  );
}

function projectFileKey(path: string, projectPath: string) {
  let root = projectPath.replace(/\\/g, "/").replace(/\/$/, "");
  let value = path.replace(/\\/g, "/");
  if (/^[a-z]:\//i.test(root) || root.startsWith("//")) {
    root = root.toLowerCase();
    value = value.toLowerCase();
  }
  if (value.startsWith(`${root}/`)) value = value.slice(root.length + 1);
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (
      segment === ".." &&
      segments.length &&
      segments[segments.length - 1] !== ".."
    )
      segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

const AgentExecutionGroup = memo(function AgentExecutionGroup({
  entries,
  active,
  projectPath,
  sessionId,
}: {
  entries: ActivityEntry[];
  active: boolean;
  projectPath: string;
  sessionId?: string;
}) {
  const states = useRef(new Map<string, AgentDisclosureState>());
  const stateFor = (key: string) => {
    let state = states.current.get(key);
    if (!state) {
      state = createAgentDisclosureState();
      states.current.set(key, state);
    }
    return state;
  };
  const tools = entries
    .map((entry) => entry.part)
    .filter(
      (part): part is Extract<AgentPart, { type: "tool" }> =>
        part.type === "tool",
    );
  const files = new Set(
    tools
      .flatMap(modifiedPaths)
      .map((path) => projectFileKey(path, projectPath)),
  );
  const pending =
    active ||
    tools.some((part) => part.state === "pending" || part.state === "running");
  const failures = tools.filter(
    (part) => part.state === "error" && !isAgentCancellation(part.error),
  );
  const stopped = tools.filter(
    (part) => part.state === "error" && isAgentCancellation(part.error),
  );
  const title = pending
    ? tools.length
      ? `正在处理 ${tools.length} 个步骤${files.size ? ` · 已修改 ${files.size} 个文件` : ""}`
      : "正在思考"
    : tools.length
      ? `${files.size ? `已修改 ${files.size} 个文件 · ` : ""}已执行 ${tools.length} 步${stopped.length ? ` · ${stopped.length} 步已停止` : ""}`
      : "思考记录";
  const firstFailure = failures.find((part) => part.error)?.error;
  return (
    <AgentDisclosure
      className="wb-execution-group wb-disclosure"
      summaryClassName="wb-execution-summary"
      bodyClassName="wb-execution-detail"
      data-state={
        pending
          ? "running"
          : failures.length
            ? "error"
            : stopped.length
              ? "stopped"
              : "completed"
      }
      summary={
        <>
          <ChevronRight
            className="wb-disclosure-chevron h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          {pending ? (
            <Loader2
              className="h-3.5 w-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
          ) : failures.length ? (
            <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <Wrench className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1">
            <span>{title}</span>
            {failures.length > 0 && (
              <span className="wb-execution-error">
                {" "}
                · {failures.length} 步失败
                {firstFailure ? `：${firstFailure.slice(0, 160)}` : ""}
              </span>
            )}
          </span>
        </>
      }
    >
      {() =>
        entries.map(({ part, key }) =>
          part.type === "tool" ? (
            <AgentToolPart
              key={key}
              part={part}
              projectPath={projectPath}
              sessionId={sessionId}
              grouped
              disclosureState={stateFor(key)}
            />
          ) : part.type === "reasoning" ? (
            <AgentReasoningPart
              key={key}
              part={part}
              projectPath={projectPath}
              sessionId={sessionId}
              disclosureState={stateFor(key)}
            />
          ) : null,
        )
      }
    </AgentDisclosure>
  );
});

export interface AgentTranscriptProps {
  messages: AgentMessage[];
  projectPath: string;
  sessionId?: string;
  status?: AgentStatus;
  imageAttachmentsByMessage?: Record<string, AgentImageAttachment[]>;
  documentAttachmentsByMessage?: Record<string, AgentDocumentAttachment[]>;
  userIdentity?: AgentMessageIdentity;
  onLoadEarlier?: () => void;
}

// Like Harness's loaded history window, bound the initial rendering work rather
// than mounting every historical Markdown/code surface on a session change.
// This only pages the view; the native session and model context stay complete.
const HISTORY_PAGE_SIZE = 40;

export const AgentTranscript = memo(function AgentTranscript({
  messages,
  projectPath,
  sessionId,
  status = "idle",
  imageAttachmentsByMessage = {},
  documentAttachmentsByMessage = {},
  userIdentity,
  onLoadEarlier,
}: AgentTranscriptProps) {
  const blocks = useMemo(() => groupAgentTranscript(messages), [messages]);
  const identity = `${projectPath}\0${sessionId || ""}`;
  const [window, setWindow] = useState(() => ({
    identity,
    first: blocks[Math.max(0, blocks.length - HISTORY_PAGE_SIZE)]?.key,
  }));
  let start =
    window.identity === identity
      ? blocks.findIndex((block) => block.key === window.first)
      : -1;
  if (start < 0) {
    start = Math.max(0, blocks.length - HISTORY_PAGE_SIZE);
    const first = blocks[start]?.key;
    if (window.identity !== identity || window.first !== first)
      setWindow({ identity, first });
  }
  const anchor = useRef<{
    row: Element;
    top: number;
    scroll: HTMLElement;
  }>();
  useLayoutEffect(() => {
    const saved = anchor.current;
    anchor.current = undefined;
    if (saved?.row.isConnected)
      saved.scroll.scrollTop +=
        saved.row.getBoundingClientRect().top - saved.top;
  }, [window]);
  const active =
    status === "running" ||
    status === "waiting_permission" ||
    status === "waiting_question";
  return (
    <>
      {start > 0 && (
        <button
          type="button"
          className="wb-history-earlier"
          onClick={(event) => {
            const row = event.currentTarget.nextElementSibling;
            const scroll = event.currentTarget.closest<HTMLElement>(".wb-chat");
            if (row && scroll)
              anchor.current = {
                row,
                top: row.getBoundingClientRect().top,
                scroll,
              };
            onLoadEarlier?.();
            setWindow({
              identity,
              first: blocks[Math.max(0, start - HISTORY_PAGE_SIZE)].key,
            });
          }}
        >
          加载更早的消息
        </button>
      )}
      {blocks.slice(start).map((block, index) =>
        block.kind === "message" ? (
          <AgentMessageView
            key={block.key}
            message={block.message}
            projectPath={projectPath}
            sessionId={sessionId}
            imageAttachments={imageAttachmentsByMessage[block.message.id]}
            documentAttachments={documentAttachmentsByMessage[block.message.id]}
            userIdentity={userIdentity}
          />
        ) : block.kind === "text" ? (
          <AgentMessageFrame
            role="assistant"
            key={block.key}
            companionSurface={{
              id: `message-${sessionId || projectPath}-${block.key}`,
              text: block.text,
            }}
          >
            <AgentTextPart
              text={block.text}
              projectPath={projectPath}
              sessionId={sessionId}
            />
          </AgentMessageFrame>
        ) : block.kind === "proposal" ? (
          <AgentMessageFrame
            role="assistant"
            key={block.key}
            ariaLabel="Agent 自动化提案"
          >
            <AgentToolPart
              part={block.part}
              projectPath={projectPath}
              sessionId={sessionId}
            />
          </AgentMessageFrame>
        ) : (
          <AgentMessageFrame
            key={block.key}
            role="assistant"
            ariaLabel="Agent 执行过程"
            showAuthor={false}
            className="wb-chat-message--activity"
          >
            <AgentExecutionGroup
              entries={block.entries}
              projectPath={projectPath}
              sessionId={sessionId}
              active={active && index + start === blocks.length - 1}
            />
          </AgentMessageFrame>
        ),
      )}
    </>
  );
});

/** Keep a small recent-session working set, including disclosure and paging state. */
export const AgentTranscriptDeck = memo(function AgentTranscriptDeck({
  active = true,
  onEvict,
  ...props
}: AgentTranscriptProps & {
  active?: boolean;
  onEvict?: (identity: string) => void;
}) {
  const key = `${props.projectPath}\0${props.sessionId || ""}`;
  const actions = useContext(AgentFileActionsContext);
  const [entries, setEntries] = useState(() => [{ key, props, actions }]);
  const committed = useRef<string[]>([]);
  useLayoutEffect(() => {
    const next = entries.map((entry) => entry.key);
    for (const previous of committed.current)
      if (!next.includes(previous)) onEvict?.(previous);
    committed.current = next;
  }, [entries, onEvict]);
  const latest = entries.at(-1)!;
  if (
    latest.key !== key ||
    latest.actions !== actions ||
    (Object.keys(props) as (keyof AgentTranscriptProps)[]).some(
      (name) => !Object.is(props[name], latest.props[name]),
    ) ||
    Object.keys(latest.props).length !== Object.keys(props).length
  ) {
    setEntries(
      [
        ...entries.filter((entry) => entry.key !== key),
        { key, props, actions },
      ].slice(-3),
    );
  }
  return entries.map((entry) => (
    <div
      key={entry.key}
      data-agent-transcript-session={entry.props.sessionId}
      hidden={entry.key !== key}
      className="wb-transcript-pane"
    >
      <ViewActivityContext.Provider value={active && entry.key === key}>
        <AgentFileActionsContext.Provider value={entry.actions}>
          <AgentTranscript {...entry.props} />
        </AgentFileActionsContext.Provider>
      </ViewActivityContext.Provider>
    </div>
  ));
});
