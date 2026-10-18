import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { UnrealPage } from "@/components/unreal/UnrealPage";
import { toast } from "@/lib/toast";
import type { UnrealSnapshot } from "@/lib/api/unreal";
import zh from "@/i18n/locales/zh.json";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@/lib/api/agent", () => ({
  agentApi: { openProjectDirectory: vi.fn() },
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      let text = key
        .split(".")
        .reduce<unknown>(
          (data, part) => (data as Record<string, unknown>)?.[part],
          zh,
        );
      if (typeof text !== "string") return key;
      for (const [name, value] of Object.entries(values))
        text = (text as string).split(`{{${name}}}`).join(String(value));
      return text;
    },
  }),
}));
let data: UnrealSnapshot;
let install: (() => Promise<void>) | undefined;
beforeEach(() => {
  install = undefined;
  data = {
    projects: [
      {
        id: "game",
        name: "Game",
        path: "D:/Games/Game.uproject",
        engineAssociation: "5.8",
        pluginInstalled: true,
        pluginEnabled: true,
        pluginReady: false,
        addedAt: 1,
      },
    ],
    engines: [
      {
        version: "5.8.3",
        path: "D:/UE_5.8",
        editorExecutable: "UnrealEditor.exe",
        source: "fixture",
      },
    ],
    bridge: { listening: true, port: 17861, editors: [] },
    sourceRevision: "pinned",
  };
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      if (command === "get_unreal_snapshot") return structuredClone(data);
      if (command === "install_unreal_agent_link") {
        expect(args).toEqual({ projectId: "game" });
        await install?.();
        data.projects[0].pluginReady = true;
        return data.projects[0];
      }
      throw new Error(`Unexpected command: ${command}`);
    });
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <UnrealPage onOpenChannels={vi.fn()} onOpenAgentProject={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("UE bridge setup state", () => {
  it("offers repair for source-only enabled plugins, blocks overlapping operations, and only offers launch after validation", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    install = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    mount();
    const repair = await screen.findByRole("button", { name: "修复并启用桥" });
    expect(
      screen.queryByRole("button", { name: "启动编辑器" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("模块尚未为当前引擎编译，或版本不匹配"),
    ).toBeVisible();
    await user.click(repair);
    expect(await screen.findByRole("status")).toHaveTextContent(
      "正在为此引擎编译并验证插件",
    );
    expect(screen.getByRole("button", { name: "正在准备桥…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "从工程库移除" })).toBeDisabled();
    release();
    expect(
      await screen.findByRole("button", { name: "启动编辑器" }),
    ).toBeEnabled();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([name]) => name === "launch_unreal_project"),
    ).toHaveLength(0);
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        description: expect.stringContaining("请从本页启动编辑器"),
      }),
    );
  });

  it("does not advertise ready when compilation fails and lets the user retry", async () => {
    const user = userEvent.setup();
    install = async () => {
      throw new Error("编译工具链缺失，原工程未修改");
    };
    mount();
    await user.click(
      await screen.findByRole("button", { name: "修复并启用桥" }),
    );
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        "安装编辑器桥失败",
        expect.objectContaining({
          description: "编译工具链缺失，原工程未修改",
        }),
      ),
    );
    expect(screen.getByRole("button", { name: "修复并启用桥" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "启动编辑器" }),
    ).not.toBeInTheDocument();
  });

  it("recognizes an editor connection when a saved Windows path has the verbatim prefix", async () => {
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("Win32");
    data.projects[0].path = "\\\\?\\D:\\Games\\Game.uproject";
    data.projects[0].pluginReady = true;
    data.bridge.editors = [
      {
        projectPath: "d:/games/game.uproject",
        projectName: "Game",
        connectedAt: 1,
        lastSeenAt: 1,
      },
    ];
    mount();
    expect(
      await screen.findByRole("button", { name: "已连接" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "启动编辑器" }),
    ).not.toBeInTheDocument();
    vi.restoreAllMocks();
  });
});
