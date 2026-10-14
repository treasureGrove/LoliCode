import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate } from "@/lib/updater";

const mocks = vi.hoisted(() => ({ check: vi.fn(), version: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: mocks.version }));

beforeEach(() => {
  mocks.check.mockReset();
  mocks.version.mockReset().mockResolvedValue("4.0.12");
});
describe("native updater metadata", () => {
  it("treats only a null native update resource as up to date", async () => {
    mocks.check.mockResolvedValue(null);
    expect(await checkForUpdate()).toEqual({ status: "up-to-date" });
    expect(mocks.check).toHaveBeenCalledWith({ timeout: 30000 });
  });
  it("reads body and date from the real Update contract and releases the check resource", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.check.mockResolvedValue({
      currentVersion: "4.0.11",
      version: "4.0.13",
      body: "Release notes",
      date: "2026-10-14",
      available: false,
      notes: "Wrong legacy field",
      close,
    });
    expect(await checkForUpdate({ timeout: 5000 })).toEqual({
      status: "available",
      info: {
        currentVersion: "4.0.12",
        availableVersion: "4.0.13",
        notes: "Release notes",
        pubDate: "2026-10-14",
      },
    });
    expect(close).toHaveBeenCalledOnce();
  });
  it("uses the native resource current version when app version lookup fails", async () => {
    mocks.version.mockRejectedValue(new Error("Unavailable"));
    mocks.check.mockResolvedValue({
      currentVersion: "4.0.12",
      version: "4.0.13",
      close: vi.fn(),
    });
    expect(await checkForUpdate()).toMatchObject({
      status: "available",
      info: { currentVersion: "4.0.12" },
    });
  });
  it("rejects malformed metadata and still closes its resource", async () => {
    const close = vi.fn();
    mocks.check.mockResolvedValue({ version: "", close });
    await expect(checkForUpdate()).rejects.toThrow("有效版本号");
    expect(close).toHaveBeenCalledOnce();
  });
  it("propagates a check failure so it cannot be reported as latest", async () => {
    mocks.check.mockRejectedValue(new Error("HTTP 503"));
    await expect(checkForUpdate()).rejects.toThrow("HTTP 503");
  });
});
