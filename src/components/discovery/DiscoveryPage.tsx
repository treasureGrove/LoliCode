import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  Bookmark,
  ChartNoAxesCombined,
  Check,
  Gift,
  Globe,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { AppPageHeader } from "@/components/shell/AppPageHeader";
import { RankingPreview } from "./RankingPreview";
import { Button } from "@/components/ui/button";
import {
  discoveryApi,
  discoveryKey,
  discoveryLink,
  filterDiscovery,
  type DiscoveryKind,
  type DiscoveryText,
} from "@/lib/api/discovery";
import { settingsApi } from "@/lib/api/settings";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export function DiscoveryPage({ kind }: { kind: DiscoveryKind }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: discoveryKey(kind),
    queryFn: () => discoveryApi.get(kind),
    retry: false,
    staleTime: 60_000,
  });
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState(false);
  const [refreshed, setRefreshed] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const text = (value: DiscoveryText) =>
    i18n.language.startsWith("zh") ? value.zh : value.en;
  const entries = query.data?.catalog.entries ?? [];
  const favorites = query.data?.favorites ?? [];
  const all = entries.filter((entry) => entry.kind === kind);
  const visible = useMemo(
    () =>
      filterDiscovery(
        entries,
        kind,
        search,
        category,
        favoritesOnly,
        favorites,
      ),
    [entries, kind, search, category, favoritesOnly, favorites],
  );
  const categories = ["all", ...new Set(all.map((entry) => entry.category))];
  const Icon = kind === "rankings" ? ChartNoAxesCombined : Gift;

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(false);
    setRefreshed(false);
    try {
      const snapshot = await discoveryApi.refresh(kind);
      client.setQueryData(discoveryKey(kind), snapshot);
      await client.invalidateQueries({ queryKey: ["discovery"] });
      setRefreshed(true);
    } catch {
      setRefreshError(true);
    } finally {
      setRefreshing(false);
    }
  };
  const favorite = async (id: string) => {
    setSaving(id);
    try {
      const snapshot = await discoveryApi.favorite(
        kind,
        id,
        !favorites.includes(id),
      );
      client.setQueryData(discoveryKey(kind), snapshot);
      await client.invalidateQueries({ queryKey: ["discovery"] });
    } catch {
      toast.error(t("discovery.favoriteFailed"));
    } finally {
      setSaving(null);
    }
  };
  const open = async (url: string, id: string) => {
    setOpening(id);
    try {
      await settingsApi.openExternal(discoveryLink(url));
    } catch {
      toast.error(t("discovery.openFailed"));
    } finally {
      setOpening(null);
    }
  };

  return (
    <>
      <AppPageHeader
        title={t(`applications.${kind}.title`)}
        subtitle={t(`discovery.${kind}.subtitle`)}
        actions={
          <Button
            variant="ghost"
            disabled={refreshing || query.isPending}
            onClick={() => void refresh()}
          >
            <RefreshCw
              className={cn("h-4 w-4", refreshing && "animate-spin")}
            />
            {t("discovery.refresh")}
          </Button>
        }
      />
      <div
        id="main-content"
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-6 sm:px-8"
      >
        <div
          className={cn(
            "mx-auto max-w-6xl",
            kind === "rankings" ? "space-y-4" : "space-y-6",
          )}
        >
          <section
            className={cn(
              "relative overflow-hidden rounded-2xl border border-border/80 bg-surface/90 shadow-sm",
              kind === "rankings" ? "px-5 py-4" : "px-6 py-7 sm:px-8",
            )}
          >
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-12 -top-20 h-64 w-64 rounded-full bg-action/5 blur-3xl"
            />
            <div className="relative flex items-start justify-between gap-6">
              <div
                className={kind === "free-ai" ? "max-w-2xl" : "min-w-0 flex-1"}
              >
                <div
                  className={cn(
                    "mb-4 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.18em] text-action-text",
                    kind === "rankings" && "hidden",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {kind === "rankings"
                    ? "MODEL OBSERVATORY"
                    : "LITTLE DISCOVERIES"}
                </div>
                <h2
                  className={cn(
                    "text-2xl font-semibold tracking-tight text-fg-1",
                    kind === "rankings" && "hidden",
                  )}
                >
                  {t(`discovery.${kind}.headline`)}
                </h2>
                <p
                  className={cn(
                    "text-sm leading-7 text-fg-2",
                    kind === "free-ai" && "mt-3 max-w-xl",
                  )}
                >
                  {t(`discovery.${kind}.intro`)}
                </p>
              </div>
              <span className="hidden rounded-full border border-border px-3 py-1.5 text-xs text-fg-3 sm:block">
                {t("discovery.count", { count: all.length })}
              </span>
            </div>
            {query.data && (
              <div
                className={cn(
                  "flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-fg-3",
                  kind === "rankings" ? "mt-2" : "mt-5",
                )}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                  {t(`discovery.source.${query.data.source}`)}
                </span>
                <span>
                  {t("discovery.updated", {
                    date: query.data.catalog.updatedAt,
                  })}
                </span>
                {refreshed && (
                  <span role="status">{t("discovery.refreshed")}</span>
                )}
              </div>
            )}
            {refreshError && (
              <p role="status" className="mt-4 text-xs leading-6 text-fg-2">
                {t("discovery.refreshUnavailable")}
              </p>
            )}
          </section>

          <div className="flex flex-wrap items-center gap-3">
            <label className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-3 h-4 w-4 text-fg-3" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label={t("discovery.search")}
                placeholder={t(`discovery.${kind}.search`)}
                className="h-10 w-full rounded-xl border border-border bg-surface/90 pl-10 pr-10 text-sm outline-none focus:border-action-text/60 focus:ring-2 focus:ring-action/10"
              />
              {search && (
                <button
                  className="absolute right-2 top-2 rounded-md p-1 text-fg-3 hover:text-fg-1"
                  aria-label={t("discovery.clearSearch")}
                  onClick={() => setSearch("")}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </label>
            <Button
              variant={favoritesOnly ? "secondary" : "ghost"}
              aria-pressed={favoritesOnly}
              onClick={() => setFavoritesOnly(!favoritesOnly)}
            >
              <Bookmark
                className={cn("h-4 w-4", favoritesOnly && "fill-current")}
              />
              {t("discovery.favorites")}
            </Button>
          </div>
          <div
            className="flex flex-wrap items-center gap-2"
            aria-label={t("discovery.categories")}
          >
            {categories.map((value) => (
              <button
                key={value}
                aria-pressed={category === value}
                onClick={() => setCategory(value)}
                className={cn(
                  "rounded-full border px-3.5 py-1.5 text-xs transition-colors",
                  category === value
                    ? "border-action-text/25 bg-action/10 text-action-text"
                    : "border-transparent text-fg-2 hover:border-border hover:bg-surface",
                )}
              >
                {t(`discovery.category.${value}`)}
                <span className="ml-2 opacity-60">
                  {value === "all"
                    ? all.length
                    : all.filter((entry) => entry.category === value).length}
                </span>
              </button>
            ))}
            <span className="ml-auto text-xs text-fg-3">
              {t("discovery.results", { count: visible.length })}
            </span>
          </div>

          {query.isPending ? (
            <div
              role="status"
              className="flex justify-center gap-2 py-12 text-sm text-fg-2"
            >
              <LoaderCircle className="h-4 w-4 animate-spin" />
              {t("discovery.loading")}
            </div>
          ) : query.isError ? (
            <div
              role="alert"
              className="rounded-xl border border-border bg-surface p-6 text-sm"
            >
              <p>{t("discovery.loadFailed")}</p>
              <Button variant="link" onClick={() => void query.refetch()}>
                {t("applications.retry")}
              </Button>
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-surface/60 px-6 py-14 text-center">
              <Bookmark className="mx-auto mb-3 h-6 w-6 text-fg-3" />
              <p className="text-sm text-fg-2">
                {t(
                  favoritesOnly
                    ? "discovery.noFavorites"
                    : "discovery.noResults",
                )}
              </p>
              <Button
                className="mt-3"
                variant="ghost"
                onClick={() => {
                  setSearch("");
                  setCategory("all");
                  setFavoritesOnly(false);
                }}
              >
                {t("discovery.showAll")}
              </Button>
            </div>
          ) : (
            <div
              className={cn(
                "grid gap-4",
                kind === "free-ai" && "lg:grid-cols-2",
              )}
            >
              {visible.map((entry) => {
                const saved = favorites.includes(entry.id);
                const expired =
                  !!entry.expiresAt &&
                  entry.expiresAt < new Date().toISOString().slice(0, 10);
                return (
                  <article
                    key={entry.id}
                    aria-labelledby={`discovery-${entry.id}`}
                    className="group flex min-w-0 flex-col rounded-2xl border border-border/80 bg-surface/95 p-5 shadow-sm transition-colors hover:border-action-text/30 sm:p-6"
                  >
                    <div className="flex items-start gap-3.5">
                      <span
                        aria-hidden="true"
                        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-action/5 text-lg font-semibold text-action-text"
                      >
                        {entry.name.slice(0, 1)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3
                          id={`discovery-${entry.id}`}
                          className="truncate text-base font-semibold text-fg-1"
                        >
                          {entry.name}
                        </h3>
                        <p className="mt-1 truncate text-xs text-fg-3">
                          {new URL(entry.url).hostname}
                        </p>
                      </div>
                      <button
                        onClick={() => void favorite(entry.id)}
                        disabled={saving !== null}
                        aria-pressed={saved}
                        aria-label={t(
                          saved ? "discovery.unfavorite" : "discovery.favorite",
                          { name: entry.name },
                        )}
                        className="rounded-lg p-2 text-fg-3 transition-colors hover:bg-action/10 hover:text-action-text disabled:opacity-50"
                      >
                        {saving === entry.id ? (
                          <LoaderCircle className="h-4 w-4 animate-spin" />
                        ) : (
                          <Bookmark
                            className={cn(
                              "h-4 w-4",
                              saved && "fill-current text-action-text",
                            )}
                          />
                        )}
                      </button>
                    </div>
                    <p className="mt-4 text-sm leading-7 text-fg-2">
                      {text(entry.summary)}
                    </p>
                    {kind === "rankings" && <RankingPreview entry={entry} />}
                    {kind === "free-ai" && (
                      <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
                        <span className="rounded-full bg-action/8 px-2.5 py-1 text-action-text">
                          {t(`discovery.offer.${entry.offer}`)}
                        </span>
                        <span className="rounded-full border border-border px-2.5 py-1 text-fg-3">
                          {t(`discovery.access.${entry.access}`)}
                        </span>
                        {expired && (
                          <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-amber-600">
                            {t("discovery.expired")}
                          </span>
                        )}
                      </div>
                    )}
                    <p className="mt-4 rounded-lg bg-app/70 px-3 py-2.5 text-xs leading-6 text-fg-3">
                      {text(entry.limits)}
                    </p>
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
                      <div className="text-[11px] text-fg-3">
                        <button
                          className="inline-flex items-center gap-1 hover:text-action-text"
                          onClick={() =>
                            void open(entry.sourceUrl, `${entry.id}-source`)
                          }
                          disabled={opening !== null}
                        >
                          <Globe className="h-3 w-3" />
                          {t("discovery.officialSource")}
                        </button>
                        <p className="mt-1">
                          {t("discovery.checked", { date: entry.checkedAt })}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={opening !== null}
                        onClick={() => void open(entry.url, entry.id)}
                      >
                        {t(
                          kind === "rankings"
                            ? "discovery.viewRanking"
                            : "discovery.visit",
                        )}
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          <p className="text-center text-xs leading-6 text-fg-3">
            {t(`discovery.${kind}.footer`)}
          </p>
        </div>
      </div>
    </>
  );
}
