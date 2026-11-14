import { describe, expect, it } from "vitest";
import { axisInShape, levelInShape } from "./stick";
import type { Point } from "../types";

const box: Point[] = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]];

describe("paper joystick", () => {
  it("rests at zero in the middle and reaches the drawn edge", () => {
    expect(axisInShape([0.5, 0.5], box)).toEqual({ x: 0, y: 0 });
    const edge = axisInShape([0.8, 0.5], box);
    expect(edge!.x).toBeGreaterThan(0.95);
    expect(Math.abs(edge!.y)).toBeLessThan(0.05);
  });
  it("ignores a finger outside the outline", () => {
    expect(axisInShape([0.05, 0.5], box)).toBeNull();
  });
  it("reads zoom from top to bottom of the shape", () => {
    expect(levelInShape([0.5, 0.2], box)).toBeCloseTo(0);
    expect(levelInShape([0.5, 0.8], box)).toBeCloseTo(1);
    expect(levelInShape([0.05, 0.5], box)).toBeNull();
  });
});
