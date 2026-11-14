import type { PaperControl, Point } from "../types";

/** Scale degrees of Twinkle, Twinkle Little Star, mapped onto whatever keys were drawn. */
const TWINKLE = [0, 0, 4, 4, 5, 5, 4, 3, 3, 2, 2, 1, 1, 0, 4, 4, 3, 3, 2, 2, 1, 4, 4, 3, 3, 2, 2, 1, 0, 0, 4, 4, 5, 5, 4, 3, 3, 2, 2, 1, 1, 0];

const centerX = (c: PaperControl) => c.polygon.reduce((s, p: Point) => s + p[0], 0) / c.polygon.length;

/** Left-to-right keys (notes if any were drawn, otherwise every shape) in song order. */
export function songOrder(controls: PaperControl[]): string[] {
  const notes = controls.filter((c) => c.action.type === "note");
  const keys = (notes.length >= 2 ? notes : controls).slice().sort((a, b) => centerX(a) - centerX(b));
  if (keys.length < 2) return [];
  return TWINKLE.map((degree) => keys[degree % keys.length].id);
}
