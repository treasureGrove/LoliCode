import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FullScreenPanel,
  FullScreenPanelHostContext,
  FullScreenPanelNavigationContext,
} from "@/components/common/FullScreenPanel";
import { DRAG_REGION_ENABLED } from "@/lib/platform";

const Panels = ({ innerOpen }: { innerOpen: boolean }) => (
  <>
    <FullScreenPanel isOpen title="Outer" onClose={() => undefined}>
      outer
    </FullScreenPanel>
    <FullScreenPanel isOpen={innerOpen} title="Inner" onClose={() => undefined}>
      inner
    </FullScreenPanel>
  </>
);

describe("FullScreenPanel motion", () => {
  it("is opaque from the first render, including after reopening", async () => {
    const panel = (isOpen: boolean) => (
      <FullScreenPanel isOpen={isOpen} title="Editor" onClose={() => undefined}>
        editor content
      </FullScreenPanel>
    );
    const view = render(panel(true));
    const surface = () => screen.getByText("editor content").closest(".bg-app");
    expect(surface()).toHaveStyle({ opacity: "1" });

    view.rerender(panel(false));
    // The departing surface is visual only while its short exit runs.
    const closing = screen.queryByText("editor content")?.closest(".bg-app");
    if (closing) {
      expect(closing).toHaveAttribute("aria-hidden", "true");
      expect((closing as HTMLElement).inert).toBe(true);
    }
    await waitFor(() =>
      expect(screen.queryByText("editor content")).toBeNull(),
    );

    view.rerender(panel(true));
    expect(surface()).toHaveStyle({ opacity: "1" });
  });

  it("keeps the explicit horizontal navigation transition", () => {
    render(
      <FullScreenPanel
        isOpen
        title="Authorization"
        onClose={() => undefined}
        motionPreset="slide-from-right"
      >
        authorization content
      </FullScreenPanel>,
    );
    const surface = screen
      .getByText("authorization content")
      .closest(".bg-app");
    expect(surface).toHaveStyle({ transform: "translateX(28px)" });
    expect(surface).not.toHaveStyle({ opacity: "0" });
  });

  it("keeps only the incoming controls interactive during a gentle panel switch", async () => {
    const toggleSidebar = vi.fn();
    const panels = (next: boolean) => (
      <FullScreenPanelNavigationContext.Provider
        value={<button onClick={toggleSidebar}>展开项目侧栏</button>}
      >
        <FullScreenPanel
          isOpen={!next}
          title="Plugins"
          onClose={() => undefined}
          motionPreset="fade"
        >
          <input aria-label="Plugin search" />
        </FullScreenPanel>
        <FullScreenPanel
          isOpen={next}
          title="Automation"
          onClose={() => undefined}
          motionPreset="fade"
        >
          <input aria-label="Workflow search" />
        </FullScreenPanel>
      </FullScreenPanelNavigationContext.Provider>
    );
    const view = render(panels(false));
    const outgoing = screen.getByRole("region", { name: "Plugins" });
    await waitFor(() => expect(outgoing).toHaveStyle({ opacity: "1" }));
    view.rerender(panels(true));
    const incoming = screen.getByRole("region", { name: "Automation" });
    expect(outgoing.inert).toBe(true);
    expect(outgoing).toHaveAttribute("aria-hidden", "true");
    expect(incoming.inert).toBe(false);
    expect(
      screen.getAllByRole("button", { name: "展开项目侧栏" }),
    ).toHaveLength(1);
    const toggle = screen.getByRole("button", { name: "展开项目侧栏" });
    toggle.focus();
    expect(toggle).toHaveFocus();
    fireEvent.click(toggle);
    expect(toggleSidebar).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.queryByLabelText("Plugin search")).toBeNull(),
    );
    expect(incoming.inert).toBe(false);
  });
});

describe("FullScreenPanel interaction lifecycle", () => {
  it("keeps embedded workspace navigation usable while covering only its chat surface", async () => {
    const appHost = document.createElement("main");
    appHost.id = "content-area";
    const appPage = document.createElement("div");
    appPage.className = "tai-page";
    appPage.inert = false;
    const navigation = document.createElement("nav");
    navigation.setAttribute("aria-label", "Workspace navigation");
    const trigger = document.createElement("button");
    trigger.textContent = "Open automation";
    navigation.append(trigger);
    const chatHost = document.createElement("main");
    chatHost.id = "agent-content-area";
    const chatSurface = document.createElement("div");
    chatSurface.setAttribute("data-panel-background", "");
    chatSurface.inert = false;
    chatHost.append(chatSurface);
    appPage.append(navigation, chatHost);
    appHost.append(appPage);
    document.body.append(appHost);
    trigger.focus();
    const panel = (isOpen: boolean) => (
      <FullScreenPanelHostContext.Provider value="agent-content-area">
        <FullScreenPanelNavigationContext.Provider
          value={<button>展开项目侧栏</button>}
        >
          <FullScreenPanel
            isOpen={isOpen}
            title="Automation"
            onClose={() => undefined}
            motionPreset="none"
          >
            <input aria-label="Automation name" />
          </FullScreenPanel>
        </FullScreenPanelNavigationContext.Provider>
      </FullScreenPanelHostContext.Provider>
    );
    const view = render(panel(true));
    try {
      const surface = screen.getByRole("region", { name: "Automation" });
      expect(surface.parentElement).toBe(chatHost);
      expect(surface).toHaveClass("absolute");
      expect(chatSurface.inert).toBe(true);
      expect(appPage.inert).toBe(false);
      expect(navigation.closest("[inert]")).toBeNull();
      expect(surface).toHaveFocus();
      const restoreNavigation = screen.getByRole("button", {
        name: "展开项目侧栏",
      });
      expect(surface).toContainElement(restoreNavigation);
      restoreNavigation.focus();
      expect(restoreNavigation).toHaveFocus();
      expect(restoreNavigation.closest("[inert]")).toBeNull();
      trigger.focus();
      expect(trigger).toHaveFocus();
      surface.focus();
      view.rerender(panel(false));
      await waitFor(() =>
        expect(screen.queryByLabelText("Automation name")).toBeNull(),
      );
      expect(chatSurface.inert).toBe(false);
      expect(trigger).toHaveFocus();
    } finally {
      view.unmount();
      appHost.remove();
    }
  });

  it("preserves the existing input Escape behavior unless the editor opts in", () => {
    const close = vi.fn();
    render(
      <FullScreenPanel
        isOpen
        title="Legacy editor"
        onClose={close}
        trackUnsavedChanges
      >
        <input aria-label="Unsaved model name" defaultValue="Original" />
      </FullScreenPanel>,
    );
    const input = screen.getByLabelText("Unsaved model name");
    fireEvent.input(input, { target: { value: "My unsaved change" } });
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(input).toHaveValue("My unsaved change");
    expect(input).toHaveFocus();
  });

  it("gives only the top panel Escape and restores the parent after a nested close", async () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    const panels = (innerOpen: boolean) => (
      <>
        <FullScreenPanel isOpen title="Outer editor" onClose={closeOuter}>
          <input aria-label="Outer draft" />
        </FullScreenPanel>
        <FullScreenPanel
          isOpen={innerOpen}
          title="Inner editor"
          onClose={closeInner}
        >
          <input aria-label="Inner draft" />
        </FullScreenPanel>
      </>
    );
    const view = render(panels(true));
    const outer = screen
      .getByLabelText("Outer draft")
      .closest(".tai-editor-panel") as HTMLElement;
    const inner = screen
      .getByLabelText("Inner draft")
      .closest(".tai-editor-panel") as HTMLElement;
    expect(outer.inert).toBe(true);
    expect(inner.inert).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeInner).toHaveBeenCalledOnce();
    expect(closeOuter).not.toHaveBeenCalled();

    view.rerender(panels(false));
    await waitFor(() =>
      expect(screen.queryByLabelText("Inner draft")).toBeNull(),
    );
    expect(outer.inert).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeOuter).toHaveBeenCalledOnce();
  });

  it("keeps a nested panel on top when both levels mount in the same commit", () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <FullScreenPanel isOpen title="Parent" onClose={closeOuter}>
        parent content
        <FullScreenPanel isOpen title="Child" onClose={closeInner}>
          child content
        </FullScreenPanel>
      </FullScreenPanel>,
    );
    const inner = screen
      .getByText("child content")
      .closest(".tai-editor-panel") as HTMLElement;
    expect(inner.inert).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeInner).toHaveBeenCalledOnce();
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it("lets an inner control consume Escape without closing its editor", () => {
    const close = vi.fn();
    render(
      <FullScreenPanel isOpen title="Editor" onClose={close}>
        <input
          aria-label="Combobox input"
          onKeyDown={(event) => event.preventDefault()}
        />
      </FullScreenPanel>,
    );
    fireEvent.keyDown(screen.getByLabelText("Combobox input"), {
      key: "Escape",
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("removes exiting form IDs from the live namespace when another editor opens", async () => {
    const panels = (next: boolean) => (
      <>
        <FullScreenPanel
          isOpen={!next}
          title="First editor"
          onClose={() => undefined}
        >
          <form id="provider-form">
            <input id="provider-name" aria-label="First provider name" />
          </form>
        </FullScreenPanel>
        <FullScreenPanel
          isOpen={next}
          title="Next editor"
          onClose={() => undefined}
        >
          <form id="provider-form">
            <input id="provider-name" aria-label="Next provider name" />
          </form>
        </FullScreenPanel>
      </>
    );
    const view = render(panels(false));
    view.rerender(panels(true));
    expect(document.querySelectorAll('[id="provider-form"]')).toHaveLength(1);
    expect(document.querySelectorAll('[id="provider-name"]')).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "First editor" })).toBeNull();
    expect(screen.getByRole("region", { name: "Next editor" })).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByLabelText("First provider name")).toBeNull(),
    );
  });

  it("reverses a close into the same live editor without resetting its input or IDs", () => {
    const panel = (isOpen: boolean) => (
      <FullScreenPanel
        isOpen={isOpen}
        title="Reopened editor"
        onClose={() => undefined}
      >
        <input
          id="reopened-draft"
          aria-label="Reopened draft"
          defaultValue=""
        />
      </FullScreenPanel>
    );
    const view = render(panel(true));
    const input = screen.getByLabelText("Reopened draft");
    fireEvent.input(input, { target: { value: "Preserve this draft" } });
    view.rerender(panel(false));
    view.rerender(panel(true));
    expect(screen.getByLabelText("Reopened draft")).toBe(input);
    expect(input).toHaveValue("Preserve this draft");
    expect(document.querySelectorAll('[id="reopened-draft"]')).toHaveLength(1);
    const surface = screen.getByRole("region", { name: "Reopened editor" });
    expect(surface.inert).toBe(false);
    expect(surface).not.toHaveAttribute("aria-hidden");
  });

  it("restores the trigger focus and existing inert state after closing", async () => {
    const host = document.createElement("main");
    host.id = "content-area";
    const page = document.createElement("div");
    page.className = "tai-page";
    page.inert = false;
    const trigger = document.createElement("button");
    trigger.textContent = "Open editor";
    page.append(trigger);
    host.append(page);
    document.body.append(host);
    trigger.focus();
    const panel = (isOpen: boolean) => (
      <FullScreenPanel
        isOpen={isOpen}
        title="Focus editor"
        onClose={() => undefined}
      >
        <input aria-label="Provider draft" />
      </FullScreenPanel>
    );
    const view = render(panel(true));
    try {
      expect(page.inert).toBe(true);
      expect(
        screen.getByRole("region", { name: "Focus editor" }),
      ).toHaveFocus();
      view.rerender(panel(false));
      await waitFor(() =>
        expect(screen.queryByLabelText("Provider draft")).toBeNull(),
      );
      expect(page.inert).toBe(false);
      expect(trigger).toHaveFocus();
    } finally {
      view.unmount();
      host.remove();
    }
  });

  it("does not unlock the covered page until the exit surface is gone", async () => {
    const host = document.createElement("main");
    host.id = "content-area";
    const page = document.createElement("div");
    page.className = "tai-page";
    page.inert = false;
    host.append(page);
    document.body.append(host);
    const panel = (isOpen: boolean) => (
      <FullScreenPanel
        isOpen={isOpen}
        title="Exit editor"
        onClose={() => undefined}
      >
        outgoing editor
      </FullScreenPanel>
    );
    const view = render(panel(true));
    try {
      view.rerender(panel(false));
      if (screen.queryByText("outgoing editor")) expect(page.inert).toBe(true);
      await waitFor(() =>
        expect(screen.queryByText("outgoing editor")).toBeNull(),
      );
      expect(page.inert).toBe(false);
    } finally {
      view.unmount();
      host.remove();
    }
  });
});

describe("FullScreenPanel body scroll locking", () => {
  afterEach(() => {
    document.body.style.overflow = "";
  });

  it("keeps the body locked when a nested panel closes", () => {
    document.body.style.overflow = "clip";
    const view = render(<Panels innerOpen />);

    expect(document.body.style.overflow).toBe("hidden");

    view.rerender(<Panels innerOpen={false} />);
    expect(document.body.style.overflow).toBe("hidden");

    view.unmount();
    expect(document.body.style.overflow).toBe("clip");
  });
});

describe("FullScreenPanel header", () => {
  it("keeps a long editor title and its action accessible", () => {
    const title = "Edit " + "a-very-long-user-provided-name-".repeat(8);
    render(
      <FullScreenPanel
        isOpen
        title={title}
        onClose={() => undefined}
        actions={<button>Save editor</button>}
      >
        body
      </FullScreenPanel>,
    );
    const heading = screen.getByRole("heading", { name: title });
    expect(heading).toHaveTextContent(title);
    expect(heading).toHaveClass("truncate");
    const save = screen.getByRole("button", { name: "Save editor" });
    save.focus();
    expect(save).toHaveFocus();
    expect(save).not.toHaveAttribute("data-tauri-drag-region");
  });

  it("keeps the whole title area as a window drag region", () => {
    render(
      <FullScreenPanel isOpen title="Edit MCP" onClose={() => undefined}>
        body
      </FullScreenPanel>,
    );
    const heading = screen.getByRole("heading", { name: "Edit MCP" });
    // Tauri 只认按下的元素自身带属性：标题和铺满页头的标题区都得带
    for (const element of [heading, heading.parentElement!]) {
      expect(element.hasAttribute("data-tauri-drag-region")).toBe(
        DRAG_REGION_ENABLED,
      );
    }
    expect(
      screen.getByRole("button", { name: "common.back" }),
    ).not.toHaveAttribute("data-tauri-drag-region");
  });
});
