import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ChevronDown, RefreshCw, UserRound } from "lucide-react";
import { WindowControlsContext } from "@/app/shell/AppPageHeader";
import { FreeModelBadge } from "@/components/ui/free-model-badge";
import { useLolicodeAccount } from "@/hooks/useLolicodeAccount";
import { useLolicodeRelayStatus } from "@/hooks/useLolicodeRelayStatus";
import { DRAG_REGION_ATTR, DRAG_REGION_STYLE } from "@/lib/platform";
import {
  formatCredit,
  modelCreditPricing,
  relayCreditQuota,
} from "@/lib/relay-credit";
import "./lolicode-allowance.css";

const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

function remainingPercentage(remaining: number, limit: number) {
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0)
    return 0;
  return Math.max(0, Math.min(100, (remaining / limit) * 100));
}

export function LolicodeAllowancePage({ onBack, embedded = false }: { onBack?: () => void; embedded?: boolean }) {
  const { i18n } = useTranslation();
  const chinese = i18n.language.startsWith("zh");
  const text = (zh: string, en: string) => (chinese ? zh : en);
  const identity = useLolicodeAccount();
  const accountId = identity.account?.id ?? null;
  const windowControls = useContext(WindowControlsContext);
  const query = useLolicodeRelayStatus(accountId, !identity.isPending);
  const refresh = async () => {
    try {
      await query.refresh();
    } catch {
      // The single shared query exposes this failure to the page and sidebar.
    }
  };

  const status =
    !identity.isPending &&
    !query.isError &&
    accountId &&
    query.data?.account.id === accountId
      ? query.data
      : null;
  const quota = status?.quota;
  const credits = quota ? relayCreditQuota(quota) : null;
  const number = (value: number) => value.toLocaleString(i18n.language);
  const resetDate = quota ? new Date(quota.resetsAt) : null;
  let resetLabel = text("时间待更新", "Reset time unavailable");
  if (quota && resetDate && Number.isFinite(resetDate.getTime())) {
    try {
      resetLabel = new Intl.DateTimeFormat(i18n.language, {
        timeZone: quota.timezone,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(resetDate);
    } catch {
      resetLabel = quota.resetsAt;
    }
  }
  const timezone =
    quota?.timezone === "Asia/Singapore"
      ? text("新加坡时间", "Singapore time")
      : quota?.timezone;
  const exhausted =
    credits !== null && (credits.remaining <= 0 || credits.limit <= 0);
  const error =
    query.error instanceof Error
      ? query.error.message
      : text("请检查网络连接后重试。", "Check your connection and try again.");

  return (
    <div className={`lolicode-allowance-page${embedded ? " allowance-embedded" : ""}`}>
      {!embedded && <header
        className="allowance-topbar"
        {...DRAG_REGION_ATTR}
        style={DRAG_REGION_STYLE as React.CSSProperties}
      >
        <button
          type="button"
          className="allowance-back"
          onClick={onBack}
          aria-label={text("返回", "Back")}
          style={NO_DRAG}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {text("返回", "Back")}
        </button>
        {windowControls && <div style={NO_DRAG}>{windowControls}</div>}
      </header>}
      <main id={embedded ? undefined : "main-content"} className={embedded ? "allowance-embedded-content" : "allowance-scroll"}>
        <div className="allowance-content">
          {!embedded && <div className="allowance-page-heading">
            <div>
              <h1>{text("账户额度", "Account allowance")}</h1>
              <p>
                {text(
                  "查看你的每日免费 Credit 与各模型消耗费率。",
                  "Your daily free Credit and each model's usage rates.",
                )}
              </p>
            </div>
            {accountId && (
              <button
                type="button"
                className="allowance-action"
                onClick={() => void refresh()}
                disabled={query.isFetching || identity.isPending}
                aria-label={text(
                  "刷新额度和模型",
                  "Refresh allowance and models",
                )}
              >
                <RefreshCw
                  size={14}
                  aria-hidden="true"
                  className={
                    query.isFetching ? "allowance-refreshing" : undefined
                  }
                />
                {query.isFetching
                  ? text("正在刷新…", "Refreshing…")
                  : text("刷新", "Refresh")}
              </button>
            )}
          </div>}

          {identity.isLoading || identity.isPending ? (
            <div className="allowance-state" role="status">
              {text("正在读取额度…", "Loading allowance…")}
            </div>
          ) : !identity.account ? (
            <div className="allowance-state">
              <UserRound size={24} aria-hidden="true" />
              <h2>
                {text(
                  "登录后查看免费额度",
                  "Sign in to view your free allowance",
                )}
              </h2>
              <p>
                {text(
                  "点击左下角头像登录 LoliCode，所有设备共用同一账户的每日额度。",
                  "Sign in to LoliCode from the profile menu. All your devices share the same daily allowance.",
                )}
              </p>
              {identity.error && <p role="alert">{identity.error}</p>}
            </div>
          ) : (
            <>
              <section
                className="allowance-section"
                aria-labelledby="allowance-account-title"
              >
                <h2 id="allowance-account-title">
                  {text("当前账户", "Your account")}
                </h2>
                <div className="allowance-account-card">
                  <span className="allowance-avatar" aria-hidden="true">
                    {Array.from(
                      identity.account.displayName || identity.account.username,
                    )[0]?.toLocaleUpperCase()}
                  </span>
                  <div className="allowance-account-copy">
                    <strong>
                      {identity.account.displayName ||
                        identity.account.username}
                    </strong>
                    <span>@{identity.account.username}</span>
                  </div>
                  <span className="allowance-membership">
                    {text("每日免费额度", "Daily free allowance")}
                  </span>
                </div>
              </section>

              {query.isError ? (
                <div className="allowance-state allowance-error" role="alert">
                  <h2>{text("暂时无法读取额度", "Allowance unavailable")}</h2>
                  <p>{error}</p>
                  <button
                    type="button"
                    className="allowance-action"
                    onClick={() => void refresh()}
                    disabled={query.isFetching}
                  >
                    {text("重试", "Try again")}
                  </button>
                </div>
              ) : !status ? (
                <div className="allowance-state" role="status">
                  {text("正在读取额度…", "Loading allowance…")}
                </div>
              ) : (
                <>
                  <section
                    className="allowance-section"
                    aria-labelledby="allowance-daily-title"
                  >
                    <div className="allowance-section-heading">
                      <h2 id="allowance-daily-title">
                        {text("今日额度", "Daily allowance")}
                      </h2>
                      <span>
                        {text("所有设备共享", "Shared across devices")}
                      </span>
                    </div>
                    <div className="allowance-quota-card">
                      {credits && (
                        <AllowanceMeter
                          label="Credit"
                          ariaLabel={text(
                            "今日 Credit 剩余额度",
                            "Daily Credit remaining",
                          )}
                          remaining={credits.remaining}
                          limit={credits.limit}
                          used={credits.used}
                          unit="Credit"
                          locale={i18n.language}
                          text={text}
                        />
                      )}
                    </div>
                    {!credits && (
                      <p className="allowance-note" role="status">
                        {text(
                          "Credit 额度待更新，请刷新重试。",
                          "Credit allowance unavailable. Please refresh.",
                        )}
                      </p>
                    )}
                    <p className="allowance-note">
                      {text(
                        `今日已调用 ${number(status.quota.requestsUsed)} 次。实际用量：${number(status.quota.tokensUsed)} Token。`,
                        `${number(status.quota.requestsUsed)} requests today. Actual usage: ${number(status.quota.tokensUsed)} tokens.`,
                      )}
                    </p>
                    <div className="allowance-reset">
                      <span>{text("下一次重置", "Next reset")}</span>
                      <span>
                        <time dateTime={status.quota.resetsAt}>
                          {resetLabel}
                        </time>{" "}
                        · {timezone}
                      </span>
                    </div>
                    {credits && credits.reserved > 0 && (
                      <p className="allowance-note">
                        {text(
                          `处理中请求已预留 ${formatCredit(credits.reserved, i18n.language)} Credit，未计入剩余额度。`,
                          `${formatCredit(credits.reserved, i18n.language)} Credit is reserved for requests in progress and excluded from the remaining allowance.`,
                        )}
                      </p>
                    )}
                    {exhausted && (
                      <p className="allowance-exhausted" role="status">
                        {text(
                          "今日免费额度已用完，重置后即可继续使用。",
                          "Your daily free allowance is exhausted. It will be available again after the reset.",
                        )}
                      </p>
                    )}
                  </section>

                  <section
                    className="allowance-section"
                    aria-labelledby="allowance-models-title"
                  >
                    <h2 id="allowance-models-title">
                      {text("可用公益模型", "Sponsored models")}
                    </h2>
                    {status.ready && status.models.length > 0 ? (
                      <div className="allowance-models">
                        {status.models.map((model) => {
                          const pricing = modelCreditPricing(model);
                          return (
                            <div className="allowance-model" key={model.id}>
                              <div>
                                <strong>{model.name || model.id}</strong>
                                {model.name && model.name !== model.id && (
                                  <span>{model.id}</span>
                                )}
                                {pricing && (
                                  <span>
                                    {pricing.mode === "request"
                                      ? text(
                                          `每次 ${formatCredit(pricing.creditsPerRequest, i18n.language)} Credit`,
                                          `${formatCredit(pricing.creditsPerRequest, i18n.language)} Credit / request`,
                                        )
                                      : text(
                                          `每百万 Token：输入 ${formatCredit(pricing.prices.input, i18n.language)} / 输出 ${formatCredit(pricing.prices.output, i18n.language)} / 缓存读取 ${formatCredit(pricing.prices.cacheRead, i18n.language)} / 缓存写入 ${formatCredit(pricing.prices.cacheWrite, i18n.language)} Credit`,
                                          `Credit / 1M tokens: input ${formatCredit(pricing.prices.input, i18n.language)} / output ${formatCredit(pricing.prices.output, i18n.language)} / cache read ${formatCredit(pricing.prices.cacheRead, i18n.language)} / cache write ${formatCredit(pricing.prices.cacheWrite, i18n.language)}`,
                                        )}
                                  </span>
                                )}
                              </div>
                              <FreeModelBadge />
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="allowance-models-empty">
                        {status.ready
                          ? text(
                              "暂时没有可用的公益模型，稍后刷新查看。",
                              "No sponsored models are available. Refresh again later.",
                            )
                          : text(
                              "公益模型尚未开放。开放后刷新即可加入模型列表。",
                              "Sponsored models are not available yet. Refresh after they open to add them to your model list.",
                            )}
                      </div>
                    )}
                    {status.ready && status.models.length > 0 && (
                      <p className="allowance-note">
                        {text(
                          "在工作台的模型列表中选择公益模型即可使用。",
                          "Choose a sponsored model from the workspace model picker to get started.",
                        )}
                      </p>
                    )}
                  </section>

                  <details className="allowance-rules">
                    <summary>
                      {text("额度如何计算", "How your allowance works")}
                      <ChevronDown size={14} aria-hidden="true" />
                    </summary>
                    <ul>
                      <li>
                        {text(
                          "按各模型费率扣除 Credit，每日不限制调用次数。",
                          "Credit is deducted at each model's rates. There is no daily request-count limit.",
                        )}
                      </li>
                      <li>
                        {text(
                          "当日剩余额度不累积，所有设备共用同一账户的额度。",
                          "Unused daily allowance does not roll over. All devices share the same account allowance.",
                        )}
                      </li>
                      <li>
                        {text(
                          "请求结束后按上游用量结算；中断且未返回用量时，按预留额度计入。",
                          "Requests are settled using reported upstream usage. Interrupted requests without a usage report count against their reserved allowance.",
                        )}
                      </li>
                    </ul>
                  </details>
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function AllowanceMeter({
  label,
  ariaLabel,
  remaining,
  limit,
  used,
  unit,
  locale,
  text,
}: {
  label: string;
  ariaLabel: string;
  remaining: number;
  limit: number;
  used: number;
  unit: string;
  locale: string;
  text: (zh: string, en: string) => string;
}) {
  const percentage = remainingPercentage(remaining, limit);
  const counts = `${formatCredit(remaining, locale)} / ${formatCredit(limit, locale)}`;
  const percent =
    percentage > 0 && percentage < 1 ? "<1%" : `${Math.round(percentage)}%`;
  return (
    <div className="allowance-meter-section">
      <div className="allowance-meter-heading">
        <h3>{label}</h3>
        <span>{text(`剩余 ${percent}`, `${percent} remaining`)}</span>
      </div>
      <p className="allowance-count">
        <strong>{counts}</strong>
        <span>{unit}</span>
      </p>
      <div
        className="allowance-meter"
        role="meter"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
        aria-valuetext={`${counts} ${text("剩余", "remaining")}`}
      >
        <span style={{ width: `${percentage}%` }} />
      </div>
      <p className="allowance-meter-used">
        {text(
          `已使用 ${formatCredit(used, locale)} ${unit}`,
          `${formatCredit(used, locale)} ${unit} used`,
        )}
      </p>
    </div>
  );
}
