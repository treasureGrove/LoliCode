import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchField } from "./search-field";

function SearchHarness({ onEscape }: { onEscape: () => void }) {
  const [value, setValue] = useState("樱花");
  return (
    <div onKeyDown={(event) => event.key === "Escape" && onEscape()}>
      <SearchField
        aria-label="Search"
        value={value}
        onValueChange={setValue}
        clearLabel="Clear"
      />
    </div>
  );
}

describe("SearchField keyboard interaction", () => {
  it.each([{ isComposing: true }, { keyCode: 229 }])(
    "keeps the query and containing panel when Escape cancels IME composition: %o",
    (composition) => {
      const onEscape = vi.fn();
      render(<SearchHarness onEscape={onEscape} />);
      const input = screen.getByRole("textbox", { name: "Search" });
      input.focus();

      fireEvent.keyDown(input, { key: "Escape", ...composition });

      expect(input).toHaveValue("樱花");
      expect(input).toHaveFocus();
      expect(onEscape).not.toHaveBeenCalled();
    },
  );

  it("clears once without replacing the focused input, then lets Escape reach the panel", () => {
    const onEscape = vi.fn();
    render(<SearchHarness onEscape={onEscape} />);
    const input = screen.getByRole("textbox", { name: "Search" });
    input.focus();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Search" })).toBe(input);
    expect(onEscape).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("returns focus to the same input after clearing with the pointer", () => {
    render(<SearchHarness onEscape={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Search" });
    const clear = screen.getByRole("button", { name: "Clear" });
    clear.focus();

    fireEvent.click(clear);

    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(
      screen.queryByRole("button", { name: "Clear" }),
    ).not.toBeInTheDocument();
  });
});
