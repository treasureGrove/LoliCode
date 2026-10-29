// Public navigation and login use the forum-backed session, including on the homepage.
(() => {
  const publicPaths = new Set(["/", "/pricing", "/rankings", "/about"]);
  const frameSelector =
    'iframe[src^="https://relay.lolicode.com/relay-assets/index.html?"]';
  let account = null;
  let reading = false;
  let submitting = false;
  let generation = 0;
  let refreshedAt = 0;
  let loginOpener;

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const link = (text, href, className) => {
    const node = element("a", className, text);
    node.href = href;
    return node;
  };
  const nav = element("header", "relay-public-nav");
  nav.id = "relay-public-nav";
  const brand = link("", "/", "relay-nav-brand");
  const logo = element("img");
  logo.src = "https://lolicode.com/desktop-assets/favicon-32.png";
  logo.alt = "";
  logo.width = logo.height = 32;
  brand.append(logo, element("span", "", "LoliCode Relay"));
  const navigation = element("nav", "relay-nav-links");
  navigation.setAttribute("aria-label", "主导航");
  for (const [text, href] of [
    ["用户控制台", "/account"],
    ["管理后台", "/admin"],
  ]) {
    navigation.append(link(text, href));
  }
  const controls = element("div", "relay-nav-account");
  controls.setAttribute("aria-live", "polite");
  nav.append(brand, navigation, controls);

  const dialog = element("dialog", "relay-login-dialog");
  dialog.setAttribute("aria-labelledby", "relay-login-heading");
  const close = element("button", "relay-login-close", "×");
  close.type = "button";
  close.setAttribute("aria-label", "关闭登录窗口");
  close.addEventListener("click", () => dialog.close());
  const heading = element("h2", "", "登录 LoliCode 账号");
  heading.id = "relay-login-heading";
  const form = element("form", "relay-login-form");
  const nameLabel = element("label", "", "用户名或邮箱");
  nameLabel.htmlFor = "relay-login-name";
  const name = element("input");
  name.id = "relay-login-name";
  name.name = "username";
  name.autocomplete = "username";
  name.maxLength = 512;
  name.required = true;
  const passwordLabel = element("label", "", "密码");
  passwordLabel.htmlFor = "relay-login-password";
  const password = element("input");
  password.id = "relay-login-password";
  password.name = "password";
  password.type = "password";
  password.autocomplete = "current-password";
  password.maxLength = 1024;
  password.required = true;
  const error = element("p", "relay-login-error");
  error.setAttribute("role", "status");
  const submit = element("button", "relay-nav-primary", "登录 LoliCode");
  submit.type = "submit";
  form.append(nameLabel, name, passwordLabel, password, error, submit);
  const loginLinks = element("div", "relay-login-links");
  loginLinks.append(
    link("注册 LoliCode 账号 ↗", "/register"),
    link("忘记密码？", "https://lolicode.com/all?account=login"),
  );
  dialog.append(
    close,
    heading,
    element(
      "p",
      "relay-login-description",
      "使用原来的社区用户名或邮箱和密码，无需另行注册中转站账号。",
    ),
    form,
    loginLinks,
  );
  document.body.prepend(nav);
  document.body.append(dialog);

  function updateFrame() {
    document
      .querySelector(frameSelector)
      ?.contentWindow.postMessage(
        { type: "lolicode:portal-account", signedIn: Boolean(account) },
        "*",
      );
    document.querySelector(frameSelector)?.contentWindow.postMessage(
      {
        themeMode: document.documentElement.classList.contains("dark")
          ? "dark"
          : "light",
      },
      "*",
    );
  }
  function render() {
    controls.replaceChildren();
    if (!account) {
      const login = element("button", "relay-nav-primary", "LoliCode 登录");
      login.type = "button";
      login.addEventListener("click", () => openLogin(login));
      controls.append(link("注册", "/register", "relay-nav-register"), login);
    } else {
      const menu = element("details", "relay-account-menu");
      const summary = element("summary");
      const initial =
        Array.from(account.displayName || account.username)[0] || "L";
      summary.append(
        element("span", "relay-account-initial", initial),
        element(
          "span",
          "relay-account-name",
          account.displayName || account.username,
        ),
        element("span", "", "⌄"),
      );
      const dropdown = element("div", "relay-account-dropdown");
      const logout = element("button", "", "退出 LoliCode 登录");
      logout.type = "button";
      logout.addEventListener("click", async () => {
        if (submitting) return;
        submitting = true;
        logout.disabled = true;
        ++generation;
        try {
          await api("logout", {});
          account = null;
          render();
        } catch (failure) {
          logout.textContent = failure.message || "退出失败，请重试";
        } finally {
          submitting = false;
          logout.disabled = false;
        }
      });
      dropdown.append(link("我的额度 / 控制台", "/account"), logout);
      menu.append(summary, dropdown);
      controls.append(menu);
    }
    updateFrame();
  }
  async function api(path, body) {
    const response = await fetch(`/account-api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const failure = new Error(
        data.error?.message ||
          (response.status === 429
            ? "尝试过于频繁，请稍后重试。"
            : "账号服务暂时无法连接，请稍后重试。"),
      );
      failure.status = response.status;
      throw failure;
    }
    return data;
  }
  async function refresh() {
    if (reading || submitting || !publicPaths.has(location.pathname)) return;
    reading = true;
    const current = generation;
    try {
      const status = await api("account");
      if (current !== generation) return;
      account = status.account;
      render();
    } catch (failure) {
      if (current !== generation) return;
      if (failure.status === 401 || failure.status === 403) {
        account = null;
        render();
      }
    } finally {
      reading = false;
      refreshedAt = Date.now();
    }
  }
  function openLogin(opener) {
    if (account) {
      location.assign("/account");
      return;
    }
    if (dialog.open) return;
    loginOpener = opener;
    error.textContent = "";
    dialog.showModal();
    name.focus();
  }
  dialog.addEventListener("close", () => {
    password.value = "";
    loginOpener?.focus();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    submit.disabled = true;
    error.textContent = "正在验证 LoliCode 账号…";
    ++generation;
    try {
      const result = await api("login", {
        identification: name.value.trim(),
        password: password.value,
      });
      account = result.account;
      dialog.close();
      render();
    } catch (failure) {
      error.textContent = failure.message || "网络连接失败，请稍后重试。";
    } finally {
      password.value = "";
      submit.disabled = false;
      submitting = false;
    }
  });
  window.addEventListener("message", (event) => {
    const frame = document.querySelector(frameSelector);
    if (
      event.origin !== "null" ||
      !frame ||
      event.source !== frame.contentWindow
    )
      return;
    if (event.data?.type === "lolicode:portal-login")
      openLogin(controls.querySelector("button"));
    if (event.data?.type === "lolicode:portal-ready") updateFrame();
  });
  function route() {
    const isPublic = publicPaths.has(location.pathname);
    document.body.classList.toggle("relay-public-page", isPublic);
    nav.hidden = !isPublic;
    if (!isPublic && dialog.open) dialog.close();
    for (const anchor of navigation.querySelectorAll("a")) {
      if (anchor.getAttribute("href") === location.pathname)
        anchor.setAttribute("aria-current", "page");
      else anchor.removeAttribute("aria-current");
    }
    if (isPublic && Date.now() - refreshedAt > 1000) refresh();
  }
  window.addEventListener("lolicode:route", route);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  window.addEventListener("pageshow", () => refresh());
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 60000);
  render();
  route();
})();
