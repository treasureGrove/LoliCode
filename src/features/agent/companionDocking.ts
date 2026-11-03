export type CompanionPosition = { x: number; y: number };
export type CompanionRest = "sit" | "lie";
export type CompanionViewport = { width: number; height: number };

export const COMPANION_CHARACTER_TOP = 20;
export const COMPANION_STANDING_WIDTH = 192;
export const COMPANION_STANDING_FOOT_Y = COMPANION_CHARACTER_TOP + 192 * 0.93;
export const COMPANION_DOCK_DISTANCE = 52;

/** Contact points are measured in the exported transparent pose canvases. */
export const COMPANION_REST_POSES = {
  sit: { width: 192, height: 192, contactX: 0.5, contactY: 0.738 },
  lie: { width: 240, height: 160, contactX: 0.5, contactY: 0.8 },
} as const;

type SurfaceRect = Pick<
  DOMRectReadOnly,
  "left" | "right" | "top" | "bottom" | "width" | "height"
>;

export interface CompanionDockGeometry {
  kind: CompanionRest;
  position: CompanionPosition;
  contact: CompanionPosition;
  fraction: number;
  distance: number;
}

export interface CompanionDockTarget extends CompanionDockGeometry {
  element: HTMLElement;
  scope: HTMLElement;
  id: string;
}

const VIEWPORT_MARGIN = 8;
const SUPPORT_INSET = { sit: 24, lie: 48 };
const MIN_SURFACE_WIDTH = { sit: 80, lie: 144 };

export function companionStandingContact(position: CompanionPosition) {
  return {
    x: position.x + COMPANION_STANDING_WIDTH / 2,
    y: position.y + COMPANION_STANDING_FOOT_Y,
  };
}

/** Never clamp the resulting root: that would move the pose off its edge. */
export function companionDockGeometry(
  rect: SurfaceRect,
  kind: CompanionRest,
  contactX: number,
  viewport: CompanionViewport,
): Omit<CompanionDockGeometry, "distance"> | null {
  const pose = COMPANION_REST_POSES[kind];
  if (
    rect.width < MIN_SURFACE_WIDTH[kind] ||
    rect.height < 16 ||
    rect.left < 0 ||
    rect.right > viewport.width ||
    rect.top < 0 ||
    rect.bottom <= 0 ||
    rect.top >= viewport.height ||
    contactX < rect.left + SUPPORT_INSET[kind] ||
    contactX > rect.right - SUPPORT_INSET[kind]
  )
    return null;
  const position = {
    x: contactX - pose.width * pose.contactX,
    y: rect.top - COMPANION_CHARACTER_TOP - pose.height * pose.contactY,
  };
  if (
    position.x < VIEWPORT_MARGIN ||
    position.y < VIEWPORT_MARGIN ||
    position.x + pose.width > viewport.width - VIEWPORT_MARGIN ||
    position.y + COMPANION_CHARACTER_TOP + pose.height >
      viewport.height - VIEWPORT_MARGIN
  )
    return null;
  return {
    kind,
    position,
    contact: { x: contactX, y: rect.top },
    fraction: (contactX - rect.left) / rect.width,
  };
}

export function companionStandingPosition(target: CompanionDockGeometry) {
  return {
    x: target.contact.x - COMPANION_STANDING_WIDTH / 2,
    y: target.contact.y - COMPANION_STANDING_FOOT_Y,
  };
}

function viewport(): CompanionViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function isExposed(element: HTMLElement, contact: CompanionPosition) {
  // The pet can overlap its own anchor. Ignore its non-surface UI in hit tests.
  if (typeof document.elementsFromPoint !== "function") return true;
  return [-16, 0, 16].every((offset) => {
    const front = document
      .elementsFromPoint(contact.x + offset, contact.y + 2)
      .find((hit) => !hit.closest(".lc-pet, [data-agent-pane-resize-shield]"));
    return Boolean(front && (front === element || element.contains(front)));
  });
}

export function readCompanionDockTarget(
  element: HTMLElement,
  contactX: number,
): CompanionDockTarget | null {
  if (!element.isConnected) return null;
  const kind = element.dataset.companionRest;
  const id = element.dataset.companionDockId;
  if (
    (kind !== "sit" && kind !== "lie") ||
    !id ||
    !element.hasAttribute("data-companion-surface") ||
    element.closest('[hidden], [aria-hidden="true"], [inert]')
  )
    return null;
  for (
    let ancestor: HTMLElement | null = element;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    const style = window.getComputedStyle(ancestor);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      (style.opacity !== "" && Number(style.opacity) === 0)
    )
      return null;
  }
  const geometry = companionDockGeometry(
    element.getBoundingClientRect(),
    kind,
    contactX,
    viewport(),
  );
  if (!geometry || !isExposed(element, geometry.contact)) return null;
  return {
    ...geometry,
    id,
    element,
    scope:
      element.closest<HTMLElement>(".lolicode-agent-page") ?? document.body,
    distance: 0,
  };
}

export function findCompanionDockTarget(
  position: CompanionPosition,
): CompanionDockTarget | null {
  const foot = companionStandingContact(position);
  let nearest: CompanionDockTarget | null = null;
  document
    .querySelectorAll<HTMLElement>(
      "[data-companion-surface][data-companion-rest][data-companion-dock-id]",
    )
    .forEach((element) => {
      // Most transcript entries are nowhere near the feet. Avoid walking their
      // computed ancestor styles during every pointer move.
      if (
        Math.abs(element.getBoundingClientRect().top - foot.y) >
        COMPANION_DOCK_DISTANCE
      )
        return;
      const target = readCompanionDockTarget(element, foot.x);
      if (!target) return;
      const distance = Math.abs(target.contact.y - foot.y);
      if (
        distance <= COMPANION_DOCK_DISTANCE &&
        (!nearest || distance < nearest.distance)
      )
        nearest = { ...target, distance };
    });
  return nearest;
}

/** Rebind a rebuilt message only inside the same live page and stable session ID. */
export function refreshCompanionDock(
  dock: CompanionDockTarget,
): CompanionDockTarget | null {
  let element = dock.element;
  if (!element.isConnected) {
    if (!dock.scope.isConnected) return null;
    const replacement = Array.from(
      dock.scope.querySelectorAll<HTMLElement>(
        "[data-companion-surface][data-companion-dock-id][data-companion-rest]",
      ),
    ).find(
      (candidate) =>
        candidate.dataset.companionDockId === dock.id &&
        candidate.dataset.companionRest === dock.kind,
    );
    if (!replacement) return null;
    element = replacement;
  }
  if (
    element.dataset.companionDockId !== dock.id ||
    element.dataset.companionRest !== dock.kind
  )
    return null;
  const rect = element.getBoundingClientRect();
  return readCompanionDockTarget(
    element,
    rect.left + rect.width * dock.fraction,
  );
}
