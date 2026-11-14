import { useEffect, useRef } from "react";

/**
 * A one-button Geometry Dash: the cube runs on its own, and each new `jumps` value hops it.
 * `jumps` comes from the paper shape registered as JUMP.
 */
export function DashGame({
  running,
  jumps,
  onFinish,
}: {
  running: boolean;
  jumps: number;
  onFinish: (score: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const jumpsRef = useRef(jumps);
  const finishRef = useRef(onFinish);
  jumpsRef.current = jumps;
  finishRef.current = onFinish;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const w = el.width;
    const h = el.height;
    const ground = h - 32;
    if (!running) {
      ctx.fillStyle = "#111318";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#2a2e36";
      ctx.fillRect(0, ground, w, h - ground);
      ctx.fillStyle = "#9aa0aa";
      ctx.font = "16px system-ui, sans-serif";
      ctx.fillText("Register JUMP, then start", 16, h / 2);
      return;
    }

    let y = ground - 28;
    let vy = 0;
    let world = 0;
    let nextSpike = 320;
    let seen = jumpsRef.current;
    let alive = true;
    let last = performance.now();
    const spikes: number[] = [];
    let raf = 0;

    const frame = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      if (alive) {
        world += 220 * dt;
        vy += 1800 * dt;
        y += vy * dt;
        if (y > ground - 28) {
          y = ground - 28;
          vy = 0;
        }
        if (jumpsRef.current !== seen && y >= ground - 29) {
          vy = -620;
          seen = jumpsRef.current;
        } else seen = jumpsRef.current;
        while (nextSpike < world + w + 40) {
          spikes.push(nextSpike);
          nextSpike += 160 + Math.random() * 180;
        }
        const px = 72;
        for (const spike of spikes) {
          const sx = spike - world;
          if (sx > px + 26 || sx + 22 < px) continue;
          if (y + 26 > ground - 22) alive = false;
        }
      }

      ctx.fillStyle = "#111318";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#1c2028";
      ctx.fillRect(0, ground, w, h - ground);
      ctx.strokeStyle = "#3a4150";
      ctx.beginPath();
      for (let x = -((world / 2) % 40); x < w; x += 40) {
        ctx.moveTo(x, ground);
        ctx.lineTo(x, h);
      }
      ctx.stroke();
      ctx.fillStyle = "#f4f2ed";
      for (const spike of spikes) {
        const sx = spike - world;
        if (sx < -30 || sx > w + 30) continue;
        ctx.beginPath();
        ctx.moveTo(sx, ground);
        ctx.lineTo(sx + 11, ground - 26);
        ctx.lineTo(sx + 22, ground);
        ctx.fill();
      }
      ctx.fillStyle = alive ? "#2ee6a6" : "#ff5a36";
      ctx.fillRect(72, y, 26, 26);
      ctx.fillStyle = "#f4f2ed";
      ctx.font = "bold 18px system-ui, sans-serif";
      ctx.fillText(String(Math.floor(world / 12)), 16, 28);
      if (!alive) {
        ctx.fillStyle = "#f4f2ed";
        ctx.font = "bold 22px system-ui, sans-serif";
        ctx.fillText("Crashed", w / 2 - 48, h / 2);
        finishRef.current(Math.floor(world / 12));
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  return <canvas ref={canvas} className="dash" width={640} height={200} aria-label="Paper Dash" />;
}
