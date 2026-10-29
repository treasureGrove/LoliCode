import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Cpu,
  Download,
  LoaderCircle,
  Pause,
  Power,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { tavernApi, TAVERN_LOCAL_MODEL_KEY } from "@/lib/api/tavern";

export function TavernLocalModelPanel({
  onChange,
}: {
  onChange: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: TAVERN_LOCAL_MODEL_KEY,
    queryFn: tavernApi.getLocalModel,
    retry: false,
    refetchInterval: (q) => {
      const stage = q.state.data?.stage;
      return stage === "downloading" ||
        stage === "verifying" ||
        stage === "starting"
        ? 1000
        : stage === "running"
          ? 5000
          : false;
    },
  });
  const status = query.data;
  const busy =
    pending ||
    status?.stage === "downloading" ||
    status?.stage === "verifying" ||
    status?.stage === "starting";
  useEffect(() => {
    if (status?.installed) void onChange();
  }, [status?.installed, status?.enabled, onChange]);

  async function act(action: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await action();
      await client.invalidateQueries({ queryKey: TAVERN_LOCAL_MODEL_KEY });
      await onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await client.invalidateQueries({ queryKey: TAVERN_LOCAL_MODEL_KEY });
    } finally {
      setPending(false);
    }
  }
  const progress = status
    ? Math.min(
        100,
        (status.downloadedBytes / Math.max(1, status.totalBytes)) * 100,
      )
    : 0;
  const stage = status?.stage ?? "notInstalled";

  return (
    <section
      aria-label={t("tavern.local.title")}
      className="mx-4 mt-3 shrink-0 overflow-hidden rounded-xl border border-border bg-surface lg:mx-5"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        aria-label={t(
          expanded ? "tavern.local.collapse" : "tavern.local.expand",
        )}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Cpu className="h-4 w-4 shrink-0 text-fg-3" />
        <span className="shrink-0 text-sm font-semibold">
          {t("tavern.local.title")}
        </span>
        <span
          role="status"
          className="min-w-0 flex-1 truncate text-xs text-fg-3"
        >
          {query.isError
            ? t("tavern.local.loadFailed")
            : !status
              ? t("tavern.local.loading")
              : stage === "ready" && !status.enabled
                ? t("tavern.local.disabled")
                : t(`tavern.local.states.${stage}`)}
          {(stage === "downloading" || stage === "verifying") &&
            ` · ${progress.toFixed(1)}%`}
          {stage === "running" && status && status.cpuFfnLayers > 0 && (
            <> · {t("tavern.local.memoryMode")}</>
          )}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-fg-3 transition-transform ${expanded ? "rotate-180" : ""}`}
        />
      </button>
      {(stage === "downloading" || stage === "verifying") && status && (
        <progress
          className="block h-1 w-full accent-action"
          aria-label={t("tavern.local.progress")}
          max={100}
          value={progress}
        />
      )}
      {(error || status?.error) && (
        <p
          role="alert"
          className="max-h-16 overflow-y-auto px-4 pb-2 break-words text-xs text-destructive"
        >
          {error ?? status?.error}
        </p>
      )}
      <div
        id={detailsId}
        hidden={!expanded}
        className="max-h-[30vh] overflow-y-auto border-t border-border px-4 py-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm">{t("tavern.local.model")}</p>
            <p className="mt-1 text-xs text-fg-3">
              {t("tavern.local.description")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {query.isError && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void query.refetch()}
              >
                {t("common.retry")}
              </Button>
            )}
            {status?.enabled && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(() => tavernApi.setLocalModelEnabled(false))
                }
              >
                {t("tavern.local.useChannels")}
              </Button>
            )}
            {stage === "running" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => void act(tavernApi.stopLocalModel)}
              >
                <Power className="h-4 w-4" />
                {t("tavern.local.release")}
              </Button>
            ) : stage === "downloading" || stage === "verifying" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => void act(tavernApi.pauseLocalModelInstall)}
              >
                <Pause className="h-4 w-4" />
                {t("tavern.local.pause")}
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={busy || !status?.supported}
                onClick={() =>
                  void act(
                    status?.installed && stage !== "paused"
                      ? () => tavernApi.setLocalModelEnabled(true)
                      : tavernApi.installLocalModel,
                  )
                }
              >
                {busy ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {status?.installed
                  ? t("tavern.local.start")
                  : stage === "paused" || stage === "error"
                    ? t("tavern.local.resume")
                    : t("tavern.local.install")}
              </Button>
            )}
          </div>
        </div>
        {(stage === "downloading" || stage === "verifying") && status && (
          <p className="mt-1 text-xs tabular-nums text-fg-3">
            {(status.downloadedBytes / 1e9).toFixed(2)} /{" "}
            {(status.totalBytes / 1e9).toFixed(2)} GB · {progress.toFixed(1)}%
          </p>
        )}
        {status?.installed && stage === "error" && (
          <Button
            variant="quiet"
            size="sm"
            disabled={busy}
            onClick={() => void act(tavernApi.installLocalModel)}
          >
            {t("tavern.local.repair")}
          </Button>
        )}
        <details className="mt-2 text-xs text-fg-3">
          <summary className="cursor-pointer">
            {t("tavern.local.details")}
          </summary>
          <p className="mt-2">{t("tavern.local.requirements")}</p>
          <p className="mt-1">{t("tavern.local.history")}</p>
          <p className="mt-1">
            Hugging Face · RX5950XT/silicon-based-girlfriend-v2-GGUF · llama.cpp
            b11729 / CUDA 13.4 · Q8 KV
          </p>
        </details>
      </div>
    </section>
  );
}
