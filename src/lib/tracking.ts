import {
  FilesetResolver,
  HandLandmarker,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import type { Point } from "../types";

export interface HandFrame {
  /** Monotonic time of the source observation, not physical action-to-audio latency. */
  timestampMs: number;
  /** Index fingertip in unmirrored, normalized camera coordinates. Null means release. */
  tip: Point | null;
  landmarks: NormalizedLandmark[];
  /** Thumb/index distance divided by palm width. Lower = closed. Not surface contact. */
  pinch: number;
  /** Index-knuckle to pinky-knuckle distance in normalized image units; 0 when no hand. */
  palmWidth: number;
  /** Every fingertip of every visible hand (up to 2). id = "<hand>:<finger 0-4>", finger 1 = index. */
  fingers: Finger[];
  /** Handedness classification score; this is not a physical-contact confidence. */
  confidence: number;
  handedness: string | null;
}

export interface Finger {
  id: string;
  tip: Point;
  palmWidth: number;
}

const TIPS = [4, 8, 12, 16, 20];
const DIPS = [3, 7, 11, 15, 19]; // joint just behind each tip
/** From a high, steep webcam the pad touching the paper sits a little past the tip landmark. */
const CONTACT_REACH = 0.2;

export interface TrackingDiagnostics {
  fps: number;
  cameraFps: number;
  inferenceMs: number;
  frames: number;
  skippedFrames: number;
  lastFrameAt: number;
  handVisible: boolean;
  lostTrackingCount: number;
  status: "idle" | "loading" | "ready" | "running" | "paused" | "error";
  error: string | null;
  delegate: "GPU" | "CPU" | null;
}

/** No new camera frame for this long: release anything the hand was holding. */
const STALL_MS = 400;
/** A result older than this is from a hung frame, so it is not used. */
const MAX_INFERENCE_MS = 500;
const assetBase = `${import.meta.env.BASE_URL}models`;

/** One fresh camera frame per synchronous inference; no buffered inference queue. */
export class HandTracker {
  readonly diagnostics: TrackingDiagnostics = {
    fps: 0,
    cameraFps: 0,
    inferenceMs: 0,
    frames: 0,
    skippedFrames: 0,
    lastFrameAt: 0,
    handVisible: false,
    lostTrackingCount: 0,
    status: "idle",
    error: null,
    delegate: null,
  };

  private model: HandLandmarker | null = null;
  private loading: Promise<void> | null = null;
  private disposed = false;
  private video: HTMLVideoElement | null = null;
  private onFrame: ((frame: HandFrame) => void) | null = null;
  private frameHandle: number | null = null;
  private usesVideoCallback = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastVideoTime = -1;
  private lastPresentedFrames = 0;
  private lastInferenceAt = 0;
  private lastTimestamp = 0;
  private onError: ((message: string) => void) | null = null;
  private errorNotified = false;

  async init(): Promise<void> {
    if (this.disposed)
      throw new Error("This tracker has been disposed. Create a new tracker.");
    if (this.model) return;
    if (this.loading) return this.loading;
    this.diagnostics.status = "loading";
    this.diagnostics.error = null;
    this.loading = this.loadModel();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private async loadModel(): Promise<void> {
    try {
      const fileset = await FilesetResolver.forVisionTasks(`${assetBase}/wasm`);
      const options = {
        runningMode: "VIDEO" as const,
        numHands: 2,
        // Lower than default: steep desk angles make MediaPipe less sure, and dropping a hand mid-press is worse than a stray frame.
        // A laptop webcam looks down at the desk, where MediaPipe is less sure than in a selfie.
        minHandDetectionConfidence: 0.35,
        minHandPresenceConfidence: 0.35,
        minTrackingConfidence: 0.35,
      };
      let model: HandLandmarker;
      try {
        model = await HandLandmarker.createFromOptions(fileset, {
          ...options,
          baseOptions: {
            modelAssetPath: `${assetBase}/hand_landmarker.task`,
            delegate: "GPU",
          },
        });
        this.diagnostics.delegate = "GPU";
      } catch {
        if (this.disposed) return;
        model = await HandLandmarker.createFromOptions(fileset, {
          ...options,
          baseOptions: {
            modelAssetPath: `${assetBase}/hand_landmarker.task`,
            delegate: "CPU",
          },
        });
        this.diagnostics.delegate = "CPU";
      }
      if (this.disposed) {
        model.close();
        return;
      }
      this.model = model;
      this.diagnostics.status = "ready";
    } catch (error) {
      this.diagnostics.status = "error";
      this.diagnostics.error =
        error instanceof Error
          ? error.message
          : "Hand tracking could not initialize.";
      throw new Error(
        "Local hand tracking could not load. Retry or use keyboard / MIDI input.",
        { cause: error },
      );
    }
  }

  start(
    video: HTMLVideoElement,
    onFrame: (frame: HandFrame) => void,
    onError?: (message: string) => void,
  ): void {
    if (!this.model)
      throw new Error(
        "Call and await HandTracker.init() before starting tracking.",
      );
    this.stop();
    this.video = video;
    this.onFrame = onFrame;
    this.onError = onError ?? null;
    this.errorNotified = false;
    if (video.paused) void video.play?.().catch(() => {});
    this.running = true;
    this.lastVideoTime = -1;
    this.lastPresentedFrames = 0;
    this.lastInferenceAt = 0;
    this.diagnostics.lastFrameAt = performance.now();
    this.diagnostics.error = null;
    this.diagnostics.status = "running";
    this.usesVideoCallback =
      typeof video.requestVideoFrameCallback === "function";
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    video.addEventListener("ended", this.onVideoUnavailable);
    video.addEventListener("emptied", this.onVideoUnavailable);
    video.addEventListener("pause", this.onVideoUnavailable);
    // rVFC stops when the source stalls, so release cannot depend on another frame.
    this.watchdog = setInterval(() => {
      if (performance.now() - this.diagnostics.lastFrameAt > STALL_MS) {
        this.release();
        this.diagnostics.status = "paused";
        this.diagnostics.fps = 0;
        this.diagnostics.cameraFps = 0;
      }
    }, 30);
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle !== null) {
      if (this.usesVideoCallback)
        this.video?.cancelVideoFrameCallback(this.frameHandle);
      else cancelAnimationFrame(this.frameHandle);
    }
    this.frameHandle = null;
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.video?.removeEventListener("ended", this.onVideoUnavailable);
    this.video?.removeEventListener("emptied", this.onVideoUnavailable);
    this.video?.removeEventListener("pause", this.onVideoUnavailable);
    this.release(true);
    this.video = null;
    this.onFrame = null;
    this.onError = null;
    this.diagnostics.fps = 0;
    this.diagnostics.cameraFps = 0;
    this.diagnostics.status = this.model ? "ready" : "idle";
  }

  /** Release WebGL/WASM resources on unmount; stop() alone supports restarting. */
  dispose(): void {
    this.stop();
    this.disposed = true;
    this.model?.close();
    this.model = null;
    this.diagnostics.status = "idle";
  }

  private onVisibilityChange = (): void => {
    if (document.hidden) this.release();
  };

  private onVideoUnavailable = (): void => {
    this.release();
    this.diagnostics.status = "paused";
  };

  private schedule(): void {
    if (!this.running || !this.video) return;
    if (this.usesVideoCallback) {
      this.frameHandle = this.video.requestVideoFrameCallback(
        (_now, metadata) => {
          const presented = metadata.presentedFrames ?? 0;
          const presentedDelta = this.lastPresentedFrames
            ? presented - this.lastPresentedFrames
            : 1;
          if (this.lastPresentedFrames) {
            this.diagnostics.skippedFrames += Math.max(0, presentedDelta - 1);
          }
          // presentedFrames stays 0 on some camera streams, so a callback is a new frame.
          const fresh =
            this.lastPresentedFrames === 0 || presented !== this.lastPresentedFrames;
          this.lastPresentedFrames = presented;
          this.process(metadata.mediaTime, presentedDelta, fresh);
        },
      );
    } else {
      this.frameHandle = requestAnimationFrame(() => {
        const live =
          typeof MediaStream !== "undefined" &&
          this.video?.srcObject instanceof MediaStream;
        const time = this.video?.currentTime ?? -1;
        this.process(time, 1, live && time === this.lastVideoTime);
      });
    }
  }

  private process(mediaTime: number, presentedDelta = 1, freshFrame = false): void {
    this.frameHandle = null;
    if (!this.running || !this.video || !this.model) return;
    const video = this.video;
    if (document.hidden || video.readyState < 2 || !video.videoWidth) {
      this.schedule();
      return;
    }
    // A paused camera never presents another frame, so rVFC would stall the loop.
    if (video.paused) {
      void video.play?.().catch(() => {});
      this.frameHandle = requestAnimationFrame(() =>
        this.process(video.currentTime, 1, false),
      );
      return;
    }
    let clock = mediaTime;
    if (clock === this.lastVideoTime) {
      if (!freshFrame) {
        this.schedule();
        return;
      }
      // Some webcams repeat mediaTime while still delivering new frames.
      clock = this.lastVideoTime + Math.max(presentedDelta, 1) / 60;
    }
    const previousVideoTime = this.lastVideoTime;
    this.lastVideoTime = clock;
    const timestampMs = Math.max(performance.now(), this.lastTimestamp + 0.01);
    this.lastTimestamp = timestampMs;
    try {
      const startedAt = performance.now();
      const result = this.model.detectForVideo(video, timestampMs);
      this.diagnostics.inferenceMs = performance.now() - startedAt;
      this.diagnostics.lastFrameAt = performance.now();
      this.diagnostics.frames += 1;
      this.diagnostics.status = "running";
      if (this.lastInferenceAt) {
        const fps = 1000 / (timestampMs - this.lastInferenceAt);
        this.diagnostics.fps = this.diagnostics.fps
          ? this.diagnostics.fps * 0.8 + fps * 0.2
          : fps;
      }
      if (previousVideoTime >= 0 && clock > previousVideoTime) {
        const cameraFps = presentedDelta / (clock - previousVideoTime);
        this.diagnostics.cameraFps = this.diagnostics.cameraFps
          ? this.diagnostics.cameraFps * 0.8 + cameraFps * 0.2
          : cameraFps;
      }
      this.lastInferenceAt = timestampMs;
      this.diagnostics.error = null;
      this.errorNotified = false;
      // A hung frame is too old to place a fingertip. A merely slow one still is.
      if (this.diagnostics.inferenceMs > MAX_INFERENCE_MS) {
        this.release(true);
        this.diagnostics.status = "paused";
        this.schedule();
        return;
      }
      const landmarks = result.landmarks[0];
      if (
        !landmarks ||
        landmarks.length < 21 ||
        !landmarks.every(
          (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
        )
      ) {
        this.release(true, timestampMs);
      } else {
        const aspect = video.videoWidth / video.videoHeight;
        const distance = (a: NormalizedLandmark, b: NormalizedLandmark) =>
          Math.hypot((a.x - b.x) * aspect, a.y - b.y);
        const palmWidth = distance(landmarks[5], landmarks[17]);
        const pinch =
          palmWidth > 0.005
            ? distance(landmarks[4], landmarks[8]) / palmWidth
            : Infinity;
        const fingers: Finger[] = [];
        result.landmarks.forEach((hand, h) => {
          if (hand.length < 21) return;
          // Handedness keeps ids stable when MediaPipe reorders hands between frames.
          let name = result.handedness[h]?.[0]?.categoryName ?? String(h);
          if (fingers.some((f) => f.id.startsWith(`${name}:`))) name += h;
          const width = distance(hand[5], hand[17]);
          TIPS.forEach((t, f) => {
            const tip = hand[t], dip = hand[DIPS[f]];
            if (![tip.x, tip.y, dip.x, dip.y].every(Number.isFinite)) return;
            fingers.push({
              id: `${name}:${f}`,
              tip: [tip.x + (tip.x - dip.x) * CONTACT_REACH, tip.y + (tip.y - dip.y) * CONTACT_REACH],
              palmWidth: width,
            });
          });
        });
        this.diagnostics.handVisible = true;
        this.onFrame?.({
          timestampMs,
          tip: [landmarks[8].x, landmarks[8].y],
          landmarks,
          pinch,
          palmWidth,
          fingers,
          confidence: result.handedness[0]?.[0]?.score ?? 0,
          handedness: result.handedness[0]?.[0]?.categoryName ?? null,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Hand tracking stopped unexpectedly.";
      this.diagnostics.status = "error";
      this.diagnostics.error = message;
      if (!this.errorNotified) {
        this.errorNotified = true;
        this.onError?.(message);
      }
      this.schedule();
      return;
    }
    this.schedule();
  }

  private release(force = false, timestampMs = performance.now()): void {
    if (!this.diagnostics.handVisible && !force) return;
    if (this.diagnostics.handVisible) this.diagnostics.lostTrackingCount += 1;
    this.diagnostics.handVisible = false;
    this.onFrame?.({
      timestampMs,
      tip: null,
      landmarks: [],
      pinch: Infinity,
      palmWidth: 0,
      fingers: [],
      confidence: 0,
      handedness: null,
    });
  }
}
