/* What the built app's files answer (src/server/static.ts): a missing hashed file is a 404 and never the page, "/" is revalidated and compressed like a deep link, and a failed page chunk reloads once. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountStatic } from "../src/server/static.ts";
import { isChunkError, reloadOnce } from "../src/app/ChunkGuard.tsx";

const dir = mkdtempSync(join(tmpdir(), "dist-"));
mkdirSync(join(dir, "assets"));
writeFileSync(join(dir, "index.html"), `<!doctype html><html><body>${"app shell ".repeat(300)}</body></html>`);
writeFileSync(join(dir, "assets", "app-NEW.js"), `export const x = "${"a".repeat(2000)}";`);
const app = new Hono();
app.get("/api/ping", (c) => c.json({ ok: true }));
mountStatic(app, relative(process.cwd(), dir));
const get = (path: string) => app.request(path, { headers: { "Accept-Encoding": "gzip" } });

describe("static files", () => {
  it("a hashed file that exists is compressed and cached for a year", async () => {
    const r = await get("/assets/app-NEW.js");
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(r.headers.get("Content-Encoding")).toBe("gzip");
  });
  it("a hashed file that is not there is a 404, not the page, and is never cached", async () => {
    for (const p of ["/assets/app-OLD.js", "/assets/chunks/Plan-OLD.js", "/assets/x.css"]) {
      const r = await get(p);
      expect(r.status).toBe(404);
      expect(r.headers.get("Content-Type") ?? "").not.toContain("text/html");
      expect(r.headers.get("Cache-Control") ?? "").not.toContain("immutable");
    }
  });
  it("/, /index.html and a deep link are revalidated and compressed", async () => {
    for (const p of ["/", "/index.html", "/events/1"]) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("Cache-Control"), p).toBe("no-cache");
      expect(r.headers.get("Content-Encoding"), p).toBe("gzip");
      expect(r.headers.get("Content-Type"), p).toContain("text/html");
    }
  });
  it("the api is untouched", async () => {
    const r = await get("/api/ping");
    expect(r.headers.get("Cache-Control")).toBeNull();
  });
});

describe("a failed page chunk after a deploy", () => {
  it("is recognised in the browsers' words", () => {
    expect(isChunkError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/Plan-abc.js"))).toBe(true);
    expect(isChunkError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkError(new Error("Importing a module script failed."))).toBe(true);
    expect(isChunkError(new Error("x is not a function"))).toBe(false);
  });
  it("reloads once a minute, then stops so it cannot loop", () => {
    const store = new Map<string, string>();
    (globalThis as { sessionStorage?: unknown }).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    let n = 0;
    expect(reloadOnce(1_000_000, () => n++)).toBe(true);
    expect(reloadOnce(1_030_000, () => n++)).toBe(false);
    expect(reloadOnce(1_070_000, () => n++)).toBe(true);
    expect(n).toBe(2);
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });
});
