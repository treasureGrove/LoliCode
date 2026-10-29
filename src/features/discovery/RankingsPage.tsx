import { useMemo, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  ChartNoAxesCombined,
  ChevronDown,
  CircleHelp,
  Database,
  RefreshCw,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { AppPageHeader } from "@/app/shell/AppPageHeader";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { filterRankedModels, type RankedModel } from "@/lib/ai-rankings";
import { useRankingsFeed } from "@/lib/query/aiRankings";
import { discoveryLink } from "@/lib/api/discovery";
import { settingsApi } from "@/lib/api/settings";
import { toast } from "@/lib/toast";
import { RankingBarChart } from "./RankingBarChart";
import "./rankings.css";

type LicenseFilter = "all" | "open" | "proprietary";

export function RankingsPage() {
  const { t } = useTranslation("rankings");
  const {
    snapshot: rankingSnapshot,
    models: rankedModels,
    source,
    refreshing,
    failed,
    refresh,
  } = useRankingsFeed();
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("all");
  const [license, setLicense] = useState<LicenseFilter>("all");
  // Preserve the evidence content until the dialog finishes its exit animation.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [methodOpen, setMethodOpen] = useState(false);
  const methodTrigger = useRef<HTMLButtonElement | null>(null);
  const evidenceTrigger = useRef<HTMLButtonElement | null>(null);
  const selected: RankedModel | undefined = rankedModels.find(
    (model) => model.id === selectedId,
  );
  const availableSources = useMemo(
    () =>
      rankingSnapshot.sources.filter((entry) =>
        rankingSnapshot.models.some(
          (model) => model.measurements[entry.id] !== null,
        ),
      ).length,
    [rankingSnapshot],
  );
  const providers = useMemo(
    () => [...new Set(rankedModels.map((model) => model.provider))].sort(),
    [rankedModels],
  );
  const visible = useMemo(
    () => filterRankedModels(rankedModels, search, provider, license),
    [rankedModels, search, provider, license],
  );

  async function openSource(url: string) {
    try {
      await settingsApi.openExternal(discoveryLink(url));
    } catch {
      toast.error(t("openFailed"));
    }
  }

  function resetFilters() {
    setSearch("");
    setProvider("all");
    setLicense("all");
  }

  function openMethod(event: MouseEvent<HTMLButtonElement>) {
    methodTrigger.current = event.currentTarget;
    setMethodOpen(true);
  }

  return (
    <>
      <AppPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            <Button
              variant="ghost"
              disabled={refreshing}
              onClick={refresh}
              aria-label={t("refresh")}
            >
              <RefreshCw
                className={`h-4 w-4${refreshing ? " animate-spin" : ""}`}
              />
              <span className="hidden sm:inline">{t("refresh")}</span>
            </Button>
            <Button variant="ghost" onClick={openMethod}>
              <CircleHelp className="h-4 w-4" />
              {t("method")}
            </Button>
          </>
        }
      />
      <div id="main-content" className="rankings-scroll">
        <div className="rankings-page">
          <section
            className="rankings-intro"
            aria-labelledby="rankings-headline"
          >
            <div className="rankings-intro-copy">
              <span className="rankings-eyebrow">
                <ChartNoAxesCombined className="h-3.5 w-3.5" />
                {t("eyebrow")}
              </span>
              <h2 id="rankings-headline">{t("headline")}</h2>
              <p>{t("intro")}</p>
              <div className="rankings-snapshot" title={t("snapshotHint")}>
                <CalendarDays className="h-3.5 w-3.5" />
                {t("snapshot", { date: rankingSnapshot.retrievedAt })}
                <span
                  className="rankings-feed-status"
                  role="status"
                  data-testid="rankings-feed-status"
                >
                  {t(
                    failed
                      ? "refreshFailed"
                      : refreshing
                        ? "refreshing"
                        : `feedSource.${source}`,
                  )}
                </span>
              </div>
              <p
                className="rankings-source-note"
                role={
                  availableSources < rankingSnapshot.sources.length
                    ? "status"
                    : undefined
                }
              >
                {availableSources < rankingSnapshot.sources.length
                  ? t("sourceAvailability", {
                      available: availableSources,
                      total: rankingSnapshot.sources.length,
                    })
                  : null}
              </p>
            </div>
            <div className="rankings-intro-stats" aria-label={t("evidence")}>
              <div>
                <strong>{rankedModels.length}</strong>
                <span>{t("models")}</span>
              </div>
              <span className="rankings-stat-divider" aria-hidden="true" />
              <div>
                <strong>
                  {availableSources < rankingSnapshot.sources.length
                    ? `${availableSources}/${rankingSnapshot.sources.length}`
                    : rankingSnapshot.sources.length}
                </strong>
                <span>{t("sources")}</span>
              </div>
            </div>
          </section>

          <section className="rankings-board" aria-label={t("title")}>
            <div className="rankings-toolbar">
              <label className="rankings-search">
                <Search className="h-4 w-4" />
                <input
                  aria-label={t("search")}
                  placeholder={t("search")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search && (
                  <button
                    type="button"
                    aria-label={t("clearSearch")}
                    onClick={() => setSearch("")}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </label>
              <div className="rankings-provider">
                <select
                  aria-label={t("provider")}
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                >
                  <option value="all">{t("allProviders")}</option>
                  {providers.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <ChevronDown className="h-3.5 w-3.5" />
              </div>
            </div>
            <div className="rankings-filterbar">
              <div className="rankings-segments" aria-label={t("allModels")}>
                {(["all", "open", "proprietary"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={license === value}
                    onClick={() => setLicense(value)}
                  >
                    {t(
                      value === "all"
                        ? "allModels"
                        : value === "open"
                          ? "openWeights"
                          : "proprietary",
                    )}
                  </button>
                ))}
              </div>
              <span className="rankings-result-count" role="status">
                {t("results", {
                  visible: visible.length,
                  total: rankedModels.length,
                })}
              </span>
            </div>

            {visible.length > 0 && (
              <RankingBarChart
                models={visible}
                sources={rankingSnapshot.sources}
                onSelect={(model, trigger) => {
                  evidenceTrigger.current = trigger;
                  setSelectedId(model.id);
                  setEvidenceOpen(true);
                }}
              />
            )}
            {visible.length === 0 && (
              <div className="rankings-empty">
                <Search className="h-6 w-6" />
                <p>{t("noResults")}</p>
                <Button variant="outline" onClick={resetFilters}>
                  {t("resetFilters")}
                </Button>
              </div>
            )}
            <div className="rankings-board-footer">
              <span>
                <Database className="h-3.5 w-3.5" />
                {t("footer")}
              </span>
              <button type="button" onClick={openMethod}>
                {t("method")}
                <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </section>

          <div className="rankings-sources">
            <span>{t("sourceTitle")}</span>
            {rankingSnapshot.sources.map((source) => (
              <button
                key={source.id}
                type="button"
                onClick={() => void openSource(source.url)}
              >
                {source.name}
                <ArrowUpRight className="h-3 w-3" />
              </button>
            ))}
          </div>
        </div>
      </div>
      <Dialog open={methodOpen} onOpenChange={setMethodOpen}>
        <DialogContent
          className="max-w-2xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            methodTrigger.current?.focus({ preventScroll: true });
          }}
        >
          <DialogHeader className="flex-row items-start justify-between gap-4">
            <div>
              <DialogTitle className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-action-text" />
                {t("methodologyTitle")}
              </DialogTitle>
              <DialogDescription className="mt-2">
                {t("methodologyIntro")}
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" aria-label={t("close")}>
                <X className="h-4 w-4" />
              </Button>
            </DialogClose>
          </DialogHeader>
          <div className="rankings-method-body">
            <p className="rankings-formula">{t("methodologySteps")}</p>
            <p>{t("methodologyScope")}</p>
            <p>{t("methodologyConfig")}</p>
            <p>{t("methodologyExclusions")}</p>
            <p>
              {t("methodologyDates", { date: rankingSnapshot.retrievedAt })}
            </p>
            <div className="rankings-method-sources">
              {rankingSnapshot.sources.map((source) => (
                <button
                  type="button"
                  key={source.id}
                  onClick={() => void openSource(source.dataUrl ?? source.url)}
                >
                  <span>
                    <strong>{source.name}</strong>
                    <small>{source.updatedAt ?? t("unpublishedDate")}</small>
                  </span>
                  <ArrowUpRight className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={evidenceOpen && Boolean(selected)}
        onOpenChange={setEvidenceOpen}
      >
        <DialogContent
          className="max-w-3xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            evidenceTrigger.current?.focus({ preventScroll: true });
          }}
        >
          <DialogHeader className="flex-row items-start justify-between gap-4">
            <div>
              <DialogTitle>{selected?.name}</DialogTitle>
              <DialogDescription className="mt-2">
                #{selected?.rank} · {t("composite")}{" "}
                {selected?.composite.toFixed(2)} / 100 · {selected?.provider}
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <Button variant="ghost" size="icon" aria-label={t("close")}>
                <X className="h-4 w-4" />
              </Button>
            </DialogClose>
          </DialogHeader>
          {selected && (
            <div className="rankings-model-evidence">
              <div className="rankings-evidence-heading">
                <ShieldCheck className="h-4 w-4" />
                {t("evidence")}
                <span>{t("compositeHint")}</span>
              </div>
              <div className="rankings-evidence-grid">
                {rankingSnapshot.sources.map((source) => {
                  const result = selected.measurements[source.id];
                  if (!result) return null;
                  return (
                    <div className="rankings-evidence-card" key={source.id}>
                      <div className="rankings-evidence-title">
                        <strong>{source.name}</strong>
                        <button
                          type="button"
                          aria-label={`${t("readSource")} ${source.name} ${selected.name}`}
                          onClick={() => void openSource(result.url)}
                        >
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <p className="rankings-configuration">
                        {result.configuration}
                      </p>
                      <dl>
                        <div>
                          <dt>{t("sourceScore")}</dt>
                          <dd>
                            {result.score.toFixed(
                              source.id === "arena" ? 0 : 2,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("sourceRank")}</dt>
                          <dd>
                            {t("cohortRank", {
                              rank: result.cohortRank,
                              total: result.cohortSize,
                            })}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("score")}</dt>
                          <dd>{result.percentile.toFixed(2)}</dd>
                        </div>
                      </dl>
                      <p className="rankings-evidence-date">
                        {source.updatedAt
                          ? `${t("sourceDate")} · ${source.updatedAt}`
                          : t("unpublishedDate")}
                      </p>
                    </div>
                  );
                })}
              </div>
              <p className="rankings-evidence-note">{t("methodologyConfig")}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
