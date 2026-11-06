// 轻量平台检测，避免在 SSR 或无 navigator 的环境报错
export const isMac = (): boolean => {
  try {
    const ua = navigator.userAgent || "";
    const plat = (navigator.platform || "").toLowerCase();
    return /mac/i.test(ua) || plat.includes("mac");
  } catch {
    return false;
  }
};

export const isWindows = (): boolean => {
  try {
    const ua = navigator.userAgent || "";
    return /windows|win32|win64/i.test(ua);
  } catch {
    return false;
  }
};

export const isLinux = (): boolean => {
  try {
    const ua = navigator.userAgent || "";
    // WebKitGTK/Chromium 在 Linux/Wayland/X11 下 UA 通常包含 Linux 或 X11
    return (
      /linux|x11/i.test(ua) && !/android/i.test(ua) && !isMac() && !isWindows()
    );
  } catch {
    return false;
  }
};

// Linux keeps drag regions disabled to avoid Wayland move/resize issues.
// Windows uses Tauri's mousedown handler. CSS app-region would also ask
// WebView2 to reposition native hit-test windows as the DOM geometry changes.
export const DRAG_REGION_ENABLED = !isLinux();
const WEBKIT_DRAG_REGION_ENABLED = DRAG_REGION_ENABLED && !isWindows();

export const DRAG_REGION_ATTR: Record<string, unknown> = DRAG_REGION_ENABLED
  ? {
      "data-tauri-drag-region": true,
      "data-webkit-drag-region": WEBKIT_DRAG_REGION_ENABLED || undefined,
    }
  : {};

export const DRAG_REGION_STYLE: Record<string, unknown> =
  WEBKIT_DRAG_REGION_ENABLED ? { WebkitAppRegion: "drag" } : {};
