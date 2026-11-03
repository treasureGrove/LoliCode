import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPANION_DOCK_DISTANCE,
  COMPANION_REST_POSES,
  COMPANION_STANDING_FOOT_Y,
  companionDockGeometry,
  companionStandingPosition,
  findCompanionDockTarget,
  refreshCompanionDock,
  type CompanionRest,
} from "@/features/agent/companionDocking";

function rect(left = 100, top = 400, width = 400, height = 100) {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}

function surface(kind: CompanionRest = "sit", bounds = rect()) {
  const element = document.createElement("div");
  element.dataset.companionSurface = "surface-test";
  element.dataset.companionDockId = "surface-test";
  element.dataset.companionRest = kind;
  document.body.append(element);
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(bounds);
  return element;
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 768,
  });
});

afterEach(() => {
  document
    .querySelectorAll("[data-companion-surface]")
    .forEach((node) => node.remove());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("companion edge geometry", () => {
  it.each(["sit", "lie"] as const)(
    "aligns the %s canvas contact exactly to the edge",
    (kind) => {
      const result = companionDockGeometry(rect(), kind, 300, {
        width: 1024,
        height: 768,
      })!;
      const pose = COMPANION_REST_POSES[kind];
      expect(result.position.x + pose.width * pose.contactX).toBe(300);
      expect(result.position.y + 20 + pose.height * pose.contactY).toBe(400);
      expect(companionStandingPosition({ ...result, distance: 0 })).toEqual({
        x: 204,
        y: 400 - COMPANION_STANDING_FOOT_Y,
      });
    },
  );

  it.each([-1, 1])(
    "snaps up to 52px on side %s and chooses the closest eligible edge",
    (side) => {
      surface();
      const atLimit = {
        x: 204,
        y: 400 - COMPANION_STANDING_FOOT_Y + side * COMPANION_DOCK_DISTANCE,
      };
      expect(findCompanionDockTarget(atLimit)?.distance).toBe(
        COMPANION_DOCK_DISTANCE,
      );
      expect(
        findCompanionDockTarget({ ...atLimit, y: atLimit.y + side * 0.01 }),
      ).toBeNull();
      const closer = surface("lie", rect(100, 420));
      const selected = findCompanionDockTarget({
        x: 204,
        y: 415 - COMPANION_STANDING_FOOT_Y,
      });
      expect(selected?.element).toBe(closer);
      expect(selected?.kind).toBe("lie");
    },
  );

  it("rejects unsupported x coordinates, narrow edges, and poses that cannot fit above an edge", () => {
    const viewport = { width: 1024, height: 768 };
    expect(companionDockGeometry(rect(), "sit", 123, viewport)).toBeNull();
    expect(
      companionDockGeometry(rect(100, 400, 79), "sit", 140, viewport),
    ).toBeNull();
    expect(
      companionDockGeometry(rect(100, 400, 143), "lie", 170, viewport),
    ).toBeNull();
    expect(
      companionDockGeometry(rect(100, 130), "sit", 300, viewport),
    ).toBeNull();
    expect(companionDockGeometry(rect(0, 400), "lie", 96, viewport)).toBeNull();
    expect(
      companionDockGeometry(rect(100, 720), "sit", 300, viewport),
    ).toBeNull();
    expect(companionDockGeometry(rect(-5), "sit", 300, viewport)).toBeNull();
  });

  it("only considers explicit visible surfaces and excludes hidden ancestors and occluding panels", () => {
    const marked = surface();
    const position = { x: 204, y: 400 - COMPANION_STANDING_FOOT_Y };
    const ordinaryCard = document.createElement("div");
    vi.spyOn(ordinaryCard, "getBoundingClientRect").mockReturnValue(rect());
    document.body.append(ordinaryCard);
    expect(findCompanionDockTarget(position)?.element).toBe(marked);
    marked.parentElement!.style.opacity = "0";
    expect(findCompanionDockTarget(position)).toBeNull();
    marked.parentElement!.style.opacity = "";
    marked.hidden = true;
    expect(findCompanionDockTarget(position)).toBeNull();
    marked.hidden = false;
    const hitTest = vi.fn((): Element[] => [ordinaryCard]);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: hitTest,
    });
    expect(findCompanionDockTarget(position)).toBeNull();
    const pet = document.createElement("button");
    pet.className = "lc-pet";
    hitTest.mockReturnValue([pet, marked]);
    expect(findCompanionDockTarget(position)?.element).toBe(marked);
    const resizeShield = document.createElement("div");
    resizeShield.dataset.agentPaneResizeShield = "true";
    hitTest.mockReturnValue([resizeShield, marked]);
    expect(findCompanionDockTarget(position)?.element).toBe(marked);
    ordinaryCard.remove();
    delete (document as unknown as Record<string, unknown>).elementsFromPoint;
  });

  it("follows the same relative point and releases removed, relabelled, or offscreen surfaces", () => {
    const element = surface();
    const dock = findCompanionDockTarget({
      x: 204,
      y: 400 - COMPANION_STANDING_FOOT_Y,
    })!;
    vi.mocked(element.getBoundingClientRect).mockReturnValue(
      rect(200, 460, 500),
    );
    const followed = refreshCompanionDock(dock)!;
    expect(followed.contact).toEqual({ x: 450, y: 460 });
    expect(followed.fraction).toBe(0.5);
    element.dataset.companionDockId = "new-session";
    expect(refreshCompanionDock(dock)).toBeNull();
    element.dataset.companionDockId = dock.id;
    vi.mocked(element.getBoundingClientRect).mockReturnValue(
      rect(200, 30, 500),
    );
    expect(refreshCompanionDock(dock)).toBeNull();
    element.remove();
    expect(refreshCompanionDock(dock)).toBeNull();
  });

  it("rebinds a rebuilt stable surface within the same page, while keeping navigation isolated", () => {
    const page = document.createElement("main");
    page.className = "lolicode-agent-page";
    document.body.append(page);
    const original = surface();
    page.append(original);
    const dock = findCompanionDockTarget({
      x: 204,
      y: 400 - COMPANION_STANDING_FOOT_Y,
    })!;
    const replacement = surface("sit", rect(200, 420, 600));
    original.replaceWith(replacement);
    expect(original.isConnected).toBe(false);
    const rebound = refreshCompanionDock(dock)!;
    expect(rebound.element).toBe(replacement);
    expect(rebound.contact).toEqual({ x: 500, y: 420 });
    replacement.dataset.companionDockId = "different-session";
    expect(refreshCompanionDock(dock)).toBeNull();
    replacement.dataset.companionDockId = dock.id;
    document.body.append(replacement);
    expect(refreshCompanionDock(dock)).toBeNull();
    page.remove();
  });
});
