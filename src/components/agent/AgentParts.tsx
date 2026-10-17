import { memo, useCallback } from "react";
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileText,
  Loader2,
  Wrench,
} from "lucide-react";
import type {
  AgentDocumentAttachment,
  AgentImageAttachment,
  AgentMessage,
  AgentPart,
} from "@/types/agent";
import { SessionMarkdown } from "@/components/sessions/reader/SessionMarkdown";
import { SessionCodeBlock } from "@/components/sessions/reader/SessionCodeBlock";
import { cn } from "@/lib/utils";
import { AgentFilePath } from "./AgentFilePath";
import { AgentImage } from "./AgentImage";
import { AgentAttachmentImage } from "./AgentAttachmentImage";
import { AgentDisclosure, type AgentDisclosureState } from "./AgentDisclosure";
import { isAgentCancellation } from "./AgentRunError";

const TOOL_NAMES: Record<string, string> = {
  read: "读取文件",
  read_file: "读取文件",
  glob: "查找文件",
  grep: "搜索代码",
  list: "查看目录",
  list_files: "查看目录",
  search_files: "搜索代码",
  edit: "修改文件",
  write: "写入文件",
  write_file: "写入文件",
  apply_patch: "修改文件",
  bash: "运行命令",
  shell: "运行命令",
  run_command: "运行命令",
  task: "执行子任务",
  webfetch: "读取网页",
  websearch: "搜索网页",
  todowrite: "更新计划",
  question: "询问你的意见",
  ask_user: "询问你的意见",
  exit_plan_mode: "确认实施计划",
  read_skill: "读取技能",
  tavern_list_characters: "查看酒馆角色",
  tavern_list_stories: "查看酒馆故事",
  tavern_read_story: "读取酒馆故事",
  tavern_import_character: "导入酒馆角色卡",
  tavern_create_story: "新建酒馆故事",
  tavern_preview_context: "预览角色与世界书",
  unreal_editor_command: "操作虚幻编辑器",
};

function toolTarget(part: Extract<AgentPart, { type: "tool" }>) {
  if (!part.input || typeof part.input !== "object") return "";
  const input = part.input as Record<string, unknown>;
  if (part.name === "read_skill" && typeof input.id === "string")
    return input.id.slice(0, 200);
  for (const key of [
    "filePath",
    "file_path",
    "path",
    "skill_id",
    "pattern",
    "description",
    "command",
    "url",
  ]) {
    if (typeof input[key] === "string")
      return (input[key] as string).slice(0, 200);
  }
  return "";
}

export const AgentToolPart = memo(function AgentToolPart({
  part,
  grouped = false,
  disclosureState,
}: {
  part: Extract<AgentPart, { type: "tool" }>;
  grouped?: boolean;
  disclosureState?: AgentDisclosureState;
}) {
  const active = part.state === "pending" || part.state === "running";
  const cancelled = part.state === "error" && isAgentCancellation(part.error);
  const label = TOOL_NAMES[part.name] || part.name;
  const target = toolTarget(part);
  const filePath =
    part.input && typeof part.input === "object"
      ? ["filePath", "file_path", "path"]
          .map((key) => (part.input as Record<string, unknown>)[key])
          .find((value): value is string => typeof value === "string")
      : undefined;
  return (
    <AgentDisclosure
      className={cn("wb-tool wb-disclosure my-2", grouped && "wb-tool-step")}
      state={disclosureState}
      data-state={part.state}
      summaryClassName="flex cursor-pointer items-start gap-2 px-3 py-2 text-caption"
      bodyClassName="max-h-80 overflow-y-auto border-t border-border px-3 py-2"
      summary={
        <>
          <ChevronRight
            className="wb-disclosure-chevron mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          {active ? (
            <Loader2
              className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
          ) : part.state === "error" && !cancelled ? (
            <CircleAlert
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-text"
              aria-hidden="true"
            />
          ) : part.state === "completed" ? (
            <CheckCircle2
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
          ) : (
            <Wrench className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1">
            <span className="font-medium">{label}</span>
            {target && (
              <span className="wb-tool-target ml-2 break-all">
                {filePath ? <AgentFilePath path={filePath} /> : target}
              </span>
            )}
            {part.state === "error" && part.error && (
              <span
                className={cn(
                  "wb-tool-error-summary block truncate",
                  !cancelled && "text-danger-text",
                )}
              >
                {part.error.slice(0, 160)}
              </span>
            )}
          </span>
          <span className="wb-tool-status shrink-0">
            {part.state === "pending"
              ? "等待执行"
              : part.state === "running"
                ? "执行中"
                : part.state === "error"
                  ? cancelled
                    ? "已停止"
                    : "失败"
                  : "已完成"}
          </span>
        </>
      }
    >
      {() => (
        <>
          {part.error && (
            <p
              role={cancelled ? "status" : "alert"}
              className={cn(
                "whitespace-pre-wrap text-caption",
                !cancelled && "text-danger-text",
              )}
            >
              {part.error}
            </p>
          )}
          {part.output ? (
            <SessionCodeBlock
              className="wb-code-block"
              code={part.output.slice(0, 30000)}
            />
          ) : (
            <p className="text-caption text-fg-3">
              {active ? "正在等待工具输出…" : "此步骤没有额外输出。"}
            </p>
          )}
          {part.output && part.output.length > 30000 && (
            <p className="text-caption text-fg-3">
              输出较长，已显示前 30,000 字。
            </p>
          )}
        </>
      )}
    </AgentDisclosure>
  );
});

export const AgentTextPart = memo(function AgentTextPart({
  text,
  projectPath,
  sessionId,
}: {
  text: string;
  projectPath: string;
  sessionId?: string;
}) {
  const renderLocalImage = useCallback(
    (path: string, alt: string) => (
      <AgentImage
        sessionId={sessionId}
        path={path}
        alt={alt}
        projectPath={projectPath}
      />
    ),
    [sessionId, projectPath],
  );
  const renderLocalPath = useCallback(
    (path: string, label?: React.ReactNode) => (
      <AgentFilePath path={path} label={label} />
    ),
    [],
  );
  return (
    <SessionMarkdown
      content={text}
      projectDir={projectPath}
      renderLocalImage={renderLocalImage}
      renderLocalPath={renderLocalPath}
      previewLocalImageLinks
    />
  );
});

export const AgentReasoningPart = memo(function AgentReasoningPart({
  part,
  projectPath,
  disclosureState,
}: {
  part: { text: string };
  projectPath: string;
  disclosureState?: AgentDisclosureState;
}) {
  const renderLocalPath = useCallback(
    (path: string, label?: React.ReactNode) => (
      <AgentFilePath path={path} label={label} />
    ),
    [],
  );
  return (
    <AgentDisclosure
      className="wb-reasoning wb-disclosure my-2 text-caption"
      state={disclosureState}
      summaryClassName="flex cursor-pointer items-center gap-2"
      summary={
        <>
          <ChevronRight
            className="wb-disclosure-chevron h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          思考过程
        </>
      }
    >
      {() => (
        <SessionMarkdown
          content={part.text}
          projectDir={projectPath}
          variant="note"
          renderLocalPath={renderLocalPath}
        />
      )}
    </AgentDisclosure>
  );
});

/** A part key does not depend on the arrival/removal of another part type. */
export function agentMessageParts(message: AgentMessage) {
  const ordinals = { text: 0, reasoning: 0, tool: 0 };
  return message.parts.map((part) => {
    const ordinal = ordinals[part.type]++;
    return { part, key: `${message.id}:${part.type}:${part.id || ordinal}` };
  });
}

export const AgentMessageView = memo(function AgentMessageView({
  message,
  projectPath,
  sessionId,
  imageAttachments,
  documentAttachments,
}: {
  message: AgentMessage;
  projectPath: string;
  sessionId?: string;
  imageAttachments?: AgentImageAttachment[];
  documentAttachments?: AgentDocumentAttachment[];
}) {
  return (
    <article
      aria-label={
        message.role === "user"
          ? "你的消息"
          : message.role === "assistant"
            ? "Agent 回复"
            : "系统消息"
      }
      className={cn(
        "min-w-0",
        message.role === "user" && "wb-message-user",
        message.role === "assistant" && "wb-message-assistant",
      )}
    >
      {message.role !== "assistant" && (
        <p className="wb-message-meta">
          {message.role === "user" ? "你" : "系统"}
        </p>
      )}
      {agentMessageParts(message).map(({ part, key }) =>
        part.type === "tool" ? (
          <AgentToolPart key={key} part={part} />
        ) : part.type === "reasoning" ? (
          <AgentReasoningPart key={key} part={part} projectPath={projectPath} />
        ) : (
          <AgentTextPart
            key={key}
            text={part.text}
            projectPath={projectPath}
            sessionId={sessionId}
          />
        ),
      )}
      {message.role === "user" && imageAttachments?.length ? (
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
      ) : null}
      {message.role === "user" && documentAttachments?.length ? (
        <div className="wb-message-documents" aria-label="消息中的文档">
          {documentAttachments.map((document) => (
            <div className="wb-message-document" key={document.id}>
              <FileText aria-hidden="true" />
              <span title={document.fileName}>{document.fileName}</span>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  );
});
