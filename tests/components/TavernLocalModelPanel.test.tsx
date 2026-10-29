import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { TavernLocalModelPanel } from "@/features/tavern/TavernLocalModelPanel";
import {
  TAVERN_LOCAL_MODEL_KEY,
  type TavernLocalModelStatus,
} from "@/lib/api/tavern";
import zh from "@/i18n/locales/zh.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key
        .split(".")
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          zh,
        ) ?? key,
  }),
}));
let status: TavernLocalModelStatus;
let failure = false;
const changed = vi.fn(async () => {});
beforeEach(() => {
  status = {
    supported: true,
    installed: false,
    enabled: false,
    stage: "notInstalled",
    downloadedBytes: 0,
    totalBytes: 6358750677,
    error: null,
    cpuFfnLayers: 0,
  };
  failure = false;
  changed.mockClear();
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (name, args) => {
      if (name === "get_tavern_local_model") return structuredClone(status);
      if (name === "install_tavern_local_model") {
        if (failure) throw new Error("网络中断，可从断点继续");
        status = { ...status, stage: "downloading", downloadedBytes: 1e9 };
        return status;
      }
      if (name === "pause_tavern_local_model_install") {
        status.stage = "paused";
        return;
      }
      if (name === "stop_tavern_local_model") {
        status.stage = "ready";
        return status;
      }
      if (name === "set_tavern_local_model_enabled") {
        status.enabled = (args as { enabled: boolean }).enabled;
        status.stage = status.enabled ? "running" : "ready";
        return status;
      }
      throw new Error(`Unexpected command: ${name}`);
    });
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TavernLocalModelPanel onChange={changed} />
    </QueryClientProvider>,
  );
  return client;
}
describe("Tavern local companion setup", () => {
  it("starts collapsed, keeps progress visible and continues downloading while collapsed", async () => {
    const user = userEvent.setup();
    mount();
    const toggle = screen.getByRole("button", { name: "展开本地模型设置" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("button", { name: "一键配置并启用" }),
    ).not.toBeInTheDocument();
    await user.click(toggle);
    await user.click(
      await screen.findByRole("button", { name: "一键配置并启用" }),
    );
    await screen.findByRole("button", { name: "暂停配置" });
    await user.click(screen.getByRole("button", { name: "收起本地模型设置" }));
    expect(screen.getByRole("progressbar")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("15.7%");
    expect(
      screen.queryByRole("button", { name: "暂停配置" }),
    ).not.toBeInTheDocument();
    expect(status.stage).toBe("downloading");
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(
          ([name]) => name === "pause_tavern_local_model_install",
        ),
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "展开本地模型设置" }));
    expect(screen.getByRole("button", { name: "暂停配置" })).toBeVisible();
  });

  it("shows startup errors even when the settings are collapsed", async () => {
    status = {
      ...status,
      installed: true,
      stage: "error",
      error: "模型启动失败，请重试",
    };
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("模型启动失败");
    expect(
      screen.getByRole("button", { name: "展开本地模型设置" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("starts setup, shows byte progress, pauses and resumes without touching channel credentials", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "展开本地模型设置" }));
    await user.click(
      await screen.findByRole("button", { name: "一键配置并启用" }),
    );
    expect(
      await screen.findByRole("progressbar", { name: "本地模型下载进度" }),
    ).toHaveAttribute("value", expect.stringMatching(/^15\./));
    expect(screen.getByText(/1.00 \/ 6.36 GB/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "暂停配置" }));
    await user.click(await screen.findByRole("button", { name: "继续配置" }));
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "install_tavern_local_model"),
    ).toHaveLength(2);
    expect(
      vi
        .mocked(invoke)
        .mock.calls.every(([name]) => !name.includes("channel_center")),
    ).toBe(true);
  });
  it("keeps an installation failure visible and allows retry", async () => {
    const user = userEvent.setup();
    failure = true;
    mount();
    await user.click(screen.getByRole("button", { name: "展开本地模型设置" }));
    await user.click(
      await screen.findByRole("button", { name: "一键配置并启用" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("网络中断");
    failure = false;
    await user.click(screen.getByRole("button", { name: "一键配置并启用" }));
    await screen.findByRole("progressbar");
  });
  it("releases VRAM without disabling the installed model, then restarts or explicitly switches channels", async () => {
    const user = userEvent.setup();
    status = { ...status, installed: true, enabled: true, stage: "running" };
    const client = mount();
    await user.click(screen.getByRole("button", { name: "展开本地模型设置" }));
    await user.click(await screen.findByRole("button", { name: "释放显存" }));
    expect(status.enabled).toBe(true);
    await user.click(await screen.findByRole("button", { name: "启用并启动" }));
    await screen.findByRole("button", { name: "释放显存" });
    await user.click(screen.getByRole("button", { name: "使用渠道模型" }));
    await waitFor(() => expect(status.enabled).toBe(false));
    await client.invalidateQueries({ queryKey: TAVERN_LOCAL_MODEL_KEY });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "已安装，当前使用渠道模型",
    );
  });
  it("keeps unsupported platforms read-only", async () => {
    const user = userEvent.setup();
    status = { ...status, supported: false, stage: "unsupported" };
    mount();
    await user.click(screen.getByRole("button", { name: "展开本地模型设置" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "一键配置并启用" }),
      ).toBeDisabled(),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "本地陪伴模型" })).getByRole(
          "status",
        ),
      ).toHaveTextContent("Windows x64 NVIDIA"),
    );
  });
});
