/* The scanner in a real browser with a fake camera, against a running desk (scripts/e2e-scan.mjs). It needs Chrome and a running `make demo`, so it runs only when E2E_SCAN_BASE is set:
   E2E_SCAN_BASE=http://localhost:8982 npx vitest run tests/scan-e2e.test.ts */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const base = process.env.E2E_SCAN_BASE;
describe.skipIf(!base)("the scanner end to end", () => {
  for (const wasm of [false, true]) {
    it(`decodes a badge offline (${wasm ? "WebAssembly decoder" : "the browser's own"}), photographs a card offline, and both arrive once`, () => {
      const out = execFileSync("node", ["scripts/e2e-scan.mjs"], { env: { ...process.env, BASE: base, ...(wasm ? { WASM: "1" } : {}) }, encoding: "utf8", timeout: 120_000 });
      expect(out).toMatch(/scan e2e passed/);
    }, 150_000);
  }
});
