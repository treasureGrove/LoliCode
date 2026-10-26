import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  mobileCompanionApi,
  type MobileCompanionStatus,
} from "@/lib/api/mobile-companion";
import { settingsApi } from "@/lib/api/settings";
import { MobileCompanionAccountPanel } from "./MobileCompanionAccountPanel";

export function MobileCompanionDialog({
  open,
  onOpenChange,
  accountId,
  onRequestLogin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId?: string | null;
  onRequestLogin?: () => void;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const text = (chinese: string, english: string) => (zh ? chinese : english);
  const [status, setStatus] = useState<MobileCompanionStatus | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setStatus(null);
    setError(false);
    setBusy(false);
    if (!open) return;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await mobileCompanionApi.status();
        if (generation.current === current) setStatus(result);
      } catch {
        if (generation.current === current) setError(true);
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [open, accountId]);

  const action = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    const current = generation.current;
    setBusy(true);
    setError(false);
    try {
      await operation();
      const next = await mobileCompanionApi.status();
      if (generation.current === current) setStatus(next);
    } catch {
      if (generation.current === current) setError(true);
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };
  // Native code enforces the same account ownership and direct-only boundary.
  const devices =
    status?.pairs.filter(
      (device) =>
        device.accountId &&
        (accountId === undefined || device.accountId === accountId),
    ) ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone size={18} aria-hidden="true" />
            {text("连接 Android 手机", "Connect an Android phone")}
          </DialogTitle>
          <DialogDescription>
            {text(
              "手机与电脑直接通信，任务在电脑后台执行。电脑需要保持开机、联网并运行 LoliCode。",
              "Connect directly to your computer and run tasks quietly in the background. Keep the computer online and LoliCode running.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 p-5 pt-0">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void settingsApi.openExternal("https://lolicode.com/mobile/")
            }
          >
            {text("下载 Android 应用", "Download the Android app")}
          </Button>
          <MobileCompanionAccountPanel
            open={open}
            accountId={accountId}
            onRequestLogin={onRequestLogin}
          />
          <p className="rounded-lg bg-muted/40 p-3 text-sm text-fg-2">
            {text(
              "仅直连：服务器只协助登录、发现设备和建立连接，不转发任务、回复、图片或文件。无法打通时，请切换网络后重试。",
              "Direct only: the server helps sign in, find devices and establish connections. It never forwards task content, replies, images or files. If a direct connection fails, switch networks and retry.",
            )}
          </p>
          {devices.map((device) => (
            <section
              key={device.roomId}
              className="space-y-2 rounded-lg border border-border p-3"
            >
              <div className="flex items-center justify-between gap-3">
                <strong className="text-sm">
                  {device.deviceName || text("我的手机", "My phone")}
                </strong>
                <span className="text-xs text-fg-2">
                  {device.online && device.transport === "direct"
                    ? text(
                        "已直连 · 端到端加密",
                        "Direct · End-to-end encrypted",
                      )
                    : text("未建立直连", "Direct connection unavailable")}
                </span>
              </div>
              {device.lastError && (
                <p className="text-xs text-fg-2">
                  {text(
                    "直连不可用，请切换网络后重试。",
                    "A direct connection is unavailable. Switch networks and retry.",
                  )}
                </p>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void action(() => mobileCompanionApi.revoke(device.roomId))
                }
              >
                {text("撤销连接", "Revoke access")}
              </Button>
              {!device.online && (
                <Button
                  type="button"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void action(() => mobileCompanionApi.connectAccount())
                  }
                >
                  {text("重试直连", "Retry direct connection")}
                </Button>
              )}
            </section>
          ))}
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {text(
                "无法读取或更新手机连接，请检查账户状态后重试。",
                "Unable to read or update device connections. Check your account and retry.",
              )}
            </p>
          )}
          <p className="text-xs text-fg-2">
            {text(
              "后台安全模式支持文件与检索任务；终端命令和桌面点击等工具暂不开放。系统锁屏推送暂未启用。",
              "Background-safe mode supports file and search tasks. Shell commands and interactive desktop tools are unavailable. Lockscreen push is currently disabled.",
            )}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
