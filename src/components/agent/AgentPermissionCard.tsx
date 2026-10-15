import { useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentPermission, AgentPermissionDecision } from "@/types/agent";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";

const NATIVE_DANGEROUS_COMMAND_SUMMARY =
  "Dangerous command requires your approval for this execution";

function permissionPreview(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const values = input as Record<string, unknown>;
  const fields: { label: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const [key, label] of [
    ["command", "将执行的命令"],
    ["filePath", "涉及路径"],
    ["file_path", "涉及路径"],
    ["path", "涉及路径"],
    ["cwd", "工作目录"],
    ["workdir", "工作目录"],
    ["workingDirectory", "工作目录"],
  ]) {
    const value = Object.prototype.hasOwnProperty.call(values, key)
      ? values[key]
      : undefined;
    if (typeof value !== "string" || !value.trim()) continue;
    const identity = `${label}\0${value}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    fields.push({ label, value });
  }
  return fields;
}

export function AgentPermissionCard({
  request,
  onReply,
}: {
  request: AgentPermission;
  onReply: (decision: AgentPermissionDecision) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const preview = permissionPreview(request.toolInput);
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
    } catch (cause) {
      setError(agentErrorMessage(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <section aria-label="需要你的许可" className="wb-permission border p-4">
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
          disabled={busy}
          onClick={() => void reply("once")}
        >
          允许一次
        </Button>
        <Button
          variant="neutral"
          disabled={busy || request.approvalMode === "user-once"}
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
          disabled={busy}
          onClick={() => void reply("reject")}
        >
          拒绝
        </Button>
      </div>
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
