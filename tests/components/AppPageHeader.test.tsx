import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AppPageHeader,
  WindowControlsContext,
} from "@/components/shell/AppPageHeader";

describe("AppPageHeader title semantics", () => {
  it("keeps the editor task as the heading when a client subtitle is supplied", () => {
    const close = vi.fn();
    render(
      <WindowControlsContext.Provider
        value={<button onClick={close}>Close window</button>}
      >
        <AppPageHeader
          variant="app"
          title="Edit a very long provider name"
          subtitle="Claude Code"
          truncateTitle
          actions={<button>Save</button>}
        />
      </WindowControlsContext.Provider>,
    );
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Edit a very long provider name",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close window" }));
    expect(close).toHaveBeenCalledOnce();
  });
  it("uses the client as context only for an explicit client header", () => {
    render(
      <AppPageHeader
        variant="client"
        title="Claude Code"
        subtitle="Providers"
      />,
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Providers" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
  });
});
