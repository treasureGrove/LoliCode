import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { CompanionVideoActor } from "@/features/agent/CompanionVideoActor";

const props = {
  sources: { idle: "idle.webm", pet: "greeting.webm", feed: "feeding.webm" },
  poster: "neutral-poster.png",
  motion: "idle" as const,
  alt: "小伙伴",
};

let reduced = false;
let hidden = false;
let preferenceChanged: (() => void) | null = null;
const play = vi.fn<() => Promise<void>>();
const pause = vi.fn();
const load = vi.fn();

function videoIn(container: HTMLElement) {
  const video = container.querySelector("video");
  if (!video) throw new Error("Expected a video decoder");
  return video;
}

function decoded(video: HTMLVideoElement) {
  Object.defineProperty(video, "readyState", { configurable: true, value: 2 });
  Object.defineProperty(video, "duration", { configurable: true, value: 5 });
  fireEvent.loadedData(video);
}

function visibility(next: boolean) {
  hidden = next;
  fireEvent(document, new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  reduced = false;
  hidden = false;
  preferenceChanged = null;
  play.mockReset().mockResolvedValue(undefined);
  pause.mockReset();
  load.mockReset();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(load);
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return reduced;
      },
      addEventListener: (_event: string, listener: () => void) => {
        preferenceChanged = listener;
      },
      removeEventListener: vi.fn(),
    })),
  );
});

describe("quiet ambient footage", () => {
  it("accepts one new offer while idle, finishes once, and drops offers made during that activity", () => {
    const { container, rerender } = render(<CompanionVideoActor {...props} />);
    decoded(videoIn(container));
    rerender(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 1, source: "snack.webm" }}
      />,
    );
    const snack = videoIn(container);
    decoded(snack);
    expect(snack).toHaveAttribute("src", "snack.webm");
    expect(snack.loop).toBe(false);
    expect(screen.getByRole("img")).toHaveAttribute("data-clip", "ambient");
    rerender(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 1, source: "snack.webm" }}
      />,
    );
    expect(videoIn(container)).toBe(snack);
    rerender(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 2, source: "curious.webm" }}
      />,
    );
    expect(videoIn(container)).toBe(snack);
    fireEvent.ended(snack);
    const idle = videoIn(container);
    expect(idle).toHaveAttribute("src", props.sources.idle);
    expect(idle.loop).toBe(true);
    rerender(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 2, source: "curious.webm" }}
      />,
    );
    expect(videoIn(container)).toBe(idle);
    rerender(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 3, source: "curious.webm" }}
      />,
    );
    expect(videoIn(container)).toHaveAttribute("src", "curious.webm");
  });

  it.each(["pet", "feed", "drag", "sleep"] as const)(
    "immediately yields an ambient activity to user %s without reacting to old decoder events",
    (motion) => {
      const ambient = { key: 1, source: "snack.webm" };
      const { container, rerender } = render(
        <CompanionVideoActor {...props} ambient={ambient} />,
      );
      const snack = videoIn(container);
      decoded(snack);
      rerender(
        <CompanionVideoActor
          {...props}
          motion={motion}
          playbackKey={1}
          ambient={ambient}
        />,
      );
      const replacement = container.querySelector("video");
      if (motion === "sleep") expect(replacement).toBeNull();
      else
        expect(replacement).toHaveAttribute(
          "src",
          motion === "drag" ? props.sources.idle : props.sources[motion],
        );
      expect(snack).not.toHaveAttribute("src");
      fireEvent.ended(snack);
      fireEvent.error(snack);
      expect(container.querySelector("video")).toBe(replacement);
    },
  );

  it.each(["pet", "feed"] as const)(
    "never interrupts or restarts unfinished %s for an ambient offer, even after the parent is idle",
    (motion) => {
      const { container, rerender } = render(
        <CompanionVideoActor {...props} motion={motion} playbackKey={1} />,
      );
      const action = videoIn(container);
      decoded(action);
      rerender(
        <CompanionVideoActor
          {...props}
          motion={motion}
          playbackKey={1}
          ambient={{ key: 1, source: "snack.webm" }}
        />,
      );
      expect(videoIn(container)).toBe(action);
      rerender(
        <CompanionVideoActor
          {...props}
          playbackKey={1}
          ambient={{ key: 2, source: "curious.webm" }}
        />,
      );
      expect(videoIn(container)).toBe(action);
      fireEvent.ended(action);
      expect(videoIn(container)).toHaveAttribute("src", props.sources.idle);
    },
  );

  it("drops hidden-page offers instead of queuing them for visibility resume", () => {
    const { container, rerender } = render(<CompanionVideoActor {...props} />);
    const idle = videoIn(container);
    decoded(idle);
    visibility(true);
    rerender(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 1, source: "snack.webm" }}
      />,
    );
    expect(videoIn(container)).toBe(idle);
    visibility(false);
    expect(videoIn(container)).toBe(idle);
    rerender(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 2, source: "snack.webm" }}
      />,
    );
    expect(videoIn(container)).toHaveAttribute("src", "snack.webm");
  });

  it("drops reduced-motion offers and starts idle when the preference is restored", () => {
    reduced = true;
    const { container, rerender } = render(<CompanionVideoActor {...props} />);
    rerender(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 1, source: "snack.webm" }}
      />,
    );
    expect(container.querySelector("video")).toBeNull();
    act(() => {
      reduced = false;
      preferenceChanged?.();
    });
    expect(videoIn(container)).toHaveAttribute("src", props.sources.idle);
    rerender(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 2, source: "snack.webm" }}
      />,
    );
    expect(videoIn(container)).toHaveAttribute("src", "snack.webm");
  });

  it("returns to base idle after ambient failure and does not retry the failed URL", () => {
    const { container, rerender } = render(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 1, source: "bad.webm" }}
      />,
    );
    fireEvent.error(videoIn(container));
    const idle = videoIn(container);
    expect(idle).toHaveAttribute("src", props.sources.idle);
    decoded(idle);
    rerender(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 2, source: "bad.webm" }}
      />,
    );
    expect(videoIn(container)).toBe(idle);
    rerender(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 3, source: "good.webm" }}
      />,
    );
    expect(videoIn(container)).toHaveAttribute("src", "good.webm");
  });

  it("cancels an ambient activity when its offer is removed", () => {
    const { container, rerender } = render(
      <CompanionVideoActor
        {...props}
        ambient={{ key: 1, source: "snack.webm" }}
      />,
    );
    const snack = videoIn(container);
    decoded(snack);
    rerender(<CompanionVideoActor {...props} />);
    expect(videoIn(container)).toHaveAttribute("src", props.sources.idle);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("local companion video actor", () => {
  it("restores the decoder source when StrictMode replays its effect", () => {
    const playedSources: Array<string | null> = [];
    play.mockImplementation(function (this: HTMLMediaElement) {
      playedSources.push(this.getAttribute("src"));
      return Promise.resolve();
    });
    const { container, unmount } = render(
      <StrictMode>
        <CompanionVideoActor {...props} />
      </StrictMode>,
    );
    const video = videoIn(container);
    expect(playedSources).toEqual([props.sources.idle, props.sources.idle]);
    expect(load).toHaveBeenCalledTimes(1);
    decoded(video);
    expect(screen.getByRole("img")).toHaveAttribute("data-video-ready", "true");
    unmount();
    expect(video).not.toHaveAttribute("src");
    expect(load).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one accessible image and the matching poster until a frame is decoded", () => {
    const { container } = render(<CompanionVideoActor {...props} />);
    const actor = screen.getByRole("img", { name: props.alt });
    const video = videoIn(container);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(actor).toHaveAttribute("data-video-ready", "false");
    expect(container.querySelector("img")).toHaveAttribute("src", props.poster);
    expect(video).toHaveAttribute("aria-hidden", "true");
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.loop).toBe(true);
    decoded(video);
    expect(actor).toHaveAttribute("data-video-ready", "true");
    expect(video).toHaveAttribute("data-ready", "true");
    expect(screen.getAllByRole("img")).toHaveLength(1);
    fireEvent.canPlay(video);
    fireEvent.playing(video);
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("waits for the presented frame callback when the browser supports it", () => {
    const { container, unmount } = render(<CompanionVideoActor {...props} />);
    const video = videoIn(container);
    let frame: VideoFrameRequestCallback | undefined;
    const request = vi.fn((callback: VideoFrameRequestCallback) => {
      frame = callback;
      return 4;
    });
    const cancel = vi.fn();
    video.requestVideoFrameCallback = request;
    video.cancelVideoFrameCallback = cancel;
    decoded(video);
    fireEvent.canPlay(video);
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img")).toHaveAttribute(
      "data-video-ready",
      "false",
    );
    act(() => frame?.(0, {} as VideoFrameCallbackMetadata));
    expect(screen.getByRole("img")).toHaveAttribute("data-video-ready", "true");
    unmount();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("finishes a five second action even if the parent returns to idle early", () => {
    const { container, rerender } = render(
      <CompanionVideoActor {...props} motion="pet" playbackKey={1} />,
    );
    const greeting = videoIn(container);
    decoded(greeting);
    expect(greeting.loop).toBe(false);
    rerender(<CompanionVideoActor {...props} playbackKey={1} />);
    act(() => vi.advanceTimersByTime(3200));
    expect(videoIn(container)).toBe(greeting);
    expect(greeting).toHaveAttribute("src", props.sources.pet);
    fireEvent.ended(greeting);
    const idle = videoIn(container);
    expect(idle).not.toBe(greeting);
    expect(idle.loop).toBe(true);
    expect(idle).toHaveAttribute("src", props.sources.idle);
    expect(screen.getByRole("img")).toHaveAttribute(
      "data-video-ready",
      "false",
    );
  });

  it("restarts only on a new action or playback key and ignores events from the old decoder", () => {
    const { container, rerender } = render(
      <CompanionVideoActor {...props} motion="feed" playbackKey={1} />,
    );
    const first = videoIn(container);
    decoded(first);
    rerender(<CompanionVideoActor {...props} motion="feed" playbackKey={1} />);
    expect(videoIn(container)).toBe(first);
    rerender(<CompanionVideoActor {...props} motion="feed" playbackKey={2} />);
    const second = videoIn(container);
    expect(second).not.toBe(first);
    expect(first).not.toHaveAttribute("src");
    fireEvent.ended(first);
    fireEvent.error(first);
    expect(videoIn(container)).toBe(second);
    fireEvent.ended(second);
    const idle = videoIn(container);
    rerender(<CompanionVideoActor {...props} motion="feed" playbackKey={2} />);
    expect(videoIn(container)).toBe(idle);
    rerender(<CompanionVideoActor {...props} playbackKey={2} />);
    expect(videoIn(container)).toBe(idle);
    rerender(<CompanionVideoActor {...props} playbackKey={3} />);
    expect(videoIn(container)).toBe(idle);
  });

  it("interrupts feeding for drag and sleep, with the same poster for sleep", () => {
    const { container, rerender } = render(
      <CompanionVideoActor {...props} motion="feed" playbackKey={1} />,
    );
    const feeding = videoIn(container);
    decoded(feeding);
    rerender(<CompanionVideoActor {...props} motion="drag" playbackKey={1} />);
    expect(videoIn(container)).toHaveAttribute("src", props.sources.idle);
    expect(screen.getByRole("img")).toHaveAttribute("data-motion", "drag");
    rerender(<CompanionVideoActor {...props} motion="sleep" playbackKey={1} />);
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute("src", props.poster);
    fireEvent.ended(feeding);
    expect(container.querySelector("video")).toBeNull();
    rerender(<CompanionVideoActor {...props} playbackKey={1} />);
    expect(videoIn(container)).toHaveAttribute("src", props.sources.idle);
  });

  it("greets once on mount without replaying on media readiness events", () => {
    const { container, rerender } = render(
      <CompanionVideoActor {...props} greetOnMount />,
    );
    const greeting = videoIn(container);
    expect(greeting).toHaveAttribute("src", props.sources.pet);
    decoded(greeting);
    fireEvent.canPlay(greeting);
    fireEvent.playing(greeting);
    rerender(<CompanionVideoActor {...props} greetOnMount />);
    expect(videoIn(container)).toBe(greeting);
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.ended(greeting);
    expect(videoIn(container)).toHaveAttribute("src", props.sources.idle);
  });

  it("pauses hidden pages and preserves the action's remaining watchdog budget", () => {
    const { container } = render(
      <CompanionVideoActor {...props} motion="feed" />,
    );
    const video = videoIn(container);
    decoded(video);
    act(() => vi.advanceTimersByTime(2000));
    visibility(true);
    expect(pause).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    visibility(false);
    expect(play).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(4000));
    expect(videoIn(container)).toBe(video);
    fireEvent.ended(video);
    expect(videoIn(container)).toHaveAttribute("src", props.sources.idle);
  });

  it("does not play while initially hidden or expose a pending callback after hiding", () => {
    hidden = true;
    const { container } = render(<CompanionVideoActor {...props} />);
    const video = videoIn(container);
    expect(play).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    visibility(false);
    let callback: VideoFrameRequestCallback | undefined;
    video.requestVideoFrameCallback = vi.fn((next) => {
      callback = next;
      return 9;
    });
    video.cancelVideoFrameCallback = vi.fn();
    decoded(video);
    visibility(true);
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(9);
    act(() => callback?.(0, {} as VideoFrameCallbackMetadata));
    expect(screen.getByRole("img")).toHaveAttribute(
      "data-video-ready",
      "false",
    );
  });

  it("uses only the poster for reduced motion, then starts idle rather than replaying a stale action", () => {
    reduced = true;
    const { container, rerender } = render(
      <CompanionVideoActor {...props} greetOnMount />,
    );
    expect(container.querySelector("video")).toBeNull();
    expect(play).not.toHaveBeenCalled();
    rerender(<CompanionVideoActor {...props} motion="feed" playbackKey={1} />);
    expect(container.querySelector("video")).toBeNull();
    act(() => {
      reduced = false;
      preferenceChanged?.();
    });
    const idle = videoIn(container);
    expect(idle).toHaveAttribute("src", props.sources.idle);
    decoded(idle);
    act(() => {
      reduced = true;
      preferenceChanged?.();
    });
    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute("src", props.poster);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back on missing or failed clips without retrying a failed URL", () => {
    const missing = render(<CompanionVideoActor {...props} sources={{}} />);
    expect(missing.container.querySelector("video")).toBeNull();
    expect(missing.container.querySelector("img")).toHaveAttribute(
      "src",
      props.poster,
    );
    missing.unmount();
    const { container, rerender } = render(
      <CompanionVideoActor {...props} motion="feed" playbackKey={1} />,
    );
    fireEvent.error(videoIn(container));
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByRole("img")).toHaveAttribute(
      "data-video-ready",
      "false",
    );
    rerender(<CompanionVideoActor {...props} motion="feed" playbackKey={2} />);
    expect(container.querySelector("video")).toBeNull();
    expect(play).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["pet", "feed"] as const)(
    "returns to valid idle after a missing %s clip instead of waiting for ended",
    (motion) => {
      const sources = { idle: props.sources.idle };
      const { container, rerender } = render(
        <CompanionVideoActor {...props} sources={sources} motion={motion} />,
      );
      expect(container.querySelector("video")).toBeNull();
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        props.poster,
      );
      rerender(<CompanionVideoActor {...props} sources={sources} />);
      const idle = videoIn(container);
      expect(idle).toHaveAttribute("src", props.sources.idle);
      decoded(idle);
      expect(screen.getByRole("img")).toHaveAttribute(
        "data-video-ready",
        "true",
      );
    },
  );

  it("releases a retained action when its source disappears after the parent is idle", () => {
    const { container, rerender } = render(
      <CompanionVideoActor {...props} motion="feed" />,
    );
    const feeding = videoIn(container);
    decoded(feeding);
    rerender(<CompanionVideoActor {...props} />);
    expect(videoIn(container)).toBe(feeding);
    rerender(
      <CompanionVideoActor {...props} sources={{ idle: props.sources.idle }} />,
    );
    const idle = videoIn(container);
    expect(idle).not.toBe(feeding);
    expect(idle).toHaveAttribute("src", props.sources.idle);
    expect(feeding).not.toHaveAttribute("src");
    fireEvent.ended(feeding);
    expect(videoIn(container)).toBe(idle);
  });

  it("handles blocked play promises and bounded loading or playback stalls", async () => {
    play.mockRejectedValueOnce(new Error("decoder unavailable"));
    const blocked = render(<CompanionVideoActor {...props} />);
    await act(async () => {});
    expect(blocked.container.querySelector("video")).toBeNull();
    blocked.unmount();
    const loading = render(<CompanionVideoActor {...props} />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(loading.container.querySelector("video")).toBeNull();
    loading.unmount();
    const stalled = render(<CompanionVideoActor {...props} motion="pet" />);
    decoded(videoIn(stalled.container));
    act(() => vi.advanceTimersByTime(7000));
    expect(stalled.container.querySelector("video")).toBeNull();
    expect(stalled.container.querySelector("img")).toHaveAttribute(
      "src",
      props.poster,
    );
  });

  it("ignores an old play rejection after a legitimate hidden-page pause", async () => {
    let reject: ((error: Error) => void) | undefined;
    play.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, failed) => {
          reject = failed;
        }),
    );
    const { container } = render(<CompanionVideoActor {...props} />);
    const video = videoIn(container);
    visibility(true);
    visibility(false);
    await act(async () => reject?.(new Error("play aborted by pause")));
    expect(videoIn(container)).toBe(video);
  });

  it("hides a previous clip while its replacement decodes and releases media on unmount", () => {
    const { container, rerender, unmount } = render(
      <CompanionVideoActor {...props} />,
    );
    const previous = videoIn(container);
    decoded(previous);
    rerender(
      <CompanionVideoActor
        {...props}
        sources={{ ...props.sources, idle: "replacement.webm" }}
        poster="replacement-poster.png"
      />,
    );
    const replacement = videoIn(container);
    expect(replacement).not.toBe(previous);
    expect(previous).not.toHaveAttribute("src");
    expect(screen.getByRole("img")).toHaveAttribute(
      "data-video-ready",
      "false",
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "replacement-poster.png",
    );
    unmount();
    expect(replacement).not.toHaveAttribute("src");
    expect(pause).toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
