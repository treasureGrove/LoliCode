import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  rendererUpdatesApi,
  type RendererStatus,
} from "@/lib/api/renderer-updates";
import { hasUnsavedChanges } from "@/lib/unsavedChanges";

/** Remains reachable when the normal application/settings cannot render. */
export function RendererRecoveryButton() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<RendererStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void rendererUpdatesApi
      .local()
      .then((value) => {
        if (alive && value.runningId) setStatus(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!status?.runningId) return null;
  const recover = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (hasUnsavedChanges()) throw new Error(t("rendererUpdates.unsaved"));
      const fresh = await rendererUpdatesApi.local();
      if (!fresh.state.pendingConfirmation) {
        await rendererUpdatesApi.rollback(fresh.runningId ?? "");
      }
      await rendererUpdatesApi.restart();
    } catch (cause) {
      setError(String(cause));
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Button
        className="w-full"
        variant="neutral"
        disabled={busy}
        onClick={() => void recover()}
      >
        {t("rendererUpdates.recover")}
      </Button>
      {error && (
        <p role="status" className="text-sm text-fg-2">
          {error}
        </p>
      )}
    </div>
  );
}
