/* Events Desk's half of the four-desk rehearsal (docs/SHARED-WORLD.md 14.2). Run by lumen-world's stage/rehearse.py:

     DATABASE_URL=postgres://.../ev6p4_events CRM_DESK_URL=... CRM_DESK_KEY=... EVENTS_JOURNAL=file EVENTS_NOW=2026-11-12T14:00:00+00:00 node scripts/rehearse.ts

   It seeds the world, runs this desk's own sweep and outbox against a live CRM Desk, and writes down every call that changed something. It never calls a vendor or a model.
   A queued activity dated after the CRM's own clock is cancelled with a reason and counted, not written: CRM Desk's audit says nothing is dated after now. Prints one JSON line. */

import { migrate, postgresJs } from "../src/server/db.ts";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { seed } from "../src/server/seed.ts";
import { worldData } from "../src/server/world-slice.ts";
import { crmDeskCrm } from "../src/server/crm-desk.ts";
import { drainOutbox } from "../src/server/crm-outbox.ts";
import { syncCrm } from "../src/server/crm-sync.ts";
import { journalFetch } from "../src/server/journal-fetch.ts";

const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} is not set.`); process.exit(1); } return v; };
const url = need("DATABASE_URL"), crmUrl = need("CRM_DESK_URL"), crmKey = need("CRM_DESK_KEY"), journal = need("EVENTS_JOURNAL"), now = need("EVENTS_NOW");
// The runner names the prefix it may drop (REHEARSAL_DB_PREFIX); this script drops a schema, so it takes no other database.
const prefix = need("EVENTS_DB_PREFIX"), dbName = new URL(url).pathname.slice(1);
if (!dbName.startsWith(prefix)) { console.error(`Refusing the database ${dbName}: it does not start with ${prefix}.`); process.exit(1); }

// The desk's ids (events.ts newId, caches.ts) come from crypto.randomUUID, so every run made different ids, and the queries that order by id wrote the CRM
// in a different order (and picked different people): three rehearsals, three different journals (2026-11-16). A rehearsal is a recording the other desks
// replay, so its ids are numbered: the same sequence of calls gives the same ids. Only this script is changed; the desk itself keeps its random ids.
let idCount = 0;
Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, writable: true, value: () => {
  const h = createHash("sha256").update(`rehearsal-id:${idCount++}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}` as `${string}-${string}-${string}-${string}-${string}`;
} });

// The desk reads the wall clock in places (new Date(), Date.now(): what is "upcoming", which day a sample falls on), so a rehearsal on another hour or day wrote other calls.
// For this run the clock is the demo's own day (worldData().today, noon UTC), the day the world's Events Desk is built for; timers and the database driver keep real time.
const fixedNow = new Date(`${worldData().today}T12:00:00Z`).getTime();
class FixedDate extends Date {
  constructor(...a: unknown[]) { if (a.length === 0) super(fixedNow); else super(...(a as [string])); }
  static now() { return fixedNow; }
}
globalThis.Date = FixedDate as DateConstructor;

const clockNow = new Date(now.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")).toISOString();   // CRM Desk writes its clock as 2026-11-12T14:00:00+00
const root = fileURLToPath(new URL("..", import.meta.url));
const db = await postgresJs(url);
await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
await migrate(db, readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(join(root, "migrations", name), "utf8") })));
// Queries that do not fix their order return rows as Postgres happens to produce them, and background vacuum, parallel scans and synchronized scans change that between runs
// (Account Desk's runner turns the same three off for its deterministic build). Off for this database before anything is written, so the rows come back in the order they were made.
await db.query(`ALTER DATABASE "${dbName}" SET max_parallel_workers_per_gather = 0`);
await db.query(`ALTER DATABASE "${dbName}" SET synchronize_seqscans = off`);
for (const t of await db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")) await db.query(`ALTER TABLE "${t.tablename}" SET (autovacuum_enabled = false)`);
await seed(db, { real: true, today: worldData().today, world: true });

// People the CRM does not hold (the dinner's guests who declined or waited, most of the targets) are written as leads only when the event's person turned that on.
// A person would; the rehearsal does it for every event so the three new statuses have contacts to land on.
await db.query("UPDATE events SET write_leads = true");
// What the demo motion would have left from the weeks before Money20/20 USA: invitations sent and three meetings held, written as the desk's own rows (the sweep then writes them as it
// would any). The motion itself needs the whole demo pipeline, which a rehearsal does not run.
const people = await db.query<{ id: string; event_id: string; email: string; domain: string | null }>(
  `SELECT k.id, k.event_id, k.email, co.primary_domain AS domain FROM contacts k LEFT JOIN companies co ON co.id = k.company_id
   WHERE k.event_id = 'evt_money20-20-usa-2026' AND k.email LIKE '%.example' AND k.dropped_at IS NULL ORDER BY lower(k.email), k.full_name LIMIT 30`);   // by the person, not the id: an uploaded list's contact ids are random per run
for (const [i, p] of people.entries()) {
  await db.query(`INSERT INTO touches (id, domain, contact_id, event_id, kind, channel, at, source, dedup_key, step) VALUES ($1, $2, $3, $4, 'send', 'email', $5, 'rehearsal', $6, 1)`,
    [`tch_rh_${i}`, p.domain, p.id, p.event_id, new Date(Date.UTC(2026, 9, 6, 14 + (i % 3), i)).toISOString(), `rehearsal:send:${p.id}`]);
  if (i < 3) await db.query(`INSERT INTO meetings (id, event_id, contact_id, domain, external_key, status, scheduled_at, timezone, source) VALUES ($1, $2, $3, $4, $5, 'held', $6, 'America/Los_Angeles', 'manual')`,
    [`mtg_rh_${i}`, p.event_id, p.id, p.domain ?? "unknown.example", `rehearsal:meeting:${p.id}`, new Date(Date.UTC(2026, 9, 20, 17 + i)).toISOString()]);
}
const crm = crmDeskCrm(crmUrl, crmKey, journalFetch(journal));
// A guest who waited or declined was invited by someone, so the CRM holds them as a lead by then. The world's CRM slice leaves most of them out, and this desk never makes a lead from a
// waitlist or a decline (13.9 item 5), so the rehearsal writes them as the invite list would have: by address, before their status.
for (const g of await db.query<{ email: string; name: string; company: string | null }>("SELECT DISTINCT ON (lower(email)) lower(email) AS email, name, company FROM event_guests WHERE status IN ('waitlist', 'declined') AND removed_at IS NULL AND email IS NOT NULL ORDER BY lower(email)"))
  await crm.createLead!({ email: g.email, full_name: g.name, company: g.company ?? "", domain: g.email.split("@")[1] } as never);
const swept = await syncCrm(db, crm);
const late = await db.query<{ kind: string; n: number }>(
  `UPDATE crm_outbox SET status = 'cancelled', last_error = 'after the CRM''s clock' WHERE status = 'queued' AND kind = 'activity' AND (payload->>'at')::timestamptz > $1::timestamptz
   RETURNING kind, 1 AS n`, [clockNow]);
// Nothing but an example address goes to a rehearsal's CRM (the audit holds every desk to it): the demo's own sample people may carry others.
const notExample = await db.query("UPDATE crm_outbox SET status = 'cancelled', last_error = 'not an example address' WHERE status = 'queued' AND payload->>'email' IS NOT NULL AND lower(payload->>'email') NOT LIKE '%.example' RETURNING id");
let passes = 0, last = { sent: 0, failed: 0, none: 0 };
for (; passes < 6; passes++) {                    // a child campaign and the members wait for their parent: a few passes
  last = await drainOutbox(db, crm);
  if (!(await db.query("SELECT 1 FROM crm_outbox WHERE status = 'queued'")).length) break;
}
const by = async (sql: string) => Object.fromEntries((await db.query<{ k: string; n: number }>(sql)).map((r) => [r.k, r.n]));
console.log(JSON.stringify({
  swept, passes: passes + 1, drain: last, cancelled_after_clock: late.length, cancelled_not_example: notExample.length,
  outbox: await by("SELECT kind || ':' || status AS k, count(*)::int AS n FROM crm_outbox GROUP BY 1"),
  members: await by("SELECT last AS k, count(*)::int AS n FROM crm_sync WHERE kind = 'member' GROUP BY 1"),
  errors: await by("SELECT left(coalesce(last_error, ''), 80) AS k, count(*)::int AS n FROM crm_outbox WHERE status IN ('failed', 'held', 'queued') GROUP BY 1"),
}));
await db.close();
