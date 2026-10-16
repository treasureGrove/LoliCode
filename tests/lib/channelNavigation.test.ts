import { afterEach, describe, expect, it } from "vitest";
import {
  parseView,
  productViewOf,
  readStoredView,
  VIEW_STORAGE_KEY,
} from "@/lib/navigation";

afterEach(() => localStorage.removeItem(VIEW_STORAGE_KEY));

describe("LoliCode startup navigation", () => {
  it("starts from the coding workspace, including upgrades from resource pages", () => {
    expect(readStoredView()).toBe("agent");
    for (const view of [
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
    for (const view of [
      "providers",
      "workspace",
      "openclawConfig",
      "openclawTools",
    ]) {
      localStorage.setItem(VIEW_STORAGE_KEY, view);
      expect(readStoredView()).toBe("channels");
    }
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
  it("redirects internal legacy navigation without an empty product page", () => {
    for (const view of [
      "mcp",
      "skills",
      "skillsDiscovery",
      "prompts",
      "sessions",
      "hermesMemory",
    ] as const) {
      expect(productViewOf(view)).toBe("agent");
    }
    expect(productViewOf("providers")).toBe("channels");
    expect(productViewOf("apps")).toBe("apps");
  });
});
