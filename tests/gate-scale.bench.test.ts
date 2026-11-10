/* The gate and the funnel at about 10,000 people. Not part of the normal run: set BENCH_GATE=1 (and TEST_ALL_ON_POSTGRES for real plans). Prints timings and the plans of the per-person queries. */

import { describe, expect, it } from "vitest";
import { runGate } from "../src/server/gate.ts";
import { freshDb } from "./helpers.ts";
import { deliveredInMotion, personAt } from "./lifecycle-harness.ts";

const N = Number(process.env.BENCH_N ?? 10_000);

describe.runIf(process.env.BENCH_GATE === "1")("gate at scale", () => {
  it(`runs the gate for ${N} people and reads the plans`, async () => {
    const db = await freshDb();
    const h = await deliveredInMotion(db);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await db.query(`CREATE TABLE bulk AS SELECT c.*, g FROM contacts c, generate_series(1, $2::int) g WHERE c.id = $1`, [ana.id, N]);
    await db.query(`UPDATE bulk SET id = 'b' || g, email = 'p' || g || '@' || split_part(email, '@', 2), full_name = full_name || ' ' || g, person_id = NULL, linkedin = 'https://www.linkedin.com/in/p' || g`);
    await db.query(`ALTER TABLE bulk DROP COLUMN g`);
    await db.query(`INSERT INTO contacts SELECT * FROM bulk`);
    await db.query(`INSERT INTO verification_cache (email, verdict, verifier, checked_at) SELECT lower(email), 'deliverable', 'bench', $1::timestamptz FROM bulk ON CONFLICT DO NOTHING`, [h.time.now.toISOString()]);
    // Background history, so the plans see tables of a realistic size: ten touches and two messages per person.
    await db.query(`INSERT INTO touches (id, domain, contact_id, event_id, kind, at, source, dedup_key)
      SELECT 'tb' || g, split_part(b.email, '@', 2), b.id, $1, (ARRAY['send','send','send','open','reply_positive','send','send','send','send','reply_not_now'])[1 + g % 10], $3::timestamptz - (g % 400) * interval '1 day', 'bench', 'tb' || g
      FROM generate_series(1, $2::int * 10) g JOIN bulk b ON b.id = 'b' || (1 + g % $2::int)`, [h.id, N, h.time.now.toISOString()]);
    await db.query(`INSERT INTO inbound_messages (id, connector, provider_message_id, event_id, contact_id, channel, signal, received_at, status)
      SELECT 'ib' || g, 'instantly', 'ib' || g, $1, 'b' || (1 + g % $2::int), 'email', 'reply', now() - interval '500 days', 'done' FROM generate_series(1, $2::int * 2) g`, [h.id, N]);
    await db.query("ANALYZE");
    const ids = (await db.query<{ id: string }>("SELECT id FROM contacts WHERE id LIKE 'b%' AND event_id = $1", [h.id])).map((r) => r.id);
    expect(ids.length).toBe(N);

    let t = performance.now();
    const res = await runGate(db, h.deps, h.id, ids, "email", "add");
    const gateMs = performance.now() - t;
    const reasons: Record<string, number> = {};
    for (const r of res) reasons[r.reason ?? "passed"] = (reasons[r.reason ?? "passed"] ?? 0) + 1;
    t = performance.now();
    await db.query("SELECT * FROM event_funnel WHERE event_id = $1", [h.id]);
    const funnelMs = performance.now() - t;
    console.log(`BENCH gate ${N} people: ${Math.round(gateMs)} ms (${(gateMs / N).toFixed(2)} ms/person). funnel: ${Math.round(funnelMs)} ms. outcomes: ${JSON.stringify(reasons)}`);

    const p = (await db.query<{ id: string; person_id: string | null; email: string }>("SELECT id, person_id, email FROM contacts WHERE id = 'b77'"))[0];
    const plans: [string, string, unknown[]][] = [
      ["cadence", `SELECT n.id FROM enrollments n JOIN contacts k ON k.id = n.contact_id WHERE n.state <> 'removed' AND n.event_id <> $1 AND (n.contact_id = $2 OR ($3::text IS NOT NULL AND n.person_id = $3) OR ($4::text IS NOT NULL AND lower(k.email) = lower($4))) LIMIT 1`, ["other", p.id, p.person_id, p.email]],
      ["cool_off", `SELECT kind, at::text AS at FROM (SELECT t.kind, t.at FROM touches t WHERE t.contact_id = $1 AND t.kind IN ('reply_not_interested', 'reply_not_now') UNION ALL SELECT t.kind, t.at FROM touches t WHERE $2::text IS NOT NULL AND t.person_id = $2 AND t.kind IN ('reply_not_interested', 'reply_not_now') AND t.person_id IS NOT NULL UNION ALL SELECT t.kind, t.at FROM contacts k JOIN touches t ON t.contact_id = k.id WHERE $3::text IS NOT NULL AND lower(k.email) = lower($3) AND k.email IS NOT NULL AND t.kind IN ('reply_not_interested', 'reply_not_now')) x WHERE at <= $4::timestamptz ORDER BY at DESC LIMIT 1`, [p.id, p.person_id, p.email, h.time.now.toISOString()]],
      ["waiting", `SELECT 1 FROM inbound_messages WHERE contact_id = $1 AND (status = 'received' OR (doubtful AND decided_at IS NULL)) LIMIT 1`, [p.id]],
      ["met", `SELECT 1 FROM onsite_captures c WHERE c.contact_id = $1 AND c.event_id = $2 LIMIT 1`, [p.id, h.id]],
      ["funnel", `SELECT * FROM event_funnel WHERE event_id = $1`, [h.id]],
    ];
    for (const [name, sql, args] of plans) {
      const rows = await db.query<Record<string, string>>(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, args);
      console.log(`PLAN ${name}\n` + rows.map((r) => Object.values(r)[0]).join("\n"));
    }
  }, 600_000);
});
