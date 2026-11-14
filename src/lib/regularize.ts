import type { AiShape } from "../../server/identify";
import type { Point } from "../types";

/**
 * Turn a traced blob into the polygon that shape is supposed to be.
 * A rectangle keeps 4 corners, a triangle 3, a diamond 4, a star its 5 tips.
 * Only those corners move, so the overlay stays a clean shape sat on the drawing.
 */
export function regularize(shape: AiShape["shape"], points: Point[]): Point[] {
  if (points.length < 3) return points;
  if (shape === "circle") return ellipse(points, 20);
  const hull = convexHull(points);
  if (hull.length < 3) return points;
  if (shape === "star") return star(hull);
  const count = shape === "triangle" ? 3 : shape === "other" ? Math.min(6, hull.length) : 4;
  return sharpest(hull, count);
}

function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const unique = sorted.filter((p, i) => i === 0 || p[0] !== sorted[i - 1][0] || p[1] !== sorted[i - 1][1]);
  if (unique.length <= 2) return unique;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list: Point[]) => {
    const h: Point[] = [];
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  return [...build(unique), ...build([...unique].reverse())];
}

/** The n sharpest hull corners, in boundary order. Edge points along a straight side are dropped. */
function sharpest(hull: Point[], count: number): Point[] {
  if (hull.length <= count) return hull;
  const ranked = hull
    .map((p, i) => ({ i, turn: turn(hull[(i - 1 + hull.length) % hull.length], p, hull[(i + 1) % hull.length]) }))
    .sort((a, b) => b.turn - a.turn)
    .slice(0, count)
    .map((s) => s.i)
    .sort((a, b) => a - b);
  return ranked.map((i) => hull[i]);
}

function turn(prev: Point, p: Point, next: Point) {
  const ax = p[0] - prev[0], ay = p[1] - prev[1];
  const bx = next[0] - p[0], by = next[1] - p[1];
  return Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
}

/** Five tips, then a notch between each, so the overlay is a star rather than a pentagon. */
function star(hull: Point[]): Point[] {
  const tips = sharpest(hull, Math.min(5, hull.length));
  if (tips.length < 5) return tips;
  const cx = tips.reduce((s, p) => s + p[0], 0) / tips.length;
  const cy = tips.reduce((s, p) => s + p[1], 0) / tips.length;
  const ordered = tips
    .map((p) => ({ p, a: Math.atan2(p[1] - cy, p[0] - cx) }))
    .sort((a, b) => a.a - b.a);
  const outer = ordered.reduce((s, t) => s + Math.hypot(t.p[0] - cx, t.p[1] - cy), 0) / ordered.length;
  const inner = outer * 0.4;
  const out: Point[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const tip = ordered[i];
    const next = ordered[(i + 1) % ordered.length];
    const mid = tip.a + ((next.a - tip.a + Math.PI * 2) % (Math.PI * 2)) / 2;
    out.push(tip.p);
    out.push([cx + Math.cos(mid) * inner, cy + Math.sin(mid) * inner]);
  }
  return out;
}

function ellipse(points: Point[], samples: number): Point[] {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  let xx = 0, yy = 0, xy = 0;
  for (const p of points) {
    const x = p[0] - cx, y = p[1] - cy;
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  const ang = 0.5 * Math.atan2(2 * xy, xx - yy);
  const c = Math.cos(ang), s = Math.sin(ang);
  let rx = 0, ry = 0;
  for (const p of points) {
    const x = p[0] - cx, y = p[1] - cy;
    rx = Math.max(rx, Math.abs(x * c + y * s));
    ry = Math.max(ry, Math.abs(-x * s + y * c));
  }
  rx = Math.max(rx, 0.01);
  ry = Math.max(ry, 0.01);
  return Array.from({ length: samples }, (_, i) => {
    const t = (i / samples) * Math.PI * 2;
    const x = Math.cos(t) * rx, y = Math.sin(t) * ry;
    return [cx + x * c - y * s, cy + x * s + y * c] as Point;
  });
}
