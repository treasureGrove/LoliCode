// Ordinary accounts use the forum-backed portal; explicit admin entry stays native.
(() => {
  const nativeAdminPath = (path) =>
    /^\/(?:dashboard|channels?|models?|users?|settings|system-settings|security|profile|keys|usage-logs|logs|tokens?|redemption)(?:\/|$)/.test(
      path,
    );
  const adminDestination = (url) =>
    ["redirect", "returnTo"].some((name) => {
      const target = url.searchParams.get(name);
      if (!target) return false;
      try {
        const destination = new URL(target, location.origin);
        return (
          destination.origin === location.origin &&
          nativeAdminPath(destination.pathname)
        );
      } catch {
        return false;
      }
    });
  let adminContext =
    nativeAdminPath(location.pathname) ||
    new URL(location.href).searchParams.get("admin") === "1";
  const shortcuts = document.createElement("nav");
  shortcuts.id = "relay-admin-shortcuts";
  shortcuts.className = "relay-admin-shortcuts";
  shortcuts.setAttribute("aria-label", "中转站管理快捷入口");
  shortcuts.hidden = true;
  const caption = document.createElement("span");
  caption.textContent = "中转站管理";
  shortcuts.append(caption);
  for (const [text, href] of [
    ["渠道管理", "/channels"],
    ["简易后台", "/public-models-admin"],
  ]) {
    const anchor = document.createElement("a");
    anchor.textContent = text;
    anchor.href = href;
    shortcuts.append(anchor);
  }
  document.body.append(shortcuts);
  const isPublicLogin = (url) =>
    url.origin === location.origin &&
    ["/sign-in", "/login"].includes(url.pathname) &&
    url.searchParams.get("admin") !== "1";
  const loginDestination = (url) => {
    if (adminContext || adminDestination(url)) {
      url.searchParams.set("admin", "1");
      return url.pathname + url.search + url.hash;
    }
    return "/account";
  };
  const route = () => {
    const url = new URL(location.href);
    if (nativeAdminPath(url.pathname)) adminContext = true;
    else if (
      ["/", "/account", "/pricing", "/rankings", "/about"].includes(
        url.pathname,
      )
    )
      adminContext = false;
    if (/^\/dashboard(?:\/overview)?\/?$/.test(url.pathname) && adminContext) {
      location.replace("/public-models-admin");
      return;
    }
    if (isPublicLogin(url)) location.replace(loginDestination(url));
    shortcuts.hidden = !nativeAdminPath(url.pathname);
    window.dispatchEvent(new Event("lolicode:route"));
  };
  document.addEventListener(
    "click",
    (event) => {
      const link = event.target.closest?.("a[href]");
      if (link && isPublicLogin(new URL(link.href, location.href))) {
        event.preventDefault();
        event.stopImmediatePropagation();
        location.assign(loginDestination(new URL(link.href, location.href)));
      }
    },
    true,
  );
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      route();
      return result;
    };
  }
  window.addEventListener("popstate", route);
  route();
})();

// Only resize our own opaque-origin sandboxed homepage.
window.addEventListener("message", (event) => {
  if (event.origin !== "null") return;
  const message = event.data;
  const frame = document.querySelector(
    'iframe[src^="https://relay.lolicode.com/relay-assets/index.html?"]',
  );
  if (!frame || event.source !== frame.contentWindow) return;
  if (
    message?.type === "lolicode:portal-size" &&
    Number.isInteger(message.height) &&
    message.height >= 300 &&
    message.height <= 30000
  ) {
    frame.style.height = `${message.height}px`;
  } else if (
    message?.type === "lolicode:portal-anchor" &&
    Number.isInteger(message.top) &&
    message.top >= 0 &&
    message.top <= frame.offsetHeight
  ) {
    window.scrollTo({
      top:
        frame.getBoundingClientRect().top + window.scrollY + message.top - 80,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
  }
});
