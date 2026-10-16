import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { Sheet, SheetContent, SheetPageContent, SheetTitle } from "./sheet";

describe.each(["dialog", "sheet", "page sheet"] as const)(
  "%s IME dismissal",
  (variant) => {
    it.each([{ isComposing: true }, { keyCode: 229 }])(
      "keeps the draft when Escape cancels composition, then closes on ordinary Escape: %o",
      (composition) => {
        const onOpenChange = vi.fn();
        const onEscapeKeyDown = vi.fn();
        const input = <input aria-label="Draft" defaultValue="樱花" />;
        const props = { "aria-describedby": undefined, onEscapeKeyDown };

        render(
          variant === "dialog" ? (
            <Dialog open onOpenChange={onOpenChange}>
              <DialogContent {...props}>
                <DialogTitle>Editor</DialogTitle>
                {input}
              </DialogContent>
            </Dialog>
          ) : (
            <Sheet open onOpenChange={onOpenChange}>
              {variant === "sheet" ? (
                <SheetContent closeLabel="Close" {...props}>
                  <SheetTitle>Editor</SheetTitle>
                  {input}
                </SheetContent>
              ) : (
                <SheetPageContent title="Editor" closeLabel="Back" {...props}>
                  {input}
                </SheetPageContent>
              )}
            </Sheet>
          ),
        );
        const draft = screen.getByRole("textbox", { name: "Draft" });
        draft.focus();
        fireEvent.keyDown(draft, { key: "Escape", ...composition });

        expect(onOpenChange).not.toHaveBeenCalled();
        expect(onEscapeKeyDown).not.toHaveBeenCalled();
        expect(draft).toHaveValue("樱花");
        expect(draft).toHaveFocus();

        fireEvent.keyDown(draft, { key: "Escape" });
        expect(onEscapeKeyDown).toHaveBeenCalledOnce();
        expect(onOpenChange).toHaveBeenCalledWith(false);
      },
    );
  },
);
