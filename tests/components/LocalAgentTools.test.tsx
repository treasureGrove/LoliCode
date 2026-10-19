import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalAgentTools } from "@/components/apps/LocalAgentTools";
import {
  localAgentToolsApi,
  type LocalAgentTool,
} from "@/lib/api/local-agent-tools";
import { settingsApi } from "@/lib/api/settings";
import { open } from "@tauri-apps/plugin-dialog";
import { getIcon, getIconUrl, isUrlIcon } from "@/icons/extracted";

vi.mock("@/lib/api/local-agent-tools", async (original) => ({
  ...(await original<typeof import("@/lib/api/local-agent-tools")>()),
  localAgentToolsApi: { list: vi.fn(), setPath: vi.fn(), reveal: vi.fn() },
}));
vi.mock("@/lib/api/settings", () => ({
  settingsApi: { openExternal: vi.fn() },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const tools: LocalAgentTool[] = [
  {
    id: "workbuddy",
    installed: true,
    path: "D:/apps/WorkBuddy.exe",
    version: "5.3.14",
    customPath: false,
    configPaths: ["/home/.workbuddy/models.json"],
    configExists: true,
    configError: null,
  },
  {
    id: "deepseek-harness",
    installed: false,
    path: null,
    version: null,
    customPath: false,
    configPaths: ["/home/.dsh/profiles/web/cordis.patch.yml"],
    configExists: true,
    configError: null,
  },
  {
    id: "zcode",
    installed: true,
    path: "C:/apps/ZCode.exe",
    version: null,
    customPath: true,
    configPaths: [],
    configExists: false,
    configError: null,
  },
  {
    id: "mimocode",
    installed: false,
    path: null,
    version: null,
    customPath: false,
    configPaths: [],
    configExists: false,
    configError: null,
  },
  {
    id: "codebuddy",
    installed: false,
    path: null,
    version: null,
    customPath: false,
    configPaths: [],
    configExists: false,
    configError: null,
  },
  {
    id: "qoder",
    installed: true,
    path: "C:/apps/Qoder IDE.exe",
    version: "1.25.1",
    customPath: false,
    configPaths: [],
    configExists: false,
    configError: null,
  },
];
function setup(props: Parameters<typeof LocalAgentTools>[0] = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LocalAgentTools {...props} />
    </QueryClientProvider>,
  );
}
function row(id: string) {
  return within(
    document.querySelector(`[data-local-agent="${id}"]`) as HTMLElement,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(localAgentToolsApi.list).mockResolvedValue(tools);
  vi.mocked(localAgentToolsApi.setPath).mockResolvedValue();
  vi.mocked(localAgentToolsApi.reveal).mockResolvedValue();
  vi.mocked(open).mockResolvedValue(null);
});

describe("local domestic Agent management", () => {
  it("lists all six tools and keeps configuration existence separate from installation", async () => {
    setup();
    await screen.findByText("5.3.14");
    expect(row("workbuddy").getByText("已发现配置文件")).toBeInTheDocument();
    expect(
      row("deepseek-harness").getByText("未检测到程序"),
    ).toBeInTheDocument();
    expect(
      row("deepseek-harness").getByText("已发现配置文件"),
    ).toBeInTheDocument();
    expect(
      row("deepseek-harness").queryByText("打开位置"),
    ).not.toBeInTheDocument();
    expect(row("zcode").getByText("已安装")).toBeInTheDocument();
    expect(row("mimocode").getByText("MiMo Code")).toBeInTheDocument();
    expect(row("codebuddy").getByText("CodeBuddy")).toBeInTheDocument();
    expect(row("qoder").getByText("1.25.1")).toBeInTheDocument();
    expect(
      row("qoder").getByText("通过 Qoder 官方设置向导添加模型"),
    ).toBeInTheDocument();
    fireEvent.click(row("workbuddy").getByText("打开位置"));
    await waitFor(() =>
      expect(localAgentToolsApi.reveal).toHaveBeenCalledWith("workbuddy"),
    );
  });
  it("opens official downloads and delegates explicit model configuration without writing files", async () => {
    const onConfigure = vi.fn();
    setup({ onConfigure });
    await screen.findByText("5.3.14");
    fireEvent.click(row("zcode").getByText("配置模型"));
    expect(onConfigure).toHaveBeenCalledWith("zcode");
    expect(localAgentToolsApi.setPath).not.toHaveBeenCalled();
    fireEvent.click(row("mimocode").getByText("官网下载"));
    await waitFor(() =>
      expect(settingsApi.openExternal).toHaveBeenCalledWith(
        "https://github.com/XiaomiMiMo/MiMo-Code",
      ),
    );
  });
  it("saves a selected program immediately, supports resetting, and leaves cancellation alone", async () => {
    setup();
    await screen.findByText("5.3.14");
    fireEvent.click(row("workbuddy").getByText("选择程序"));
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(localAgentToolsApi.setPath).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(row("workbuddy").getByText("选择程序")).toBeEnabled(),
    );
    vi.mocked(open).mockResolvedValueOnce("D:/new/WorkBuddy.exe");
    fireEvent.click(row("workbuddy").getByText("选择程序"));
    await waitFor(() =>
      expect(localAgentToolsApi.setPath).toHaveBeenCalledWith(
        "workbuddy",
        "D:/new/WorkBuddy.exe",
      ),
    );
    await waitFor(() =>
      expect(row("zcode").getByText("自动检测")).toBeEnabled(),
    );
    fireEvent.click(row("zcode").getByText("自动检测"));
    await waitFor(() =>
      expect(localAgentToolsApi.setPath).toHaveBeenCalledWith("zcode", null),
    );
    expect(
      vi.mocked(localAgentToolsApi.list).mock.calls.length,
    ).toBeGreaterThan(1);
  });
  it("shows path errors and does not allow configuring while channel state is locked", async () => {
    setup({ onConfigure: vi.fn(), configureDisabled: true });
    await screen.findByText("5.3.14");
    expect(row("zcode").getByText("配置模型")).toBeDisabled();
    vi.mocked(open).mockResolvedValueOnce("D:/setup.exe");
    vi.mocked(localAgentToolsApi.setPath).mockRejectedValueOnce(
      "请选择已安装程序",
    );
    fireEvent.click(row("zcode").getByText("选择程序"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ZCode：请选择已安装程序",
    );
  });
  it("shows detection failures instead of reporting uninstalled", async () => {
    vi.mocked(localAgentToolsApi.list).mockRejectedValueOnce(
      "无法读取路径记录",
    );
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "无法读取路径记录",
    );
    expect(screen.getAllByText("状态未知")).toHaveLength(6);
    expect(screen.queryByText("未检测到程序")).not.toBeInTheDocument();
  });
  it("uses the bundled official ZCode Z instead of the GLM provider symbol", () => {
    expect(isUrlIcon("zcode")).toBe(true);
    expect(getIconUrl("zcode")).toContain("zcode.png");
    expect(getIconUrl("zcode")).not.toMatch(/^https?:/);
    expect(getIcon("zcode")).toBe("");
  });

  it("adds CodeBuddy to managed configuration while Qoder opens its official wizard guide", async () => {
    const onConfigure = vi.fn();
    setup({ onConfigure });
    await screen.findByText("5.3.14");
    fireEvent.click(row("codebuddy").getByText("配置模型"));
    expect(onConfigure).toHaveBeenCalledWith("codebuddy");
    expect(row("qoder").queryByText("配置模型")).not.toBeInTheDocument();
    fireEvent.click(row("qoder").getByText("模型设置指引"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/验证并添加/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByText("打开官方配置文档"));
    await waitFor(() =>
      expect(settingsApi.openExternal).toHaveBeenCalledWith(
        "https://docs.qoder.com/zh/qoder/custom-models",
      ),
    );
    expect(onConfigure).toHaveBeenCalledTimes(1);
    expect(localAgentToolsApi.setPath).not.toHaveBeenCalled();
  });
});
