import { memo } from "react";
import { CheckCircle2, CircleAlert, Loader2, Wrench } from "lucide-react";
import type { AgentMessage, AgentPart } from "@/types/agent";
import { SessionMarkdown } from "@/components/sessions/reader/SessionMarkdown";
import { SessionCodeBlock } from "@/components/sessions/reader/SessionCodeBlock";
import { cn } from "@/lib/utils";
import LolicodeMascot from "@/components/shell/LolicodeMascot";

const TOOL_NAMES: Record<string, string> = {
  read: "读取文件",
  glob: "查找文件",
  grep: "搜索代码",
  list: "查看目录",
  edit: "修改文件",
  write: "写入文件",
  apply_patch: "修改文件",
  bash: "运行命令",
  shell: "运行命令",
  task: "执行子任务",
  webfetch: "读取网页",
  websearch: "搜索网页",
  todowrite: "更新计划",
  question: "询问你的意见",
};

function toolTarget(part: Extract<AgentPart, { type: "tool" }>) {
  if (!part.input || typeof part.input !== "object") return "";
  const input = part.input as Record<string, unknown>;
  for (const key of [
    "filePath",
    "file_path",
    "path",
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
  return (
    <details className="wb-tool my-2" data-state={part.state}>
      <summary className="flex cursor-pointer items-start gap-2 px-3 py-2 text-caption">
        {active ? (
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : part.state === "error" ? (
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-text" />
        ) : part.state === "completed" ? (
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <Wrench className="h-3.5 w-3.5" />
        )}
        <span className="min-w-0 flex-1">
          <span className="font-medium">{label}</span>
          {toolTarget(part) && (
            <span className="wb-tool-target ml-2 break-all">
              {toolTarget(part)}
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
      </summary>
      <div className="border-t border-border px-3 py-2">
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
      </div>
    </details>
  );
});

export const AgentMessageView = memo(function AgentMessageView({
  message,
  projectPath,
}: {
  message: AgentMessage;
  projectPath: string;
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
          <details
            key={part.id || index}
            className="wb-reasoning my-2 text-caption"
          >
            <summary className="cursor-pointer">思考过程</summary>
            <SessionMarkdown
              content={part.text}
              projectDir={projectPath}
              variant="note"
            />
          </details>
        ) : (
          <SessionMarkdown
            key={part.id || index}
            content={part.text}
            projectDir={projectPath}
          />
        ),
      )}
    </article>
  );
});
