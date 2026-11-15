import type { Point } from "../types";

const EPSILON = 1e-9;

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(point: Point, a: Point, b: Point): boolean {
  return (
    Math.abs(cross(a, b, point)) < EPSILON &&
    point[0] >= Math.min(a[0], b[0]) - EPSILON &&
    point[0] <= Math.max(a[0], b[0]) + EPSILON &&
    point[1] >= Math.min(a[1], b[1]) - EPSILON &&
    point[1] <= Math.max(a[1], b[1]) + EPSILON
  );
}

function contains(
  point: Point,
  polygon: Point[],
  includeBoundary: boolean,
): boolean {
  if (polygon.length < 3 || !point.every(Number.isFinite)) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    if (onSegment(point, a, b)) return includeBoundary;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

/** Boundary points count as hits, so strokes are touchable too. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  return contains(point, polygon, true);
}

function distanceToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

/**
 * The control under `point`, else the nearest one whose outline is within `radius`.
 * Fingertips and clicks land a little off the pencil line, so near misses still count.
 * `aspect` (width / height) keeps the radius round on a non-square frame; radius is in heights.
 */
export function hitControl<T extends { polygon: Point[] }>(
  point: Point,
  controls: T[],
  aspect = 1,
  radius = 0.07,
): T | undefined {
  const scale = ([x, y]: Point): Point => [x * aspect, y];
  // Inside one or more shapes (slanted neighbours can touch): take the nearest centre.
  let best: T | undefined;
  let bestD = Infinity;
  for (const c of controls) {
    if (!pointInPolygon(point, c.polygon)) continue;
    const n = c.polygon.length;
    const d = Math.hypot(...scale(point).map((v, k) => v - c.polygon.reduce((s, p) => s + scale(p)[k], 0) / n));
    if (d < bestD) [best, bestD] = [c, d];
  }
  if (best) return best;
  bestD = radius;
  for (const c of controls) {
    const poly = c.polygon.map(scale);
    for (let i = 0; i < poly.length; i++) {
      const d = distanceToSegment(scale(point), poly[i], poly[(i + 1) % poly.length]);
      if (d < bestD) [best, bestD] = [c, d];
    }
  }
  return best;
}
