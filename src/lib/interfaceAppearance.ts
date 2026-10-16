export type DecorationMode = "full" | "soft" | "off";

export interface InterfaceAppearance {
  mode: DecorationMode;
  intensity: number;
  companionVisible: boolean;
}

export const INTERFACE_APPEARANCE_KEY = "lolicode.interface-appearance.v1";
export const INTERFACE_APPEARANCE_EVENT = "lolicode:interface-appearance";
export const INTERFACE_BACKGROUND_OPACITY_KEY =
  "lolicode.interface-background-opacity.v1";
export const DEFAULT_INTERFACE_BACKGROUND_OPACITY = 75;
export const DEFAULT_INTERFACE_APPEARANCE: InterfaceAppearance = {
  mode: "full",
  intensity: 48,
  companionVisible: true,
};

let memoryFallback: string | null = null;

export function readInterfaceBackgroundOpacity() {
  try {
    const raw = window.localStorage.getItem(INTERFACE_BACKGROUND_OPACITY_KEY);
    if (raw === null) return DEFAULT_INTERFACE_BACKGROUND_OPACITY;
    const value = Number(raw);
    return Number.isFinite(value)
      ? Math.round(Math.min(95, Math.max(20, value)))
      : DEFAULT_INTERFACE_BACKGROUND_OPACITY;
  } catch {
    return DEFAULT_INTERFACE_BACKGROUND_OPACITY;
  }
}

export function saveInterfaceBackgroundOpacity(opacity: number) {
  const value = Math.round(Math.min(95, Math.max(20, opacity)));
  try {
    window.localStorage.setItem(
      INTERFACE_BACKGROUND_OPACITY_KEY,
      String(value),
    );
  } catch {
    // The preview still updates when local storage is unavailable.
  }
  applyInterfaceBackgroundOpacity(value);
}

function applyInterfaceBackgroundOpacity(opacity: number) {
  document.documentElement.style.setProperty(
    "--atelier-sheet-opacity",
    `${opacity}%`,
  );
  document.documentElement.style.setProperty(
    "--atelier-reply-opacity",
    `${Math.max(20, opacity - 5)}%`,
  );
}

/** Old or malformed local preferences must never prevent the workspace opening. */
export function parseInterfaceAppearance(
  raw: string | null,
): InterfaceAppearance {
  try {
    const value: unknown = JSON.parse(raw || "null");
    if (!value || typeof value !== "object")
      return { ...DEFAULT_INTERFACE_APPEARANCE };
    const saved = value as Record<string, unknown>;
    return {
      mode:
        saved.mode === "full" || saved.mode === "soft" || saved.mode === "off"
          ? saved.mode
          : DEFAULT_INTERFACE_APPEARANCE.mode,
      intensity:
        typeof saved.intensity === "number" && Number.isFinite(saved.intensity)
          ? Math.round(Math.min(100, Math.max(0, saved.intensity)))
          : DEFAULT_INTERFACE_APPEARANCE.intensity,
      companionVisible:
        typeof saved.companionVisible === "boolean"
          ? saved.companionVisible
          : DEFAULT_INTERFACE_APPEARANCE.companionVisible,
    };
  } catch {
    return { ...DEFAULT_INTERFACE_APPEARANCE };
  }
}

export function readInterfaceAppearanceSnapshot(): string {
  if (memoryFallback !== null) return memoryFallback;
  try {
    return window.localStorage.getItem(INTERFACE_APPEARANCE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveInterfaceAppearance(updates: Partial<InterfaceAppearance>) {
  const current = parseInterfaceAppearance(readInterfaceAppearanceSnapshot());
  const next = parseInterfaceAppearance(
    JSON.stringify({ ...current, ...updates }),
  );
  const raw = JSON.stringify(next);
  try {
    window.localStorage.setItem(INTERFACE_APPEARANCE_KEY, raw);
    memoryFallback = null;
  } catch {
    // The visual controls continue working when storage is unavailable/full.
    memoryFallback = raw;
  }
  window.dispatchEvent(new Event(INTERFACE_APPEARANCE_EVENT));
}

export function subscribeInterfaceAppearance(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === INTERFACE_APPEARANCE_KEY || event.key === null) {
      memoryFallback = null;
      onChange();
    }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(INTERFACE_APPEARANCE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(INTERFACE_APPEARANCE_EVENT, onChange);
  };
}

export function applyInterfaceAppearance(appearance: InterfaceAppearance) {
  document.documentElement.dataset.decoration = appearance.mode;
  document.documentElement.style.setProperty(
    "--atelier-intensity",
    String(appearance.intensity / 100),
  );
  applyInterfaceBackgroundOpacity(readInterfaceBackgroundOpacity());
}
