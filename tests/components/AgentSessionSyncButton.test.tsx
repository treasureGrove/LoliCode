import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionSyncButton } from "@/features/agent/AgentSessionSyncButton";
import { agentApi } from "@/lib/api/agent";

vi.mock("@/lib/api/agent", () => ({
  agentApi: { syncSessions: vi.fn() },
}));

const syncResult = {
  imported: 2,
  exported: 3,
  duplicates: 4,
  conflicts: 1,
  skippedBusy: 1,
  skippedUnsupported: 2,
  peerName: "开发版",
  warnings: ["开发版已打开，请退出后重新打开以显示会话。"],
};

describe("manual session synchronization", () => {
  beforeEach(() => {
    vi.mocked(agentApi.syncSessions).mockReset();
    vi.mocked(agentApi.syncSessions).mockResolvedValue(syncResult);
  });

  it("syncs both ways by default and keeps the outcome visible after refreshing", async () => {
    const user = userEvent.setup();
    const onSynced = vi.fn();
    render(<AgentSessionSyncButton onSynced={onSynced} />);
    await user.click(screen.getByRole("button", { name: "同步会话" }));
    expect(screen.getByRole("combobox", { name: "同步方向" })).toHaveValue(
      "both",
    );
    await user.click(screen.getByRole("button", { name: "开始同步" }));
    expect(agentApi.syncSessions).toHaveBeenCalledOnce();
    expect(agentApi.syncSessions).toHaveBeenCalledWith("both");
    await waitFor(() => expect(onSynced).toHaveBeenCalledOnce());
    expect(screen.getByRole("status")).toHaveTextContent(
      "同步过来 2 个，同步过去 3 个",
    );
    expect(screen.getByRole("status")).toHaveTextContent("保留冲突副本 1 个");
    expect(screen.getByRole("status")).toHaveTextContent(
      syncResult.warnings[0],
    );
    expect(screen.getByRole("button", { name: "再次同步" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each(["import", "export"] as const)(
    "passes the selected %s direction",
    async (direction) => {
      const user = userEvent.setup();
      render(<AgentSessionSyncButton onSynced={vi.fn()} />);
      await user.click(screen.getByRole("button", { name: "同步会话" }));
      await user.selectOptions(
        screen.getByRole("combobox", { name: "同步方向" }),
        direction,
      );
      await user.click(screen.getByRole("button", { name: "开始同步" }));
      expect(agentApi.syncSessions).toHaveBeenCalledOnce();
      expect(agentApi.syncSessions).toHaveBeenCalledWith(direction);
      await screen.findByText("同步完成");
    },
  );

  it("keeps a failed direction available for retry without reporting success", async () => {
    const user = userEvent.setup();
    const onSynced = vi.fn();
    vi.mocked(agentApi.syncSessions)
      .mockRejectedValueOnce(new Error("另一版本的数据目录暂不可访问"))
      .mockResolvedValueOnce(syncResult);
    render(<AgentSessionSyncButton onSynced={onSynced} />);
    await user.click(screen.getByRole("button", { name: "同步会话" }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: "同步方向" }),
      "export",
    );
    await user.click(screen.getByRole("button", { name: "开始同步" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "另一版本的数据目录暂不可访问",
    );
    expect(screen.queryByText("同步完成")).not.toBeInTheDocument();
    expect(onSynced).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "同步方向" })).toHaveValue(
      "export",
    );
    await user.click(screen.getByRole("button", { name: "开始同步" }));
    await screen.findByText("同步完成");
    expect(agentApi.syncSessions).toHaveBeenNthCalledWith(2, "export");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("prevents duplicate submissions and closing while synchronization is pending", async () => {
    let finish!: (result: typeof syncResult) => void;
    vi.mocked(agentApi.syncSessions).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<AgentSessionSyncButton onSynced={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "同步会话" }));
    const form = screen
      .getByRole("combobox", { name: "同步方向" })
      .closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(agentApi.syncSessions).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "正在同步…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "同步方向" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => finish(syncResult));
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("preserves a completed sync result if the session list could not refresh", async () => {
    const user = userEvent.setup();
    render(
      <AgentSessionSyncButton
        onSynced={vi.fn().mockRejectedValue(new Error("列表读取失败"))}
      />,
    );
    await user.click(screen.getByRole("button", { name: "同步会话" }));
    await user.click(screen.getByRole("button", { name: "开始同步" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "会话已同步，列表刷新未完成",
      ),
    );
    expect(screen.getByRole("status")).toHaveTextContent("同步过来 2 个");
    expect(agentApi.syncSessions).toHaveBeenCalledOnce();
  });

  it("disables opening while another workspace operation is in progress", () => {
    render(<AgentSessionSyncButton disabled onSynced={vi.fn()} />);
    expect(screen.getByRole("button", { name: "同步会话" })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
