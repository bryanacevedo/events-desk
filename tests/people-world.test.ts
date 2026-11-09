/* People search, title parsing, tiers, ranking and quotas, measured against the simulated world (samples/world.json, samples/world-titles.json).

   SIMULATED RESULTS ARE AUTHORED. The world knows every title's tier (the generator author's judgment) and, from samples/world-titles.json, its function and
   seniority (hand labels written without reading the parser). The simulated people search misses, lists someone who has left, hides last names and
   dates records at the rates in SIM_RATES.people; the simulated model misreads titles at stated rates. None of that is measured. These numbers show the code
   copes with those failures and stays inside the card; they say nothing about Apollo or a real model. The floors stop a change from making this worse. */

import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { demoIcp } from "../src/evals/company-tier.ts";
import { decideApproval } from "../src/server/approvals.ts";
import { answerCase, listCases } from "../src/server/cases.ts";
import type { Db } from "../src/server/db.ts";
import { createEvent } from "../src/server/events.ts";
import { exampleDns } from "../src/server/identity.ts";
import { spendByStep } from "../src/server/ledger.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { requestOutreachCard, requestResearchCard } from "../src/server/research.ts";
import { seedIcp } from "../src/server/seed.ts";
import { loadWorldTitles, SIM_RATES, simDeps, simLlm } from "../src/server/sim-vendors.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { priority } from "../src/shared/tiers.ts";
import { parseTitle, personaTier, validTitleParse } from "../src/shared/titles.ts";
import type { World } from "../src/shared/world.ts";
import { freshDb } from "./helpers.ts";

const csv = readFileSync("samples/attendees-large.csv", "utf8");
const world = JSON.parse(readFileSync("samples/world.json", "utf8")) as World;
const icp = demoIcp();
const truthTier = new Map<string, number>();
for (const c of world.companies) if (!c.parent_id && !truthTier.has(c.domain)) truthTier.set(c.domain, c.tier);
const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;

let db: Db, id: string;
let card: { lines: Record<string, number>; step_caps: Record<string, { credits?: number; llm?: number }>; credits_cap: number; llm_cap: number };
let used: Record<string, number>;
interface Contact { source: string; title: string | null; priority: string | null; drop_reason: string | null; domain: string | null; company: string; tier: number | null; company_id: string }
let contacts: Contact[], attempts: string[];
const calls = { parse: 0 };

beforeAll(async () => {
  db = await freshDb();
  await seedIcp(db);
  id = (await createEvent(db, "Maya Ortiz", { name: "Meridian", starts_on: "2027-03-30", seat_count: 60, seat_price_cents: 100, country: "Spain", flow: "two_card" })).id;
  const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
  await decideApproval(db, { approvalId: await pending(), actor: "Dan Whitlock", decision: "approve" });
  await ingestUpload(db, id, "Maya Ortiz", "large.csv", csv);
  await requestResearchCard(db, id, "Maya Ortiz", exampleDns);
  await decideApproval(db, { approvalId: await pending(), actor: "Maya Ortiz", decision: "approve" });
  const deps = simDeps(world);
  // Prospects on, so the search covers every attending company as well as the company-only rows.
  await db.query("UPDATE event_settings SET settings = jsonb_set(settings, '{add_prospects}', 'true') WHERE event_id = $1", [id]);
  await processEvent(db, id, deps);
  for (const k of await listCases(db, id)) if (!k.decision) await answerCase(db, id, k.id, "Dan Whitlock", k.suggested ?? (k.options[0] as { value: string }).value);
  await processEvent(db, id, deps);
  await requestOutreachCard(db, id, "Maya Ortiz");
  [card] = await db.query<typeof card>("SELECT lines, step_caps, credits_cap, llm_cap FROM cost_cards WHERE event_id = $1 AND kind = 'outreach'", [id]);
  await decideApproval(db, { approvalId: await pending(), actor: "Maya Ortiz", decision: "approve" });
  await processEvent(db, id, deps);
  used = Object.fromEntries((await spendByStep(db, id)).filter((s) => s.kind === "outreach").map((s) => [`${s.step}/${s.unit}`, s.n]));
  contacts = await db.query<Contact>(
    `SELECT c.source, c.title, c.priority, c.drop_reason, co.primary_domain AS domain, co.name AS company, co.tier, c.company_id FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.event_id = $1`, [id]);
  attempts = (await db.query<{ result: string }>("SELECT result FROM enrichment_attempts WHERE event_id = $1 AND step = 'people_search'", [id])).map((r) => r.result);
  calls.parse = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM llm_calls WHERE event_id = $1 AND step = 'title_parse'", [id]))[0].n;
}, 240_000);

describe("title tier against the world (authored rates)", () => {
  it("reads titles: tier, function and seniority against the world's labels, with the rules first and the simulated model for the rest", async () => {
    const labels = loadWorldTitles();
    const llm = simLlm(world);
    let n = 0, tier = 0, fn = 0, sen = 0, byRules = 0, promoted = 0, promotedFrom3 = 0;
    for (const [title, wTier] of Object.entries(world.titles)) {
      let p = parseTitle(title);
      if (p.placed || p.non_buyer) byRules++;
      else {
        const { text } = await llm.complete("title_parse", `INPUT\nTitle: ${title}`);
        const v = validTitleParse(JSON.parse(text));
        if (v) p = { function: v.function, seniority: v.seniority, non_buyer: v.non_buyer, former: false, placed: true };
      }
      const t = personaTier(p, icp.personas);
      n++;
      if (t === wTier) tier++;
      if (p.function === labels[title].function || (labels[title].non_buyer && p.non_buyer)) fn++;
      if (p.seniority === labels[title].seniority) sen++;
      if (t === 1 && wTier !== 1) promoted++;
      if (t === 1 && wTier === 3) promotedFrom3++;
    }
    // eslint-disable-next-line no-console
    console.log(`TITLES (authored rates): ${n} distinct world titles. tier right ${tier} (${pct(tier, n)}), function right ${fn} (${pct(fn, n)}), seniority right ${sen} (${pct(sen, n)}). Placed by rules in code: ${byRules} (${pct(byRules, n)}); the rest went to the simulated model. Given tier 1 though the world says otherwise: ${promoted}, of which the world says tier 3: ${promotedFrom3}.`);
    expect(n).toBe(327);
    expect(byRules / n).toBeGreaterThanOrEqual(0.9);
    expect(tier / n).toBeGreaterThanOrEqual(0.82);
    expect(fn / n).toBeGreaterThanOrEqual(0.9);
    expect(promotedFrom3 / n).toBeLessThanOrEqual(0.03);
  });
});

describe("people search, ranking and quotas on Meridian (authored rates)", () => {
  const prospects = () => contacts.filter((c) => c.source === "prospect");
  it("keeps prospects within the quota for every company, and never cuts an attendee by it", () => {
    const by = new Map<string, number>();
    for (const c of prospects()) by.set(c.company_id, (by.get(c.company_id) ?? 0) + 1);
    const over = [...by].filter(([cid, n]) => n > (contacts.find((c) => c.company_id === cid)!.tier === 1 ? 5 : 3));
    const attendeeDrops = contacts.filter((c) => c.source === "attendee" && c.drop_reason && !["low_tier", "duplicate", "excluded_company", "existing_customer", "tiering_failed", "rejected_in_review", "no_company", "company_not_found", "budget_cap", "no_email_found", "not_deliverable", "email_unconfirmed", "catch_all_unconfirmed", "vendor_error", "employment_unconfirmed", "crm_unsubscribed", "crm_do_not_contact"].includes(c.drop_reason));
    const sizes = [...by.values()];
    // eslint-disable-next-line no-console
    console.log(`PEOPLE: ${prospects().length} prospects at ${by.size} companies (${(sizes.reduce((a, b) => a + b, 0) / Math.max(1, by.size)).toFixed(2)} per searched company, ${sizes.filter((n) => n >= 5).length} at the cap of 5). Companies over quota ${over.length}. Attendees dropped for any reason a quota could cause: ${attendeeDrops.length}. Search results: ${attempts.length} searches.`);
    expect(prospects().length).toBeGreaterThan(250);
    expect(over).toEqual([]);
    expect(attendeeDrops).toEqual([]);
    expect(by.size).toBeGreaterThan(100);
  });
  it("stops C before anything is paid: no prospect is priority C, and every stored prospect is A or B", () => {
    expect(prospects().filter((c) => c.priority === "C" || c.priority === null).length).toBe(0);
    const search = attempts.join("\n");
    const stopped = [...search.matchAll(/(\d+) stopped at C/g)].reduce((a, m) => a + Number(m[1]), 0);
    // eslint-disable-next-line no-console
    console.log(`C STOPS HERE: ${stopped} found people were priority C and never stored, so never looked up or verified. People with a hidden last name found (ranked like anyone else, revealed only if kept): ${[...search.matchAll(/(\d+) with a hidden last name/g)].reduce((a, m) => a + Number(m[1]), 0)}.`);
    expect(stopped).toBeGreaterThan(100);
  });
  it("does not wrongly promote people to priority A", () => {
    const withP = contacts.filter((c) => c.priority && c.domain && truthTier.has(c.domain) && c.title && world.titles[c.title.toLowerCase()] !== undefined);
    const a = withP.filter((c) => c.priority === "A");
    const wrongA = a.filter((c) => priority(truthTier.get(c.domain!) as 1 | 2 | 3, world.titles[c.title!.toLowerCase()] as 1 | 2 | 3) !== "A");
    const trueA = withP.filter((c) => priority(truthTier.get(c.domain!) as 1 | 2 | 3, world.titles[c.title!.toLowerCase()] as 1 | 2 | 3) === "A").length;
    const wrongFromC = a.filter((c) => priority(truthTier.get(c.domain!) as 1 | 2 | 3, world.titles[c.title!.toLowerCase()] as 1 | 2 | 3) === "C");
    if (process.env.DBG_A) console.log(wrongA.map((c) => `${c.title} | co tier ${c.tier} truth ${truthTier.get(c.domain!)} | world title ${world.titles[c.title!.toLowerCase()]}`));
    // eslint-disable-next-line no-console
    console.log(`PRIORITY A: ${a.length} people given A (${trueA} are A in the world). Wrongly A: ${wrongA.length} (${pct(wrongA.length, a.length)}), of which the world says C: ${wrongFromC.length}. Where the world says C: inflated chief titles (\"Chief Vibes Officer\", read as c_level, which the persona rule makes tier 1) and the world's own quirk that \"founder\" is tier 3 (a self-employed founder shares the string). The rest are companies the pipeline put in tier 1 that the world puts in tier 2.`);
    expect(a.length).toBeGreaterThan(50);
    // Floors with room above what the authored rates give: a change that made promotion worse would cross them.
    expect(wrongFromC.length / a.length).toBeLessThanOrEqual(0.12);
    // 0.25 since the second look was cut (decision 24). The old 0.2 rested on a catch rate the simulator invented; the real recording caught nothing. The world-says-C floor above did not move.
    expect(wrongA.length / a.length).toBeLessThanOrEqual(0.25);
  });
  it("reads most titles with rules in code, so the model is a small cost, and stays inside the Outreach card", () => {
    const caps = card.step_caps;
    const report = Object.entries(caps).map(([step, c]) => { const unit = c.llm !== undefined ? "llm" : "credits"; return `${step} ${used[`${step}/${unit}`] ?? 0}/${c[unit as "llm" | "credits"]}`; });
    // eslint-disable-next-line no-console
    console.log(`OUTREACH CARD (authored): ${report.join("; ")}. title_parse model calls ${calls.parse} (the card prices ${card.lines.title_llm}: every discovered person's title as if it needed the model). The people search charged nothing: discovery credits on the card ${card.lines.discovery_credits}, spent ${used["discovery/credits"] ?? 0}.`);
    for (const [step, c] of Object.entries(caps)) for (const unit of ["credits", "llm"] as const) if (c[unit] !== undefined) expect(used[`${step}/${unit}`] ?? 0, `${step}/${unit}`).toBeLessThanOrEqual(c[unit]!);
    expect(card.lines.discovery_credits).toBe(0);
    expect(used["discovery/credits"] ?? 0).toBe(0);
    expect(calls.parse).toBeLessThanOrEqual(card.lines.title_llm);
    expect(calls.parse).toBeLessThan(prospects().length * 0.25);
    expect(SIM_RATES.people.hidden_last_name).toBeGreaterThan(0);
  });
});
