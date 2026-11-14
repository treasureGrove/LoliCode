import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelGatewayPanel } from "@/features/channels/ChannelGatewayPanel";
import {
  channelCenterApi,
  type ChannelGatewayStatus,
} from "@/lib/api/channel-center";

vi.mock("@/lib/api/channel-center", () => ({
  channelCenterApi: {
    getGatewayStatus: vi.fn(),
    startGateway: vi.fn(),
    checkGateway: vi.fn(),
    getGatewayClaudeConfig: vi.fn(),
    openGatewayClaude: vi.fn(),
  },
}));
const stopped: ChannelGatewayStatus = {
  running: false,
  baseUrl: null,
  revision: null,
  savedRevision: 3,
  modelCount: 0,
  defaultModel: null,
  totalRequests: 0,
  activeConnections: 0,
};
const running: ChannelGatewayStatus = {
  ...stopped,
  running: true,
  baseUrl: "http://127.0.0.1:15721/tai/catalogs/3/clients/claude",
  revision: 3,
  modelCount: 2,
  defaultModel: "test/model",
};
const props = {
  disabled: false,
  routeDisabled: false,
  revision: 3,
  refreshToken: 0,
  onConnect: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(channelCenterApi.getGatewayStatus).mockResolvedValue(stopped);
  vi.mocked(channelCenterApi.startGateway).mockResolvedValue(running);
  vi.mocked(channelCenterApi.checkGateway).mockResolvedValue(running);
});

describe("Claude Code Gateway", () => {
  it("starts only on request and checks the listener without connecting the CLI", async () => {
    render(<ChannelGatewayPanel {...props} />);
    await screen.findByText("Gateway 未启动");
    expect(channelCenterApi.startGateway).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "检查连接" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "2. 进入 Claude Code" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "1. 启动路由服务" }));
    await screen.findByText("Gateway 运行中");
    expect(channelCenterApi.startGateway).toHaveBeenCalledWith(3);
    expect(props.onConnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "检查连接" }));
    await screen.findByText(/本机 Gateway 认证与模型目录检查通过/);
    expect(channelCenterApi.checkGateway).toHaveBeenCalledOnce();
  });

  it("waits for the real CLI configuration write and reports failure accurately", async () => {
    vi.mocked(channelCenterApi.getGatewayStatus).mockResolvedValue(running);
    const onConnect = vi.fn().mockResolvedValue(false);
    render(<ChannelGatewayPanel {...props} onConnect={onConnect} />);
    await screen.findByText("Gateway 运行中");
    fireEvent.click(
      screen.getByRole("button", { name: "2. 进入 Claude Code" }),
    );
    await screen.findByText(/未能进入 Claude Code/);
    expect(screen.queryByText(/Claude Code 已连接/)).not.toBeInTheDocument();
    expect(channelCenterApi.startGateway).not.toHaveBeenCalled();
    expect(channelCenterApi.getGatewayClaudeConfig).not.toHaveBeenCalled();
    expect(channelCenterApi.openGatewayClaude).not.toHaveBeenCalled();
  });

  it("copies config only on demand and never renders its credential", async () => {
    vi.mocked(channelCenterApi.getGatewayStatus).mockResolvedValue(running);
    const config = { env: { ANTHROPIC_AUTH_TOKEN: "synthetic-gateway-token" } };
    vi.mocked(channelCenterApi.getGatewayClaudeConfig).mockResolvedValue(
      config,
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<ChannelGatewayPanel {...props} />);
    await screen.findByText("Gateway 运行中");
    expect(channelCenterApi.getGatewayClaudeConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "复制接入配置" }));
    await screen.findByText(/已复制 Claude Code 配置/);
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(config, null, 2));
    expect(
      screen.queryByText(/synthetic-gateway-token/),
    ).not.toBeInTheDocument();
  });

  it("blocks starting and connecting with unsaved or unavailable channels", async () => {
    render(<ChannelGatewayPanel {...props} routeDisabled />);
    await screen.findByText("Gateway 未启动");
    expect(
      screen.getByRole("button", { name: "1. 启动路由服务" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "2. 进入 Claude Code" }),
    ).toBeDisabled();
  });

  it("ignores stale status replies after a refresh", async () => {
    let resolve!: (value: ChannelGatewayStatus) => void;
    vi.mocked(channelCenterApi.getGatewayStatus).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const view = render(<ChannelGatewayPanel {...props} />);
    vi.mocked(channelCenterApi.getGatewayStatus).mockResolvedValue(running);
    view.rerender(<ChannelGatewayPanel {...props} refreshToken={1} />);
    await screen.findByText("Gateway 运行中");
    await act(async () => resolve(stopped));
    await waitFor(() =>
      expect(screen.getByText("Gateway 运行中")).toBeInTheDocument(),
    );
  });

  it("opens Claude Code only after the service is running and configuration succeeds", async () => {
    vi.mocked(channelCenterApi.getGatewayStatus).mockResolvedValue(running);
    vi.mocked(channelCenterApi.openGatewayClaude).mockResolvedValue(true);
    const onConnect = vi.fn().mockImplementation(async () => {
      expect(channelCenterApi.openGatewayClaude).not.toHaveBeenCalled();
      return true;
    });
    render(<ChannelGatewayPanel {...props} onConnect={onConnect} />);
    await screen.findByText("Gateway 运行中");
    fireEvent.click(
      screen.getByRole("button", { name: "2. 进入 Claude Code" }),
    );
    await screen.findByText(/已打开使用 Gateway 的 Claude Code/);
    expect(onConnect).toHaveBeenCalledOnce();
    expect(channelCenterApi.openGatewayClaude).toHaveBeenCalledOnce();
    expect(channelCenterApi.startGateway).not.toHaveBeenCalled();
  });

  it("requires updating the route directory before entering with new models", async () => {
    vi.mocked(channelCenterApi.getGatewayStatus).mockResolvedValue(running);
    render(<ChannelGatewayPanel {...props} revision={4} />);
    await screen.findByText("Gateway 运行中");
    expect(
      screen.getByRole("button", { name: "2. 进入 Claude Code" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "更新路由目录" })).toBeEnabled();
  });
});
