import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBuildChannel } from "@/lib/buildChannel";

const nativeCheck = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-updater", () => ({ check: nativeCheck }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  nativeCheck.mockReset();
});

describe("application build channels", () => {
  it("keeps packaged development builds separate even with Vite production mode", () => {
    expect(
      resolveBuildChannel({
        channel: "development",
        dev: false,
        mode: "production",
      }),
    ).toBe("development");
  });

  it("recognizes the live development server and ordinary stable packages", () => {
    expect(resolveBuildChannel({ dev: true, mode: "development" })).toBe(
      "development",
    );
    expect(resolveBuildChannel({ dev: false, mode: "production" })).toBe(
      "stable",
    );
    expect(
      resolveBuildChannel({ channel: "stable", dev: true, mode: "test" }),
    ).toBe("stable");
  });

  it("never contacts the native stable updater from a development build", async () => {
    vi.stubEnv("VITE_LOLICODE_BUILD_CHANNEL", "development");
    vi.stubEnv("VITE_LOLICODE_BUILD_REVISION", "abc1234+dirty");
    vi.stubEnv("VITE_LOLICODE_BUILD_NUMBER", " DEV-20261028-174243 ");
    vi.stubEnv("VITE_LOLICODE_BUILD_BRANCH", " TG/freehub-m0 ");
    vi.stubEnv("VITE_LOLICODE_BUILD_TIMESTAMP", " 2026-10-28T09:42:43.000Z ");
    vi.stubEnv("VITE_LOLICODE_BUILD_DIRTY", "true");
    const branding = await import("@/lib/branding");
    const channel = await import("@/lib/buildChannel");
    const { checkForUpdate } = await import("@/lib/updater");
    expect(branding.APP_NAME).toBe("LoliCode 开发版");
    expect(branding.APP_UPDATES_ENABLED).toBe(false);
    expect(branding.APP_WINDOW_TITLE).toBe(
      "LoliCode 开发版 · DEV-20261028-174243",
    );
    expect(channel.BUILD_NUMBER).toBe("DEV-20261028-174243");
    expect(channel.BUILD_REVISION).toBe("abc1234+dirty");
    expect(channel.BUILD_BRANCH).toBe("TG/freehub-m0");
    expect(channel.BUILD_TIMESTAMP).toBe("2026-10-28T09:42:43.000Z");
    expect(channel.BUILD_DIRTY).toBe(true);
    await expect(checkForUpdate()).rejects.toThrow("本地构建");
    expect(nativeCheck).not.toHaveBeenCalled();
  });

  it("keeps development numbers out of the stable window title", async () => {
    vi.stubEnv("VITE_LOLICODE_BUILD_CHANNEL", "stable");
    vi.stubEnv("VITE_LOLICODE_BUILD_NUMBER", "DEV-20261028-174243");
    const branding = await import("@/lib/branding");
    expect(branding.APP_WINDOW_TITLE).toBe("LoliCode");
  });
});
