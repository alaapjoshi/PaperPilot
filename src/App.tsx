import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Box, Camera, ImageUp, Play, RotateCcw, Trophy, X, LoaderCircle, Music } from "lucide-react";
import { AudioEngine } from "./lib/audio";
import { CameraController } from "./lib/camera";
import { HandTracker, type HandFrame } from "./lib/tracking";
import { hitControl, pointInPolygon } from "./lib/geometry";
import { recognizeControls } from "./lib/recognition";
import { aiToControls, BASE_OCTAVE, controlName, DRUMS, FX, SHAPE_VOICE, voiceOf, type Voice } from "./lib/aiLayout";
import { findRegions, inkMap, mergeShapes } from "./lib/regions";
import { regularize } from "./lib/regularize";
import { songOrder } from "./lib/song";
import { DashGame } from "./components/DashGame";
import { CadStage } from "./components/CadStage";
import { axisInShape, levelInShape } from "./lib/stick";
import type { AiShape } from "../server/identify";
import { TapDetector } from "./lib/tap";
import { noteName, type ControlAction, type ControlEvent, type PaperControl, type Point } from "./types";

type Step = "scan" | "play";
type Usage = { scans: number; inTokens: number; outTokens: number; costUsd: number; budgetUsd: number; ai?: boolean };

const KEYS = "asdfghjkl;qwertyuiop".split("");
const NOTES = Array.from({ length: 61 }, (_, i) => 36 + i); // C2..C7
const GAME_SECONDS = 30;
const TARGET_MS = 2200; // a lit shape moves on if you don't hit it in time

const VOICES: [Voice, string][] = [
  ["piano", "Piano"], ["marimba", "Marimba"], ["guitar", "Guitar"], ["bass", "Bass"],
  ["organ", "Organ"], ["synth", "Synth"], ["drums", "Drums"], ["fx", "Sound FX"],
];
const VOICE_NAME = Object.fromEntries(VOICES) as Record<Voice, string>;
const SHAPE_GLYPH: Record<AiShape["shape"], string> = { rectangle: "▭", circle: "◯", triangle: "△", diamond: "◇", star: "☆", other: "⬠" };
type CadRole = "joy" | "zoom" | "home";
const CAD_ROLES: CadRole[] = ["joy", "zoom", "home"];
const CAD_HELP: Record<CadRole, string> = {
  joy: "JOY — push inside it to orbit",
  zoom: "ZOOM — slide up and down",
  home: "HOME — tap to reset the view",
};
function cadRole(label: string): CadRole | null {
  const t = label.trim().toLowerCase();
  if (/joy|stick|orbit/.test(t)) return "joy";
  if (/zoom/.test(t)) return "zoom";
  if (/home|reset/.test(t)) return "home";
  return null;
}
/** A finger that vanishes for less than this (tracker dropout) keeps its press state. */
const FINGER_GRACE_MS = 160;
const label = (a: ControlAction) =>
  a.type === "note" ? noteName(a.midi) : a.type === "sound" ? a.sound[0].toUpperCase() + a.sound.slice(1) : a.action;

/** Area centroid (where a label looks centred), falling back to the vertex average for slivers. */
const center = (p: Point[]): Point => {
  let a = 0, cx = 0, cy = 0;
  p.forEach(([x0, y0], i) => {
    const [x1, y1] = p[(i + 1) % p.length], k = x0 * y1 - x1 * y0;
    a += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
  });
  if (Math.abs(a) < 1e-9) return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
  return [cx / (3 * a), cy / (3 * a)];
};

/** Demo paper: 8 keys plus 4 round drum pads, for trying it without a drawing. */
function demoControls(): PaperControl[] {
  const keys: PaperControl[] = [60, 62, 64, 65, 67, 69, 71, 72].map((midi, i) => ({
    id: `demo-k${i}`,
    kind: "key",
    name: noteName(midi),
    polygon: [[0.06 + i * 0.111, 0.42], [0.155 + i * 0.111, 0.42], [0.155 + i * 0.111, 0.92], [0.06 + i * 0.111, 0.92]],
    action: { type: "note", midi },
  }));
  const pads: PaperControl[] = DRUMS.map((sound, i) => ({
    id: `demo-d${i}`,
    kind: "pad",
    name: sound,
    polygon: Array.from({ length: 12 }, (_, k) => {
      const a = (k / 12) * Math.PI * 2;
      return [0.2 + i * 0.2 + Math.cos(a) * 0.065, 0.2 + Math.sin(a) * 0.1] as Point;
    }),
    action: { type: "sound", sound },
  }));
  return [...pads, ...keys];
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("Could not read that image."));
    im.src = src;
  });
}

/** Any image/video frame -> JPEG canvas at most 1024 px wide (keeps Gemini cost down). */
function toCanvas(src: HTMLVideoElement | HTMLImageElement) {
  const w = "videoWidth" in src ? src.videoWidth : src.naturalWidth;
  const h = "videoHeight" in src ? src.videoHeight : src.naturalHeight;
  const s = Math.min(1, 1024 / w);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * s);
  canvas.height = Math.round(h * s);
  canvas.getContext("2d")!.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function readBest() {
  try {
    return Number(localStorage.getItem("paperpilot.best")) || 0;
  } catch {
    return 0;
  }
}

export default function App() {
  const [step, setStep] = useState<Step>("scan");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [image, setImage] = useState<string | null>(null); // the scanned frame; null + no stream = demo paper
  const [aspect, setAspect] = useState(16 / 10);
  const [controls, setControls] = useState<PaperControl[]>([]);
  const [shapes, setShapes] = useState<AiShape[]>([]); // last AI scan (outlines snapped to the ink)
  const [useLetters, setUseLetters] = useState(true);
  const [still, setStill] = useState(false); // labels belong to an uploaded photo / demo, not the live feed
  const [busy, setBusy] = useState<"" | "camera" | "scan">("");
  const [notice, setNotice] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [trackerReady, setTrackerReady] = useState(false);
  const [trackError, setTrackError] = useState("");
  const [active, setActive] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<Set<string>>(new Set());
  const [tips, setTips] = useState<Point[]>([]);
  const [tab, setTab] = useState<"play" | "game" | "cad">("play");
  const [cadBind, setCadBind] = useState<Partial<Record<CadRole, string>>>({});
  const [cadAssign, setCadAssign] = useState<CadRole | null>(null);
  const [joy, setJoy] = useState({ x: 0, y: 0 });
  const [zoomLevel, setZoomLevel] = useState<number | null>(null);
  const [homeTick, setHomeTick] = useState(0);
  const [sectionOn, setSectionOn] = useState(false);
  const [gamePick, setGamePick] = useState<"song" | "dash">("song");
  const [jumpId, setJumpId] = useState("");
  const [assignJump, setAssignJump] = useState(false);
  const [dashOn, setDashOn] = useState(false);
  const [jumps, setJumps] = useState(0);
  const [dashScore, setDashScore] = useState<number | null>(null);
  const [fingers, setFingers] = useState<1 | 2 | 10>(1);
  const [game, setGame] = useState({ on: false, target: "", score: 0, combo: 0, left: 0, best: readBest(), pop: "" });

  const audio = useRef(new AudioEngine());
  const camera = useRef(new CameraController());
  const tracker = useRef(new HandTracker());
  const taps = useRef(new Map<string, TapDetector>()); // one per tracked fingertip
  const seen = useRef(new Map<string, number>()); // fingertip -> last time it was tracked
  const video = useRef<HTMLVideoElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  // slot (an input, or one fingertip) -> what it is holding
  const held = useRef(new Map<string, { id: string; source: ControlEvent["source"] }>());
  const targetAt = useRef(0);
  const songIds = useRef<string[]>([]);
  const songAt = useRef(0);
  const joyNow = useRef(joy);
  const zoomNow = useRef(zoomLevel);
  const live = useRef({ controls, aspect, game, tab, fingers, gamePick, jumpId, assignJump, dashOn, cadBind, cadAssign });
  live.current = { controls, aspect, game, tab, fingers, gamePick, jumpId, assignJump, dashOn, cadBind, cadAssign };

  useEffect(() => {
    fetch("/api/usage").then((r) => r.json()).then(setUsage).catch(() => setUsage(null));
  }, []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- sound -------------------------------------------------------------
  const wakeAudio = useCallback(() => {
    void audio.current.ready().catch((e) => setNotice(e.message));
  }, []);
  useEffect(() => {
    void audio.current.preload();
    // Capture so sound unlocks on the same click that plays a shape.
    const unlock = () => wakeAudio();
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
    };
  }, [wakeAudio]);

  const release = useCallback((slot: string) => {
    const h = held.current.get(slot);
    const c = live.current.controls.find((x) => x.id === h?.id);
    held.current.delete(slot);
    if (c && h)
      audio.current.trigger({ controlId: `${c.id}|${slot}`, phase: "up", value: 0, source: h.source, timestampMs: performance.now() }, c, "piano");
    setActive(new Set([...held.current.values()].map((x) => x.id)));
  }, []);

  const press = useCallback(
    (id: string, source: ControlEvent["source"], slot: string = source) => {
      const c = live.current.controls.find((x) => x.id === id);
      if (!c) return;
      if (held.current.has(slot)) release(slot);
      const desk = live.current.tab === "cad" && (id === live.current.cadBind.joy || id === live.current.cadBind.zoom);
      // Sound first, UI after: keeps latency down. Each finger owns its own voice.
      // The joystick and zoom slider are continuous, so a tap there should not also play a note.
      if (!desk) audio.current.trigger({ controlId: `${id}|${slot}`, phase: "down", value: 1, source, timestampMs: performance.now() }, c, "piano");
      held.current.set(slot, { id, source });
      setActive(new Set([...held.current.values()].map((x) => x.id)));
      const now = live.current;
      if (now.cadAssign) {
        const role = now.cadAssign;
        setCadBind((b) => ({ ...b, [role]: id }));
        setCadAssign(null);
        setNotice(`${role.toUpperCase()} is this shape.`);
        return;
      }
      if (now.tab === "cad" && id === now.cadBind.home) {
        setHomeTick((n) => n + 1);
        return;
      }
      if (now.assignJump) {
        setJumpId(id);
        setAssignJump(false);
        setNotice("JUMP is this shape. Start the run when you're ready.");
        return;
      }
      if (now.tab !== "game") return;
      if (now.gamePick === "dash") {
        if (now.dashOn && id === now.jumpId) setJumps((n) => n + 1);
        return;
      }
      const g = now.game;
      if (!g.on) return;
      if (id === g.target) {
        const ids = songIds.current;
        const fast = performance.now() - targetAt.current < 900;
        const next = ids.length ? (songAt.current + 1) % ids.length : 0;
        songAt.current = next;
        targetAt.current = performance.now();
        const points = 1 + Math.min(g.combo, 9) + (fast ? 2 : 0);
        setGame((s) => ({ ...s, score: s.score + points, combo: s.combo + 1, target: ids[next] ?? "", pop: `+${points}${fast ? " fast!" : ""}` }));
      } else setGame((s) => ({ ...s, combo: 0, pop: "miss" }));
    },
    [release],
  );

  // ---- keyboard ----------------------------------------------------------
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.repeat || (e.target as HTMLElement).matches?.("input,select,textarea")) return;
      const c = live.current.controls[KEYS.indexOf(e.key.toLowerCase())];
      if (c) {
        e.preventDefault();
        press(c.id, "keyboard");
      }
    };
    const up = (e: KeyboardEvent) => {
      if (KEYS.includes(e.key.toLowerCase())) release("keyboard");
    };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
    };
  }, [press, release]);

  // ---- camera + hand tracking ---------------------------------------------
  const startCamera = async () => {
    setBusy("camera");
    try {
      const s = await camera.current.start();
      setStream(s);
      setImage(null);
      tracker.current.init().then(() => setTrackerReady(true)).catch((e) => {
        const message = e instanceof Error ? e.message : "Hand tracking could not start.";
        setTrackError(message);
        setNotice(`Hand tracking off: ${message}`);
      });
    } catch (e) {
      // A newer camera request replaced this one (React dev mounts twice): not an error.
      if (e instanceof DOMException && e.name === "AbortError") return;
      setNotice(e instanceof Error ? e.message : "Camera could not start.");
    } finally {
      setBusy("");
    }
  };
  useEffect(() => {
    void startCamera();
    return () => camera.current.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on open
  }, []);

  const onHand = useCallback(
    (f: HandFrame) => {
      setTrackError((prev) => (prev ? "" : prev));
      const { controls, aspect, fingers } = live.current;
      // 1 = first index finger, 2 = both index fingers, 10 = every fingertip.
      // Dots always show every detected fingertip; the count only chooses which ones play.
      let use = fingers === 10 ? f.fingers : f.fingers.filter((x) => x.id.endsWith(":1"));
      if (fingers === 1) use = use.slice(0, 1);
      const hovered = new Set<string>();
      for (const finger of use) {
        seen.current.set(finger.id, f.timestampMs);
        let d = taps.current.get(finger.id);
        if (!d) taps.current.set(finger.id, (d = new TapDetector()));
        const hit = hitControl(finger.tip, controls, aspect);
        if (hit) hovered.add(hit.id);
        const ev = d.update(f.timestampMs, finger.tip[1], finger.palmWidth);
        if (ev === "lift") release(`vision:${finger.id}`);
        if (ev === "tap" && hit) press(hit.id, "vision", `vision:${finger.id}`);
      }
      // Fingers that left the frame (or the selection) let go, after a short grace for tracker dropouts.
      for (const id of [...taps.current.keys()])
        if (!use.some((x) => x.id === id) && f.timestampMs - (seen.current.get(id) ?? 0) > FINGER_GRACE_MS) {
          taps.current.delete(id);
          release(`vision:${id}`);
        }
      if (live.current.tab === "cad") {
        const bind = live.current.cadBind;
        const joyShape = controls.find((c) => c.id === bind.joy);
        const joyFinger = joyShape && use.find((finger) => pointInPolygon(finger.tip, joyShape.polygon));
        const nextJoy = joyFinger && joyShape ? axisInShape(joyFinger.tip, joyShape.polygon) ?? { x: 0, y: 0 } : { x: 0, y: 0 };
        if (Math.hypot(nextJoy.x - joyNow.current.x, nextJoy.y - joyNow.current.y) > 0.03) {
          joyNow.current = nextJoy;
          setJoy(nextJoy);
        }
        const zoomShape = controls.find((c) => c.id === bind.zoom);
        const zoomFinger = zoomShape && use.find((finger) => pointInPolygon(finger.tip, zoomShape.polygon));
        const nextZoom = zoomFinger && zoomShape ? levelInShape(zoomFinger.tip, zoomShape.polygon) : null;
        if (nextZoom !== zoomNow.current) {
          zoomNow.current = nextZoom;
          setZoomLevel(nextZoom);
        }
      }
      setTips(f.fingers.map((x) => x.tip));
      setHover(hovered);
    },
    [press, release],
  );
  const bindVideo = useCallback((node: HTMLVideoElement | null) => {
    video.current = node;
    if (!node) return;
    if (stream && node.srcObject !== stream) node.srcObject = stream;
    if (node.paused) void node.play().catch(() => {});
  }, [stream]);
  useEffect(() => {
    const v = video.current;
    // Track on the live preview too, so fingertips show before the picture is taken.
    if (busy === "scan" || still || !stream || !trackerReady || !v) return;
    taps.current.clear();
    try {
      tracker.current.start(v, onHand, (message) => setTrackError(message));
    } catch (e) {
      setTrackError(e instanceof Error ? e.message : "Hand tracking unavailable.");
    }
    return () => {
      tracker.current.stop();
      for (const slot of [...held.current.keys()]) if (slot.startsWith("vision")) release(slot);
      taps.current.clear();
      setTips([]);
      setHover(new Set());
    };
  }, [busy, still, stream, trackerReady, onHand, release]);

  // ---- scanning ------------------------------------------------------------
  const scan = async (canvas: HTMLCanvasElement) => {
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    setImage(dataUrl);
    setAspect(canvas.width / canvas.height);
    setControls([]);
    setStep("play");
    setBusy("scan");
    try {
      let found: PaperControl[] = [];
      try {
        const res = await fetch("/api/identify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: dataUrl }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (data.usage) setUsage(data.usage);
        // Snap each AI outline onto the real pen stroke for precise edges.
        const img = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
        const ink = inkMap(img);
        const ai: AiShape[] = (Array.isArray(data.shapes) ? data.shapes : []).filter(
          (sh: AiShape) => Array.isArray(sh?.points) && sh.points.length >= 3 && sh.points.every((p) => Array.isArray(p) && p.every(Number.isFinite)),
        );
        // Use the exact outline the pen drew wherever the drawing confirms the AI's shape.
        const traced = mergeShapes(ai, findRegions(ink, canvas.width, canvas.height));
        // Keep a real square, triangle, or star, and only move those corners onto the drawing.
        const refined = traced.map((sh) => {
          const points = regularize(sh.shape, sh.points);
          return { ...sh, points: points.length >= 3 ? points : sh.points };
        });
        setShapes(refined);
        found = aiToControls(refined, { useLetters });
      } catch (e) {
        // AI is optional: fall back to the offline outline finder.
        setShapes([]);
        found = recognizeControls(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height));
        setNotice(`AI scan failed (${e instanceof Error ? e.message : "network"}). Used the offline finder.`);
      }
      setControls(found);
      const jump = found.find((c) => /jump/i.test(c.label ?? ""));
      if (jump) setJumpId(jump.id);
      if (!found.length) setNotice("No drawn boxes or circles found. Darken the lines and scan again, or try the demo.");
    } finally {
      setBusy("");
    }
  };
  const scanCamera = () => {
    wakeAudio();
    const v = video.current;
    if (!v || v.readyState < 2) return setNotice("Camera is still starting. Try again in a second.");
    setStill(false);
    void scan(toCanvas(v));
  };
  const scanPhoto = async (file?: File) => {
    if (!file) return;
    wakeAudio();
    setStill(true);
    const url = URL.createObjectURL(file);
    try {
      void scan(toCanvas(await loadImage(url)));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Could not read that image.");
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  const demo = () => {
    wakeAudio();
    setImage(null);
    setAspect(16 / 10);
    setStill(true);
    setControls(demoControls());
    setStep("play");
  };

  // ---- game ------------------------------------------------------------------
  const startSong = () => {
    wakeAudio();
    const ids = songOrder(controls);
    if (ids.length < 2) return setNotice("Need at least two shapes to play a song.");
    songIds.current = ids;
    songAt.current = 0;
    targetAt.current = performance.now();
    setDashOn(false);
    setGame((s) => ({ ...s, on: true, score: 0, combo: 0, left: GAME_SECONDS, pop: "", target: ids[0] }));
  };
  useEffect(() => {
    if (!game.on) return;
    const end = performance.now() + game.left * 1000;
    const t = setInterval(() => {
      const left = Math.max(0, Math.ceil((end - performance.now()) / 1000));
      if (left <= 0) {
        setGame((s) => {
          if (!s.on) return s;
          const best = Math.max(s.best, s.score);
          try {
            localStorage.setItem("paperpilot.best", String(best));
          } catch {
            /* best score is a nicety */
          }
          return { ...s, on: false, left: 0, target: "", best, pop: "" };
        });
        return;
      }
      if (performance.now() - targetAt.current > TARGET_MS) {
        targetAt.current = performance.now();
        setGame((s) => (s.on ? { ...s, left, combo: 0, pop: "too slow" } : s));
      } else setGame((s) => (s.on && s.left !== left ? { ...s, left } : s));
    }, 100);
    return () => clearInterval(t);
  }, [game.on]);
  useEffect(() => {
    if (!game.pop) return;
    const t = setTimeout(() => setGame((s) => ({ ...s, pop: "" })), 700);
    return () => clearTimeout(t);
  }, [game.pop, game.score]);

  // ---- pointer on the paper ----------------------------------------------------
  const pointAt = (e: PointerEvent<HTMLDivElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const hit = hitControl(pointAt(e), controls, aspect);
    if (!hit) return;
    wakeAudio();
    press(hit.id, "pointer");
  };

  const setAction = (id: string, action: ControlAction) => {
    const next = controls.map((c) => (c.id === id ? { ...c, action, kind: action.type === "note" ? ("key" as const) : ("pad" as const), name: controlName(action) } : c));
    setControls(next);
    live.current.controls = next; // so the preview below plays the new sound right away
    audio.current.warm(next);
    press(id, "pointer");
    setTimeout(() => release("pointer"), 400);
  };
  /** Switch a shape's instrument, keeping its note name (moved to that instrument's octave). */
  const setVoice = (c: PaperControl, voice: Voice) => {
    if (voice === "drums") return setAction(c.id, { type: "sound", sound: DRUMS[0] });
    if (voice === "fx") return setAction(c.id, { type: "sound", sound: FX[0] });
    const pc = c.action.type === "note" ? c.action.midi % 12 : 0;
    setAction(c.id, { type: "note", midi: 12 * (BASE_OCTAVE[voice] + 1) + pc, instrument: voice });
  };
  const toggleLetters = (on: boolean) => {
    setUseLetters(on);
    if (shapes.length) setControls(aiToControls(shapes, { useLetters: on }));
  };
  useEffect(() => audio.current.warm(controls), [controls]);
  useEffect(() => {
    if (jumpId && !controls.some((c) => c.id === jumpId)) setJumpId("");
  }, [controls, jumpId]);
  useEffect(() => {
    setCadBind((prev) => {
      const next = { ...prev };
      for (const role of CAD_ROLES) {
        if (next[role] && !controls.some((c) => c.id === next[role])) delete next[role];
        const found = controls.find((c) => cadRole(c.label ?? "") === role);
        if (found) next[role] = found.id;
      }
      return next;
    });
  }, [controls]);

  const restart = () => {
    setGame((s) => ({ ...s, on: false, target: "" }));
    setDashOn(false);
    setAssignJump(false);
    setTab("play");
    setControls([]);
    setShapes([]);
    setImage(null);
    setStep("scan");
  };
  const stopGames = () => {
    setGame((s) => ({ ...s, on: false, target: "" }));
    setDashOn(false);
  };

  // ---- render ------------------------------------------------------------------
  const scanning = busy === "scan";
  // Live feed whenever the camera is on, except while the still picture is being labeled.
  const showVideo = !!stream && !scanning && !still;
  const paper = (
    <div
      className={`paper ${!image && !stream ? "blank" : ""}`}
      style={{ aspectRatio: aspect, ["--ar" as string]: aspect }}
      onPointerDown={onPointerDown}
      onPointerUp={() => release("pointer")}
      onPointerLeave={() => release("pointer")}
    >
      {stream && (
        <video
          ref={bindVideo}
          onLoadedMetadata={(e) => step === "scan" && setAspect(e.currentTarget.videoWidth / e.currentTarget.videoHeight)}
          autoPlay
          playsInline
          muted
          style={{ visibility: showVideo ? "visible" : "hidden" }}
        />
      )}
      {image && !showVideo && <img src={image} alt="Your picture" />}
      {step === "scan" && !stream && (
        <div className="empty">
          <Camera size={28} />
          <p>{busy === "camera" ? "Starting camera…" : "Allow the camera, or use a photo."}</p>
        </div>
      )}
      {step === "play" && (
        <svg viewBox="0 0 1 1" preserveAspectRatio="none">
          {controls.map((c) => (
            <polygon
              key={c.id}
              points={c.polygon.map((p) => p.join(",")).join(" ")}
              className={[`v-${voiceOf(c)}`, active.has(c.id) && "on", ((game.on && game.target === c.id) || (gamePick === "dash" && c.id === jumpId) || (tab === "cad" && Object.values(cadBind).includes(c.id))) && "target", hover.has(c.id) && "hover"]
                .filter(Boolean)
                .join(" ")}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      )}
      {step === "play" &&
        controls.map((c, i) => {
          const [x, y] = center(c.polygon);
          return (
            <span
              key={c.id}
              className={`tag v-${voiceOf(c)} ${active.has(c.id) ? "on" : ""}`}
              style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
            >
              {tab === "cad" ? (CAD_ROLES.find((role) => cadBind[role] === c.id)?.toUpperCase() ?? label(c.action)) : label(c.action)}
              {KEYS[i] && <kbd>{KEYS[i].toUpperCase()}</kbd>}
            </span>
          );
        })}
      {tips.map((t, i) => (
        <i key={i} className="tip" style={{ left: `${t[0] * 100}%`, top: `${t[1] * 100}%` }} />
      ))}
      {scanning && (
        <div className="scanning">
          <LoaderCircle className="spin" size={22} /> Labeling your drawing…
        </div>
      )}
      {game.pop && <b className={`pop ${game.pop === "miss" || game.pop === "too slow" ? "bad" : ""}`}>{game.pop}</b>}
    </div>
  );

  const usageText = usage
    ? usage.ai === false
      ? "Gemini off · add GEMINI_API_KEY"
      : `Gemini · ${usage.scans} scan${usage.scans === 1 ? "" : "s"} · $${usage.costUsd.toFixed(4)} of $${usage.budgetUsd.toFixed(2)}`
    : "Gemini · usage unavailable";

  return (
    <div className="app">
      <header>
        <button className="brand" onClick={restart} aria-label="Start over">
          PaperPilot
        </button>
        {step === "play" && !scanning && controls.length > 0 && (
          <nav className="tabs">
            {(["play", "game", "cad"] as const).map((t) => (
              <button
                key={t}
                className={tab === t ? "on" : ""}
                onClick={() => {
                  stopGames();
                  setCadAssign(null);
                  setTab(t);
                }}
              >
                {t === "play" ? <Music size={16} /> : t === "game" ? <Trophy size={16} /> : <Box size={16} />} {t === "play" ? "Play" : t === "game" ? "Game" : "CAD"}
              </button>
            ))}
          </nav>
        )}
        <div
          className="usage"
          title={usage ? `${usage.inTokens.toLocaleString()} input + ${usage.outTokens.toLocaleString()} output tokens. Estimate from list price; check AI Studio billing for the exact charge.` : ""}
        >
          <span className="meter" style={{ width: `${usage ? Math.min(100, (usage.costUsd / usage.budgetUsd) * 100) : 0}%` }} />
          {usageText}
        </div>
      </header>

      <main className={tab === "cad" && step === "play" && !scanning ? "split-cad" : ""}>
        <section className="stage">{paper}</section>
        {tab === "cad" && step === "play" && !scanning && (
          <div className="cad-pane">
            <CadStage joy={joy} zoom={zoomLevel} homeTick={homeTick} section={sectionOn} />
          </div>
        )}

        <aside>
          {step === "scan" && (
            <>
              <h1>Take a picture of your drawing</h1>
              <p className="lead">Each shape you draw is an instrument. Write a note (C, F#, Bb) inside a shape to pick its exact note.</p>
              {stream && !trackerReady && !trackError && <p className="hint">Loading hand tracking…</p>}
              {stream && trackerReady && !trackError && <p className="hint">A yellow dot follows each fingertip. Hold your hand over the page.</p>}
              {trackError && <p className="hint">{trackError}</p>}
              <ul className="legend">
                {(Object.keys(SHAPE_VOICE) as AiShape["shape"][]).map((sh) => (
                  <li key={sh} className={`v-${SHAPE_VOICE[sh]}`}>
                    <b>{SHAPE_GLYPH[sh]}</b> {sh === "other" ? "other shape" : sh} <span>{VOICE_NAME[SHAPE_VOICE[sh]]}</span>
                  </li>
                ))}
              </ul>
              <button className="primary big" onClick={stream ? scanCamera : startCamera} disabled={busy === "camera"}>
                <Camera size={20} /> {stream ? "Take picture" : busy === "camera" ? "Starting camera…" : "Turn on camera"}
              </button>
              <button onClick={() => fileInput.current?.click()}>
                <ImageUp size={18} /> Use a photo instead
              </button>
              <button className="ghost" onClick={demo}>
                <Play size={18} /> Try without paper
              </button>
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => void scanPhoto(e.target.files?.[0])} />
            </>
          )}

          {step === "play" && scanning && (
            <>
              <h2>Labeling…</h2>
              <p className="lead">Gemini is finding your keys and drums. Keep the paper and camera still.</p>
            </>
          )}

          {step === "play" && !scanning && tab === "game" && (
            <>
              <div className="choice" role="tablist" aria-label="Games">
                <button className={gamePick === "song" ? "on" : ""} onClick={() => { stopGames(); setGamePick("song"); }}>
                  Song <small>Light-up notes</small>
                </button>
                <button className={gamePick === "dash" ? "on" : ""} onClick={() => { stopGames(); setGamePick("dash"); }}>
                  Dash <small>One-button run</small>
                </button>
              </div>
              {gamePick === "song" && (
                <>
                  <h2>Play the glowing note</h2>
                  {game.on ? (
                    <div className="scoreboard">
                      <div><small>Score</small><b>{game.score}</b></div>
                      <div><small>Streak</small><b>×{game.combo}</b></div>
                      <div><small>Time</small><b>{game.left}s</b></div>
                    </div>
                  ) : (
                    <>
                      <p className="lead">Twinkle, Twinkle. The next note lights up on the paper. Hit that shape. Fast hits score more. {GAME_SECONDS} seconds.</p>
                      <div className="scoreboard two">
                        <div><small>Best</small><b>{game.best}</b></div>
                        <div><small>Last round</small><b>{game.score}</b></div>
                      </div>
                      <button className="primary big" onClick={startSong} disabled={controls.length < 2}>
                        <Play size={20} /> Start song
                      </button>
                    </>
                  )}
                </>
              )}
              {gamePick === "dash" && (
                <>
                  <h2>Paper Dash</h2>
                  <p className="lead">Draw a shape and write JUMP inside it, then take a picture. That shape is the jump button. The cube runs until it hits a spike.</p>
                  <ol className="steps-list">
                    <li className={jumpId ? "done" : ""}>JUMP {jumpId ? "registered" : "not found yet"}</li>
                  </ol>
                  {!jumpId && (
                    <button className={assignJump ? "primary" : ""} onClick={() => setAssignJump(true)}>
                      {assignJump ? "Tap the JUMP shape…" : "Tap a shape to register JUMP"}
                    </button>
                  )}
                  {jumpId && !dashOn && (
                    <button onClick={() => setAssignJump(true)}>Use a different shape</button>
                  )}
                  <DashGame
                    running={dashOn}
                    jumps={jumps}
                    onFinish={(score) => {
                      setDashOn(false);
                      setDashScore(score);
                    }}
                  />
                  {dashScore !== null && !dashOn && <p className="hint">Last run: {dashScore}</p>}
                  {!dashOn && (
                    <button className="primary big" onClick={() => { wakeAudio(); setJumps(0); setDashOn(true); }} disabled={!jumpId}>
                      <Play size={20} /> Start run
                    </button>
                  )}
                </>
              )}
              {showVideo && (
                <div className="fingers" role="radiogroup" aria-label="Fingers that play">
                  <span>Fingers</span>
                  {([1, 2, 10] as const).map((n) => (
                    <button key={n} role="radio" aria-checked={fingers === n} className={fingers === n ? "on" : ""} onClick={() => setFingers(n)}>
                      {n}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {step === "play" && !scanning && tab === "cad" && (
            <>
              <h2>Desk controls</h2>
              <p className="lead">Extra hands for a CAD program. Draw three shapes and write JOY, ZOOM, and HOME. The joystick orbits the bracket. Slide ZOOM. Tap HOME to reset. Arrow keys do the same orbit.</p>
              <ol className="steps-list">
                {CAD_ROLES.map((role) => (
                  <li key={role} className={cadBind[role] ? "done" : ""}>{CAD_HELP[role]}{cadBind[role] ? " · ready" : ""}</li>
                ))}
              </ol>
              {CAD_ROLES.map((role) => (
                <button key={role} className={cadAssign === role ? "primary" : ""} onClick={() => setCadAssign(role)}>
                  {cadAssign === role ? `Tap the ${role.toUpperCase()} shape…` : cadBind[role] ? `Reassign ${role.toUpperCase()}` : `Tap a shape for ${role.toUpperCase()}`}
                </button>
              ))}
              <button className={sectionOn ? "primary" : ""} onClick={() => setSectionOn((v) => !v)}>
                {sectionOn ? "Section on" : "Section view"}
              </button>
            </>
          )}

          {step === "play" && !scanning && tab === "play" && (
            <>
              <h2>{controls.length ? "Play" : "No shapes found"}</h2>
              <p className="lead">
                {!controls.length
                  ? "Darken the lines and retake the picture."
                  : showVideo
                    ? "Tap a shape on your paper, or click it on screen. Yellow dots are your fingertips."
                    : "Click a shape or use the keys shown."}
              </p>
              {showVideo && !trackerReady && !trackError && <p className="hint">Loading hand tracking…</p>}
              {showVideo && trackError && <p className="hint">{trackError}</p>}
              {showVideo && (
                <div className="fingers" role="radiogroup" aria-label="Fingers that play">
                  <span>Fingers</span>
                  {([1, 2, 10] as const).map((n) => (
                    <button key={n} role="radio" aria-checked={fingers === n} className={fingers === n ? "on" : ""} onClick={() => setFingers(n)}>
                      {n}
                    </button>
                  ))}
                </div>
              )}
              <button onClick={restart}>
                <RotateCcw size={18} /> Retake picture
              </button>
              {shapes.length > 0 && (
                <label className="switch">
                  <input type="checkbox" checked={useLetters} onChange={(e) => toggleLetters(e.target.checked)} />
                  Letters written in a shape set its note
                </label>
              )}
              {controls.length > 0 && (
                <details>
                  <summary>Change instruments & notes</summary>
                  <ul className="list">
                    {controls.map((c, i) => {
                      const voice = voiceOf(c);
                      return (
                        <li key={c.id}>
                          <i className={`dot v-${voice}`} title={c.shape} />
                          <select aria-label={`Instrument for shape ${i + 1}`} value={voice} onChange={(e) => setVoice(c, e.target.value as Voice)}>
                            {VOICES.map(([v, name]) => (
                              <option key={v} value={v}>{name}</option>
                            ))}
                          </select>
                          <select
                            aria-label={`Note for shape ${i + 1}`}
                            value={c.action.type === "note" ? c.action.midi : c.action.type === "sound" ? c.action.sound : ""}
                            onChange={(e) =>
                              setAction(
                                c.id,
                                c.action.type === "note"
                                  ? { type: "note", midi: Number(e.target.value), instrument: c.action.instrument }
                                  : { type: "sound", sound: e.target.value },
                              )
                            }
                          >
                            {c.action.type === "note"
                              ? NOTES.map((n) => <option key={n} value={n}>{noteName(n)}</option>)
                              : (voice === "drums" ? DRUMS : FX).map((x) => <option key={x} value={x}>{x[0].toUpperCase() + x.slice(1)}</option>)}
                          </select>
                          <button className="x" aria-label="Remove shape" onClick={() => setControls((cs) => cs.filter((x) => x.id !== c.id))}>
                            <X size={14} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              )}
            </>
          )}
        </aside>
      </main>
      <footer>
        <span className="brand">PaperPilot</span>
        <span>Runs in your browser</span>
      </footer>
      {notice && (
        <div className="toast" role="status" onClick={() => setNotice("")}>
          {notice}
        </div>
      )}
    </div>
  );
}

