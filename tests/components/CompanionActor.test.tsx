import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompanionActor,
  type CompanionActorLayout,
} from "@/features/agent/CompanionActor";

const SOURCE = "data:image/png;base64,atlas";
const FALLBACK = "data:image/png;base64,standing";
const layout: CompanionActorLayout = {
  columns: 3,
  rows: 5,
  frameWidth: 40,
  frameHeight: 60,
  clips: {
    idle: { row: 0, frames: 3, durations: [100, 200, 300], loop: true },
    feed: { row: 1, frames: 3, durations: [100, 200, 300], loop: false },
    pet: { row: 2, frames: 3, durations: [100, 200, 300], loop: false },
    sleep: { row: 3, frames: 3, durations: [200, 300, 400], loop: true },
    drag: { row: 4, frames: 3, durations: [100, 100, 100], loop: true },
  },
};
const loads: { resolve: () => void; reject: (reason: Error) => void }[] = [];
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
let hidden = false;
let reduced = false;
let preferenceChanged: (() => void) | null = null;
const drawImage = vi.fn();
const drawStates: { args: unknown[]; alpha: number; operation: string }[] = [];
const context = {
  drawImage,
  clearRect: vi.fn(),
  setTransform: vi.fn(),
  imageSmoothingEnabled: false,
  globalAlpha: 1,
  globalCompositeOperation: "source-over",
};

async function decode() {
  await act(async () => {
    loads.at(-1)!.resolve();
  });
}
function step(time: number) {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(time);
  });
}
function lastSourceFrame() {
  return drawImage.mock.calls.at(-1)?.slice(1, 5);
}

beforeEach(() => {
  loads.length = 0;
  frames.clear();
  frameId = 0;
  hidden = false;
  reduced = false;
  preferenceChanged = null;
  drawStates.length = 0;
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  drawImage.mockImplementation((...args: unknown[]) => {
    drawStates.push({
      args,
      alpha: context.globalAlpha,
      operation: context.globalCompositeOperation,
    });
  });
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.stubGlobal("devicePixelRatio", 100);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => {
      frames.delete(id);
    }),
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return reduced;
      },
      addEventListener: (_type: string, listener: () => void) => {
        preferenceChanged = listener;
      },
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 120;
      naturalHeight = 300;
      src = "";
      decoding = "";
      onload = null;
      onerror = null;
      decode() {
        return new Promise<void>((resolve, reject) =>
          loads.push({ resolve, reject }),
        );
      }
    },
  );
  drawImage.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("companion motion actor", () => {
  it("keeps one accessible fallback until decoding and follows variable frame durations without React updates", async () => {
    const { unmount } = render(
      <CompanionActor
        source={SOURCE}
        fallback={FALLBACK}
        alt="Companion"
        motion="idle"
        layout={layout}
      />,
    );
    expect(screen.getByRole("img")).toHaveAttribute("src", FALLBACK);
    await decode();
    const canvas = screen.getByRole("img") as HTMLCanvasElement;
    expect(canvas.tagName).toBe("CANVAS");
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(canvas.width).toBe(80);
    expect(canvas.height).toBe(120);
    expect(lastSourceFrame()).toEqual([0, 0, 40, 60]);
    step(0);
    step(99);
    expect(lastSourceFrame()).toEqual([0, 0, 40, 60]);
    step(100);
    expect(lastSourceFrame()).toEqual([40, 0, 40, 60]);
    step(300);
    expect(lastSourceFrame()).toEqual([80, 0, 40, 60]);
    step(600);
    expect(lastSourceFrame()).toEqual([0, 0, 40, 60]);
    expect(screen.getByRole("img")).toBe(canvas);
    expect(loads).toHaveLength(1);
    unmount();
    expect(frames.size).toBe(0);
  });

  it("switches to a decoded action row immediately and stops a non-looping clip on its last frame", async () => {
    const props = {
      source: SOURCE,
      fallback: FALLBACK,
      alt: "Companion",
      layout,
      transitionMs: 0,
    };
    const { rerender } = render(<CompanionActor {...props} motion="idle" />);
    await decode();
    const canvas = screen.getByRole("img");
    step(0);
    step(100);
    rerender(<CompanionActor {...props} motion="feed" />);
    expect(lastSourceFrame()).toEqual([0, 60, 40, 60]);
    expect(screen.getByRole("img")).toBe(canvas);
    expect(loads).toHaveLength(1);
    step(100);
    step(700);
    expect(lastSourceFrame()).toEqual([80, 60, 40, 60]);
    expect(frames.size).toBe(0);
    rerender(<CompanionActor {...props} motion="sleep" />);
    expect(lastSourceFrame()).toEqual([0, 180, 40, 60]);
  });

  it("pauses in a hidden document and resumes without jumping across suspended time", async () => {
    render(
      <CompanionActor
        source={SOURCE}
        fallback={FALLBACK}
        alt="Companion"
        motion="idle"
        layout={layout}
      />,
    );
    await decode();
    step(0);
    step(100);
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
    expect(frames.size).toBe(0);
    step(50_000);
    expect(lastSourceFrame()).toEqual([40, 0, 40, 60]);
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    step(50_000);
    expect(lastSourceFrame()).toEqual([40, 0, 40, 60]);
    step(50_200);
    expect(lastSourceFrame()).toEqual([80, 0, 40, 60]);
  });

  it("does not restart motion when a parent recreates equivalent layout metadata", async () => {
    const props = {
      source: SOURCE,
      fallback: FALLBACK,
      alt: "Companion",
      motion: "idle" as const,
    };
    const { rerender } = render(<CompanionActor {...props} layout={layout} />);
    await decode();
    step(0);
    step(100);
    expect(lastSourceFrame()).toEqual([40, 0, 40, 60]);
    const draws = drawImage.mock.calls.length;
    rerender(
      <CompanionActor {...props} layout={JSON.parse(JSON.stringify(layout))} />,
    );
    expect(drawImage).toHaveBeenCalledTimes(draws);
    expect(loads).toHaveLength(1);
    step(300);
    expect(lastSourceFrame()).toEqual([80, 0, 40, 60]);
  });

  it("draws only the first action frame for reduced motion and responds to preference changes", async () => {
    reduced = true;
    const props = {
      source: SOURCE,
      fallback: FALLBACK,
      alt: "Companion",
      layout,
    };
    const { rerender } = render(<CompanionActor {...props} motion="idle" />);
    await decode();
    expect(lastSourceFrame()).toEqual([0, 0, 40, 60]);
    expect(frames.size).toBe(0);
    rerender(<CompanionActor {...props} motion="pet" />);
    expect(lastSourceFrame()).toEqual([0, 120, 40, 60]);
    expect(frames.size).toBe(0);
    reduced = false;
    act(() => preferenceChanged?.());
    step(0);
    step(100);
    expect(lastSourceFrame()).toEqual([40, 120, 40, 60]);
    reduced = true;
    act(() => preferenceChanged?.());
    expect(lastSourceFrame()).toEqual([0, 120, 40, 60]);
    expect(frames.size).toBe(0);
  });

  it("retains the original accessible artwork when decode fails or layout is missing", async () => {
    const props = {
      source: SOURCE,
      fallback: FALLBACK,
      alt: "Companion",
      motion: "idle" as const,
    };
    const { rerender } = render(<CompanionActor {...props} layout={layout} />);
    await act(async () => {
      loads.at(-1)!.reject(new Error("invalid atlas"));
    });
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByRole("img")).toHaveAttribute("src", FALLBACK);
    expect(frames.size).toBe(0);
    rerender(<CompanionActor {...props} />);
    expect(screen.getByRole("img")).toHaveAttribute("src", FALLBACK);
    expect(loads).toHaveLength(1);
  });

  it("dissolves only action changes with complementary alpha, reusing a single previous-frame buffer", async () => {
    const props = {
      source: SOURCE,
      fallback: FALLBACK,
      alt: "Companion",
      layout,
    };
    const { rerender } = render(<CompanionActor {...props} motion="idle" />);
    await decode();
    const canvas = screen.getByRole("img");
    step(0);
    step(100);
    const create = vi.spyOn(document, "createElement");
    rerender(<CompanionActor {...props} motion="feed" />);
    expect(canvas).toHaveAttribute("data-transitioning", "true");
    expect(screen.getByRole("img")).toBe(canvas);
    step(100);
    drawStates.length = 0;
    step(160);
    expect(drawStates).toHaveLength(2);
    expect(
      drawStates.map(({ alpha, operation }) => [alpha, operation]),
    ).toEqual([
      [0.5, "source-over"],
      [0.5, "lighter"],
    ]);
    expect(drawStates[0].args[0]).toBeInstanceOf(HTMLCanvasElement);
    expect(drawStates[1].args.slice(1, 5)).toEqual([0, 60, 40, 60]);
    step(220);
    expect(canvas).toHaveAttribute("data-transitioning", "false");
    drawStates.length = 0;
    step(320);
    // Ordinary frame advancement draws one opaque source frame, with no echo.
    expect(drawStates).toHaveLength(1);
    expect(drawStates[0].alpha).toBe(1);
    expect(drawStates[0].operation).toBe("source-over");
    expect(lastSourceFrame()).toEqual([40, 60, 40, 60]);
    rerender(<CompanionActor {...props} motion="pet" />);
    step(320);
    step(440);
    expect(create.mock.calls.filter(([tag]) => tag === "canvas")).toHaveLength(
      1,
    );
    expect(loads).toHaveLength(1);
  });

  it("restarts a repeated action when playbackKey changes without reloading its atlas", async () => {
    const props = {
      source: SOURCE,
      fallback: FALLBACK,
      alt: "Companion",
      layout,
      motion: "feed" as const,
      transitionMs: 0,
    };
    const { rerender } = render(<CompanionActor {...props} playbackKey={1} />);
    await decode();
    step(0);
    step(300);
    expect(lastSourceFrame()).toEqual([80, 60, 40, 60]);
    rerender(<CompanionActor {...props} playbackKey={2} />);
    expect(lastSourceFrame()).toEqual([0, 60, 40, 60]);
    step(300);
    step(400);
    expect(lastSourceFrame()).toEqual([40, 60, 40, 60]);
    const draws = drawImage.mock.calls.length;
    rerender(<CompanionActor {...props} playbackKey={2} />);
    expect(drawImage).toHaveBeenCalledTimes(draws);
    expect(loads).toHaveLength(1);
  });

  it("skips a hidden action transition and completes an in-flight dissolve when reduced motion is enabled", async () => {
    const props = {
      source: SOURCE,
      fallback: FALLBACK,
      alt: "Companion",
      layout,
    };
    const { rerender } = render(<CompanionActor {...props} motion="idle" />);
    await decode();
    const canvas = screen.getByRole("img");
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
    rerender(<CompanionActor {...props} motion="feed" />);
    expect(lastSourceFrame()).toEqual([0, 60, 40, 60]);
    expect(canvas).toHaveAttribute("data-transitioning", "false");
    expect(frames.size).toBe(0);
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    rerender(<CompanionActor {...props} motion="pet" />);
    expect(canvas).toHaveAttribute("data-transitioning", "true");
    reduced = true;
    act(() => preferenceChanged?.());
    expect(lastSourceFrame()).toEqual([0, 120, 40, 60]);
    expect(canvas).toHaveAttribute("data-transitioning", "false");
    expect(context.globalAlpha).toBe(1);
    expect(frames.size).toBe(0);
  });

  it("falls back during a source change and never mixes artwork from different characters", async () => {
    const props = { fallback: FALLBACK, alt: "Companion", layout };
    const { rerender } = render(
      <CompanionActor {...props} source={SOURCE} motion="idle" />,
    );
    await decode();
    rerender(
      <CompanionActor
        {...props}
        source="data:image/png;base64,other-character"
        motion="pet"
      />,
    );
    expect(screen.getByRole("img")).toHaveAttribute("src", FALLBACK);
    drawStates.length = 0;
    await decode();
    const canvas = screen.getByRole("img");
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas).toHaveAttribute("data-transitioning", "false");
    expect(drawStates).toHaveLength(1);
    expect(drawStates[0].alpha).toBe(1);
    expect(drawStates[0].args[0]).not.toBeInstanceOf(HTMLCanvasElement);
  });

  it("plays non-contiguous and repeated source columns while tracking the playback step", async () => {
    const ordered: CompanionActorLayout = {
      ...layout,
      clips: {
        ...layout.clips,
        idle: {
          row: 0,
          frames: 5,
          durations: [100, 100, 100, 100, 100],
          loop: true,
          sequence: [2, 0, 2, 2, 1],
        },
      },
    };
    render(
      <CompanionActor
        source={SOURCE}
        fallback={FALLBACK}
        alt="Companion"
        motion="idle"
        layout={ordered}
      />,
    );
    await decode();
    const canvas = screen.getByRole("img");
    expect(lastSourceFrame()).toEqual([80, 0, 40, 60]);
    expect(canvas).toHaveAttribute("data-frame", "0");
    expect(canvas).toHaveAttribute("data-source-frame", "2");
    step(0);
    step(100);
    expect(lastSourceFrame()).toEqual([0, 0, 40, 60]);
    expect(canvas).toHaveAttribute("data-frame", "1");
    step(200);
    expect(lastSourceFrame()).toEqual([80, 0, 40, 60]);
    step(300);
    expect(lastSourceFrame()).toEqual([80, 0, 40, 60]);
    expect(canvas).toHaveAttribute("data-frame", "3");
    expect(canvas).toHaveAttribute("data-source-frame", "2");
    step(400);
    expect(lastSourceFrame()).toEqual([40, 0, 40, 60]);
    step(500);
    expect(lastSourceFrame()).toEqual([80, 0, 40, 60]);
    expect(canvas).toHaveAttribute("data-frame", "0");
  });

  it("allows a returning action to have more playback steps than source columns", async () => {
    const ordered: CompanionActorLayout = {
      ...layout,
      clips: {
        ...layout.clips,
        pet: {
          row: 2,
          frames: 7,
          durations: [100],
          loop: false,
          sequence: [0, 1, 2, 2, 2, 1, 0],
        },
      },
    };
    render(
      <CompanionActor
        source={SOURCE}
        fallback={FALLBACK}
        alt="Companion"
        motion="pet"
        layout={ordered}
      />,
    );
    await decode();
    step(0);
    step(500);
    expect(lastSourceFrame()).toEqual([40, 120, 40, 60]);
    expect(screen.getByRole("img")).toHaveAttribute("data-frame", "5");
    step(700);
    expect(lastSourceFrame()).toEqual([0, 120, 40, 60]);
    expect(screen.getByRole("img")).toHaveAttribute("data-frame", "6");
    expect(frames.size).toBe(0);
  });

  it.each([
    ["wrong length", [0, 1]],
    ["negative column", [0, -1, 2]],
    ["column beyond atlas", [0, 1, 3]],
    ["fractional column", [0, 0.5, 2]],
    ["missing column", Array(3)],
  ])(
    "keeps the original image for an invalid sequence: %s",
    (_reason, sequence) => {
      const invalid: CompanionActorLayout = {
        ...layout,
        clips: {
          ...layout.clips,
          idle: { ...layout.clips.idle, sequence: sequence as number[] },
        },
      };
      render(
        <CompanionActor
          source={SOURCE}
          fallback={FALLBACK}
          alt="Companion"
          motion="idle"
          layout={invalid}
        />,
      );
      expect(screen.getByRole("img")).toHaveAttribute("src", FALLBACK);
      expect(loads).toHaveLength(0);
      expect(frames.size).toBe(0);
    },
  );

  it("bounds a sequence to 256 steps before allocating playback state", () => {
    const invalid: CompanionActorLayout = {
      ...layout,
      clips: {
        ...layout.clips,
        idle: {
          ...layout.clips.idle,
          frames: 257,
          sequence: Array(257).fill(0),
        },
      },
    };
    render(
      <CompanionActor
        source={SOURCE}
        fallback={FALLBACK}
        alt="Companion"
        motion="idle"
        layout={invalid}
      />,
    );
    expect(screen.getByRole("img")).toHaveAttribute("src", FALLBACK);
    expect(loads).toHaveLength(0);
  });
});
