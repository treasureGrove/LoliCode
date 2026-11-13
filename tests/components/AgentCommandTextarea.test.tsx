import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgentCommandTextarea,
  normalizeAgentCommand,
} from "@/features/agent/AgentCommandTextarea";

afterEach(cleanup);

function Composer({ initial = "", submit = vi.fn() }) {
  const [value, setValue] = useState(initial);
  return (
    <AgentCommandTextarea
      aria-label="消息"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onSelectCommand={setValue}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) submit(value);
      }}
    />
  );
}

describe("Agent command suggestions", () => {
  it("opens slash commands with descriptions and selects without submitting", () => {
    const submit = vi.fn();
    render(<Composer submit={submit} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(
      screen.getByText("先分析并提出方案，确认后推进执行。"),
    ).toBeVisible();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent(
      "/goal",
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("/goal ");
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("filters without case sensitivity and supports Tab completion", () => {
    render(<Composer initial="/PL" />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("/plan ");
  });

  it("supports pointer selection while retaining the editing focus", () => {
    render(<Composer initial="/" />);
    const input = screen.getByRole("textbox");
    act(() => input.focus());
    const option = screen.getByRole("option", { name: /\/plan/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("/plan ");
  });

  it("dismisses on Escape and reopens when the query changes", () => {
    render(<Composer initial="/" />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.change(input, { target: { value: "/p" } });
    expect(screen.getByRole("listbox")).toBeVisible();
    fireEvent.blur(input);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it.each(["/plan Read README", "/tmp/file", "text /", "/unknown"])(
    "leaves ordinary input alone: %s",
    (initial) => {
      const submit = vi.fn();
      render(<Composer initial={initial} submit={submit} />);
      const input = screen.getByRole("textbox");
      fireEvent.focus(input);
      expect(screen.queryByRole("listbox")).toBeNull();
      fireEvent.keyDown(input, { key: "Enter" });
      expect(submit).toHaveBeenCalledWith(initial);
    },
  );

  it("does not select or send when Enter confirms IME composition", () => {
    const submit = vi.fn();
    render(<Composer initial="/p" submit={submit} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(input).toHaveValue("/p");
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input).toHaveValue("/plan ");
  });

  it("preserves Shift+Enter and modified submission shortcuts", () => {
    const submit = vi.fn();
    render(<Composer initial="/p" submit={submit} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(input).toHaveValue("/p");
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(submit).toHaveBeenCalledWith("/p");
  });
});

describe("native command normalization", () => {
  it.each([
    ["/Plan Review MyAPI", "/plan Review MyAPI"],
    ["/GOAL Finish MyProject", "/goal Finish MyProject"],
    ["/Compact", "/compact"],
    ["/planning is a path", "/planning is a path"],
    ["/Unknown KeepCase", "/Unknown KeepCase"],
    ["Explain /Plan", "Explain /Plan"],
  ])("normalizes only supported command names: %s", (input, expected) => {
    expect(normalizeAgentCommand(input)).toBe(expected);
  });
});
