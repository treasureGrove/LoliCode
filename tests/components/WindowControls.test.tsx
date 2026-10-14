import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowControls } from "@/components/shell/WindowControls";

const mocks = vi.hoisted(() => ({
  isMaximized: vi.fn(),
  onResized: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  unlisten: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => mocks }));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.error } }));
vi.mock("@/components/ui/hover-tip", () => ({
  HoverTip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { error: string }) =>
      ({
        "header.windowMinimize": "最小化窗口",
        "header.windowMaximize": "最大化窗口",
        "header.windowRestore": "还原窗口",
        "header.windowClose": "关闭窗口",
        "notifications.windowControlFailed": `窗口控制失败：${options?.error || ""}`,
      })[key] || key,
  }),
}));
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.isMaximized.mockResolvedValue(false);
  mocks.onResized.mockResolvedValue(mocks.unlisten);
  mocks.minimize.mockResolvedValue(undefined);
  mocks.toggleMaximize.mockResolvedValue(undefined);
  mocks.close.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("WindowControls", () => {
  it("exposes distinct accessible native window actions and follows native close preferences", async () => {
    render(<WindowControls />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "最小化窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
    await flush();
    expect(mocks.minimize).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "关闭弹窗" }),
    ).not.toBeInTheDocument();
    mocks.isMaximized.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: "最大化窗口" }));
    await flush();
    expect(mocks.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "还原窗口" }),
    ).toBeInTheDocument();
  });

  it("reports a native close failure without pretending the window closed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.close.mockRejectedValue(new Error("关闭失败"));
    render(<WindowControls />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "关闭窗口" }));
    await flush();
    expect(mocks.error).toHaveBeenCalledWith("窗口控制失败：关闭失败");
    expect(screen.getByRole("button", { name: "关闭窗口" })).toBeEnabled();
    log.mockRestore();
  });

  it("does not register resize listeners when the modal clone unmounts during initial native sync", async () => {
    let finish: (value: boolean) => void = () => {};
    mocks.isMaximized.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<WindowControls />);
    view.unmount();
    await act(async () => finish(false));
    await flush();
    expect(mocks.onResized).not.toHaveBeenCalled();
  });

  it("releases a listener that arrives after the modal clone was already unmounted", async () => {
    let finish: (unlisten: () => void) => void = () => {};
    mocks.onResized.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<WindowControls />);
    await flush();
    expect(mocks.onResized).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => finish(mocks.unlisten));
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });

  it("releases a ready resize listener when the modal clone closes", async () => {
    const view = render(<WindowControls />);
    await flush();
    view.unmount();
    expect(mocks.unlisten).toHaveBeenCalledTimes(1);
  });
});
