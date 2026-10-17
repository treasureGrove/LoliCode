import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { AlertTriangle, FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface AppDataRecoveryProps {
  path: string;
  error: string;
}

export function AppDataRecovery({ path, error }: AppDataRecoveryProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const chooseDirectory = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择原 LoliCode 数据目录",
      });
      if (typeof selected !== "string") return;
      await invoke("recover_app_config_dir", { path: selected });
      await relaunch();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10 text-foreground">
      <section className="w-full max-w-2xl rounded-2xl border border-border bg-card p-7 shadow-xl">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <AlertTriangle aria-hidden="true" />
        </div>
        <h1 className="text-xl font-semibold">找不到原来的数据目录</h1>
        <p className="mt-3 leading-7 text-muted-foreground">
          LoliCode
          检测到上次使用的数据目录当前不可用，因此暂停启动，避免创建一份空数据库让项目、渠道和
          API Key 看起来丢失。本次启动没有清除旧数据。
        </p>
        <div className="my-5 rounded-lg border border-border bg-muted/40 p-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">
            上次使用的位置
          </div>
          <code className="break-all text-sm">{path}</code>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          如果数据盘或同步目录暂时未连接，请先连接后重启。也可以选择包含{" "}
          <code>cc-switch.db</code>（或旧版 <code>config.json</code>
          ）的原数据目录。
        </p>
        {error && <p className="mt-3 text-sm text-muted-foreground">{error}</p>}
        {message && (
          <p
            role="alert"
            className="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
          >
            {message}
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={chooseDirectory} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FolderOpen className="mr-2 h-4 w-4" />
            )}
            选择原数据目录并重启
          </Button>
          <Button
            variant="outline"
            onClick={() => void exit(0)}
            disabled={busy}
          >
            退出
          </Button>
        </div>
      </section>
    </main>
  );
}
