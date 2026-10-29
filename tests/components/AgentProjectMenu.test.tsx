import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentProjectMenu } from "@/features/agent/AgentProjectMenu";

describe("project submenu", () => {
  it("renames only the display name, trims it and keeps a failed draft editable", async () => {
    const user = userEvent.setup();
    const rename = vi
      .fn()
      .mockRejectedValueOnce(new Error("保存失败，请重试。"))
      .mockResolvedValueOnce(undefined);
    render(
      <AgentProjectMenu
        name="工坊"
        pinned
        disabled={false}
        onRename={rename}
        onTogglePin={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "管理项目：工坊" }));
    await user.click(screen.getByRole("menuitem", { name: "重命名项目" }));
    const input = screen.getByRole("textbox", { name: "项目名称" });
    expect(input).toHaveValue("工坊");
    await user.clear(input);
    await user.type(input, "  新的工坊  ");
    await user.click(screen.getByRole("button", { name: "保存名称" }));
    expect(rename).toHaveBeenCalledWith("新的工坊");
    expect(screen.getByRole("alert")).toHaveTextContent("保存失败");
    expect(input).toHaveValue("  新的工坊  ");
    await user.click(screen.getByRole("button", { name: "保存名称" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("can cancel a rename and rejects an empty display name", async () => {
    const user = userEvent.setup();
    const rename = vi.fn();
    render(
      <AgentProjectMenu
        name="工坊"
        pinned={false}
        disabled={false}
        onRename={rename}
        onTogglePin={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "管理项目：工坊" }));
    await user.click(screen.getByRole("menuitem", { name: "重命名项目" }));
    const input = screen.getByRole("textbox", { name: "项目名称" });
    await user.clear(input);
    await user.type(input, "   ");
    expect(screen.getByRole("button", { name: "保存名称" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(rename).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("prevents duplicate saves while a rename is pending", async () => {
    let finish!: () => void;
    const rename = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <AgentProjectMenu
        name="工坊"
        pinned={false}
        disabled={false}
        onRename={rename}
        onTogglePin={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "管理项目：工坊" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名项目" }));
    const input = screen.getByRole("textbox", { name: "项目名称" });
    fireEvent.change(input, { target: { value: "新名称" } });
    const form = input.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(rename).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消" })).toBeDisabled();
    await act(async () => finish());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens outside the clipped sidebar and closes after selecting an action", async () => {
    const user = userEvent.setup();
    const pin = vi.fn();
    const remove = vi.fn();
    const { container } = render(
      <div style={{ overflow: "hidden", height: 20 }}>
        <AgentProjectMenu
          name="工坊"
          pinned={false}
          disabled={false}
          onTogglePin={pin}
          onRemove={remove}
        />
      </div>,
    );
    await user.click(screen.getByRole("button", { name: "管理项目：工坊" }));
    expect(container).not.toContainElement(screen.getByRole("menu"));
    await user.click(screen.getByRole("menuitem", { name: "置顶项目" }));
    expect(pin).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });

  it("supports Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(
      <AgentProjectMenu
        name="星图"
        pinned
        disabled={false}
        onTogglePin={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "管理项目：星图" });
    await user.click(trigger);
    expect(
      screen.getByRole("menuitem", { name: "取消置顶" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("prevents opening actions while the workspace is busy", async () => {
    render(
      <AgentProjectMenu
        name="星图"
        pinned={false}
        disabled
        onTogglePin={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "管理项目：星图" }),
    ).toBeDisabled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
