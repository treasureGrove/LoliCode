import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Expand, ImageOff, LoaderCircle, Minus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { discoveryApi, type DiscoveryEntry } from "@/lib/api/discovery";

export function RankingPreview({ entry }: { entry: DiscoveryEntry }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [broken, setBroken] = useState(false);
  const query = useQuery({
    queryKey: ["discovery-preview", entry.id, entry.preview?.sha256],
    queryFn: () => discoveryApi.preview(entry.id),
    enabled: !!entry.preview,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const unavailable = !entry.preview || query.isError || broken;
  if (unavailable) {
    return (
      <div className="mt-4 flex items-center gap-2 rounded-xl bg-app/60 px-4 py-3 text-xs text-fg-3">
        <ImageOff className="h-4 w-4 shrink-0" />
        {t("discovery.preview.unavailable")}
        {entry.preview && (
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              setBroken(false);
              void query.refetch();
            }}
          >
            {t("applications.retry")}
          </Button>
        )}
      </div>
    );
  }
  if (!query.data) {
    return (
      <div
        role="status"
        className="mt-4 flex h-36 items-center justify-center gap-2 rounded-xl bg-app/60 text-xs text-fg-3"
      >
        <LoaderCircle className="h-4 w-4 animate-spin" />
        {t("discovery.preview.loading")}
      </div>
    );
  }
  const caption = t("discovery.preview.date", { date: query.data.capturedAt });
  const alt = t("discovery.preview.alt", { name: entry.name });
  return (
    <>
      <figure className="mt-5 overflow-hidden rounded-xl border border-border/70 bg-white">
        <button
          className="group/preview relative block w-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-action-text"
          aria-label={t("discovery.preview.expand", { name: entry.name })}
          onClick={() => {
            setZoom(100);
            setExpanded(true);
          }}
        >
          <img
            src={query.data.dataUrl}
            alt={alt}
            onError={() => setBroken(true)}
            className="mx-auto block h-auto max-h-[26rem] max-w-full"
          />
          <span className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-lg bg-black/75 px-3 py-2 text-xs text-white shadow-sm transition-colors group-hover/preview:bg-black/90">
            <Expand className="h-3.5 w-3.5" />
            {t("discovery.preview.enlarge")}
          </span>
        </button>
        <figcaption className="flex flex-wrap justify-between gap-2 border-t border-border/50 bg-surface px-4 py-2.5 text-[11px] text-fg-3">
          <span>{caption}</span>
          <span>
            {t(
              query.data.stale
                ? "discovery.preview.stale"
                : "discovery.preview.local",
            )}
          </span>
        </figcaption>
      </figure>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="w-[calc(100%-2rem)] max-w-[96rem] overflow-hidden">
          <DialogHeader className="flex-row items-center justify-between gap-3 py-4">
            <div className="min-w-0">
              <DialogTitle>{entry.name}</DialogTitle>
              <DialogDescription className="mt-1 text-xs">
                {new URL(entry.sourceUrl).hostname} · {caption}
              </DialogDescription>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="icon"
                variant="ghost"
                disabled={zoom <= 75}
                aria-label={t("discovery.preview.zoomOut")}
                onClick={() => setZoom(zoom - 25)}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <span className="w-12 text-center text-xs tabular-nums text-fg-3">
                {zoom}%
              </span>
              <Button
                size="icon"
                variant="ghost"
                disabled={zoom >= 200}
                aria-label={t("discovery.preview.zoomIn")}
                onClick={() => setZoom(zoom + 25)}
              >
                <Plus className="h-4 w-4" />
              </Button>
              <DialogClose asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("discovery.preview.close")}
                >
                  <X className="h-4 w-4" />
                </Button>
              </DialogClose>
            </div>
          </DialogHeader>
          <div className="min-h-0 overflow-auto border-t border-border bg-white p-3">
            <img
              src={query.data.dataUrl}
              alt={alt}
              style={{ width: `${zoom}%` }}
              className="mx-auto max-w-none"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
