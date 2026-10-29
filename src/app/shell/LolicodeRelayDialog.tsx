import { useCallback, useEffect, useRef, useState } from "react";
import {
  lolicodeAccountApi,
  type LolicodeRelayStatus,
} from "@/lib/api/lolicode-account";
import { Button } from "@/components/ui/button";
import { FreeModelBadge } from "@/components/ui/free-model-badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function LolicodeRelayDialog({
  open,
  onOpenChange,
  accountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
}) {
  const [status, setStatus] = useState<LolicodeRelayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const load = useCallback(
    async (sync: boolean) => {
      const current = ++generation.current;
      setBusy(true);
      setError(null);
      try {
        if (sync) await lolicodeAccountApi.connectRelay();
        const result = await lolicodeAccountApi.relayStatus();
        if (generation.current === current && result.account.id === accountId)
          setStatus(result);
      } catch (cause) {
        if (generation.current === current) {
          setStatus(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (generation.current === current) setBusy(false);
      }
    },
    [accountId],
  );
  useEffect(() => {
    setStatus(null);
    if (open && accountId) void load(false);
    return () => {
      generation.current += 1;
    };
  }, [open, accountId, load]);
  if (!accountId) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>公益模型与每日额度</DialogTitle>
          <DialogDescription>
            使用当前 LoliCode 账号，所有设备共用每日额度，新加坡时间零点重置。
          </DialogDescription>
        </DialogHeader>
        {busy && <p role="status">正在读取额度…</p>}
        {error && <p role="alert">{error}</p>}
        {status && (
          <div className="space-y-3 text-sm">
            <p>
              今日剩余请求：
              <strong>
                {status.quota.requestsRemaining} / {status.quota.requestLimit}
              </strong>
            </p>
            <p>
              今日剩余 token：
              <strong>
                {status.quota.tokensRemaining.toLocaleString()} /{" "}
                {status.quota.tokenLimit.toLocaleString()}
              </strong>
            </p>
            {status.quota.tokensReserved > 0 && (
              <p>
                正在处理的请求已预留{" "}
                {status.quota.tokensReserved.toLocaleString()} token。
              </p>
            )}
            <p>输入与输出合并计量，任一额度用完即停止，当日剩余额度不累积。</p>
            <p>
              请求结束后按上游用量结算；中断且未返回用量时，按预留额度计入。
            </p>
            {status.ready ? (
              <div className="space-y-1.5">
                <p>已开放：</p>
                <ul className="space-y-1.5">
                  {status.models.map((model) => (
                    <li key={model.id} className="flex items-center gap-1.5">
                      <span className="min-w-0 break-words">
                        {model.name || model.id}
                      </span>
                      <FreeModelBadge />
                    </li>
                  ))}
                </ul>
                <p>在 LoliCode 模型列表中选择公益模型即可使用。</p>
              </div>
            ) : (
              <p>
                账号与额度已就绪，公益模型尚未开放。开放后刷新即可加入模型列表。
              </p>
            )}
          </div>
        )}
        <Button disabled={busy} onClick={() => void load(true)}>
          刷新额度和模型
        </Button>
      </DialogContent>
    </Dialog>
  );
}
