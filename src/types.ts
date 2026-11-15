export type Point = [number, number];
export type Mode = "piano" | "chords" | "drums" | "soundboard" | "game";
/** Pitched voices. "piano" uses the bundled samples; the rest are synthesized (src/lib/synth.ts). */
export const INSTRUMENTS = ["piano", "marimba", "guitar", "bass", "organ", "synth"] as const;
export type Instrument = (typeof INSTRUMENTS)[number];
export type ControlAction =
  | { type: "note"; midi: number; instrument?: Instrument }
  | { type: "sound"; sound: string }
  | { type: "game"; action: string };
export interface PaperControl {
  id: string;
  kind: "key" | "pad" | "slider";
  name: string;
  polygon: Point[];
  action: ControlAction;
  color?: string;
  electrode?: number | null;
  /** Drawn shape the AI saw (rectangle, circle, triangle…), for display. */
  shape?: string;
  /** Handwriting inside the shape, kept so a game can register "JUMP". */
  label?: string;
}
export interface ControlEvent {
  controlId: string;
  phase: "down" | "up" | "change";
  value: number;
  source: "vision" | "midi" | "keyboard" | "pointer" | "loop";
  timestampMs: number;
}
export const NOTE_NAMES = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
];
export function noteName(midi: number) {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
export const NATURAL_NOTES = [60, 62, 64, 65, 67, 69, 71, 72];
