import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DevelopmentFrontendRefreshButton } from "@/components/shell/DevelopmentFrontendRefreshButton";
import {
  developmentFrontendNavigation,
  rebuildDevelopmentFrontend,
} from "@/lib/developmentFrontend";
import {
  discardUnsavedChanges,
  hasUnsavedChanges,
  useUnsavedChangesTracker,
} from "@/lib/unsavedChanges";

const mocks = vi.hoisted(() => ({
  development: true,
  invoke: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/lib/buildChannel", () => ({
  get IS_DEVELOPMENT_BUILD() {
    return mocks.development;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.error } }));

function Editor() {
  return (
    <div {...useUnsavedChangesTracker()}>
      <input aria-label="draft" />
    </div>
  );
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const unloadListeners: Array<(event: BeforeUnloadEvent) => void> = [];
function registerEditorUnloadGuard() {
  const guard = vi.fn((event: BeforeUnloadEvent) => event.preventDefault());
  window.addEventListener("beforeunload", guard);
  unloadListeners.push(guard);
  return guard;
}

function dispatchBeforeUnload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("development frontend refresh", () => {
  beforeEach(() => {
    mocks.development = true;
    mocks.invoke.mockReset();
    mocks.error.mockReset();
    vi.spyOn(developmentFrontendNavigation, "reload").mockImplementation(() => {
      dispatchBeforeUnload();
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => {
    discardUnsavedChanges();
    for (const listener of unloadListeners)
      window.removeEventListener("beforeunload", listener);
    unloadListeners.length = 0;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("builds once, disables all entries, then reloads only after native success", async () => {
    const build = deferred();
    mocks.invoke.mockReturnValue(build.promise);
    render(
      <>
        <DevelopmentFrontendRefreshButton />
        <DevelopmentFrontendRefreshButton />
      </>,
    );
    const buttons = screen.getAllByRole("button", { name: "热更新界面" });
    fireEvent.click(buttons[0]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("rebuild_development_frontend");
    for (const button of buttons) expect(button).toBeDisabled();
    expect(developmentFrontendNavigation.reload).not.toHaveBeenCalled();
    fireEvent.click(buttons[1]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    build.resolve({ developmentBuildNumber: "DEV-new" });
    await waitFor(() =>
      expect(developmentFrontendNavigation.reload).toHaveBeenCalledOnce(),
    );
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("keeps the current interface after a build failure and permits retry", async () => {
    mocks.invoke.mockRejectedValue(new Error("Vite compile failed"));
    render(<DevelopmentFrontendRefreshButton />);
    fireEvent.click(screen.getByRole("button", { name: "热更新界面" }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "界面热更新失败：Vite compile failed",
      ),
    );
    expect(developmentFrontendNavigation.reload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "热更新界面" })).toBeEnabled();
  });

  it("protects drafts edited during compilation when the user cancels reload", async () => {
    const build = deferred();
    mocks.invoke.mockReturnValue(build.promise);
    vi.mocked(window.confirm).mockReturnValue(false);
    const unloadGuard = registerEditorUnloadGuard();
    render(
      <>
        <Editor />
        <DevelopmentFrontendRefreshButton />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "热更新界面" }));
    fireEvent.input(screen.getByRole("textbox", { name: "draft" }), {
      target: { value: "new draft" },
    });
    expect(hasUnsavedChanges()).toBe(true);
    build.resolve({});
    await waitFor(() => expect(window.confirm).toHaveBeenCalledOnce());
    expect(developmentFrontendNavigation.reload).not.toHaveBeenCalled();
    expect(hasUnsavedChanges()).toBe(true);
    expect(screen.getByRole("textbox", { name: "draft" })).toHaveValue(
      "new draft",
    );
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
    expect(unloadGuard).toHaveBeenCalledOnce();
  });

  it("reloads an unsaved editor only after explicit confirmation", async () => {
    mocks.invoke.mockResolvedValue({});
    const unloadGuard = registerEditorUnloadGuard();
    render(
      <>
        <Editor />
        <DevelopmentFrontendRefreshButton />
      </>,
    );
    fireEvent.input(screen.getByRole("textbox", { name: "draft" }), {
      target: { value: "draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "热更新界面" }));
    await waitFor(() =>
      expect(developmentFrontendNavigation.reload).toHaveBeenCalledOnce(),
    );
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("刷新会丢弃这些修改"),
    );
    expect(unloadGuard).not.toHaveBeenCalled();
    expect(hasUnsavedChanges()).toBe(true);
    // Approval is consumed once: future navigation still uses the editor guard.
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
    expect(unloadGuard).toHaveBeenCalledOnce();
  });

  it("retains unload protection when reload throws", async () => {
    mocks.invoke.mockResolvedValue({});
    vi.mocked(developmentFrontendNavigation.reload).mockImplementation(() => {
      throw new Error("Reload unavailable");
    });
    const unloadGuard = registerEditorUnloadGuard();
    render(
      <>
        <Editor />
        <DevelopmentFrontendRefreshButton />
      </>,
    );
    fireEvent.input(screen.getByRole("textbox", { name: "draft" }), {
      target: { value: "draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "热更新界面" }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(
        "界面热更新失败：Reload unavailable",
      ),
    );
    expect(hasUnsavedChanges()).toBe(true);
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
    expect(unloadGuard).toHaveBeenCalledOnce();
  });

  it("expires unused reload approval when navigation does not start", async () => {
    vi.useFakeTimers();
    mocks.invoke.mockResolvedValue({});
    vi.mocked(developmentFrontendNavigation.reload).mockImplementation(
      () => undefined,
    );
    const unloadGuard = registerEditorUnloadGuard();
    render(<Editor />);
    fireEvent.input(screen.getByRole("textbox", { name: "draft" }), {
      target: { value: "draft" },
    });
    await act(async () => {
      await rebuildDevelopmentFrontend(() => true);
    });
    vi.advanceTimersByTime(5000);
    expect(hasUnsavedChanges()).toBe(true);
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
    expect(unloadGuard).toHaveBeenCalledOnce();
  });

  it("preserves the editor unload guard after a build failure", async () => {
    mocks.invoke.mockRejectedValue(new Error("Build failed"));
    const unloadGuard = registerEditorUnloadGuard();
    render(
      <>
        <Editor />
        <DevelopmentFrontendRefreshButton />
      </>,
    );
    fireEvent.input(screen.getByRole("textbox", { name: "draft" }), {
      target: { value: "draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "热更新界面" }));
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("界面热更新失败：Build failed"),
    );
    expect(hasUnsavedChanges()).toBe(true);
    expect(dispatchBeforeUnload().defaultPrevented).toBe(true);
    expect(unloadGuard).toHaveBeenCalledOnce();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(developmentFrontendNavigation.reload).not.toHaveBeenCalled();
  });

  it("hides and rejects the development action in stable builds", async () => {
    mocks.development = false;
    render(<DevelopmentFrontendRefreshButton />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await expect(rebuildDevelopmentFrontend(() => true)).rejects.toThrow(
      "仅用于开发版",
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(developmentFrontendNavigation.reload).not.toHaveBeenCalled();
  });
});
