import { useEffect, useRef, useState } from "react";

export interface AgentPaneResizeHandleProps {
  label: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  growthDirection: 1 | -1;
  onWidthChange: (width: number) => void;
}

let cancelActiveDrag: (() => void) | undefined;
const bounded = (value: number, min: number, max: number) =>
  Math.round(Math.min(Math.max(min, max), Math.max(min, value)));

/** A real separator; pointer capture and a shield keep drags out of iframes. */
export function AgentPaneResizeHandle(props: AgentPaneResizeHandleProps) {
  const latest = useRef(props);
  latest.current = props;
  const stopDrag = useRef<(() => void) | undefined>();
  const mounted = useRef(true);
  const [dragging, setDragging] = useState(false);
  const disabled = props.maxWidth <= props.minWidth;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopDrag.current?.();
    };
  }, []);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuemin={Math.round(props.minWidth)}
      aria-valuemax={Math.round(props.maxWidth)}
      aria-valuenow={Math.round(props.width)}
      aria-valuetext={`${Math.round(props.width)} 像素`}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      className="wb-pane-resizer"
      data-dragging={dragging || undefined}
      onKeyDown={(event) => {
        if (disabled) return;
        const step = event.shiftKey ? 40 : 16;
        let next: number;
        if (event.key === "Home") next = props.minWidth;
        else if (event.key === "End") next = props.maxWidth;
        else if (event.key === "ArrowLeft")
          next = props.width - step * props.growthDirection;
        else if (event.key === "ArrowRight")
          next = props.width + step * props.growthDirection;
        else return;
        event.preventDefault();
        props.onWidthChange(bounded(next, props.minWidth, props.maxWidth));
      }}
      onPointerDown={(event) => {
        if (
          disabled ||
          event.isPrimary === false ||
          (event.button !== 0 && event.pointerType !== "touch") ||
          !Number.isFinite(event.clientX)
        )
          return;
        event.preventDefault();
        cancelActiveDrag?.();
        const handle = event.currentTarget;
        const pointerId = event.pointerId;
        const startX = event.clientX;
        const startWidth = props.width;
        const saved = ["cursor", "user-select", "touch-action"].map((name) => ({
          name,
          value: document.body.style.getPropertyValue(name),
          priority: document.body.style.getPropertyPriority(name),
        }));
        document.body.style.setProperty("cursor", "col-resize", "important");
        document.body.style.setProperty("user-select", "none", "important");
        document.body.style.setProperty("touch-action", "none", "important");
        const shield = document.createElement("div");
        shield.dataset.agentPaneResizeShield = "";
        shield.setAttribute("aria-hidden", "true");
        shield.style.cssText =
          "position:fixed;inset:0;z-index:2147483647;cursor:col-resize;touch-action:none;";
        document.body.append(shield);
        try {
          handle.setPointerCapture(pointerId);
        } catch {
          /* The window listeners still cover older WebViews. */
        }
        let stopped = false;
        const move = (next: PointerEvent) => {
          if (next.pointerId !== pointerId) return;
          next.preventDefault();
          const current = latest.current;
          current.onWidthChange(
            bounded(
              startWidth + (next.clientX - startX) * current.growthDirection,
              current.minWidth,
              current.maxWidth,
            ),
          );
        };
        const stop = () => {
          if (stopped) return;
          stopped = true;
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", finish);
          window.removeEventListener("blur", stop);
          handle.removeEventListener("lostpointercapture", stop);
          try {
            handle.releasePointerCapture(pointerId);
          } catch {
            /* Capture may already have been released. */
          }
          shield.remove();
          for (const property of saved) {
            if (property.value)
              document.body.style.setProperty(
                property.name,
                property.value,
                property.priority,
              );
            else document.body.style.removeProperty(property.name);
          }
          if (cancelActiveDrag === stop) cancelActiveDrag = undefined;
          stopDrag.current = undefined;
          if (mounted.current) setDragging(false);
        };
        const finish = (next: PointerEvent) => {
          if (next.pointerId === pointerId) stop();
        };
        stopDrag.current = stop;
        cancelActiveDrag = stop;
        window.addEventListener("pointermove", move, { passive: false });
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
        window.addEventListener("blur", stop);
        handle.addEventListener("lostpointercapture", stop);
        setDragging(true);
      }}
    />
  );
}
