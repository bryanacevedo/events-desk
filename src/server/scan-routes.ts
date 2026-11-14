/* The scanner over HTTP (docs/SCANNER.md 7). Who may do what is decided here, once: any actor scans and reads their own scans; the rep, a planner, a lead or GTM confirms and reads a photo;
   planners, leads and GTM set the scanner up, read every scan and decide reviews. Acting as is self-declared across the desk, so a repeat of someone else's scan id is refused, not answered. */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Context, Hono } from "hono";
import type { Db } from "./db.ts";
import { RuleError } from "./events.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import type { OrganizerAdapter } from "./organizer-api.ts";
import { mockLlm, type Llm } from "./providers.ts";
import {
  confirmScan, ingestScan, listScans, photoImage, photoStatus, planner, putPhotoChunk, putSettings, readPhoto, resolvePending, resolveReview, scannerConfig, scansCsv, ScanForbidden, ScanForeign, ScanInvalid,
  type ScanInput,
} from "./scans.ts";

type Cfg = { demo: boolean; llm?: Llm; organizer?: OrganizerAdapter | null; lifecycle?: LifecycleDeps };

export function mountScans(app: Hono<any>, db: Db, deps: LifecycleDeps, cfg: Cfg) {
  const llm = cfg.llm ?? mockLlm;
  const ext = () => ({ organizer: cfg.organizer ?? null, llm });
  const actorOf = (c: Context): string => c.get("actor");
  const id = (c: Context) => c.req.param("id") as string;
  const refuse = (msg: string, status: 400 | 403 | 404 | 409) => Response.json({ error: msg }, { status });
  const run = async <T>(fn: () => Promise<T>, status: 200 | 201 = 200) => {
    try { return Response.json(await fn(), { status }); }
    catch (e) {
      if (e instanceof ScanForeign) return refuse(e.message, 409);
      if (e instanceof ScanForbidden) return refuse(e.message, 403);
      if (e instanceof ScanInvalid) return refuse(e.message, 400);
      if (e instanceof RuleError) return refuse(e.message, 409);
      throw e;
    }
  };
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, any>;
  const ready = (org: string | null, ref: { event_ref: string; exhibitor_ref: string }) => (cfg.organizer ? cfg.organizer.id === "fake" || (cfg.organizer.id === org && cfg.organizer.ready(ref)) : false);

  // The home-screen app opens this event's scanner, not the desk. The page carries nothing but the app's own name.
  app.get("/scan/:id/manifest.webmanifest", (c) => Response.json({ name: "Scanner", short_name: "Scanner", start_url: `/scan/${encodeURIComponent(id(c))}`, scope: "/scan/", display: "standalone", background_color: "#15231B", theme_color: "#15231B", icons: [] }, { headers: { "content-type": "application/manifest+json" } }));

  // The QR code that opens this event's scanner on a phone. Made here from the app's own copy of the encoder, so it needs no outside service.
  app.get("/api/events/:id/scanner/qr.png", async (c) => {
    const origin = (cfg.lifecycle?.appUrl ?? process.env.APP_URL) || new URL(c.req.url).origin;
    const { prepareZXingModule, writeBarcode } = await import("zxing-wasm/writer");
    const wasm = readFileSync(createRequire(import.meta.url).resolve("zxing-wasm/writer/zxing_writer.wasm"));
    await prepareZXingModule({ overrides: { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer }, fireImmediately: true });
    const out = await writeBarcode(`${origin.replace(/\/$/, "")}/scan/${encodeURIComponent(id(c))}`, { format: "QRCode", scale: 6, ecLevel: "M" });
    return new Response(await out.image!.arrayBuffer(), { headers: { "content-type": "image/png", "cache-control": "private, max-age=300" } });
  });

  // What the phone caches to work offline. Opening it also tries any badge ids still waiting.
  app.get("/api/events/:id/scanner", (c) => run(async () => { await resolvePending(db, deps, id(c), ext()); return scannerConfig(db, actorOf(c), id(c), ready); }));
  app.put("/api/events/:id/scanner/settings", (c) => run(async () => { await putSettings(db, actorOf(c), id(c), await body(c)); return scannerConfig(db, actorOf(c), id(c), ready); }));
  app.post("/api/events/:id/scans", (c) => run(async () => ingestScan(db, deps, id(c), actorOf(c), (await body(c)) as ScanInput, ext()), 201));
  app.post("/api/events/:id/scans/resolve", (c) => run(() => resolvePending(db, deps, id(c), ext())));
  app.get("/api/events/:id/scans", (c) => run(() => listScans(db, actorOf(c), id(c))));
  app.get("/api/events/:id/scans.csv", async (c) => {
    try {
      const text = await scansCsv(db, actorOf(c), id(c));
      return new Response(text, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="scans-${id(c)}.csv"` } });
    } catch (e) { if (e instanceof RuleError) return refuse(e.message, 409); throw e; }
  });

  app.put("/api/scans/:id/photo", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const q = new URL(c.req.url).searchParams;
    return run(() => putPhotoChunk(db, actorOf(c), id(c), { offset: Number(q.get("offset")), total: Number(q.get("total")), kind: q.get("kind") === "card" ? "card" : "badge" }, bytes));
  });
  app.get("/api/scans/:id/photo", async (c) => {
    if (new URL(c.req.url).searchParams.get("status") !== null) return run(() => photoStatus(db, actorOf(c), id(c)));
    try { const p = await photoImage(db, actorOf(c), id(c)); return new Response(p.bytes as unknown as BodyInit, { headers: { "content-type": p.mime, "cache-control": "private, no-store" } }); }
    catch (e) { if (e instanceof ScanForbidden) return refuse(e.message, 403); if (e instanceof RuleError) return refuse(e.message, 404); throw e; }
  });
  app.post("/api/scans/:id/read", (c) => run(() => readPhoto(db, deps, llm, actorOf(c), id(c))));
  app.post("/api/scans/:id/confirm", (c) => run(async () => confirmScan(db, deps, actorOf(c), id(c), await body(c))));
  app.post("/api/scans/:id/review", (c) => run(async () => { const b = await body(c); return resolveReview(db, actorOf(c), id(c), b.decision); }));
  void planner;
}
