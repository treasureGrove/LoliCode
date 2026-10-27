import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, ShieldCheck } from "lucide-react";
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
      className="space-y-4"
    >
      <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
        <strong className="flex items-center gap-2 text-sm">
          <ShieldCheck size={16} aria-hidden="true" />
          {text(
            "登录同一账户，无需配对码",
            "Use the same account, without pairing codes",
          )}
        </strong>
        <p className="text-sm text-fg-2">
          {text(
            "手机登录同一个 LoliCode 账户，选择这台电脑，再在此处确认。确认后的手机可浏览已注册项目的会话目录，选中后读取历史并续聊。每台设备使用独立密钥，内容端到端加密。",
            "Sign in to the same LoliCode account on your phone, select this computer, then confirm here. Your approved phone can browse registered project sessions, select one to read its history and continue the conversation. Each device has its own key; content is end-to-end encrypted.",
          )}
        </p>
      </div>
      {!status && !error && (
        <p role="status" className="text-sm text-fg-2">
          {text("正在读取账户连接…", "Loading account connection…")}
        </p>
      )}
      {status && !status.signedIn && (
        <div className="space-y-2">
          <p className="text-sm">
            {text(
              "先在电脑登录 LoliCode 账户。",
              "Sign in to LoliCode on this computer first.",
            )}
          </p>
          {onRequestLogin && (
            <Button onClick={onRequestLogin}>
              {text("登录 LoliCode", "Sign in to LoliCode")}
            </Button>
          )}
        </div>
      )}
      {status?.signedIn && (
        <div className="space-y-3">
          {!status.enabled ? (
            <>
              <label className="block space-y-2 text-sm">
                <span>{text("这台电脑的名称", "Computer name")}</span>
                <Input
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                  maxLength={40}
                  disabled={busy}
                  autoComplete="off"
                  placeholder={text("我的电脑", "My computer")}
                />
              </label>
              <Button
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
                    className="mr-2 animate-spin"
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
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-sm">
                    {status.device?.deviceName ||
                      text("这台电脑", "This computer")}
                  </p>
                  <p className="text-xs text-fg-2">
                    {status.lastError
                      ? text(
                          "连接暂不可用，正在重试",
                          "Connection unavailable; retrying",
                        )
                      : text(
                          "手机登录后即可选择此电脑",
                          "Select this computer after signing in on your phone",
                        )}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(mobileCompanionApi.disconnectAccount)
                  }
                >
                  {text("关闭账户连接", "Turn off account connection")}
                </Button>
              </div>
              {!pending.length && (
                <p className="text-sm text-fg-2">
                  {text(
                    "没有待确认的手机。",
                    "No phones awaiting confirmation.",
                  )}
                </p>
              )}
              {status.lastError && (
                <Button
                  size="sm"
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
              className="space-y-3 rounded-lg border border-border p-4"
            >
              <div>
                <strong className="text-sm">{request.phone.deviceName}</strong>
                <p className="text-xs text-fg-2">
                  {text(
                    "同一账户的手机请求连接",
                    "A phone on your account requests access",
                  )}
                </p>
              </div>
              <details className="text-xs text-fg-2">
                <summary className="cursor-pointer">
                  {text("设备密钥指纹", "Device key fingerprint")}
                </summary>
                <code className="mt-2 block break-all select-text">
                  {request.phone.fingerprint}
                </code>
              </details>
              <div className="flex gap-2">
                <Button
                  size="sm"
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
                  variant="outline"
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
        <p role="alert" className="text-sm text-red-600">
          {text(
            "账户连接未完成，请检查登录状态和网络后重试。",
            "Account connection is unavailable. Check your sign-in and network, then retry.",
          )}
        </p>
      )}
    </section>
  );
}
