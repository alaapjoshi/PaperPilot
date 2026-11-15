import { describe, expect, it } from "vitest";
import type { Point } from "../types";
import { hitControl, pointInPolygon } from "./geometry";

const unit: Point[] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
describe("paper-space hit testing", () => {
  it("handles edges, off-paper fingertips, and concave controls", () => {
    const lShape: Point[] = [
      [0, 0],
      [1, 0],
      [1, 0.3],
      [0.3, 0.3],
      [0.3, 1],
      [0, 1],
    ];
    expect(pointInPolygon([0.2, 0.9], lShape)).toBe(true);
    expect(pointInPolygon([0.8, 0.8], lShape)).toBe(false);
    expect(pointInPolygon([0, 0.5], lShape)).toBe(true);
    expect(pointInPolygon([-0.1, 0.5], unit)).toBe(false);
    expect(pointInPolygon([NaN, 0.5], unit)).toBe(false);
  });
});

describe("hitControl", () => {
  const box = (id: string, x: number) => ({
    id,
    polygon: [[x, 0.2], [x + 0.1, 0.2], [x + 0.1, 0.8], [x, 0.8]] as Point[],
  });
  const controls = [box("a", 0.1), box("b", 0.4)];
  it("prefers the shape under the point, then the nearest one in range", () => {
    expect(hitControl([0.15, 0.5], controls)?.id).toBe("a");
    expect(hitControl([0.24, 0.5], controls)?.id).toBe("a"); // 0.04 right of a
    expect(hitControl([0.37, 0.5], controls)?.id).toBe("b"); // 0.03 left of b
    expect(hitControl([0.3, 0.5], controls)).toBeUndefined(); // gap middle, too far
    expect(hitControl([0.15, 0.95], controls)).toBeUndefined();
  });
});
