import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  rendererUpdatesApi,
  rendererStatusKey,
} from "@/lib/api/renderer-updates";
import { hasUnsavedChanges } from "@/lib/unsavedChanges";

export function RendererUpdatesSection() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { data, error } = useQuery({
    queryKey: rendererStatusKey,
    queryFn: rendererUpdatesApi.local,
    retry: false,
    staleTime: Infinity,
  });
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (action: "check" | "install" | "rollback" | "restart") => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (action === "check") {
        const version = await rendererUpdatesApi.check();
        setAvailable(version);
        if (version === null) setMessage(t("rendererUpdates.none"));
      } else if (action === "restart") {
        if (hasUnsavedChanges()) throw new Error(t("rendererUpdates.unsaved"));
        await rendererUpdatesApi.restart();
      } else {
        if (action === "install") await rendererUpdatesApi.install();
        else await rendererUpdatesApi.rollback(data?.runningId ?? "");
        setAvailable(null);
        client.setQueryData(
          rendererStatusKey,
          await rendererUpdatesApi.local(),
        );
        setMessage(t("rendererUpdates.staged"));
      }
    } catch (cause) {
      setMessage(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const disabled =
    busy ||
    !data ||
    data.development ||
    data.state.restartRequired ||
    data.state.pendingConfirmation;
  return (
    <section
      className="space-y-3 px-5 py-4"
      aria-label={t("rendererUpdates.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-body font-semibold">
          {t("rendererUpdates.title")}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="neutral"
            disabled={disabled}
            onClick={() => void run("check")}
          >
            {t("rendererUpdates.check")}
          </Button>
          {available !== null && (
            <Button disabled={disabled} onClick={() => void run("install")}>
              {t("rendererUpdates.install", { version: available })}
            </Button>
          )}
          {data?.state.canRollback && (
            <Button
              variant="ghost"
              disabled={disabled}
              onClick={() => void run("rollback")}
            >
              {t("rendererUpdates.rollback")}
            </Button>
          )}
          {data?.state.restartRequired && (
            <Button disabled={busy} onClick={() => void run("restart")}>
              {t("rendererUpdates.restart")}
            </Button>
          )}
        </div>
      </div>
      <p className="text-caption text-fg-2">
        {data?.development
          ? t("rendererUpdates.development")
          : data?.runningVersion
            ? t("rendererUpdates.current", { version: data.runningVersion })
            : t("rendererUpdates.bundled")}{" "}
        · {t("rendererUpdates.scope")}
      </p>
      {(message || data?.warning || error) && (
        <p role="status" className="text-caption text-fg-2">
          {message ?? data?.warning ?? String(error)}
        </p>
      )}
    </section>
  );
}
