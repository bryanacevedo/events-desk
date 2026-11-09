/* Company identity measured against the simulated world (samples/attendees-large.csv, samples/world.json).

   The world knows which company every name means. The simulated vendors misbehave at the rates in SIM_RATES.identity,
   which are AUTHORED, not measured: the vendor lacks 6% of companies, drops the right answer from 3% of searches,
   returns a person's current employer, and so on. So these numbers prove the code copes with those failures and
   say nothing about how real vendors perform. The floors below stop a change from making identity worse against
   this world; they are not claims about the real one. A harsher variant runs too, so the rules are not tuned to one
   set of rates.

   "Correct" is judged by the NAME: a company filed as "Rafenia Trading" is correct at the domain of Rafenia Trading,
   whoever its registrants really work for. Where the registrants really work is a person-level case after delivery. */

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { exampleDns, memoryReveals, resolveCompany, type Resolution } from "../src/server/identity.ts";
import { defaultSettings } from "../src/server/approvals.ts";
import { decideApproval } from "../src/server/approvals.ts";
import { answerCase, listCases } from "../src/server/cases.ts";
import { createEvent } from "../src/server/events.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { requestResearchCard } from "../src/server/research.ts";
import { spendByStep } from "../src/server/ledger.ts";
import { SIM_RATES, simDeps, simVendors } from "../src/server/sim-vendors.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { fakeClock, UNLIMITED, VendorDown, VendorHealth } from "../src/server/vendor-health.ts";
import { companyKey, mapColumns, normalize, parseCsv, type Ingested } from "../src/shared/ingest.ts";
import type { World } from "../src/shared/world.ts";
import { freshDb } from "./helpers.ts";

const csv = readFileSync("samples/attendees-large.csv", "utf8");
const world = JSON.parse(readFileSync("samples/world.json", "utf8")) as World;
const parsed = parseCsv(csv);
const mapped = mapColumns(parsed);
const ingested: Ingested = normalize(parsed, mapped.map, mapped.extras);
const byId = new Map(world.companies.map((c) => [c.id, c]));
const nameTruth = new Map<string, string>();
for (const c of world.companies) for (const n of [c.name, ...c.aliases]) if (!nameTruth.has(companyKey(n))) nameTruth.set(companyKey(n), c.id);
const truthDomain = (key: string) => { const id = nameTruth.get(key); return id ? byId.get(id)!.domain : null; };
const settings = defaultSettings();

interface Run { n: number; correct: number; wrong: number; ambiguous: number; notFound: number; paidMatches: number; reused: number; results: Map<string, Resolution>; waited: number; probes: number }

/** Resolves every company that survived Layer 0, the way stage 4 does, against the simulated vendors. */
async function runWorld(opts: { throttle?: { every: number; length_ms: number }; rates?: Partial<Record<string, number>> } = {}): Promise<Run> {
  const saved = { ...SIM_RATES.identity } as Record<string, unknown>;
  Object.assign(SIM_RATES.identity as Record<string, unknown>, opts.rates ?? {});
  try {
    const clock = fakeClock();
    const identity = simVendors(world, settings, { clock, throttle: opts.throttle }).identity!;
    const health = new VendorHealth({ clock, config: UNLIMITED });
    const reveals = memoryReveals();
    const run: Run = { n: 0, correct: 0, wrong: 0, ambiguous: 0, notFound: 0, paidMatches: 0, reused: 0, results: new Map(), waited: 0, probes: 0 };
    const env = { health, identity, country: "Spain", reveals, pay: async (go: () => Promise<{ value: never; charged: number }>) => { run.paidMatches++; const o = await go(); return { kind: "ok" as const, value: o.value }; } };
    for (const co of ingested.companies) {
      const people = ingested.contacts.filter((c) => c.company_key === co.key && !c.drop_reason && c.full_name).map((c) => ({ full_name: c.full_name!, title: c.title }));
      let r: Resolution;
      for (;;) {
        try { r = await resolveCompany(env as never, { key: co.key, name: co.name, evidence: co.evidence, people }); break; }
        catch (e) { if (!(e instanceof VendorDown)) throw e; run.waited++; await clock.sleep(e.retry_after_ms); }
      }
      if (r.person_match === "reused") run.reused++;
      run.results.set(co.key, r);
      const td = truthDomain(co.key);
      run.n++;
      if (r.state === "resolved") (r.domain === td ? run.correct++ : run.wrong++);
      else if (r.state === "ambiguous") run.ambiguous++;
      else run.notFound++;
    }
    run.probes = health.guard(identity.companySearch.name).stats.probes;
    return run;
  } finally { Object.assign(SIM_RATES.identity as Record<string, unknown>, saved); }
}

/** Groups resolved keys by domain, as the merge does, and judges each group by the domains the names really mean. */
function mergeStats(results: Map<string, Resolution>) {
  const groups = new Map<string, string[]>();
  for (const [k, r] of results) if (r.state === "resolved") groups.set(r.domain!, [...(groups.get(r.domain!) ?? []), k]);
  let falseMerges = 0, trueMerges = 0;
  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    const truths = new Set(keys.map(truthDomain));
    if (truths.size > 1) falseMerges++; else trueMerges++;
  }
  const trueDomains = new Set([...results.keys()].map(truthDomain).filter(Boolean));
  const trueCompanies = new Set([...results.keys()].map((k) => nameTruth.get(k)).filter(Boolean));
  return { companiesAfterMerge: groups.size, falseMerges, trueMerges, trueDomains: trueDomains.size, trueCompanies: trueCompanies.size };
}

const pct = (n: number, of: number) => `${((100 * n) / of).toFixed(1)}%`;
let base: Run;
beforeAll(async () => { base = await runWorld(); }, 60_000);

describe("identity against the world (authored vendor rates)", () => {
  it("has the 500 raw keys and 420 true companies the design talks about", () => {
    const raw = new Set<string>();
    const H = Object.fromEntries(parsed.headers.map((h, i) => [h, i]));
    for (const r of parsed.rows) { const v = (r[H["Company Name"]] ?? "").trim(); if (v) raw.add(companyKey(v)); }
    expect(raw.size).toBe(501);
    expect(ingested.companies.length).toBe(451);
    expect(world.companies.length).toBe(420);
    expect(new Set(world.companies.map((c) => c.domain)).size).toBe(406);
  });

  it("resolves the right domain for nearly every company, with almost no wrong domain accepted", () => {
    const m = mergeStats(base.results);
    // eslint-disable-next-line no-console
    console.log(`IDENTITY (authored rates): ${base.n} companies after Layer 0 (from 501 raw keys). correct ${base.correct} (${pct(base.correct, base.n)}), wrong domain accepted ${base.wrong} (${pct(base.wrong, base.n)}), ambiguous ${base.ambiguous}, not found ${base.notFound} (${pct(base.notFound, base.n)}). person matches paid ${base.paidMatches} (${base.paidMatches} credits), reused ${base.reused}. merged to ${m.companiesAfterMerge} companies (the names in this file mean ${m.trueCompanies} of the 420 true companies, on ${m.trueDomains} distinct domains, since 14 subsidiaries share a parent's domain); false merges ${m.falseMerges}, true merges ${m.trueMerges}.`);
    expect(base.n).toBe(451);
    expect(base.correct / base.n).toBeGreaterThanOrEqual(0.97);
    expect(base.wrong / base.n).toBeLessThanOrEqual(0.015);
    expect(base.notFound / base.n).toBeLessThanOrEqual(0.02);
    expect(base.ambiguous / base.n).toBeLessThanOrEqual(0.02);
  });

  it("spends little: a person match only where free evidence and search failed", () => {
    expect(base.paidMatches).toBeLessThanOrEqual(15);
    // Free file evidence does most of the work; search does the rest.
    const via: Record<string, number> = {};
    for (const r of base.results.values()) via[r.via ?? r.state] = (via[r.via ?? r.state] ?? 0) + 1;
    expect(via.email_domain / base.n).toBeGreaterThan(0.5);
  });

  it("merges rows that resolve to one domain, with at most a couple of false merges", () => {
    const m = mergeStats(base.results);
    expect(m.falseMerges).toBeLessThanOrEqual(2);
    expect(m.trueMerges).toBeGreaterThanOrEqual(35);
    // 451 keys fold to about as many companies as there are true domains among them.
    expect(Math.abs(m.companiesAfterMerge - m.trueDomains)).toBeLessThanOrEqual(5);
    expect(m.companiesAfterMerge).toBeLessThan(base.n - 40);
  });

  it("holds up when the vendors are much worse than authored (a harsher variant, looser floors)", async () => {
    const harsh = await runWorld({ rates: { search_miss: 0.25, search_wrong_top: 0.10 } });
    const m = mergeStats(harsh.results);
    // eslint-disable-next-line no-console
    console.log(`IDENTITY (harsher rates, 25% missing and 10% wrong top): correct ${harsh.correct} (${pct(harsh.correct, harsh.n)}), wrong ${harsh.wrong} (${pct(harsh.wrong, harsh.n)}), ambiguous ${harsh.ambiguous}, not found ${harsh.notFound} (${pct(harsh.notFound, harsh.n)}), person matches ${harsh.paidMatches}, false merges ${m.falseMerges}.`);
    expect(harsh.correct / harsh.n).toBeGreaterThanOrEqual(0.88);
    expect(harsh.wrong / harsh.n).toBeLessThanOrEqual(0.06);
    expect(m.falseMerges).toBeLessThanOrEqual(8);
  });

  it("silent throttling changes nothing: the probe catches it, the run waits, and no company is reported missing", async () => {
    const throttle = { every: 40, length_ms: 5_000 };
    const guarded = await runWorld({ throttle });
    expect(guarded.waited).toBeGreaterThan(3);
    expect(guarded.correct).toBe(base.correct);
    expect(guarded.wrong).toBe(base.wrong);
    expect(guarded.notFound).toBe(base.notFound);
    // What an unguarded caller would have said: every empty answer taken as "nobody found".
    const clock = fakeClock();
    const naive = simVendors(world, settings, { clock, throttle }).identity!;
    let falseMissing = 0;
    for (const co of ingested.companies) {
      const r = await naive.companySearch.search(co.name, {}).catch(() => ({ candidates: [] }));
      if (!r.candidates.length && nameTruth.has(co.key) && base.results.get(co.key)?.via?.startsWith("search")) falseMissing++;
    }
    // eslint-disable-next-line no-console
    console.log(`THROTTLING: with the probe, ${guarded.waited} waits and 0 extra not-found. Without it, ${falseMissing} companies that search finds would have been reported missing.`);
    expect(falseMissing).toBeGreaterThan(10);
  });
});

describe("identity through the pipeline on the large list", () => {
  it("stays inside the Research card's caps, opens cases for what a person must settle, and the merged companies tier", async () => {
    const db = await freshDb();
    const id = (await createEvent(db, "Maya Ortiz", { name: "Meridian", starts_on: "2027-03-30", seat_count: 60, seat_price_cents: 100, country: "Spain", flow: "two_card" })).id;
    const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
    await decideApproval(db, { approvalId: await pending(), actor: "Dan Whitlock", decision: "approve" });
    await ingestUpload(db, id, "Maya Ortiz", "large.csv", csv);
    await requestResearchCard(db, id, "Maya Ortiz", exampleDns);
    const [card] = await db.query<{ lines: Record<string, number>; step_caps: Record<string, { credits?: number }> }>("SELECT lines, step_caps FROM cost_cards WHERE event_id = $1", [id]);
    await decideApproval(db, { approvalId: await pending(), actor: "Maya Ortiz", decision: "approve" });
    const deps = simDeps(world);
    await processEvent(db, id, deps);
    const spent = Object.fromEntries((await spendByStep(db, id)).filter((s) => s.unit === "credits").map((s) => [s.step, s.n]));
    // eslint-disable-next-line no-console
    console.log(`PIPELINE: the Research card priced ${card.lines.person_match_credits} credits of person match for ${card.lines.person_match_companies} companies and ${card.lines.reverse_lookup_credits} of reverse lookups; spent ${spent.person_match ?? 0} and ${spent.reverse_lookup ?? 0}.`);
    expect(spent.person_match ?? 0).toBeLessThanOrEqual(card.step_caps.person_match.credits!);
    expect(spent.reverse_lookup ?? 0).toBeLessThanOrEqual(card.step_caps.reverse_lookup.credits!);
    // The card priced a person match only for companies the file's own evidence did not settle and that have a named person.
    expect(card.lines.person_match_companies).toBeLessThan(card.lines.companies * 0.5);
    expect(card.lines.unresolved_companies).toBeLessThan(card.lines.companies);
    // After the merge, the companies are the domains.
    const cos = await db.query<{ primary_domain: string | null; identity_state: string; tier: number | null; in_research: boolean }>("SELECT primary_domain, identity_state, tier, in_research FROM companies WHERE event_id = $1", [id]);
    const live = cos.filter((c) => c.primary_domain);
    expect(new Set(live.map((c) => c.primary_domain)).size).toBe(live.length);
    // Every resolved company that is still in research was tiered, and the rest are waiting on a case.
    const open = (await listCases(db, id)).filter((c) => !c.decision);
    expect(cos.filter((c) => c.in_research && c.identity_state === "resolved" && c.tier === null).length).toBeLessThanOrEqual(open.length);
    for (const k of open) await answerCase(db, id, k.id, "Dan Whitlock", k.suggested ?? (k.options[0] as { value: string }).value);
    await processEvent(db, id, deps);
    const after = await db.query<{ tier: number | null; identity_state: string; in_research: boolean }>("SELECT tier, identity_state, in_research FROM companies WHERE event_id = $1", [id]);
    expect(after.filter((c) => c.in_research && c.tier === null).length).toBe(0);
    // Domain correctness as it stands in the database.
    const rows = await db.query<{ key: string; primary_domain: string }>("SELECT key, primary_domain FROM companies WHERE event_id = $1 AND primary_domain IS NOT NULL AND identity_state = 'resolved'", [id]);
    const wrong = rows.filter((r) => { const t = truthDomain(r.key); return t && t !== r.primary_domain; });
    expect(wrong.length / rows.length).toBeLessThanOrEqual(0.02);
    await db.close();
  }, 120_000);
});
