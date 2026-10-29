import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Download,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
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
      <DialogContent className="max-w-xl overflow-hidden">
        <DialogHeader className="relative gap-3 px-6 pb-6 pt-7 pr-16 sm:px-8 sm:pr-16">
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-4 top-4 rounded-full"
              aria-label={text("关闭手机连接", "Close phone connection")}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DialogClose>
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-action-soft text-action-text">
              <Smartphone size={22} strokeWidth={1.6} aria-hidden="true" />
            </span>
            <div className="min-w-0 space-y-1">
              <DialogTitle>
                {text("连接 Android 手机", "Connect an Android phone")}
              </DialogTitle>
              <DialogDescription className="leading-relaxed">
                {text(
                  "把会话带到手机上，随时接着聊。",
                  "Take your conversations with you and keep chatting.",
                )}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="min-h-0 space-y-6 overflow-y-auto px-6 py-6 sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 flex-1 basis-48 space-y-1">
              <h3 className="text-sm font-medium">
                {text("准备好手机端", "Get the phone app")}
              </h3>
              <p className="text-xs leading-relaxed text-fg-2">
                {text(
                  "安装 Android 应用，登录同一 LoliCode 账户。",
                  "Install the Android app and sign in to the same LoliCode account.",
                )}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              className="h-9"
              aria-label={text("下载 Android 应用", "Download the Android app")}
              onClick={() =>
                void settingsApi.openExternal("https://lolicode.com/mobile/")
              }
            >
              <Download size={15} aria-hidden="true" />
              {text("下载应用", "Download app")}
            </Button>
          </div>
          <MobileCompanionAccountPanel
            open={open}
            accountId={accountId}
            onRequestLogin={onRequestLogin}
          />
          {devices.length > 0 && (
            <section
              aria-label={text("已连接的手机", "Connected phones")}
              className="space-y-3"
            >
              <h3 className="text-xs font-medium text-fg-2">
                {text("已连接的手机", "Connected phones")}
                <span className="ml-2 tabular-nums text-fg-3">
                  {devices.length}
                </span>
              </h3>
              <div className="divide-y divide-border/60">
                {devices.map((device) => (
                  <div
                    key={device.roomId}
                    className="space-y-2 py-3 first:pt-0 last:pb-0"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <Smartphone
                        size={18}
                        className="shrink-0 text-fg-3"
                        aria-hidden="true"
                      />
                      <div className="min-w-0 flex-1 basis-40 space-y-1">
                        <p className="break-words text-sm font-medium">
                          {device.deviceName || text("我的手机", "My phone")}
                        </p>
                        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-fg-2">
                          <span
                            className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${device.online && device.transport === "direct" ? "bg-success" : device.online && device.transport === "text" ? "bg-warning" : "bg-control-off"}`}
                            aria-hidden="true"
                          />
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
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {!device.online && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void action(() =>
                                mobileCompanionApi.connectAccount(),
                              )
                            }
                          >
                            {text("重试连接", "Retry connection")}
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void action(() =>
                              mobileCompanionApi.revoke(device.roomId),
                            )
                          }
                        >
                          {text("撤销连接", "Revoke access")}
                        </Button>
                      </div>
                    </div>
                    {device.lastError && (
                      <p className="pl-7 text-xs leading-relaxed text-fg-2">
                        {text(
                          "连接受限或文本额度已用尽，请查看设备状态后重试。",
                          "The connection is unavailable or the text quota is exhausted. Check device status and retry.",
                        )}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-lg bg-danger-soft px-3 py-2 text-sm leading-relaxed text-danger-text"
            >
              {text(
                "无法读取或更新手机连接，请检查账户状态后重试。",
                "Unable to read or update device connections. Check your account and retry.",
              )}
            </p>
          )}
          <div className="space-y-3 border-t border-border/60 pt-4">
            <p className="flex items-center gap-1.5 text-xs text-fg-2">
              <ShieldCheck
                size={14}
                className="shrink-0 text-fg-3"
                aria-hidden="true"
              />
              {text(
                "端到端加密 · 无需配对码",
                "End-to-end encrypted · No pairing code",
              )}
            </p>
            <p className="text-xs leading-relaxed text-fg-3">
              {text(
                "电脑需保持开机、联网并运行 LoliCode。",
                "Keep your computer on and online with LoliCode running.",
              )}
            </p>
            <details className="group text-xs text-fg-2">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm py-1 outline-none hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {text("连接与功能说明", "Connection details and limits")}
                <ChevronDown
                  size={14}
                  className="shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                  aria-hidden="true"
                />
              </summary>
              <div className="space-y-3 pt-3 leading-relaxed">
                <p>
                  {text(
                    "确认后的手机可浏览已注册项目的会话目录，读取历史并续聊。每台设备使用独立密钥。",
                    "Approved phones can browse registered project sessions, read history and continue conversations. Each device uses its own key.",
                  )}
                </p>
                <p>
                  {text(
                    "优先直连，连接受限时使用加密文本通道，任务在电脑后台执行。",
                    "Direct connections are preferred, with encrypted text fallback when needed. Tasks run on your computer.",
                  )}
                </p>
                <p>
                  {text(
                    "文本通道只同步有大小和流量限制的文字、状态与问题卡片，由手机本地显示。图片、文件和桌面视频不经此通道转发；额度用尽会停止并提示。",
                    "Text fallback syncs bounded text, status and question cards for local display on your phone. Images, files and desktop video are excluded. Forwarding stops when its quota is exhausted.",
                  )}
                </p>
                <p>
                  {text(
                    "后台安全模式支持文件与检索任务；终端命令和桌面点击等工具暂不开放。系统锁屏推送暂未启用。",
                    "Background-safe mode supports file and search tasks. Shell commands and interactive desktop tools are unavailable. Lockscreen push is currently disabled.",
                  )}
                </p>
              </div>
            </details>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
