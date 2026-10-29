import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZhipuLoginPanel } from "@/features/channels/ZhipuLoginPanel";
import {
  channelCenterApi,
  type ChannelSource,
  type ZhipuLoginStatus,
} from "@/lib/api/channel-center";
import { settingsApi } from "@/lib/api";

vi.mock("@/lib/api/channel-center", () => ({
  channelCenterApi: {
    startZhipuLogin: vi.fn(),
    pollZhipuLogin: vi.fn(),
    cancelZhipuLogin: vi.fn(),
  },
}));
vi.mock("@/lib/api", () => ({ settingsApi: { openExternal: vi.fn() } }));

const source: ChannelSource = {
  id: "fixture-zhipu",
  name: "智谱 Coding Plan",
  authKind: "zhipu_oauth",
  accountId: "fixture-zhipu-account",
  apiKey: "",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  protocol: "openai_chat",
  models: [],
  enabled: true,
};

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(channelCenterApi.startZhipuLogin).mockReset().mockResolvedValue({
    flowId: "fixture-flow",
    url: "https://open.bigmodel.cn/login",
    expiresIn: 30,
  });
  vi.mocked(channelCenterApi.pollZhipuLogin)
    .mockReset()
    .mockResolvedValue({ status: "pending" });
  vi.mocked(channelCenterApi.cancelZhipuLogin).mockReset().mockResolvedValue();
  vi.mocked(settingsApi.openExternal).mockReset().mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ZhipuLoginPanel", () => {
  it("uses official browser login once and forwards only the resolved coding source", async () => {
    vi.mocked(channelCenterApi.pollZhipuLogin).mockResolvedValue({
      status: "success",
      channel: source,
    });
    const onConnected = vi.fn().mockResolvedValue(undefined);
    const onBusyChange = vi.fn();
    render(
      <ZhipuLoginPanel onConnected={onConnected} onBusyChange={onBusyChange} />,
    );
    const button = screen.getByRole("button", { name: "登录智谱 / ZCode" });
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    expect(channelCenterApi.startZhipuLogin).toHaveBeenCalledTimes(1);
    expect(channelCenterApi.startZhipuLogin).toHaveBeenCalledWith("bigmodel");
    expect(settingsApi.openExternal).toHaveBeenCalledWith(
      "https://open.bigmodel.cn/login",
    );
    expect(onConnected).toHaveBeenCalledWith(source);
    expect(
      screen.getByText("账号已登录，渠道与模型已加入。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("fixture-coding-key")).not.toBeInTheDocument();
    expect(onBusyChange.mock.calls.some(([busy]) => busy)).toBe(true);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("polls serially while waiting and supports the international account region", async () => {
    vi.mocked(channelCenterApi.pollZhipuLogin)
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "success", channel: source });
    const onConnected = vi.fn().mockResolvedValue(undefined);
    render(<ZhipuLoginPanel onConnected={onConnected} />);
    fireEvent.change(screen.getByLabelText("账号所在地区"), {
      target: { value: "zai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录智谱 / ZCode" }));
    await flush();
    expect(channelCenterApi.startZhipuLogin).toHaveBeenCalledWith("zai");
    expect(channelCenterApi.pollZhipuLogin).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(channelCenterApi.pollZhipuLogin).toHaveBeenCalledTimes(2);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("ignores a successful stale poll after canceling login", async () => {
    let finishPoll: (status: ZhipuLoginStatus) => void = () => {};
    vi.mocked(channelCenterApi.pollZhipuLogin).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishPoll = resolve;
        }),
    );
    const onConnected = vi.fn().mockResolvedValue(undefined);
    render(<ZhipuLoginPanel onConnected={onConnected} />);
    fireEvent.click(screen.getByRole("button", { name: "登录智谱 / ZCode" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    await act(async () => finishPoll({ status: "success", channel: source }));
    expect(channelCenterApi.cancelZhipuLogin).toHaveBeenCalledWith(
      "fixture-flow",
    );
    expect(onConnected).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "登录智谱 / ZCode" }),
    ).toBeEnabled();
  });

  it("cancels a flow that finishes starting after the panel unmounts", async () => {
    let finishStart: (
      value: Awaited<ReturnType<typeof channelCenterApi.startZhipuLogin>>,
    ) => void = () => {};
    vi.mocked(channelCenterApi.startZhipuLogin).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = resolve;
        }),
    );
    const view = render(<ZhipuLoginPanel onConnected={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "登录智谱 / ZCode" }));
    view.unmount();
    await act(async () =>
      finishStart({
        flowId: "late-flow",
        url: "https://open.bigmodel.cn/login",
        expiresIn: 30,
      }),
    );
    expect(channelCenterApi.cancelZhipuLogin).toHaveBeenCalledWith("late-flow");
    expect(settingsApi.openExternal).not.toHaveBeenCalled();
    expect(channelCenterApi.pollZhipuLogin).not.toHaveBeenCalled();
  });

  it("expires a waiting authorization without leaving navigation blocked", async () => {
    vi.mocked(channelCenterApi.startZhipuLogin).mockResolvedValue({
      flowId: "expiry-flow",
      url: "https://open.bigmodel.cn/login",
      expiresIn: 3,
    });
    const onBusyChange = vi.fn();
    const onConnected = vi.fn();
    render(
      <ZhipuLoginPanel onConnected={onConnected} onBusyChange={onBusyChange} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "登录智谱 / ZCode" }));
    await flush();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(
      screen.getByText("登录等待已超时，请重新登录。"),
    ).toBeInTheDocument();
    expect(channelCenterApi.cancelZhipuLogin).toHaveBeenCalledWith(
      "expiry-flow",
    );
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("does not claim connection success when discovering or saving the resolved source fails", async () => {
    vi.mocked(channelCenterApi.pollZhipuLogin).mockResolvedValue({
      status: "success",
      channel: { ...source, authKind: "api_key", apiKey: "fixture-coding-key" },
    });
    const onConnected = vi
      .fn()
      .mockRejectedValue(new Error("401 fixture-coding-key"));
    render(<ZhipuLoginPanel onConnected={onConnected} />);
    fireEvent.click(screen.getByRole("button", { name: "登录智谱 / ZCode" }));
    await flush();
    expect(
      screen.getByText("没有访问权限，请检查 API Key 或重新登录账号。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("账号已登录，渠道与模型已加入。"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/fixture-coding-key/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新登录" })).toBeEnabled();
  });

  it("offers a browser retry if opening the authorization page fails", async () => {
    vi.mocked(settingsApi.openExternal).mockRejectedValueOnce(
      new Error("Browser unavailable"),
    );
    render(<ZhipuLoginPanel onConnected={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "登录智谱 / ZCode" }));
    await flush();
    expect(
      screen.getByText("浏览器没有自动打开，请点击打开登录页。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开登录页" }));
    await flush();
    expect(settingsApi.openExternal).toHaveBeenCalledTimes(2);
    expect(channelCenterApi.startZhipuLogin).toHaveBeenCalledTimes(1);
  });
});
