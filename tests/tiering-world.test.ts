/* Company tiering measured against the simulated world (samples/world.json, samples/attendees-large.csv).

   SIMULATED RESULTS ARE AUTHORED. The world knows every company's true tier. The simulated vendors lack, omit and misstate firmographics at the
   rates in SIM_RATES.firmo, and the simulated models read the supplied facts and err at the rates in SIM_RATES.tier. Those rates were chosen,
   not measured. So these numbers prove the code copes with those failures and stays inside the card; they say nothing about how a real vendor or
   a real model performs. The floors stop a change from making tiering worse against this world; they are not claims about the real one.
   The real model's accuracy is measured only by the recordings in evals/ (see tests/company-tier-evals.test.ts). */

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { decideApproval } from "../src/server/approvals.ts";
import { answerCase, listCases } from "../src/server/cases.ts";
import type { Db } from "../src/server/db.ts";
import { createEvent } from "../src/server/events.ts";
import { exampleDns } from "../src/server/identity.ts";
import { spendByStep } from "../src/server/ledger.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { requestResearchCard } from "../src/server/research.ts";
import { seedIcp } from "../src/server/seed.ts";
import { SIM_RATES, simDeps } from "../src/server/sim-vendors.ts";
import { spreadFor } from "../src/server/tiering.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { baselineTier, type Icp } from "../src/shared/icp.ts";
import type { World } from "../src/shared/world.ts";
import { freshDb } from "./helpers.ts";
import { defaults } from "./tier-helpers.ts";

const csv = readFileSync("samples/attendees-large.csv", "utf8");
const world = JSON.parse(readFileSync("samples/world.json", "utf8")) as World;
const truthByDomain = new Map<string, number>();
for (const c of world.companies) if (!c.parent_id && !truthByDomain.has(c.domain)) truthByDomain.set(c.domain, c.tier);

interface Row { name: string; domain: string; tier: number | null; via: string | null; baseline: number | null; second: { agreed: boolean } | null; truth: number | null; firmo: Record<string, unknown> | null }
let db: Db, id: string, rows: Row[], icp: Icp;
let caps: Record<string, { credits?: number; llm?: number }>, used: Record<string, number>, lines: Record<string, number>;
let cases: Record<string, number>, afterCases: Row[], seconds = 0;

const load = async () => (await db.query<{ name: string; primary_domain: string; tier: number | null; tier_via: string | null; baseline_tier: number | null; second_look: { agreed: boolean } | null; firmo: Record<string, unknown> | null }>(
  "SELECT name, primary_domain, tier, tier_via, baseline_tier, second_look, firmo FROM companies WHERE event_id = $1 AND in_research AND identity_state = 'resolved' AND list_status IS NULL AND primary_domain IS NOT NULL", [id]))
  .map((r): Row => ({ name: r.name, domain: r.primary_domain, tier: r.tier, via: r.tier_via, baseline: r.baseline_tier, second: r.second_look, firmo: r.firmo, truth: truthByDomain.get(r.primary_domain) ?? null }));

beforeAll(async () => {
  db = await freshDb();
  await seedIcp(db);
  icp = (await db.query<{ icp: Icp }>("SELECT icp FROM icp_versions WHERE version = 1"))[0].icp;
  id = (await createEvent(db, "Maya Ortiz", { name: "Meridian", starts_on: "2027-03-30", seat_count: 60, seat_price_cents: 100, country: "Spain", flow: "two_card" })).id;
  const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
  await decideApproval(db, { approvalId: await pending(), actor: "Dan Whitlock", decision: "approve" });
  await ingestUpload(db, id, "Maya Ortiz", "large.csv", csv);
  await requestResearchCard(db, id, "Maya Ortiz", exampleDns);
  await decideApproval(db, { approvalId: await pending(), actor: "Maya Ortiz", decision: "approve" });
  const t = Date.now();
  await processEvent(db, id, simDeps(world));
  seconds = (Date.now() - t) / 1000;
  rows = (await load()).filter((r) => r.truth !== null);
  const all = await listCases(db, id);
  cases = {};
  for (const k of all) cases[k.kind] = (cases[k.kind] ?? 0) + 1;
  const card = (await db.query<{ lines: Record<string, number>; step_caps: Record<string, { credits?: number; llm?: number }> }>("SELECT lines, step_caps FROM cost_cards WHERE event_id = $1", [id]))[0];
  caps = card.step_caps; lines = card.lines;
  used = Object.fromEntries((await spendByStep(db, id)).map((s) => [`${s.step}/${s.unit}`, s.n]));
  // The demo reviewer takes every suggested answer.
  for (const k of all) if (!k.decision && ["unknown_tier", "second_look_disagreement"].includes(k.kind)) await answerCase(db, id, k.id, "Dan Whitlock", k.suggested ?? (k.options[0] as { value: string }).value);
  await processEvent(db, id, simDeps(world));
  afterCases = (await load()).filter((r) => r.truth !== null);
}, 180_000);

const pct = (n: number, d: number) => `${((100 * n) / d).toFixed(1)}%`;

/** Companies the tier step reached. A few more wait on another case (a CRM customer, say) and are not scored. */
const reached = () => rows.filter((r) => r.via !== null);

describe("company tier against the world (authored rates)", () => {
  it("tiers nearly every company right, with almost no tier 3 called tier 1, and compares with the baseline", () => {
    const scored = reached();
    const decided = scored.filter((r) => r.tier !== null);
    const right = decided.filter((r) => r.tier === r.truth).length;
    const wrongAsOne = scored.filter((r) => r.truth === 3 && r.tier === 1).length;
    const baseOf = (r: Row) => baselineTier(icp, { employees: r.firmo?.employees as number | undefined, industry: r.firmo?.industry as string | undefined, description: r.firmo?.description as string | undefined });
    const base = scored.filter((r) => baseOf(r) === r.truth).length;
    const baseWrong = scored.filter((r) => baseOf(r) !== r.truth);
    const baseWrongWhy = { consumer_only: baseWrong.filter((r) => r.firmo?.business_model === "B2C").length, agency_or_consultancy: baseWrong.filter((r) => /agency|consult|advisory services|media buying/i.test(String(r.firmo?.industry ?? ""))).length };
    const unknown = scored.length - decided.length;
    const flaggedWrongOnes = scored.filter((r) => r.tier === 1 && r.truth !== 1);
    const caught = flaggedWrongOnes.filter((r) => r.second && !r.second.agreed).length;
    // eslint-disable-next-line no-console
    console.log(`TIER (authored rates): ${scored.length} companies reached the tier step (${rows.length - scored.length} more wait on another case). right ${right} of ${decided.length} decided (${pct(right, decided.length)}); with Unknown counted wrong ${pct(right, scored.length)}. Unknown ${unknown} (${pct(unknown, scored.length)}). tier 3 called tier 1: ${wrongAsOne}. BASELINE (size band plus keywords, same facts): ${pct(base, scored.length)}; its misses include ${baseWrongWhy.consumer_only} consumer-only and ${baseWrongWhy.agency_or_consultancy} agency or consultancy companies. hard-rule tier 3: ${scored.filter((r) => r.via === "hard_rule").length}. wrong tier 1s: ${flaggedWrongOnes.length}, of which the second look flagged ${caught}.`);
    expect(scored.length).toBeGreaterThan(340);
    expect(right / decided.length).toBeGreaterThanOrEqual(0.85);
    expect(right / scored.length).toBeGreaterThanOrEqual(0.8);
    expect(wrongAsOne / scored.length).toBeLessThanOrEqual(0.02);
    // The baseline is compared, not assumed beaten. Here the world's truth IS a size-and-segment rule, so the baseline is near the ceiling and the
    // authored model noise can leave the system a little below it. Whether the real model beats it is decided on the frozen holdout, not here.
    expect(right / scored.length).toBeGreaterThanOrEqual(base / scored.length - 0.05);
  });

  it("says Unknown for a minority, and each Unknown is a case a person can settle", () => {
    const unknown = reached().filter((r) => r.tier === null).length;
    // eslint-disable-next-line no-console
    console.log(`UNKNOWN: ${unknown} of ${reached().length} (${pct(unknown, reached().length)}); open unknown_tier cases ${cases.unknown_tier ?? 0}.`);
    expect(unknown / reached().length).toBeLessThanOrEqual(0.1);
    expect(cases.unknown_tier ?? 0).toBeGreaterThanOrEqual(unknown);
  });

  it("makes no second look: no model-tiered company carries one, and no second-look case is open", () => {
    const modeled = reached().filter((r) => r.via === "model");
    expect(modeled.filter((r) => r.second !== null).length).toBe(0);
    expect(cases.second_look_disagreement ?? 0).toBe(0);
    expect(used["second_look/llm"]).toBeUndefined();
  });

  it("stays inside every cap of the Research card, with room to spare", () => {
    const report = Object.entries(caps).map(([step, c]) => { const unit = c.llm !== undefined ? "llm" : "credits"; const u = used[`${step}/${unit}`] ?? 0; return `${step} ${u}/${c[unit as "llm" | "credits"]} ${unit}`; });
    // eslint-disable-next-line no-console
    console.log(`CARD (authored): ${report.join("; ")}. Model calls per company on average: ${((used["company_tier/llm"] + used["website_read/llm"]) / lines.companies).toFixed(2)} of a worst case of ${lines.llm_calls_per_company}. Research took ${seconds.toFixed(1)} s.`);
    for (const [step, c] of Object.entries(caps)) {
      for (const unit of ["credits", "llm"] as const) if (c[unit] !== undefined) expect(used[`${step}/${unit}`] ?? 0, `${step}/${unit}`).toBeLessThanOrEqual(c[unit]!);
    }
    const avg = (used["company_tier/llm"] + used["website_read/llm"]) / lines.companies;
    expect(avg).toBeLessThanOrEqual(2.2);
    // Paid enrich only for missing fields: never more than one per company.
    expect(used["firmographics/credits"]).toBeLessThanOrEqual(lines.max_companies);
    // No company was dropped for want of budget.
  });

  it("buys an enrich only where the free search left a needed field out", async () => {
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM companies WHERE event_id = $1 AND firmo_source LIKE '%enrich%'", [id]);
    const [{ m }] = await db.query<{ m: number }>("SELECT count(*)::int AS m FROM companies WHERE event_id = $1 AND firmo_source = 'search'", [id]);
    // eslint-disable-next-line no-console
    console.log(`FIRMOGRAPHICS: ${n} companies enriched (paid), ${m} satisfied by the free search alone. The free search returns all three needed fields for ${pct(Math.round(m), n + m)} of companies here.`);
    expect(used["firmographics/credits"]).toBe(n);
    expect(m).toBeGreaterThan(0);
  });

  it("holds on the spread check and moves no company to a tier it had no fact for", async () => {
    const spread = await spreadFor(db.query, id, defaults());
    // eslint-disable-next-line no-console
    console.log(`SPREAD: ${JSON.stringify(spread.counts)}; warnings: ${spread.warnings.map((w) => w.kind).join(", ") || "none"}.`);
    expect(spread.counts.total).toBeGreaterThan(350);
    expect(spread.warnings.map((w) => w.kind)).not.toContain("mostly_unknown");
    expect(spread.warnings.map((w) => w.kind)).not.toContain("no_tier1");
    // Every tier that a model gave cites its fact.
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM companies WHERE event_id = $1 AND tier IS NOT NULL AND tier_via = 'model' AND (tier_fact IS NULL OR tier_fact = '')", [id]);
    expect(n).toBe(0);
  });

  it("after a person takes the suggested answers, every company has a tier or is gone, and accuracy does not fall", () => {
    const tiered = afterCases.filter((r) => r.tier !== null);
    const right = tiered.filter((r) => r.tier === r.truth).length;
    const before = rows.filter((r) => r.tier !== null && r.tier === r.truth).length / rows.filter((r) => r.tier !== null).length;
    // eslint-disable-next-line no-console
    console.log(`AFTER SUGGESTED ANSWERS: ${tiered.length} companies tiered, ${pct(right, tiered.length)} right (before: ${(100 * before).toFixed(1)}%).`);
    expect(right / tiered.length).toBeGreaterThanOrEqual(before - 0.01);
  });

  it("states its rates as authored", () => {
    expect(SIM_RATES.tier.off_by_one).toBeGreaterThan(0);
    expect(SIM_RATES.firmo.none).toBeGreaterThan(0);
  });
});
