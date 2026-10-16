import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentProjectMenu } from "@/components/agent/AgentProjectMenu";

describe("project submenu", () => {
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
