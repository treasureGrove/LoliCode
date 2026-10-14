import { afterEach, describe, expect, it } from "vitest";
import { parseView, readStoredView, VIEW_STORAGE_KEY } from "@/lib/navigation";

afterEach(() => localStorage.removeItem(VIEW_STORAGE_KEY));

describe("Lolicode startup navigation", () => {
  it("starts from the coding workspace, including upgrades from resource pages", () => {
    expect(readStoredView()).toBe("agent");
    for (const view of [
      "providers",
      "mcp",
      "skills",
      "skillsDiscovery",
      "prompts",
      "sessions",
      "unknown",
    ]) {
      localStorage.setItem(VIEW_STORAGE_KEY, view);
      expect(readStoredView()).toBe("agent");
    }
    localStorage.setItem(VIEW_STORAGE_KEY, "auth");
    expect(readStoredView()).toBe("channels");
  });
  it("retains remembered core destinations and parses legacy views for internal callers", () => {
    for (const view of [
      "agent",
      "channels",
      "usage",
      "apps",
      "settings",
    ] as const) {
      localStorage.setItem(VIEW_STORAGE_KEY, view);
      expect(readStoredView()).toBe(view);
    }
    expect(parseView("providers")).toBe("providers");
    expect(parseView("openclawTools")).toBe("openclawConfig");
  });
});
