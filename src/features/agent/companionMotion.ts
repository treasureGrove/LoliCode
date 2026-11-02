import atlas from "@/assets/atelier/companion-motion-v2.webp?inline";
import type { CompanionActorLayout } from "./CompanionActor";

export const companionMotionSource = atlas;

/** Each row contains painted poses, rather than transforms of a still image. */
export const COMPANION_MOTION_LAYOUT: CompanionActorLayout = {
  columns: 6,
  rows: 5,
  frameWidth: 256,
  frameHeight: 256,
  clips: {
    idle: {
      row: 0,
      frames: 5,
      sequence: [5, 4, 2, 4, 5],
      durations: [3800, 75, 110, 85, 1200],
      loop: true,
    },
    feed: {
      row: 1,
      frames: 6,
      durations: [180, 180, 320, 180, 350, 250],
      loop: false,
    },
    pet: {
      row: 2,
      frames: 7,
      sequence: [0, 1, 3, 5, 3, 1, 0],
      durations: [160, 160, 240, 260, 240, 160, 200],
      loop: false,
    },
    sleep: {
      row: 3,
      frames: 4,
      sequence: [1, 5, 4, 5],
      durations: [1100, 900, 1100, 900],
      loop: true,
    },
    drag: {
      row: 4,
      frames: 1,
      sequence: [0],
      durations: [1000],
      loop: true,
    },
  },
};
