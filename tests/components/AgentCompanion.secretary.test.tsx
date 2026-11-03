import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCompanion } from "@/features/agent/AgentCompanion";
import {
  useSecretaryActivity,
  type SecretaryActivity,
} from "@/hooks/useSecretaryActivity";
import {
  COMPANION_STORAGE_KEY,
  readCompanionState,
  saveCompanionState,
} from "@/lib/companion";
import {
  DEFAULT_INTERFACE_APPEARANCE,
  saveInterfaceAppearance,
} from "@/lib/interfaceAppearance";

vi.mock("@/hooks/useSecretaryActivity", () => ({
  useSecretaryActivity: vi.fn(),
}));
const status = vi.mocked(useSecretaryActivity);
const target = {
  sessionId: "chief",
  projectPath: "D:/work/project",
  workerSessionId: "worker",
};
const activity = (
  patch: Partial<SecretaryActivity> = {},
): SecretaryActivity => ({
  phase: "working",
  running: 1,
  queued: 0,
  attention: 0,
  target,
  ...patch,
});
beforeEach(() => {
  vi.useFakeTimers();
  status.mockReset().mockReturnValue(activity());
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  localStorage.removeItem(COMPANION_STORAGE_KEY);
  saveInterfaceAppearance({
    ...DEFAULT_INTERFACE_APPEARANCE,
    companionVisible: true,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.removeItem(COMPANION_STORAGE_KEY);
  saveInterfaceAppearance(DEFAULT_INTERFACE_APPEARANCE);
});

describe("companion secretary interaction", () => {
  it("opens the real pending worker without changing pet care state", () => {
    status.mockReturnValue(
      activity({ phase: "waiting_permission", running: 0, attention: 1 }),
    );
    const open = vi.fn();
    const care = readCompanionState();
    const view = render(<AgentCompanion onOpenSecretary={open} />);
    expect(view.container.querySelector(".lc-pet")).toHaveAttribute(
      "data-work-state",
      "waiting_permission",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "查看秘书待办",
      }),
    );
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(target);
    expect(readCompanionState().feedCount).toBe(care.feedCount);
    expect(readCompanionState().affection).toBe(care.affection);
  });
  it("displays a real background work state after the greeting finishes", async () => {
    const view = render(<AgentCompanion onOpenSecretary={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4600);
    });
    expect(view.container.querySelector(".lc-pet-bubble")).toHaveTextContent(
      "正在跟进",
    );
    expect(view.container.querySelector(".lc-pet-bubble")).toHaveAttribute(
      "data-speaking",
      "true",
    );
  });
  it("keeps sleep quiet while retaining the user-controlled secretary shortcut", async () => {
    saveCompanionState({ ...readCompanionState(), sleeping: true });
    const open = vi.fn();
    const view = render(<AgentCompanion onOpenSecretary={open} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4600);
    });
    expect(view.container.querySelector(".lc-pet")).toHaveAttribute(
      "data-sleeping",
      "true",
    );
    expect(
      view.container.querySelector(".lc-pet-bubble"),
    ).not.toHaveTextContent("正在跟进");
    fireEvent.click(screen.getByRole("button", { name: "打开 Loli 秘书" }));
    expect(open).toHaveBeenCalledWith(target);
    expect(readCompanionState().sleeping).toBe(true);
  });
  it("stops status observation when the companion is hidden without cancelling tasks", () => {
    saveInterfaceAppearance({ companionVisible: false });
    const open = vi.fn();
    const view = render(<AgentCompanion onOpenSecretary={open} />);
    expect(view.container).toBeEmptyDOMElement();
    expect(status).toHaveBeenLastCalledWith(false);
    expect(open).not.toHaveBeenCalled();
  });
  it("keeps an unknown connection distinct from completed work", () => {
    status.mockReturnValue(
      activity({ phase: "unknown", running: 0, target: undefined }),
    );
    const open = vi.fn();
    render(<AgentCompanion onOpenSecretary={open} />);
    const shortcut = screen.getByRole("button", {
      name: "打开 Loli 秘书",
    });
    expect(shortcut).toHaveAttribute("title", "工作状态暂未确认");
    fireEvent.click(shortcut);
    expect(open).toHaveBeenCalledWith(undefined);
  });
});
