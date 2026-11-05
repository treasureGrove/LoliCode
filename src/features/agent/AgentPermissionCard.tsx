import { useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentPermission, AgentPermissionDecision } from "@/types/agent";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";

const NATIVE_DANGEROUS_COMMAND_SUMMARY =
  "Dangerous command requires your approval for this execution";

function permissionPreview(request: AgentPermission) {
  const input = request.toolInput;
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const values = input as Record<string, unknown>;
  const fields: { label: string; value: string }[] = [];
  const seen = new Set<string>();
  const displayFields = [
    ["command", "将执行的命令"],
    ["filePath", "涉及路径"],
    ["file_path", "涉及路径"],
    ["path", "涉及路径"],
    ["cwd", "工作目录"],
    ["workdir", "工作目录"],
    ["workingDirectory", "工作目录"],
  ];
  if (!request.editPreview) {
    if (request.toolName === "write_file") {
      displayFields.push(
        ["expected_content", "预期原文"],
        ["content", "拟写入内容"],
      );
    } else if (request.toolName === "apply_patch") {
      displayFields.push(["old_text", "待替换文本"], ["new_text", "替换为"]);
    }
  }
  for (const [key, label] of displayFields) {
    const value = Object.prototype.hasOwnProperty.call(values, key)
      ? values[key]
      : undefined;
    if (typeof value !== "string") {
      if (key === "expected_content" && value === null) {
        fields.push({ label, value: "新文件" });
      }
      continue;
    }
    const editText = [
      "expected_content",
      "content",
      "old_text",
      "new_text",
    ].includes(key);
    if (!editText && !value.trim()) continue;
    const identity = `${label}\0${value}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    fields.push({ label, value: value || "（空文本）" });
  }
  return fields;
}

interface PermissionProps {
  request: AgentPermission;
  onReply: (decision: AgentPermissionDecision) => Promise<void>;
}

export function AgentPermissionCard(props: PermissionProps) {
  return (
    <PermissionForm
      key={JSON.stringify([props.request.sessionId, props.request.id])}
      {...props}
    />
  );
}

function PermissionForm({ request, onReply }: PermissionProps) {
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const preview = permissionPreview(request);
  const description =
    request.description === NATIVE_DANGEROUS_COMMAND_SUMMARY
      ? "这条命令需要你确认后才能执行。"
      : request.description || request.action;
  const reply = async (decision: AgentPermissionDecision) => {
    if (
      pending.current ||
      (decision === "always" && request.approvalMode === "user-once")
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onReply(decision);
      setResolved(true);
    } catch (cause) {
      pending.current = false;
      setError(agentErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="需要你的许可"
      aria-busy={busy}
      className="wb-permission border p-4"
    >
      <h3 className="wb-permission-heading flex items-center gap-2 text-body font-medium">
        <ShieldCheck className="h-4 w-4" />
        需要你的许可
      </h3>
      <p className="mt-2 whitespace-pre-wrap text-body">{description}</p>
      {preview.length > 0 && (
        <div className="mt-3 space-y-2">
          {preview.map(({ label, value }, index) => (
            <div key={index} className="min-w-0">
              <p className="mb-1 text-caption text-fg-3">{label}</p>
              <pre
                aria-label={label}
                className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-caption"
                tabIndex={value.length > 500 ? 0 : undefined}
              >
                <code>{value}</code>
              </pre>
            </div>
          ))}
        </div>
      )}
      {request.editPreview && (
        <div className="mt-3">
          <p className="mb-1 text-caption text-fg-3">待应用的差异</p>
          <pre
            aria-label="待应用的差异"
            className="max-h-60 overflow-auto whitespace-pre rounded border p-2 text-caption"
            tabIndex={0}
          >
            <code>{request.editPreview}</code>
          </pre>
        </div>
      )}
      {request.resources.length > 0 && (
        <ul className="wb-permission-resources mt-2 space-y-1 text-caption">
          {request.resources.map((resource, index) => (
            <li key={index} className="break-all">
              {resource}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          className="wb-permission-allow"
          disabled={busy || resolved}
          onClick={() => void reply("once")}
        >
          允许一次
        </Button>
        <Button
          variant="neutral"
          disabled={busy || resolved || request.approvalMode === "user-once"}
          title={
            request.approvalMode === "user-once"
              ? "此请求只支持允许一次"
              : undefined
          }
          onClick={() => void reply("always")}
        >
          此项目记住授权
        </Button>
        <Button
          variant="quiet"
          disabled={busy || resolved}
          onClick={() => void reply("reject")}
        >
          拒绝
        </Button>
      </div>
      {resolved && (
        <p role="status" className="mt-2 text-caption text-fg-2">
          已提交处理结果，等待 Agent 继续。
        </p>
      )}
      <p className="mt-2 text-caption text-fg-3">
        {request.approvalMode === "user-once"
          ? "此请求由原生引擎管理，仅支持本次授权。"
          : "记住授权会保存到当前项目，按工具请求的范围生效；范围可能包含同类操作。"}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-caption text-danger-text">
          {error}
        </p>
      )}
    </section>
  );
}
