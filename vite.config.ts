import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
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
  test: {
    // Worktrees made inside the repo (.claude/worktrees) carry their own copy of the tests; never run those (2026-11-27: they doubled the local run).
    exclude: [...configDefaults.exclude, ".claude/**", ".wt/**"],
    globalSetup: ["tests/pg-cleanup.ts"],
    /* Two parts. First the cause: freshDb now starts from a migrated copy (tests/pg-cleanup.ts), which took the full run from 1071 s to 345 to 410 s under the same load. What is left is real
       work inside the test body: a whole event taken from upload to a delivered workbook in-process (2 to 7 s alone on a busy laptop), with one worker per core, and directory-readers also
       waits on a real Chrome and a local port. The 5 s default sits on the slower of those, so a busier machine tipped them over (4 tests and a 10 s hook in one of three runs after the
       first part). A hang still fails, in 30 s. Global on purpose: simpler than a list of files that goes stale; per-file budgets would be tighter. A test that needs more says so itself. */
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  plugins: [react(), scanAssets()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  build: { outDir: "dist", emptyOutDir: true },
});
