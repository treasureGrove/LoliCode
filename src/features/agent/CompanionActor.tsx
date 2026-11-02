import { useEffect, useRef, useState } from "react";
import "./companion-actor.css";

export type CompanionMotion = "idle" | "feed" | "pet" | "sleep" | "drag";

export interface CompanionActorLayout {
  columns: number;
  rows: number;
  frameWidth: number;
  frameHeight: number;
  clips: Record<
    CompanionMotion,
    {
      row: number;
      frames: number;
      durations: number[];
      loop: boolean;
      /** Source columns in playback order; allows holds and returning poses. */
      sequence?: number[];
    }
  >;
}

export interface CompanionActorProps {
  source: string;
  fallback: string;
  alt: string;
  motion: CompanionMotion;
  layout?: CompanionActorLayout;
  /** Increment when another interaction should restart the same action. */
  playbackKey?: string | number;
  /** Only action changes dissolve; ordinary animation frames stay crisp. */
  transitionMs?: number;
}

const MOTIONS: CompanionMotion[] = ["idle", "feed", "pet", "sleep", "drag"];
const MAX_CANVAS_PIXELS = 4_194_304;

function normalizeLayout(
  layout?: CompanionActorLayout,
): CompanionActorLayout | null {
  if (!layout) return null;
  if (
    !Number.isInteger(layout.columns) ||
    layout.columns < 1 ||
    layout.columns > 64 ||
    !Number.isInteger(layout.rows) ||
    layout.rows < 1 ||
    layout.rows > 64 ||
    !Number.isInteger(layout.frameWidth) ||
    layout.frameWidth < 1 ||
    layout.frameWidth > 4096 ||
    !Number.isInteger(layout.frameHeight) ||
    layout.frameHeight < 1 ||
    layout.frameHeight > 4096
  )
    return null;
  const clips = {} as CompanionActorLayout["clips"];
  for (const motion of MOTIONS) {
    const clip = layout.clips?.[motion];
    if (
      !clip ||
      !Number.isInteger(clip.row) ||
      clip.row < 0 ||
      clip.row >= layout.rows ||
      !Number.isInteger(clip.frames) ||
      clip.frames < 1 ||
      clip.frames > 256 ||
      (clip.sequence === undefined && clip.frames > layout.columns) ||
      (clip.sequence !== undefined &&
        (!Array.isArray(clip.sequence) ||
          clip.sequence.length !== clip.frames ||
          !Array.from(clip.sequence).every(
            (column) =>
              Number.isInteger(column) &&
              column >= 0 &&
              column < layout.columns,
          ))) ||
      !Array.isArray(clip.durations) ||
      clip.durations.length === 0
    )
      return null;
    const durations = Array.from({ length: clip.frames }, (_, index) => {
      const duration =
        clip.durations[Math.min(index, clip.durations.length - 1)];
      return Number.isFinite(duration) && duration > 0 ? duration : 120;
    });
    clips[motion] = {
      row: clip.row,
      frames: clip.frames,
      durations,
      loop: clip.loop === true,
      ...(clip.sequence !== undefined ? { sequence: [...clip.sequence] } : {}),
    };
  }
  return {
    columns: layout.columns,
    rows: layout.rows,
    frameWidth: layout.frameWidth,
    frameHeight: layout.frameHeight,
    clips,
  };
}

/** Draw local, already generated motion frames without deforming the artwork. */
export function CompanionActor({
  source,
  fallback,
  alt,
  motion,
  layout,
  playbackKey,
  transitionMs = 120,
}: CompanionActorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previousFrameRef = useRef<HTMLCanvasElement | null>(null);
  const renderedRef = useRef<{
    canvas: HTMLCanvasElement;
    source: string;
    layoutKey: string;
    motion: CompanionMotion;
    playbackKey: string | number | undefined;
  } | null>(null);
  const transitionDurationRef = useRef(transitionMs);
  transitionDurationRef.current = transitionMs;
  const [atlas, setAtlas] = useState<{
    source: string;
    image: HTMLImageElement;
  } | null>(null);
  const [painted, setPainted] = useState<{
    source: string;
    layoutKey: string;
  } | null>(null);
  const normalized = normalizeLayout(layout);
  // Equivalent layout objects from a parent render must not restart a clip.
  const layoutKey = normalized ? JSON.stringify(normalized) : "";
  const hasLayout = Boolean(normalized);

  useEffect(() => {
    if (!hasLayout || !source) return;
    let active = true;
    const image = new Image();
    image.decoding = "async";
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () =>
        reject(new Error("Companion atlas could not be decoded"));
    });
    image.src = source;
    // decode waits for complete image data, so switching motions never exposes
    // a partially loaded row. The load promise also handles older WebViews.
    const decoded =
      typeof image.decode === "function" ? image.decode() : loaded;
    // Suppress a redundant load-event rejection when decode is available.
    void loaded.catch(() => {});
    void decoded
      .then(() => {
        if (active && image.naturalWidth > 0 && image.naturalHeight > 0)
          setAtlas({ source, image });
      })
      .catch(() => {
        if (active) setAtlas(null);
      });
    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [source, hasLayout]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !normalized || atlas?.source !== source) return;
    if (
      atlas.image.naturalWidth < normalized.columns * normalized.frameWidth ||
      atlas.image.naturalHeight < normalized.rows * normalized.frameHeight
    ) {
      setPainted(null);
      return;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      setPainted(null);
      return;
    }
    const { frameWidth, frameHeight } = normalized;
    const clip = normalized.clips[motion];
    const duration = clip.durations.reduce((total, ms) => total + ms, 0);
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const paused = () => document.hidden || Boolean(preference?.matches);
    const transitionDuration = Number.isFinite(transitionDurationRef.current)
      ? Math.max(0, transitionDurationRef.current)
      : 120;
    const previous = renderedRef.current;
    let previousFrame: HTMLCanvasElement | null = null;
    if (
      !paused() &&
      transitionDuration > 0 &&
      previous?.canvas === canvas &&
      previous.source === source &&
      previous.layoutKey === layoutKey &&
      (previous.motion !== motion || previous.playbackKey !== playbackKey)
    ) {
      const buffer =
        previousFrameRef.current ?? document.createElement("canvas");
      previousFrameRef.current = buffer;
      const bufferContext = buffer.getContext("2d");
      if (bufferContext) {
        if (buffer.width !== canvas.width) buffer.width = canvas.width;
        if (buffer.height !== canvas.height) buffer.height = canvas.height;
        bufferContext.setTransform(1, 0, 0, 1, 0, 0);
        bufferContext.globalAlpha = 1;
        bufferContext.globalCompositeOperation = "copy";
        // Copy the already composited frame, including transparent edges.
        // This reuses one buffer and never reads pixels back to JavaScript.
        bufferContext.drawImage(canvas, 0, 0);
        bufferContext.globalCompositeOperation = "source-over";
        previousFrame = buffer;
      }
    }
    const deviceRatio = Number.isFinite(window.devicePixelRatio)
      ? window.devicePixelRatio
      : 1;
    const ratio = Math.min(
      Math.max(1, deviceRatio),
      2,
      Math.sqrt(MAX_CANVAS_PIXELS / (frameWidth * frameHeight)),
    );
    const width = Math.max(1, Math.round(frameWidth * ratio));
    const height = Math.max(1, Math.round(frameHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.setTransform(
      canvas.width / frameWidth,
      0,
      0,
      canvas.height / frameHeight,
      0,
      0,
    );
    context.imageSmoothingEnabled = true;
    let handle: number | null = null;
    let lastTime: number | null = null;
    let elapsed = 0;
    let frame = 0;
    let completed = false;
    let active = true;
    let transitionElapsed = 0;
    let transitioning = previousFrame !== null;

    const draw = (index: number, progress = 1) => {
      const sourceFrame = clip.sequence?.[index] ?? index;
      context.clearRect(0, 0, frameWidth, frameHeight);
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      if (previousFrame && progress < 1) {
        context.globalAlpha = 1 - progress;
        context.drawImage(
          previousFrame,
          0,
          0,
          previousFrame.width,
          previousFrame.height,
          0,
          0,
          frameWidth,
          frameHeight,
        );
        // Add premultiplied colors and alpha with complementary weights.
        // Source-over would attenuate the old frame twice at the soft edges.
        context.globalCompositeOperation = "lighter";
        context.globalAlpha = progress;
      }
      context.drawImage(
        atlas.image,
        sourceFrame * frameWidth,
        clip.row * frameHeight,
        frameWidth,
        frameHeight,
        0,
        0,
        frameWidth,
        frameHeight,
      );
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      canvas.dataset.frame = String(index);
      canvas.dataset.sourceFrame = String(sourceFrame);
      canvas.dataset.transitioning = String(progress < 1);
      frame = index;
    };
    const stop = () => {
      if (handle !== null) cancelAnimationFrame(handle);
      handle = null;
      lastTime = null;
    };
    const schedule = () => {
      if (
        active &&
        !paused() &&
        (transitioning || (!completed && clip.frames > 1)) &&
        handle === null
      )
        handle = requestAnimationFrame(tick);
    };
    function tick(time: number) {
      handle = null;
      if (!active || paused()) {
        lastTime = null;
        return;
      }
      const delta = lastTime === null ? 0 : Math.max(0, time - lastTime);
      lastTime = time;
      if (transitioning) {
        transitionElapsed += delta;
        const progress = Math.min(1, transitionElapsed / transitionDuration);
        draw(0, progress);
        if (progress === 1) {
          transitioning = false;
          previousFrame = null;
        }
        schedule();
        return;
      }
      elapsed += delta;
      if (clip.loop) elapsed %= duration;
      else if (elapsed >= duration) {
        elapsed = duration;
        completed = true;
      }
      let boundary = 0;
      let next = clip.frames - 1;
      for (let index = 0; index < clip.frames; index++) {
        boundary += clip.durations[index];
        if (elapsed < boundary) {
          next = index;
          break;
        }
      }
      if (next !== frame) draw(next);
      schedule();
    }
    const onVisibility = () => {
      stop();
      if (document.hidden && transitioning) {
        transitioning = false;
        previousFrame = null;
        draw(0);
      }
      schedule();
    };
    const onPreference = () => {
      stop();
      if (preference?.matches) {
        transitioning = false;
        previousFrame = null;
        elapsed = 0;
        completed = false;
        draw(0);
      }
      schedule();
    };

    // Paint synchronously from the decoded atlas before exposing the canvas.
    draw(0, transitioning ? 0 : 1);
    renderedRef.current = { canvas, source, layoutKey, motion, playbackKey };
    setPainted((previous) =>
      previous?.source === source && previous.layoutKey === layoutKey
        ? previous
        : { source, layoutKey },
    );
    document.addEventListener("visibilitychange", onVisibility);
    preference?.addEventListener?.("change", onPreference);
    schedule();
    return () => {
      active = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      preference?.removeEventListener?.("change", onPreference);
    };
  }, [atlas, source, motion, playbackKey, layoutKey]);

  const ready =
    hasLayout &&
    atlas?.source === source &&
    painted?.source === source &&
    painted.layoutKey === layoutKey;
  return (
    <span className="lc-companion-actor">
      {hasLayout && (
        <canvas
          ref={canvasRef}
          className="lc-companion-actor-canvas"
          role="img"
          data-motion={motion}
          aria-label={alt}
          hidden={!ready}
          aria-hidden={!ready}
        />
      )}
      {!ready && (
        <img
          className="lc-companion-actor-fallback"
          src={fallback}
          alt={alt}
          draggable={false}
          decoding="async"
        />
      )}
    </span>
  );
}
