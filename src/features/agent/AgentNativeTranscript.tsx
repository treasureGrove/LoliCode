import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FileText, ImageIcon } from "lucide-react";
import { assembleAssistantStream } from "@deepseek-ai/dsh-llm/assistant-stream";
import type {
  SessionAssistantStreamAttempt,
  SessionWireEvent,
} from "@/types/harness-session";
import type {
  AgentDocumentAttachment,
  AgentImageAttachment,
  AgentPart,
  AgentStatus,
} from "@/types/agent";
import { AgentAttachmentImage } from "./AgentAttachmentImage";
import { AgentDisclosure } from "./AgentDisclosure";
import {
  AgentMessageFrame,
  type AgentMessageIdentity,
} from "./AgentMessageFrame";
import { AgentReasoningPart, AgentTextPart, AgentToolPart } from "./AgentParts";

type JsonObject = Record<string, unknown>;
type ToolView = Extract<AgentPart, { type: "tool" }>;
type ToolEvents = {
  assistant?: SessionWireEvent;
  call?: SessionWireEvent;
  result?: SessionWireEvent;
  ended?: SessionWireEvent;
};
type Row = {
  event: SessionWireEvent;
  kind: "user" | "assistant" | "attempt" | "tool" | "end" | "notice";
};
const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const list = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];
const text = (value: unknown) => (typeof value === "string" ? value : "");
const toolKey = (data: JsonObject, id: unknown) =>
  `${data.turn}:${data.step}:${String(id ?? "")}`;
const append = (event: SessionWireEvent) => event.surfaceOp === "append";

function argumentValue(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toolView(block: JsonObject, events?: ToolEvents): ToolView {
  const call = object(events?.call?.data);
  const result = object(events?.result?.data);
  const message = object(result.message);
  const output = list(message.content)
    .map((value) => {
      const content = object(value);
      return typeof content.text === "string"
        ? content.text
        : JSON.stringify(value);
    })
    .join("\n");
  const failed = message.isError === true;
  const ended = object(events?.ended?.data);
  const unfinished = !events?.result && events?.ended;
  return {
    type: "tool",
    id: text(block.id) || text(call.callId) || text(message.toolCallId),
    name: text(block.name) || text(call.name) || "工具",
    state: unfinished
      ? "error"
      : events?.result
        ? failed
          ? "error"
          : "completed"
        : events?.call
          ? "running"
          : "pending",
    input: argumentValue(call.arguments ?? block.arguments),
    output: output || undefined,
    error: unfinished
      ? endLabels[text(object(ended.reason).kind)] ||
        "本轮已结束，工具未返回结果"
      : failed
        ? text(object(result.error).reason) || output || "工具执行失败"
        : undefined,
  };
}

/** Index explicit turn/step/call identities; repeated provider call ids cannot cross turns. */
function nativeRows(events: readonly SessionWireEvent[]) {
  const tools = new Map<string, ToolEvents>();
  const declared = new Set<string>();
  const calls = new Set<string>();
  const endings = new Map<unknown, SessionWireEvent>();
  for (const event of events) {
    const data = object(event.data);
    if (event.type === "assistant/message" && append(event)) {
      for (const value of list(object(data.message).content)) {
        const block = object(value);
        if (block.type === "tool-call") {
          const key = toolKey(data, block.id);
          declared.add(key);
          tools.set(key, { ...tools.get(key), assistant: event });
        }
      }
    } else if (event.type === "tool/call") {
      const key = toolKey(data, data.callId);
      calls.add(key);
      tools.set(key, { ...tools.get(key), call: event });
    } else if (event.type === "tool/result" && append(event)) {
      const key = toolKey(data, object(data.message).toolCallId);
      tools.set(key, { ...tools.get(key), result: event });
    } else if (event.type === "turn/end") {
      endings.set(data.turn, event);
    }
  }
  for (const value of tools.values()) {
    const data = object((value.call ?? value.result ?? value.assistant)?.data);
    value.ended = endings.get(data.turn);
  }
  const rows: Row[] = [];
  for (const event of events) {
    const data = object(event.data);
    if (event.type === "user/message" && append(event)) {
      const source = object(data.source);
      if (source.kind === "user") rows.push({ kind: "user", event });
      else if (source.form === "notice" && typeof source.summary === "string")
        rows.push({ kind: "notice", event });
    } else if (event.type === "assistant/message" && append(event)) {
      rows.push({ kind: "assistant", event });
    } else if (event.type === "assistant/attempt") {
      rows.push({ kind: "attempt", event });
    } else if (
      event.type === "tool/call" &&
      !declared.has(toolKey(data, data.callId))
    ) {
      rows.push({ kind: "tool", event });
    } else if (event.type === "tool/result" && append(event)) {
      const key = toolKey(data, object(data.message).toolCallId);
      if (!declared.has(key) && !calls.has(key))
        rows.push({ kind: "tool", event });
    } else if (
      event.type === "turn/end" &&
      object(data.reason).kind !== "completed"
    ) {
      rows.push({ kind: "end", event });
    }
  }
  return { rows, tools };
}

function Content({
  values,
  data,
  tools,
  projectPath,
  sessionId,
  cachedImages = [],
  cachedDocuments = [],
}: {
  values: readonly unknown[];
  data: JsonObject;
  tools: ReadonlyMap<string, ToolEvents>;
  projectPath: string;
  sessionId?: string;
  cachedImages?: readonly AgentImageAttachment[];
  cachedDocuments?: readonly AgentDocumentAttachment[];
}) {
  let imageIndex = 0;
  let documentIndex = 0;
  return (
    <>
      {values.map((value, index) => {
        const block = object(value);
        const key = `${String(block.type)}:${String(block.id ?? index)}`;
        if (block.type === "text" && typeof block.text === "string")
          return (
            <AgentTextPart
              key={key}
              text={block.text}
              projectPath={projectPath}
              sessionId={sessionId}
            />
          );
        if (block.type === "reasoning" && typeof block.text === "string")
          return (
            <AgentReasoningPart
              key={key}
              part={{ text: block.text }}
              projectPath={projectPath}
              sessionId={sessionId}
            />
          );
        if (block.type === "tool-call")
          return (
            <AgentToolPart
              key={key}
              part={toolView(block, tools.get(toolKey(data, block.id)))}
              projectPath={projectPath}
              sessionId={sessionId}
            />
          );
        // A durable attachment id is opaque. Cached user uploads can show their
        // image; unresolved refs stay named cards rather than guessed local paths.
        if (block.type === "image" || block.type === "file") {
          if (
            block.type === "image"
              ? imageIndex++ < cachedImages.length
              : documentIndex++ < cachedDocuments.length
          )
            return null;
          const attachment = object(block.attachment);
          return (
            <div
              key={key}
              className="wb-message-document"
              aria-label={
                block.type === "image" ? "消息中的图片引用" : "消息中的文档"
              }
            >
              {block.type === "image" ? (
                <ImageIcon aria-hidden="true" />
              ) : (
                <FileText aria-hidden="true" />
              )}
              <span>
                {text(attachment.name) ||
                  (block.type === "image" ? "图片附件" : "文档附件")}
              </span>
            </div>
          );
        }
        return (
          <p key={key} className="text-caption text-fg-3">
            附加内容：{text(block.type) || "未知类型"}
          </p>
        );
      })}
    </>
  );
}

function AttemptContent({
  attempt,
  ...props
}: { attempt: SessionAssistantStreamAttempt } & Omit<
  Parameters<typeof Content>[0],
  "values" | "data"
>) {
  const assembled = useMemo(() => {
    try {
      // The public browser wire carries JsonValue; interpretation stays in the
      // pinned upstream assembler rather than a second token-fold algorithm.
      return {
        values: assembleAssistantStream(
          attempt.stream as Parameters<typeof assembleAssistantStream>[0],
        ).blocks(),
      };
    } catch {
      return {
        values: [],
        error: "这段实时回复暂时无法显示，已保留原生记录。",
      };
    }
  }, [attempt.stream]);
  return (
    <AgentMessageFrame role="assistant" ariaLabel="Agent 正在回复">
      <Content
        {...props}
        values={assembled.values}
        data={{ turn: attempt.turn, step: attempt.step }}
      />
      {assembled.error && (
        <p role="status" className="text-caption text-fg-3">
          {assembled.error}
        </p>
      )}
    </AgentMessageFrame>
  );
}

const endLabels: Record<string, string> = {
  aborted: "本轮已取消",
  blocked: "本轮请求被阻止",
  "max-tokens": "本轮达到模型输出上限",
  interrupted: "本轮执行中断",
  forked: "会话已从这里分叉",
  error: "本轮运行失败",
};

export interface AgentNativeTranscriptProps {
  events: readonly SessionWireEvent[];
  activeAttempt?: SessionAssistantStreamAttempt | null;
  projectPath: string;
  sessionId?: string;
  status?: AgentStatus;
  imageAttachmentsByMessage?: Record<string, AgentImageAttachment[]>;
  documentAttachmentsByMessage?: Record<string, AgentDocumentAttachment[]>;
  messageAliases?: Readonly<Record<string, string>>;
  userIdentity?: AgentMessageIdentity;
  onLoadEarlier?: () => void;
  onLoadOlder?: () => void;
  hasMore?: boolean;
  loadingEarlier?: boolean;
}

export function hasNativeTranscriptContent(
  events: readonly SessionWireEvent[],
  activeAttempt?: SessionAssistantStreamAttempt | null,
): boolean {
  return (
    Boolean(activeAttempt) ||
    events.some((event) => {
      const data = object(event.data);
      if (event.type === "user/message")
        return append(event) && object(data.source).kind === "user";
      if (event.type === "assistant/message" || event.type === "tool/result")
        return append(event);
      return (
        event.type === "tool/call" ||
        event.type === "assistant/attempt" ||
        (event.type === "turn/end" && object(data.reason).kind !== "completed")
      );
    })
  );
}

/** Native event references are the display source; no intermediate AgentMessage history. */
export const AgentNativeTranscript = memo(function AgentNativeTranscript({
  events,
  activeAttempt,
  projectPath,
  sessionId,
  imageAttachmentsByMessage = {},
  documentAttachmentsByMessage = {},
  messageAliases = {},
  userIdentity,
  onLoadEarlier,
  onLoadOlder,
  hasMore = false,
  loadingEarlier = false,
}: AgentNativeTranscriptProps) {
  const { rows, tools } = useMemo(() => nativeRows(events), [events]);
  const identity = `${projectPath}\0${sessionId || ""}`;
  const [window, setWindow] = useState(() => ({
    identity,
    first: rows[Math.max(0, rows.length - 40)]?.event.seq,
  }));
  const loadBefore = useRef<{ identity: string; seq: number }>();
  let start =
    window.identity === identity
      ? rows.findIndex((row) => row.event.seq === window.first)
      : -1;
  if (loadBefore.current?.identity !== identity) loadBefore.current = undefined;
  if (
    loadBefore.current &&
    rows.length &&
    rows[0].event.seq < loadBefore.current.seq
  ) {
    loadBefore.current = undefined;
    start = 0;
    setWindow({ identity, first: rows[0].event.seq });
  }
  if (start < 0) {
    start = Math.max(0, rows.length - 40);
    const first = rows[start]?.event.seq;
    if (window.identity !== identity || window.first !== first)
      setWindow({ identity, first });
  }
  const anchor = useRef<{ row: Element; top: number; scroll: HTMLElement }>();
  useLayoutEffect(() => {
    if (loadingEarlier) return;
    const saved = anchor.current;
    anchor.current = undefined;
    loadBefore.current = undefined;
    if (saved?.row.isConnected)
      saved.scroll.scrollTop +=
        saved.row.getBoundingClientRect().top - saved.top;
  }, [window, events, loadingEarlier]);
  const contentProps = { tools, projectPath, sessionId };
  return (
    <>
      {(start > 0 || hasMore) && (
        <button
          type="button"
          className="wb-history-earlier"
          disabled={loadingEarlier || (start === 0 && !onLoadOlder)}
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
            if (start > 0)
              setWindow({
                identity,
                first: rows[Math.max(0, start - 40)].event.seq,
              });
            else {
              if (rows[0])
                loadBefore.current = { identity, seq: rows[0].event.seq };
              onLoadOlder?.();
            }
          }}
        >
          {loadingEarlier ? "正在加载更早的消息…" : "加载更早的消息"}
        </button>
      )}
      {rows.slice(start).map(({ event, kind }) => {
        const data = object(event.data);
        const message = kind === "user" ? data : object(data.message);
        const source = object(data.source);
        const imageAttachments =
          imageAttachmentsByMessage[messageAliases[text(data.id)]] ||
          imageAttachmentsByMessage[text(data.id)] ||
          imageAttachmentsByMessage[text(source.rpcId)] ||
          [];
        const documents =
          documentAttachmentsByMessage[messageAliases[text(data.id)]] ||
          documentAttachmentsByMessage[text(data.id)] ||
          documentAttachmentsByMessage[text(source.rpcId)] ||
          [];
        const props = {
          "data-native-event-seq": event.seq,
          "data-native-turn":
            typeof data.turn === "number" ? data.turn : undefined,
          "data-native-step":
            typeof data.step === "number" ? data.step : undefined,
        };
        if (kind === "notice")
          return (
            <p key={event.seq} {...props} className="text-caption text-fg-3">
              {text(source.summary)}
            </p>
          );
        if (kind === "end")
          return (
            <p
              key={event.seq}
              {...props}
              role="status"
              className="text-caption text-fg-3"
            >
              {endLabels[text(object(data.reason).kind)] || "本轮提前结束"}
            </p>
          );
        if (kind === "tool") {
          const id = data.callId ?? message.toolCallId;
          return (
            <div key={event.seq} {...props} className="min-w-0">
              <AgentMessageFrame
                role="assistant"
                ariaLabel="Agent 执行过程"
                showAuthor={false}
                className="wb-chat-message--activity"
              >
                <AgentToolPart
                  part={toolView({}, tools.get(toolKey(data, id)))}
                  projectPath={projectPath}
                  sessionId={sessionId}
                />
              </AgentMessageFrame>
            </div>
          );
        }
        if (kind === "attempt") {
          let values: readonly unknown[] = [];
          try {
            values = assembleAssistantStream(
              list(data.stream) as Parameters<
                typeof assembleAssistantStream
              >[0],
            ).interruptedBlocks();
          } catch {
            /* Keep the attempt marker even if a new stream block needs a renderer. */
          }
          return (
            <div key={event.seq} {...props} className="min-w-0">
              <AgentMessageFrame
                role="assistant"
                ariaLabel="Agent 模型尝试"
                showAuthor={false}
                className="wb-chat-message--activity"
              >
                <AgentDisclosure
                  className="wb-reasoning wb-disclosure my-2 text-caption"
                  summary="此模型尝试未形成回复"
                >
                  {() => (
                    <Content {...contentProps} values={values} data={data} />
                  )}
                </AgentDisclosure>
              </AgentMessageFrame>
            </div>
          );
        }
        const values = list(message.content);
        const plainText = values.every((value) => object(value).type === "text")
          ? values.map((value) => text(object(value).text)).join("\n")
          : undefined;
        return (
          <div key={event.seq} {...props} className="min-w-0">
            <AgentMessageFrame
              role={kind === "user" ? "user" : "assistant"}
              identity={kind === "user" ? userIdentity : undefined}
              companionSurface={
                plainText
                  ? {
                      id: `native-${sessionId || projectPath}-${event.seq}`,
                      text: plainText,
                    }
                  : undefined
              }
            >
              <Content
                {...contentProps}
                values={values}
                data={data}
                cachedImages={imageAttachments}
                cachedDocuments={documents}
              />
              {kind === "user" && imageAttachments.length > 0 && (
                <div className="wb-message-images" aria-label="消息中的图片">
                  {imageAttachments.map((image) => (
                    <AgentAttachmentImage
                      key={image.id}
                      image={image}
                      buttonClassName="wb-message-image-preview"
                      imageClassName="wb-message-image-preview__image"
                    />
                  ))}
                </div>
              )}
              {kind === "user" && documents.length > 0 && (
                <div className="wb-message-documents" aria-label="消息中的文档">
                  {documents.map((document) => (
                    <div className="wb-message-document" key={document.id}>
                      <FileText aria-hidden="true" />
                      <span title={document.fileName}>{document.fileName}</span>
                    </div>
                  ))}
                </div>
              )}
              {data.interrupted === true && (
                <p role="status" className="text-caption text-fg-3">
                  回复已中断
                </p>
              )}
            </AgentMessageFrame>
          </div>
        );
      })}
      {activeAttempt && (
        <div
          data-native-turn={activeAttempt.turn}
          data-native-step={activeAttempt.step}
          data-native-attempt={activeAttempt.attemptId}
          className="min-w-0"
        >
          <AttemptContent {...contentProps} attempt={activeAttempt} />
        </div>
      )}
    </>
  );
});
