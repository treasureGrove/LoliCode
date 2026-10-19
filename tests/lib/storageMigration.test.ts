import { beforeEach, describe, expect, it, vi } from "vitest";
import { readMigratedStorage } from "@/lib/storageMigration";
import { readLocalCache, writeLocalCache } from "@/lib/localCache";

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});
describe("LoliCode preference migration", () => {
  it("keeps saved themes and skill targets while adopting the new keys", () => {
    localStorage.setItem("cc-switch-theme", "dark");
    localStorage.setItem("cc-switch:skills:install-to", '["codex","claude"]');
    expect(readMigratedStorage("lolicode-theme", ["cc-switch-theme"])).toBe(
      "dark",
    );
    expect(
      readMigratedStorage("lolicode:skills:install-to", [
        "cc-switch:skills:install-to",
      ]),
    ).toBe('["codex","claude"]');
    expect(localStorage.getItem("lolicode-theme")).toBe("dark");
    expect(localStorage.getItem("cc-switch-theme")).toBe("dark");
    localStorage.setItem("lolicode-theme", "light");
    expect(readMigratedStorage("lolicode-theme", ["cc-switch-theme"])).toBe(
      "light",
    );
  });
  it("keeps the original preference usable if migration cannot write", () => {
    localStorage.setItem("cc-switch-theme", "dark");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(readMigratedStorage("lolicode-theme", ["cc-switch-theme"])).toBe(
      "dark",
    );
  });
  it("reads old cache data and writes future values under the new prefix", () => {
    localStorage.setItem("cc-switch-cache:usage", '{"requests":7}');
    expect(readLocalCache("usage")).toEqual({ requests: 7 });
    writeLocalCache("usage", { requests: 8 });
    expect(readLocalCache("usage")).toEqual({ requests: 8 });
    expect(localStorage.getItem("cc-switch-cache:usage")).toBe(
      '{"requests":7}',
    );
  });
});
