// Ordinary accounts use the forum-backed portal; explicit admin entry stays native.
(() => {
  const isPublicLogin = (url) => url.origin === location.origin &&
    ["/sign-in", "/login"].includes(url.pathname) && url.searchParams.get("admin") !== "1";
  const route = () => {
    if (isPublicLogin(new URL(location.href))) location.replace("/account");
    window.dispatchEvent(new Event("lolicode:route"));
  };
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (link && isPublicLogin(new URL(link.href, location.href))) {
      event.preventDefault();
      event.stopImmediatePropagation();
      location.assign("/account");
    }
  }, true);
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
