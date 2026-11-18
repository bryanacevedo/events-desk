/* Builds the public demo as a static snapshot (docs/RUNBOOK.md, Static snapshot): the built app plus every answer it needs, saved as files.

   It opens the demo database the hosted demo opens (samples/demo-snapshot.tgz, unpacked into a folder of its own), runs the
   app in this process (Hono's fetch, no port), with PUBLIC_DEMO=1, and reads it the way the screens do, as each person the
   "Acting as" list offers and as a visitor who has not chosen yet. It writes:

     <out>/                           the built app, with the snapshot's fetch shim, noindex, the demo bar's snapshot words
     <out>/_snapshot/abc.json.gz      saved answers, sharded by the first 3 hex digits of a key's SHA-1
     <out>/_snapshot/config.json.gz   who the shim can answer as
     <out>/api/events/<id>/workbook   the files a screen links to (workbook, scans CSV, scanner code), as plain files
     <out>/_headers, robots.txt       noindex everywhere
     <out>/snapshot-manifest.json     every saved request, for the tests and the runbook

   A key is the request as the shim sees it: method, path, sorted query pairs. Under a key an answer is saved for everyone
   ("*") or, when the people differ (money, who may plan, "mine"), for each of them ("a:<name>", "a:" for nobody chosen).
   The crawl sends only GETs. The database's fingerprint is compared before and after, so the build stops if a read
   changed anything. It refuses any database that is not the demo's own folder.

     node scripts/build-static-snapshot.ts --out .snapshot        (make snapshot builds the app first) */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { PERSONAS } from "../src/shared/roles.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHIM = join(ROOT, "scripts", "static-snapshot", "shim.js");
export const SNAPSHOT_HOST = "https://events-desk-demo.pages.dev";
export const MAX_FILES = 19_000;          // Cloudflare Pages takes 20,000 files a deployment on the free plan
export const MAX_MB = 60;
/** Who can ask: nobody chosen yet (the app sends no name until a person picks one), then each person in the Acting as list. */
export const IDENTITIES: string[] = ["", ...PERSONAS.map((p) => p.name)];
const PAGE = 12;                          // Event.tsx: the people and companies lists page by 12

// ---------------------------------------------------------------- the key, the same as shim.js keyOf

export type Answer = [number, unknown];
export const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;

export function requestKey(method: string, path: string): string {
  const u = new URL(path, "http://x");
  const pairs = [...u.searchParams].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return JSON.stringify([method.toUpperCase(), u.pathname, pairs, null]);
}
export const requestHash = (method: string, path: string) => createHash("sha1").update(requestKey(method, path)).digest("hex");

// ---------------------------------------------------------------- what the screens ask for, read from src/app

/** Every /api path the screens read, as written in the code. A literal is a read unless it is the path of a send(...) with a changing method. Used by the tests: each must have a saved answer. */
export function readTemplates(src = join(ROOT, "src")): string[] {
  const found = new Set<string>();
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []);
  // The scanner (src/scan) is a phone app the snapshot does not run; its link opens the event.
  for (const f of walk(join(src, "app"))) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/(["'`])(\/api\/[^"'`]*?)\1/g)) {
      const before = text.slice(Math.max(0, m.index! - 60), m.index!);
      // A change: the path follows a changing method (send("POST", path), act("POST", path)), is the target of an Upload, or is the base the delete button uses.
      if (/["'`](?:POST|PATCH|PUT|DELETE)["'`],\s*$/.test(before)) continue;
      if (/\bpath=\{?$/.test(before) || /\bbase:\s*$/.test(before)) continue;
      if (/method:\s*["'`](?:POST|PATCH|PUT|DELETE)["'`][^)]*$/.test(before)) continue;
      found.add(m[2]);
    }
  }
  return [...found].sort();
}
/** A template's path as a pattern: each ${...} stands for part of one path segment. */
export function templatePattern(t: string): RegExp {
  const parts = t.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, "\0").split("?")[0].split("\0");
  return new RegExp("^" + parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/?]*") + "$");
}

// ---------------------------------------------------------------- the database

type Db = { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>; close(): Promise<void> };

export async function fingerprint(db: Db): Promise<Record<string, string>> {
  const tables = (await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).map((r) => r.tablename);
  const out: Record<string, string> = {};
  for (const t of tables) {
    const [r] = await db.query<{ n: number; x: string; h: string }>(`SELECT count(*)::int AS n, coalesce(max(xmin::text::bigint), 0)::text AS x, coalesce(sum(hashtextextended(t::text, 0)::numeric), 0)::text AS h FROM "${t}" t`);
    out[t] = `${r.n}:${r.x}:${r.h}`;
  }
  return out;
}

/** Opens the demo the hosted instance opens, from a copy: the folder the sample unpacks to is a temporary one, so nothing else is read or changed. */
export async function openDemo(): Promise<{ db: Db & { tx: unknown }; app: { fetch: (r: Request) => Response | Promise<Response> }; dir: string; today: string }> {
  if (process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is set. The snapshot reads only the demo sample (samples/demo-snapshot.tgz) and refuses to run beside a database URL: unset it.");
  process.env.PUBLIC_DEMO = "1";
  process.env.WORLD = process.env.WORLD ?? "lumen";
  for (const k of ["LIVE_SPEND", "LIVE_SEND", "INTEGRATED_WITH", "CRM", "SIM_MODE", "TRANSACTIONAL_URL", "TRANSACTIONAL_KEY", "WRITE_KEY"]) delete process.env[k];
  const tgz = join(ROOT, "samples", "demo-snapshot.tgz");
  if (!existsSync(tgz)) throw new Error("samples/demo-snapshot.tgz is missing: it is the demo the snapshot reads (make demo-snapshot builds it).");
  const dir = mkdtempSync(join(tmpdir(), "events-desk-snapshot-"));
  execFileSync("tar", ["xzf", tgz, "-C", dir]);
  const { pglite, migrate } = await import("../src/server/db.ts");
  const { createApp } = await import("../src/server/app.ts");
  const { simDeps } = await import("../src/server/sim-vendors.ts");
  const { demoConnectors } = await import("../src/server/connectors/setup.ts");
  const { demoLifecycle } = await import("../src/server/sim-mode.ts");
  const { publishAll } = await import("../src/server/definitions.ts");
  const { restampDemoPlan } = await import("../src/server/seed-plan.ts");
  const { worldData } = await import("../src/server/world-slice.ts");
  const { exampleDns } = await import("../src/server/identity.ts");
  const db = await pglite(join(dir, "demo"));
  const migrations = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(join(ROOT, "migrations", name), "utf8") }));
  await migrate(db, migrations);
  await publishAll(db);
  // The same start the hosted demo makes (src/server/node.ts): the sample's own day, and the plan dates set around it.
  const today = process.env.DEMO_TODAY ?? (process.env.WORLD === "lumen" ? worldData().today : new Date().toISOString().slice(0, 10));
  process.env.DEMO_TODAY = today; process.env.DEMO_TODAY_SET = "1";
  await restampDemoPlan(db, today);
  const deps = simDeps();
  const setup = await demoConnectors(db);
  const lifecycle = demoLifecycle(db, deps as never, setup);
  const app = createApp(db, { autoQuote: true, lifecycle, demoTools: setup.tools, demo: true, publicDemo: true, llm: deps.llm, dns: exampleDns, crm: deps.crm } as never);
  return { db: db as never, app, dir, today };
}

// ---------------------------------------------------------------- the crawl

export class Crawl {
  saved = new Map<string, Record<string, Answer>>();
  manifest: { path: string; status: number[]; scopes: string[] }[] = [];
  files = new Map<string, Uint8Array>();
  sent: string[] = [];
  log: (s: string) => void = () => undefined;
  app: { fetch: (r: Request) => Response | Promise<Response> };
  constructor(app: { fetch: (r: Request) => Response | Promise<Response> }) { this.app = app; }

  private async ask(path: string, who: string): Promise<{ r: Response; bytes: Uint8Array }> {
    this.sent.push(`GET ${path}`);
    const r = await this.app.fetch(new Request(SNAPSHOT_HOST + path, { headers: who ? { "x-actor": encodeURIComponent(who) } : {} }));
    return { r, bytes: new Uint8Array(await r.arrayBuffer()) };
  }

  /** Reads a path as each of the identities and keeps the answer once when they all got the same one. Returns the answer of the most capable one (GTM Team). */
  async read(path: string, who: string[] = IDENTITIES): Promise<unknown> {
    if (this.sent.length % 2000 < who.length) this.log(`  ${this.sent.length} reads, ${this.saved.size} answers`);
    const asked: Record<string, Answer> = {};
    for (const w of who) {
      const { r, bytes } = await this.ask(path, w);
      if (r.status >= 500 || r.status === 429) throw new Error(`GET ${path} as "${w}" answered ${r.status}: ${new TextDecoder().decode(bytes).slice(0, 200)}`);
      if (!(r.headers.get("content-type") ?? "").includes("json")) throw new Error(`GET ${path} did not answer JSON (${r.headers.get("content-type")}); a file is read with file().`);
      asked[`a:${w}`] = [r.status, JSON.parse(new TextDecoder().decode(bytes))];
    }
    const vals = Object.values(asked);
    const same = vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0]));
    const h = requestHash("GET", path);
    if (!this.saved.has(h)) {
      this.saved.set(h, same ? { "*": vals[0] } : asked);
      this.manifest.push({ path, status: [...new Set(vals.map((v) => v[0]))].sort(), scopes: same ? ["*"] : Object.keys(asked) });
    }
    const best = asked["a:GTM Team"] ?? vals[vals.length - 1];
    return best && best[0] === 200 ? best[1] : null;
  }

  /** A file a screen links to, saved as it is at its own path. Read as the person who can see the most; a refusal is not saved. */
  async file(path: string): Promise<boolean> {
    const { r, bytes } = await this.ask(path, "GTM Team");
    if (r.status !== 200) return false;
    this.files.set(new URL(path, "http://x").pathname, bytes);
    return true;
  }
}

interface Ids { events: string[]; contacts: string[]; replies: string[]; meetings: string[]; debriefs: string[]; sequences: { id: string; event_id: string }[]; kit: string[]; compiles: string[]; guests: { id: string; event_id: string; token: string }[]; catalog: string[]; uploads: { id: string; event_id: string }[] }

async function idsOf(db: Db): Promise<Ids> {
  const col = async (sql: string) => (await db.query<{ id: string }>(sql)).map((r) => r.id);
  return {
    events: await col("SELECT id FROM events ORDER BY id"),
    contacts: await col("SELECT id FROM contacts ORDER BY id"),
    replies: await col("SELECT id FROM inbound_messages ORDER BY id"),
    meetings: await col("SELECT id FROM meetings ORDER BY id"),
    debriefs: await col("SELECT id FROM debriefs ORDER BY id"),
    sequences: await db.query<{ id: string; event_id: string }>("SELECT id, event_id FROM sequences ORDER BY id"),
    kit: await col("SELECT id FROM kit_offers ORDER BY id"),
    compiles: await col("SELECT id FROM icp_compiles ORDER BY id"),
    guests: await db.query<{ id: string; event_id: string; token: string }>("SELECT id, event_id, rsvp_token AS token FROM event_guests WHERE removed_at IS NULL ORDER BY id"),
    catalog: await col("SELECT id FROM catalog_events ORDER BY id"),
    uploads: await db.query<{ id: string; event_id: string }>("SELECT id, event_id FROM uploads ORDER BY id"),
  };
}

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();
const rowsOf = (d: unknown): { id?: string }[] => (d && typeof d === "object" && Array.isArray((d as { rows?: unknown }).rows) ? (d as { rows: { id?: string }[] }).rows : []);

/** Walks a list the way its Pager does: from offset 0 by the page size until the total is reached. */
async function pageAll(k: Crawl, base: (offset: number) => string, max = Infinity): Promise<{ id?: string }[]> {
  const out: { id?: string }[] = [];
  for (let offset = 0, n = 0; n < max; offset += PAGE, n++) {
    const d = (await k.read(base(offset))) as { total?: number; rows?: { id?: string }[] } | null;
    out.push(...rowsOf(d));
    if (!d || typeof d.total !== "number" || offset + PAGE >= d.total) break;
  }
  return out;
}

/** The scanner's read settles badge scans that were waiting for a person (the app does it on any visit, once). It runs before the "before" fingerprint, so the crawl itself changes nothing. */
export async function prime(app: { fetch: (r: Request) => Response | Promise<Response> }, ids: Ids): Promise<void> {
  for (const id of ids.events) await (await app.fetch(new Request(`${SNAPSHOT_HOST}/api/events/${id}/scanner`, { headers: { "x-actor": encodeURIComponent("GTM Team") } }))).arrayBuffer();
}

/** The scanner's answer, read last: the read retries the badge scans waiting for a person (src/server/scans.ts resolvePending), so it touches the scans table of the temporary copy, and nothing else. */
export async function crawlScanner(k: Crawl, ids: Ids): Promise<void> {
  for (const id of ids.events) await k.read(`/api/events/${id}/scanner`);
}

export async function crawl(k: Crawl, ids: Ids, log: (s: string) => void = console.log): Promise<void> {
  // The shell and the pages that do not belong to one event.
  for (const p of ["/api/health", "/api/overview", "/api/events", "/api/catalog", "/api/approvals", "/api/seat-requests", "/api/seat-decisions", "/api/choosing", "/api/choosing/repeat",
    "/api/results", "/api/speaking", "/api/kit/offers", "/api/target-accounts", "/api/suppressions", "/api/settings/view", "/api/settings/defaults", "/api/icp", "/api/icp/sample-bench",
    "/api/integration", "/api/capture-keys", "/api/cases/open", "/api/motion/learning", "/api/hosted/mine"]) await k.read(p);
  for (const rep of PERSONAS.map((p) => p.name)) await k.read(`/api/motion/my-day?rep=${encodeURIComponent(rep)}`);
  // Budget and Usage: every page of the default view, for each year the desk knows.
  for (const base of ["/api/usage?q=&page=", "/api/budget?q=&page="]) {
    const years: (number | null)[] = base.includes("budget") ? [] : [null];
    if (base.includes("budget")) {
      const first = (await k.read("/api/budget?year=0&q=&page=1")) as { years?: number[] } | null;
      const set = new Set<number>([...(first?.years ?? []), new Date().getFullYear(), 2026]);
      years.push(...set);
    }
    for (const y of years) {
      const withYear = (p: number) => (y === null ? `${base}${p}` : `/api/budget?year=${y}&q=&page=${p}`);
      for (let p = 1; p < 200; p++) {
        const d = (await k.read(withYear(p))) as { total?: number; per_page?: number; pages?: number; page_count?: number } | null;
        const pages = d?.pages ?? d?.page_count ?? (d?.total && d?.per_page ? Math.ceil(d.total / d.per_page) : 1);
        if (!d || p >= pages) break;
      }
    }
  }
  for (const c of ids.catalog) await k.read(`/api/choosing/${c}/likely`);

  // One event at a time: its page, its tabs, its lists and each row's sheet.
  const deals = new Map<string, Set<string>>();
  let n = 0;
  for (const id of ids.events) {
    const e = `/api/events/${id}`;
    for (const p of [e, `${e}/plan`, `${e}/cost`, `${e}/next`, `${e}/motion`, `${e}/motion/roster`, `${e}/hosted`, `${e}/speaking`, `${e}/follow-up`, `${e}/goal-tracker`, `${e}/desk-plays`,
      `${e}/desk-panel`, `${e}/cases`, `${e}/sequences`, `${e}/scans`, `${e}/directory`, `${e}/guests/suggestions`, `${e}/reminders?kind=reminder&note=`, `${e}/reminders?kind=logistics&note=`,
      `/api/kit/offers?event=${id}`]) await k.read(p);
    for (const f of [`${e}/workbook`, `${e}/scans.csv`, `${e}/scanner/qr.png`]) await k.file(f);
    for (const u of ids.uploads.filter((x) => x.event_id === id)) for (const f of [`${e}/uploads/${u.id}/file`, `${e}/uploads/${u.id}/rows`]) await k.file(f);
    // The people list the page opens with, every page of it, and the first pages of each single filter.
    const people = (extra: Record<string, string>) => (offset: number) => `${e}/people?${q({ q: "", priority: "", tier: "", status: "kept", source: "", offset: String(offset), limit: String(PAGE), ...extra })}`;
    await pageAll(k, people({}));
    for (const [key, vals] of [["priority", ["A", "B", "C"]], ["tier", ["1", "2", "3", "unknown"]], ["source", ["attendee", "prospect"]], ["status", ["dropped", "all"]]] as const) {
      for (const v of vals) await pageAll(k, people({ [key]: v }), 2);
    }
    const companies = (offset: number) => `${e}/companies?${q({ q: "", tier: "", offset: String(offset), limit: String(PAGE) })}`;
    for (const c of await pageAll(k, companies)) {
      if (!c.id) continue;
      for (const oid of dealIds(await k.read(`${e}/companies/${c.id}`))) (deals.get(id) ?? deals.set(id, new Set()).get(id)!).add(oid);
    }
    for (const t of ["1", "2", "3", "unknown"]) await pageAll(k, (o) => `${e}/companies?${q({ q: "", tier: t, offset: String(o), limit: String(PAGE) })}`, 2);
    if (++n % 10 === 0) log(`  events: ${n} of ${ids.events.length}`);
  }
  for (const [event, set] of deals) for (const oid of set) await k.read(`/api/events/${event}/deals/${encodeURIComponent(oid)}`);

  // Every record a sheet can open.
  const each = async (label: string, paths: string[]) => { for (const p of paths) await k.read(p); log(`  ${label}: ${paths.length}`); };
  await each("people", ids.contacts.map((c) => `/api/people/${c}`));
  await each("replies", ids.replies.map((r) => `/api/motion/replies/${r}`));
  await each("meetings", ids.meetings.flatMap((m) => [`/api/motion/meetings/${m}`, `/api/motion/meetings/${m}/brief`]));
  await each("debriefs", ids.debriefs.map((d) => `/api/motion/debriefs/${d}`));
  await each("sequences", ids.sequences.map((s) => `/api/events/${s.event_id}/sequences/${s.id}`));
  await each("kit", ids.kit.map((o) => `/api/kit/${o}`));
  await each("compiles", ids.compiles.map((c) => `/api/icp/compiles/${c}`));
  await each("invitations", ids.guests.map((g) => `/api/events/${g.event_id}/guests/${g.id}/invitation`));
  await each("rsvp", ids.guests.map((g) => `/api/rsvp/${encodeURIComponent(g.token)}`));
}

/** The deals a company's sheet credits to its event: their ids. */
export function dealIds(body: unknown): string[] {
  const d = (body as { deals?: { opportunity_id?: string }[] } | null)?.deals;
  return Array.isArray(d) ? d.map((x) => x.opportunity_id).filter((x): x is string => Boolean(x)) : [];
}

// ---------------------------------------------------------------- the bundle

const gz = (data: string | Uint8Array) => gzipSync(data, { level: 9, mtime: 0 } as never);

export function writeBundle(out: string, k: Crawl, takenOn: string, today: string): { responses: number; shards: number; raw_bytes: number } {
  const snap = join(out, "_snapshot");
  mkdirSync(snap, { recursive: true });
  // The snapshot is a snapshot: the health read says so, so every page shows it, and no other desk is called.
  const health = k.saved.get(requestHash("GET", "/api/health"))!;
  for (const a of Object.values(health)) if (a[0] === 200) (a[1] as Record<string, unknown>).snapshot = { taken_on: takenOn };
  const integration = k.saved.get(requestHash("GET", "/api/integration"))!;
  for (const a of Object.values(integration)) if (a[0] === 200) (a[1] as Record<string, unknown>).links = {};
  const shards = new Map<string, Record<string, Record<string, Answer>>>();
  for (const [h, v] of k.saved) { const s = shards.get(h.slice(0, 3)) ?? shards.set(h.slice(0, 3), {}).get(h.slice(0, 3))!; s[h] = v; }
  let raw = 0;
  for (const [name, items] of shards) { const data = JSON.stringify(items); raw += data.length; writeFileSync(join(snap, `${name}.json.gz`), gz(data)); }
  writeFileSync(join(snap, "config.json.gz"), gz(JSON.stringify({ identities: IDENTITIES, today })));
  for (const [p, bytes] of k.files) { const f = join(out, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, bytes); }
  writeFileSync(join(out, "snapshot-manifest.json"), JSON.stringify({ taken_on: takenOn, requests: k.manifest, files: [...k.files.keys()] }));
  return { responses: k.saved.size, shards: shards.size, raw_bytes: raw };
}

export const CSP = "default-src 'self'; img-src 'self' data: blob: https://www.google.com https://*.gstatic.com https://images.unsplash.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; media-src 'self' blob:; manifest-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

/** The built app gets the shim before its own script, noindex, and the headers file. */
export function finishWeb(out: string): void {
  const index = join(out, "index.html");
  const html = readFileSync(index, "utf8").replace("<head>", '<head>\n    <meta name="robots" content="noindex,nofollow" />\n    <script src="/snapshot-shim.js"></script>');
  writeFileSync(index, html);
  cpSync(SHIM, join(out, "snapshot-shim.js"));
  // The scanner is a phone app that needs a camera and a service worker; the snapshot has neither, so it does not ship its worker.
  rmSync(join(out, "scan-sw.js"), { force: true });
  writeFileSync(join(out, "_headers"), [
    "/*", "  X-Robots-Tag: noindex, nofollow", "  X-Content-Type-Options: nosniff", "  X-Frame-Options: DENY", "  Referrer-Policy: same-origin", `  Content-Security-Policy: ${CSP}`, "",
    "/_snapshot/*", "  Cache-Control: public, max-age=0, must-revalidate", "",
    "/api/events/*/workbook", "  Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "  Content-Disposition: attachment", "",
    "/api/events/*/scans.csv", "  Content-Type: text/csv; charset=utf-8", "",
    "/api/events/*/scanner/qr.png", "  Content-Type: image/png", "",
    "/api/events/*/uploads/*", "  Content-Disposition: attachment", "",
  ].join("\n"));
  writeFileSync(join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");
}

function dirSize(p: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = join(d, e.name); if (e.isDirectory()) walk(f); else { files++; bytes += statSync(f).size; } } };
  walk(p);
  return { files, bytes };
}

/** The read paths the screens use that have no saved answer (or file). */
export function uncovered(manifest: { path: string; status: number[] }[], files: string[], templates = readTemplates()): string[] {
  const paths = manifest.map((m) => new URL(m.path, "http://x").pathname);
  return templates.filter((t) => { const pat = templatePattern(t); return !paths.some((p) => pat.test(p)) && !files.some((p) => pat.test(p)); });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const get = (name: string, dflt: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const out = resolve(get("--out", join(ROOT, ".snapshot")));
  const t0 = Date.now();
  // The database guard first: it must hold even where dist/ has not been built (CI runs the suite without a build).
  if (process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is set. The snapshot reads only the demo sample (samples/demo-snapshot.tgz) and refuses to run beside a database URL: unset it.");
  if (!existsSync(join(ROOT, "dist", "index.html"))) throw new Error("dist/ is missing: run npm run build first (make snapshot does).");
  const { db, app, dir, today } = await openDemo();
  try {
    const k = new Crawl(app);
    k.log = console.log;
    const ids = await idsOf(db);
    await prime(app, ids);
    const before = await fingerprint(db);
    await crawl(k, ids);
    const after = await fingerprint(db);
    const changed = Object.keys(before).filter((t) => before[t] !== after[t]);
    if (changed.length) throw new Error(`The crawl changed the database (${changed.join(", ")}). Nothing is published.`);
    await crawlScanner(k, ids);
    const last = await fingerprint(db);
    const touched = Object.keys(after).filter((t) => after[t] !== last[t]);
    if (touched.some((t) => t !== "scans")) throw new Error(`The scanner reads changed the database (${touched.join(", ")}). Nothing is published.`);
    const writes = k.sent.filter((s) => !s.startsWith("GET "));
    if (writes.length) throw new Error(`The crawl sent a change: ${writes.slice(0, 3).join(", ")}`);
    rmSync(out, { recursive: true, force: true });
    cpSync(join(ROOT, "dist"), out, { recursive: true });
    const takenOn = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    const stats = writeBundle(out, k, takenOn, today);
    finishWeb(out);
    const { files, bytes } = dirSize(out);
    const missing = uncovered(k.manifest, [...k.files.keys()]);
    const report = { ...stats, files, bytes, seconds: Math.round((Date.now() - t0) / 1000), uncovered: missing };
    console.log(JSON.stringify(report, null, 1));
    if (missing.length) throw new Error(`Screens read paths the snapshot did not save: ${missing.join(", ")}`);
    if (bytes > MAX_MB * 1_000_000) throw new Error(`The bundle is ${(bytes / 1e6).toFixed(1)} MB, over ${MAX_MB} MB.`);
    if (files > MAX_FILES) throw new Error(`The bundle has ${files} files, over ${MAX_FILES}.`);
    return 0;
  } finally {
    await db.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c), (e) => { console.error(String((e as Error).message ?? e)); process.exit(1); });
}
