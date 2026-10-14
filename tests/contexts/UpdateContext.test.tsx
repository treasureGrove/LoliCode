import { act, renderHook } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { UpdateProvider, useUpdate } from "@/contexts/UpdateContext";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  install: vi.fn(),
  settings: {
    isSuccess: true,
    data: { checkUpdates: false } as { checkUpdates?: boolean },
  },
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  stops: [] as ReturnType<typeof vi.fn>[],
  listen: vi.fn(),
}));
vi.mock("@/lib/updater", () => ({ checkForUpdate: mocks.check }));
vi.mock("@/lib/api", () => ({
  settingsApi: { installUpdateAndRestart: mocks.install },
}));
vi.mock("@/lib/query/queries", () => ({
  useSettingsQuery: () => mocks.settings,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

const info = {
  currentVersion: "4.0.12",
  availableVersion: "4.0.13",
  notes: "Signed release",
};
function mount() {
  return renderHook(() => useUpdate(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <UpdateProvider>{children}</UpdateProvider>
    ),
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
function emit(name: string, payload: unknown) {
  act(() => mocks.listeners.get(name)?.({ payload }));
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mocks.check.mockReset().mockResolvedValue({ status: "available", info });
  mocks.install.mockReset().mockResolvedValue(false);
  mocks.settings = { isSuccess: true, data: { checkUpdates: false } };
  mocks.listeners.clear();
  mocks.stops.length = 0;
  mocks.listen
    .mockReset()
    .mockImplementation(
      async (name: string, callback: (event: { payload: unknown }) => void) => {
        mocks.listeners.set(name, callback);
        const stop = vi.fn(() => {
          if (mocks.listeners.get(name) === callback)
            mocks.listeners.delete(name);
        });
        mocks.stops.push(stop);
        return stop;
      },
    );
});
afterEach(() => {
  vi.useRealTimers();
});

describe("application update lifecycle", () => {
  it("waits for saved preferences and never overrides an explicit disabled check", async () => {
    mocks.settings.isSuccess = false;
    const hook = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocks.check).not.toHaveBeenCalled();
    mocks.settings.isSuccess = true;
    hook.rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("defaults to one startup check, displays the update, and does not install", async () => {
    mocks.settings.data = {};
    const hook = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(hook.result.current.hasUpdate).toBe(true);
    expect(mocks.install).not.toHaveBeenCalled();
    hook.rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.check).toHaveBeenCalledOnce();
  });

  it("joins concurrent checks instead of claiming the application is up to date", async () => {
    const response = deferred<{ status: "available"; info: typeof info }>();
    mocks.check.mockReturnValue(response.promise);
    const hook = mount();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = hook.result.current.checkUpdate();
      second = hook.result.current.checkUpdate();
    });
    expect(second).toBe(first);
    await flush();
    expect(mocks.check).toHaveBeenCalledOnce();
    await act(async () => {
      response.resolve({ status: "available", info });
      expect(await first).toBe(true);
    });
  });

  it("checks every six hours while enabled and stops when the preference is disabled", async () => {
    mocks.settings.data = { checkUpdates: true };
    const hook = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.check).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    });
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.install).not.toHaveBeenCalled();
    mocks.settings.data.checkUpdates = false;
    hook.rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    });
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it("keeps a discovered version when a later check fails", async () => {
    const hook = mount();
    await act(async () => {
      await hook.result.current.checkUpdate();
    });
    mocks.check.mockRejectedValue(new Error("Feed unavailable"));
    await act(async () => {
      await expect(hook.result.current.checkUpdate()).rejects.toThrow(
        "Feed unavailable",
      );
    });
    expect(hook.result.current.updateInfo).toEqual(info);
    expect(hook.result.current.hasUpdate).toBe(true);
    expect(hook.result.current.phase).toBe("error");
  });

  it("registers progress before installation and joins rapid install clicks", async () => {
    const response = deferred<boolean>();
    mocks.install.mockImplementation(() => {
      expect(mocks.listeners.size).toBe(2);
      return response.promise;
    });
    const hook = mount();
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = hook.result.current.installUpdate();
      second = hook.result.current.installUpdate();
    });
    expect(second).toBe(first);
    await flush();
    expect(mocks.install).toHaveBeenCalledOnce();
    await expect(hook.result.current.checkUpdate()).rejects.toThrow(
      "更新正在进行",
    );
    emit("update-download-progress", { downloaded: 50, total: 100 });
    expect(hook.result.current.progress).toEqual({
      downloaded: 50,
      total: 100,
    });
    expect(hook.result.current.phase).toBe("downloading");
    emit("app-update-progress", { phase: "verifying" });
    expect(hook.result.current.phase).toBe("verifying");
    await act(async () => {
      response.resolve(true);
      expect(await first).toBe(true);
    });
    expect(hook.result.current.phase).toBe("installing");
    expect(hook.result.current.isInstalling).toBe(true);
    expect(hook.result.current.installUpdate()).toBe(first);
    expect(mocks.install).toHaveBeenCalledOnce();
    expect(mocks.stops.every((stop) => stop.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("treats false only as no update and clears the available badge", async () => {
    const hook = mount();
    await act(async () => {
      await hook.result.current.checkUpdate();
    });
    await act(async () => {
      expect(await hook.result.current.installUpdate()).toBe(false);
    });
    expect(hook.result.current.hasUpdate).toBe(false);
    expect(hook.result.current.updateInfo).toBeNull();
    expect(hook.result.current.phase).toBe("up_to_date");
    expect(hook.result.current.isInstalling).toBe(false);
  });

  it("preserves the available version on busy or signature errors and allows retry", async () => {
    const hook = mount();
    await act(async () => {
      await hook.result.current.checkUpdate();
    });
    mocks.install.mockRejectedValueOnce(
      new Error("仍有编程任务或授权/提问等待处理"),
    );
    await act(async () => {
      await expect(hook.result.current.installUpdate()).rejects.toThrow(
        "仍有编程任务",
      );
    });
    expect(hook.result.current.isInstalling).toBe(false);
    expect(hook.result.current.hasUpdate).toBe(true);
    expect(hook.result.current.error).toContain("仍有编程任务");
    mocks.install.mockRejectedValueOnce(
      new Error("Signature verification failed"),
    );
    await act(async () => {
      await expect(hook.result.current.installUpdate()).rejects.toThrow(
        "Signature",
      );
    });
    expect(hook.result.current.error).toContain("Signature");
    await act(async () => {
      expect(await hook.result.current.installUpdate()).toBe(false);
    });
    expect(mocks.install).toHaveBeenCalledTimes(3);
  });

  it("rejects an invalid install acknowledgement instead of displaying latest", async () => {
    mocks.install.mockResolvedValue(undefined);
    const hook = mount();
    await act(async () => {
      await expect(hook.result.current.installUpdate()).rejects.toThrow(
        "有效结果",
      );
    });
    expect(hook.result.current.phase).toBe("error");
    expect(hook.result.current.isInstalling).toBe(false);
  });

  it("ignores stale progress callbacks after a failed attempt and cleans listeners", async () => {
    const hook = mount();
    let stale!: (event: { payload: unknown }) => void;
    mocks.install.mockImplementationOnce(() => {
      stale = mocks.listeners.get("update-download-progress")!;
      return Promise.reject(new Error("Failed"));
    });
    await act(async () => {
      await hook.result.current.installUpdate().catch(() => {});
    });
    act(() => stale({ payload: { downloaded: 100, total: 100 } }));
    expect(hook.result.current.progress).toBeNull();
    expect(hook.result.current.phase).toBe("error");
    expect(mocks.listeners.size).toBe(0);
    expect(mocks.stops.every((stop) => stop.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it("uses indeterminate progress when total size is unknown and rejects invalid events", async () => {
    const response = deferred<boolean>();
    mocks.install.mockReturnValue(response.promise);
    const hook = mount();
    let task!: Promise<boolean>;
    act(() => {
      task = hook.result.current.installUpdate();
    });
    await flush();
    emit("update-download-progress", { downloaded: 42, total: null });
    expect(hook.result.current.progress).toEqual({
      downloaded: 42,
      total: null,
    });
    emit("update-download-progress", { downloaded: -1, total: 100 });
    emit("app-update-progress", { phase: "fictional" });
    expect(hook.result.current.phase).toBe("downloading");
    expect(hook.result.current.progress?.downloaded).toBe(42);
    hook.unmount();
    expect(mocks.listeners.size).toBe(0);
    response.resolve(false);
    await task;
    expect(mocks.stops.every((stop) => stop.mock.calls.length === 1)).toBe(
      true,
    );
  });
});
