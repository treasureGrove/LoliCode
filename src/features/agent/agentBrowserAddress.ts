export function externalBrowserAddress(value: string): URL | undefined {
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !["tauri.localhost", "asset.localhost", "ipc.localhost"].includes(
        url.hostname.replace(/\.+$/, ""),
      ) &&
      !url.pathname.startsWith("/__lolicode_preview/") &&
      url.origin !== window.location.origin
    )
      return url;
  } catch {
    // Ignore malformed addresses supplied by stale preview receipts.
  }
}

export function typedBrowserAddress(value: string): string | undefined {
  const trimmed = value.trim();
  // Harness uses HTTPS for hostnames entered without a scheme.
  const explicitScheme = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/.test(
    trimmed,
  );
  return externalBrowserAddress(explicitScheme ? trimmed : `https://${trimmed}`)
    ?.href;
}
