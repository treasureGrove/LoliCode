export type DecorationMode = "full" | "soft" | "off";

export interface InterfaceAppearance {
  mode: DecorationMode;
  intensity: number;
  companionVisible: boolean;
}

export const INTERFACE_APPEARANCE_KEY = "lolicode.interface-appearance.v1";
export const INTERFACE_APPEARANCE_EVENT = "lolicode:interface-appearance";
export const DEFAULT_INTERFACE_APPEARANCE: InterfaceAppearance = {
  mode: "full",
  intensity: 48,
  companionVisible: true,
};

let memoryFallback: string | null = null;

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
}
