import { tavernApi } from "@/lib/api/tavern";
import { translate, type TranslationMessage } from "../../i18n/index.js";
import { useSettings } from "../settings.js";
import { readMessageEvent } from "./parseEvent.js";
import { readServerSentEvents } from "./sse.js";
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from "./types.js";

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN =
  typeof __API_ORIGIN__ !== "undefined"
    ? __API_ORIGIN__
    : "https://api.deepseek.com";
/** Anthropic 兼容接口的前缀 */
const ANTHROPIC_BASE_URL = `${API_ORIGIN}/anthropic/v1`;
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = "files-api-2025-04-14";

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | "http"
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | "stream"
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | "network"
  /** 流在 message_stop 之前结束 */
  | "interrupted"
  /** 响应不符合协议（如非 SSE 响应） */
  | "protocol";

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage;

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number,
  ) {
    super(
      typeof message === "string"
        ? message
        : translate(message.key, message.params),
    );
    this.name = "ApiError";
    this.localMessage = typeof message === "string" ? undefined : message;
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === "object" &&
  value !== null &&
  "error" in value &&
  typeof (value as ApiErrorBody).error?.message === "string";

const readErrorResponse = async (
  response: Response,
  kind: "http" | "protocol" = "http",
  fallback = response.statusText,
): Promise<ApiError> => {
  const text = await response.text().catch(() => "");
  let message = text || fallback;
  try {
    const body: unknown = JSON.parse(text);
    if (isErrorBody(body)) {
      message = body.error.message;
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status);
};

export const request = async (
  url: string,
  init: RequestInit,
): Promise<Response> => {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted) {
      throw error;
    }
    throw new ApiError(
      "network",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!response.ok) {
    throw await readErrorResponse(response);
  }
  return response;
};

const anthropicHeaders = (
  apiKey: string,
  beta: boolean,
): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  "x-api-key": apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { "anthropic-beta": FILES_BETA } : {}),
});

/** 用 GET /models 校验 API Key（不产生费用） */
export const verifyApiKey = async (
  apiKey: string,
  signal?: AbortSignal,
): Promise<void> => {
  await request(`${API_ORIGIN}/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
};

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal,
): Promise<FileObject> => {
  const form = new FormData();
  if (purpose) {
    form.append("purpose", purpose);
  }
  form.append("file", file);
  const response = await request(`${ANTHROPIC_BASE_URL}/files`, {
    method: "POST",
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  });
  return (await response.json()) as FileObject;
};

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (
  apiKey: string,
  fileId: string,
): Promise<void> => {
  await request(`${ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: anthropicHeaders(apiKey, true),
  });
};

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== "string" &&
      message.content.some(
        (block) => block.type === "image" || block.type === "document",
      ),
  );

const extractPlainText = (body: CreateMessageRequest): string => {
  const rounds: string[] = [];
  for (const msg of body.messages) {
    if (msg.role === "latest_reminder") continue;
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter(
              (b): b is { type: "text"; text: string } => b.type === "text",
            )
            .map((b) => b.text)
            .join("\n");
    if (!text.trim()) continue;
    rounds.push(
      msg.role === "user" ? text.trim() : `Assistant: ${text.trim()}`,
    );
  }
  return rounds.at(-1) ?? "";
};

async function* streamViaDesktopChannel(
  channelModelId: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
): AsyncGenerator<MessageStreamEvent> {
  signal.throwIfAborted();
  let snapshot = await tavernApi.getSnapshot();
  let characterId = snapshot.characters[0]?.id;
  if (!characterId) {
    const presets = await tavernApi.getPresets();
    const first = presets[0];
    if (!first) {
      throw new ApiError("protocol", "无法初始化本地对话通道");
    }
    const created = await tavernApi.addPreset(first.id);
    characterId = created.id;
  }
  const story = await tavernApi.createStory(characterId, "ChatDemo");
  try {
    const prompt = extractPlainText(body);
    const updated = await tavernApi.sendMessage(
      story.id,
      prompt,
      channelModelId,
    );
    signal.throwIfAborted();
    const reply =
      updated.messages.filter((m) => m.role === "assistant").at(-1)?.text ?? "";
    const msgId = story.id;
    yield {
      type: "message_start",
      message: { id: msgId, model: channelModelId },
    };
    yield {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    };
    if (reply) {
      yield {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: reply },
      };
    }
    yield {
      type: "content_block_stop",
      index: 0,
    };
    const autoTitle = prompt.slice(0, 20).replace(/\s+/g, " ").trim();
    yield {
      type: "message_delta",
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
        ...(body.title?.enabled && autoTitle ? { title: autoTitle } : {}),
      },
    };
    yield { type: "message_stop" };
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError(
      "http",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    void tavernApi.deleteStory(story.id).catch(() => undefined);
  }
}

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * 若选择了桌面端渠道或本地离线模型（channel:*），则通过桌面端统一渠道层执行。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
): AsyncGenerator<MessageStreamEvent> {
  const { modelSource } = useSettings.getState();
  if (modelSource.startsWith("channel:")) {
    const channelModelId = modelSource.slice("channel:".length);
    yield* streamViaDesktopChannel(channelModelId, body, signal);
    return;
  }
  const effectiveModel =
    modelSource === "deepseek-v4-pro" ? "deepseek-v4-pro" : body.model;
  const response = await request(`${ANTHROPIC_BASE_URL}/messages`, {
    method: "POST",
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ ...body, model: effectiveModel, stream: true }),
    signal,
  });
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!response.body || !contentType.includes("text/event-stream")) {
    throw await readErrorResponse(response, "protocol", "");
  }
  for await (const { event: eventName, data } of readServerSentEvents(
    response.body,
    signal,
  )) {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      if (eventName !== "error") {
        continue;
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError("stream", payload.error.message);
    }
    if (eventName === "error") {
      throw new ApiError("stream", data);
    }
    const event = readMessageEvent(payload);
    if (!event) {
      continue;
    }
    yield event;
    if (event.type === "message_stop") {
      return;
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError("interrupted", "");
}
