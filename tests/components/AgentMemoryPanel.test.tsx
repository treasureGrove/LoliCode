import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentMemoryPanel } from "@/components/agent/AgentMemoryPanel";
import {
  agentMemoryApi,
  type AgentMemorySnapshot,
} from "@/lib/api/agent-memory";

vi.mock("@/lib/api/agent-memory", () => ({
  agentMemoryApi: {
    get: vi.fn(),
    edit: vi.fn(),
    configure: vi.fn(),
    clear: vi.fn(),
  },
}));

const snapshot = (
  patch: Partial<AgentMemorySnapshot> = {},
): AgentMemorySnapshot => ({
  revision: 7,
  enabled: true,
  requireApproval: true,
  projectPath: "D:/project",
  user: {
    entries: [
      {
        id: "user-pref",
        content: "默认用中文回答",
        source: "user",
        updatedAt: 1792195200000,
      },
    ],
    used: 8,
    limit: 1375,
  },
  project: { entries: [], used: 0, limit: 2200 },
  ...patch,
});

beforeEach(() => {
  vi.mocked(agentMemoryApi.get).mockResolvedValue(snapshot());
  vi.mocked(agentMemoryApi.edit).mockResolvedValue(snapshot({ revision: 8 }));
  vi.mocked(agentMemoryApi.configure).mockResolvedValue(
    snapshot({ revision: 8, enabled: false }),
  );
  vi.mocked(agentMemoryApi.clear).mockResolvedValue(
    snapshot({ revision: 8, user: { entries: [], used: 0, limit: 1375 } }),
  );
});

describe("AgentMemoryPanel", () => {
  it("identifies editable character presets without reinitializing them from the UI", async () => {
    const preset = {
      id: "preset",
      content: "默认称呼用户为主人",
      source: "preset:sillyDog:v1",
      updatedAt: 1792195200000,
    };
    vi.mocked(agentMemoryApi.get).mockResolvedValue(
      snapshot({ user: { entries: [preset], used: 10, limit: 1375 } }),
    );
    render(<AgentMemoryPanel />);
    expect(await screen.findByText(preset.content)).toBeVisible();
    expect(screen.getByText(/sillyDog（小笨狗）/)).toBeVisible();
    expect(screen.getByText(/内置预设 ·/)).toBeVisible();
    expect(screen.getByRole("button", { name: "编辑记忆" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "删除记忆" })).toBeEnabled();
  });
  it("loads current scopes, edits by exact original content, and sends an optimistic revision", async () => {
    render(<AgentMemoryPanel projectPath="D:/project" />);
    expect(await screen.findByText("默认用中文回答")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "编辑记忆" }));
    fireEvent.change(screen.getByRole("textbox", { name: "编辑记忆内容" }), {
      target: { value: "默认用中文，简明回答" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() =>
      expect(agentMemoryApi.edit).toHaveBeenCalledWith(
        {
          revision: 7,
          scope: "user",
          action: "patch",
          old_text: "默认用中文回答",
          content: "默认用中文，简明回答",
        },
        "D:/project",
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "添加记忆内容" })).toHaveValue(
        "",
      ),
    );
  });

  it("exposes a close affordance when the host passes onClose", async () => {
    const onClose = vi.fn();
    render(<AgentMemoryPanel projectPath="D:/project" onClose={onClose} />);
    await screen.findByText("默认用中文回答");
    fireEvent.click(screen.getByRole("button", { name: "关闭记忆面板" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("omits the close affordance when the host does not provide one", async () => {
    render(<AgentMemoryPanel projectPath="D:/project" />);
    await screen.findByText("默认用中文回答");
    expect(
      screen.queryByRole("button", { name: "关闭记忆面板" }),
    ).not.toBeInTheDocument();
  });

  it("requires an explicit confirmation for clearing all projects and user memories", async () => {
    render(<AgentMemoryPanel />);
    await screen.findByText("默认用中文回答");
    fireEvent.click(screen.getByRole("button", { name: "清除全部记忆" }));
    expect(agentMemoryApi.clear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认清除" }));
    await waitFor(() =>
      expect(agentMemoryApi.clear).toHaveBeenCalledWith(7, "all", undefined),
    );
    await waitFor(() =>
      expect(screen.queryByText("默认用中文回答")).not.toBeInTheDocument(),
    );
  });

  it("disables project scope when there is no project and preserves text on failed saves", async () => {
    vi.mocked(agentMemoryApi.get).mockResolvedValue(
      snapshot({ projectPath: null }),
    );
    vi.mocked(agentMemoryApi.edit).mockRejectedValue(
      "记忆已被其它会话更新，请刷新后重试",
    );
    render(<AgentMemoryPanel />);
    await screen.findByText("默认用中文回答");
    expect(screen.getByRole("tab", { name: "当前项目" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "添加记忆内容" }), {
      target: { value: "偏好深色界面" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加记忆" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "记忆已被其它会话更新",
    );
    expect(screen.getByRole("textbox", { name: "添加记忆内容" })).toHaveValue(
      "偏好深色界面",
    );
  });

  it("ignores a late result belonging to the previous project", async () => {
    let finish!: (value: AgentMemorySnapshot) => void;
    vi.mocked(agentMemoryApi.edit).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<AgentMemoryPanel projectPath="D:/project" />);
    await screen.findByText("默认用中文回答");
    fireEvent.change(screen.getByRole("textbox", { name: "添加记忆内容" }), {
      target: { value: "旧项目记忆" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加记忆" }));
    vi.mocked(agentMemoryApi.get).mockResolvedValue(
      snapshot({
        projectPath: "D:/other",
        user: { entries: [], used: 0, limit: 1375 },
      }),
    );
    view.rerender(<AgentMemoryPanel projectPath="D:/other" />);
    await waitFor(() =>
      expect(screen.queryByText("默认用中文回答")).not.toBeInTheDocument(),
    );
    finish(
      snapshot({
        user: {
          entries: [
            {
              id: "old",
              source: "user",
              updatedAt: 1,
              content: "不应出现的旧项目结果",
            },
          ],
          used: 10,
          limit: 1375,
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "添加记忆" })).toBeDisabled(),
    );
    expect(screen.queryByText("不应出现的旧项目结果")).not.toBeInTheDocument();
  });
});
