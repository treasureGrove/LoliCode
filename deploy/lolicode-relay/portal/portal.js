const status = document.getElementById("service-status");
const note = document.getElementById("service-note");
const hostOrigin = "https://relay.lolicode.com";
let statusTimer;

// The official custom-home sandbox keeps this document separate from account state.
if (window.parent !== window) {
  document.documentElement.classList.add("is-embedded");
  let resizeScheduled = false;
  const reportHeight = () => {
    if (resizeScheduled) return;
    resizeScheduled = true;
    requestAnimationFrame(() => {
      resizeScheduled = false;
      window.parent.postMessage(
        {
          type: "lolicode:portal-size",
          height: Math.ceil(document.body.getBoundingClientRect().height),
        },
        hostOrigin,
      );
    });
  };
  new ResizeObserver(reportHeight).observe(document.body);
  window.addEventListener("load", reportHeight);
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.('a[href^="#"]');
    const target = link && document.getElementById(link.hash.slice(1));
    if (!target) return;
    event.preventDefault();
    window.parent.postMessage(
      {
        type: "lolicode:portal-anchor",
        top: Math.ceil(target.getBoundingClientRect().top + window.scrollY),
      },
      hostOrigin,
    );
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== hostOrigin) return;
    if (event.data?.themeMode === "dark" || event.data?.themeMode === "light") {
      document.documentElement.dataset.theme = event.data.themeMode;
    }
    if (event.data?.type === "lolicode:portal-account" && typeof event.data.signedIn === "boolean") {
      const entry = document.getElementById("hero-account-entry");
      entry.dataset.signedIn = String(event.data.signedIn);
      entry.textContent = event.data.signedIn ? "进入我的额度 ↗" : "LoliCode 账号登录 ↗";
    }
  });
  document.getElementById("hero-account-entry").addEventListener("click", (event) => {
    // If the parent login UI failed to load, preserve the ordinary /account link.
    if (event.currentTarget.dataset.signedIn !== "false") return;
    event.preventDefault();
    window.parent.postMessage({ type: "lolicode:portal-login" }, hostOrigin);
  });
  window.parent.postMessage({ type: "lolicode:portal-ready" }, hostOrigin);
  reportHeight();
}

async function loadStatus() {
  clearTimeout(statusTimer);
  status.parentElement
    .querySelectorAll(".retry-status")
    .forEach((button) => button.remove());
  try {
    const response = await fetch("/community-status", {
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Unavailable");
    const data = await response.json();
    if (
      typeof data.ready !== "boolean" ||
      !Number.isInteger(data.dailyRequests) ||
      !Number.isInteger(data.dailyTokens) ||
      data.dailyRequests < 1 ||
      data.dailyTokens < 1
    )
      throw new Error("Invalid status");
    document.getElementById("request-limit").textContent =
      data.dailyRequests.toLocaleString("zh-CN");
    document.getElementById("token-limit").textContent =
      data.dailyTokens >= 10000
        ? `${data.dailyTokens / 10000}万`
        : data.dailyTokens.toLocaleString("zh-CN");
    status.textContent = data.ready
      ? `公益模型已开放 · ${data.modelCount} 个模型`
      : "模型接入中 · 暂未开放使用";
    status.parentElement.classList.toggle("is-ready", data.ready);
    const deadline = data.trialEndsAt ? new Date(data.trialEndsAt) : null;
    const trialNote =
      deadline && Number.isFinite(deadline.getTime())
        ? ` 本轮试用至 ${deadline.toLocaleString("zh-CN", {
            timeZone: "Asia/Singapore",
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}（UTC+8）。`
        : "";
    note.textContent = data.ready
      ? "在 LoliCode 中登录原账号，查看可用模型与每日额度。"
      : "接入完成后，在包含公益入口的 LoliCode 客户端中使用。";
    if (data.ready) note.textContent += trialNote;
    const limits = data.limits;
    const poolNote =
      limits &&
      Number.isInteger(limits.globalDailyRequests) &&
      Number.isInteger(limits.globalDailyTokens) &&
      Number.isInteger(limits.maxConcurrentGlobal)
        ? ` 全站每天共用 ${limits.globalDailyRequests} 次、${(limits.globalDailyTokens / 10000).toLocaleString("zh-CN")} 万 token，最多同时处理 ${limits.maxConcurrentGlobal} 个请求；繁忙时请稍后重试。`
        : "";
    document.getElementById("availability-answer").textContent = data.ready
      ? "模型已开放。请使用包含公益入口的客户端，并在头像菜单中查看可用模型和每日额度。" +
        poolNote +
        trialNote
      : "目前正在接入模型，尚未开放推理。原有账号已经联动，无需再注册；请留意这里的开放状态。";
  } catch {
    status.textContent = "开放状态暂时无法读取";
    note.textContent = "请稍后刷新页面；也可以在 LoliCode 应用内查看状态。";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "retry-status";
    button.textContent = "重新读取";
    button.addEventListener(
      "click",
      () => {
        button.remove();
        status.textContent = "正在读取开放状态…";
        loadStatus();
      },
      { once: true },
    );
    status.after(button);
  } finally {
    statusTimer = setTimeout(loadStatus, 60000);
  }
}
loadStatus();
