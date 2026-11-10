/* The two seams to the outside: the model and the vendors. Everything here is
   deterministic and free. Real adapters arrive behind env keys and LIVE_SPEND=1. */

import { createHash } from "node:crypto";
import type { Step } from "./prompts.ts";
import type { Settings } from "../shared/cost.ts";
import type { Verdict } from "../shared/tiers.ts";
import { documentOf, draftJson } from "./sim-icp.ts";
import type { FirmoRecord } from "../shared/tiering.ts";
import { parseTitle } from "../shared/titles.ts";

/** `model` is the model that answered, when the API says. With server-side fallback it can differ from the one requested. */
export interface LlmResult { text: string; input_tokens: number; output_tokens: number; model?: string; /** Real model only: why it stopped, and how many of the output tokens were hidden thinking. */ stop_reason?: string; thinking_tokens?: number }
/** `hint` is for simulators only: a real model is never sent it (the prompt is the whole request). The simulated model uses it to return the code-written text for the perspective step.
    `simulated` marks a model that is not a model, so nothing it returns is presented as written by one. */
export interface Llm { model: string; simulated?: boolean; complete(step: Step, prompt: string, hint?: unknown): Promise<LlmResult> }

/** `charged` is 0 when the vendor says it did not bill, and "unknown" otherwise. */
export class VendorError extends Error {
  charged: 0 | "unknown";
  constructor(charged: 0 | "unknown") { super("vendor error"); this.charged = charged; }
}

/** `apollo_verified`: Apollo itself reports this address as Verified. */
export interface Found { value: string | null; charged: number; linkedin?: string | null; apollo_verified?: boolean }
export interface Person { full_name: string; title: string; linkedin?: string | null }
export interface LinkedinLookup {
  name: string; cost: number;
  /** `verified_email`: the address Apollo holds as Verified for this person, when the same answer says so. */
  find(person: { full_name: string | null; title: string | null; company: string; email: string | null }): Promise<{ value: string | null; charged: number; verified_email?: string | null }>;
}
export interface Discovery { name: string; cost: number; find(company: string, limit: number): Promise<{ people: Person[]; charged: number }> }
export interface Finder { name: string; cost: number; find(person: { full_name: string | null; company: string }): Promise<Found> }
export interface Verifier { name: string; cost: number; verify(email: string): Promise<{ verdict: Verdict; charged: number }> }
/* --------------------------------------------------------- the email waterfall
   Apollo's `run_waterfall_email` with `poll_only`: one paid call starts it and returns a request id, and the result is polled for free (docs/DATA-HYGIENE.md, section 0). */
export interface WaterfallResult {
  email: string | null; linkedin?: string | null;
  /** Apollo's own status on the final address is Verified. */
  apollo_verified: boolean;
  /** ZeroBounce passed the address, flagged usedForVerification in the result. */
  zerobounce_pass: boolean;
  /** `credits_consumed`, as Apollo reports it. */
  credits: number;
}
/** `gone`: the id is unknown or past retention, so no result will ever come. */
export type WaterfallPoll = { state: "pending"; retry_after_ms: number } | { state: "done"; result: WaterfallResult } | { state: "gone" };
export interface Waterfall {
  name: string;
  /** The worst case held from the card until the result reconciles it. */
  reserve: number;
  start(person: { full_name: string; company: string; domain: string }): Promise<{ request_id: string; linkedin?: string | null }>;
  poll(requestId: string): Promise<WaterfallPoll>;
}
/* ------------------------------------------------------------ identity seams
   Company search, person match and reverse lookup (docs/TIERING-AND-ENRICHMENT.md, "Layer 1").
   Company search is free on the vendors that allow it. A person match is a reveal and costs a credit.
   `identity` is optional so a test that builds its own Vendors still compiles; the pipeline falls back
   to the mock one. */
export interface CompanyCandidate { name: string; domain: string; parent_name?: string | null; parent_domain?: string | null; country?: string | null; employees?: number | null }
export interface CompanySearch {
  name: string;
  search(query: string, opts: { country?: string | null }): Promise<{ candidates: CompanyCandidate[]; charged: number }>;
  /** A lookup whose right answer is known. When results suddenly dry up it is run, and "nobody found" is not final until it passes. */
  probe: { query: string; domain: string };
}
export interface PersonMatchResult {
  vendor_person_id: string; full_name: string; email: string | null; linkedin: string | null; employer: string | null; employer_domain: string | null; title?: string | null;
  /** Apollo itself reports `email` as Verified. */
  email_verified?: boolean | null;
  /** Detail the same paid match or reveal returns, kept for the delivered list. Absent on a vendor that does not say. */
  location?: string | null; seniority?: string | null; departments?: string[] | null;
  /** When the person started in the current role, YYYY-MM or YYYY-MM-DD as the vendor gives it. */
  role_since?: string | null;
}
export interface PersonMatch {
  name: string; cost: number;
  match(p: { first: string; last: string; full_name: string; company: string; title?: string | null }): Promise<{ person: PersonMatchResult | null; charged: number }>;
}
/** Who a reverse lookup found. Written to a row only where the row is blank. */
export interface ReversePerson { full_name: string | null; title: string | null; linkedin: string | null }
export interface ReverseResult { company: CompanyCandidate | null; person?: ReversePerson | null; charged: number }
export interface ReverseLookup {
  name: string; cost: number;
  byEmail(email: string): Promise<ReverseResult>;
  byLinkedin(url: string): Promise<ReverseResult>;
}
/** Does the domain have a mail server? Free (a DNS lookup). */
export interface Dns { hasMailServer(domain: string): Promise<boolean> }
export interface Identity { companySearch: CompanySearch; personMatch: PersonMatch; reverse: ReverseLookup; dns: Dns }

/* ------------------------------------------------------ firmographics seam
   Company facts by confirmed domain (docs/TIERING-AND-ENRICHMENT.md, "Layer 2"). `search` is free on the vendors that allow it and
   may return only some fields. `enrich` is one paid call, made only when fields the ICP needs are still missing after the cache and
   the free search. Every value is a vendor claim until a person corrects it. Optional, like `identity`: the pipeline falls back to the mock. */
export interface FirmographicsLookup {
  name: string; cost: number;
  /** The fields this vendor can ever return. A paid enrich is bought only for a missing field the vendor provides. Absent means all of them. */
  provides?: readonly ("employees" | "industry" | "business_model" | "country" | "description")[];
  search(domain: string, name: string): Promise<{ firmo: FirmoRecord | null; charged: number; company_name?: string | null }>;
  enrich(domain: string, name: string): Promise<{ firmo: FirmoRecord | null; charged: number }>;
}
/** One read of a company's own site, as plain text, or null when there is nothing to read. Free: no vendor credit. */
export interface WebsiteReader { name: string; read(domain: string): Promise<string | null> }

/* --------------------------------------------------------- people search seam
   Build-order step 7. Free search by company domain (docs/TIERING-AND-ENRICHMENT.md, "Layer 4"): titles and freshness dates for people at a
   company, with no email and, on the vendors that behave this way, the last name and LinkedIn hidden. It charges nothing; whatever it
   returns is a claim until a reveal (step 8). `vendor_person_id` is what the pipeline dedupes on before anything is paid. */
export interface FoundPerson {
  vendor_person_id: string; first_name: string;
  /** Null when the vendor hides it. A person with a hidden last name cannot be looked up for an email until a reveal, so step 7 leaves them out. */
  last_name: string | null;
  title: string | null; linkedin: string | null;
  /** The date the vendor last refreshed this record, YYYY-MM-DD. Freshness, not proof of employment. */
  updated_at: string | null;
  /** Whether the vendor says an email exists for this person. */
  has_email: boolean | null;
  country?: string | null;
}
export interface PeopleQuery { domain: string; company: string; titles: string[]; country: string | null; limit: number }
export interface PeopleSearch {
  name: string; search(q: PeopleQuery): Promise<{ people: FoundPerson[]; charged: number }>;
  /** A company the vendor surely has people for. An empty answer is final only after this still returns someone, so a throttling vendor is never read as "no people". */
  probe?: { domain: string; company: string };
}
/** The paid call that returns a person's email, employer and LinkedIn, by the id the free search gave. It is the first step of the email loop for a discovered person,
    and anything it returns is stored and never bought twice. */
export interface Reveal {
  name: string; cost: number;
  reveal(q: { vendor_person_id: string; first_name: string; company: string; domain: string }): Promise<{ person: PersonMatchResult | null; charged: number }>;
}

export interface Vendors { peopleSearch?: PeopleSearch; reveal?: Reveal; discovery: Discovery; finders: Finder[]; verifiers: Verifier[]; waterfall?: Waterfall; linkedin: LinkedinLookup; identity?: Identity; firmographics?: FirmographicsLookup; website?: WebsiteReader }

const roll = (s: string, n: number) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16) % n;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
/** A fictional, deterministic profile URL. The slug carries a hash so two people never share one. */
export const mockLinkedin = (name: string | null, company: string) =>
  `https://www.linkedin.com/in/${(name ?? "contact").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "contact"}-${roll(`li${name}${company}`, 65536).toString(16).padStart(4, "0")}`;
const FIRST = ["Alma", "Bruno", "Celia", "Dario", "Elif", "Farid", "Greta", "Hugo", "Iris", "Jonas"];
const LAST = ["Abara", "Brandt", "Costa", "Dimitrov", "Eriksen", "Fuentes", "Grant", "Hakimi", "Ivanova", "Jensen"];

const titleCase = (s: string) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
/** The mock identity vendor. Every company it is asked about exists, at a domain made from its name, except about one in ten that it cannot find. */
export function mockIdentity(s: Settings): Identity {
  const domainOf = (name: string) => `${slug(name)}.example`;
  return {
    companySearch: {
      name: "company_search_mock", probe: { query: "Probe Known Co", domain: "probeknownco.example" },
      async search(query) {
        if (query === "Probe Known Co") return { candidates: [{ name: "Probe Known Co", domain: "probeknownco.example" }], charged: 0 };
        if (!slug(query) || roll(`cs${query.toLowerCase()}`, 10) === 0) return { candidates: [], charged: 0 };
        return { candidates: [{ name: titleCase(query.toLowerCase()), domain: domainOf(query) }], charged: 0 };
      },
    },
    personMatch: {
      name: "person_match_mock", cost: s.research.person_match_cost,
      async match(p) {
        const id = `pm_${roll(`pm${p.full_name}${p.company}`, 1e6)}`;
        return { person: { vendor_person_id: id, full_name: p.full_name, email: `${slug(p.first)}.${slug(p.last)}@${domainOf(p.company)}`, linkedin: mockLinkedin(p.full_name, p.company), employer: p.company, employer_domain: domainOf(p.company), email_verified: true }, charged: s.research.person_match_cost };
      },
    },
    reverse: {
      name: "reverse_lookup_mock", cost: s.research.reverse_lookup_cost,
      async byEmail(email) {
        const d = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
        if (!d.endsWith(".example")) return { company: null, charged: s.research.reverse_lookup_cost };
        const local = email.slice(0, email.lastIndexOf("@"));
        return { company: { name: titleCase(d.split(".")[0]), domain: d }, person: local.includes(".") ? { full_name: local.split(".").map(titleCase).join(" "), title: null, linkedin: null } : null, charged: s.research.reverse_lookup_cost };
      },
      async byLinkedin() { return { company: null, charged: s.research.reverse_lookup_cost }; },
    },
    dns: { async hasMailServer(domain) { return domain.endsWith(".example"); } },
  };
}

const MOCK_INDUSTRIES = ["B2B software", "payments", "logistics technology", "industrial manufacturing", "marketing agency", "management consulting", "retail clothing"];
/** The mock firmographics vendor. Deterministic and generic: the free search knows size and country, the paid call adds industry, business model and a description. */
export function mockFirmographics(s: Settings): FirmographicsLookup {
  const pick = (name: string) => {
    const t = name.toLowerCase();
    const industry = /software|cloud|saas|data/.test(t) ? "B2B software" : /pay|settle|treasury/.test(t) ? "payments" : /logistic|freight|cargo|fleet/.test(t) ? "logistics technology" : /agency|media|creative/.test(t) ? "marketing agency" : /consult|advis/.test(t) ? "management consulting" : MOCK_INDUSTRIES[roll(`ind${name}`, MOCK_INDUSTRIES.length)];
    return { employees: 40 + roll(`emp${name}`, 6000), country: "Spain", industry, business_model: /consumer|retail|app/.test(t) || industry === "retail clothing" ? "B2C" : "B2B", description: `${titleCase(name.toLowerCase())} works in ${industry.toLowerCase()}.` };
  };
  return {
    name: "firmographics_mock", cost: s.research.firmographics_cost,
    async search(_domain, name) { const f = pick(name); return { firmo: { employees: f.employees, country: f.country }, charged: 0 }; },
    async enrich(_domain, name) { return { firmo: pick(name), charged: s.research.firmographics_cost }; },
  };
}
export const mockWebsite: WebsiteReader = { name: "website_mock", async read(domain) { return domain.endsWith(".example") ? `Welcome to ${domain.split(".")[0]}. We build products for businesses and we are hiring.` : null; } };

const MOCK_TITLES = ["VP Sales", "Head of Revenue Operations", "Director of Sales", "Account Executive", "Marketing Manager", "Software Engineer", "Chief Executive Officer", "Customer Success Manager"];
/** The mock people search: a few deterministic people per domain, with a mix of titles so some are tier 3. It never charges. */
export const mockPeopleSearch: PeopleSearch = {
  name: "people_search_mock", probe: { domain: "probeknownco.example", company: "Probe Known Co" },
  async search(q) {
    const n = Math.min(q.limit, 2 + roll(`pn${q.domain}`, 5));
    const people: FoundPerson[] = Array.from({ length: n }, (_, i) => ({
      vendor_person_id: `mock_${q.domain}_${i}`, first_name: FIRST[roll(`pf${q.domain}${i}`, 10)], last_name: LAST[roll(`pl${q.domain}${i}`, 10)],
      title: MOCK_TITLES[roll(`pt${q.domain}${i}`, MOCK_TITLES.length)], linkedin: null, updated_at: null, has_email: null,
    }));
    return { people, charged: 0 };
  },
};

/** The mock reveal: the person a mock search listed, at the address the mock finders would give. Costs one credit, hit or miss. */
export function mockReveal(s: Settings): Reveal {
  const cost = s.outreach?.reveal_cost ?? s.finders[0]?.cost ?? 1;
  return {
    name: "reveal_mock", cost,
    async reveal(q) {
      const m = q.vendor_person_id.match(/^mock_(.+)_(\d+)$/);
      const last = LAST[roll(`pl${m?.[1] ?? q.domain}${m?.[2] ?? 0}`, 10)];
      const full = `${q.first_name} ${last}`;
      return { person: { vendor_person_id: q.vendor_person_id, full_name: full, email: `${slug(q.first_name)}.${slug(last)}@${q.domain}`, linkedin: mockLinkedin(full, q.company), employer: q.company, employer_domain: q.domain, email_verified: true }, charged: cost };
    },
  };
}

/** The mock waterfall: the request id carries the question, so the answer needs no state. Nothing is pending. */
export function mockWaterfall(s: Settings): Waterfall {
  const { name, reserve } = s.waterfall;
  return {
    name, reserve,
    async start(p) { return { request_id: `mockwf:${p.company}:${p.full_name}`, linkedin: null }; },
    async poll(id) {
      const [, company, full_name] = id.split(":");
      const hit = roll(`wf${full_name}${company}`, 10) < 8;
      const local = full_name.toLowerCase().replace(/[^a-z]+/g, ".");
      return { state: "done", result: hit ? { email: `wf.${local}@${slug(company)}.example`, linkedin: null, apollo_verified: true, zerobounce_pass: true, credits: 2 } : { email: null, linkedin: null, apollo_verified: false, zerobounce_pass: false, credits: 1 } };
    },
  };
}

export function mockVendors(s: Settings): Vendors {
  return {
    peopleSearch: mockPeopleSearch,
    reveal: mockReveal(s),
    identity: mockIdentity(s),
    firmographics: mockFirmographics(s),
    website: mockWebsite,
    discovery: {
      name: "discovery_mock", cost: s.discovery_cost,
      async find(company, limit) {
        const n = Math.min(limit, roll(`n${company}`, limit + 1) || 1);
        const people = Array.from({ length: n }, (_, i) => ({
          full_name: `${FIRST[roll(`f${company}${i}`, 10)]} ${LAST[roll(`l${company}${i}`, 10)]}`,
          title: s.target_titles[i % s.target_titles.length],
          linkedin: null as string | null,
        }));
        for (const p of people) p.linkedin = mockLinkedin(p.full_name, company);
        return { people, charged: n * s.discovery_cost };
      },
    },
    finders: s.finders.map((f, i) => ({
      name: f.name, cost: f.cost,
      async find(p) {
        const hit = roll(`${f.name}${p.full_name}${p.company}`, 10) < (i === 0 ? 6 : 8);
        const local = (p.full_name ?? "contact").toLowerCase().replace(/[^a-z]+/g, ".");
        return { value: hit ? `${local}@${slug(p.company)}.example` : null, charged: f.cost, linkedin: hit ? mockLinkedin(p.full_name, p.company) : null, apollo_verified: hit };
      },
    })),
    waterfall: mockWaterfall(s),
    verifiers: s.verifiers.map((v) => ({
      name: v.name, cost: v.cost,
      async verify(email) {
        // An address nobody has (the catch-all probe's) is not deliverable at an ordinary domain.
        if (email.startsWith("zz-")) return { verdict: "undeliverable", charged: v.cost };
        const r = roll(`${v.name}${email}`, 20);
        return { verdict: r === 0 ? "undeliverable" : r === 1 ? "unknown" : r === 2 ? "catch_all" : "deliverable", charged: v.cost };
      },
    })),
    linkedin: {
      name: s.linkedin.name, cost: s.linkedin.cost,
      async find(p) { return { value: p.full_name ? mockLinkedin(p.full_name, p.company) : null, charged: s.linkedin.cost }; },
    },
  };
}

/* ------------------------------------------------------------------ CRM */

export type Heat = "hot" | "warm" | "cold";
/** What the CRM knows about one company. Never a deal amount. */
export type AccountType = "customer" | "prospect" | "partner" | "competitor" | "none";
export interface CrmAccount { owner: string | null; deal_name: string | null; deal_stage: string | null; last_activity: string | null; /** Null when the CRM has no answer, which the workbook shows as "Unknown". */ heat: Heat | null; /** What the CRM calls this account. Read by domain. */ account_type?: AccountType | null }
/** Who to look for. A CRM matches by `email` and, alongside it, by `full_name` at the account (`domain`, or `company` when no domain is known). */
export interface CrmPersonQuery { ref: string; email: string | null; full_name: string | null; company: string | null; domain: string | null }
/** One Lead or Contact, as Salesforce holds it. `bounced_at` is when mail to `email` last bounced. */
export interface CrmRecord { id: string; object: "Lead" | "Contact"; email: string | null; email_opt_out: boolean; do_not_contact: boolean; do_not_call: boolean; bounced_at: string | null }
export interface CrmAccountQuery { ref: string; domain: string | null; name: string | null }
export interface CrmPatch { email?: string; email_opt_out?: true }
/** `asOf` is the day the lookup runs, so "last activity" is a real date. */
export interface Crm {
  name: string; lookup(company: string, asOf: string): Promise<CrmAccount>;
  /** The design reads the CRM by confirmed domain, and the answer carries an account type. Absent on a CRM that only knows names. */
  lookupByDomain?(domain: string, company: string, asOf: string): Promise<CrmAccount>;
  /** True only when do not contact checks can and must run. A CRM that says true and cannot answer pauses the run. */
  connected?: boolean;
  /** Every record that matches each person, by `ref`. An empty list means none. */
  personFlags?(people: CrmPersonQuery[]): Promise<Record<string, CrmRecord[]>>;
  /** Whether each account is marked do not prospect, by `ref`. */
  accountFlags?(accounts: CrmAccountQuery[]): Promise<Record<string, { do_not_prospect: boolean }>>;
  /** Updates one record that exists. Absent means nothing is written back. */
  write?(record: CrmRecord, patch: CrmPatch): Promise<void>;
  /** The event's Campaign. Looked up by the desk's key first, so a retry finds the one already made. */
  findCampaignByKey?(key: string): Promise<{ id: string } | null>;
  createCampaign?(a: { name: string; start: string; end: string; type: string; key: string }): Promise<{ id: string }>;
  updateCampaignMemberStatus?(a: { campaign: string; record: CrmRecord; status: string }): Promise<void>;
  /** Salesforce refuses a duplicate member, so `CrmAlreadyExists` from here counts as done. */
  createCampaignMember?(a: { campaign: string; record: CrmRecord; key: string; status?: string }): Promise<{ id: string }>;
  /** Tasks can double on a retry, so the desk's key goes in a custom field and is looked for first. */
  findTaskByKey?(key: string): Promise<{ id: string } | null>;
  createTask?(a: { record: CrmRecord; subject: string; body: string; due: string; key: string }): Promise<{ id: string }>;
  createLead?(a: { email: string; full_name: string | null; company: string; domain: string | null; key: string }): Promise<{ id: string }>;
  /** Opportunities on each account, by `ref`. */
  opportunities?(accounts: CrmAccountQuery[]): Promise<Record<string, CrmOpportunity[]>>;
}
export interface CrmOpportunity { id: string; stage: string; amount_cents: number | null; created_date: string; stage_history: { stage: string; at: string }[]; close_date?: string | null; is_won?: boolean; is_closed?: boolean }
export class CrmAlreadyExists extends Error {}

const OWNERS = ["Priya Natarajan", "Tomas Lindqvist", "Adaeze Okonkwo", "Mateo Ruiz", "Hanna Berg"];
const DEAL_KINDS = ["platform pilot", "expansion", "renewal", "new logo"];
const DEAL_STAGES = ["Discovery", "Evaluation", "Proposal", "Negotiation"];
const shiftDays = (ymd: string, days: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

/** Heat follows one written rule: hot is an open deal with activity in the last 30 days,
    warm is an open deal or activity in the last 45 days, cold is everything else. */
export const heatOf = (hasDeal: boolean, daysSinceActivity: number | null): Heat =>
  hasDeal && daysSinceActivity !== null && daysSinceActivity <= 30 ? "hot" : hasDeal || (daysSinceActivity !== null && daysSinceActivity <= 45) ? "warm" : "cold";

export const mockCrm: Crm = {
  name: "crm_mock",
  async lookupByDomain(_domain, company, asOf) { return { ...(await mockCrm.lookup(company, asOf)), account_type: "none" }; },
  async lookup(company, asOf) {
    if (roll(`crm${company}`, 10) < 2) return { owner: null, deal_name: null, deal_stage: null, last_activity: null, heat: "cold" };
    const hasDeal = roll(`deal${company}`, 10) < 5;
    const daysAgo = 3 + roll(`act${company}`, 120);
    return {
      owner: OWNERS[roll(`own${company}`, OWNERS.length)],
      deal_name: hasDeal ? `${company} ${DEAL_KINDS[roll(`kind${company}`, DEAL_KINDS.length)]}` : null,
      deal_stage: hasDeal ? DEAL_STAGES[roll(`stage${company}`, DEAL_STAGES.length)] : null,
      last_activity: shiftDays(asOf, -daysAgo),
      heat: heatOf(hasDeal, daysAgo),
    };
  },
};

/** The CRM for a live install that has none connected. Every field stays blank, so nothing is invented for a real company. */
export const noCrm: Crm = {
  name: "no_crm",
  connected: false,
  async lookup() { return { owner: null, deal_name: null, deal_stage: null, last_activity: null, heat: null }; },
  async lookupByDomain(domain, company, asOf) { return { ...(await noCrm.lookup(company, asOf)), account_type: null }; },
};

/** The simulated model's answer for the perspective step: the code-written text it was handed, never prose of its own. Nothing handed means an empty answer, which is invalid. */
export const draftReply = (hint: unknown): LlmResult => ({ text: hint && typeof hint === "object" ? JSON.stringify(hint) : "", input_tokens: 0, output_tokens: 0 });

export const mockLlm: Llm = {
  model: "mock-deterministic",
  simulated: true,
  async complete(step, prompt, hint) {
    if (step === "perspective") return draftReply(hint);
    // The mock reads an ICP document with the same deterministic parser the simulated model uses. It is data: nothing in it is acted on.
    if (step === "icp_compile") return { text: draftJson(documentOf(prompt)), input_tokens: 0, output_tokens: 0 };
    const input = prompt.slice(prompt.lastIndexOf("INPUT")).toLowerCase();
    let out: unknown;
    if (step === "concierge") {
      const question = input.split("\n").find((l) => l.startsWith("question:")) ?? "";
      const tool = input.match(/tool result (\w+): (.*)/);
      if (/money|cost|spend|spent|budget|price|credit|\$/.test(question)) out = { answer: "I can only share counts." };
      else if (tool) out = { answer: `Here are the contacts counts I found: ${tool[2]}` };
      else out = { tool: /drop|remove|why/.test(question) ? "drop_counts" : /compan/.test(question) ? "company_counts" : "priority_counts", args: {} };
    } else if (step === "company_tier") {
      const fact = input.split("\n").map((l) => l.trim()).find((l) => /^(employees|industry|sells to|country|description|from its own website|from the attendee file)/.test(l));
      // The original lines keep their case: the fact is copied, not lowered.
      const original = prompt.slice(prompt.lastIndexOf("INPUT")).split("\n").map((l) => l.trim()).find((l) => fact && l.toLowerCase() === fact) ?? null;
      const base = /agency|consult|consumer/.test(input) ? { tier: 3, reason: "outside_icp" }
        : /software|logistics|payments/.test(input) ? { tier: 1, reason: "icp_match" }
        : { tier: 2, reason: "insufficient_information" };
      out = { ...base, segment: null, company_type: null, fact: original };
    } else if (step === "reply_classify") {
      const reply = prompt.slice(prompt.lastIndexOf("<<<REPLY") + 8, prompt.lastIndexOf("REPLY>>>")).toLowerCase();
      out = { code: /out of (the )?office|away until/.test(reply) ? "out_of_office" : /left the company|no longer (with|at)/.test(reply) ? "departed" : /wrong person/.test(reply) ? "wrong_person" : /speak to|talk to my colleague/.test(reply) ? "referral" : /not interested|no thanks/.test(reply) ? "not_interested" : /next (year|quarter)|not now|bad time/.test(reply) ? "not_now" : /(book|meet|call|calendar|tuesday|wednesday|thursday)/.test(reply) ? "meeting_request" : /interested|tell me more|sounds good/.test(reply) ? "interested" : "other" };
    } else if (step === "debrief_extract") {
      const notes = prompt.slice(prompt.lastIndexOf("<<<NOTES") + 8, prompt.lastIndexOf("NOTES>>>")).trim();
      const first = notes.split(/[.\n]/)[0]?.trim() ?? "";
      out = { facts: first ? [{ account: null, theme: "general", fact: first, quote: first }] : [] };
    } else if (step === "title_parse") {
      const p = parseTitle(input.split("\n").find((l) => l.startsWith("title:"))?.slice(6).trim() ?? "");
      out = { function: p.function ?? "other", seniority: p.seniority ?? "individual", non_buyer: p.non_buyer };
    } else if (step === "website_read") {
      const page = prompt.slice(prompt.lastIndexOf("<<<PAGE") + 7, prompt.lastIndexOf("PAGE>>>")).trim();
      out = { description: page.slice(0, 200) };
    } else if (step === "title_tier") {
      out = /sales|account|growth|revenue|marketing/.test(input) ? { tier: 2, reason: "influencer" } : { tier: 3, reason: "not_relevant" };
    } else {
      out = { flags: /student|retired|former/.test(input) ? ["title_company_mismatch"] : [] };
    }
    return { text: JSON.stringify(out), input_tokens: 0, output_tokens: 0 };
  },
};
