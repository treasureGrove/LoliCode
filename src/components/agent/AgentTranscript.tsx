import { memo, useMemo, useRef } from "react";
import { ChevronRight, CircleAlert, Loader2, Wrench } from "lucide-react";
import type { AgentMessage, AgentPart, AgentStatus } from "@/types/agent";
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

type ActivityEntry = { key: string; part: AgentPart };
type TranscriptBlock =
  | { kind: "message"; key: string; message: AgentMessage }
  | { kind: "text"; key: string; text: string }
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
}: {
  entries: ActivityEntry[];
  active: boolean;
  projectPath: string;
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
              grouped
              disclosureState={stateFor(key)}
            />
          ) : part.type === "reasoning" ? (
            <AgentReasoningPart
              key={key}
              part={part}
              projectPath={projectPath}
              disclosureState={stateFor(key)}
            />
          ) : null,
        )
      }
    </AgentDisclosure>
  );
});

export function AgentTranscript({
  messages,
  projectPath,
  sessionId,
  status = "idle",
}: {
  messages: AgentMessage[];
  projectPath: string;
  sessionId?: string;
  status?: AgentStatus;
}) {
  const blocks = useMemo(() => groupAgentTranscript(messages), [messages]);
  const active =
    status === "running" ||
    status === "waiting_permission" ||
    status === "waiting_question";
  return (
    <>
      {blocks.map((block, index) =>
        block.kind === "message" ? (
          <AgentMessageView
            key={block.key}
            message={block.message}
            projectPath={projectPath}
            sessionId={sessionId}
          />
        ) : block.kind === "text" ? (
          <article
            className="min-w-0 wb-message-assistant"
            aria-label="Agent 回复"
            key={block.key}
          >
            <AgentTextPart
              text={block.text}
              projectPath={projectPath}
              sessionId={sessionId}
            />
          </article>
        ) : (
          <AgentExecutionGroup
            key={block.key}
            entries={block.entries}
            projectPath={projectPath}
            active={active && index === blocks.length - 1}
          />
        ),
      )}
    </>
  );
}
