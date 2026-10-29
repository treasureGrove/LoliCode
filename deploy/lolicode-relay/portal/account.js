(() => {
  const el = (id) => document.getElementById(id);
  let loggedIn = false;
  let busy = false;
  const number = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString("zh-CN") : "—";
  const date = (value, short = false) => {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return "—";
    return parsed.toLocaleString("zh-CN", {
      timeZone: "Asia/Singapore", hour12: false,
      ...(short ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" } : {}),
    });
  };
  function message(text = "", error = false) {
    el("message").textContent = text;
    el("message").classList.toggle("error", error);
  }
  function setBusy(value) {
    busy = value;
    for (const id of ["refresh", "logout", "login-submit"]) el(id).disabled = value;
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
      credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    let result;
    try { result = await response.json(); } catch { result = {}; }
    if (!response.ok) {
      const error = new Error(result.error?.message || (response.status === 429 ? "操作过于频繁，请稍后重试。" : "暂时无法读取用量，请稍后重试。"));
      error.status = response.status;
      throw error;
    }
    return result;
  }
  function renderChart(daily) {
    const maximum = Math.max(1, ...daily.map((day) => day.tokens));
    const columns = daily.map((day) => {
      const column = document.createElement("div");
      column.className = "chart-column";
      column.title = `${day.day} · ${number(day.requests)} 次请求 · ${number(day.tokens)} token`;
      const value = document.createElement("span");
      value.textContent = number(day.tokens);
      const track = document.createElement("div");
      track.className = "chart-track";
      const bar = document.createElement("div");
      bar.className = "chart-bar";
      bar.style.height = day.tokens ? `${Math.max(2, Math.round(day.tokens / maximum * 100))}%` : "2px";
      track.append(bar);
      const label = document.createElement("span");
      label.className = "chart-day";
      label.textContent = day.day.slice(5).replace("-", "/");
      column.append(value, track, label);
      return column;
    });
    el("daily-chart").replaceChildren(...columns);
    const total = daily.reduce((sum, day) => sum + day.tokens, 0);
    el("daily-chart").setAttribute("aria-label", `近七天共使用 ${number(total)} token`);
    el("chart-caption").textContent = total ? `近 7 天合计 ${number(total)} token` : "最近 7 天暂无用量";
  }
  function renderRecords(records) {
    const states = { charged: "已结算", pending: "处理中", uncertain: "已计入额度", released: "已退回" };
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
      if (record.state === "uncertain") state.title = "未收到完整用量，按预留额计入每日额度。";
      stateCell.append(state);
      const tokens = document.createElement("td");
      tokens.className = "numeric";
      tokens.textContent = number(record.tokens);
      if (record.reservedTokens > 0) {
        const reserved = document.createElement("span");
        reserved.className = "record-reserved";
        reserved.textContent = `预留 ${number(record.reservedTokens)}`;
        tokens.append(reserved);
      }
      row.append(when, model, stateCell, tokens);
      return row;
    });
    el("usage-records").replaceChildren(...rows);
    el("records-empty").hidden = records.length > 0;
  }
  function render(account, usage) {
    const q = account.quota;
    if (!q || !usage.plan || !usage.today || !Array.isArray(usage.daily) || !Array.isArray(usage.records)) {
      throw new Error("用量数据暂时不可用，请稍后刷新。");
    }
    loggedIn = true;
    el("login-panel").hidden = true;
    el("account-panel").hidden = false;
    el("logout").hidden = false;
    el("account-name").textContent = `${account.account.displayName} · @${account.account.username}`;
    el("plan-name").textContent = usage.plan.name;
    el("platform-fee").textContent = new Intl.NumberFormat("zh-CN", {
      style: "currency", currency: usage.plan.currency,
    }).format(usage.plan.billedAmount);
    // Use one ledger snapshot for used and remaining values, including at midnight.
    for (const [kind, remaining, limit, used] of [
      ["requests", Math.max(0, q.requestLimit - usage.today.requests), q.requestLimit, usage.today.requests],
      ["tokens", Math.max(0, q.tokenLimit - usage.today.tokens - usage.today.reservedTokens), q.tokenLimit, usage.today.tokens],
    ]) {
      el(`${kind}-remaining`).textContent = number(remaining);
      el(`${kind}-progress`).max = Math.max(1, limit);
      el(`${kind}-progress`).value = remaining;
      el(`${kind}-used`).textContent = number(used);
      el(`${kind}-limit`).textContent = number(limit);
    }
    el("reset").textContent = `下次重置：${date(usage.resetsAt || q.resetsAt)}（UTC+8）`;
    el("reserved").textContent = usage.today.reservedTokens > 0 ? `处理中预留 ${number(usage.today.reservedTokens)} token` : "";
    renderChart(usage.daily);
    renderRecords(usage.records);
    el("availability").textContent = account.ready ? "在 LoliCode 中选择以下模型即可使用。" : "暂无可用模型";
    el("models").replaceChildren(...account.models.map((model) => {
      const item = document.createElement("span");
      item.className = "model-tag";
      item.textContent = model.name || model.id;
      return item;
    }));
  }
  async function refresh(initial = false) {
    if (busy) return;
    setBusy(true);
    try {
      const [account, usage] = await Promise.all([request("account"), request("usage")]);
      render(account, usage);
      message();
    } catch (error) {
      if (initial || error.status === 401 || error.status === 403) showLogin();
      if (initial && error.status === 401) message();
      else message(error.message || "网络连接失败，请稍后重试。", true);
    } finally { setBusy(false); }
  }
  el("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    message("正在登录…");
    try {
      const account = await request("login", { identification: el("identification").value.trim(), password: el("password").value });
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
    try { await request("logout", {}); showLogin(); message("已退出登录。"); }
    catch (error) { message(error.message || "退出失败，请重试。", true); }
    finally { setBusy(false); }
  });
  refresh(true);
  setInterval(() => { if (loggedIn && !document.hidden) refresh(); }, 60000);
})();
