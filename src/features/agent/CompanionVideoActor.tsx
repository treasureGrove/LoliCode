import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CompanionMotion } from "./CompanionActor";
import "./companion-video-actor.css";

type BaseClip = "idle" | "pet" | "feed";
type Clip = BaseClip | "ambient";

export interface CompanionVideoActorProps {
  /** Locally bundled clips sharing the poster's canvas, scale and foot position. */
  sources: Partial<Record<BaseClip, string>>;
  /** A new key offers one quiet activity; busy, hidden or reduced-motion offers are dropped. */
  ambient?: { key: string | number; source: string };
  poster: string;
  motion: CompanionMotion;
  playbackKey?: string | number;
  alt: string;
  greetOnMount?: boolean;
}

type Playback = { clip: Clip | null; serial: number; ambientSource?: string };
type VideoPlayerProps = {
  source: string;
  clip: Clip;
  serial: number;
  onReady: (serial: number, source: string) => void;
  onEnded: (serial: number) => void;
  onFailed: (serial: number, source: string) => void;
};

/** Owns one decoder. A new action gets a new element, so late events stay local. */
function VideoPlayer({
  source,
  clip,
  serial,
  onReady,
  onEnded,
  onFailed,
}: VideoPlayerProps) {
  const ref = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    // StrictMode can replay this effect on the same element after cleanup.
    if (video.getAttribute("src") !== source) video.setAttribute("src", source);
    let active = true;
    let firstFrame = false;
    let playRequest = 0;
    let frameRequest: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let remaining = 10_000;
    let timerStarted = 0;
    const loop = clip === "idle";

    const clearTimer = () => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      remaining = Math.max(0, remaining - (Date.now() - timerStarted));
    };
    const cancelFrame = () => {
      if (frameRequest !== null) {
        video.cancelVideoFrameCallback?.(frameRequest);
        frameRequest = null;
      }
    };
    const fail = () => {
      if (!active) return;
      active = false;
      clearTimer();
      cancelFrame();
      video.pause();
      onFailed(serial, source);
    };
    const armTimer = () => {
      if (!active || document.hidden || timer !== null || (firstFrame && loop))
        return;
      timerStarted = Date.now();
      timer = setTimeout(fail, remaining);
    };
    const markReady = () => {
      frameRequest = null;
      if (!active || firstFrame || document.hidden) return;
      firstFrame = true;
      clearTimer();
      // Normal completion comes from ended. This only bounds a broken/stalled clip.
      remaining = Number.isFinite(video.duration)
        ? Math.max(6_000, Math.min(30_000, video.duration * 1000 + 2_000))
        : 7_000;
      setReady(true);
      onReady(serial, source);
      armTimer();
    };
    const frameAvailable = () => {
      if (
        !active ||
        firstFrame ||
        document.hidden ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      )
        return;
      if (typeof video.requestVideoFrameCallback === "function") {
        if (frameRequest === null)
          frameRequest = video.requestVideoFrameCallback(markReady);
      } else {
        markReady();
      }
    };
    const play = () => {
      if (!active || document.hidden) return;
      const request = ++playRequest;
      try {
        const playing = video.play();
        void playing?.catch(() => {
          // A visibility pause may abort an in-flight play request legitimately.
          if (active && !document.hidden && request === playRequest) fail();
        });
      } catch {
        fail();
      }
    };
    const ended = () => {
      if (!active || loop) return;
      active = false;
      clearTimer();
      cancelFrame();
      onEnded(serial);
    };
    const visibility = () => {
      if (document.hidden) {
        playRequest += 1;
        video.pause();
        clearTimer();
        cancelFrame();
      } else {
        play();
        frameAvailable();
        armTimer();
      }
    };

    video.muted = true;
    video.defaultMuted = true;
    video.addEventListener("loadeddata", frameAvailable);
    video.addEventListener("canplay", frameAvailable);
    video.addEventListener("playing", frameAvailable);
    video.addEventListener("ended", ended);
    video.addEventListener("error", fail);
    document.addEventListener("visibilitychange", visibility);
    play();
    frameAvailable();
    armTimer();

    return () => {
      active = false;
      clearTimer();
      cancelFrame();
      video.removeEventListener("loadeddata", frameAvailable);
      video.removeEventListener("canplay", frameAvailable);
      video.removeEventListener("playing", frameAvailable);
      video.removeEventListener("ended", ended);
      video.removeEventListener("error", fail);
      document.removeEventListener("visibilitychange", visibility);
      video.pause();
      // Clearing src before load releases the decoder without refetching its clip.
      video.removeAttribute("src");
      video.load();
    };
  }, [source, clip, serial, onReady, onEnded, onFailed]);

  return (
    <video
      ref={ref}
      className="lc-companion-video-clip"
      data-ready={ready}
      data-clip={clip}
      src={source}
      muted
      playsInline
      loop={clip === "idle"}
      preload="auto"
      controls={false}
      disablePictureInPicture
      aria-hidden="true"
      tabIndex={-1}
      draggable={false}
    />
  );
}

/** Plays verified local character footage; the matching poster is every fallback. */
export function CompanionVideoActor({
  sources,
  poster,
  motion,
  playbackKey,
  ambient,
  alt,
  greetOnMount = false,
}: CompanionVideoActorProps) {
  const [reduced, setReduced] = useState(
    () =>
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );
  const [playback, setPlayback] = useState<Playback>(() => ({
    clip:
      reduced || motion === "sleep"
        ? null
        : motion === "pet" || motion === "feed"
          ? motion
          : greetOnMount && motion === "idle" && sources.pet
            ? "pet"
            : "idle",
    serial: 0,
  }));
  const [failedSources, setFailedSources] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [painted, setPainted] = useState<{
    serial: number;
    source: string;
  } | null>(null);
  const previous = useRef({
    motion,
    playbackKey,
    reduced,
    petSource: sources.pet,
    feedSource: sources.feed,
    ambientKey: undefined as string | number | undefined,
    ambientSource: undefined as string | undefined,
  });

  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const changed = () => setReduced(Boolean(preference?.matches));
    changed();
    preference?.addEventListener?.("change", changed);
    return () => preference?.removeEventListener?.("change", changed);
  }, []);

  useLayoutEffect(() => {
    const last = previous.current;
    previous.current = {
      motion,
      playbackKey,
      reduced,
      petSource: sources.pet,
      feedSource: sources.feed,
      ambientKey: ambient?.key,
      ambientSource: ambient?.source,
    };
    if (
      last.motion === motion &&
      last.playbackKey === playbackKey &&
      last.reduced === reduced &&
      last.petSource === sources.pet &&
      last.feedSource === sources.feed &&
      last.ambientKey === ambient?.key &&
      last.ambientSource === ambient?.source
    )
      return;
    setPlayback((current) => {
      let clip: Clip | null;
      const currentSource =
        current.clip === "ambient"
          ? current.ambientSource
          : current.clip
            ? sources[current.clip]
            : undefined;
      if (reduced || motion === "sleep") clip = null;
      else if (last.reduced || motion === "drag") clip = "idle";
      else if (motion === "pet" || motion === "feed") {
        // Ambient offers must neither interrupt nor restart a user's response.
        if (
          last.motion === motion &&
          last.playbackKey === playbackKey &&
          (motion === "pet" ? last.petSource : last.feedSource) ===
            sources[motion]
        )
          return current;
        clip = motion;
      }
      // A parent's shorter feedback timer must not cut a real action in half.
      else if (
        (current.clip === "pet" || current.clip === "feed") &&
        currentSource &&
        !failedSources.has(currentSource)
      )
        return current;
      else if (current.clip === "ambient" && ambient?.source) return current;
      else if (
        motion === "idle" &&
        current.clip === "idle" &&
        ambient?.key !== undefined &&
        last.ambientKey !== ambient.key &&
        ambient.source &&
        !document.hidden &&
        !failedSources.has(ambient.source)
      )
        return {
          clip: "ambient",
          ambientSource: ambient.source,
          serial: current.serial + 1,
        };
      else clip = "idle";
      if (clip === current.clip && (clip === null || clip === "idle"))
        return current;
      return { clip, serial: current.serial + 1 };
    });
  }, [
    motion,
    playbackKey,
    reduced,
    sources.pet,
    sources.feed,
    failedSources,
    ambient?.key,
    ambient?.source,
  ]);

  const onReady = useCallback((serial: number, source: string) => {
    setPainted({ serial, source });
  }, []);
  const onEnded = useCallback((serial: number) => {
    setPlayback((current) =>
      current.serial === serial
        ? { clip: "idle", serial: current.serial + 1 }
        : current,
    );
  }, []);
  const onFailed = useCallback((serial: number, source: string) => {
    setFailedSources((current) => new Set([...current, source]));
    setPlayback((current) =>
      current.serial === serial
        ? {
            clip: current.clip === "ambient" ? "idle" : null,
            serial: current.serial + 1,
          }
        : current,
    );
  }, []);

  const clip = playback.clip;
  const source =
    clip === "ambient"
      ? playback.ambientSource
      : clip
        ? sources[clip]
        : undefined;
  const canPlay = Boolean(
    !reduced &&
      motion !== "sleep" &&
      !(motion === "drag" && clip !== "idle") &&
      source &&
      !failedSources.has(source),
  );
  const ready =
    canPlay && painted?.serial === playback.serial && painted.source === source;

  return (
    <span
      className="lc-companion-video-actor"
      role="img"
      aria-label={alt}
      data-motion={motion}
      data-clip={canPlay ? clip : "poster"}
      data-video-ready={ready}
      data-reduced-motion={reduced}
    >
      <img
        className="lc-companion-video-poster"
        src={poster}
        alt=""
        aria-hidden="true"
        draggable={false}
        decoding="async"
      />
      {canPlay && source && clip && (
        <VideoPlayer
          key={`${playback.serial}:${source}`}
          source={source}
          clip={clip}
          serial={playback.serial}
          onReady={onReady}
          onEnded={onEnded}
          onFailed={onFailed}
        />
      )}
    </span>
  );
}
