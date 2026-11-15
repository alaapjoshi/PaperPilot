import type { Finger } from "./tracking";
import type { Point } from "../types";

/** Cube pose: rotation in radians, scale per axis (1 = normal size). */
export interface CubePose {
  yaw: number;
  pitch: number;
  roll: number;
  sx: number;
  sy: number;
  sz: number;
}
export const HOME_POSE: CubePose = { yaw: 0.6, pitch: -0.4, roll: 0, sx: 1, sy: 1, sz: 1 };
export type GestureMode = "idle" | "rotate" | "stretch";

const PINCH_ON = 0.3; // thumb–index gap (palm widths) that starts a pinch
const PINCH_OFF = 0.45; // gap that ends it; the gap between the two stops flicker
const SMOOTH = 0.35; // weight of the newest pinch position (lower = smoother, more lag)
const DEADZONE = 0.002; // ignore smaller per-frame moves (normalized), so a still hand holds still
const SPIN = 4.5; // radians per full frame width of drag
const COAST = 5; // how fast the spin dies out after letting go (per second)
const clampScale = (v: number) => Math.min(3, Math.max(0.3, v));

/**
 * Hands → cube, using only each hand's thumb and index fingertip.
 * One hand pinching and dragging spins the cube; letting go coasts briefly.
 * Two hands pinching: pulling apart sideways stretches it wide, up/down stretches it tall,
 * moving together shrinks it, and twisting the line between the hands rolls it.
 */
export class CubeGestures {
  pose: CubePose = { ...HOME_POSE };
  mode: GestureMode = "idle";
  /** Thumb and index tips of every hand (the only points this mode uses), for display. */
  points: Point[] = [];
  private pinching = new Set<string>();
  private smooth = new Map<string, Point>(); // smoothed pinch point per hand
  private last: { t: number | null; one?: { id: string; p: Point }; two?: { dx: number; dy: number; angle: number; sx: number; sy: number; roll: number } } = { t: null };
  private spin = { yaw: 0, pitch: 0 };

  /** fingers: tracked fingertips (ids "<hand>:<0-4>"); only 0 (thumb) and 1 (index) are read. */
  update(fingers: Finger[], t: number, aspect: number): CubePose {
    const dt = this.last.t === null ? 0 : Math.min(0.1, Math.max(0, (t - this.last.t) / 1000));
    const pinched = this.readPinches(fingers, aspect);

    if (pinched.length >= 2) {
      const [a, b] = pinched.map((h) => h.p);
      const dx = (b[0] - a[0]) * aspect, dy = b[1] - a[1];
      const angle = Math.atan2(dy, dx);
      if (!this.last.two) this.last.two = { dx, dy, angle, sx: this.pose.sx, sy: this.pose.sy, roll: this.pose.roll };
      const s = this.last.two;
      if (Math.abs(s.dx) > 0.06) this.pose.sx = clampScale((s.sx * Math.abs(dx)) / Math.abs(s.dx));
      if (Math.abs(s.dy) > 0.06) this.pose.sy = clampScale((s.sy * Math.abs(dy)) / Math.abs(s.dy));
      let d = angle - s.angle;
      d = Math.atan2(Math.sin(d), Math.cos(d)); // wrap so crossing the axis doesn't flip it
      this.pose.roll = s.roll + d;
      this.last.one = undefined;
      this.spin = { yaw: 0, pitch: 0 };
      this.mode = "stretch";
    } else if (pinched.length === 1) {
      const { id, p } = pinched[0];
      if (this.last.one?.id === id) {
        let mx = p[0] - this.last.one.p[0], my = p[1] - this.last.one.p[1];
        if (Math.hypot(mx, my) < DEADZONE) mx = my = 0;
        this.pose.yaw += mx * SPIN;
        this.pose.pitch += my * SPIN;
        if (dt > 0) this.spin = { yaw: (mx * SPIN) / dt, pitch: (my * SPIN) / dt };
        if (mx || my) this.last.one = { id, p };
      } else this.last.one = { id, p }; // a new grab: no jump on the first frame
      this.last.two = undefined;
      this.mode = "rotate";
    } else {
      this.pose.yaw += this.spin.yaw * dt;
      this.pose.pitch += this.spin.pitch * dt;
      const k = Math.exp(-dt * COAST);
      this.spin = { yaw: this.spin.yaw * k, pitch: this.spin.pitch * k };
      this.last.one = undefined;
      this.last.two = undefined;
      this.mode = "idle";
    }
    this.last.t = t;
    return this.pose;
  }

  reset() {
    this.pose = { ...HOME_POSE };
    this.spin = { yaw: 0, pitch: 0 };
    this.last = { t: this.last.t };
  }

  private readPinches(fingers: Finger[], aspect: number): { id: string; p: Point }[] {
    const hands = new Map<string, { thumb?: Finger; index?: Finger }>();
    for (const f of fingers) {
      const cut = f.id.lastIndexOf(":");
      const hand = f.id.slice(0, cut), n = f.id.slice(cut + 1);
      if (n !== "0" && n !== "1") continue; // only the thumb and index finger
      const h = hands.get(hand) ?? {};
      if (n === "0") h.thumb = f;
      else h.index = f;
      hands.set(hand, h);
    }
    this.points = [];
    const out: { id: string; p: Point }[] = [];
    for (const [id, { thumb, index }] of hands) {
      if (!thumb || !index) continue;
      const a = thumb.raw ?? thumb.tip, b = index.raw ?? index.tip;
      this.points.push(a, b);
      const palm = thumb.palmWidth;
      if (!(palm > 0.005)) continue;
      const gap = Math.hypot((a[0] - b[0]) * aspect, a[1] - b[1]) / palm;
      const was = this.pinching.has(id);
      if (gap < PINCH_ON || (was && gap < PINCH_OFF)) {
        const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        const prev = was ? this.smooth.get(id) : undefined;
        const p: Point = prev ? [prev[0] + SMOOTH * (mid[0] - prev[0]), prev[1] + SMOOTH * (mid[1] - prev[1])] : mid;
        this.smooth.set(id, p);
        this.pinching.add(id);
        out.push({ id, p });
      } else {
        this.pinching.delete(id);
        this.smooth.delete(id);
      }
    }
    for (const id of [...this.pinching]) if (!hands.has(id)) (this.pinching.delete(id), this.smooth.delete(id));
    return out;
  }
}
