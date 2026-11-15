import { useEffect, useRef } from "react";
import type { CubePaperMode } from "../lib/cubePaper";
import type { CubePose, GestureMode } from "../lib/gesture";

export type CubeViewMode = GestureMode | CubePaperMode;

type Vec = [number, number, number];
const CORNERS: Vec[] = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
// Each face: corner indices (outward winding) and a colour.
const FACES: [number[], string][] = [
  [[0, 3, 2, 1], "#2f6bff"], // back
  [[4, 5, 6, 7], "#38bdf8"], // front
  [[0, 1, 5, 4], "#7c3aed"], // bottom
  [[3, 7, 6, 2], "#e9a100"], // top
  [[0, 4, 7, 3], "#ff5a36"], // left
  [[1, 2, 6, 5], "#16a34a"], // right
];

/** A floating cube drawn on a canvas; `pose` is read every frame so hand updates don't re-render React. */
export function CubeStage({ pose, mode }: { pose: { current: CubePose }; mode: CubeViewMode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    let raf = 0;
    const draw = (now: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth, h = el.clientHeight;
      if (el.width !== Math.round(w * dpr)) [el.width, el.height] = [Math.round(w * dpr), Math.round(h * dpr)];
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const p = pose.current;
      const bob = Math.sin(now / 700) * 0.08; // gentle float
      const [cy, sy] = [Math.cos(p.yaw), Math.sin(p.yaw)];
      const [cx, sx] = [Math.cos(p.pitch), Math.sin(p.pitch)];
      const [cz, sz] = [Math.cos(p.roll), Math.sin(p.roll)];
      const rotate = ([x, y, z]: Vec): Vec => {
        // roll (z), then pitch (x), then yaw (y)
        [x, y] = [x * cz - y * sz, x * sz + y * cz];
        [y, z] = [y * cx - z * sx, y * sx + z * cx];
        [x, z] = [x * cy + z * sy, -x * sy + z * cy];
        return [x, y, z];
      };
      const size = Math.min(w, h) * 0.17;
      const pts = CORNERS.map(([x, y, z]) => rotate([x * p.sx, y * p.sy, z * p.sz]));
      const project = ([x, y, z]: Vec): [number, number] => {
        const f = 5 / (5 - z);
        return [w / 2 + x * size * f, h / 2 - (y + bob) * size * f];
      };

      // Soft shadow under the cube.
      const spread = Math.max(p.sx, p.sz) * size * 1.3;
      const g = ctx.createRadialGradient(w / 2, h * 0.84, 0, w / 2, h * 0.84, spread);
      g.addColorStop(0, "rgba(56,189,248,0.25)");
      g.addColorStop(1, "rgba(56,189,248,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(w / 2, h * 0.84, spread, spread * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();

      // Painter's algorithm: far faces first; shade by how much each face points at us.
      const faces = FACES.map(([idx, color]) => {
        const v = idx.map((i) => pts[i]);
        const depth = v.reduce((s, q) => s + q[2], 0) / 4;
        const [a, b, c] = v;
        const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
        const light = Math.abs(n[2]) / (Math.hypot(...n) || 1);
        return { v, depth, color, light };
      }).sort((m, n) => m.depth - n.depth);
      for (const f of faces) {
        ctx.beginPath();
        f.v.map(project).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath();
        ctx.fillStyle = f.color;
        ctx.fill();
        ctx.fillStyle = `rgba(0,0,0,${(1 - f.light) * 0.55})`; // faces turned away get darker
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [pose]);

  const label = {
    idle: "Pinch, or use SPIN",
    rotate: "Spinning",
    stretch: "Stretching",
    spin: "SPIN",
    roll: "ROLL",
    size: "SIZE",
  }[mode];
  return (
    <div className="cube-view">
      <canvas ref={canvas} aria-label="A floating 3D cube you control with hand gestures" />
      <span className={`cube-mode ${mode}`}>{label}</span>
    </div>
  );
}
