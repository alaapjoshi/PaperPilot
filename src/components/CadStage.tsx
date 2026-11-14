import { useEffect, useRef } from "react";

/** A small steel bracket. Paper JOY orbits it; ZOOM sets distance; HOME resets. */
const FACES: [number, number, number][][] = [];
function addBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  for (const [a, b, c, d] of [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 3, 7, 4], [1, 2, 6, 5]] as [number, number, number, number][])
    FACES.push([v[a], v[b], v[c], v[d]] as [number, number, number][]);
}
addBox(-1.3, -0.2, -0.7, 1.1, 0.12, 0.7);
addBox(-1.3, 0.12, -0.7, -0.95, 1.35, 0.7);
addBox(-0.95, 0.12, -0.18, -0.15, 0.72, 0.18);

type Vec = [number, number, number];

export function CadStage({
  joy,
  zoom,
  homeTick,
  section,
}: {
  joy: { x: number; y: number };
  zoom: number | null;
  homeTick: number;
  section: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const joyRef = useRef(joy);
  const zoomRef = useRef(zoom);
  const sectionRef = useRef(section);
  joyRef.current = joy;
  zoomRef.current = zoom;
  sectionRef.current = section;
  const homeNow = useRef(homeTick);
  homeNow.current = homeTick;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const view = { yaw: 0.7, pitch: 0.45, dist: 4.4 };
    const home = { ...view };
    let seenHome = homeNow.current;
    let last = performance.now();
    let raf = 0;
    const project = (p: Vec, w: number, h: number): [number, number, number] => {
      const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw);
      const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
      const x1 = p[0] * cy - p[2] * sy;
      const z1 = p[0] * sy + p[2] * cy;
      const y1 = p[1] * cp - z1 * sp;
      const z2 = p[1] * sp + z1 * cp;
      const f = 280 / (view.dist + z2);
      return [w / 2 + x1 * f, h / 2 - y1 * f, z2];
    };
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (seenHome !== homeNow.current) {
        seenHome = homeNow.current;
        Object.assign(view, home);
      }
      const stick = joyRef.current;
      view.yaw += stick.x * 1.8 * dt;
      view.pitch = Math.max(-1.15, Math.min(1.15, view.pitch + stick.y * 1.4 * dt));
      if (zoomRef.current !== null) view.dist = 2.4 + zoomRef.current * 5.5;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(2, Math.floor(el.clientWidth * dpr));
      const h = Math.max(2, Math.floor(el.clientHeight * dpr));
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
      }
      ctx.fillStyle = "#16181d";
      ctx.fillRect(0, 0, w, h);
      const faces = FACES.map((face) => {
        const pts = face.map((p) => project(p, w, h));
        const z = pts.reduce((s, p) => s + p[2], 0) / pts.length;
        const cy = face.reduce((s, p) => s + p[1], 0) / face.length;
        return { pts, z, cy };
      })
        .filter((f) => !sectionRef.current || f.cy < 0.35)
        .sort((a, b) => b.z - a.z);
      for (const face of faces) {
        ctx.beginPath();
        face.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.closePath();
        const light = Math.max(0.25, Math.min(1, 0.55 + face.z / 8));
        ctx.fillStyle = `rgb(${Math.round(120 * light)}, ${Math.round(138 * light)}, ${Math.round(156 * light)})`;
        ctx.strokeStyle = "#0e1014";
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = "#f4f2ed";
      ctx.font = "14px system-ui, sans-serif";
      ctx.fillText(sectionRef.current ? "Section" : "Bracket", 14, 24);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") view.yaw -= 0.12;
      else if (e.key === "ArrowRight") view.yaw += 0.12;
      else if (e.key === "ArrowUp") view.pitch -= 0.1;
      else if (e.key === "ArrowDown") view.pitch += 0.1;
      else if (e.key === "h" || e.key === "H") Object.assign(view, home);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return <canvas ref={canvas} className="cad-view" width={960} height={540} aria-label="CAD bracket" />;
}
