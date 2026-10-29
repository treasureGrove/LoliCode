import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContextWindowSelect } from "@/features/channels/ContextWindowSelect";

describe("context window selection", () => {
  it("offers only declared windows and can return to the channel default", () => {
    const select = vi.fn();
    render(
      <ContextWindowSelect
        windows={[1000000, 128000, 0, 128000]}
        defaultLimit={128000}
        onSelect={select}
      />,
    );
    const picker = screen.getByRole("combobox", { name: "上下文窗口" });
    expect(screen.getAllByRole("option")).toHaveLength(3);
    fireEvent.change(picker, { target: { value: "1000000" } });
    expect(select).toHaveBeenLastCalledWith(1000000);
    fireEvent.change(picker, { target: { value: "default" } });
    expect(select).toHaveBeenLastCalledWith(null);
  });

  it("shows a removed saved window without claiming it is selectable", () => {
    const view = render(
      <ContextWindowSelect
        value={1000000}
        windows={[128000]}
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("option", { name: /当前目录未提供/ }),
    ).toBeDisabled();
    view.rerender(
      <ContextWindowSelect windows={[128000]} onSelect={vi.fn()} />,
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
