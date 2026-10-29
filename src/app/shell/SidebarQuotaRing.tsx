import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, RefreshCw } from "lucide-react";
import { lolicodeAccountApi } from "@/lib/api/lolicode-account";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import "./sidebar-quota-ring.css";

/** Either daily limit can stop the relay; the ring follows the tighter allowance. */
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
  const [expired, setExpired] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const openedByPointer = useRef(false);
  const revision = useRef(refreshRevision);
  const query = useQuery({
    queryKey: ["lolicode-account", "relay-quota", accountId],
    queryFn: async ({ signal }) => {
      const status = await lolicodeAccountApi.relayStatus();
      if (signal.aborted || status.account.id !== accountId)
        throw new Error(
          text(
            "账户已变化，请重新读取额度。",
            "Account changed. Reload your allowance.",
          ),
        );
      return status;
    },
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  const fetchQuota = query.refetch;
  const refetch = useCallback(
    () => fetchQuota({ cancelRefetch: false }),
    [fetchQuota],
  );
  const status = query.isError || expired ? undefined : query.data;
  const quota = status?.quota;
  const requests = quota
    ? remainingRatio(quota.requestsRemaining, quota.requestLimit)
    : null;
  const tokens = quota
    ? remainingRatio(quota.tokensRemaining, quota.tokenLimit)
    : null;
  const ratio =
    requests === null || tokens === null ? null : Math.min(requests, tokens);
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
  useEffect(() => {
    const resetAt = Date.parse(query.data?.quota.resetsAt ?? "");
    const delay = resetAt - Date.now();
    const alreadyReset = Number.isFinite(resetAt) && delay <= 0;
    setExpired(alreadyReset);
    if (!Number.isFinite(resetAt)) return;
    if (alreadyReset) {
      if (query.dataUpdatedAt < resetAt) void refetch();
      return;
    }
    const timer = setTimeout(
      () => {
        setExpired(Date.now() >= resetAt);
        void refetch();
      },
      Math.min(delay + 250, 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [query.data, query.dataUpdatedAt, refetch]);

  const keepOpen = () => clearTimeout(leaveTimer.current);
  const openDetails = () => {
    keepOpen();
    setOpen(true);
    if (
      !query.isFetching &&
      (query.isError || Date.now() - query.dataUpdatedAt >= 30_000)
    )
      void refetch();
  };
  const closeSoon = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setOpen(false), 180);
  };
  const counts = (value: number, limit: number) =>
    `${value.toLocaleString(i18n.language)} / ${limit.toLocaleString(i18n.language)}`;
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
            openedByPointer.current = false;
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
        {quota && ratio !== null ? (
          <div className="tai-shell-quota-details">
            <div className="tai-shell-quota-summary">
              <span>{text("今日额度", "Daily allowance")}</span>
              <strong>
                {text(`剩余 ${remaining}`, `${remaining} remaining`)}
              </strong>
            </div>
            <div className="tai-shell-quota-row">
              <span>{text("请求数", "Requests")}</span>
              <span>{counts(quota.requestsRemaining, quota.requestLimit)}</span>
            </div>
            <div className="tai-shell-quota-row">
              <span>Token</span>
              <span>{counts(quota.tokensRemaining, quota.tokenLimit)}</span>
            </div>
            {quota.tokensReserved > 0 && (
              <p className="tai-shell-quota-note">
                {text(
                  `其中 ${quota.tokensReserved.toLocaleString(i18n.language)} Token 已预留，未计入剩余。`,
                  `${quota.tokensReserved.toLocaleString(i18n.language)} reserved tokens are excluded from the remaining allowance.`,
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
