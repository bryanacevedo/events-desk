/* Frames from a screen recording, taken in the browser (docs/DIRECTORY.md 9). The video is played locally and never leaves the computer; only the frames that differ go up.
   The pure parts (the thumbnail, the difference, the times, the keep rule) are at the top and have no DOM, so a test can run them. */

export const FRAME_STEP_SECONDS = 0.7;
export const MAX_FRAME_WIDTH = 1000;
export const THUMB = 32;
/** Mean absolute difference, 0 to 255, between two 32 by 32 grayscale thumbnails. Below this the screen has not moved enough to hold anyone new. */
export const DIFF_THRESHOLD = 6;

/** A 32 by 32 grayscale thumbnail from RGBA pixels of any size (nearest sample, luma weights). */
export function grayThumb(rgba: ArrayLike<number>, width: number, height: number): Uint8Array {
  const out = new Uint8Array(THUMB * THUMB);
  if (!width || !height) return out;
  for (let y = 0; y < THUMB; y++) {
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / THUMB));
    for (let x = 0; x < THUMB; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / THUMB));
      const i = (sy * width + sx) * 4;
      out[y * THUMB + x] = Math.round(0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]);
    }
  }
  return out;
}

/** The mean absolute difference of two thumbnails. Different sizes are a full difference. */
export function meanAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Keep a frame when there is no kept frame yet, or when it differs from the last kept one by more than the threshold. */
export function keepFrame(last: ArrayLike<number> | null, next: ArrayLike<number>, threshold = DIFF_THRESHOLD): boolean {
  return last === null || meanAbsDiff(last, next) > threshold;
}

/** The moments to look at: every `step` seconds from 0, never past the end. At least one, for a clip shorter than a step. */
export function frameTimes(duration: number, step = FRAME_STEP_SECONDS): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const out: number[] = [];
  for (let t = 0; t < duration; t = Math.round((t + step) * 1000) / 1000) out.push(t);
  return out;
}

/** The size a frame is drawn at: no wider than 1,000 pixels, the same shape. */
export function frameSize(w: number, h: number, max = MAX_FRAME_WIDTH): { w: number; h: number } {
  if (!w || !h) return { w: 0, h: 0 };
  if (w <= max) return { w, h };
  return { w: max, h: Math.max(1, Math.round((h * max) / w)) };
}

/** "0:24", "1:52". */
export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/* ------------------------------------------------------------------ the browser part */

export interface TakenFrame { n: number; at: number; blob: Blob }
export class CannotDecode extends Error {}

const once = (el: HTMLMediaElement, ok: string, ms = 15000) => new Promise<void>((resolve, reject) => {
  const done = (f: () => void) => { clearTimeout(timer); el.removeEventListener(ok, onOk); el.removeEventListener("error", onErr); f(); };
  const onOk = () => done(resolve), onErr = () => done(() => reject(new CannotDecode("The browser could not read this video.")));
  const timer = setTimeout(() => done(() => reject(new CannotDecode("The browser could not read this video."))), ms);
  el.addEventListener(ok, onOk); el.addEventListener("error", onErr);
});

/** Plays the file in a hidden video, seeks to each moment and returns the frames that differ from the last kept one, in order. `onMoment` tells how far through the moments it is.
    Throws CannotDecode when the browser cannot play the file. Stops early, with what it has, when `stopped()` says so or `max` frames are kept. */
export async function takeFrames(file: File, hooks: { onMoment: (at: number, total: number) => void; stopped: () => boolean; max: number }): Promise<TakenFrame[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true; video.preload = "auto"; video.playsInline = true; video.style.display = "none";
  video.src = url;
  document.body.appendChild(video);
  const kept: TakenFrame[] = [];
  try {
    await once(video, "loadeddata");
    const { w, h } = frameSize(video.videoWidth, video.videoHeight);
    const times = frameTimes(video.duration);
    if (!w || !h || !times.length) throw new CannotDecode("The browser could not read this video.");
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const small = document.createElement("canvas");
    small.width = THUMB; small.height = THUMB;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    if (!ctx || !sctx) throw new CannotDecode("The browser could not read this video.");
    let last: Uint8Array | null = null;
    for (let i = 0; i < times.length && kept.length < hooks.max; i++) {
      if (hooks.stopped()) break;
      hooks.onMoment(i + 1, times.length);
      const seeked = once(video, "seeked");
      video.currentTime = Math.min(times[i], Math.max(0, video.duration - 0.05));
      await seeked;
      ctx.drawImage(video, 0, 0, w, h);
      sctx.drawImage(canvas, 0, 0, THUMB, THUMB);
      const thumb = grayThumb(sctx.getImageData(0, 0, THUMB, THUMB).data, THUMB, THUMB);
      if (!keepFrame(last, thumb)) continue;
      last = thumb;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.85));
      if (!blob) throw new CannotDecode("The browser could not read this video.");
      kept.push({ n: kept.length, at: times[i], blob });
    }
    return kept;
  } finally {
    video.removeAttribute("src"); video.load(); video.remove(); URL.revokeObjectURL(url);
  }
}

/** A picture file as a frame: JPEG, PNG and WebP go as they are. */
export const isImage = (f: File) => /^image\/(jpeg|png|webp)$/.test(f.type);
