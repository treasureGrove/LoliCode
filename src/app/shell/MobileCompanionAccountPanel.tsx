import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Monitor, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  mobileCompanionApi,
  type CompanionAccountStatus,
} from "@/lib/api/mobile-companion";

export function MobileCompanionAccountPanel({
  open,
  accountId,
  onRequestLogin,
}: {
  open: boolean;
  accountId?: string | null;
  onRequestLogin?: () => void;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const text = (chinese: string, english: string) => (zh ? chinese : english);
  const [status, setStatus] = useState<CompanionAccountStatus | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setStatus(null);
    setError(false);
    setBusy(false);
    setDeviceName("");
    if (!open) return;
    let loading = false;
    const accept = (next: CompanionAccountStatus) => {
      if (generation.current !== current) return;
      if (accountId !== undefined && next.accountId !== accountId) return;
      setStatus(next);
      setError(false);
      setDeviceName((previous) => previous || next.device?.deviceName || "");
    };
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        accept(await mobileCompanionApi.accountStatus());
      } catch {
        if (generation.current === current) setError(true);
      } finally {
        loading = false;
      }
    };
    void mobileCompanionApi
      .setAccountVisible(true)
      .then(accept)
      .catch(() => {
        if (generation.current === current) setError(true);
      });
    void refresh();
    // This reads local native state; native code controls bounded network polling.
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
      void mobileCompanionApi.setAccountVisible(false).catch(() => undefined);
    };
  }, [open, accountId]);

  const action = async (operation: () => Promise<CompanionAccountStatus>) => {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    setError(false);
    try {
      const next = await operation();
      if (
        generation.current === current &&
        (accountId === undefined || next.accountId === accountId)
      )
        setStatus(next);
    } catch {
      if (generation.current === current) setError(true);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };
  const pending =
    status?.requests.filter(
      (request) =>
        request.status === "pending" && request.expiresAt > Date.now(),
    ) ?? [];

  return (
    <section
      aria-label={text("账户连接", "Account connection")}
      className="space-y-5 rounded-2xl border border-border/60 bg-muted/20 p-5"
    >
      <div className="space-y-1.5">
        <h3 className="text-sm font-semibold">
          {text("让手机发现这台电脑", "Make this computer discoverable")}
        </h3>
        <p className="text-xs leading-relaxed text-fg-2">
          {text(
            "在手机上选择这台电脑，再回来确认连接。",
            "Select this computer on your phone, then confirm the connection here.",
          )}
        </p>
      </div>
      {!status && !error && (
        <p role="status" className="flex items-center gap-2 text-sm text-fg-2">
          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          {text("正在读取账户连接…", "Loading account connection…")}
        </p>
      )}
      {status && !status.signedIn && (
        <div className="space-y-4">
          <p className="text-sm text-fg-2">
            {text(
              "先在电脑登录 LoliCode 账户。",
              "Sign in to LoliCode on this computer first.",
            )}
          </p>
          {onRequestLogin && (
            <Button
              className="h-auto min-h-9 w-full whitespace-normal py-2"
              onClick={onRequestLogin}
            >
              {text("登录 LoliCode", "Sign in to LoliCode")}
            </Button>
          )}
        </div>
      )}
      {status?.signedIn && (
        <div className="space-y-4">
          {!status.enabled ? (
            <>
              <label className="block space-y-2 text-xs text-fg-2">
                <span>{text("这台电脑的名称", "Computer name")}</span>
                <Input
                  className="h-9 bg-surface text-sm text-fg-1"
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                  maxLength={40}
                  disabled={busy}
                  autoComplete="off"
                  placeholder={text("我的电脑", "My computer")}
                />
              </label>
              <Button
                className="h-auto min-h-9 w-full whitespace-normal py-2"
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    mobileCompanionApi.connectAccount(
                      deviceName.trim() || undefined,
                    ),
                  )
                }
              >
                {busy && (
                  <Loader2
                    size={15}
                    className="shrink-0 animate-spin"
                    aria-hidden="true"
                  />
                )}
                {text(
                  "允许我的手机发现此电脑",
                  "Make this computer available to my phone",
                )}
              </Button>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 basis-40 items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-surface text-fg-2">
                    <Monitor size={19} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 space-y-1">
                    <p className="break-all text-sm font-medium">
                      {status.device?.deviceName ||
                        text("这台电脑", "This computer")}
                    </p>
                    <p className="flex items-center gap-1.5 text-xs text-fg-2">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.lastError ? "bg-warning" : "bg-success"}`}
                        aria-hidden="true"
                      />
                      {status.lastError
                        ? text("连接重试中", "Retrying connection")
                        : text("已开启发现", "Discovery enabled")}
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-auto min-h-7 max-w-full whitespace-normal py-1 text-xs"
                  disabled={busy}
                  onClick={() =>
                    void action(mobileCompanionApi.disconnectAccount)
                  }
                >
                  {text("关闭账户连接", "Turn off account connection")}
                </Button>
              </div>
              {!pending.length && (
                <p className="text-xs text-fg-2">
                  {text(
                    "没有待确认的手机。",
                    "No phones awaiting confirmation.",
                  )}
                </p>
              )}
              {status.lastError && (
                <Button
                  size="sm"
                  className="h-auto min-h-7 max-w-full whitespace-normal py-1"
                  disabled={busy}
                  onClick={() =>
                    void action(() => mobileCompanionApi.connectAccount())
                  }
                >
                  {text("重试直连", "Retry direct connection")}
                </Button>
              )}
            </>
          )}
          {pending.map((request) => (
            <section
              key={request.requestId}
              className="space-y-4 rounded-xl border border-border/60 bg-surface p-4"
            >
              <div className="flex items-center gap-3">
                <Smartphone
                  size={19}
                  className="shrink-0 text-fg-2"
                  aria-hidden="true"
                />
                <div className="min-w-0 space-y-1">
                  <p className="break-all text-sm font-medium">
                    {request.phone.deviceName}
                  </p>
                  <p className="text-xs text-fg-2">
                    {text(
                      "同一账户的手机请求连接",
                      "A phone on your account requests access",
                    )}
                  </p>
                </div>
              </div>
              <details className="text-xs text-fg-2">
                <summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {text("设备密钥指纹", "Device key fingerprint")}
                </summary>
                <code className="mt-2 block break-all select-text">
                  {request.phone.fingerprint}
                </code>
              </details>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  className="h-auto min-h-8 max-w-full whitespace-normal py-1.5"
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      mobileCompanionApi.approveAccountRequest(
                        request.requestId,
                        request.phone.fingerprint,
                      ),
                    )
                  }
                >
                  {text("确认这是我的手机", "Confirm my phone")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      mobileCompanionApi.rejectAccountRequest(
                        request.requestId,
                      ),
                    )
                  }
                >
                  {text("拒绝", "Reject")}
                </Button>
              </div>
            </section>
          ))}
        </div>
      )}
      {(error || status?.lastError) && (
        <p role="alert" className="text-xs leading-relaxed text-danger-text">
          {text(
            "账户连接未完成，请检查登录状态和网络后重试。",
            "Account connection is unavailable. Check your sign-in and network, then retry.",
          )}
        </p>
      )}
    </section>
  );
}
