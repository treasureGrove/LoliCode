(() => {
  const el = (id) => document.getElementById(id);
  let loggedIn = false;
  let busy = false;
  function message(text = "", error = false) {
    el("message").textContent = text;
    el("message").classList.toggle("error", error);
  }
  function showLogin() {
    loggedIn = false;
    el("account-panel").hidden = true;
    el("login-panel").hidden = false;
  }
  async function request(path, body) {
    const response = await fetch(`/account-api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let result;
    try { result = await response.json(); } catch { result = {}; }
    if (!response.ok) {
      const error = new Error(result.error?.message || (response.status === 429 ? "操作过于频繁，请稍后重试。" : "暂时无法读取账号服务，请稍后重试。"));
      error.status = response.status;
      throw error;
    }
    return result;
  }
  const number = (value) => Number(value).toLocaleString("zh-CN");
  const date = (value) => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Singapore", hour12: false });
  function render(value) {
    const q = value.quota;
    loggedIn = true;
    el("login-panel").hidden = true;
    el("account-panel").hidden = false;
    el("display-name").textContent = value.account.displayName;
    el("username").textContent = `@${value.account.username} · LoliCode 账号`;
    for (const [kind, remaining, limit] of [["requests", q.requestsRemaining, q.requestLimit], ["tokens", q.tokensRemaining, q.tokenLimit]]) {
      el(`${kind}-remaining`).textContent = number(remaining);
      el(`${kind}-progress`).max = limit;
      el(`${kind}-progress`).value = remaining;
    }
    el("requests-detail").textContent = `已用 ${number(q.requestsUsed)} / 每日 ${number(q.requestLimit)} 次`;
    el("tokens-detail").textContent = `已用 ${number(q.tokensUsed)} / 每日 ${number(q.tokenLimit)} token${q.tokensReserved ? ` · 处理中预留 ${number(q.tokensReserved)}` : ""}`;
    el("reset").textContent = `下次重置：${date(q.resetsAt)}（UTC+8）· 当日额度不累积 · 网页与客户端共用额度`;
    el("availability").textContent = value.ready ? "公益模型已开放，可在客户端使用。" : "公益模型目前暂未开放，或本轮试用已结束。你的账号可以正常登录。";
    el("models").replaceChildren(...value.models.map((model) => {
      const item = document.createElement("li");
      item.textContent = model.name || model.id;
      return item;
    }));
    el("trial-end").textContent = value.trialEndsAt ? `本轮试用截止：${date(value.trialEndsAt)}（UTC+8），续期后会更新开放状态。` : "";
  }
  async function refresh(initial = false) {
    if (busy) return;
    busy = true;
    el("refresh").disabled = true;
    try {
      render(await request("account"));
      message();
    } catch (error) {
      if (initial || error.status === 401 || error.status === 403) showLogin();
      if (initial && error.status === 401) message();
      else message(error.message || "网络连接失败，请稍后重试。", true);
    } finally {
      busy = false;
      el("refresh").disabled = false;
    }
  }
  el("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    el("login-submit").disabled = true;
    message("正在验证 LoliCode 账号…");
    try {
      render(await request("login", { identification: el("identification").value.trim(), password: el("password").value }));
      message();
    } catch (error) {
      message(error.message || "网络连接失败，请稍后重试。", true);
    } finally {
      el("password").value = "";
      busy = false;
      el("login-submit").disabled = false;
    }
  });
  el("refresh").addEventListener("click", () => refresh());
  el("logout").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    el("logout").disabled = true;
    try { await request("logout", {}); showLogin(); message("已退出网页登录，客户端登录不受影响。"); }
    catch (error) { message(error.message || "退出失败，请重试。", true); }
    finally { busy = false; el("logout").disabled = false; }
  });
  refresh(true);
  setInterval(() => { if (loggedIn && !document.hidden) refresh(); }, 60000);
})();
