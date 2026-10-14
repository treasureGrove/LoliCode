import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { useEditorCloseGuard } from "@/hooks/useEditorCloseGuard";
import { discardUnsavedChanges } from "@/lib/unsavedChanges";
import { MotionSurface } from "@/components/motion/MotionSurface";

function Editor({ busy = false }: { busy?: boolean }) {
  const [open, setOpen] = useState(true);
  const { requestLeave, leaveDialog } = useEditorCloseGuard(open, busy);
  return (
    <FullScreenPanel
      isOpen={open}
      title="Draft"
      trackUnsavedChanges
      closeOnInputEscape
      onClose={() => requestLeave(() => setOpen(false))}
    >
      <input aria-label="Name" defaultValue="Original" />
      <button onClick={() => requestLeave(() => setOpen(false))}>
        Cancel draft
      </button>
      <button onClick={() => setOpen(false)}>Save success</button>
      {leaveDialog}
    </FullScreenPanel>
  );
}

afterEach(discardUnsavedChanges);

describe("editor close requests", () => {
  it("keeps the same input and its draft after canceling a leave request", async () => {
    render(<Editor />);
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.input(input, { target: { value: "My unfinished draft" } });
    fireEvent.click(screen.getByText("Cancel draft"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("common.unsavedLeaveCancel"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toBe(input);
    expect(input).toHaveValue("My unfinished draft");
    fireEvent.click(screen.getByText("Cancel draft"));
    fireEvent.click(screen.getByText("common.unsavedLeaveConfirm"));
    await waitFor(() =>
      expect(screen.queryByLabelText("Name")).not.toBeInTheDocument(),
    );
  });

  it("protects Escape from an input and closes directly only after a successful save", async () => {
    render(<Editor />);
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.input(input, { target: { value: "Keep this" } });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("common.unsavedLeaveCancel"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Save success"));
    await waitFor(() =>
      expect(screen.queryByLabelText("Name")).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("rejects a close request while a save is pending", () => {
    render(<Editor busy />);
    fireEvent.click(screen.getByText("Cancel draft"));
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

it("navigation animation does not remount a live form after ten changes", () => {
  const surface = (key: string) => (
    <MotionSurface motionKey={key}>
      <input aria-label="Live draft" defaultValue="Original" />
    </MotionSurface>
  );
  const view = render(surface("start"));
  const input = screen.getByLabelText("Live draft");
  fireEvent.input(input, { target: { value: "Still here" } });
  input.focus();
  for (let i = 0; i < 10; i++) view.rerender(surface(String(i)));
  expect(screen.getAllByLabelText("Live draft")).toHaveLength(1);
  expect(screen.getByLabelText("Live draft")).toBe(input);
  expect(input).toHaveValue("Still here");
  expect(input).toHaveFocus();
});
