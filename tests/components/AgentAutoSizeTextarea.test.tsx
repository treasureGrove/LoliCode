import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentAutoSizeTextarea } from "@/features/agent/useAgentAutoSizeTextarea";

let height = 22;
let width = 300;
const observers: {
  callback: ResizeObserverCallback;
  disconnect: ReturnType<typeof vi.fn>;
}[] = [];
let original: PropertyDescriptor | undefined;
function Composer({
  value = "",
  visible = true,
}: {
  value?: string;
  visible?: boolean;
}) {
  const ref = useAgentAutoSizeTextarea(value);
  return visible ? (
    <textarea
      ref={ref}
      aria-label="draft"
      value={value}
      readOnly
      rows={1}
      style={{ padding: 0, border: 0, lineHeight: "22px" }}
    />
  ) : null;
}

beforeEach(() => {
  height = 22;
  width = 300;
  observers.length = 0;
  original = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "scrollHeight",
  );
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => height,
  });
  vi.spyOn(
    HTMLTextAreaElement.prototype,
    "getBoundingClientRect",
  ).mockImplementation(() => ({ width }) as DOMRect);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, disconnect: this.disconnect });
      }
    },
  );
});
afterEach(() => {
  if (original)
    Object.defineProperty(
      HTMLTextAreaElement.prototype,
      "scrollHeight",
      original,
    );
  else
    delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>)
      .scrollHeight;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Agent composer auto sizing", () => {
  it("starts with one compact line, grows to 150px and shrinks again when the draft is cleared", () => {
    const view = render(<Composer />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("rows", "1");
    expect(input).toHaveStyle({ height: "36px", overflowY: "hidden" });
    height = 240;
    view.rerender(<Composer value={"line\n".repeat(12)} />);
    expect(input).toHaveStyle({ height: "150px", overflowY: "auto" });
    height = 22;
    view.rerender(<Composer value="" />);
    expect(input).toHaveStyle({ height: "36px", overflowY: "hidden" });
  });

  it("measures an empty draft when the textarea appears conditionally", () => {
    const view = render(<Composer visible={false} />);
    view.rerender(<Composer />);
    expect(screen.getByRole("textbox")).toHaveStyle({ height: "36px" });
    expect(observers).toHaveLength(1);
  });

  it("remeasures wrapping when pane width changes and disconnects on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const view = render(
      <Composer value="A long draft that wraps differently after a pane resize" />,
    );
    const observer = observers[0];
    height = 88;
    width = 180;
    act(() => observer.callback([], {} as ResizeObserver));
    expect(screen.getByRole("textbox")).toHaveStyle({ height: "88px" });
    view.unmount();
    expect(observer.disconnect).toHaveBeenCalled();
    expect(remove.mock.calls.some(([type]) => type === "resize")).toBe(true);
  });
});
