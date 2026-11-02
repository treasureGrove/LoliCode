import { describe, expect, it } from "vitest";
import {
  advanceRigBlend,
  deformCompanionRigPoint,
  EMPTY_RIG_BLEND,
  rigFrameDelta,
  sampleCompanionRigPose,
  sampleRigFeeding,
} from "@/features/agent/companionRigMotion";

describe("continuous companion motion", () => {
  it("anchors the boots throughout standing, petting, feeding, and sleeping", () => {
    for (const motion of ["idle", "pet", "feed", "sleep"] as const) {
      const blend = { ...EMPTY_RIG_BLEND, [motion]: 1 };
      for (const time of [0, 350, 1100, 1800, 3200, 5900, 15000]) {
        const pose = sampleCompanionRigPose(time, time, motion, blend);
        expect(deformCompanionRigPoint(0.53, 0.98, pose)).toEqual([0.53, 0.98]);
      }
    }
  });

  it("keeps the face rigid while the surrounding illustration moves", () => {
    const pose = sampleCompanionRigPose(1700, 650, "pet", {
      ...EMPTY_RIG_BLEND,
      pet: 1,
    });
    const a = deformCompanionRigPoint(0.4, 0.3, pose);
    const b = deformCompanionRigPoint(0.6, 0.38, pose);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(
      Math.hypot(0.2, 0.08),
      8,
    );
    expect(a).not.toEqual([0.4, 0.3]);
  });

  it("moves food to the mouth before three bites and clears it before the action ends", () => {
    expect(sampleRigFeeding(0).visible).toBe(false);
    expect(sampleRigFeeding(900).approach).toBe(1);
    expect(sampleRigFeeding(900).bite).toBe(0);
    expect(sampleRigFeeding(1200).bite).toBeCloseTo(1 / 3);
    expect(sampleRigFeeding(1700).bite).toBeCloseTo(2 / 3);
    expect(sampleRigFeeding(2200).bite).toBeCloseTo(1);
    expect(sampleRigFeeding(2200).visible).toBe(false);
    expect(sampleRigFeeding(3200).crumbProgress).toBe(-1);
  });

  it("gently enters drag and sleep without advancing on a resumed first frame", () => {
    expect(rigFrameDelta(100000, null)).toBe(0);
    expect(rigFrameDelta(100000, 1000)).toBe(50);
    expect(rigFrameDelta(10, 20)).toBe(0);
    const first = advanceRigBlend(EMPTY_RIG_BLEND, "drag", 16);
    expect(first.drag).toBeGreaterThan(0);
    expect(first.drag).toBeLessThan(0.2);
    expect(advanceRigBlend(first, "idle", 16).drag).toBeLessThan(first.drag);
    let sleep = { ...EMPTY_RIG_BLEND };
    for (let n = 0; n < 40; n++) sleep = advanceRigBlend(sleep, "sleep", 16);
    expect(
      sampleCompanionRigPose(0, 640, "sleep", sleep).eyeClosed,
    ).toBeGreaterThan(0.99);
  });

  it("ends the pet expression and keeps all mesh movement within the art margin", () => {
    expect(
      sampleCompanionRigPose(0, 1800, "pet", { ...EMPTY_RIG_BLEND, pet: 1 })
        .eyeClosed,
    ).toBe(0);
    for (const motion of ["idle", "feed", "pet", "sleep", "drag"] as const) {
      const blend = { ...EMPTY_RIG_BLEND, [motion]: 1 };
      for (const time of [0, 600, 1600, 4200]) {
        const pose = sampleCompanionRigPose(time, 600, motion, blend);
        for (let y = 0; y <= 16; y++)
          for (let x = 0; x <= 12; x++) {
            const point = deformCompanionRigPoint(x / 12, y / 16, pose);
            expect(Math.abs(point[0] - x / 12)).toBeLessThan(0.03);
            expect(Math.abs(point[1] - y / 16)).toBeLessThan(0.03);
          }
      }
    }
  });
});
