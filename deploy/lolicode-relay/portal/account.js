(() => {
  const el = (id) => document.getElementById(id);
  let loggedIn = false;
  let busy = false;
  const number = (value) =>
    Number.isFinite(Number(value))
      ? Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 6 })
      : "—";
  const credits = (row) => row.credits ?? row.tokens / 1000;
  const reservedCredits = (row) =>
    row.creditsReserved ??
    row.reservedCredits ??
    (row.reservedTokens || 0) / 1000;
  const creditPerMillion = (value) =>
    number(Number((Number(value) * 1000).toFixed(6)));
  function legacyPricePerMillion(value, conversion) {
    const units = (number) => {
      const text = String(number ?? "");
      if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) return null;
      const [whole, fraction = ""] = text.split(".");
      return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
    };
    const price = units(value),
      rate = units(conversion);
    if (price === null || rate === null || rate === 0n) return null;
    const product = price * rate;
    if (product % 1000000n !== 0n || product / 1000000n > 10000000n * 1000000n)
      return null;
    return number(Number(product / 1000000n) / 1000000);
  }
  function billingDescription(billing, legacyRate) {
    if (billing?.mode === "request")
      return "旧定价待迁移，请联系管理员；当前费用仍按原配置结算。";
    if (billing?.mode === "tokens") {
      const prices = billing.prices || {};
      const quote = Object.fromEntries(
        ["input", "output", "cacheRead", "cacheWrite"].map((key) => [
          key,
          legacyPricePerMillion(prices[key], billing.creditsPerUnit),
        ]),
      );
      if (Object.values(quote).some((value) => value === null))
        return "旧报价待迁移，无法精确显示当前 Credit 单价；请联系管理员。";
      return `每 1M（100万）token：输入 ${quote.input} / 输出 ${quote.output} / 缓存读 ${quote.cacheRead} / 缓存写 ${quote.cacheWrite} Credit`;
    }
    const rate = billing?.rate ||
      legacyRate || { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
    return `每 1M（100万）token：输入 ${creditPerMillion(rate.input)} / 输出 ${creditPerMillion(rate.output)} / 缓存读 ${creditPerMillion(rate.cacheRead)} / 缓存写 ${creditPerMillion(rate.cacheWrite)} Credit`;
  }
  function accountCreditBalance(quota) {
    const valid = (value) =>
      typeof value === "number" && Number.isFinite(value) && value >= 0;
    const fields = ["limit", "used", "reserved", "remaining"];
    if (quota.creditBalance !== undefined && quota.creditBalance !== null) {
      const balance = quota.creditBalance;
      if (
        !balance ||
        balance.unit !== "Credit" ||
        !fields.every((key) => valid(balance[key]))
      )
        throw new Error("Credit 余额快照不完整，请刷新后重试。");
      return balance;
    }
    const flat = {
      unit: "Credit",
      limit: quota.creditLimit,
      used: quota.creditsUsed,
      reserved: quota.creditsReserved,
      remaining: quota.creditsRemaining,
    };
    if (fields.every((key) => valid(flat[key]))) return flat;
    const legacy = {
      unit: "Credit",
      limit: quota.tokenLimit,
      used: quota.tokensUsed,
      reserved: quota.tokensReserved,
      remaining: quota.tokensRemaining,
    };
    if (fields.every((key) => valid(legacy[key])))
      return Object.fromEntries(
        Object.entries(legacy).map(([key, value]) => [
          key,
          key === "unit" ? value : value / 1000,
        ]),
      );
    throw new Error("Credit 余额暂时不可用，请刷新后重试。");
  }
  const date = (value, short = false) => {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return "—";
    return parsed.toLocaleString("zh-CN", {
      timeZone: "Asia/Singapore",
      hour12: false,
      ...(short
        ? {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }
        : {}),
    });
  };
  function message(text = "", error = false) {
    el("message").textContent = text;
    el("message").classList.toggle("error", error);
  }
  function setBusy(value) {
    busy = value;
    for (const id of ["refresh", "logout", "login-submit"])
      el(id).disabled = value;
  }
  function showLogin() {
    loggedIn = false;
    el("account-panel").hidden = true;
    el("login-panel").hidden = false;
    el("logout").hidden = true;
    el("usage-records").replaceChildren();
    el("daily-chart").replaceChildren();
    el("models").replaceChildren();
  }
  async function request(path, body) {
    const response = await fetch(`/account-api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      result = {};
    }
    if (!response.ok) {
      const error = new Error(
        result.error?.message ||
          (response.status === 429
            ? "操作过于频繁，请稍后重试。"
            : "暂时无法读取用量，请稍后重试。"),
      );
      error.status = response.status;
      throw error;
    }
    return result;
  }
  function renderChart(daily) {
    const maximum = Math.max(0.000001, ...daily.map(credits));
    const columns = daily.map((day) => {
      const column = document.createElement("div");
      column.className = "chart-column";
      column.title = `${day.day} · ${number(day.requests)} 次请求 · ${number(credits(day))} Credit · ${number(day.tokens)} token${reservedCredits(day) > 0 ? ` · 预留 ${number(reservedCredits(day))} Credit` : ""}`;
      const value = document.createElement("span");
      value.textContent = number(credits(day));
      const track = document.createElement("div");
      track.className = "chart-track";
      const bar = document.createElement("div");
      bar.className = "chart-bar";
      bar.style.height = credits(day)
        ? `${Math.max(2, Math.round((credits(day) / maximum) * 100))}%`
        : "2px";
      track.append(bar);
      const label = document.createElement("span");
      label.className = "chart-day";
      label.textContent = day.day.slice(5).replace("-", "/");
      column.append(value, track, label);
      return column;
    });
    el("daily-chart").replaceChildren(...columns);
    const total = daily.reduce((sum, day) => sum + credits(day), 0);
    const tokens = daily.reduce((sum, day) => sum + day.tokens, 0);
    el("daily-chart").setAttribute(
      "aria-label",
      `近七天共使用 ${number(total)} Credit`,
    );
    el("chart-caption").textContent =
      tokens || total
        ? `近 7 天合计 ${number(total)} Credit · ${number(tokens)} token；处理中预留不计入柱状图。`
        : "最近 7 天暂无用量";
  }
  function renderRecords(records) {
    const states = {
      charged: "已结算",
      pending: "处理中",
      uncertain: "待确认 · 按预留计费",
      released: "已退回",
    };
    const rows = records.slice(0, 20).map((record) => {
      const row = document.createElement("tr");
      const when = document.createElement("td");
      when.textContent = date(record.createdAt, true);
      const model = document.createElement("td");
      model.className = "model";
      model.textContent = record.model;
      model.title = record.model;
      const stateCell = document.createElement("td");
      const state = document.createElement("span");
      state.className = `record-state ${Object.hasOwn(states, record.state) ? record.state : ""}`;
      state.textContent = states[record.state] || "待确认";
      if (record.state === "uncertain")
        state.title =
          "未收到完整用量，按请求开始时的 Credit 预留额计入每日额度。";
      stateCell.append(state);
      const tokens = document.createElement("td");
      tokens.className = "numeric";
      tokens.textContent = number(record.tokens);
      const chargedCredits = document.createElement("td");
      chargedCredits.className = "numeric";
      chargedCredits.textContent = number(credits(record));
      const rate = record.creditRate;
      if (rate)
        chargedCredits.title = `本次费率（Credit / 1M（100万）token）：输入 ${creditPerMillion(rate.input)}，输出 ${creditPerMillion(rate.output)}，缓存读取 ${creditPerMillion(rate.cacheRead)}，缓存写入 ${creditPerMillion(rate.cacheWrite)}`;
      if (record.costDetails && typeof record.costDetails === "object") {
        const cost = record.costDetails;
        const detail = document.createElement("span");
        detail.className = "record-cost";
        const basis =
          cost.basis === "request"
            ? "按次计费"
            : cost.basis === "reservation"
              ? "按预留计费"
              : "实际用量";
        detail.textContent = `${basis} ${String(cost.amount ?? "—")} ${String(cost.currency || "")}`;
        detail.title = `本次换算率：1 ${String(cost.currency || "")} = ${number(cost.creditsPerUnit)} Credit`;
        chargedCredits.title = `${basis} ${String(cost.amount ?? "—")} ${String(cost.currency || "")}；${detail.title}`;
        chargedCredits.append(detail);
      }
      if (reservedCredits(record) > 0) {
        const reserved = document.createElement("span");
        reserved.className = "record-reserved";
        reserved.textContent = `预留 ${number(reservedCredits(record))}`;
        chargedCredits.append(reserved);
      }
      row.append(when, model, stateCell, chargedCredits, tokens);
      return row;
    });
    el("usage-records").replaceChildren(...rows);
    el("records-empty").hidden = records.length > 0;
  }
  function render(account, usage) {
    const q = account.quota;
    if (
      !q ||
      !usage.plan ||
      !usage.today ||
      !Array.isArray(usage.daily) ||
      !Array.isArray(usage.records)
    ) {
      throw new Error("用量数据暂时不可用，请稍后刷新。");
    }
    const balance = accountCreditBalance(q);
    loggedIn = true;
    el("login-panel").hidden = true;
    el("account-panel").hidden = false;
    el("logout").hidden = false;
    el("account-name").textContent =
      `${account.account.displayName} · @${account.account.username}`;
    el("plan-name").textContent = usage.plan.name;
    el("platform-fee").textContent = new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: usage.plan.currency,
    }).format(usage.plan.billedAmount);
    // The server supplies the whole balance from one ledger/pricing revision.
    el("credits-remaining").textContent = number(balance.remaining);
    el("credits-progress").max = Math.max(1, balance.limit);
    el("credits-progress").value = balance.remaining;
    el("credits-used").textContent = number(balance.used);
    el("credits-limit").textContent = number(balance.limit);
    const heldCredits = balance.reserved;
    if (balance.pricingRevision !== undefined)
      el("account-panel").dataset.pricingRevision = String(
        balance.pricingRevision,
      );
    if (balance.ledgerRevision !== undefined)
      el("account-panel").dataset.ledgerRevision = String(
        balance.ledgerRevision,
      );
    el("reset").textContent =
      `下次重置：${date(usage.resetsAt || q.resetsAt)}（UTC+8）`;
    el("reserved").textContent =
      heldCredits > 0
        ? `处理中预留 ${number(heldCredits)} Credit，结束后按实际用量结算。`
        : "";
    el("requests-used").textContent = number(usage.today.requests);
    el("tokens-used").textContent = number(usage.today.tokens);
    renderChart(usage.daily);
    renderRecords(usage.records);
    el("availability").textContent = account.ready
      ? "在 LoliCode 中选择以下模型即可使用。"
      : "暂无可用模型";
    el("models").replaceChildren(
      ...account.models.map((model) => {
        const item = document.createElement("span");
        item.className = "model-tag";
        const name = document.createElement("strong");
        name.textContent = model.name || model.id;
        const pricing = document.createElement("span");
        pricing.className = "model-pricing";
        pricing.textContent = billingDescription(
          model.billing,
          model.creditRate,
        );
        item.append(name, pricing);
        return item;
      }),
    );
  }
  async function refresh(initial = false) {
    if (busy) return;
    setBusy(true);
    try {
      const [account, usage] = await Promise.all([
        request("account"),
        request("usage"),
      ]);
      render(account, usage);
      message();
    } catch (error) {
      if (initial || error.status === 401 || error.status === 403) showLogin();
      if (initial && error.status === 401) message();
      else message(error.message || "网络连接失败，请稍后重试。", true);
    } finally {
      setBusy(false);
    }
  }
  el("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    message("正在登录…");
    try {
      const account = await request("login", {
        identification: el("identification").value.trim(),
        password: el("password").value,
      });
      render(account, await request("usage"));
      message();
    } catch (error) {
      if (error.status === 401 || error.status === 403) showLogin();
      message(error.message || "网络连接失败，请稍后重试。", true);
    } finally {
      el("password").value = "";
      setBusy(false);
    }
  });
  el("refresh").addEventListener("click", () => refresh());
  el("logout").addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    try {
      await request("logout", {});
      showLogin();
      message("已退出登录。");
    } catch (error) {
      message(error.message || "退出失败，请重试。", true);
    } finally {
      setBusy(false);
    }
  });
  refresh(true);
  setInterval(() => {
    if (loggedIn && !document.hidden) refresh();
  }, 60000);
})();
