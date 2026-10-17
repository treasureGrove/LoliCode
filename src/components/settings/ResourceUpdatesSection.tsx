import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  resourcePackKey,
  resourceUpdatesApi,
} from "@/lib/api/resource-updates";

export function ResourceUpdatesSection() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const { data } = useQuery({
    queryKey: resourcePackKey,
    queryFn: resourceUpdatesApi.local,
    retry: false,
    staleTime: Infinity,
  });
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = async (action: "check" | "install" | "rollback") => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (action === "check") {
        const version = await resourceUpdatesApi.check();
        setAvailable(version);
        if (version === null) setMessage(t("resourceUpdates.none"));
      } else {
        const pack =
          action === "install"
            ? await resourceUpdatesApi.install()
            : await resourceUpdatesApi.rollback(data?.id ?? "");
        client.setQueryData(resourcePackKey, pack);
        setAvailable(null);
        setMessage(
          t(
            action === "install"
              ? "resourceUpdates.applying"
              : "resourceUpdates.restored",
          ),
        );
      }
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="space-y-3 px-5 py-4"
      aria-label={t("resourceUpdates.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-body font-semibold">
          {t("resourceUpdates.title")}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="neutral"
            disabled={busy || data?.pendingConfirmation}
            onClick={() => void run("check")}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {t("resourceUpdates.check")}
          </Button>
          {available !== null && (
            <Button
              disabled={busy || data?.pendingConfirmation}
              onClick={() => void run("install")}
            >
              {t("resourceUpdates.install", { version: available })}
            </Button>
          )}
          {data?.canRollback && (
            <Button
              variant="ghost"
              disabled={busy || data.pendingConfirmation}
              onClick={() => void run("rollback")}
            >
              {t("resourceUpdates.rollback")}
            </Button>
          )}
        </div>
      </div>
      <p className="text-caption text-fg-2">
        {data?.version
          ? t("resourceUpdates.current", { version: data.version })
          : t("resourceUpdates.bundled")}{" "}
        · {t("resourceUpdates.scope")}
      </p>
      {(message || data?.warning) && (
        <p role="status" className="text-caption text-fg-2">
          {message ?? data?.warning}
        </p>
      )}
    </section>
  );
}
