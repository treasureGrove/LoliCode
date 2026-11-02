import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCompanion } from "@/features/agent/AgentCompanion";
import * as resourceImages from "@/app/shell/ResourcePackProvider";
import * as actorModule from "@/features/agent/CompanionRig";
import {
  COMPANION_STORAGE_KEY,
  FEED_COOLDOWN_MS,
  readCompanionState,
  saveCompanionState,
} from "@/lib/companion";
import {
  DEFAULT_INTERFACE_APPEARANCE,
  INTERFACE_APPEARANCE_KEY,
  saveInterfaceAppearance,
} from "@/lib/interfaceAppearance";

const NOW = 1_800_000_000_000;

// jsdom has no native PointerEvent; MouseEvent alone drops capture identifiers
// and isPrimary, hiding the code paths exercised by actual pointer gestures.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

function resize(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
  });
  fireEvent(window, new Event("resize"));
}

function pointer(
  element: HTMLElement,
  phase: "down" | "move" | "up" | "cancel",
  x: number,
  y: number,
  extra: PointerEventInit = {},
) {
  fireEvent(
    element,
    new TestPointerEvent(`pointer${phase}`, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      button: 0,
      buttons: phase === "up" || phase === "cancel" ? 0 : 1,
      clientX: x,
      clientY: y,
      ...extra,
    }),
  );
}

function mount() {
  const view = render(<AgentCompanion />);
  const character = screen.getByRole("button", { name: "companion.moveLabel" });
  const food = screen.getByRole("button", { name: "companion.foodLabel" });
  const root = view.container.querySelector<HTMLElement>(".lc-pet")!;
  vi.spyOn(character, "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 100,
    left: 100,
    top: 100,
    right: 220,
    bottom: 280,
    width: 120,
    height: 180,
    toJSON: () => ({}),
  });
  return { ...view, character, food, root };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("PointerEvent", TestPointerEvent);
  localStorage.removeItem(COMPANION_STORAGE_KEY);
  saveInterfaceAppearance(DEFAULT_INTERFACE_APPEARANCE);
  resize(1024, 768);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  saveCompanionState(readCompanionState());
  localStorage.removeItem(COMPANION_STORAGE_KEY);
  saveInterfaceAppearance(DEFAULT_INTERFACE_APPEARANCE);
  localStorage.removeItem(INTERFACE_APPEARANCE_KEY);
  vi.useRealTimers();
});

describe("floating companion gestures", () => {
  it("renders no floating controls when hidden and appears when enabled in appearance settings", () => {
    saveInterfaceAppearance({ companionVisible: false });
    const { container } = render(<AgentCompanion />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    act(() => saveInterfaceAppearance({ companionVisible: true }));
    expect(container.querySelector(".lc-pet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "companion.moveLabel" }),
    ).toBeInTheDocument();
  });

  it("removes the companion and care panel when hidden, retaining care when reenabled from settings", () => {
    const { container, food } = mount();
    fireEvent.click(food);
    fireEvent.click(screen.getByRole("button", { name: "companion.details" }));
    expect(
      screen.getByRole("region", { name: "companion.title" }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.atelier.hideCompanion" }),
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();

    act(() => saveInterfaceAppearance({ companionVisible: true }));
    expect(
      screen.getByRole("button", { name: "companion.details" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(readCompanionState()).toMatchObject({ feedCount: 1, affection: 2 });
    expect(
      screen.getByRole("button", { name: "companion.foodLabel" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("remembers a genuine pointer drag without also petting on the generated click", () => {
    const view = mount();
    const origin = {
      x: Number.parseFloat(view.root.style.left),
      y: Number.parseFloat(view.root.style.top),
    };
    pointer(view.character, "down", 150, 200);
    pointer(view.character, "move", 230, 160);
    expect(view.root).toHaveAttribute("data-dragging", "pet");
    pointer(view.character, "up", 230, 160);
    fireEvent.click(view.character);
    expect(view.root.style.left).toBe(`${origin.x + 80}px`);
    expect(view.root.style.top).toBe(`${origin.y - 40}px`);
    expect(readCompanionState()).toMatchObject({
      position: { x: origin.x + 80, y: origin.y - 40 },
      affection: 0,
    });
    expect(view.root).not.toHaveAttribute("data-dragging");
    view.unmount();
    const restored = mount();
    expect(restored.root.style.left).toBe(`${origin.x + 80}px`);
    expect(restored.root.style.top).toBe(`${origin.y - 40}px`);
  });

  it("feeds when food is dropped on the character, suppresses duplicate clicks and observes cooldown", () => {
    const { food, character } = mount();
    pointer(food, "down", 80, 350);
    pointer(food, "move", 155, 190);
    expect(character).toHaveAttribute("data-food-over", "true");
    pointer(food, "up", 155, 190);
    fireEvent.click(food);
    expect(readCompanionState()).toMatchObject({ feedCount: 1, affection: 2 });
    expect(food).toHaveAttribute("aria-disabled", "true");
    act(() => vi.advanceTimersByTime(500));
    fireEvent.click(food);
    expect(readCompanionState().feedCount).toBe(1);
    act(() => vi.advanceTimersByTime(FEED_COOLDOWN_MS));
    expect(food).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(food);
    expect(readCompanionState().feedCount).toBe(2);
  });

  it("does not feed when food misses, and treats a short character tap as petting", () => {
    const { food, character, container } = mount();
    pointer(food, "down", 80, 350);
    pointer(food, "move", 450, 350);
    pointer(food, "up", 450, 350);
    fireEvent.click(food);
    expect(readCompanionState().feedCount).toBe(0);
    expect(
      container.querySelector(".lc-pet-food-ghost"),
    ).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    pointer(character, "down", 150, 200);
    pointer(character, "move", 152, 202);
    pointer(character, "up", 152, 202);
    fireEvent.click(character);
    expect(readCompanionState().affection).toBe(1);
    fireEvent.click(character);
    expect(readCompanionState().affection).toBe(1);
  });

  it.each(["cancel", "blur", "escape", "buttons"] as const)(
    "restores an interrupted drag on %s and accepts a fresh gesture",
    (interruption) => {
      const { character, root } = mount();
      const origin = { left: root.style.left, top: root.style.top };
      pointer(character, "down", 150, 200);
      pointer(character, "move", 250, 250);
      if (interruption === "cancel") pointer(character, "cancel", 250, 250);
      if (interruption === "blur") fireEvent(window, new Event("blur"));
      if (interruption === "escape")
        fireEvent.keyDown(window, { key: "Escape" });
      if (interruption === "buttons")
        pointer(character, "move", 260, 260, { buttons: 0 });
      expect(root.style.left).toBe(origin.left);
      expect(root.style.top).toBe(origin.top);
      expect(root).not.toHaveAttribute("data-dragging");
      pointer(character, "move", 400, 400);
      expect(root.style.left).toBe(origin.left);
      pointer(character, "down", 150, 200);
      pointer(character, "move", 190, 160);
      pointer(character, "up", 190, 160);
      expect(root.style.left).toBe(`${Number.parseFloat(origin.left) + 40}px`);
      expect(root.style.top).toBe(`${Number.parseFloat(origin.top) - 40}px`);
    },
  );

  it("keeps the character reachable on a smaller viewport and after reopening", () => {
    const view = mount();
    pointer(view.character, "down", 150, 200);
    pointer(view.character, "move", 3000, 3000);
    pointer(view.character, "up", 3000, 3000);
    expect(Number.parseFloat(view.root.style.left)).toBeLessThan(1024 - 192);
    act(() => resize(360, 480));
    expect(view.root.style.left).toBe("160px");
    expect(view.root.style.top).toBe("222px");
    view.unmount();
    const restored = mount();
    expect(restored.root.style.left).toBe("160px");
    expect(restored.root.style.top).toBe("222px");
  });

  it("can sleep, wake for feeding, and fall asleep after five idle minutes", () => {
    const { root, food } = mount();
    fireEvent.click(screen.getByRole("button", { name: "companion.sleep" }));
    expect(root).toHaveAttribute("data-sleeping", "true");
    fireEvent.click(screen.getByRole("button", { name: "companion.wake" }));
    expect(root).toHaveAttribute("data-sleeping", "false");
    fireEvent.click(screen.getByRole("button", { name: "companion.sleep" }));
    fireEvent.click(food);
    expect(root).toHaveAttribute("data-sleeping", "false");
    act(() => vi.advanceTimersByTime(5 * 60_000));
    expect(root).toHaveAttribute("data-sleeping", "true");
    expect(readCompanionState().sleeping).toBe(true);
  });

  it.each([
    ["companion.foodLabel", "eating"],
    ["companion.moveLabel", "happy"],
  ])(
    "clears the %s reaction when immediately hidden and restored",
    (label, reaction) => {
      const { root, container } = mount();
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(root).toHaveAttribute("data-reaction", reaction);
      fireEvent.click(
        screen.getByRole("button", { name: "settings.atelier.hideCompanion" }),
      );
      expect(container).toBeEmptyDOMElement();
      act(() => saveInterfaceAppearance({ companionVisible: true }));
      const restoredRoot = container.querySelector(".lc-pet");
      expect(restoredRoot).toHaveAttribute("data-reaction", "idle");
      expect(container.querySelector(".lc-pet-hearts")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(2_000));
      expect(restoredRoot).toHaveAttribute("data-reaction", "idle");
    },
  );

  it("expires feeding cooldown on the first tick after a suspended browser resumes", () => {
    const { food } = mount();
    fireEvent.click(food);
    expect(food).toHaveAttribute("aria-disabled", "true");
    // Moving the wall clock does not execute intervals while the app is suspended.
    vi.setSystemTime(NOW + 45_000);
    act(() => vi.advanceTimersByTime(1_000));
    expect(food).toHaveAttribute("aria-disabled", "false");
    expect(food).not.toHaveTextContent(/\ds/);
    fireEvent.click(food);
    expect(readCompanionState().feedCount).toBe(2);
  });

  it("saves care immediately and batches passive persistence instead of writing every second", () => {
    const { food } = mount();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const petWrites = () =>
      writes.mock.calls.filter(([key]) => key === COMPANION_STORAGE_KEY);
    fireEvent.click(food);
    expect(petWrites()).toHaveLength(1);
    expect(
      JSON.parse(localStorage.getItem(COMPANION_STORAGE_KEY)!).feedCount,
    ).toBe(1);
    writes.mockClear();
    act(() => vi.advanceTimersByTime(59_000));
    expect(petWrites()).toHaveLength(0);
    act(() => vi.advanceTimersByTime(1_000));
    expect(petWrites()).toHaveLength(1);
    expect(
      JSON.parse(localStorage.getItem(COMPANION_STORAGE_KEY)!).updatedAt,
    ).toBe(NOW + 60_000);
  });

  it("consumes Escape for its panel or gesture before parent navigation, and leaves idle Escape alone", () => {
    const navigateBack = vi.fn();
    const onParentKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) navigateBack();
    };
    // App navigation can register first; the pet's capture listener must still
    // mark an owned Escape handled before the parent's ordinary listener runs.
    window.addEventListener("keydown", onParentKey);
    try {
      const { character, root } = mount();
      const escape = () => {
        const event = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        fireEvent(window, event);
        return event;
      };
      expect(escape().defaultPrevented).toBe(false);
      expect(navigateBack).toHaveBeenCalledTimes(1);

      const details = screen.getByRole("button", { name: "companion.details" });
      fireEvent.click(details);
      expect(details).toHaveAttribute("aria-expanded", "true");
      expect(escape().defaultPrevented).toBe(true);
      expect(details).toHaveAttribute("aria-expanded", "false");
      expect(navigateBack).toHaveBeenCalledTimes(1);

      pointer(character, "down", 150, 200);
      pointer(character, "move", 230, 170);
      expect(root).toHaveAttribute("data-dragging", "pet");
      expect(escape().defaultPrevented).toBe(true);
      expect(root).not.toHaveAttribute("data-dragging");
      expect(navigateBack).toHaveBeenCalledTimes(1);
      expect(escape().defaultPrevented).toBe(false);
      expect(navigateBack).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("keydown", onParentKey);
    }
  });

  it("routes care and real dragging to the painted action clips, then returns to idle", () => {
    const { root, character, food } = mount();
    expect(root).toHaveAttribute("data-motion", "idle");
    fireEvent.click(character);
    expect(root).toHaveAttribute("data-motion", "pet");
    act(() => vi.advanceTimersByTime(1800));
    expect(root).toHaveAttribute("data-motion", "idle");

    fireEvent.click(food);
    expect(root).toHaveAttribute("data-motion", "feed");
    act(() => vi.advanceTimersByTime(3199));
    expect(root).toHaveAttribute("data-motion", "feed");
    act(() => vi.advanceTimersByTime(1));
    expect(root).toHaveAttribute("data-motion", "idle");

    fireEvent.click(screen.getByRole("button", { name: "companion.sleep" }));
    expect(root).toHaveAttribute("data-motion", "sleep");
    act(() => vi.advanceTimersByTime(5000));
    expect(root).toHaveAttribute("data-motion", "sleep");
    fireEvent.click(screen.getByRole("button", { name: "companion.wake" }));
    act(() => vi.advanceTimersByTime(1800));
    expect(root).toHaveAttribute("data-motion", "idle");

    pointer(character, "down", 150, 200);
    pointer(character, "move", 152, 202);
    expect(root).toHaveAttribute("data-motion", "idle");
    pointer(character, "move", 230, 170);
    expect(root).toHaveAttribute("data-motion", "drag");
    pointer(character, "up", 230, 170);
    expect(root).toHaveAttribute("data-motion", "idle");
  });

  it("keeps a custom resource-pack character and never applies the bundled character atlas", () => {
    const custom = "data:image/png;base64,custom-resource-character";
    vi.spyOn(resourceImages, "useResourceImage").mockReturnValue(custom);
    const imageConstructor = vi.fn();
    vi.stubGlobal("Image", imageConstructor);
    const { root, character, food, container } = mount();
    expect(screen.getByRole("img")).toHaveAttribute("src", custom);
    expect(container.querySelector("canvas")).not.toBeInTheDocument();
    expect(imageConstructor).not.toHaveBeenCalled();

    fireEvent.click(character);
    expect(root).toHaveAttribute("data-motion", "pet");
    fireEvent.click(food);
    expect(root).toHaveAttribute("data-motion", "feed");
    fireEvent.click(screen.getByRole("button", { name: "companion.sleep" }));
    expect(root).toHaveAttribute("data-motion", "sleep");
    expect(screen.getByRole("img")).toHaveAttribute("src", custom);
    expect(container.querySelector("canvas")).not.toBeInTheDocument();
    expect(imageConstructor).not.toHaveBeenCalled();
  });

  it("does not interrupt or extend the feeding animation when food is clicked repeatedly during cooldown", () => {
    const renders = vi.spyOn(actorModule, "CompanionRig");
    const { root, food } = mount();
    fireEvent.click(food);
    const feedingKey = renders.mock.calls.at(-1)![0].playbackKey;
    expect(root).toHaveAttribute("data-reaction", "eating");
    for (let retry = 0; retry < 3; retry++) {
      act(() => vi.advanceTimersByTime(800));
      fireEvent.click(food);
      expect(root).toHaveAttribute("data-reaction", "eating");
      expect(root).toHaveAttribute("data-motion", "feed");
      expect(renders.mock.calls.at(-1)![0].playbackKey).toBe(feedingKey);
    }
    act(() => vi.advanceTimersByTime(799));
    fireEvent.click(food);
    expect(root).toHaveAttribute("data-motion", "feed");
    act(() => vi.advanceTimersByTime(1));
    expect(root).toHaveAttribute("data-reaction", "idle");
    expect(root).toHaveAttribute("data-motion", "idle");
    expect(readCompanionState()).toMatchObject({ feedCount: 1, affection: 2 });
  });

  it("replays repeated head pats while keeping the five-second affection cooldown", () => {
    const renders = vi.spyOn(actorModule, "CompanionRig");
    const { character, root } = mount();
    const initialKey = Number(renders.mock.calls.at(-1)![0].playbackKey);
    fireEvent.click(character);
    const firstKey = Number(renders.mock.calls.at(-1)![0].playbackKey);
    expect(firstKey).toBeGreaterThan(initialKey);
    expect(readCompanionState().affection).toBe(1);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.click(character);
    const secondKey = Number(renders.mock.calls.at(-1)![0].playbackKey);
    expect(secondKey).toBeGreaterThan(firstKey);
    expect(root).toHaveAttribute("data-motion", "pet");
    expect(readCompanionState().affection).toBe(1);
    act(() => vi.advanceTimersByTime(4899));
    fireEvent.click(character);
    expect(Number(renders.mock.calls.at(-1)![0].playbackKey)).toBeGreaterThan(
      secondKey,
    );
    expect(readCompanionState().affection).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    fireEvent.click(character);
    expect(readCompanionState().affection).toBe(2);
  });

  it("switches from sleep to a head-pat animation during affection cooldown without extra rewards", () => {
    const { character, root } = mount();
    fireEvent.click(character);
    const petted = readCompanionState();
    fireEvent.click(screen.getByRole("button", { name: "companion.sleep" }));
    expect(root).toHaveAttribute("data-motion", "sleep");
    fireEvent.click(character);
    expect(root).toHaveAttribute("data-sleeping", "false");
    expect(root).toHaveAttribute("data-motion", "pet");
    expect(readCompanionState()).toMatchObject({
      affection: petted.affection,
      mood: petted.mood,
    });
  });

  it("places care to the side in a short window, including after moving the character higher", () => {
    resize(900, 600);
    const { root, character } = mount();
    const open = () => {
      fireEvent.click(
        screen.getByRole("button", { name: "companion.details" }),
      );
      return screen.getByRole("region", { name: "companion.title" });
    };
    const bounds = (panel: HTMLElement) => {
      const left = Number.parseFloat(panel.style.left);
      const top = Number.parseFloat(panel.style.top);
      expect(left).toBeGreaterThanOrEqual(
        Number.parseFloat(root.style.left) + 192,
      );
      expect(left + 272).toBeLessThanOrEqual(900 - 8);
      expect(top).toBeGreaterThanOrEqual(8);
      expect(top + 326).toBeLessThanOrEqual(600 - 8);
    };
    bounds(open());
    fireEvent.click(
      screen.getByRole("button", { name: "companion.closeDetails" }),
    );
    pointer(character, "down", 150, 200);
    pointer(character, "move", 150, -60);
    pointer(character, "up", 150, -60);
    expect(Number.parseFloat(root.style.top)).toBeLessThan(100);
    bounds(open());
  });

  it("repositions from measured panel height and stays inside a narrow viewport after resizing", () => {
    resize(900, 600);
    const callbacks: ResizeObserverCallback[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect = disconnect;
      },
    );
    let measuredHeight = 326;
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (!this.classList.contains("lc-pet-panel"))
          return originalBounds.call(this);
        return {
          x: 0,
          y: 0,
          left: 0,
          top: 0,
          right: 272,
          bottom: measuredHeight,
          width: 272,
          height: measuredHeight,
          toJSON: () => ({}),
        };
      },
    );
    const view = mount();
    fireEvent.click(screen.getByRole("button", { name: "companion.details" }));
    const panel = screen.getByRole("region", { name: "companion.title" });
    measuredHeight = 420;
    act(() => callbacks[0]([], {} as ResizeObserver));
    expect(
      Number.parseFloat(panel.style.top) + measuredHeight,
    ).toBeLessThanOrEqual(600 - 8);
    act(() => resize(360, 480));
    const left = Number.parseFloat(panel.style.left);
    const top = Number.parseFloat(panel.style.top);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(left + 272).toBeLessThanOrEqual(360 - 8);
    expect(top + measuredHeight).toBeLessThanOrEqual(480 - 8);
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
