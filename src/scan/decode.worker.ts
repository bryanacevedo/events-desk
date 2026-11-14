/* Decoding where the browser has no BarcodeDetector (iOS Safari): ZXing as WebAssembly, in a worker, on a downscaled frame. The wasm file is this app's own, never a CDN's. */
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

const ready = prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) }, fireImmediately: true });

self.onmessage = async (e: MessageEvent<{ id: number; image: ImageData }>) => {
  try {
    await ready;
    const found = await readBarcodes(e.data.image, { tryHarder: true, maxNumberOfSymbols: 1, formats: ["QRCode", "Code128", "Code39", "DataMatrix", "PDF417", "Aztec", "EAN13", "ITF"] });
    (self as unknown as Worker).postMessage({ id: e.data.id, text: found[0]?.text ?? null });
  } catch (err) { (self as unknown as Worker).postMessage({ id: e.data.id, text: null, error: String(err) }); }
};
