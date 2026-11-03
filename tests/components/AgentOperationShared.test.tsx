import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAgentOperation,
  useAgentResource,
} from "@/features/agent/AgentOperationShared";

const flush = () =>
  act(async () => {
    for (let index = 0; index < 10; index++) await Promise.resolve();
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useAgentResource", () => {
  it("clears loading when a pending resource is disabled", async () => {
    const view = renderHook(
      ({ name }) =>
        useAgentResource(name, () => new Promise<string>(() => {}), 0),
      {
        initialProps: { name: "idle-status" },
      },
    );
    await flush();
    expect(view.result.current.loading).toBe(true);
    view.rerender({ name: "" });
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.error).toBeNull();
  });

  it("does not show an old project's error while a new resource loads", async () => {
    const view = renderHook(
      ({ name }) =>
        useAgentResource(
          name,
          () =>
            name === "old"
              ? Promise.reject(new Error("old error"))
              : new Promise<string>(() => {}),
          0,
        ),
      {
        initialProps: { name: "old" },
      },
    );
    await flush();
    expect(view.result.current.error).toBe("old error");
    view.rerender({ name: "new" });
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.loading).toBe(true);
  });

  it("ends a hung read with a useful error and allows an explicit retry", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue("ready");
    const view = renderHook(() => useAgentResource("automations", load, 0));
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.error).toMatch(/超时/);
    act(() => view.result.current.reload());
    await flush();
    expect(view.result.current.data).toBe("ready");
    expect(view.result.current.error).toBeNull();
  });

  it("does not accumulate polling calls when an IPC read never settles", async () => {
    const load = vi.fn(() => new Promise<string>(() => {}));
    const view = renderHook(() => useAgentResource("hung-poll", load));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(view.result.current.error).toMatch(/超时/);
    expect(load).toHaveBeenCalledOnce();
  });
});

describe("useAgentOperation", () => {
  it("restores reads after a stalled write without unlocking duplicate mutations or unrelated scopes", async () => {
    let finish!: () => void;
    const request = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const writer = renderHook(() => useAgentOperation("hung-write"));
    act(() => {
      void writer.result.current.run(() => request);
    });
    const load = vi.fn().mockResolvedValue("fresh list");
    const reader = renderHook(() =>
      useAgentResource("list-during-write", load, 0, false, "hung-write"),
    );
    try {
      expect(writer.result.current.busy).toBe(true);
      expect(load).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(30_001));
      expect(writer.result.current.error).toMatch(/长时间未响应/);
      expect(writer.result.current.busy).toBe(true);
      expect(reader.result.current.data).toBe("fresh list");
      const duplicate = vi.fn().mockResolvedValue(undefined);
      await act(async () => {
        await writer.result.current.run(duplicate);
      });
      expect(duplicate).not.toHaveBeenCalled();
      const other = renderHook(() => useAgentOperation("other-write"));
      expect(other.result.current.busy).toBe(false);
      await act(async () => {
        expect(await other.result.current.run(duplicate)).toBe(true);
      });
      expect(duplicate).toHaveBeenCalledOnce();
      writer.unmount();
      const reopened = renderHook(() => useAgentOperation("hung-write"));
      expect(reopened.result.current.busy).toBe(true);
      expect(reopened.result.current.error).toMatch(/长时间未响应/);
      await act(async () => {
        finish();
        await request;
      });
      expect(reopened.result.current.busy).toBe(false);
      expect(reopened.result.current.error).toBeNull();
    } finally {
      await act(async () => {
        finish();
        await request;
      });
    }
  });
});
