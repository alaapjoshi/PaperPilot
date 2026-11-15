import { describe, expect, it } from "vitest";
import { CubeGestures, HOME_POSE } from "./gesture";
import type { Finger } from "./tracking";

const PALM = 0.1;
/** One hand: thumb and index around `at` (touching when pinched), other fingers spread nearby. */
function hand(name: string, at: [number, number], pinch = false, jitter = 0): Finger[] {
  const [x, y] = at;
  const gap = pinch ? 0.005 : 0.06;
  const pts: [number, number][] = [[x - gap, y + jitter], [x + gap, y + jitter], [x + 0.03, y - 0.1], [x + 0.06, y - 0.1], [x + 0.09, y - 0.08]];
  return pts.map((p, i) => ({ id: `${name}:${i}`, tip: p, raw: p, palmWidth: PALM }));
}
const run = (g: CubeGestures, frames: Finger[][]) => frames.forEach((f, i) => g.update(f, i * 33, 1));

describe("CubeGestures", () => {
  it("spins smoothly with one pinching hand, in the direction of the drag", () => {
    const g = new CubeGestures();
    const frames = Array.from({ length: 12 }, (_, i) => hand("Right", [0.4 + Math.min(i, 6) * 0.02, 0.5], true));
    run(g, frames);
    expect(g.mode).toBe("rotate");
    expect(g.pose.yaw).toBeGreaterThan(HOME_POSE.yaw + 0.3);
    expect(g.pose.yaw).toBeLessThan(HOME_POSE.yaw + 0.6); // 0.12 of the frame × 4.5
  });
  it("holds still while pinching with tracker jitter", () => {
    const g = new CubeGestures();
    run(g, Array.from({ length: 20 }, (_, i) => hand("Right", [0.5, 0.5], true, i % 2 ? 0.001 : -0.001)));
    expect(g.pose.yaw).toBeCloseTo(HOME_POSE.yaw, 3);
    expect(g.pose.pitch).toBeCloseTo(HOME_POSE.pitch, 3);
  });
  it("ignores an open hand, and only reports thumb and index points", () => {
    const g = new CubeGestures();
    run(g, [hand("Right", [0.3, 0.5]), hand("Right", [0.7, 0.5])]);
    expect(g.pose).toEqual(HOME_POSE);
    expect(g.points).toHaveLength(2);
  });
  it("stretches wide when two pinching hands pull apart sideways", () => {
    const g = new CubeGestures();
    const frames = [[0.4, 0.6], ...Array(15).fill([0.3, 0.7])].map(([l, r]) => [...hand("Left", [l, 0.5], true), ...hand("Right", [r, 0.5], true)]);
    run(g, frames);
    expect(g.mode).toBe("stretch");
    expect(g.pose.sx).toBeCloseTo(2, 1);
    expect(g.pose.sy).toBe(1);
  });
});
