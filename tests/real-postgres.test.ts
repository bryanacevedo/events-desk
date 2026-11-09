/* Real Postgres over the network: the driver, and locks under real contention, which PGlite's single connection cannot show.
   Runs when TEST_DATABASE_URL points at a database it may wipe. CI starts one. */

import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, postgresJs, type Db } from "../src/server/db.ts";
import { reserve, settle, spend } from "../src/server/ledger.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { mockLlm, mockVendors } from "../src/server/providers.ts";
import { seed } from "../src/server/seed.ts";

const url = process.env.TEST_DATABASE_URL;

describe.runIf(url)("on real Postgres", () => {
  let db: Db;
  beforeAll(async () => {
    db = await postgresJs(url!, { max: 12 });
    await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(db, readdirSync("migrations").filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(`migrations/${name}`, "utf8") })));
    await seed(db);
  }, 180_000);
  afterAll(async () => { await db?.close(); });

  const card = async (cap: number) => {
    const [{ id: eventId }] = await db.query<{ id: string }>("SELECT id FROM events ORDER BY created_at LIMIT 1");
    await db.query("UPDATE cost_cards SET status = 'declined' WHERE event_id = $1", [eventId]);
    await db.query("DELETE FROM credit_ledger WHERE event_id = $1", [eventId]);
    await db.query(`INSERT INTO cost_cards (id, event_id, inputs, rates, lines, credits_cap, llm_cap, est_cents, status) VALUES ($1, $2, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $3, 0, 0, 'approved')`, [`card_pg_${cap}`, eventId, cap]);
    return eventId;
  };

  it("loads the migrations and the sample on the network driver", async () => {
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM events");
    expect(n).toBeGreaterThan(0);
  });

  it("keeps timestamps and dates in the shapes the app expects", async () => {
    const [e] = await db.query<{ starts_on: string; created_at: string }>("SELECT starts_on::text AS starts_on, created_at FROM events LIMIT 1");
    expect(e.starts_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(e.created_at).toMatch(/T.*Z$/);
  });

  it("passes array parameters", async () => {
    const [e] = await db.query<{ id: string }>("SELECT id FROM events LIMIT 1");
    expect(await db.query("SELECT id FROM events WHERE id = ANY($1::text[])", [[e.id]])).toHaveLength(1);
  });

  it("never lets concurrent reservations pass the cap", async () => {
    const eventId = await card(20);
    const got = await Promise.all(Array.from({ length: 60 }, () => reserve(db, eventId, "credits", 1, "race", "race")));
    expect(got.filter(Boolean)).toHaveLength(20);
    expect((await spend(db, eventId)).credits).toBe(20);
  }, 60_000);

  it("settles concurrently without losing a release", async () => {
    const eventId = await card(30);
    const ids = (await Promise.all(Array.from({ length: 30 }, () => reserve(db, eventId, "credits", 1, "race", "race")))).filter(Boolean) as string[];
    await Promise.all(ids.map((id, i) => settle(db, id, i % 2)));
    expect((await spend(db, eventId)).credits).toBe(15);
  }, 60_000);

  it("gives each queued job to one worker", async () => {
    const [{ id: eventId }] = await db.query<{ id: string }>("SELECT id FROM events ORDER BY created_at LIMIT 1");
    await db.query("DELETE FROM jobs WHERE event_id = $1", [eventId]);
    for (let i = 0; i < 40; i++) await db.query("INSERT INTO jobs (id, event_id, kind, payload) VALUES ($1, $2, 'race', '{}'::jsonb)", [`job_pg_${i}`, eventId]);
    const claim = () => db.query<{ id: string }>(`UPDATE jobs SET status = 'running', lease_until = now() + interval '2 minutes' WHERE id = (SELECT id FROM jobs WHERE event_id = $1 AND status = 'queued' AND kind = 'race' ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`, [eventId]);
    const rounds = await Promise.all(Array.from({ length: 80 }, claim));
    const ids = rounds.flat().map((r) => r.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  }, 60_000);

  it("runs an event's pipeline on the network driver", async () => {
    const running = await db.query<{ id: string }>("SELECT id FROM events WHERE stage IN ('researching', 'tiering', 'enriching', 'flagging', 'finding_people') LIMIT 1");
    if (running[0]) await processEvent(db, running[0].id, { llm: mockLlm, vendorsFor: mockVendors });
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE status = 'running' AND lease_until > now() AND kind <> 'race'");
    expect(n).toBe(0);
  }, 120_000);
});
