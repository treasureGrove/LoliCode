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
  // Native code enforces account ownership and both transport boundaries.
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
              "优先直连，连接受限时使用加密文本通道，任务在电脑后台执行。电脑需要保持开机、联网并运行 LoliCode。",
              "Direct connections are preferred, with encrypted text fallback when needed. Tasks run on your computer. Keep it online with LoliCode running.",
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
              "文本通道只同步有大小和流量限制的文字、状态与问题卡片，由手机本地显示。图片、文件和桌面视频不经此通道转发；额度用尽会停止并提示。",
              "Text fallback syncs bounded text, status and question cards for local display on your phone. Images, files and desktop video are excluded. Forwarding stops when its quota is exhausted.",
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
                    : device.online && device.transport === "text"
                      ? text(
                          "受限文本 · 端到端加密",
                          "Limited text · End-to-end encrypted",
                        )
                      : text("连接未就绪", "Connection unavailable")}
                </span>
              </div>
              {device.lastError && (
                <p className="text-xs text-fg-2">
                  {text(
                    "连接受限或文本额度已用尽，请查看设备状态后重试。",
                    "The connection is unavailable or the text quota is exhausted. Check device status and retry.",
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
                  {text("重试连接", "Retry connection")}
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
