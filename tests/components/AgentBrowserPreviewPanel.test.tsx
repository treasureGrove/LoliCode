import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AgentBrowserPreviewPanel } from "@/features/agent/AgentBrowserPreviewPanel";
import { agentFilesApi } from "@/lib/api/agent-files";
import { settingsApi } from "@/lib/api/settings";
import { emitTauriEvent } from "../msw/tauriMocks";

vi.mock("@/lib/platform", () => ({ isWindows: () => true }));
vi.mock("@/lib/api/agent-files", () => ({
  agentFilesApi: {
    browserFrame: vi.fn(),
    syncBrowserWebview: vi.fn(),
    navigateBrowser: vi.fn(),
  },
}));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { openExternal: vi.fn() },
}));

const sessionId = "lc:worker";
const bounds = { x: 100, y: 80, width: 300, height: 260 };
const close = vi.fn();

beforeEach(() => {
  vi.mocked(agentFilesApi.syncBrowserWebview).mockReset().mockResolvedValue();
  vi.mocked(agentFilesApi.navigateBrowser).mockReset().mockResolvedValue();
  vi.mocked(agentFilesApi.browserFrame).mockReset();
  vi.mocked(settingsApi.openExternal).mockReset().mockResolvedValue();
});

it("never falls back to screenshots for a stale Windows browser tool receipt", () => {
  render(
    <AgentBrowserPreviewPanel
      sessionId={sessionId}
      browserId="legacy-browser"
      url="http://127.0.0.1:1234/"
      width={340}
      toolPage
      onClose={close}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("请让 Agent 重新打开");
  expect(screen.queryByRole("button", { name: "刷新页面画面" })).toBeNull();
  expect(agentFilesApi.browserFrame).not.toHaveBeenCalled();
});

it.each([
  {
    source: "delivered page",
    toolPage: false,
    browserId: "00112233445566778899aabbccddeeff",
    url: "http://127.0.0.1:1234/__lolicode_preview/00112233445566778899aabbccddeeff/index.html",
  },
  {
    source: "independent browser tool",
    toolPage: true,
    browserId: "browser-tool-1",
    url: "https://example.test/page",
  },
])(
  "keeps the live $source mounted when a dialog or fold hides it",
  async ({ browserId, toolPage, url }) => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        ...bounds,
        left: bounds.x,
        top: bounds.y,
        right: bounds.x + bounds.width,
        bottom: bounds.y + bounds.height,
        toJSON: () => bounds,
      });
    const panel = (visible: boolean, dialog = false) => (
      <>
        <div className="wb-chat" />
        <AgentBrowserPreviewPanel
          sessionId={sessionId}
          browserId={browserId}
          url={url}
          native
          toolPage={toolPage}
          width={340}
          visible={visible}
          onClose={close}
        />
        {dialog && <div role="dialog" aria-modal="true" />}
      </>
    );
    try {
      const { container, rerender } = render(panel(true));
      const sync = vi.mocked(agentFilesApi.syncBrowserWebview);
      const presentation = expect.objectContaining({ slot: 0, revision: expect.any(Number) });
      await waitFor(() =>
        expect(sync).toHaveBeenLastCalledWith(
          sessionId,
          browserId,
          bounds,
          false,
          presentation,
        ),
      );
      const stage = document.querySelector("[data-preview-carrier='native']");
      await waitFor(() =>
        expect(stage).toHaveAttribute("data-native-ready", "true"),
      );
      expect(agentFilesApi.browserFrame).not.toHaveBeenCalled();
      const external = screen.queryByRole("button", {
        name: "在系统浏览器中打开",
      });
      if (toolPage) {
        const address = screen.getByRole("textbox", { name: "网页地址" });
        const back = screen.getByRole("button", { name: "后退" });
        const forward = screen.getByRole("button", { name: "前进" });
        const currentUrl = new URL("/details", url).href;
        const state = {
          sessionId,
          browserId,
          url: currentUrl,
          title: "测试网页",
          loading: true,
          canGoBack: true,
          canGoForward: false,
        };
        const updateState = (payload: typeof state) =>
          act(() => emitTauriEvent("agent-browser-preview-state", payload));
        expect(address).toHaveValue(url);
        expect(address).toHaveAttribute("readonly");
        expect(back).toBeDisabled();
        expect(forward).toBeDisabled();
        updateState({ ...state, browserId: "another-tab" });
        expect(address).toHaveValue(url);
        updateState(state);
        expect(address).toHaveValue(currentUrl);
        expect(screen.getByText("测试网页")).toBeVisible();
        expect(stage).toHaveAttribute("aria-busy", "true");
        fireEvent.click(back);
        expect(agentFilesApi.navigateBrowser).toHaveBeenCalledWith(
          sessionId,
          browserId,
          "back",
        );
        updateState({
          ...state,
          loading: false,
          canGoBack: false,
          canGoForward: true,
        });
        expect(back).toBeDisabled();
        expect(stage).toHaveAttribute("aria-busy", "false");
        fireEvent.click(forward);
        expect(agentFilesApi.navigateBrowser).toHaveBeenCalledWith(
          sessionId,
          browserId,
          "forward",
        );
        expect(external).toBeEnabled();
        fireEvent.click(external!);
        expect(settingsApi.openExternal).toHaveBeenCalledWith(currentUrl);
      } else {
        expect(external).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "后退" })).toBeNull();
      }

      const nextFrame = () => new Promise(requestAnimationFrame);
      await act(nextFrame);
      const priorMeasures = rect.mock.calls.length;
      const transcript = container.querySelector(".wb-chat")!;
      await act(async () => {
        transcript.appendChild(document.createElement("p"));
        fireEvent.scroll(transcript);
        await nextFrame();
      });
      expect(rect).toHaveBeenCalledTimes(priorMeasures);

      rerender(panel(true, true));
      await waitFor(() =>
        expect(sync).toHaveBeenLastCalledWith(
          sessionId,
          browserId,
          null,
          false,
          presentation,
        ),
      );
      rerender(panel(true));
      await waitFor(() =>
        expect(sync).toHaveBeenLastCalledWith(
          sessionId,
          browserId,
          bounds,
          false,
          presentation,
        ),
      );

      rerender(panel(false));
      await waitFor(() =>
        expect(sync).toHaveBeenLastCalledWith(
          sessionId,
          browserId,
          null,
          false,
          presentation,
        ),
      );
      expect(stage).toBeInTheDocument();
      rerender(panel(true));
      await waitFor(() =>
        expect(sync).toHaveBeenLastCalledWith(
          sessionId,
          browserId,
          bounds,
          false,
          presentation,
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "重新加载网页" }));
      await waitFor(() =>
        expect(sync).toHaveBeenLastCalledWith(
          sessionId,
          browserId,
          bounds,
          true,
          presentation,
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "关闭页面预览" }));
      expect(close).toHaveBeenCalledOnce();
    } finally {
      rect.mockRestore();
    }
  },
);
