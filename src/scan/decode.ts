/* Reading a code from the camera (docs/SCANNER.md 5): the browser's BarcodeDetector where there is one, the WebAssembly decoder in a worker where there is not. */

import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

interface Detector { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }
declare const BarcodeDetector: { new (o?: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } | undefined;

export interface Decoder { kind: "native" | "wasm"; decode(video: HTMLVideoElement | HTMLCanvasElement | ImageBitmap): Promise<string | null>; close(): void }

/** Makes the wasm file part of what the service worker holds, so the first scan with no signal still decodes. */
export const warm = () => fetch(wasmUrl).then((r) => r.arrayBuffer()).catch(() => undefined);

export async function makeDecoder(): Promise<Decoder> {
  if (typeof BarcodeDetector !== "undefined") {
    try {
      const want = ["qr_code", "code_128", "code_39", "data_matrix", "pdf417", "aztec"], have = await BarcodeDetector.getSupportedFormats();
      const d = new BarcodeDetector({ formats: want.filter((f) => have.includes(f)) });
      return { kind: "native", async decode(v) { const r = await d.detect(v); return r[0]?.rawValue ?? null; }, close() {} };
    } catch { /* fall through to wasm */ }
  }
  const worker = new Worker(new URL("./decode.worker.ts", import.meta.url), { type: "module" });
  let n = 0;
  const waiting = new Map<number, (t: string | null) => void>();
  worker.onmessage = (e: MessageEvent<{ id: number; text: string | null }>) => { waiting.get(e.data.id)?.(e.data.text); waiting.delete(e.data.id); };
  const canvas = document.createElement("canvas");
  return {
    kind: "wasm",
    decode(src) {
      const w = src instanceof HTMLVideoElement ? src.videoWidth : src.width, h = src instanceof HTMLVideoElement ? src.videoHeight : src.height;
      if (!w || !h) return Promise.resolve(null);
      const scale = Math.min(1, 720 / Math.max(w, h));
      canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
      const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const id = ++n;
      return new Promise((resolve) => { waiting.set(id, resolve); worker.postMessage({ id, image }); setTimeout(() => { if (waiting.delete(id)) resolve(null); }, 4000); });
    },
    close() { worker.terminate(); },
  };
}

/** A decoded photo file (the picker path, or a test): the same decoder on a still. */
export async function decodeFile(file: Blob, d: Decoder): Promise<string | null> {
  const bmp = await createImageBitmap(file);
  try { return await d.decode(bmp); } finally { bmp.close(); }
}
