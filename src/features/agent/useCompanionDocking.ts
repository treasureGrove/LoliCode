import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  findCompanionDockTarget,
  refreshCompanionDock,
  type CompanionDockTarget,
  type CompanionPosition,
} from "./companionDocking";

/** Docking is ephemeral; only ordinary safe standing positions are persisted. */
export function useCompanionDocking({
  enabled,
  onFollow,
  onRelease,
}: {
  enabled: boolean;
  onFollow: (position: CompanionPosition) => void;
  onRelease: (dock: CompanionDockTarget) => void;
}) {
  const [dock, setDock] = useState<CompanionDockTarget | null>(null);
  const dockRef = useRef(dock);
  const [target, setTarget] = useState<CompanionDockTarget | null>(null);
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>();
  const callbacks = useRef({ onFollow, onRelease });
  callbacks.current = { onFollow, onRelease };
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const clearTarget = useCallback(() => setTarget(null), []);
  const detach = useCallback(() => {
    dockRef.current = null;
    setDock(null);
    setTarget(null);
    clearTimeout(settleTimer.current);
    setSettling(false);
  }, []);
  const refresh = useCallback(() => {
    const previous = dockRef.current;
    if (!previous) return;
    const next = enabledRef.current ? refreshCompanionDock(previous) : null;
    if (!next) {
      detach();
      callbacks.current.onRelease(previous);
      return;
    }
    if (
      next.position.x !== previous.position.x ||
      next.position.y !== previous.position.y
    ) {
      clearTimeout(settleTimer.current);
      setSettling(false);
    }
    dockRef.current = next;
    if (next.element !== previous.element) setDock(next);
    callbacks.current.onFollow(next.position);
  }, [detach]);
  const findTarget = useCallback((position: CompanionPosition) => {
    const next = enabledRef.current ? findCompanionDockTarget(position) : null;
    setTarget(next);
    return next;
  }, []);
  const attach = useCallback((next: CompanionDockTarget) => {
    const valid = enabledRef.current ? refreshCompanionDock(next) : null;
    if (!valid) return false;
    dockRef.current = valid;
    setDock(valid);
    setTarget(null);
    callbacks.current.onFollow(valid.position);
    clearTimeout(settleTimer.current);
    setSettling(true);
    settleTimer.current = setTimeout(() => setSettling(false), 320);
    return true;
  }, []);

  useLayoutEffect(() => {
    const element = target?.element;
    if (!element) return;
    element.dataset.companionTarget = "true";
    return () => {
      delete element.dataset.companionTarget;
    };
  }, [target?.element]);

  useLayoutEffect(() => {
    refresh();
  });

  useEffect(() => {
    if (!dock) return;
    let frame: number | undefined;
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        refresh();
      });
    };
    const observer = new ResizeObserver(schedule);
    // Grid/sidebar transitions can move a short bubble without resizing it.
    // Its containing tracks still resize on every frame of that transition.
    for (
      let element: HTMLElement | null = dock.element;
      element;
      element = element.parentElement
    )
      observer.observe(element);
    // Content above a message can move its edge without resizing the message.
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "aria-hidden",
        "data-companion-dock-id",
        "data-companion-rest",
      ],
    });
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      mutations.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [dock, refresh]);

  useEffect(() => () => clearTimeout(settleTimer.current), []);

  return {
    dock,
    dockRef,
    target,
    settling,
    attach,
    detach,
    findTarget,
    clearTarget,
    refresh,
  };
}
