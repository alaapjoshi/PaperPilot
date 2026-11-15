import type { CubePose } from "./gesture";

/** Words to write in four shapes so the paper can drive the cube. */
export type CubeRole = "spin" | "roll" | "size" | "home";
export const CUBE_ROLES: CubeRole[] = ["spin", "roll", "size", "home"];
export const CUBE_HELP: Record<CubeRole, string> = {
  spin: "SPIN — push inside to turn",
  roll: "ROLL — slide left and right to roll",
  size: "SIZE — right wider, left narrower, up taller, down shorter",
  home: "HOME — tap to reset the cube",
};

/** Shown on the cube when the paper, rather than a pinch, is driving it. */
export type CubePaperMode = "spin" | "roll" | "size";

const YAW_RATE = 2;
const PITCH_RATE = 1.6;
const ROLL_RATE = 2.2;
const SIZE_SPAN = 1.2;

function clampScale(v: number) {
  return Math.min(2.6, Math.max(0.4, v));
}

/** Handwriting that names a cube control, or null. */
export function cubeRole(label: string): CubeRole | null {
  const t = label.trim().toLowerCase();
  if (/spin|turn|rotate/.test(t)) return "spin";
  if (/roll|twist/.test(t)) return "roll";
  if (/size|scale|stretch/.test(t)) return "size";
  if (/home|reset/.test(t)) return "home";
  return null;
}

/**
 * Paper → cube. SPIN and ROLL are speeds (hold off-center to keep going).
 * SIZE is a position: the middle of the shape is normal size.
 * Axes are [-1, 1], with +y downward, matching the desk joystick.
 */
export function applyCubePaper(
  pose: CubePose,
  input: {
    spin: { x: number; y: number } | null;
    roll: { x: number } | null;
    size: { x: number; y: number } | null;
  },
  dt: number,
): void {
  const t = Math.min(0.05, Math.max(0, dt));
  if (input.spin) {
    pose.yaw += input.spin.x * YAW_RATE * t;
    pose.pitch += input.spin.y * PITCH_RATE * t;
  }
  if (input.roll) pose.roll += input.roll.x * ROLL_RATE * t;
  if (input.size) {
    pose.sx = clampScale(1 + input.size.x * SIZE_SPAN);
    pose.sy = clampScale(1 - input.size.y * SIZE_SPAN);
  }
}
