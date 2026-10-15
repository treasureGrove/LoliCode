import { memo, useCallback } from "react";
import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Loader2,
  Wrench,
} from "lucide-react";
import type { AgentMessage, AgentPart } from "@/types/agent";
import { SessionMarkdown } from "@/components/sessions/reader/SessionMarkdown";
import { SessionCodeBlock } from "@/components/sessions/reader/SessionCodeBlock";
import { cn } from "@/lib/utils";
import LolicodeMascot from "@/components/shell/LolicodeMascot";
import { AgentImage } from "./AgentImage";
import { AgentDisclosure } from "./AgentDisclosure";

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
}: {
  part: Extract<AgentPart, { type: "tool" }>;
}) {
  const active = part.state === "pending" || part.state === "running";
  const label = TOOL_NAMES[part.name] || part.name;
  const target = toolTarget(part);
  return (
    <AgentDisclosure
      className="wb-tool wb-disclosure my-2"
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
          ) : part.state === "error" ? (
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
              <span className="wb-tool-target ml-2 break-all" title={target}>
                {target}
              </span>
            )}
            {part.state === "error" && part.error && (
              <span className="wb-tool-error-summary block truncate text-danger-text">
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
                  ? "失败"
                  : "已完成"}
          </span>
        </>
      }
    >
      {() => (
        <>
          {part.error && (
            <p
              role="alert"
              className="whitespace-pre-wrap text-caption text-danger-text"
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

export const AgentMessageView = memo(function AgentMessageView({
  message,
  projectPath,
  sessionId,
}: {
  message: AgentMessage;
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
      <p className="wb-message-meta">
        {message.role === "assistant" && (
          <LolicodeMascot
            className="wb-assistant-avatar"
            variant="portrait"
            decorative
          />
        )}
        <span>
          {message.role === "user"
            ? "你"
            : message.role === "assistant"
              ? "LoliCode"
              : "系统"}
        </span>
      </p>
      {message.parts.map((part, index) =>
        part.type === "tool" ? (
          <AgentToolPart key={part.id} part={part} />
        ) : part.type === "reasoning" ? (
          <AgentDisclosure
            key={part.id || index}
            className="wb-reasoning wb-disclosure my-2 text-caption"
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
              />
            )}
          </AgentDisclosure>
        ) : (
          <SessionMarkdown
            key={part.id || index}
            content={part.text}
            projectDir={projectPath}
            renderLocalImage={renderLocalImage}
            previewLocalImageLinks
          />
        ),
      )}
    </article>
  );
});
