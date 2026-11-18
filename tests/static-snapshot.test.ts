/* The static snapshot (scripts/build-static-snapshot.ts, docs/RUNBOOK.md): what it crawls is complete, it changes nothing, the shim and
   the build agree on keys, every change is refused in the desk's own kind of words, and the bundle is noindex. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { Crawl, IDENTITIES, crawl, crawlScanner, prime, dealIds, fingerprint, finishWeb, openDemo, readTemplates, requestHash, templatePattern, uncovered, writeBundle, main } from "../scripts/build-static-snapshot.ts";
import { demoBarWords } from "../src/app/DemoBar.tsx";

const SHIM = readFileSync(join(__dirname, "..", "scripts", "static-snapshot", "shim.js"), "utf8");

/** Runs the shim in a page-like sandbox over a folder of saved answers. */
function shimIn(dir: string, search = "") {
  const calls: string[] = [];
  const win: Record<string, unknown> = {};
  const realFetch = async (u: string) => {
    calls.push(u);
    const f = join(dir, new URL(u, "http://x").pathname);
    return existsSync(f) ? new Response(readFileSync(f)) : new Response("", { status: 404 });
  };
  win.fetch = realFetch;
  win.window = win;
  const ctx = { window: win, location: { href: `http://x/${search}`, origin: "http://x", pathname: "/", replace: () => undefined }, crypto: globalThis.crypto, TextEncoder, TextDecoder, Response, Headers, Blob, URL, Uint8Array, JSON, Promise, Array, Object, String, Number, Math, DecompressionStream, decodeURIComponent };
  runInNewContext(SHIM, ctx);
  return { fetch: win.fetch as typeof fetch, key: win.__snapshotKey as (m: string, u: URL) => string, calls };
}

describe("the shim and the build key a request the same way", () => {
  it("agree on paths with queries, encodings and unsorted pairs", () => {
    const { key } = shimIn(tmpdir());
    for (const p of ["/api/overview", "/api/events/evt_a/people?q=&priority=A&tier=&status=kept&source=&offset=12&limit=12", "/api/motion/my-day?rep=Maya%20Okafor", "/api/events/evt_a/deals/006%2F1?z=1&a=2&a=1"]) {
      const { createHash } = require("node:crypto") as typeof import("node:crypto");
      const shimKey = key("GET", new URL(p, "http://x"));
      expect(createHash("sha1").update(shimKey).digest("hex")).toBe(requestHash("GET", p));
    }
  });
});

describe("a small bundle, read through the shim", () => {
  let out = "";
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "snap-test-"));
    const k = new Crawl({ fetch: async () => new Response("{}") });
    const put = (path: string, scopes: Record<string, [number, unknown]>) => k.saved.set(requestHash("GET", path), scopes);
    put("/api/health", { "*": [200, { ok: true, demo: true, public_demo: true }] });
    put("/api/integration", { "*": [200, { links: { x: "https://other.example" } }] });
    put("/api/usage?q=&page=1", { "a:": [403, { error: "Company money is for leadership and GTM Engineering." }], "a:GTM Team": [200, { vendors: [] }] });
    writeBundle(out, k, "17 November 2026", "2026-11-24");
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("answers a saved read for the person asking, and says the page is a snapshot with no other desk", async () => {
    const { fetch } = shimIn(out);
    const h = await (await fetch("/api/health")).json();
    expect(h.snapshot).toEqual({ taken_on: "17 November 2026" });
    expect((await (await fetch("/api/integration")).json()).links).toEqual({});
    const asGtm = await fetch("/api/usage?q=&page=1", { headers: { "x-actor": encodeURIComponent("GTM Team") } });
    expect(asGtm.status).toBe(200);
    const asNobody = await fetch("/api/usage?q=&page=1");
    expect(asNobody.status).toBe(403);
    expect((await asNobody.json()).error).toContain("leadership");
  });

  it("says a read it does not hold is not in the snapshot", async () => {
    const { fetch } = shimIn(out);
    const r = await fetch("/api/events/evt_x/people?q=zzz&priority=&tier=&status=kept&source=&offset=0&limit=12");
    expect(r.status).toBe(404);
    expect((await r.json()).error).toContain("not in the snapshot");
  });

  it("refuses every change with the desk's own words, and never reaches a server", async () => {
    const { fetch, calls } = shimIn(out);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const r = await fetch("/api/events/evt_x/plan/submit", { method, headers: { "x-actor": "Maya%20Okafor" }, body: "{}" });
      expect(r.status).toBe(403);
      expect((await r.json()).error).toBe("This public demo does not take changes. To try them, run the desk yourself: the README shows how.");
    }
    expect(calls).toEqual([]);
  });

  it("opens the event page for a scanner link instead of the camera app", () => {
    let to = "";
    const ctx = { window: { fetch: async () => new Response("") } as Record<string, unknown>, location: { href: "http://x/scan/evt_a", origin: "http://x", pathname: "/scan/evt_a", replace: (u: string) => { to = u; } }, crypto, TextEncoder, TextDecoder, Response, Headers, Blob, URL };
    (ctx.window as Record<string, unknown>).window = ctx.window;
    runInNewContext(SHIM, ctx);
    expect(to).toBe("/event/evt_a#scanner");
  });
});

describe("the bundle is noindex everywhere", () => {
  it("has the meta, the header, robots.txt and the shim ahead of the app", () => {
    const out = mkdtempSync(join(tmpdir(), "snap-web-"));
    mkdirSync(join(out, "assets"));
    writeFileSync(join(out, "index.html"), "<!doctype html><html><head><title>Events Desk</title></head><body></body></html>");
    writeFileSync(join(out, "scan-sw.js"), "x");
    finishWeb(out);
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(html).toContain('<meta name="robots" content="noindex,nofollow" />');
    expect(html.indexOf("snapshot-shim.js")).toBeGreaterThan(-1);
    expect(readFileSync(join(out, "_headers"), "utf8")).toMatch(/\/\*\n {2}X-Robots-Tag: noindex, nofollow/);
    expect(readFileSync(join(out, "robots.txt"), "utf8")).toBe("User-agent: *\nDisallow: /\n");
    expect(existsSync(join(out, "scan-sw.js"))).toBe(false);
    rmSync(out, { recursive: true, force: true });
  });
});

describe("the demo bar", () => {
  it("says it is a snapshot, and that nothing is saved", () => {
    const words = demoBarWords({ publicDemo: true, day: "2026-11-24", snapshot: "17 November 2026" }).join(" ");
    expect(words).toContain("read-only snapshot taken 17 November 2026");
    expect(words).toContain("Nothing you change is saved");
    expect(words).not.toContain("shared with the next visitor");
  });
});

describe("the crawl", () => {
  it("refuses to run beside a database URL", async () => {
    process.env.DATABASE_URL = "postgres://real.example/prod";
    try { await expect(main(["--out", join(tmpdir(), "never")])).rejects.toThrow(/DATABASE_URL is set/); } finally { delete process.env.DATABASE_URL; }
  });

  it("finds the read paths the screens use", () => {
    const t = readTemplates();
    expect(t).toContain("/api/overview");
    expect(t.some((p) => p.startsWith("/api/events/${id}/people"))).toBe(true);
    expect(t).not.toContain("/api/events/${e.id}/quote");        // a send(), a change
    expect(templatePattern("/api/events/${id}/people?${qs}").test("/api/events/evt_a/people")).toBe(true);
  });

  it("reads every path the screens use, changes nothing, and sends only GETs", async () => {
    const { db, app, dir } = await openDemo();
    try {
      const k = new Crawl(app);
      const ev = await db.query<{ id: string }>("SELECT id FROM events WHERE id = 'evt_money20-20-usa-2026' UNION ALL (SELECT id FROM events WHERE id <> 'evt_money20-20-usa-2026' ORDER BY id LIMIT 5)");
      const hosted = await db.query<{ event_id: string }>("SELECT event_id FROM event_guests LIMIT 1");
      const pick = [...new Set([...ev.map((e) => e.id), ...hosted.map((h) => h.event_id)])];
      const one = async (sql: string) => (await db.query<{ id: string }>(sql)).map((r) => r.id);
      const ids = {
        events: pick,
        contacts: await one("SELECT id FROM contacts ORDER BY id LIMIT 3"),
        replies: await one("SELECT id FROM inbound_messages ORDER BY id LIMIT 3"),
        meetings: await one("SELECT id FROM meetings ORDER BY id LIMIT 3"),
        debriefs: await one("SELECT id FROM debriefs ORDER BY id LIMIT 3"),
        sequences: await db.query<{ id: string; event_id: string }>("SELECT id, event_id FROM sequences ORDER BY id LIMIT 3"),
        kit: await one("SELECT id FROM kit_offers ORDER BY id LIMIT 3"),
        compiles: await one("SELECT id FROM icp_compiles ORDER BY id LIMIT 3"),
        guests: await db.query<{ id: string; event_id: string; token: string }>("SELECT id, event_id, rsvp_token AS token FROM event_guests WHERE removed_at IS NULL ORDER BY id LIMIT 3"),
        catalog: await one("SELECT id FROM catalog_events ORDER BY id LIMIT 3"),
        uploads: await db.query<{ id: string; event_id: string }>("SELECT id, event_id FROM uploads ORDER BY id LIMIT 3"),
      };
      await prime(app, ids);
      const before = await fingerprint(db);
      await crawl(k, ids, () => undefined);
      expect(await fingerprint(db)).toEqual(before);
      await crawlScanner(k, ids);
      const last = await fingerprint(db);
      expect(Object.keys(last).filter((t) => last[t] !== before[t] && t !== 'scans')).toEqual([]);
      expect(k.sent.every((s) => s.startsWith("GET "))).toBe(true);
      expect(IDENTITIES).toEqual(["", "Maya Okafor", "Camille Laurent", "Dan Whitlock", "GTM Team"]);
      // Every path the screens read has a saved answer. A kind of record the sample has none of is not asked for.
      const missing = uncovered(k.manifest, [...k.files.keys()]);
      expect(missing).toEqual([]);
    } finally { await db.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 600_000);

  it("reads a company sheet's deals", () => {
    expect(dealIds({ deals: [{ opportunity_id: "o1" }, { opportunity_id: null }] })).toEqual(["o1"]);
    expect(dealIds(null)).toEqual([]);
  });
});

