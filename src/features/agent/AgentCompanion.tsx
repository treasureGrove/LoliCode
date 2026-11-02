import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  EyeOff,
  Fish,
  Heart,
  House,
  Moon,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
// Keep the selected artwork available offline inside the renderer bundle.
import companion from "@/assets/atelier/companion.png?inline";
import companionRig from "@/assets/atelier/companion-rig-v1.webp?inline";
import companionEyesClosed from "@/assets/atelier/companion-eyes-closed-v1.webp?inline";
import { useResourceImage } from "@/app/shell/ResourcePackProvider";
import { useInterfaceAppearance } from "@/hooks/useInterfaceAppearance";
import type { CompanionMotion } from "./CompanionActor";
import { CompanionRig } from "./CompanionRig";
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
export function AgentCompanion() {
  const { t } = useTranslation();
  const { appearance, setAppearance } = useInterfaceAppearance();
  const visible = appearance.companionVisible;
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
  const portraitSource = builtInCompanion ? companionRig : companionSource;
  const cooldown =
    pet.lastFedAt > 0
      ? Math.max(0, Math.ceil((pet.lastFedAt + FEED_COOLDOWN_MS - now) / 1000))
      : 0;

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
        animation === "eating" ? 3200 : 1800,
      );
    }
  }

  function interact(action: "feed" | "pet" | "sleep" | "wake") {
    lastInteraction.current = Date.now();
    setNow(lastInteraction.current);
    if (
      action === "feed" &&
      petRef.current.lastFedAt > 0 &&
      Date.now() - petRef.current.lastFedAt < FEED_COOLDOWN_MS
    ) {
      say("cooldown", null);
      return;
    }
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
    if (current?.moved) {
      suppressClickUntil.current = Date.now() + 400;
      if (current.kind === "pet") {
        moveTo(cancelled ? current.origin : positionRef.current, true);
        if (!cancelled) say("moved", "idle");
      }
    }
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
    current.moved = true;
    setDragging(current.kind);
    event.preventDefault();
    if (current.kind === "pet") {
      setPanelOpen(false);
      moveTo({ x: current.origin.x + dx, y: current.origin.y + dy });
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
      moveTo(positionRef.current, true);
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
  const panelWidth = Math.min(panelSize.width, window.innerWidth - 16);
  const panelHeight = Math.min(panelSize.height, window.innerHeight - 16);
  let panelLeft = position.x + (WIDTH - panelWidth) / 2;
  let panelTop = position.y - panelHeight - 12;
  if (panelTop < MARGIN) {
    if (window.innerWidth - (position.x + WIDTH) >= panelWidth + 20) {
      panelLeft = position.x + WIDTH + 12;
      panelTop = position.y + (HEIGHT - panelHeight) / 2;
    } else if (position.x >= panelWidth + 20) {
      panelLeft = position.x - panelWidth - 12;
      panelTop = position.y + (HEIGHT - panelHeight) / 2;
    } else panelTop = position.y + HEIGHT + 12;
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
  const pointerHandlers = {
    onPointerMove: moveGesture,
    onPointerUp: endGesture,
    onPointerCancel: () => finishGesture(true),
    onLostPointerCapture: () => {
      if (gesture.current) finishGesture(true);
    },
  };

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
      style={{ left: position.x, top: position.y }}
    >
      {visible && (
        <>
          <div
            className="lc-pet-bubble"
            data-speaking={Boolean(feedback) || foodOverPet}
            role="status"
            aria-live="polite"
          >
            {t(`companion.${foodOverPet ? "dropHint" : (feedback ?? status)}`, {
              seconds: cooldown,
            })}
          </div>
          <span className="lc-pet-shadow" aria-hidden="true" />
          <span className="lc-pet-aura" aria-hidden="true" />
          <button
            ref={sprite}
            type="button"
            className="lc-pet-character"
            data-food-over={foodOverPet}
            aria-label={t("companion.moveLabel")}
            title={t("companion.dragHint")}
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
                moveTo(
                  { x: position.x + change.x, y: position.y + change.y },
                  true,
                );
              }
            }}
          >
            {builtInCompanion ? (
              <CompanionRig
                source={companionRig}
                eyesClosed={companionEyesClosed}
                fallback={companionRig}
                alt={t("settings.atelier.companionAlt")}
                motion={motion}
                playbackKey={playbackKey}
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
