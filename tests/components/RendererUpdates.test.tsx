import { StrictMode } from "react";
import { act, render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RendererUpdatesSection } from "@/components/settings/RendererUpdatesSection";
import { RendererBootHealth } from "@/components/shell/RendererBootHealth";
import { RendererRecoveryButton } from "@/components/shell/RendererRecoveryButton";
import {
  rendererUpdatesApi,
  type RendererStatus,
} from "@/lib/api/renderer-updates";
import { hasUnsavedChanges } from "@/lib/unsavedChanges";

vi.mock("@/lib/api/renderer-updates", () => ({
  rendererStatusKey: ["renderer-update-status"],
  rendererUpdatesApi: {
    local: vi.fn(),
    check: vi.fn(),
    install: vi.fn(),
    confirm: vi.fn(),
    rollback: vi.fn(),
    restart: vi.fn(),
  },
}));
vi.mock("@/lib/unsavedChanges", () => ({ hasUnsavedChanges: vi.fn() }));
vi.mock("@/lib/frontendLogger", () => ({ reportFrontendError: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const bundled: RendererStatus = {
  runningId: null,
  runningVersion: null,
  bootTicket: null,
  development: false,
  warning: null,
  state: {
    activeId: null,
    activeVersion: null,
    stagedVersion: null,
    restartRequired: false,
    pendingConfirmation: false,
    highestVersion: 0,
    canRollback: false,
  },
};
const staged: RendererStatus = {
  ...bundled,
  state: { ...bundled.state, stagedVersion: 2, restartRequired: true },
};
const booting: RendererStatus = {
  ...bundled,
  runningId: "pack-two",
  runningVersion: 2,
  bootTicket: "current-boot",
  state: {
    ...bundled.state,
    activeId: "pack-two",
    activeVersion: 2,
    pendingConfirmation: true,
    canRollback: true,
  },
};
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RendererUpdatesSection />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(rendererUpdatesApi.local).mockResolvedValue(bundled);
  vi.mocked(rendererUpdatesApi.check).mockResolvedValue(2);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("does not fetch remote updates on mount; download stages without restarting live work", async () => {
  mount();
  const user = userEvent.setup();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "rendererUpdates.check" }),
    ).toBeEnabled(),
  );
  expect(rendererUpdatesApi.check).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "rendererUpdates.check" }),
  );
  await screen.findByRole("button", { name: "rendererUpdates.install" });
  vi.mocked(rendererUpdatesApi.local).mockResolvedValue(staged);
  await user.click(
    screen.getByRole("button", { name: "rendererUpdates.install" }),
  );
  await screen.findByRole("button", { name: "rendererUpdates.restart" });
  expect(rendererUpdatesApi.install).toHaveBeenCalledOnce();
  expect(rendererUpdatesApi.restart).not.toHaveBeenCalled();
});
it("keeps staged updates when an editor is unsaved or the backend rejects a busy restart", async () => {
  vi.mocked(rendererUpdatesApi.local).mockResolvedValue(staged);
  mount();
  const user = userEvent.setup();
  const button = await screen.findByRole("button", {
    name: "rendererUpdates.restart",
  });
  vi.mocked(hasUnsavedChanges).mockReturnValue(true);
  await user.click(button);
  expect(rendererUpdatesApi.restart).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "rendererUpdates.unsaved",
  );
  vi.mocked(hasUnsavedChanges).mockReturnValue(false);
  vi.mocked(rendererUpdatesApi.restart).mockRejectedValue(
    "Agent task is still running",
  );
  await user.click(button);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "Agent task is still running",
    ),
  );
  expect(button).toBeEnabled();
});
it("confirms only after a normal application mount survives; StrictMode does not send duplicate receipts", async () => {
  vi.useFakeTimers();
  vi.mocked(rendererUpdatesApi.local).mockResolvedValue(booting);
  render(
    <StrictMode>
      <RendererBootHealth />
    </StrictMode>,
  );
  expect(rendererUpdatesApi.confirm).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
  expect(rendererUpdatesApi.confirm).toHaveBeenCalledOnce();
  expect(rendererUpdatesApi.confirm).toHaveBeenCalledWith(
    "pack-two",
    "current-boot",
  );
});
it("a failed/unmounted initial tree leaves boot rollback armed", async () => {
  vi.useFakeTimers();
  vi.mocked(rendererUpdatesApi.local).mockResolvedValue(booting);
  const view = render(<RendererBootHealth />);
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(rendererUpdatesApi.confirm).not.toHaveBeenCalled();
  expect(rendererUpdatesApi.local).not.toHaveBeenCalled();
});
it("a crash before health confirmation restarts into native automatic rollback", async () => {
  vi.mocked(rendererUpdatesApi.local).mockResolvedValue(booting);
  render(<RendererRecoveryButton />);
  await userEvent.click(
    await screen.findByRole("button", { name: "rendererUpdates.recover" }),
  );
  await waitFor(() =>
    expect(rendererUpdatesApi.restart).toHaveBeenCalledOnce(),
  );
  expect(rendererUpdatesApi.rollback).not.toHaveBeenCalled();
});
it("a later crash stages the previous confirmed interface before restart", async () => {
  vi.mocked(rendererUpdatesApi.local).mockResolvedValue({
    ...booting,
    state: { ...booting.state, pendingConfirmation: false },
  });
  render(<RendererRecoveryButton />);
  await userEvent.click(
    await screen.findByRole("button", { name: "rendererUpdates.recover" }),
  );
  await waitFor(() =>
    expect(rendererUpdatesApi.restart).toHaveBeenCalledOnce(),
  );
  expect(rendererUpdatesApi.rollback).toHaveBeenCalledWith("pack-two");
  expect(
    vi.mocked(rendererUpdatesApi.rollback).mock.invocationCallOrder[0],
  ).toBeLessThan(
    vi.mocked(rendererUpdatesApi.restart).mock.invocationCallOrder[0],
  );
});
it("recovery replaces a waiting update instead of booting another unverified interface", async () => {
  vi.mocked(rendererUpdatesApi.local).mockResolvedValue({
    ...booting,
    state: {
      ...booting.state,
      pendingConfirmation: false,
      restartRequired: true,
      stagedVersion: 3,
    },
  });
  render(<RendererRecoveryButton />);
  await userEvent.click(
    await screen.findByRole("button", { name: "rendererUpdates.recover" }),
  );
  await waitFor(() =>
    expect(rendererUpdatesApi.restart).toHaveBeenCalledOnce(),
  );
  expect(rendererUpdatesApi.rollback).toHaveBeenCalledWith("pack-two");
});
