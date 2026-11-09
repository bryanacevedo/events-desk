import type { Pools } from "./vendors.ts";

/* The settings an event runs with, the title rule, and the worst-case cost card.
   The card assumes nothing is dropped and every vendor is tried. */

export interface Vendor { name: string; cost: number }
/** Apollo's email waterfall. `reserve` is the worst case held from the card for one person until Apollo reports what it really consumed. `max_wait_minutes` is how long a result is waited for. */
export interface WaterfallRates { name: string; reserve: number; max_wait_minutes: number }

/** Rates for the Research card. Starting values, meant to be tuned (docs/TIERING-AND-ENRICHMENT.md, "Starting values"). */
export interface ResearchRates {
  person_match_cost: number; reverse_lookup_cost: number; firmographics_cost: number;
  /** Share of companies the card lets a person re-tier after the spread check. */
  retier_share: number;
  /** Two passes, each with one invalid-answer retry. */
  tier_calls_per_company: number; website_read_calls: number;
}
export interface OutreachRates {
  quota_tier1: number; quota_tier2: number; candidates_per_person: number;
  /** Credits per person the people search returns. The search is free on the vendors that allow it, so 0; a reveal is a later step and is priced there. */
  search_cost?: number;
  /** Credits for one reveal (the first lookup of a discovered person, by the vendor that found them). Defaults to the first finder's cost. */
  reveal_cost?: number;
  /** Off by default: guessing addresses from a pattern carries legal risk in some markets and needs counsel's sign-off. */
  pattern_guess?: boolean;
  /** One catch-all probe per domain, before any reveal. */
  probe_cost: number; verifier_retries: number;
}
/** Hit rates for the labeled estimate only. They bound nothing. */
export interface EstimateRates { finder_hit: number; verifier_pass: number; linkedin_on_file: number }
export interface Limits {
  tier1_share_warning: number; small_list_companies: number; freshness_days: number; verification_reuse_days: number; firmographics_cache_days: number;
}
export interface Settings {
  icp: string;
  excluded_companies: string[];
  existing_customers: string[];
  target_titles: string[];
  title_keywords: Record<"1" | "2" | "3", string[]>;
  contacts_per_company: number;
  add_prospects: boolean;
  discovery_cost: number;
  finders: Vendor[];
  verifiers: Vendor[];
  waterfall: WaterfallRates;
  /** One paid lookup for a kept contact who still has no LinkedIn URL. */
  linkedin: Vendor;
  /** Dollars apply to AI model calls only. Vendor credits have no dollar value anywhere in the system. */
  llm_call_cents: number;
  /** Each credit vendor's pre-allocated pool. Null allotment means unknown. */
  pools: Pools;
  approvers: string[];
  agent_question_limit: number;
  calls_per_question: number;
  research: ResearchRates;
  outreach: OutreachRates;
  estimate: EstimateRates;
  limits: Limits;
}

export type Tier = 1 | 2 | 3;

/** Tier from the keyword table, or null when the LLM must decide. Tier 3 wins, so "Assistant to the VP" is not a VP. */
export function titleRule(title: string, keywords: Settings["title_keywords"]): Tier | null {
  const t = title.toLowerCase();
  const hit = (k: string) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(t);
  for (const tier of [3, 1, 2] as const) if (keywords[tier].some(hit)) return tier;
  return null;
}

export interface CardInputs {
  person_rows: number;
  company_only_rows: number;
  people_without_email: number;
  unique_companies: number;
  titles_with_no_rule: number;
  companies_with_people: number;
}

export interface CardLines {
  contacts: number;
  discovery_credits: number;
  finder_credits: number;
  verifier_credits: number;
  linkedin_credits: number;
  pipeline_llm: number;
  agent_llm: number;
}

/* est_cents on every card is AI dollars only (model calls x the call rate). Vendor credits are never converted to money. */
export function quote(i: CardInputs, s: Settings) {
  // Prospects are looked up per attending company, on top of any company-only rows.
  const discovered = (i.company_only_rows + (s.add_prospects ? i.companies_with_people : 0)) * s.contacts_per_company;
  const contacts = i.person_rows + discovered;
  const sum = (v: Vendor[]) => v.reduce((n, x) => n + x.cost, 0);
  const lines: CardLines = {
    contacts,
    discovery_credits: discovered * s.discovery_cost,
    finder_credits: (i.people_without_email + discovered) * sum(s.finders),
    verifier_credits: contacts * sum(s.verifiers),
    // Worst case: every kept contact still needs the lookup.
    linkedin_credits: contacts * s.linkedin.cost,
    pipeline_llm: 2 * (i.unique_companies + i.titles_with_no_rule + contacts),
    agent_llm: s.agent_question_limit * s.calls_per_question,
  };
  const credits_cap = lines.discovery_credits + lines.finder_credits + lines.verifier_credits + lines.linkedin_credits;
  const llm_cap = lines.pipeline_llm + lines.agent_llm;
  return { lines, credits_cap, llm_cap, est_cents: llm_cap * s.llm_call_cents };
}

export function validateSettingsPatch(b: Record<string, unknown>): string | null {
  const n = b.contacts_per_company;
  if (n !== undefined && (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 25)) return "Contacts per company must be a whole number from 1 to 25.";
  if (b.add_prospects !== undefined && typeof b.add_prospects !== "boolean") return "Choose whether to add prospects.";
  return null;
}

/* ------------------------------------------------------------ the two cards */

/** The steps each card pays for. A paid call names its step; a step no approved card names is refused. */
export const RESEARCH_STEPS = ["person_match", "reverse_lookup", "firmographics", "company_tier", "website_read"] as const;
export const OUTREACH_STEPS = ["title_tier", "title_parse", "discovery", "reveal", "find", "waterfall", "verify", "catch_all_probe", "linkedin", "review", "perspective", "concierge"] as const;
export type StepCaps = Record<string, { credits?: number; llm?: number }>;

export interface ResearchInputs {
  /** Companies that go to research: not a list match, not stopped by the title pass. */
  companies: number;
  /** Of those, companies the file's own evidence did not settle. */
  unresolved_companies: number;
  /** Of those, the ones with a person who has a first and last name, since a person match needs one. It is the number priced. */
  person_match_companies?: number;
  /** Person rows with no company, which need a reverse lookup from their email or LinkedIn. */
  reverse_lookup_rows: number;
  /** Person rows that continue, shown on the card as "people". */
  person_rows: number;
}

/** The Research card, worst case. It covers every company, so a case settled later never needs more money.
    person match: one per unresolved company. reverse lookups: one per person row with no company.
    Companies: those in research now, plus one for every reverse lookup, because a lookup can attach a person to a company the file never named.
    firmographics: at most one paid enrich per company (the free search and the cache cost nothing).
    Per company, in LLM calls: up to 4 tier calls (two passes, one invalid-answer retry on each) and one website read. There is no second look (docs/DECISIONS.md, 24).
    The re-tier allowance is a number of companies a person may tier again before Approval 2. Each re-tiered company can use the same
    4 + 1 calls, so its website read is priced too. A re-tier reads the firmographics already stored, so it buys no credits. */
export function quoteResearch(i: ResearchInputs, s: Settings) {
  const r = s.research;
  const maxCompanies = i.companies + i.reverse_lookup_rows;
  const retier = Math.ceil(maxCompanies * r.retier_share);
  const lines = {
    contacts: i.person_rows,
    linkedin_credits: 0,
    companies: i.companies,
    max_companies: maxCompanies,
    unresolved_companies: i.unresolved_companies,
    person_match_companies: i.person_match_companies ?? i.unresolved_companies,
    reverse_lookup_rows: i.reverse_lookup_rows,
    person_match_credits: (i.person_match_companies ?? i.unresolved_companies) * r.person_match_cost,
    reverse_lookup_credits: i.reverse_lookup_rows * r.reverse_lookup_cost,
    firmographics_credits: maxCompanies * r.firmographics_cost,
    llm_calls_per_company: r.tier_calls_per_company + r.website_read_calls,
    tier_llm: maxCompanies * r.tier_calls_per_company,
    website_read_llm: maxCompanies * r.website_read_calls,
    retier_companies: retier,
    retier_llm: retier * r.tier_calls_per_company,
    retier_website_read_llm: retier * r.website_read_calls,
  };
  const step_caps: StepCaps = {
    person_match: { credits: lines.person_match_credits },
    reverse_lookup: { credits: lines.reverse_lookup_credits },
    firmographics: { credits: lines.firmographics_credits },
    company_tier: { llm: lines.tier_llm + lines.retier_llm },
    website_read: { llm: lines.website_read_llm + lines.retier_website_read_llm },
  };
  const credits_cap = lines.person_match_credits + lines.reverse_lookup_credits + lines.firmographics_credits;
  const llm_cap = step_caps.company_tier.llm! + step_caps.website_read.llm!;
  return { lines, step_caps, credits_cap, llm_cap, est_cents: llm_cap * s.llm_call_cents };
}

/** The most calls the Summary's perspective can make: the call and one retry. */
export const PERSPECTIVE_CALLS = 2;

export interface OutreachInputs {
  /** Attendees who are, or could still be, A or B. A title with no rule yet counts at its best case. */
  attendees_ab: number;
  attendees_without_email: number;
  /** Companies where people are searched, by company tier. Quotas apply to prospects only. */
  search_companies_tier1: number;
  search_companies_tier2: number;
  /** One catch-all probe each. */
  domains: number;
  titles_with_no_rule: number;
}

/** The Outreach card, quoted only once no review case is open, so a late answer can never exceed it.
    max people = attendees at A or B + companies searched x quota. Per person: Apollo's match once (a discovered person's is the reveal), one waterfall at its reserved worst case,
    the verifier on up to `candidates_per_person` candidates plus `verifier_retries` retries, one LinkedIn lookup. Plus one catch-all probe per
    domain, title parsing (with a retry), a model flag per person (with a retry), the Summary perspective (one call, one retry) and the Concierge allowance.
    The estimate beside it is labeled and uses configured hit rates, not measured ones. */
export function quoteOutreach(i: OutreachInputs, s: Settings, opts: { topUp?: boolean } = {}) {
  const o = s.outreach, e = s.estimate;
  const sum = (v: Vendor[]) => v.reduce((n, x) => n + x.cost, 0);
  const discovered = i.search_companies_tier1 * o.quota_tier1 + i.search_companies_tier2 * o.quota_tier2;
  const people = i.attendees_ab + discovered;
  const revealCost = o.reveal_cost ?? s.finders[0]?.cost ?? 1;
  // The probe is one call to the first verifier, so it is priced at whichever is higher: the setting or that verifier's rate.
  const probeCost = Math.max(o.probe_cost, s.verifiers[0]?.cost ?? 0);
  const lines = {
    contacts: people,
    max_people: people,
    attendees_ab: i.attendees_ab,
    discovered_people: discovered,
    discovery_credits: discovered * (o.search_cost ?? 0),
    // Every person may need Apollo's match and the waterfall, whatever email they came with, because a failing address sends the loop to the next source.
    // A discovered person's first lookup is the reveal (by the vendor that found them), so the match is not paid again for them.
    reveal_credits: discovered * revealCost,
    finder_credits: i.attendees_ab * sum(s.finders) + discovered * (sum(s.finders) - (s.finders[0]?.cost ?? 0)),
    waterfall_credits: people * s.waterfall.reserve,
    verifier_credits: people * (o.candidates_per_person + o.verifier_retries) * sum(s.verifiers),
    probe_credits: i.domains * probeCost,
    linkedin_credits: people * s.linkedin.cost,
    // Titles the rules cannot place go to the model, with one retry. The titles of the people the search returns are not known when the card is quoted,
    // so every discovered person is priced as if their title needed the model.
    uploaded_title_llm: 2 * i.titles_with_no_rule,
    discovered_title_llm: 2 * discovered,
    title_llm: 2 * i.titles_with_no_rule + 2 * discovered,
    review_llm: 2 * people,
    // The Summary's perspective: one model call per delivered list, with one retry at most. Its own step, so no other step's room can pay for it.
    perspective_llm: opts.topUp ? 0 : PERSPECTIVE_CALLS,
    agent_llm: opts.topUp ? 0 : s.agent_question_limit * s.calls_per_question,
  };
  const step_caps: StepCaps = {
    title_tier: { llm: lines.title_llm },
    title_parse: { llm: lines.title_llm },
    discovery: { credits: lines.discovery_credits },
    reveal: { credits: lines.reveal_credits },
    find: { credits: lines.finder_credits },
    waterfall: { credits: lines.waterfall_credits },
    verify: { credits: lines.verifier_credits },
    catch_all_probe: { credits: lines.probe_credits },
    linkedin: { credits: lines.linkedin_credits },
    review: { llm: lines.review_llm },
    perspective: { llm: lines.perspective_llm },
    concierge: { llm: lines.agent_llm },
  };
  const credits_cap = lines.discovery_credits + lines.reveal_credits + lines.finder_credits + lines.waterfall_credits + lines.verifier_credits + lines.probe_credits + lines.linkedin_credits;
  const llm_cap = lines.title_llm + lines.review_llm + lines.perspective_llm + lines.agent_llm;

  // The labeled estimate: what the configured hit rates say it will probably cost. It is not a cap.
  const needFinder = i.attendees_without_email + discovered;
  const finderCost = s.finders.reduce((n, f, k) => n + f.cost * Math.pow(1 - e.finder_hit, k), 0);
  // The waterfall runs on a miss and is priced at its reserve, since what it really consumes is only known once it reports.
  const miss = Math.pow(1 - e.finder_hit, s.finders.length);
  const withEmail = (people - needFinder) + needFinder * (1 - miss);
  const verify = s.verifiers.reduce((n, v, k) => n + v.cost * Math.pow(e.verifier_pass, k), 0);
  const est_credits = Math.round(lines.discovery_credits + lines.reveal_credits + needFinder * finderCost + needFinder * miss * s.waterfall.reserve + withEmail * verify + lines.probe_credits + withEmail * e.verifier_pass * (1 - e.linkedin_on_file) * s.linkedin.cost);
  // The perspective is priced at one call in the estimate (the retry is in the cap only).
  const est_llm = Math.round(i.titles_with_no_rule + withEmail + (opts.topUp ? 0 : 1) + lines.agent_llm);
  const estimate = {
    label: "Estimate from configured hit rates, not measured ones. The caps are what stop spending.",
    credits: est_credits, llm: est_llm, cents: est_llm * s.llm_call_cents,
  };
  return { lines: { ...lines, estimate }, step_caps, credits_cap, llm_cap, est_cents: llm_cap * s.llm_call_cents, estimate };
}
