import { describe, expect, it } from "vitest";
import { applyCubePaper, cubeRole } from "./cubePaper";
import { HOME_POSE, type CubePose } from "./gesture";

function pose(): CubePose {
  return { ...HOME_POSE };
}

describe("cubeRole", () => {
  it("reads the four words the cube demo asks for", () => {
    expect(cubeRole("SPIN")).toBe("spin");
    expect(cubeRole("roll")).toBe("roll");
    expect(cubeRole("Size")).toBe("size");
    expect(cubeRole("HOME")).toBe("home");
  });
  it("accepts the same ideas written another way", () => {
    expect(cubeRole("turn")).toBe("spin");
    expect(cubeRole("twist")).toBe("roll");
    expect(cubeRole("scale")).toBe("size");
    expect(cubeRole("reset")).toBe("home");
  });
  it("leaves the bracket words alone", () => {
    expect(cubeRole("JOY")).toBeNull();
    expect(cubeRole("ZOOM")).toBeNull();
    expect(cubeRole("")).toBeNull();
  });
});

describe("applyCubePaper", () => {
  it("turns while SPIN is held off-center, and holds still at dt 0", () => {
    const p = pose();
    applyCubePaper(p, { spin: { x: 1, y: -1 }, roll: null, size: null }, 0);
    expect(p.yaw).toBe(HOME_POSE.yaw);
    applyCubePaper(p, { spin: { x: 1, y: -1 }, roll: null, size: null }, 0.5);
    expect(p.yaw).toBeCloseTo(HOME_POSE.yaw + 2 * 0.05);
    expect(p.pitch).toBeCloseTo(HOME_POSE.pitch - 1.6 * 0.05);
  });
  it("rolls in the direction of the slide", () => {
    const p = pose();
    applyCubePaper(p, { spin: null, roll: { x: -1 }, size: null }, 0.05);
    expect(p.roll).toBeCloseTo(-2.2 * 0.05);
  });
  it("maps SIZE from the middle of the shape", () => {
    const p = pose();
    applyCubePaper(p, { spin: null, roll: null, size: { x: 0, y: 0 } }, 0.05);
    expect(p.sx).toBe(1);
    expect(p.sy).toBe(1);
    applyCubePaper(p, { spin: null, roll: null, size: { x: 1, y: -1 } }, 0.05);
    expect(p.sx).toBeCloseTo(2.2);
    expect(p.sy).toBeCloseTo(2.2);
    applyCubePaper(p, { spin: null, roll: null, size: { x: -1, y: 1 } }, 0.05);
    expect(p.sx).toBe(0.4);
    expect(p.sy).toBe(0.4);
  });
});
