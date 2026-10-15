import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface AgentDisclosureState {
  open: boolean;
  scroll: Map<string, { top: number; left: number }>;
}

export const createAgentDisclosureState = (): AgentDisclosureState => ({
  open: false,
  scroll: new Map(),
});

/** Native disclosure with no hidden payload tree, even after it was opened once. */
export function AgentDisclosure({
  children,
  summary,
  className,
  summaryClassName,
  bodyClassName,
  state: persistentState,
  "data-state": dataState,
}: {
  children: () => ReactNode;
  summary: ReactNode;
  className?: string;
  summaryClassName?: string;
  bodyClassName?: string;
  state?: AgentDisclosureState;
  "data-state"?: string;
}) {
  const ownState = useRef<AgentDisclosureState>();
  if (!ownState.current) ownState.current = createAgentDisclosureState();
  const state = persistentState || ownState.current;
  const [expanded, setExpanded] = useState(state.open);
  const body = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!expanded || !body.current) return;
    for (const [path, position] of state.scroll) {
      let node: Element | undefined = body.current;
      for (const index of path ? path.split(".") : []) {
        node = node?.children[Number(index)];
      }
      if (node instanceof HTMLElement) {
        node.scrollTop = position.top;
        node.scrollLeft = position.left;
      }
    }
  }, [expanded, state]);

  return (
    <details
      className={className}
      data-state={dataState}
      open={expanded}
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        const next = event.currentTarget.open;
        state.open = next;
        setExpanded(next);
      }}
    >
      <summary tabIndex={0} className={summaryClassName}>
        {summary}
      </summary>
      {expanded && (
        <div
          ref={body}
          className={bodyClassName}
          data-agent-disclosure-body=""
          onScrollCapture={(event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            if (
              target.closest("[data-agent-disclosure-body]") !==
              event.currentTarget
            )
              return;
            // Hiding a native details body can emit a zero-position scroll.
            // Keep the last visible position instead of caching that reset.
            let ancestor: HTMLElement | null =
              event.currentTarget.parentElement;
            while (ancestor) {
              if (ancestor instanceof HTMLDetailsElement && !ancestor.open)
                return;
              ancestor = ancestor.parentElement;
            }
            const path: number[] = [];
            let node: HTMLElement | null = target;
            while (node && node !== event.currentTarget) {
              const parent: HTMLElement | null = node.parentElement;
              if (!parent) return;
              path.unshift(Array.prototype.indexOf.call(parent.children, node));
              node = parent;
            }
            if (node)
              state.scroll.set(path.join("."), {
                top: target.scrollTop,
                left: target.scrollLeft,
              });
          }}
        >
          {children()}
        </div>
      )}
    </details>
  );
}
