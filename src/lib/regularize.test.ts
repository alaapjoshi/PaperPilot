import { describe, expect, it } from "vitest";
import { regularize } from "./regularize";
import type { Point } from "../types";

describe("canonical overlays", () => {
  it("keeps the four corners of a rectangle and drops points along the sides", () => {
    const rect: Point[] = [[0.1, 0.2], [0.5, 0.2], [0.9, 0.2], [0.9, 0.5], [0.9, 0.8], [0.5, 0.8], [0.1, 0.8], [0.1, 0.5]];
    const fitted = regularize("rectangle", rect);
    expect(fitted).toHaveLength(4);
    for (const corner of [[0.1, 0.2], [0.9, 0.2], [0.9, 0.8], [0.1, 0.8]] as Point[]) {
      expect(fitted.some((p) => Math.hypot(p[0] - corner[0], p[1] - corner[1]) < 1e-6)).toBe(true);
    }
  });

  it("uses three corners for a triangle and five tips for a star", () => {
    const tri: Point[] = [[0.2, 0.8], [0.5, 0.8], [0.8, 0.8], [0.5, 0.2]];
    expect(regularize("triangle", tri)).toHaveLength(3);
    const tips: Point[] = Array.from({ length: 5 }, (_, k) => {
      const a = -Math.PI / 2 + (k / 5) * Math.PI * 2;
      return [0.5 + Math.cos(a) * 0.3, 0.5 + Math.sin(a) * 0.3] as Point;
    });
    const star = regularize("star", tips);
    expect(star.filter((_, i) => i % 2 === 0)).toHaveLength(5);
    expect(star).toHaveLength(10);
  });
});
