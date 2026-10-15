import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentPaneResizeHandle,
  computeAgentPaneLayout,
  useAgentPaneLayout,
} from "@/components/agent/AgentPaneLayout";

const keys = [
  "lolicode.agent.layout.sidebarWidth",
  "lolicode.agent.layout.previewWidth",
];
const pointer = (
  target: Element | Node | Document | Window,
  type: string,
  x: number,
  id = 1,
  pointerType = "mouse",
) => {
  const event = new MouseEvent(type, {
    clientX: x,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: pointerType },
    isPrimary: { value: true },
  });
  fireEvent(target, event);
};

function Layout({
  sidebar = true,
  preview = true,
}: {
  sidebar?: boolean;
  preview?: boolean;
}) {
  const layout = useAgentPaneLayout({
    sidebarVisible: sidebar,
    previewVisible: preview,
  });
  return (
    <div ref={layout.containerRef}>
      <output data-testid="layout">
        {JSON.stringify({
          sidebarVisible: layout.sidebarVisible,
          sidebarWidth: layout.sidebarWidth,
          previewWidth: layout.previewWidth,
          chatMinimum: layout.chatMinimum,
        })}
      </output>
      {layout.sidebarVisible && (
        <AgentPaneResizeHandle {...layout.sidebarHandleProps} />
      )}
      {preview && <AgentPaneResizeHandle {...layout.previewHandleProps} />}
    </div>
  );
}
const layoutValue = () =>
  JSON.parse(screen.getByTestId("layout").textContent || "{}");

beforeEach(() => {
  keys.forEach((key) => localStorage.removeItem(key));
  vi.stubGlobal("innerWidth", 1000);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  keys.forEach((key) => localStorage.removeItem(key));
});

describe("Agent pane layout", () => {
  it("reserves usable chat space, clamps both panes and restores the sidebar after closing a narrow preview", () => {
    for (const width of [320, 620, 800, 1000, 1600]) {
      const result = computeAgentPaneLayout({
        width,
        sidebarVisible: true,
        previewVisible: true,
        sidebarPreferred: 99999,
        previewPreferred: 99999,
      });
      const handles = (Number(result.sidebarVisible) + 1) * 8;
      expect(
        width - result.sidebarWidth - result.previewWidth - handles,
      ).toBeGreaterThanOrEqual(result.chatMinimum - 1);
      expect(result.previewWidth).toBeGreaterThanOrEqual(result.previewMin);
    }
    const view = render(<Layout />);
    expect(layoutValue().sidebarVisible).toBe(true);
    act(() => {
      vi.stubGlobal("innerWidth", 620);
      fireEvent(window, new Event("resize"));
    });
    expect(layoutValue().sidebarVisible).toBe(false);
    expect(
      screen.queryByRole("separator", { name: "调整项目侧栏宽度" }),
    ).not.toBeInTheDocument();
    view.rerender(<Layout preview={false} />);
    expect(layoutValue().sidebarVisible).toBe(true);
  });

  it("supports direction keys and Home/End with opposite growth directions for the two panes", () => {
    render(<Layout />);
    const left = screen.getByRole("separator", { name: "调整项目侧栏宽度" });
    fireEvent.keyDown(left, { key: "ArrowRight" });
    expect(left).toHaveAttribute("aria-valuenow", "268");
    fireEvent.keyDown(left, { key: "Home" });
    expect(left).toHaveAttribute("aria-valuenow", "160");
    fireEvent.keyDown(left, { key: "End" });
    expect(Number(left.getAttribute("aria-valuenow"))).toBe(
      Number(left.getAttribute("aria-valuemax")),
    );
    const right = screen.getByRole("separator", { name: "调整预览宽度" });
    fireEvent.keyDown(right, { key: "Home" });
    expect(right).toHaveAttribute("aria-valuenow", "260");
    fireEvent.keyDown(left, { key: "Home" });
    const before = Number(right.getAttribute("aria-valuenow"));
    fireEvent.keyDown(right, { key: "ArrowLeft", shiftKey: true });
    expect(Number(right.getAttribute("aria-valuenow"))).toBe(before + 40);
  });

  it("drags across the iframe shield, ignores other pointers and restores existing selection styles on cancel", () => {
    document.body.style.setProperty("cursor", "wait", "important");
    document.body.style.setProperty("user-select", "text");
    render(<Layout />);
    const handle = screen.getByRole("separator", { name: "调整项目侧栏宽度" });
    pointer(handle, "pointerdown", 252, 7);
    expect(
      document.querySelector("[data-agent-pane-resize-shield]"),
    ).toBeInTheDocument();
    expect(document.body.style.userSelect).toBe("none");
    pointer(window, "pointermove", 312, 8);
    expect(handle).toHaveAttribute("aria-valuenow", "252");
    pointer(window, "pointermove", 312, 7);
    expect(handle).toHaveAttribute("aria-valuenow", "312");
    pointer(window, "pointercancel", 312, 7);
    expect(
      document.querySelector("[data-agent-pane-resize-shield]"),
    ).not.toBeInTheDocument();
    expect(document.body.style.getPropertyValue("cursor")).toBe("wait");
    expect(document.body.style.getPropertyPriority("cursor")).toBe("important");
    expect(document.body.style.userSelect).toBe("text");
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
  });

  it("handles touch drags and removes window listeners and the shield when unmounted mid-drag", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const view = render(<Layout sidebar={false} />);
    const handle = screen.getByRole("separator", { name: "调整预览宽度" });
    pointer(handle, "pointerdown", 500, 11, "touch");
    pointer(window, "pointermove", 450, 11, "touch");
    expect(handle).toHaveAttribute("aria-valuenow", "470");
    view.unmount();
    expect(
      document.querySelector("[data-agent-pane-resize-shield]"),
    ).not.toBeInTheDocument();
    expect(document.body.style.userSelect).not.toBe("none");
    expect(remove.mock.calls.some(([type]) => type === "pointermove")).toBe(
      true,
    );
    expect(remove.mock.calls.some(([type]) => type === "blur")).toBe(true);
  });

  it("keeps desired widths across remounts and clamps them on window resize without overwriting the preference", () => {
    const view = render(<Layout sidebar={false} />);
    const right = screen.getByRole("separator", { name: "调整预览宽度" });
    fireEvent.keyDown(right, { key: "ArrowLeft", shiftKey: true });
    expect(localStorage.getItem(keys[1])).toBe("460");
    view.unmount();
    const again = render(<Layout sidebar={false} />);
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "460",
    );
    act(() => {
      vi.stubGlobal("innerWidth", 620);
      fireEvent(window, new Event("resize"));
    });
    expect(
      Number(screen.getByRole("separator").getAttribute("aria-valuenow")),
    ).toBeLessThan(460);
    expect(localStorage.getItem(keys[1])).toBe("460");
    act(() => {
      vi.stubGlobal("innerWidth", 1200);
      fireEvent(window, new Event("resize"));
    });
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "460",
    );
    again.unmount();
  });

  it("still resizes when layout persistence is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    render(<Layout />);
    const left = screen.getByRole("separator", { name: "调整项目侧栏宽度" });
    fireEvent.keyDown(left, { key: "Home" });
    expect(left).toHaveAttribute("aria-valuenow", "160");
  });
});
