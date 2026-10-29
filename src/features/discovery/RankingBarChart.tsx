import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChartColumnIncreasing, MousePointer2 } from "lucide-react";
import { ProviderIcon } from "@/components/ProviderIcon";
import { type RankedModel, type RankingSource } from "@/lib/ai-rankings";

interface RankingBarChartProps {
  models: readonly RankedModel[];
  sources: readonly RankingSource[];
  onSelect: (model: RankedModel, trigger: HTMLButtonElement) => void;
}

interface HoveredModel {
  id: string;
  left: number;
  top: number;
}

const CARD_WIDTH = 260;
const CARD_HEIGHT = 240;
const OPEN_DELAY = 80;
const CLOSE_DELAY = 120;

export function RankingBarChart({
  models,
  sources,
  onSelect,
}: RankingBarChartProps) {
  const { t } = useTranslation("rankings");
  const [showAll, setShowAll] = useState(false);
  const displayed = useMemo(
    () => (showAll ? models : models.slice(0, 12)),
    [models, showAll],
  );
  const [hovered, setHovered] = useState<HoveredModel | null>(null);
  const active = useRef<HoveredModel | null>(null);
  const opening = useRef<number>();
  const closing = useRef<number>();
  const pointerFocus = useRef(false);
  const restoredFocus = useRef<string | null>(null);
  const tooltipId = useId();
  const hoveredModel = displayed.find((model) => model.id === hovered?.id);

  const cancelTimers = useCallback(() => {
    window.clearTimeout(opening.current);
    window.clearTimeout(closing.current);
    opening.current = undefined;
    closing.current = undefined;
  }, []);

  const dismiss = useCallback(() => {
    cancelTimers();
    active.current = null;
    setHovered(null);
  }, [cancelTimers]);

  const scheduleClose = () => {
    cancelTimers();
    closing.current = window.setTimeout(dismiss, CLOSE_DELAY);
  };

  const showModel = (
    model: RankedModel,
    target: HTMLButtonElement,
    immediate = false,
  ) => {
    cancelTimers();
    if (active.current?.id === model.id) return;
    const bounds = target.getBoundingClientRect();
    const card: HoveredModel = {
      id: model.id,
      left: Math.max(
        16,
        Math.min(bounds.right + 12, window.innerWidth - CARD_WIDTH - 16),
      ),
      top: Math.max(
        16,
        Math.min(bounds.top + 14, window.innerHeight - CARD_HEIGHT - 16),
      ),
    };
    const show = () => {
      active.current = card;
      setHovered(card);
      opening.current = undefined;
    };
    // Once open, keep one DOM node alive while the pointer crosses columns.
    if (immediate || active.current) show();
    else opening.current = window.setTimeout(show, OPEN_DELAY);
  };

  useEffect(() => {
    dismiss();
  }, [models, showAll, dismiss]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      cancelTimers();
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [cancelTimers, dismiss]);

  return (
    <div
      className="rankings-chart"
      role="group"
      aria-label={t("chartTitle")}
      onPointerLeave={scheduleClose}
    >
      <div className="rankings-chart-heading">
        <div>
          <h3>
            <ChartColumnIncreasing className="h-4 w-4" />
            {t("chartTitle")}
          </h3>
          <p>{t("chartSubtitle")}</p>
        </div>
        {models.length > 12 && (
          <div className="rankings-chart-range">
            <button
              type="button"
              aria-pressed={!showAll}
              onClick={() => {
                dismiss();
                setShowAll(false);
              }}
            >
              {t("topModels", { count: 12 })}
            </button>
            <button
              type="button"
              aria-pressed={showAll}
              onClick={() => {
                dismiss();
                setShowAll(true);
              }}
            >
              {t("showAllModels", { count: models.length })}
            </button>
          </div>
        )}
      </div>

      <div className="rankings-chart-scroll">
        <div
          className="rankings-chart-canvas"
          style={{ minWidth: `${Math.max(displayed.length * 72 + 90, 300)}px` }}
        >
          <div className="rankings-chart-grid" aria-hidden="true">
            {[100, 75, 50, 25, 0].map((value) => (
              <div key={value} style={{ top: `${100 - value}%` }}>
                <span>{value}</span>
              </div>
            ))}
          </div>
          <ol className="rankings-chart-columns">
            {displayed.map((model) => (
              <li
                className="rankings-chart-column"
                key={model.id}
                data-provider={model.provider}
                data-highlighted={hoveredModel?.id === model.id || undefined}
              >
                <button
                  type="button"
                  className="rankings-chart-bar-button"
                  aria-label={t("barLabel", {
                    name: model.name,
                    rank: model.rank,
                    score: model.composite.toFixed(2),
                    coverage: model.coverage,
                    totalSources: sources.length,
                  })}
                  aria-haspopup="dialog"
                  aria-describedby={
                    hoveredModel?.id === model.id ? tooltipId : undefined
                  }
                  onPointerEnter={(event) => {
                    if (event.pointerType !== "touch")
                      showModel(model, event.currentTarget);
                  }}
                  onPointerLeave={scheduleClose}
                  onPointerDown={(event) => {
                    pointerFocus.current = true;
                    if (event.pointerType === "touch") dismiss();
                  }}
                  onPointerUp={() => {
                    pointerFocus.current = false;
                  }}
                  onPointerCancel={() => {
                    pointerFocus.current = false;
                    dismiss();
                  }}
                  onFocus={(event) => {
                    if (pointerFocus.current) return;
                    if (restoredFocus.current === model.id) {
                      restoredFocus.current = null;
                      return;
                    }
                    showModel(model, event.currentTarget, true);
                  }}
                  onBlur={() => {
                    pointerFocus.current = false;
                    scheduleClose();
                  }}
                  onClick={(event) => {
                    dismiss();
                    restoredFocus.current = model.id;
                    onSelect(model, event.currentTarget);
                  }}
                >
                  <span
                    className="rankings-chart-bar"
                    style={{ height: `${model.composite}%` }}
                  >
                    {model.composite >= 12 && (
                      <span className="rankings-chart-value">
                        {model.composite.toFixed(1)}
                      </span>
                    )}
                  </span>
                  {model.composite < 12 && (
                    <span
                      className="rankings-chart-low-value"
                      style={{ bottom: `calc(${model.composite}% + 8px)` }}
                    >
                      {model.composite.toFixed(1)}
                    </span>
                  )}
                </button>
                <span className="rankings-chart-icon" aria-hidden="true">
                  <ProviderIcon
                    icon={model.icon}
                    name={model.provider}
                    size={21}
                  />
                </span>
                <span className="rankings-chart-label" aria-hidden="true">
                  <span className="rankings-chart-label-rank">
                    #{model.rank}{" "}
                  </span>
                  {model.name}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <p className="rankings-chart-instruction">
        <MousePointer2 className="h-3.5 w-3.5" />
        {t("chartHint")}
      </p>

      {hovered &&
        hoveredModel &&
        createPortal(
          <div
            id={tooltipId}
            role="tooltip"
            className="rankings-chart-tooltip"
            style={{ left: hovered.left, top: hovered.top }}
          >
            <div className="rankings-chart-tooltip-title">
              <span aria-hidden="true">
                <ProviderIcon
                  icon={hoveredModel.icon}
                  name={hoveredModel.provider}
                  size={20}
                />
              </span>
              <strong>{hoveredModel.name}</strong>
              <span>#{hoveredModel.rank}</span>
            </div>
            <div className="rankings-chart-tooltip-score">
              <span>{t("composite")}</span>
              <strong>
                {hoveredModel.composite.toFixed(2)}
                <small> / 100</small>
              </strong>
            </div>
            <dl className="rankings-chart-tooltip-sources">
              {sources.map((source) => {
                const result = hoveredModel.measurements[source.id];
                return (
                  <div key={source.id}>
                    <dt>{source.name}</dt>
                    <dd>
                      {result
                        ? result.score.toFixed(source.id === "arena" ? 0 : 2)
                        : "—"}
                    </dd>
                  </div>
                );
              })}
            </dl>
            <div className="rankings-chart-tooltip-footer">
              <span>
                {t("coverage")} {hoveredModel.coverage}/{sources.length}
              </span>
              <span>{t("hoverHint")}</span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
