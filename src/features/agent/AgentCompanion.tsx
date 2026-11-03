import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import {
  EyeOff,
  Fish,
  Heart,
  House,
  MessageSquare,
  Moon,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
// Preserve the resource-pack key; built-in footage is bundled as local assets.
import companion from "@/assets/atelier/companion.png?inline";
import companionPoster from "@/assets/atelier/companion-video-poster-v4.webp?inline";
import companionIdle from "@/assets/atelier/companion-idle-video-v4.webm";
import companionGreeting from "@/assets/atelier/companion-greeting-video-v4.webm";
import companionFeed from "@/assets/atelier/companion-feed-video-v4.webm";
import companionSnack from "@/assets/atelier/companion-snack-video-v4.webm";
import companionCurious from "@/assets/atelier/companion-curious-video-v4.webm";
import companionSit from "@/assets/atelier/companion-sit-video-v5.webm";
import companionSitPoster from "@/assets/atelier/companion-sit-poster-v5.webp?inline";
import companionLie from "@/assets/atelier/companion-lie-video-v5.webm";
import companionLiePoster from "@/assets/atelier/companion-lie-poster-v5.webp?inline";
import { useResourceImage } from "@/app/shell/ResourcePackProvider";
import { useInterfaceAppearance } from "@/hooks/useInterfaceAppearance";
import {
  useSecretaryActivity,
  type SecretaryOpenTarget,
} from "@/hooks/useSecretaryActivity";
import type { CompanionMotion } from "./CompanionActor";
import { CompanionVideoActor } from "./CompanionVideoActor";
import {
  COMPANION_REST_POSES,
  companionStandingPosition,
} from "./companionDocking";
import { useCompanionDocking } from "./useCompanionDocking";
import {
  advanceCompanionState,
  FEED_COOLDOWN_MS,
  interactWithCompanion,
  readCompanionState,
  saveCompanionState,
  type CompanionState,
} from "@/lib/companion";
import "./agent-companion.css";

const WIDTH = 192;
const HEIGHT = 250;
const MARGIN = 8;
const VIDEO_REACTION_MS = 5200;
const COMPANION_VIDEOS = {
  idle: companionIdle,
  pet: companionGreeting,
  feed: companionFeed,
};
const AMBIENT_VIDEOS = { snack: companionSnack, curious: companionCurious };
const REST_VIDEOS = {
  sit: { source: companionSit, poster: companionSitPoster },
  lie: { source: companionLie, poster: companionLiePoster },
};
type Position = { x: number; y: number };
type Gesture = {
  kind: "pet" | "food";
  id: number;
  start: Position;
  origin: Position;
  moved: boolean;
  target: HTMLElement;
};

function clampPosition(position: Position): Position {
  return {
    x: Math.min(
      Math.max(MARGIN, position.x),
      Math.max(MARGIN, window.innerWidth - WIDTH - MARGIN),
    ),
    y: Math.min(
      Math.max(MARGIN, position.y),
      Math.max(MARGIN, window.innerHeight - HEIGHT - MARGIN),
    ),
  };
}

const homePosition = () =>
  clampPosition({ x: 82, y: window.innerHeight - HEIGHT - 42 });

/** A window-wide companion, independent of the project sidebar and navigation. */
export function AgentCompanion({
  onOpenSecretary,
}: { onOpenSecretary?: (target?: SecretaryOpenTarget) => void } = {}) {
  const { t } = useTranslation();
  const { appearance, setAppearance } = useInterfaceAppearance();
  const visible = appearance.companionVisible;
  const secretary = useSecretaryActivity(visible && Boolean(onOpenSecretary));
  const [pet, setPet] = useState(readCompanionState);
  const petRef = useRef(pet);
  const [position, setPosition] = useState(() =>
    pet.position ? clampPosition(pet.position) : homePosition(),
  );
  const positionRef = useRef(position);
  const [panelOpen, setPanelOpen] = useState(false);
  const carePanel = useRef<HTMLElement>(null);
  const [panelSize, setPanelSize] = useState({ width: 272, height: 326 });
  const panelOpenRef = useRef(panelOpen);
  panelOpenRef.current = panelOpen;
  const [feedback, setFeedback] = useState<string | null>("greeting");
  const [reaction, setReaction] = useState("idle");
  const [playbackKey, setPlaybackKey] = useState(0);
  const [ambient, setAmbient] = useState<
    { key: number; source: string } | undefined
  >();
  const ambientSequence = useRef(0);
  const previousAmbient = useRef<keyof typeof AMBIENT_VIDEOS | null>(null);
  const reactionRef = useRef(reaction);
  reactionRef.current = reaction;
  const [now, setNow] = useState(Date.now);
  const [dragging, setDragging] = useState<Gesture["kind"] | null>(null);
  const [foodPosition, setFoodPosition] = useState<Position | null>(null);
  const [foodOverPet, setFoodOverPet] = useState(false);
  const sprite = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClickUntil = useRef(0);
  const lastInteraction = useRef(Date.now());
  const lastPersistedAt = useRef(Date.now());
  const feedbackTimer = useRef<ReturnType<typeof setTimeout>>();
  const reactionTimer = useRef<ReturnType<typeof setTimeout>>();
  const companionSource = useResourceImage("companion", companion);
  const builtInCompanion = companionSource === companion;
  const portraitSource = builtInCompanion ? companionPoster : companionSource;
  const cooldown =
    pet.lastFedAt > 0
      ? Math.max(0, Math.ceil((pet.lastFedAt + FEED_COOLDOWN_MS - now) / 1000))
      : 0;
  const docking = useCompanionDocking({
    enabled: visible && builtInCompanion,
    onFollow(next) {
      // The contact-point calculation has already checked the viewport. A
      // second, standing-size clamp would pull a resting pose off its surface.
      positionRef.current = next;
      setPosition((current) =>
        current.x === next.x && current.y === next.y ? current : next,
      );
    },
    onRelease(previous) {
      moveTo(companionStandingPosition(previous), true);
      setFeedback(null);
    },
  });

  function updatePet(next: CompanionState, persist = true) {
    petRef.current = next;
    setPet(next);
    if (persist) {
      saveCompanionState(next);
      lastPersistedAt.current = Date.now();
    }
  }

  function moveTo(next: Position, persist = false) {
    const bounded = clampPosition(next);
    positionRef.current = bounded;
    setPosition(bounded);
    if (persist) updatePet({ ...petRef.current, position: bounded });
  }

  function leaveDock() {
    const current = docking.dockRef.current;
    if (!current) return;
    docking.detach();
    moveTo(companionStandingPosition(current), true);
    setFeedback(null);
  }

  function say(message: string, animation: string | null = "happy") {
    setFeedback(message);
    clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 4500);
    if (animation !== null) {
      setReaction(animation);
      if (animation !== "idle") setPlaybackKey((key) => key + 1);
      clearTimeout(reactionTimer.current);
      reactionTimer.current = setTimeout(
        () => setReaction("idle"),
        builtInCompanion && (animation === "eating" || animation === "happy")
          ? VIDEO_REACTION_MS
          : animation === "eating"
            ? 3200
            : 1800,
      );
    }
  }

  function interact(action: "feed" | "pet" | "sleep" | "wake") {
    lastInteraction.current = Date.now();
    setAmbient(undefined);
    setNow(lastInteraction.current);
    if (
      action === "feed" &&
      petRef.current.lastFedAt > 0 &&
      Date.now() - petRef.current.lastFedAt < FEED_COOLDOWN_MS
    ) {
      say("cooldown", null);
      return;
    }
    if (action !== "sleep") leaveDock();
    updatePet(interactWithCompanion(petRef.current, action));
    say(
      action === "feed"
        ? "fed"
        : action === "pet"
          ? "petted"
          : action === "sleep"
            ? "sleeping"
            : "rested",
      action === "feed" ? "eating" : action === "sleep" ? "idle" : "happy",
    );
  }

  function isOverPet(point: Position) {
    const box = sprite.current?.getBoundingClientRect();
    return Boolean(
      box &&
        point.x >= box.left &&
        point.x <= box.right &&
        point.y >= box.top &&
        point.y <= box.bottom,
    );
  }

  function finishGesture(cancelled = false) {
    const current = gesture.current;
    gesture.current = null;
    if (current) {
      lastInteraction.current = Date.now();
      setAmbient(undefined);
    }
    if (current?.moved) {
      suppressClickUntil.current = Date.now() + 400;
      if (current.kind === "pet") {
        const target = cancelled
          ? null
          : docking.findTarget(positionRef.current);
        if (target && docking.attach(target)) {
          updatePet({
            ...petRef.current,
            position: clampPosition(companionStandingPosition(target)),
          });
          say(target.kind === "lie" ? "dockedLie" : "dockedSit", "idle");
        } else {
          moveTo(cancelled ? current.origin : positionRef.current, true);
          if (!cancelled) say("moved", "idle");
        }
      }
    }
    docking.clearTarget();
    if (current?.target.hasPointerCapture(current.id))
      current.target.releasePointerCapture(current.id);
    setDragging(null);
    setFoodPosition(null);
    setFoodOverPet(false);
  }

  function startGesture(
    event: PointerEvent<HTMLButtonElement>,
    kind: Gesture["kind"],
  ) {
    if (event.button !== 0 || event.isPrimary === false || gesture.current)
      return;
    lastInteraction.current = Date.now();
    setAmbient(undefined);
    if (kind === "food" && cooldown > 0) return;
    gesture.current = {
      kind,
      id: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      origin: positionRef.current,
      moved: false,
      target: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveGesture(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) {
      finishGesture(true);
      return;
    }
    const point = { x: event.clientX, y: event.clientY };
    const dx = point.x - current.start.x;
    const dy = point.y - current.start.y;
    if (!current.moved && Math.hypot(dx, dy) < 5) return;
    if (!current.moved && current.kind === "pet") {
      const resting = docking.dockRef.current;
      if (resting) {
        const liveBox = docking.settling
          ? root.current?.getBoundingClientRect()
          : undefined;
        const origin =
          liveBox && liveBox.width > 0 && liveBox.height > 0
            ? { x: liveBox.left, y: liveBox.top }
            : current.origin;
        // Keep the head under the pointer while picking up a wider lying pose.
        // A second drag may interrupt the release transition before its end.
        current.origin = {
          x: origin.x + (COMPANION_REST_POSES[resting.kind].width - WIDTH) / 2,
          y: origin.y,
        };
        docking.detach();
      }
    }
    current.moved = true;
    setDragging(current.kind);
    event.preventDefault();
    if (current.kind === "pet") {
      setPanelOpen(false);
      moveTo({ x: current.origin.x + dx, y: current.origin.y + dy });
      docking.findTarget(positionRef.current);
    } else {
      setFoodPosition(point);
      setFoodOverPet(isOverPet(point));
    }
  }

  function endGesture(event: PointerEvent<HTMLButtonElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const dropped = current.kind === "food" && current.moved;
    const accepted =
      dropped && isOverPet({ x: event.clientX, y: event.clientY });
    finishGesture();
    if (dropped) accepted ? interact("feed") : say("escaped", "idle");
  }

  function clickAction(action: "feed" | "pet") {
    if (Date.now() >= suppressClickUntil.current) interact(action);
  }

  useEffect(() => {
    const timer = setInterval(() => {
      const time = Date.now();
      const current = petRef.current;
      if (current.lastFedAt > 0)
        setNow((previous) =>
          previous < current.lastFedAt + FEED_COOLDOWN_MS ? time : previous,
        );
      const shouldSleep =
        visible &&
        !current.sleeping &&
        !gesture.current &&
        time - lastInteraction.current >= 5 * 60_000;
      if (shouldSleep) {
        updatePet(interactWithCompanion(current, "sleep", time));
      } else if (time - current.updatedAt >= 30_000) {
        updatePet(
          advanceCompanionState(current, time),
          time - lastPersistedAt.current >= 60_000,
        );
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [visible]);

  useEffect(() => {
    if (!visible || !builtInCompanion) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          if (cancelled) return;
          const reduced = window.matchMedia?.(
            "(prefers-reduced-motion: reduce)",
          ).matches;
          if (
            !document.hidden &&
            !reduced &&
            !petRef.current.sleeping &&
            !gesture.current &&
            !docking.dockRef.current &&
            reactionRef.current === "idle" &&
            Date.now() - lastInteraction.current >= 20_000
          ) {
            const next =
              previousAmbient.current === "snack"
                ? "curious"
                : previousAmbient.current === "curious"
                  ? "snack"
                  : Math.random() < 0.5
                    ? "snack"
                    : "curious";
            previousAmbient.current = next;
            setAmbient({
              key: ++ambientSequence.current,
              source: AMBIENT_VIDEOS[next],
            });
          }
          schedule();
        },
        35_000 + Math.floor(Math.random() * 25_001),
      );
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [visible, builtInCompanion]);

  useLayoutEffect(() => {
    const panel = carePanel.current;
    if (!panelOpen || !panel) return;
    const measure = () => {
      const box = panel.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const next = {
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
      };
      setPanelSize((current) =>
        current.width === next.width && current.height === next.height
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [panelOpen]);

  useEffect(() => {
    const onResize = () => {
      finishGesture(true);
      if (docking.dockRef.current) docking.refresh();
      else moveTo(positionRef.current, true);
    };
    const onBlur = () => {
      finishGesture(true);
      saveCompanionState(advanceCompanionState(petRef.current));
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (gesture.current || panelOpenRef.current)) {
        // The shell also uses Escape to leave settings. Close our own active
        // interaction first, without navigating away from the current page.
        event.preventDefault();
        finishGesture(true);
        setPanelOpen(false);
      }
    };
    const onOutside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setPanelOpen(false);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onBlur);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onOutside);
    return () => {
      const current = gesture.current;
      gesture.current = null;
      if (current?.target.hasPointerCapture(current.id))
        current.target.releasePointerCapture(current.id);
      saveCompanionState(advanceCompanionState(petRef.current));
      clearTimeout(feedbackTimer.current);
      clearTimeout(reactionTimer.current);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onBlur);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onOutside);
    };
  }, []);

  useEffect(() => {
    clearTimeout(feedbackTimer.current);
    clearTimeout(reactionTimer.current);
    setReaction("idle");
    setAmbient(undefined);
    setFeedback(
      visible ? (petRef.current.sleeping ? "sleeping" : "greeting") : null,
    );
    lastInteraction.current = Date.now();
    if (visible)
      feedbackTimer.current = setTimeout(() => setFeedback(null), 4500);
    if (!visible) {
      finishGesture(true);
      setPanelOpen(false);
    }
  }, [visible]);

  if (!visible) return null;

  const status = pet.sleeping
    ? "sleeping"
    : pet.satiety < 35
      ? "hungry"
      : pet.satiety > 85
        ? "full"
        : pet.mood > 70
          ? "happy"
          : "ready";
  const motion: CompanionMotion =
    dragging === "pet"
      ? "drag"
      : pet.sleeping
        ? "sleep"
        : reaction === "eating"
          ? "feed"
          : reaction === "happy"
            ? "pet"
            : "idle";
  const rest = docking.dock?.kind;
  const pose = rest ? COMPANION_REST_POSES[rest] : null;
  const characterWidth = pose?.width ?? WIDTH;
  const characterHeight = pose?.height ?? WIDTH;
  const rootHeight = characterHeight + 58;
  const panelWidth = Math.min(panelSize.width, window.innerWidth - 16);
  const panelHeight = Math.min(panelSize.height, window.innerHeight - 16);
  let panelLeft = position.x + (characterWidth - panelWidth) / 2;
  let panelTop = position.y - panelHeight - 12;
  if (panelTop < MARGIN) {
    if (window.innerWidth - (position.x + characterWidth) >= panelWidth + 20) {
      panelLeft = position.x + characterWidth + 12;
      panelTop = position.y + (rootHeight - panelHeight) / 2;
    } else if (position.x >= panelWidth + 20) {
      panelLeft = position.x - panelWidth - 12;
      panelTop = position.y + (rootHeight - panelHeight) / 2;
    } else panelTop = position.y + rootHeight + 12;
  }
  const panelStyle = {
    left: Math.max(
      MARGIN,
      Math.min(panelLeft, window.innerWidth - panelWidth - MARGIN),
    ),
    top: Math.max(
      MARGIN,
      Math.min(panelTop, window.innerHeight - panelHeight - MARGIN),
    ),
  };
  const toggleLabel = t("settings.atelier.hideCompanion");
  const secretaryStatus = t(`agentSecretary.companion.${secretary.phase}`, {
    count: secretary.running + secretary.queued,
    defaultValue: {
      unknown: "工作状态暂未确认",
      idle: "和秘书聊聊",
      thinking: "正在梳理你的安排",
      working: "正在跟进 {{count}} 项工作",
      waiting_permission: "有工作需要你授权",
      waiting_question: "有问题想请你决定",
      failed: "有工作需要你查看",
      completed: "工作有结果啦",
    }[secretary.phase],
  });
  const openSecretary = () => {
    setPanelOpen(false);
    onOpenSecretary?.(secretary.target);
  };
  const pointerHandlers = {
    onPointerMove: moveGesture,
    onPointerUp: endGesture,
    onPointerCancel: () => finishGesture(true),
    onLostPointerCapture: () => {
      if (gesture.current) finishGesture(true);
    },
  };
  const bubbleMessage = foodOverPet
    ? "dropHint"
    : docking.target
      ? docking.target.kind === "lie"
        ? "dockHintLie"
        : "dockHintSit"
      : (feedback ??
        (rest ? (rest === "lie" ? "dockedLie" : "dockedSit") : status));
  const characterStyle = {
    left: position.x,
    top: position.y,
    width: characterWidth,
    height: rootHeight,
    "--companion-width": `${characterWidth}px`,
    "--companion-height": `${characterHeight}px`,
    "--companion-contact-y": `${20 + characterHeight * (pose?.contactY ?? 0.93)}px`,
    "--companion-rest-contact": `${(pose?.contactY ?? 0.93) * 100}%`,
  } as CSSProperties;

  return (
    <div
      ref={root}
      className="lc-pet"
      data-visible={visible}
      data-sleeping={pet.sleeping}
      data-reaction={reaction}
      data-motion={motion}
      data-panel-open={panelOpen}
      data-dragging={dragging ?? undefined}
      data-docked={rest}
      data-dock-id={docking.dock?.id}
      data-settling={docking.settling || undefined}
      data-work-state={secretary.phase}
      style={characterStyle}
    >
      {visible && (
        <>
          <div
            className="lc-pet-bubble"
            data-speaking={
              Boolean(feedback) ||
              foodOverPet ||
              Boolean(docking.target) ||
              Boolean(
                onOpenSecretary &&
                  !pet.sleeping &&
                  !["idle", "unknown"].includes(secretary.phase),
              )
            }
            role="status"
            aria-live="polite"
          >
            {onOpenSecretary &&
            !pet.sleeping &&
            !feedback &&
            !foodOverPet &&
            !docking.target &&
            !["idle", "unknown"].includes(secretary.phase)
              ? secretaryStatus
              : t(`companion.${bubbleMessage}`, { seconds: cooldown })}
          </div>
          <span id="companion-dock-status" className="sr-only" role="status">
            {rest &&
              `${t(`companion.${rest === "lie" ? "dockedLie" : "dockedSit"}`)} ${t("companion.leaveDockHint")}`}
          </span>
          <span className="lc-pet-shadow" aria-hidden="true" />
          <span className="lc-pet-aura" aria-hidden="true" />
          <button
            ref={sprite}
            type="button"
            className="lc-pet-character"
            data-food-over={foodOverPet}
            aria-label={t("companion.moveLabel")}
            aria-describedby={rest ? "companion-dock-status" : undefined}
            title={t(rest ? "companion.leaveDockHint" : "companion.dragHint")}
            onPointerDown={(event) => startGesture(event, "pet")}
            {...pointerHandlers}
            onClick={() => clickAction("pet")}
            onKeyDown={(event) => {
              const delta: Record<string, Position> = {
                ArrowLeft: { x: -16, y: 0 },
                ArrowRight: { x: 16, y: 0 },
                ArrowUp: { x: 0, y: -16 },
                ArrowDown: { x: 0, y: 16 },
              };
              const change = delta[event.key];
              if (change) {
                event.preventDefault();
                lastInteraction.current = Date.now();
                setAmbient(undefined);
                leaveDock();
                moveTo(
                  {
                    x: positionRef.current.x + change.x,
                    y: positionRef.current.y + change.y,
                  },
                  true,
                );
              }
            }}
          >
            {builtInCompanion ? (
              <CompanionVideoActor
                key={rest ? `rest-${rest}` : "standing"}
                sources={
                  rest ? { idle: REST_VIDEOS[rest].source } : COMPANION_VIDEOS
                }
                poster={rest ? REST_VIDEOS[rest].poster : companionPoster}
                alt={t("settings.atelier.companionAlt")}
                motion={rest ? "idle" : motion}
                playbackKey={playbackKey}
                ambient={rest ? undefined : ambient}
                greetOnMount={!rest}
              />
            ) : (
              <img
                className="lc-pet-custom-character"
                src={companionSource}
                alt={t("settings.atelier.companionAlt")}
                draggable={false}
                decoding="async"
              />
            )}
            {pet.sleeping && (
              <span className="lc-pet-zzz" aria-hidden="true">
                z Z
              </span>
            )}
            {(reaction === "happy" || reaction === "eating") && (
              <span className="lc-pet-hearts" aria-hidden="true">
                ♥ <span>♥</span> ♥
              </span>
            )}
            {foodOverPet && (
              <span className="lc-pet-drop-ring" aria-hidden="true" />
            )}
          </button>
          <div
            className="lc-pet-tools"
            role="toolbar"
            aria-label={t("companion.title")}
          >
            <button
              type="button"
              className="lc-pet-food"
              aria-label={t("companion.foodLabel")}
              aria-disabled={cooldown > 0}
              title={
                cooldown > 0
                  ? t("companion.cooldown", { seconds: cooldown })
                  : t("companion.feedHint")
              }
              onPointerDown={(event) => startGesture(event, "food")}
              {...pointerHandlers}
              onClick={() => clickAction("feed")}
            >
              <svg
                className="lc-pet-food-ring"
                viewBox="0 0 40 40"
                aria-hidden="true"
              >
                <circle
                  cx="20"
                  cy="20"
                  r="18"
                  pathLength="100"
                  strokeDasharray="100"
                  strokeDashoffset={100 * (1 - Math.min(1, cooldown / 30))}
                />
              </svg>
              <Fish size={21} aria-hidden="true" />
              {cooldown > 0 ? (
                <span className="lc-pet-food-counter">{cooldown}s</span>
              ) : (
                <span className="sr-only">{t("companion.feed")}</span>
              )}
            </button>
            <button
              type="button"
              className="lc-pet-tool"
              aria-label={t(
                pet.sleeping ? "companion.wake" : "companion.sleep",
              )}
              title={t(pet.sleeping ? "companion.wake" : "companion.sleep")}
              aria-pressed={pet.sleeping}
              onClick={() => interact(pet.sleeping ? "wake" : "sleep")}
            >
              {pet.sleeping ? (
                <Sun size={16} aria-hidden="true" />
              ) : (
                <Moon size={16} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="lc-pet-tool"
              aria-label={t("companion.details")}
              title={t("companion.details")}
              aria-expanded={panelOpen}
              aria-controls="companion-care-panel"
              onClick={() => setPanelOpen(!panelOpen)}
            >
              <Heart size={16} aria-hidden="true" />
            </button>
            {onOpenSecretary && (
              <button
                type="button"
                className="lc-pet-work"
                data-state={secretary.phase}
                onClick={openSecretary}
                aria-label={t(
                  secretary.attention
                    ? "agentSecretary.companion.openAttention"
                    : "agentSecretary.companion.open",
                  {
                    defaultValue: secretary.attention
                      ? "查看秘书待办"
                      : "打开 Loli 秘书",
                  },
                )}
                title={secretaryStatus}
              >
                <MessageSquare size={14} aria-hidden="true" />
                {secretary.attention > 0 && (
                  <strong aria-hidden="true">{secretary.attention}</strong>
                )}
              </button>
            )}
          </div>
          {panelOpen && (
            <section
              ref={carePanel}
              id="companion-care-panel"
              className="lc-pet-panel"
              aria-label={t("companion.title")}
              style={panelStyle}
            >
              <div className="lc-pet-panel-heading">
                <div className="lc-pet-panel-identity">
                  <span className="lc-pet-portrait" aria-hidden="true">
                    <img src={portraitSource} alt="" draggable={false} />
                  </span>
                  <span className="lc-pet-panel-name">
                    <strong>{t("companion.title")}</strong>
                    <span className="lc-pet-status">
                      <i data-sleeping={pet.sleeping} />
                      {t(`companion.${status}`)}
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  aria-label={t("companion.closeDetails")}
                  onClick={() => setPanelOpen(false)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
              <p className="lc-pet-subtitle">
                <Sparkles size={12} aria-hidden="true" />
                {t("companion.subtitle")}
              </p>
              {onOpenSecretary && (
                <button
                  type="button"
                  className="lc-pet-secretary-action"
                  onClick={openSecretary}
                >
                  <MessageSquare size={14} aria-hidden="true" />
                  <span>{secretaryStatus}</span>
                </button>
              )}
              {(["satiety", "mood"] as const).map((stat) => (
                <div className="lc-pet-stat" key={stat}>
                  <label htmlFor={`companion-${stat}`}>
                    {t(`companion.${stat}`)}
                  </label>
                  <meter
                    id={`companion-${stat}`}
                    min={0}
                    max={100}
                    value={pet[stat]}
                  />
                  <span>{Math.round(pet[stat])}</span>
                </div>
              ))}
              <div className="lc-pet-affection">
                <Heart size={14} aria-hidden="true" />
                <span>{t("companion.affection")}</span>
                <strong>{Math.floor(pet.affection)}</strong>
                <small>
                  {t("companion.feedCount", { count: pet.feedCount })}
                </small>
              </div>
              <div className="lc-pet-panel-actions">
                <button type="button" onClick={() => interact("pet")}>
                  <Heart size={14} aria-hidden="true" />
                  {t("companion.pet")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    docking.detach();
                    moveTo(homePosition(), true);
                    setPanelOpen(false);
                  }}
                >
                  <House size={14} aria-hidden="true" />
                  {t("companion.resetPosition")}
                </button>
              </div>
              <p className="lc-pet-hint">{t("companion.careHint")}</p>
            </section>
          )}
          {foodPosition && (
            <span
              className="lc-pet-food-ghost"
              style={{ left: foodPosition.x, top: foodPosition.y }}
              aria-hidden="true"
            >
              <Fish size={32} />
            </span>
          )}
        </>
      )}
      <button
        type="button"
        className="lc-pet-hide"
        aria-label={toggleLabel}
        aria-expanded={visible}
        title={toggleLabel}
        onClick={() => setAppearance({ companionVisible: false })}
      >
        <EyeOff size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
