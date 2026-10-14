import { useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentPermission, AgentPermissionDecision } from "@/types/agent";
import { agentErrorMessage } from "@/hooks/useAgentSnapshot";

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
  const reply = async (decision: AgentPermissionDecision) => {
    if (pending.current) return;
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
    <section
      aria-label="需要你的许可"
      className="rounded-panel border border-border-strong bg-subtle p-4"
    >
      <h3 className="flex items-center gap-2 text-body font-medium">
        <ShieldCheck className="h-4 w-4" />
        需要你的许可
      </h3>
      <p className="mt-2 whitespace-pre-wrap text-body">
        {request.description || request.action}
      </p>
      {request.resources.length > 0 && (
        <ul className="mt-2 space-y-1 text-caption text-fg-2">
          {request.resources.map((resource, index) => (
            <li key={index} className="break-all">
              {resource}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void reply("once")}>
          允许一次
        </Button>
        <Button
          variant="neutral"
          disabled={busy}
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
        记住授权会保存到当前项目，按工具请求的范围生效；范围可能包含同类操作。
      </p>
      {error && (
        <p role="alert" className="mt-2 text-caption text-danger-text">
          {error}
        </p>
      )}
    </section>
  );
}
