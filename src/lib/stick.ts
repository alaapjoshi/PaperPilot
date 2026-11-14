import { pointInPolygon } from "./geometry";
import type { Point } from "../types";

/** Area centroid, so the stick's rest point is the middle of the drawn shape. */
function centroid(polygon: Point[]): Point {
  let a = 0, cx = 0, cy = 0;
  polygon.forEach(([x0, y0], i) => {
    const [x1, y1] = polygon[(i + 1) % polygon.length];
    const k = x0 * y1 - x1 * y0;
    a += k;
    cx += (x0 + x1) * k;
    cy += (y0 + y1) * k;
  });
  if (Math.abs(a) < 1e-9) {
    return [polygon.reduce((s, p) => s + p[0], 0) / polygon.length, polygon.reduce((s, p) => s + p[1], 0) / polygon.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/**
 * Finger position inside a drawn shape, as a stick in [-1, 1].
 * Full deflection is the edge of that shape, not a fixed screen radius.
 * A radial dead zone keeps a finger resting in the middle from drifting the view.
 * Returns null when the finger is outside the ink outline.
 */
export function axisInShape(tip: Point, polygon: Point[], deadzone = 0.16): { x: number; y: number } | null {
  if (polygon.length < 3 || !pointInPolygon(tip, polygon)) return null;
  const [cx, cy] = centroid(polygon);
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const hx = Math.max(0.015, (Math.max(...xs) - Math.min(...xs)) / 2);
  const hy = Math.max(0.015, (Math.max(...ys) - Math.min(...ys)) / 2);
  const x = Math.max(-1, Math.min(1, (tip[0] - cx) / hx));
  const y = Math.max(-1, Math.min(1, (tip[1] - cy) / hy));
  const mag = Math.hypot(x, y);
  if (mag < deadzone) return { x: 0, y: 0 };
  const scale = (mag - deadzone) / (1 - deadzone) / mag;
  return { x: x * scale, y: y * scale };
}

/** 0 at the top of the shape, 1 at the bottom. Null outside. */
export function levelInShape(tip: Point, polygon: Point[]): number | null {
  if (polygon.length < 3 || !pointInPolygon(tip, polygon)) return null;
  const ys = polygon.map((p) => p[1]);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  if (y1 - y0 < 1e-4) return 0.5;
  return Math.max(0, Math.min(1, (tip[1] - y0) / (y1 - y0)));
}
