/* The email loop measured against the simulated world (samples/world.json): reveal, the employment check, the catch-all probe and the verification loop.

   SIMULATED RESULTS ARE AUTHORED. The world knows every person's real address, who has left, and which domains accept every address. The simulated vendors
   go wrong at the rates in SIM_RATES: Apollo's match and its waterfall sources return a guessed mailbox or a homonym's address, ZeroBounce calls a mailbox that does not exist
   deliverable (4%, which is also how a probe can read an ordinary domain as catch-all) or misses a catch-all domain (8%), the reveal misses 12% and returns a person who has moved
   to a new employer, and Apollo withholds its Verified status at the authored shares. None of that is measured. These numbers show the code copes with those failures and stays inside the card;
   they say nothing about Apollo or ZeroBounce. The floors stop a change from making this worse. */

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { decideApproval } from "../src/server/approvals.ts";
import { answerCase, listCases } from "../src/server/cases.ts";
import type { Db } from "../src/server/db.ts";
import { createEvent, moveEvent } from "../src/server/events.ts";
import { exampleDns } from "../src/server/identity.ts";
import { spendByStep } from "../src/server/ledger.ts";
import { processEvent, type Deps } from "../src/server/pipeline.ts";
import { VendorError } from "../src/server/providers.ts";
import { requestOutreachCard, requestResearchCard } from "../src/server/research.ts";
import { seedIcp } from "../src/server/seed.ts";
import { simDeps } from "../src/server/sim-vendors.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { nameKey } from "../src/shared/email.ts";
import type { World } from "../src/shared/world.ts";
import { freshDb } from "./helpers.ts";

const csv = readFileSync("samples/attendees-large.csv", "utf8");
const world = JSON.parse(readFileSync("samples/world.json", "utf8")) as World;
const personByEmail = new Map(world.people.map((p) => [p.email.toLowerCase(), p]));
const mailboxes = new Set<string>([...personByEmail.keys(), ...world.meta.shared_mailboxes.map((e) => e.toLowerCase())]);
const catchAllDomains = new Set(world.companies.filter((c) => c.catch_all).map((c) => c.domain));
const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;

/** Meridian through the Research card, its cases, and the Outreach card (approved, not yet run). */
async function toOutreach(db: Db) {
  await seedIcp(db);
  const id = (await createEvent(db, "Maya Ortiz", { name: "Meridian", starts_on: "2027-03-30", seat_count: 60, seat_price_cents: 100, country: "Spain", flow: "two_card" })).id;
  const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
  await decideApproval(db, { approvalId: await pending(), actor: "Dan Whitlock", decision: "approve" });
  await ingestUpload(db, id, "Maya Ortiz", "large.csv", csv);
  await requestResearchCard(db, id, "Maya Ortiz", exampleDns);
  await decideApproval(db, { approvalId: await pending(), actor: "Maya Ortiz", decision: "approve" });
  const deps = simDeps(world);
  await db.query("UPDATE event_settings SET settings = jsonb_set(settings, '{add_prospects}', 'true') WHERE event_id = $1", [id]);
  await processEvent(db, id, deps);
  for (const k of await listCases(db, id)) if (!k.decision) await answerCase(db, id, k.id, "Dan Whitlock", k.suggested ?? (k.options[0] as { value: string }).value);
  await processEvent(db, id, deps);
  await requestOutreachCard(db, id, "Maya Ortiz");
  const [card] = await db.query<{ lines: Record<string, number>; step_caps: Record<string, { credits?: number; llm?: number }> }>("SELECT lines, step_caps FROM cost_cards WHERE event_id = $1 AND kind = 'outreach'", [id]);
  await decideApproval(db, { approvalId: await pending(), actor: "Maya Ortiz", decision: "approve" });
  return { id, deps, card };
}

let db: Db, id: string, card: Awaited<ReturnType<typeof toOutreach>>["card"];
let kept: { source: string; email: string; full_name: string; domain: string; company_id: string }[];
let drops: Record<string, number>, used: Record<string, number>, people: number;
const calls: Record<string, number> = {};

beforeAll(async () => {
  db = await freshDb();
  const o = await toOutreach(db);
  id = o.id; card = o.card;
  await processEvent(db, id, o.deps);
  used = Object.fromEntries((await spendByStep(db, id)).filter((s) => s.kind === "outreach").map((s) => [`${s.step}/${s.unit}`, s.n]));
  kept = await db.query(`SELECT k.source, k.email, k.full_name, co.primary_domain AS domain, k.company_id FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.event_id = $1 AND k.dropped_at IS NULL AND k.email IS NOT NULL AND k.priority IS NOT NULL`, [id]);
  drops = Object.fromEntries((await db.query<{ drop_reason: string; n: number }>("SELECT drop_reason, count(*)::int AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NOT NULL GROUP BY 1", [id])).map((r) => [r.drop_reason, r.n]));
  people = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND priority IS NOT NULL AND source IN ('attendee', 'prospect') AND drop_reason IS DISTINCT FROM 'low_tier'", [id]))[0].n;
  if (false) console.log(await db.query("SELECT stage FROM events WHERE id=$1", [id]), await db.query("SELECT source, priority, (verify_1 IS NULL) AS nov, (email_loop::text = '{}') AS noloop, count(*)::int n FROM contacts WHERE event_id=$1 AND dropped_at IS NULL AND email IS NOT NULL GROUP BY 1,2,3,4", [id]), await db.query("SELECT kind,status,count(*)::int n FROM jobs WHERE event_id=$1 GROUP BY 1,2", [id]));
}, 300_000);

describe("the email loop against the world (authored rates)", () => {
  it("delivers addresses that are real mailboxes of the right person, almost always", () => {
    const real = kept.filter((k) => mailboxes.has(k.email.toLowerCase()));
    const named = kept.filter((k) => k.full_name);
    const rightPerson = named.filter((k) => { const p = personByEmail.get(k.email.toLowerCase()); return p && nameKey(p.full_name) === nameKey(k.full_name); });
    const wrong = named.filter((k) => { const p = personByEmail.get(k.email.toLowerCase()); return p && nameKey(p.full_name) !== nameKey(k.full_name); });
    // eslint-disable-next-line no-console
    console.log(`EMAIL (authored rates): ${kept.length} people kept with an address, of ${people} who reached the loop (${pct(kept.length, people)}). Real mailbox ${pct(real.length, kept.length)}. Belongs to the named person ${pct(rightPerson.length, named.length)} of ${named.length} named. Belongs to someone else (wrong person) ${wrong.length} (${pct(wrong.length, named.length)}). Drops: ${JSON.stringify(drops)}.`);
    expect(kept.length).toBeGreaterThan(300);
    expect(real.length / kept.length).toBeGreaterThanOrEqual(0.95);
    expect(wrong.length / named.length).toBeLessThanOrEqual(0.03);
    expect(rightPerson.length / named.length).toBeGreaterThanOrEqual(0.9);
  });

  it("reports catch-all domains as a gap, and lets almost nobody at one through", async () => {
    const atCatchAll = kept.filter((k) => catchAllDomains.has(k.domain));
    const stopped = drops.catch_all_unconfirmed ?? 0;
    // A domain that is not catch-all but whose probe read as deliverable (a false positive of the first verifier) is stopped too: those people are lost for nothing.
    const falseStops = (await db.query<{ d: string }>("SELECT co.primary_domain AS d FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.event_id = $1 AND k.drop_reason = 'catch_all_unconfirmed'", [id])).filter((r) => !catchAllDomains.has(r.d)).length;
    // eslint-disable-next-line no-console
    console.log(`CATCH-ALL: ${catchAllDomains.size} of ${world.companies.length} world companies accept every address. ${stopped} people were reported catch_all_unconfirmed (nobody was revealed or looked up for them). ${atCatchAll.length} people were delivered at a catch-all domain (ZeroBounce's authored miss rate, 8%). ${falseStops} of the ${stopped} stops were at domains that are NOT catch-all (the probe's false positive, ZeroBounce's 4%).`);
    expect(falseStops / Math.max(1, stopped)).toBeLessThanOrEqual(0.2);
    expect(stopped).toBeGreaterThan(50);
    expect(atCatchAll.length / Math.max(1, atCatchAll.length + stopped)).toBeLessThanOrEqual(0.2);
  });

  it("spends only inside the Outreach card, and a probe is one call per domain", async () => {
    const report = Object.entries(card.step_caps).filter(([, c]) => c.credits !== undefined || c.llm !== undefined).map(([step, c]) => { const unit = c.llm !== undefined ? "llm" : "credits"; return `${step} ${used[`${step}/${unit}`] ?? 0}/${c[unit as "llm" | "credits"]}`; });
    // eslint-disable-next-line no-console
    console.log(`OUTREACH CARD (authored): ${report.join("; ")}. Worst case on the card: ${card.lines.reveal_credits} reveal + ${card.lines.finder_credits} finder + ${card.lines.waterfall_credits} waterfall + ${card.lines.verifier_credits} verifier + ${card.lines.probe_credits} probe + ${card.lines.linkedin_credits} LinkedIn credits.`);
    for (const [step, c] of Object.entries(card.step_caps)) for (const unit of ["credits", "llm"] as const) if (c[unit] !== undefined) expect(used[`${step}/${unit}`] ?? 0, `${step}/${unit}`).toBeLessThanOrEqual(c[unit]!);
    const probed = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM enrichment_attempts WHERE event_id = $1 AND step = 'catch_all_probe'", [id]))[0].n;
    const domains = (await db.query<{ n: number }>("SELECT count(DISTINCT co.primary_domain)::int AS n FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.event_id = $1", [id]))[0].n;
    expect(probed).toBeLessThanOrEqual(domains);
    expect(used["catch_all_probe/credits"] ?? 0).toBe(probed);
    // The loop spends well under its worst case on this world.
    const total = (used["reveal/credits"] ?? 0) + (used["find/credits"] ?? 0) + (used["waterfall/credits"] ?? 0) + (used["verify/credits"] ?? 0) + (used["catch_all_probe/credits"] ?? 0) + (used["linkedin/credits"] ?? 0);
    const cap = card.lines.reveal_credits + card.lines.finder_credits + card.lines.waterfall_credits + card.lines.verifier_credits + card.lines.probe_credits + card.lines.linkedin_credits;
    expect(total / cap).toBeLessThanOrEqual(0.5);
  });

  it("drops a discovered person who has moved, before any verifier is paid", async () => {
    const employment = drops.employment_unconfirmed ?? 0;
    // eslint-disable-next-line no-console
    console.log(`EMPLOYMENT: ${employment} people dropped as employment_unconfirmed (the reveal named another employer).`);
    expect(employment).toBeGreaterThan(0);
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND drop_reason = 'employment_unconfirmed' AND verify_1 IS NOT NULL", [id]);
    expect(n).toBe(0);
  });

  it("never reveals or verifies anyone at priority C; a found address needs both checks, and an attendee's stays on one", async () => {
    // A priority C person is dropped before the loop: no verifier ever saw their address, and none was revealed or found.
    expect((await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND priority = 'C' AND (verify_1 IS NOT NULL OR email_source IS NOT NULL OR vendor_person_id IS NOT NULL)", [id])).length).toBe(0);
    expect((await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND email IS NOT NULL AND priority IS NOT NULL AND verify_1 IS DISTINCT FROM 'deliverable'", [id])).length).toBe(0);
    expect((await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND email IS NOT NULL AND priority IS NOT NULL AND source = 'prospect' AND verify_2 IS DISTINCT FROM 'deliverable'", [id])).length).toBe(0);
    const [{ twice, once }] = await db.query<{ twice: number; once: number }>("SELECT count(*) FILTER (WHERE verify_2 = 'deliverable')::int AS twice, count(*) FILTER (WHERE verify_2 IS NULL)::int AS once FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND email IS NOT NULL AND priority IS NOT NULL", [id]);
    // eslint-disable-next-line no-console
    console.log(`EMAIL STATUS (authored): verified twice ${twice}, verified once ${once}.`);
    expect(drops.low_tier ?? 0).toBeGreaterThan(0);
  });
});

describe("under vendor failure (authored)", () => {
  it("pauses when the verifiers are down, drops nobody for it, and finishes after a resume", async () => {
    const d2 = await freshDb();
    const o = await toOutreach(d2);
    let down = true;
    const base = o.deps;
    const failing: Deps = { ...base, vendorsFor: (s) => { const v = base.vendorsFor(s); return { ...v, verifiers: v.verifiers.map((x) => ({ ...x, verify: async (e: string) => { if (down) throw new VendorError(0); return x.verify(e); } })) }; } };
    await processEvent(d2, o.id, failing);
    const stage = (await d2.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [o.id]))[0].stage;
    const dropped = Object.fromEntries((await d2.query<{ drop_reason: string; n: number }>("SELECT drop_reason, count(*)::int AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NOT NULL AND drop_reason IN ('vendor_error', 'email_unconfirmed', 'not_deliverable') GROUP BY 1", [o.id])).map((r) => [r.drop_reason, r.n]));
    const [{ n: paidVerify }] = await d2.query<{ n: number }>("SELECT count(*)::int AS n FROM credit_ledger WHERE event_id = $1 AND step = 'verify' AND kind = 'settle' AND amount > 0", [o.id]);
    // eslint-disable-next-line no-console
    console.log(`OUTAGE: ZeroBounce failing every call. Event stage ${stage}. Dropped for it: ${JSON.stringify(dropped)}. Verifier credits charged: ${paidVerify}.`);
    expect(stage).toBe("paused");
    expect(Object.values(dropped).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2);
    expect(paidVerify).toBe(0);
    down = false;
    await moveEvent(d2, o.id, "finding_people", "Maya Ortiz", { detail: "Resumed" });
    await processEvent(d2, o.id, failing);
    expect((await d2.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [o.id]))[0].stage).toBe("delivered");
    const kept2 = (await d2.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND email IS NOT NULL", [o.id]))[0].n;
    expect(kept2 / kept.length).toBeGreaterThan(0.85);
    await d2.close();
  }, 300_000);
});
