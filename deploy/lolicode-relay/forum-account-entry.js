// Open Flarum's existing account dialogs; account creation stays with Flarum.
(() => {
  const action = new URLSearchParams(window.location.search).get("account");
  if (action !== "register" && action !== "login") return;
  const selector =
    action === "register" ? ".item-signUp button" : ".item-logIn button";
  const started = Date.now();
  let finished = false;
  let observer;
  let timer;
  function stop() {
    finished = true;
    observer?.disconnect();
    clearTimeout(timer);
  }
  function notice(message) {
    const box = document.createElement("aside");
    box.className = "lolicode-account-entry-note";
    box.setAttribute("role", "status");
    box.style.cssText =
      "position:relative;z-index:1200;margin:12px auto;padding:14px 18px;max-width:760px;background:#fff6e9;color:#632339;border:1px solid #d897a7;border-radius:12px;font:14px/1.8 sans-serif";
    const text = document.createElement("p");
    text.textContent = message;
    const back = document.createElement("a");
    back.href = "https://relay.lolicode.com/account";
    back.textContent = "登录中转站 / 查看我的额度 ↗";
    back.style.cssText = "color:#9e2445;text-decoration:underline";
    box.append(text, back);
    document.body.prepend(box);
  }
  function open() {
    if (finished || !document.body) return;
    clearTimeout(timer);
    const button = document.querySelector(selector);
    if (button) {
      stop();
      button.click();
      return;
    }
    if (document.querySelector(".item-session, .SessionDropdown")) {
      stop();
      notice(
        "你已登录 LoliCode，无需再次注册。中转站网页和客户端都可使用这个账号登录。",
      );
      return;
    }
    if (Date.now() - started >= 15000) {
      stop();
      notice(
        "请在社区菜单中选择注册或登录。已有 LoliCode 账号可直接在客户端登录，公益模型共用同一账号。",
      );
      return;
    }
    timer = setTimeout(open, 250);
  }
  observer = new MutationObserver(open);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  open();
})();
