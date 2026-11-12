import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import {
  RELAY_POLL_INTERVAL_MS,
  useLolicodeRelayStatus,
} from "@/hooks/useLolicodeRelayStatus";
import { formatCredit, relayCreditQuota } from "@/lib/relay-credit";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import "./sidebar-quota-ring.css";

/** Credit is the daily allowance; request counts are usage statistics only. */
function remainingRatio(remaining: number, limit: number) {
  if (!Number.isFinite(remaining) || !Number.isFinite(limit)) return null;
  if (limit <= 0) return 0;
  return Math.max(0, Math.min(1, remaining / limit));
}

export function SidebarQuotaRing({
  accountId,
  onManage,
  refreshRevision = 0,
}: {
  accountId: string;
  onManage: () => void;
  refreshRevision?: number;
}) {
  const { i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const text = (zh: string, en: string) => (chinese ? zh : en);
  const [open, setOpen] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const openedByPointer = useRef(false);
  const revision = useRef(refreshRevision);
  const query = useLolicodeRelayStatus(accountId);
  const refetch = useCallback(
    () => query.refresh().catch(() => undefined),
    [query.refresh],
  );
  const status = query.data;
  const quota = status?.quota;
  const credits = quota ? relayCreditQuota(quota) : null;
  const ratio = credits
    ? remainingRatio(credits.remaining, credits.limit)
    : null;
  const percentage = (value: number) =>
    value > 0 && value < 0.01 ? "<1%" : `${Math.round(value * 100)}%`;
  const remaining = ratio === null ? null : percentage(ratio);
  const label = text("免费额度", "Free allowance");
  const summary =
    remaining === null
      ? text("额度待更新", "Allowance unavailable")
      : text(`今日剩余 ${remaining}`, `${remaining} remaining today`);

  useEffect(() => {
    setOpen(false);
    return () => clearTimeout(leaveTimer.current);
  }, [accountId]);
  useEffect(() => {
    if (revision.current === refreshRevision) return;
    revision.current = refreshRevision;
    void refetch();
  }, [refreshRevision, refetch]);
  const keepOpen = () => clearTimeout(leaveTimer.current);
  const openDetails = () => {
    keepOpen();
    setOpen(true);
    if (
      !query.isFetching &&
      (query.isError ||
        Date.now() - query.dataUpdatedAt >= RELAY_POLL_INTERVAL_MS)
    )
      void refetch();
  };
  const closeSoon = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setOpen(false), 180);
  };
  const counts = (value: number, limit: number) =>
    `${formatCredit(value, i18n.language)} / ${formatCredit(limit, i18n.language)}`;
  const resetDate = quota ? new Date(quota.resetsAt) : null;
  const resetLabel =
    resetDate && Number.isFinite(resetDate.getTime())
      ? resetDate.toLocaleString(i18n.language, {
          timeZone: "Asia/Singapore",
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="tai-shell-quota-button"
          aria-label={`${label} · ${summary}`}
          data-tone={
            ratio === null
              ? "unknown"
              : ratio === 0
                ? "empty"
                : ratio <= 0.2
                  ? "low"
                  : "normal"
          }
          onPointerEnter={() => {
            openedByPointer.current = true;
            openDetails();
          }}
          onPointerLeave={closeSoon}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openedByPointer.current = event.detail > 0;
            openDetails();
          }}
        >
          <svg
            viewBox="0 0 38 38"
            role={ratio === null ? "img" : "meter"}
            aria-label={text(
              "今日免费额度剩余",
              "Daily free allowance remaining",
            )}
            aria-valuemin={ratio === null ? undefined : 0}
            aria-valuemax={ratio === null ? undefined : 100}
            aria-valuenow={ratio === null ? undefined : Math.round(ratio * 100)}
            aria-valuetext={summary}
          >
            <circle
              className="tai-shell-quota-track"
              cx="19"
              cy="19"
              r="14.5"
            />
            {ratio !== null && ratio > 0 && (
              <circle
                className="tai-shell-quota-progress"
                cx="19"
                cy="19"
                r="14.5"
                pathLength="100"
                strokeDasharray={`${ratio * 100} 100`}
                transform="rotate(-90 19 19)"
              />
            )}
            <rect
              className="tai-shell-quota-center"
              x="15"
              y="15"
              width="8"
              height="8"
              rx="1.8"
              transform="rotate(45 19 19)"
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="tai-shell-quota-popover"
        side="right"
        align="end"
        sideOffset={10}
        aria-label={label}
        onPointerEnter={keepOpen}
        onPointerLeave={closeSoon}
        onFocusCapture={keepOpen}
        onOpenAutoFocus={(event) => {
          if (openedByPointer.current) event.preventDefault();
        }}
      >
        <div className="tai-shell-quota-source">
          <span>{text("额度来源", "Allowance source")}</span>
          <strong>
            {text("LoliCode 每日免费额度", "LoliCode daily free allowance")}
          </strong>
          <button
            type="button"
            aria-label={text("刷新免费额度", "Refresh free allowance")}
            disabled={query.isFetching}
            onClick={() => void refetch()}
          >
            <RefreshCw
              size={14}
              className={query.isFetching ? "animate-spin" : undefined}
              aria-hidden="true"
            />
          </button>
        </div>
        {quota && credits && ratio !== null ? (
          <div className="tai-shell-quota-details">
            <div className="tai-shell-quota-summary">
              <span>{text("今日额度", "Daily allowance")}</span>
              <strong>
                {text(`剩余 ${remaining}`, `${remaining} remaining`)}
              </strong>
            </div>
            <div className="tai-shell-quota-row">
              <span>Credit</span>
              <span>{counts(credits.remaining, credits.limit)}</span>
            </div>
            <div className="tai-shell-quota-row">
              <span>{text("今日调用", "Requests today")}</span>
              <span>{quota.requestsUsed.toLocaleString(i18n.language)}</span>
            </div>
            <div className="tai-shell-quota-row">
              <span>{text("已使用 Token", "Tokens used")}</span>
              <span>{quota.tokensUsed.toLocaleString(i18n.language)}</span>
            </div>
            {credits.reserved > 0 && (
              <p className="tai-shell-quota-note">
                {text(
                  `其中 ${formatCredit(credits.reserved, i18n.language)} Credit 已预留，未计入剩余。`,
                  `${formatCredit(credits.reserved, i18n.language)} reserved Credit is excluded from the remaining allowance.`,
                )}
              </p>
            )}
            {resetLabel && (
              <p className="tai-shell-quota-note">
                {text(
                  `${resetLabel} 重置 · 新加坡时间`,
                  `Resets ${resetLabel} · Singapore time`,
                )}
              </p>
            )}
          </div>
        ) : (
          <div
            className="tai-shell-quota-unavailable"
            role={query.isError ? "alert" : "status"}
          >
            {query.isError
              ? text(
                  "暂时无法读取额度，请刷新重试。",
                  "Unable to load allowance. Please refresh.",
                )
              : query.isFetching
                ? text("正在读取额度…", "Loading allowance…")
                : summary}
          </div>
        )}
        <button
          type="button"
          className="tai-shell-quota-manage"
          onClick={() => {
            keepOpen();
            setOpen(false);
            onManage();
          }}
        >
          {text("管理用量", "Manage usage")}
          <ArrowUpRight size={15} aria-hidden="true" />
        </button>
      </PopoverContent>
    </Popover>
  );
}
