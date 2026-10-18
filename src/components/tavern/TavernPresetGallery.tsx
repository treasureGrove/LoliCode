import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  BookHeart,
  Check,
  ChevronRight,
  LoaderCircle,
  Search,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { tavernApi, TAVERN_PRESETS_KEY } from "@/lib/api/tavern";
import companion from "@/assets/atelier/companion.png";

export function TavernPresetGallery({
  open,
  onOpenChange,
  onStart,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (presetId: string) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const startLock = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [search, open]);
  const presets = useQuery({
    queryKey: TAVERN_PRESETS_KEY,
    queryFn: tavernApi.getPresets,
    enabled: open,
    retry: false,
  });
  const query = search.trim().toLocaleLowerCase();
  const visible = (presets.data ?? []).filter((item) =>
    [item.name, item.work, ...item.tags].some((value) =>
      value.toLocaleLowerCase().includes(query),
    ),
  );
  const start = async (id: string) => {
    if (startLock.current || busy) return;
    startLock.current = true;
    setPending(id);
    setError("");
    try {
      await onStart(id);
      onOpenChange(false);
    } catch (cause) {
      setError(
        typeof cause === "string"
          ? cause
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    } finally {
      startLock.current = false;
      setPending(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!startLock.current) onOpenChange(value);
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookHeart className="h-5 w-5 text-action-text" />
            {t("tavern.presets.title")}
          </DialogTitle>
          <DialogDescription>
            {t("tavern.presets.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-4">
          <label className="flex items-center gap-2 rounded-xl border border-border bg-subtle/50 px-3">
            <Search className="h-4 w-4 shrink-0 text-fg-3" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("tavern.presets.search")}
              aria-label={t("tavern.presets.search")}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-3"
            />
          </label>
        </div>
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-6 pb-2">
          {presets.isLoading ? (
            <p
              role="status"
              className="flex items-center justify-center gap-2 py-12 text-sm text-fg-3"
            >
              <LoaderCircle className="h-4 w-4 animate-spin" />
              {t("tavern.presets.loading")}
            </p>
          ) : presets.error ? (
            <div role="alert" className="py-8 text-center text-sm text-danger">
              <p>{t("tavern.presets.loadFailed")}</p>
              <Button
                variant="outline"
                className="mt-3"
                onClick={() => void presets.refetch()}
              >
                {t("tavern.presets.retry")}
              </Button>
            </div>
          ) : visible.length === 0 ? (
            <p role="status" className="py-12 text-center text-sm text-fg-3">
              {t("tavern.presets.noResults")}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {visible.map((preset) => (
                <article
                  key={preset.id}
                  aria-label={preset.name}
                  className="flex flex-col rounded-2xl border border-border bg-subtle/35 p-4 transition-colors hover:border-border-strong"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-action/15 bg-action/5 text-action-text">
                      {preset.id === "sillyloli" ? (
                        <img
                          src={companion}
                          alt=""
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <span className="font-serif text-2xl">
                          {preset.name.slice(0, 1)}
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] text-fg-3">
                        {preset.work} ·{" "}
                        {t(
                          `tavern.presets.${preset.kind === "original" ? "original" : "fan"}`,
                        )}
                      </p>
                      <h3 className="mt-0.5 text-base font-semibold">
                        {preset.name}
                      </h3>
                      <p className="mt-1 text-xs leading-5 text-fg-2">
                        {preset.tagline}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {preset.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-md bg-action/5 px-2 py-0.5 text-[10px] text-fg-3"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  <details className="my-3 text-xs text-fg-2">
                    <summary className="cursor-pointer select-none py-1 text-action-text">
                      {t("tavern.presets.preview")}
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap leading-6">
                      {preset.firstMes}
                    </p>
                  </details>
                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                    <span className="flex items-center gap-1 text-[11px] text-fg-3">
                      {preset.added ? (
                        <>
                          <Check className="h-3 w-3" />
                          {t("tavern.presets.added")}
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-3 w-3" />
                          {t("tavern.presets.offline")}
                        </>
                      )}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || pending !== null}
                      aria-label={t("tavern.presets.startWith", {
                        name: preset.name,
                      })}
                      onClick={() => void start(preset.id)}
                    >
                      {pending === preset.id ? (
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5" />
                      )}
                      {pending === preset.id
                        ? t("tavern.presets.starting")
                        : t("tavern.presets.start")}
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
        {(error || busy) && (
          <p
            role={error ? "alert" : "status"}
            className="px-6 pt-3 text-xs text-danger"
          >
            {error
              ? `${t("tavern.presets.startFailed")} ${error}`
              : t("tavern.presets.busy")}
          </p>
        )}
        <DialogFooter className="items-center justify-between gap-4">
          <p className="text-[10px] leading-5 text-fg-3">
            {t("tavern.presets.note")}
          </p>
          <Button
            variant="quiet"
            disabled={pending !== null}
            onClick={() => onOpenChange(false)}
          >
            {t("tavern.presets.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
