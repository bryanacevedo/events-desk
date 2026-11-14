import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

/** The list of files the scanner's service worker keeps so the app opens with no signal (public/scan-sw.js): scripts, styles, the decoder's wasm and the Latin fonts. */
const scanAssets = (): Plugin => ({
  name: "scan-assets",
  generateBundle(_o, bundle) {
    const keep = Object.keys(bundle).filter((f) => f.startsWith("assets/") && (/\.(js|css|wasm)$/.test(f) || (/\.woff2$/.test(f) && /latin-wght-normal/.test(f) && !/latin-ext/.test(f)))).map((f) => `/${f}`);
    this.emitFile({ type: "asset", fileName: "scan-assets.json", source: JSON.stringify(keep) });
  },
});

export default defineConfig({
  test: { globalSetup: ["tests/pg-cleanup.ts"] },
  plugins: [react(), scanAssets()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  build: { outDir: "dist", emptyOutDir: true },
});
