import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Eye, EyeOff, RefreshCw } from "lucide-react";
import { copilotGetAuthStatus, copilotListAccounts } from "@/lib/api/copilot";
import {
  COPILOT_BILLING_QUERY_KEY,
  copilotBillingApi,
  type CopilotBillingReport,
} from "@/lib/api/copilotBilling";
import { Button } from "@/components/ui/button";
import { fieldClass, Input } from "@/components/ui/input";

type BillingKind = CopilotBillingReport["kind"];

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function safeMessage(error: unknown, secret = "") {
  let message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "官方账单同步失败，请稍后重试。";
  if (secret) message = message.split(secret).join("[已隐藏]");
  return message
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "[已隐藏]")
    .slice(0, 600);
}

const money = (value: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
const quantity = (value: number) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(value);

/** Official monthly ledger; kept separate from local API usage estimates. */
export function CopilotBillingPanel() {
  const queryClient = useQueryClient();
  const id = useId();
  const [enteredLogin, setEnteredLogin] = useState<string | null>(null);
  const [month, setMonth] = useState(currentMonth);
  const [kind, setKind] = useState<BillingKind>("ai_credits");
  const [advanced, setAdvanced] = useState(false);
  const [token, setToken] = useState("");
  const [revealToken, setRevealToken] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const requestId = useRef(0);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestId.current += 1;
    };
  }, []);

  const accounts = useQuery({
    queryKey: ["copilot", "billing", "accounts"],
    queryFn: copilotListAccounts,
    staleTime: 60_000,
    retry: false,
  });
  const auth = useQuery({
    queryKey: ["copilot", "billing", "auth-status"],
    queryFn: copilotGetAuthStatus,
    staleTime: 60_000,
    retry: false,
  });
  const githubAccounts =
    accounts.data?.filter(
      (account) => account.github_domain === "github.com",
    ) ?? [];
  const defaultAccount =
    githubAccounts.find(
      (account) => account.id === auth.data?.default_account_id,
    ) ?? githubAccounts[0];
  const username = enteredLogin ?? defaultAccount?.login ?? "";
  const normalizedLogin = username.trim().toLowerCase();
  const validLogin = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(
    normalizedLogin,
  );
  const [year, monthNumber] = month.split("-").map(Number);
  const validMonth =
    /^\d{4}-\d{2}$/.test(month) && monthNumber >= 1 && monthNumber <= 12;
  const ledgerKey = [
    ...COPILOT_BILLING_QUERY_KEY,
    normalizedLogin,
    year,
    monthNumber,
    kind,
  ];
  const reportQuery = useQuery({
    queryKey: ledgerKey,
    queryFn: async () => {
      const reports = await copilotBillingApi.listReports();
      return (
        reports.find(
          (report) =>
            report.accountLogin.toLowerCase() === normalizedLogin &&
            report.year === year &&
            report.month === monthNumber &&
            report.kind === kind,
        ) ?? null
      );
    },
    enabled: validLogin && validMonth,
    retry: false,
  });
  const report = reportQuery.data;
  const totals = useMemo(
    () =>
      report?.items.reduce(
        (sum, item) => ({
          quantity: sum.quantity + item.grossQuantity,
          gross: sum.gross + item.grossAmount,
          discount: sum.discount + item.discountAmount,
          net: sum.net + item.netAmount,
        }),
        { quantity: 0, gross: 0, discount: 0, net: 0 },
      ),
    [report],
  );
  const models = useMemo(() => {
    const grouped = new Map<
      string,
      { quantity: number; gross: number; discount: number; net: number }
    >();
    for (const item of report?.items ?? []) {
      const model = item.model || "未标注模型";
      const row = grouped.get(model) ?? {
        quantity: 0,
        gross: 0,
        discount: 0,
        net: 0,
      };
      row.quantity += item.grossQuantity;
      row.gross += item.grossAmount;
      row.discount += item.discountAmount;
      row.net += item.netAmount;
      grouped.set(model, row);
    }
    return [...grouped];
  }, [report]);
  const unit = kind === "ai_credits" ? "AI Credits" : "Premium Requests";

  async function sync() {
    if (inFlight.current || !validLogin || !validMonth) return;
    inFlight.current = true;
    const activeRequest = ++requestId.current;
    const submittedToken = token.trim();
    const accountId = githubAccounts.find(
      (account) => account.login.toLowerCase() === normalizedLogin,
    )?.id;
    // A late auth-status response must not change the selected ledger mid-sync.
    setEnteredLogin(username.trim());
    setPending(true);
    setError("");
    try {
      const next = await copilotBillingApi.sync({
        accountId,
        username: username.trim(),
        token: submittedToken || undefined,
        year,
        month: monthNumber,
        kind,
      });
      if (!mounted.current || activeRequest !== requestId.current) return;
      queryClient.setQueryData(ledgerKey, next);
      await queryClient.invalidateQueries({ queryKey: ledgerKey, exact: true });
    } catch (cause) {
      if (!mounted.current || activeRequest !== requestId.current) return;
      const message = safeMessage(cause, submittedToken);
      setError(message);
      if (/401|403|权限|forbidden|unauthorized|plan/i.test(message)) {
        setAdvanced(true);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current && activeRequest === requestId.current) {
        setToken("");
        setRevealToken(false);
        setPending(false);
      }
    }
  }

  function selectionChanged() {
    setError("");
    setToken("");
    setRevealToken(false);
  }

  return (
    <section
      aria-label="GitHub Copilot 官方账单"
      className="mt-8 rounded-panel border border-border bg-surface px-5 py-5"
    >
      <div className="mb-4">
        <h2 id={`${id}-title`} className="text-base font-semibold">
          GitHub Copilot · 个人官方用量账单
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-fg-2">
          VS Code、Visual Studio 等客户端合计；官方账单未区分 IDE、Agent
          或会话。
        </p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void sync();
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <label
            className="min-w-40 flex-1 text-xs text-fg-2"
            htmlFor={`${id}-login`}
          >
            GitHub 用户名
            <Input
              id={`${id}-login`}
              list={`${id}-accounts`}
              className="mt-1"
              value={username}
              disabled={pending}
              placeholder="输入个人账号"
              onChange={(event) => {
                if (pending) return;
                setEnteredLogin(event.target.value);
                selectionChanged();
              }}
            />
          </label>
          <datalist id={`${id}-accounts`}>
            {githubAccounts.map((account) => (
              <option key={account.id} value={account.login} />
            ))}
          </datalist>
          <label className="text-xs text-fg-2" htmlFor={`${id}-month`}>
            账单月份
            <Input
              id={`${id}-month`}
              type="month"
              className="mt-1"
              value={month}
              disabled={pending}
              onChange={(event) => {
                if (pending) return;
                setMonth(event.target.value);
                selectionChanged();
              }}
            />
          </label>
          <label className="text-xs text-fg-2" htmlFor={`${id}-kind`}>
            计费口径
            <select
              id={`${id}-kind`}
              className={`${fieldClass} mt-1 h-8`}
              value={kind}
              disabled={pending}
              onChange={(event) => {
                if (pending) return;
                setKind(event.target.value as BillingKind);
                selectionChanged();
              }}
            >
              <option value="ai_credits">AI Credits</option>
              <option value="premium_requests">旧版 Premium Requests</option>
            </select>
          </label>
          <Button
            type="submit"
            variant="neutral"
            size="regular"
            disabled={pending || !validLogin || !validMonth}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {pending ? "正在同步…" : "同步官方账单"}
          </Button>
        </div>
        <Button
          type="button"
          variant="quiet"
          size="compact"
          className="mt-3 px-0 text-xs text-fg-2"
          aria-expanded={advanced}
          aria-controls={`${id}-authorization`}
          disabled={pending}
          onClick={() => {
            setAdvanced(!advanced);
            setToken("");
            setRevealToken(false);
          }}
        >
          <ChevronDown
            className={`h-3.5 w-3.5 ${advanced ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
          高级授权（可选）
        </Button>
        {advanced && (
          <div
            id={`${id}-authorization`}
            className="mt-2 rounded-control border border-border bg-subtle p-3"
          >
            <p className="mb-2 text-xs leading-relaxed text-fg-2">
              优先尝试现有 GitHub 登录。若无账单权限，可填写个人 fine-grained
              PAT，仅需账户权限 Plan：只读。令牌仅用于本次同步，请求结束后清空。
            </p>
            <label className="text-xs text-fg-2" htmlFor={`${id}-token`}>
              临时账单令牌
            </label>
            <div className="mt-1 flex max-w-xl gap-1">
              <Input
                id={`${id}-token`}
                type={revealToken ? "text" : "password"}
                value={token}
                disabled={pending}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="new-password"
                placeholder="不会保存此令牌"
              />
              <Button
                type="button"
                variant="quiet"
                size="icon"
                disabled={pending}
                aria-label={revealToken ? "隐藏账单令牌" : "显示账单令牌"}
                onClick={() => setRevealToken(!revealToken)}
              >
                {revealToken ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        )}
      </form>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
          {report ? " 正在保留上次同步的账单。" : ""}
        </p>
      )}
      {reportQuery.isError && (
        <p role="alert" className="mt-3 text-xs text-fg-2">
          已保存账单暂时读取失败，请重试同步。
          {report ? " 正在显示上次记录。" : ""}
        </p>
      )}
      {report && totals ? (
        <div className="mt-4">
          <dl className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            {[
              [`${unit} 用量`, quantity(totals.quantity)],
              ["优惠前金额", money(totals.gross)],
              ["已抵扣金额", money(totals.discount)],
              ["官方净额", money(totals.net)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-fg-2">{label}</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          {models.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">按模型汇总的官方账单</caption>
                <thead className="text-fg-2">
                  <tr>
                    <th className="py-2 font-medium">模型</th>
                    <th className="px-3 py-2 text-right font-medium">{unit}</th>
                    <th className="px-3 py-2 text-right font-medium">优惠前</th>
                    <th className="px-3 py-2 text-right font-medium">已抵扣</th>
                    <th className="py-2 text-right font-medium">净额</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map(([model, values]) => (
                    <tr key={model} className="border-t border-border">
                      <th scope="row" className="py-2 font-normal">
                        {model}
                      </th>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {quantity(values.quantity)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(values.gross)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(values.discount)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {money(values.net)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs text-fg-2">
            上次同步：
            {new Date(report.fetchedAt * 1000).toLocaleString("zh-CN")} ·
            来源：GitHub Billing API
          </p>
        </div>
      ) : (
        <p role="status" className="mt-4 text-sm text-fg-2">
          {pending
            ? "正在读取 GitHub 官方账单…"
            : validLogin && reportQuery.isPending
              ? "正在读取已保存账单…"
              : "尚未同步此账号、月份及计费口径的官方账单。"}
        </p>
      )}
      <p className="mt-3 text-xs leading-relaxed text-fg-2">
        金额按官方字段汇总，可能延迟更新，不含固定订阅费；净额不代表发票已结算金额。
        此处与本地 API 估算分别记录，不计入上方估算费用。
      </p>
    </section>
  );
}
