/* A small scripted world for the company-tier tests: vendors that return exactly the firmographics a test hands them and count what was asked,
   a model that reads the supplied facts the way the seller's rule does (or misbehaves on cue), and an event taken through the Research card. */

import { readFileSync } from "node:fs";
import type { Db } from "../src/server/db.ts";
import { decideApproval } from "../src/server/approvals.ts";
import { createEvent } from "../src/server/events.ts";
import { processEvent, type Deps } from "../src/server/pipeline.ts";
import { mockLlm, mockVendors, type Vendors, type FirmographicsLookup, type FoundPerson, type Llm, type PeopleQuery, type PeopleSearch, type Reveal, type WebsiteReader } from "../src/server/providers.ts";
import { requestResearchCard } from "../src/server/research.ts";
import { seedIcp } from "../src/server/seed.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import type { Settings } from "../src/shared/cost.ts";
import type { FirmoRecord } from "../src/shared/tiering.ts";

export const MAYA = "Maya Ortiz", DAN = "Dan Whitlock";
export const defaults = (): Settings => JSON.parse(readFileSync("config/defaults.json", "utf8"));

export interface Spec {
  /** What the free search returns. Default: employees and country only, as most vendors do. */
  search?: FirmoRecord | null;
  /** What the paid enrich returns. Default: nothing. */
  enrich?: FirmoRecord | null;
  /** The page the website reader returns. Default: none. */
  site?: string | null;
}
export interface Counts { search: Record<string, number>; enrich: Record<string, number>; site: Record<string, number> }

/** Firmographics and website seams for the domains in `specs`. Anything not listed returns nothing. */
export function scriptedVendors(specs: Record<string, Spec>) {
  const counts: Counts = { search: {}, enrich: {}, site: {} };
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
  const firmographics = (s: Settings, provides?: FirmographicsLookup["provides"]): FirmographicsLookup => ({
    name: "firmo_scripted", cost: s.research.firmographics_cost, provides,
    async search(domain) { bump(counts.search, domain); return { firmo: specs[domain]?.search ?? null, charged: 0 }; },
    async enrich(domain) { bump(counts.enrich, domain); return { firmo: specs[domain]?.enrich ?? null, charged: s.research.firmographics_cost }; },
  });
  const website: WebsiteReader = { name: "site_scripted", async read(domain) { bump(counts.site, domain); return specs[domain]?.site ?? null; } };
  return { counts, firmographics, website };
}

const STRONG = /software|saas|platform|payment|logistic|freight|fleet/;
/** Reads the supplied facts the way the seller's rule does, with no errors. Says unknown when the facts do not decide it. */
export function reader(): Llm {
  return {
    model: "reader",
    async complete(step, prompt) {
      const input = prompt.slice(prompt.lastIndexOf("INPUT") + 5);
      if (step === "website_read") return { text: JSON.stringify({ description: prompt.slice(prompt.lastIndexOf("<<<PAGE") + 7, prompt.lastIndexOf("PAGE>>>")).trim().slice(0, 300) }), input_tokens: 0, output_tokens: 0 };
      if (step !== "company_tier" && step !== "second_look") return mockLlm.complete(step, prompt);
      return { text: JSON.stringify(readFacts(input)), input_tokens: 0, output_tokens: 0 };
    },
  };
}
export function readFacts(input: string) {
  const lines = input.split("\n").map((l) => l.trim());
  const get = (p: string) => lines.find((l) => l.toLowerCase().startsWith(p));
  const emp = Number(get("employees:")?.match(/\d+/)?.[0] ?? NaN);
  const industry = (get("industry:") ?? "").toLowerCase();
  const sells = (get("sells to:") ?? "").toLowerCase();
  const text = `${industry} ${get("description:") ?? ""} ${get("from its own website:") ?? ""}`.toLowerCase();
  const unknown = { tier: "unknown", segment: null, company_type: null, reason: "insufficient_information", fact: null };
  if (/consumers only/.test(sells)) return { tier: 3, segment: null, company_type: null, reason: "outside_icp", fact: get("sells to:") };
  if (!industry.trim() && !lines.some((l) => /^(description|from its own website):/i.test(l))) return unknown;
  if (/agency|consult/.test(text)) return { tier: 3, segment: null, company_type: null, reason: "outside_icp", fact: get("industry:") ?? get("description:") ?? get("from its own website:") };
  if (!Number.isFinite(emp)) return unknown;
  const strong = STRONG.test(text), inRange = emp >= 200 && emp <= 5000;
  const tier = strong && inRange ? 1 : strong || inRange ? 2 : 3;
  return { tier, segment: null, company_type: null, reason: tier === 1 ? "icp_match" : tier === 2 ? "partial_icp_match" : "outside_icp", fact: get("employees:") };
}

/** Wraps a model so a test can count calls per step and change answers. */
export function scriptedLlm(fn: (step: string, input: string, n: number) => unknown | Promise<unknown>, model = "scripted"): Llm & { n: Record<string, number> } {
  const n: Record<string, number> = {};
  return {
    model, n,
    async complete(step, prompt) {
      const input = prompt.slice(prompt.lastIndexOf("INPUT") + 5);
      const key = `${step}|${input}`;
      n[key] = (n[key] ?? 0) + 1;
      const out = await fn(step, input, n[key]);
      return { text: typeof out === "string" ? out : JSON.stringify(out), input_tokens: 0, output_tokens: 0 };
    },
  };
}

export const HEAD = "Company Name,First Name,Last Name,Job Title,Work Email\n";
export const row = (company: string, domain: string, who = "Ana Ruiz") => `${company},${who.split(" ")[0]},${who.split(" ")[1]},VP Sales,${who.split(" ")[0].toLowerCase()}@${domain}\n`;

export interface Run { id: string; deps: Deps; vendors: ReturnType<typeof scriptedVendors>; searches: PeopleQuery[] }
export async function researchWith(db: Db, csv: string, o: { specs: Record<string, Spec>; llm?: Llm; provides?: FirmographicsLookup["provides"]; icp?: boolean; people?: Record<string, FoundPerson[]>; tweak?: (v: Vendors, s: Settings) => Vendors; deps?: Partial<Deps>; name?: string; id?: string; process?: boolean }): Promise<Run> {
  if (o.icp !== false && !(await db.query("SELECT 1 FROM icp_versions")).length) await seedIcp(db);
  const id = (await createEvent(db, MAYA, { name: o.name ?? "Tiering", starts_on: "2027-03-30", seat_count: 20, seat_price_cents: 100, country: "Spain", flow: "two_card" }, o.id)).id;
  const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
  await decideApproval(db, { approvalId: await pending(), actor: DAN, decision: "approve" });
  await ingestUpload(db, id, MAYA, "a.csv", csv);
  await requestResearchCard(db, id, MAYA);
  await decideApproval(db, { approvalId: await pending(), actor: MAYA, decision: "approve" });
  const vendors = scriptedVendors(o.specs);
  const searches: PeopleQuery[] = [];
  const peopleSearch: PeopleSearch = { name: "people_scripted", async search(q) { searches.push(q); return { people: (o.people?.[q.domain] ?? []).slice(0, q.limit), charged: 0 }; } };
  // A reveal that gives back the person the search listed: the same first name and, if hidden, a last name made from the id; the work address at the company's domain.
  const everyone = new Map(Object.values(o.people ?? {}).flat().map((p) => [p.vendor_person_id, p]));
  const letters = (x: string) => x.toLowerCase().replace(/[^a-z]/g, "");
  const reveal = (s: Settings): Reveal => ({ name: "reveal_scripted", cost: s.outreach.reveal_cost ?? 1, async reveal(q) {
    const f = everyone.get(q.vendor_person_id);
    if (!f) return { person: null, charged: s.outreach.reveal_cost ?? 1 };
    const last = f.last_name ?? `Reveal${revSuffix(f.vendor_person_id)}`;
    return { person: { vendor_person_id: f.vendor_person_id, full_name: `${f.first_name} ${last}`, email: `${letters(f.first_name)}.${letters(last)}@${q.domain}`, linkedin: null, employer: q.company, employer_domain: q.domain, email_verified: true }, charged: s.outreach.reveal_cost ?? 1 };
  } });
  const deps: Deps = {
    llm: o.llm ?? reader(),
    ...o.deps,
    vendorsFor: (s) => { const v: Vendors = { ...mockVendors(s), firmographics: vendors.firmographics(s, o.provides), website: vendors.website, peopleSearch, reveal: reveal(s) }; return o.tweak ? o.tweak(v, s) : v; },
  };
  if (o.process !== false) await processEvent(db, id, deps);
  return { id, deps, vendors, searches };
}

export const companyRows = (db: Db, id: string) => db.query<{ name: string; tier: number | null; tier_via: string | null; tier_fact: string | null; segment: string | null; baseline_tier: number | null; second_look: { agreed: boolean; tier: number | null } | null; firmo: FirmoRecord | null; firmo_source: string | null; website_note: string | null; in_research: boolean; primary_domain: string | null }>(
  "SELECT name, tier, tier_via, tier_fact, segment, baseline_tier, second_look, firmo, firmo_source, website_note, in_research, primary_domain FROM companies WHERE event_id = $1 ORDER BY name", [id]);
export const company = async (db: Db, id: string, name: string) => (await companyRows(db, id)).find((c) => c.name === name)!;
export const llmCalls = async (db: Db, id: string) => Object.fromEntries((await db.query<{ step: string; n: number }>("SELECT step, count(*)::int AS n FROM llm_calls WHERE event_id = $1 GROUP BY 1", [id])).map((r) => [r.step, r.n]));
export const stepSpend = async (db: Db, id: string) => Object.fromEntries((await db.query<{ step: string; unit: string; n: number }>(
  "SELECT step, unit, sum(CASE kind WHEN 'reserve' THEN amount WHEN 'release' THEN -amount ELSE 0 END)::int AS n FROM credit_ledger WHERE event_id = $1 GROUP BY 1, 2", [id])).map((r) => [r.step, r.n]));

/** The last name and address the scripted reveal gives a person whose last name the search hid: digits in the id become letters so every id is distinct. */
export const revSuffix = (id: string) => id.toLowerCase().replace(/[0-9]/g, (d) => String.fromCharCode(97 + Number(d))).replace(/[^a-z]/g, "");
export const revealed = (first: string, id: string, domain: string) => ({ name: `${first} Reveal${revSuffix(id)}`, email: `${first.toLowerCase()}.reveal${revSuffix(id)}@${domain}` });

/** A person the free search returns. Last name visible, a fresh record, an email reported, unless told otherwise. */
export const found = (id: string, first: string, last: string | null, title: string | null, o: Partial<FoundPerson> = {}): FoundPerson =>
  ({ vendor_person_id: id, first_name: first, last_name: last, title, linkedin: null, updated_at: new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10), has_email: true, country: "Spain", ...o });

/** Quotes the Outreach card, approves it as the approver, and runs the people steps. */
export async function outreachRun(db: Db, r: Run) {
  const { requestOutreachCard } = await import("../src/server/research.ts");
  await requestOutreachCard(db, r.id, MAYA);
  const a = (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [r.id]))[0].id;
  await decideApproval(db, { approvalId: a, actor: MAYA, decision: "approve" });
  await processEvent(db, r.id, r.deps);
}
