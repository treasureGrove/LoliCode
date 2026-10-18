import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelConnectionPanel } from "@/components/channels/ChannelConnectionPanel";
import {
  channelCenterApi,
  type ChannelConnection,
} from "@/lib/api/channel-center";

vi.mock("@/lib/api/channel-center", () => ({
  channelCenterApi: { getConnections: vi.fn() },
}));
const native: ChannelConnection = {
  app: "codex",
  mode: "native",
  configured: true,
  hasNativeProfile: true,
};
beforeEach(() =>
  vi
    .mocked(channelCenterApi.getConnections)
    .mockReset()
    .mockResolvedValue([
      { ...native },
      { ...native, app: "claude", mode: "lolicode" },
    ]),
);
describe("tool connection choice", () => {
  it("reads persisted state and switches only the selected tool", async () => {
    const set = vi.fn().mockResolvedValue({ ...native, mode: "lolicode" });
    render(
      <ChannelConnectionPanel
        disabled={false}
        routeDisabled={false}
        refreshToken={null}
        onSet={set}
      />,
    );
    const codex = await screen.findByRole("group", { name: "Codex 连接方式" });
    await waitFor(() =>
      expect(
        within(codex).getByRole("button", { name: "Codex 使用原生配置" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    fireEvent.click(
      within(codex).getByRole("button", { name: "Codex 使用LoliCode 路由" }),
    );
    await waitFor(() => expect(set).toHaveBeenCalledWith("codex", "lolicode"));
    await waitFor(() =>
      expect(within(codex).getByRole("status")).toHaveTextContent(
        "当前：LoliCode 路由",
      ),
    );
    expect(screen.getAllByRole("group")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: /ZCode 使用/ }),
    ).not.toBeInTheDocument();
  });
  it("keeps native recovery available when channel edits block route activation", async () => {
    render(
      <ChannelConnectionPanel
        disabled={false}
        routeDisabled={true}
        refreshToken={null}
        onSet={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Claude Code 使用原生配置" }),
      ).toBeEnabled(),
    );
    expect(
      screen.getByRole("button", { name: "Codex 使用LoliCode 路由" }),
    ).toBeDisabled();
  });
  it("re-reads actual state after a failed write instead of showing optimistic success", async () => {
    render(
      <ChannelConnectionPanel
        disabled={false}
        routeDisabled={false}
        refreshToken={null}
        onSet={vi.fn().mockRejectedValue(new Error("synthetic write failure"))}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Codex 使用LoliCode 路由" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Codex 使用LoliCode 路由" }),
    );
    await screen.findByText("切换未完成，已重新读取实际配置状态，请重试。");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Codex 使用原生配置" }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
  });
  it("keeps route activation disabled when no usable shared models are available", async () => {
    vi.mocked(channelCenterApi.getConnections).mockResolvedValue([
      { ...native, configured: false },
    ]);
    render(
      <ChannelConnectionPanel
        disabled={false}
        routeDisabled={true}
        refreshToken={null}
        onSet={vi.fn()}
      />,
    );
    await screen.findByText("当前：原生配置");
    expect(
      screen.getByRole("button", { name: "Codex 使用LoliCode 路由" }),
    ).toBeDisabled();
  });
});
