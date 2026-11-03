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
import * as actorModule from "@/features/agent/CompanionVideoActor";
import {
  COMPANION_REST_POSES,
  COMPANION_STANDING_FOOT_Y,
  type CompanionRest,
} from "@/features/agent/companionDocking";
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
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
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
    expect(
      container.querySelector(".lc-companion-video-actor"),
    ).toHaveAttribute("data-clip", "pet");
    expect(container.querySelector("video")).toHaveAttribute(
      "src",
      expect.stringContaining("companion-greeting-video-v4"),
    );
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

  it("keeps five-second video reactions intact and routes real dragging independently", () => {
    const { root, character, food } = mount();
    expect(root).toHaveAttribute("data-motion", "idle");
    fireEvent.click(character);
    expect(root).toHaveAttribute("data-motion", "pet");
    act(() => vi.advanceTimersByTime(1800));
    expect(root).toHaveAttribute("data-motion", "pet");
    act(() => vi.advanceTimersByTime(3400));
    expect(root).toHaveAttribute("data-motion", "idle");

    fireEvent.click(food);
    expect(root).toHaveAttribute("data-motion", "feed");
    act(() => vi.advanceTimersByTime(3199));
    expect(root).toHaveAttribute("data-motion", "feed");
    act(() => vi.advanceTimersByTime(2000));
    expect(root).toHaveAttribute("data-motion", "feed");
    act(() => vi.advanceTimersByTime(1));
    expect(root).toHaveAttribute("data-motion", "idle");

    fireEvent.click(screen.getByRole("button", { name: "companion.sleep" }));
    expect(root).toHaveAttribute("data-motion", "sleep");
    act(() => vi.advanceTimersByTime(5000));
    expect(root).toHaveAttribute("data-motion", "sleep");
    fireEvent.click(screen.getByRole("button", { name: "companion.wake" }));
    act(() => vi.advanceTimersByTime(5200));
    expect(root).toHaveAttribute("data-motion", "idle");

    pointer(character, "down", 150, 200);
    pointer(character, "move", 152, 202);
    expect(root).toHaveAttribute("data-motion", "idle");
    pointer(character, "move", 230, 170);
    expect(root).toHaveAttribute("data-motion", "drag");
    pointer(character, "up", 230, 170);
    expect(root).toHaveAttribute("data-motion", "idle");
  });

  it("keeps a custom resource-pack character without loading bundled videos or changing its reaction timing", () => {
    const custom = "data:image/png;base64,custom-resource-character";
    vi.spyOn(resourceImages, "useResourceImage").mockReturnValue(custom);
    const imageConstructor = vi.fn();
    vi.stubGlobal("Image", imageConstructor);
    const videoActor = vi.spyOn(actorModule, "CompanionVideoActor");
    const { root, character, food, container } = mount();
    expect(screen.getByRole("img")).toHaveAttribute("src", custom);
    expect(container.querySelector("canvas")).not.toBeInTheDocument();
    expect(container.querySelector("video")).not.toBeInTheDocument();
    expect(videoActor).not.toHaveBeenCalled();
    expect(imageConstructor).not.toHaveBeenCalled();

    fireEvent.click(character);
    expect(root).toHaveAttribute("data-motion", "pet");
    act(() => vi.advanceTimersByTime(1800));
    expect(root).toHaveAttribute("data-motion", "idle");
    fireEvent.click(food);
    expect(root).toHaveAttribute("data-motion", "feed");
    act(() => vi.advanceTimersByTime(3200));
    expect(root).toHaveAttribute("data-motion", "idle");
    fireEvent.click(screen.getByRole("button", { name: "companion.sleep" }));
    expect(root).toHaveAttribute("data-motion", "sleep");
    expect(screen.getByRole("img")).toHaveAttribute("src", custom);
    expect(container.querySelector("canvas")).not.toBeInTheDocument();
    expect(container.querySelector("video")).not.toBeInTheDocument();
    expect(videoActor).not.toHaveBeenCalled();
    expect(imageConstructor).not.toHaveBeenCalled();
  });

  it("does not interrupt or extend the feeding animation when food is clicked repeatedly during cooldown", () => {
    const renders = vi.spyOn(actorModule, "CompanionVideoActor");
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
    expect(root).toHaveAttribute("data-motion", "feed");
    act(() => vi.advanceTimersByTime(1999));
    expect(root).toHaveAttribute("data-motion", "feed");
    act(() => vi.advanceTimersByTime(1));
    expect(root).toHaveAttribute("data-reaction", "idle");
    expect(root).toHaveAttribute("data-motion", "idle");
    expect(readCompanionState()).toMatchObject({ feedCount: 1, affection: 2 });
  });

  it("replays repeated head pats while keeping the five-second affection cooldown", () => {
    const renders = vi.spyOn(actorModule, "CompanionVideoActor");
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

describe("companion surface docking", () => {
  const surfaces: HTMLElement[] = [];

  function addSurface(kind: CompanionRest = "sit") {
    const element = document.createElement("div");
    element.dataset.companionSurface = "message-session-a";
    element.dataset.companionDockId = "message-session-a";
    element.dataset.companionRest = kind;
    document.body.append(element);
    let bounds = { left: 100, top: 400, width: 500, height: 120 };
    vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => ({
      ...bounds,
      x: bounds.left,
      y: bounds.top,
      right: bounds.left + bounds.width,
      bottom: bounds.top + bounds.height,
      toJSON: () => ({}),
    }));
    surfaces.push(element);
    return {
      element,
      move(next: Partial<typeof bounds>) {
        bounds = { ...bounds, ...next };
      },
    };
  }

  function dragOntoSurface(view: ReturnType<typeof mount>) {
    const origin = {
      x: Number.parseFloat(view.root.style.left),
      y: Number.parseFloat(view.root.style.top),
    };
    const dx = 300 - 96 - origin.x;
    const dy = 400 - COMPANION_STANDING_FOOT_Y - origin.y;
    pointer(view.character, "down", 150, 200);
    pointer(view.character, "move", 150 + dx, 200 + dy);
    return () => pointer(view.character, "up", 150 + dx, 200 + dy);
  }

  afterEach(() => {
    surfaces.splice(0).forEach((element) => element.remove());
  });

  it.each(["sit", "lie"] as const)(
    "offers a %s target while dragging and switches to its own looping canvas on release",
    (kind) => {
      const { element } = addSurface(kind);
      const view = mount();
      const release = dragOntoSurface(view);
      expect(element).toHaveAttribute("data-companion-target", "true");
      expect(view.container.querySelector(".lc-pet-bubble")).toHaveTextContent(
        kind === "sit" ? "companion.dockHintSit" : "companion.dockHintLie",
      );
      release();
      const pose = COMPANION_REST_POSES[kind];
      expect(view.root).toHaveAttribute("data-docked", kind);
      expect(view.root).toHaveAttribute("data-settling", "true");
      expect(element).not.toHaveAttribute("data-companion-target");
      expect(
        Number.parseFloat(view.root.style.left) + pose.width * pose.contactX,
      ).toBe(300);
      expect(
        Number.parseFloat(view.root.style.top) +
          20 +
          pose.height * pose.contactY,
      ).toBe(400);
      expect(view.container.querySelector("video")).toHaveAttribute(
        "src",
        expect.stringContaining(`companion-${kind}-video-v5`),
      );
      expect(
        view.container.querySelector(".lc-companion-video-poster"),
      ).toHaveAttribute(
        "src",
        expect.stringContaining(`companion-${kind}-poster-v5`),
      );
      expect(
        view.container.querySelector(".lc-companion-video-actor"),
      ).toHaveAttribute("data-motion", "idle");
      expect(view.character).toHaveAttribute(
        "aria-describedby",
        "companion-dock-status",
      );
      expect(screen.getByText(/companion.leaveDockHint/)).toBeInTheDocument();
      // Rest positions are ephemeral; reopening starts from a safe standing pose.
      expect(readCompanionState().position).toEqual({
        x: 204,
        y: 400 - COMPANION_STANDING_FOOT_Y,
      });
      act(() => vi.advanceTimersByTime(320));
      expect(view.root).not.toHaveAttribute("data-settling");
    },
  );

  it("follows element resize and captured scroll without applying a standing clamp", () => {
    const callbacks: ResizeObserverCallback[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const surface = addSurface("lie");
    const view = mount();
    dragOntoSurface(view)();
    surface.move({ left: 200, top: 460, width: 600 });
    act(() => {
      callbacks[0]([], {} as ResizeObserver);
      vi.advanceTimersByTime(20);
    });
    expect(view.root).toHaveAttribute("data-docked", "lie");
    expect(view.root).not.toHaveAttribute("data-settling");
    const pose = COMPANION_REST_POSES.lie;
    expect(
      Number.parseFloat(view.root.style.left) + pose.width * pose.contactX,
    ).toBe(440);
    expect(
      Number.parseFloat(view.root.style.top) + 20 + pose.height * pose.contactY,
    ).toBe(460);
    surface.move({ top: 430 });
    act(() => {
      fireEvent.scroll(surface.element);
      vi.advanceTimersByTime(20);
    });
    expect(
      Number.parseFloat(view.root.style.top) + 20 + pose.height * pose.contactY,
    ).toBe(430);
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("uses the painted position when a fresh drag interrupts the settling transition", () => {
    addSurface("lie");
    const view = mount();
    dragOntoSurface(view)();
    expect(view.root).toHaveAttribute("data-settling", "true");
    vi.spyOn(view.root, "getBoundingClientRect").mockReturnValue({
      x: 250,
      y: 300,
      left: 250,
      top: 300,
      right: 490,
      bottom: 518,
      width: 240,
      height: 218,
      toJSON: () => ({}),
    });
    pointer(view.character, "down", 300, 330);
    pointer(view.character, "move", 310, 320);
    expect(view.root).not.toHaveAttribute("data-docked");
    expect(view.root).not.toHaveAttribute("data-settling");
    expect(view.root.style.left).toBe("284px");
    expect(view.root.style.top).toBe("290px");
    pointer(view.character, "up", 310, 320);
  });

  it("keeps its pose when the same session rebuilds a message and observes the new element", async () => {
    const observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {}
      },
    );
    const original = addSurface("sit");
    const view = mount();
    dragOntoSurface(view)();
    const replacement = addSurface("sit");
    replacement.move({ left: 200, top: 420, width: 600 });
    original.element.replaceWith(replacement.element);
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(20);
    });
    expect(view.root).toHaveAttribute("data-docked", "sit");
    expect(observed).toContain(replacement.element);
    const pose = COMPANION_REST_POSES.sit;
    expect(
      Number.parseFloat(view.root.style.left) + pose.width * pose.contactX,
    ).toBe(440);
    replacement.move({ top: 450 });
    act(() => {
      fireEvent.scroll(window);
      vi.advanceTimersByTime(20);
    });
    expect(
      Number.parseFloat(view.root.style.top) + 20 + pose.height * pose.contactY,
    ).toBe(450);
  });

  it("keeps exact edge contact on window resize and releases if the pose no longer fits", () => {
    const surface = addSurface("lie");
    const view = mount();
    dragOntoSurface(view)();
    surface.move({ top: 460 });
    act(() => resize(800, 520));
    const pose = COMPANION_REST_POSES.lie;
    expect(view.root).toHaveAttribute("data-docked", "lie");
    expect(
      Number.parseFloat(view.root.style.top) + 20 + pose.height * pose.contactY,
    ).toBe(460);
    act(() => resize(360, 480));
    expect(view.root).not.toHaveAttribute("data-docked");
    expect(Number.parseFloat(view.root.style.left)).toBeLessThanOrEqual(160);
    expect(Number.parseFloat(view.root.style.top)).toBeLessThanOrEqual(222);
  });

  it.each(["removed", "navigation", "offscreen"] as const)(
    "safely resumes standing when the surface is %s",
    async (reason) => {
      const surface = addSurface("lie");
      const view = mount();
      dragOntoSurface(view)();
      if (reason === "removed") surface.element.remove();
      if (reason === "navigation")
        surface.element.dataset.companionDockId = "message-session-b";
      if (reason === "offscreen") surface.move({ top: 20 });
      await act(async () => {
        await Promise.resolve();
        fireEvent.scroll(window);
        vi.advanceTimersByTime(20);
      });
      expect(view.root).not.toHaveAttribute("data-docked");
      expect(view.root.style.width).toBe("192px");
      expect(Number.parseFloat(view.root.style.left)).toBeGreaterThanOrEqual(8);
      expect(Number.parseFloat(view.root.style.top)).toBeGreaterThanOrEqual(8);
      expect(view.container.querySelector("video")).not.toHaveAttribute(
        "src",
        expect.stringContaining("companion-lie"),
      );
    },
  );

  it.each(["arrow", "drag", "pet", "feed"] as const)(
    "leaves its resting canvas before a %s interaction",
    (action) => {
      addSurface("lie");
      const view = mount();
      dragOntoSurface(view)();
      act(() => vi.advanceTimersByTime(500));
      if (action === "arrow")
        fireEvent.keyDown(view.character, { key: "ArrowRight" });
      if (action === "drag") {
        pointer(view.character, "down", 300, 300);
        pointer(view.character, "move", 380, 140);
        expect(view.root).not.toHaveAttribute("data-settling");
        pointer(view.character, "up", 380, 140);
      }
      if (action === "pet") fireEvent.click(view.character);
      if (action === "feed") {
        pointer(view.food, "down", 300, 270);
        pointer(view.food, "move", 155, 190);
        expect(view.character).toHaveAttribute("data-food-over", "true");
        pointer(view.food, "up", 155, 190);
        fireEvent.click(view.food);
      }
      expect(view.root).not.toHaveAttribute("data-docked");
      expect(view.root.style.width).toBe("192px");
      if (action === "feed") {
        expect(readCompanionState()).toMatchObject({
          feedCount: 1,
          affection: 2,
        });
        expect(view.container.querySelector("video")).toHaveAttribute(
          "src",
          expect.stringContaining("companion-feed-video-v4"),
        );
      }
      if (action === "pet") {
        expect(readCompanionState().affection).toBe(1);
        expect(view.container.querySelector("video")).toHaveAttribute(
          "src",
          expect.stringContaining("companion-greeting-video-v4"),
        );
      }
    },
  );

  it("retains custom resource-pack behavior without offering unsupported poses", () => {
    vi.spyOn(resourceImages, "useResourceImage").mockReturnValue("custom.png");
    const { element } = addSurface();
    const view = mount();
    dragOntoSurface(view)();
    expect(element).not.toHaveAttribute("data-companion-target");
    expect(view.root).not.toHaveAttribute("data-docked");
    expect(screen.getByRole("img")).toHaveAttribute("src", "custom.png");
    expect(view.container.querySelector("video")).toBeNull();
  });

  it("uses the resting poster for reduced motion and clears the dock and observers when hidden", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    addSurface("lie");
    const view = mount();
    dragOntoSurface(view)();
    expect(view.root).toHaveAttribute("data-docked", "lie");
    expect(view.container.querySelector("video")).toBeNull();
    expect(
      view.container.querySelector(".lc-companion-video-poster"),
    ).toHaveAttribute(
      "src",
      expect.stringContaining("companion-lie-poster-v5"),
    );
    act(() => saveInterfaceAppearance({ companionVisible: false }));
    expect(view.container).toBeEmptyDOMElement();
    act(() => saveInterfaceAppearance({ companionVisible: true }));
    expect(view.container.querySelector(".lc-pet")).not.toHaveAttribute(
      "data-docked",
    );
    expect(
      view.container.querySelector(".lc-companion-video-poster"),
    ).toHaveAttribute(
      "src",
      expect.stringContaining("companion-video-poster-v4"),
    );
    view.unmount();
    act(() => vi.advanceTimersByTime(0));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("quiet companion activities", () => {
  function settleCurrentClip(container: HTMLElement) {
    const current = container.querySelector("video")!;
    Object.defineProperty(current, "readyState", {
      configurable: true,
      value: 2,
    });
    Object.defineProperty(current, "duration", {
      configurable: true,
      value: 5,
    });
    fireEvent.loadedData(current);
    fireEvent.ended(current);
    const idle = container.querySelector("video")!;
    Object.defineProperty(idle, "readyState", { configurable: true, value: 2 });
    fireEvent.loadedData(idle);
  }

  it("waits at least 35 seconds and alternates the two quiet activities without changing care state", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const renders = vi.spyOn(actorModule, "CompanionVideoActor");
    const { container, root } = mount();
    settleCurrentClip(container);
    act(() => vi.advanceTimersByTime(34_999));
    expect(renders.mock.calls.at(-1)![0].ambient).toBeUndefined();
    act(() => vi.advanceTimersByTime(1));
    const first = renders.mock.calls.at(-1)![0].ambient!;
    expect(first.source).toContain("companion-snack-video-v4");
    expect(root).toHaveAttribute("data-motion", "idle");
    expect(readCompanionState()).toMatchObject({ feedCount: 0, affection: 0 });
    settleCurrentClip(container);
    act(() => vi.advanceTimersByTime(35_000));
    const second = renders.mock.calls.at(-1)![0].ambient!;
    expect(second.key).not.toBe(first.key);
    expect(second.source).toContain("companion-curious-video-v4");
    settleCurrentClip(container);
    act(() => vi.advanceTimersByTime(35_000));
    expect(renders.mock.calls.at(-1)![0].ambient!.source).toBe(first.source);
  });

  it("can leave a full minute between quiet activities", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const renders = vi.spyOn(actorModule, "CompanionVideoActor");
    const { container } = mount();
    settleCurrentClip(container);
    act(() => vi.advanceTimersByTime(59_999));
    expect(renders.mock.calls.at(-1)![0].ambient).toBeUndefined();
    act(() => vi.advanceTimersByTime(1));
    expect(renders.mock.calls.at(-1)![0].ambient?.source).toContain(
      "companion-curious-video-v4",
    );
  });

  it("gives recent user interaction twenty seconds of quiet", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const renders = vi.spyOn(actorModule, "CompanionVideoActor");
    const { character, container } = mount();
    settleCurrentClip(container);
    act(() => vi.advanceTimersByTime(20_000));
    fireEvent.click(character);
    act(() => vi.advanceTimersByTime(15_000));
    expect(renders.mock.calls.at(-1)![0].ambient).toBeUndefined();
    act(() => vi.advanceTimersByTime(35_000));
    expect(renders.mock.calls.at(-1)![0].ambient?.source).toContain(
      "companion-snack-video-v4",
    );
  });

  it.each(["hidden", "reduced", "sleep", "drag"] as const)(
    "does not schedule a quiet activity while %s",
    (reason) => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      vi.spyOn(document, "hidden", "get").mockReturnValue(reason === "hidden");
      if (reason === "reduced")
        vi.stubGlobal(
          "matchMedia",
          vi.fn(() => ({
            matches: true,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          })),
        );
      const renders = vi.spyOn(actorModule, "CompanionVideoActor");
      const { character } = mount();
      if (reason === "sleep")
        fireEvent.click(
          screen.getByRole("button", { name: "companion.sleep" }),
        );
      if (reason === "drag") {
        pointer(character, "down", 150, 200);
        pointer(character, "move", 230, 180);
      }
      act(() => vi.advanceTimersByTime(35_000));
      expect(renders.mock.calls.at(-1)![0].ambient).toBeUndefined();
    },
  );

  it("counts the end of a long drag as recent interaction", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const renders = vi.spyOn(actorModule, "CompanionVideoActor");
    const { character } = mount();
    pointer(character, "down", 150, 200);
    pointer(character, "move", 230, 180);
    act(() => vi.advanceTimersByTime(69_000));
    pointer(character, "up", 230, 180);
    act(() => vi.advanceTimersByTime(1_000));
    expect(renders.mock.calls.at(-1)![0].ambient).toBeUndefined();
    act(() => vi.advanceTimersByTime(35_000));
    expect(renders.mock.calls.at(-1)![0].ambient?.source).toContain(
      "companion-snack-video-v4",
    );
  });

  it("does not load quiet activities for a custom resource character", () => {
    vi.spyOn(resourceImages, "useResourceImage").mockReturnValue("custom.png");
    vi.spyOn(Math, "random").mockReturnValue(0);
    const renders = vi.spyOn(actorModule, "CompanionVideoActor");
    const { container } = mount();
    act(() => vi.advanceTimersByTime(120_000));
    expect(renders).not.toHaveBeenCalled();
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByRole("img")).toHaveAttribute("src", "custom.png");
  });

  it("clears activity timers on hiding and releases all timers on unmount", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const renders = vi.spyOn(actorModule, "CompanionVideoActor");
    const view = mount();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.atelier.hideCompanion" }),
    );
    const hiddenRenders = renders.mock.calls.length;
    act(() => vi.advanceTimersByTime(70_000));
    expect(renders).toHaveBeenCalledTimes(hiddenRenders);
    expect(view.container).toBeEmptyDOMElement();
    view.unmount();
    // jsdom delivers the final localStorage save as a zero-delay storage event.
    act(() => vi.advanceTimersByTime(0));
    expect(vi.getTimerCount()).toBe(0);
  });
});
