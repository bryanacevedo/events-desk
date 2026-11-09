/* Simulated vendors and a simulated model, built from the world's known truth
   (samples/world.json). They implement the same `Vendors` and `Llm` interfaces as the
   mocks and the real adapters, so the pipeline cannot tell them apart, and they make
   no network call of any kind. Every answer is a pure function of the input and the
   call count, so a run is repeatable.

   They are honest about the truth and misbehave only at the rates in SIM_RATES, which
   are chosen, not measured. What they prove is that the code copes with those failures.
   They say nothing about how real vendors perform.

   A company or address the world has never heard of falls through to the plain mocks, so
   the small sample events behave exactly as before. A company the world knows is junk
   (keyboard mash, "N/A") finds nothing. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { companyKey } from "../shared/ingest.ts";
import type { Settings } from "../shared/cost.ts";
import type { World, WorldCompany, WorldPerson } from "../shared/world.ts";
import type { Verdict } from "../shared/tiers.ts";
import type { Deps } from "./pipeline.ts";
import { draftReply, mockCrm, mockLlm, mockVendors, VendorError, type AccountType, type CompanyCandidate, type Crm, type CrmRecord, type FirmographicsLookup, type FoundPerson, type Identity, type Llm, type PeopleSearch, type PersonMatchResult, type Reveal, type Vendors, type Waterfall, type WaterfallResult, type WebsiteReader } from "./providers.ts";
import { FUNCTIONS, parseTitle } from "../shared/titles.ts";
import { SENIORITIES } from "../shared/icp.ts";
import { cleanFirmo, type FirmoRecord } from "../shared/tiering.ts";
import { nameScore } from "../shared/identity.ts";
import type { Clock } from "./vendor-health.ts";

/** The stated misbehavior. Each is the share of calls (or of answers) that go wrong in that way. */
export const SIM_RATES = {
  discovery: { miss: 0.10, stale_employer: 0.08, error: 0.01 },
  /** Apollo's normal match. `wrong_pattern` is the right domain with a guessed mailbox.
      `stale_match` is a person registered under an old employer: the vendor returns the new employer's address.
      `homonym` is another person with the same name at a different company. Whatever remains is a miss. */
  finder: [
    { hit: 0.58, wrong_pattern: 0.06, stale_match: 0.70, homonym: 0.35, error: 0.015 },
  ],
  /** How often Apollo marks an address it returns as Verified: a correct one from the match, a guessed one, a reveal, and the address behind a LinkedIn lookup. */
  apollo_verified: { hit: 0.85, wrong_pattern: 0.15, reveal: 0.85, lookup: 0.85 },
  /** Apollo's email waterfall. The sources run in order until one address passes the validator. `charges`: "found" bills only a found address, "lookup" bills every attempt. Every address tested costs one
      validator credit, inside Apollo's credits. `wrong_pattern`: the source guesses a mailbox. `validator`: how often ZeroBounce, as Apollo's validator, passes a real and a non-existent address.
      `verified`: how often Apollo then marks a passed address Verified. The names are the starting lineup in docs/DATA-HYGIENE.md; none of them is ever called, and none of these rates is measured. */
  waterfall: {
    sources: [
      { name: "apollo_data", hit: 0.25, charges: "found" },
      { name: "hunter", hit: 0.45, charges: "found" },
      { name: "findymail", hit: 0.40, charges: "found" },
      { name: "dropcontact", hit: 0.30, charges: "lookup" },
      { name: "prospeo", hit: 0.35, charges: "found" },
    ],
    wrong_pattern: 0.05, stale_match: 0.70, homonym: 0.35, error: 0.01,
    validator: { real: 0.95, false_pass: 0.02 }, verified: 0.96,
    pending_polls: 1,
  },
  /** `false_deliverable`: a mailbox that does not exist reads deliverable. `unknown`: a temporary answer.
      `catch_all_missed`: a catch-all domain reads as an ordinary one. `false_undeliverable`: a real mailbox reads invalid. */
  verifier: [
    { false_deliverable: 0.04, unknown: 0.03, catch_all_missed: 0.08, false_undeliverable: 0.01, error: 0.01 },
  ],
  linkedin: { hit: 0.70, error: 0.01 },
  /** Identity (build-order step 5). `search_miss`: the vendor has no record of the company at all, under any spelling.
      `search_wrong_top`: the right company is left out of the answer and only a lookalike comes back.
      A person match returns the person's CURRENT employer, so a registrant under an old employer comes back at the wrong company.
      `homonym`: another person with the same name, elsewhere. Reverse lookups find a person by a work address or a LinkedIn profile; a personal
      webmail address is never resolved. `crm_unlisted_customer`: customers the CRM knows and the exclusion list does not. */
  identity: {
    search_miss: 0.06, search_wrong_top: 0.03, search_error: 0.01,
    person: { hit: 0.85, stale: 0.70, homonym: 0.35, error: 0.01 },
    reverse: { work_email: 0.90, linkedin: 0.75, error: 0.01 },
    crm_unlisted_customer: 0.012,
  },
  llm: { company_off_by_one: 0.12, company_obscure: 0.04, title_off: 0.06, review_recall: 0.85, review_false_positive: 0.02 },
  /** Firmographics (build-order step 6). `search` is the share of companies whose free search returns each field. `enrich` is the share of
      the fields still missing that the paid call fills. `employees_noise` is the share of headcounts the vendor has wrong by about half or
      by about 60% too many. `none` is the share of domains the vendor has no record of, in either call. `website_none`: no readable site. */
  firmo: {
    search: { employees: 0.92, country: 0.95, industry: 0.75, description: 0.55, business_model: 0.20 },
    enrich: { employees: 0.97, industry: 0.95, description: 0.90, business_model: 0.80, country: 0.9 },
    employees_noise: 0.08, none: 0.05, error: 0.01, website_none: 0.12,
  },
  /** People search (build-order step 7). `miss`: the vendor has nobody for the company. `stale_employer`: a slot shows someone who has left (still listed there).
      `hidden_last_name`: the free search hides the last name. `has_email`: the share it says have an email. `stale_record`: the share whose record was last
      refreshed over 180 days ago. `title_function_wrong` and `title_seniority_off`: how often the simulated model misreads a title the rules could not place. */
  /** Reveal (build-order step 8): the share of people it finds, and calls that fail. */
  reveal: { hit: 0.88, error: 0.01 },
  people: { miss: 0.08, stale_employer: 0.08, hidden_last_name: 0.2, has_email: 0.7, stale_record: 0.25, error: 0.01, title_function_wrong: 0.05, title_seniority_off: 0.08 },
  /** The model reading supplied facts (company tier and second look). It applies the seller's rule to what it was given.
      `off_by_one`: it misjudges by one level although the facts decide it. `unknown_though_decisive`: it says unknown although they decide it.
      `guess_when_missing`: when a deciding fact is missing it answers anyway instead of saying unknown (and is then often wrong).
      `fabricated_fact`: it cites a fact that was not supplied. */
  tier: { off_by_one: 0.08, unknown_though_decisive: 0.04, guess_when_missing: 0.25, fabricated_fact: 0.02 },
  /** The simulated CRM's do not contact data. `on_file`: people it has a record for. `second_record`: of those, people with a Lead as well as a Contact. Of second records, `other_address` sit under another
      address and `blank_email` have none, the ones a write-back can fill. Each flag is rolled per record, so anyone with two records has two chances. None of these rates is measured. */
  crm: { on_file: 0.6, second_record: 0.2, other_address: 0.25, blank_email: 0.25, email_opt_out: 0.02, do_not_contact: 0.01, do_not_call: 0.03, bounced: 0.02, do_not_prospect: 0.01 },
} as const;

export type SimClass = "hit" | "wrong_pattern" | "stale_match" | "homonym" | "miss" | "error" | "stale_employer" | "ok"
  | "false_deliverable" | "false_undeliverable" | "catch_all_missed" | "unknown" | "correct";
/** One record per simulated answer, for tests and for anyone auditing a run. */
export interface SimEvent { vendor: string; op: string; klass: SimClass; email?: string | null; truth?: string | null }
export interface SimOpts {
  audit?: (e: SimEvent) => void;
  /** For tests of the vendor guard. Silent throttling: every `every` company searches, the vendor answers with an empty success for `length_ms` of clock time. */
  throttle?: { every: number; length_ms: number };
  /** For tests: while this returns true, company search fails as if the vendor were down. */
  outage?: () => boolean;
  clock?: Clock;
  /** For tests of the vendor guard: the people search answers with an empty success for `length_ms` of clock time every `every` searches, the known-good lookup included. */
  peopleThrottle?: { every: number; length_ms: number };
  /** The day the simulated vendor's freshness dates count back from. Defaults to today, so a record is as old relative to the run as it was authored to be. */
  asOf?: string;
}

/* -------------------------------------------------------------- the index */

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ø/gi, "o").replace(/ł/gi, "l").replace(/ß/g, "ss").replace(/æ/gi, "ae").replace(/đ/gi, "d").replace(/ı/g, "i").replace(/ř/g, "r").replace(/ľ/g, "l");
/** Word order does not matter, so a swapped first and last name still finds the person, as a fuzzy vendor would. */
const nameKey = (s: string) => fold(s).toLowerCase().split(/[^a-z]+/).filter(Boolean).sort().join(" ");
const PATTERNS = ["first.last", "flast", "first", "firstl", "first_last", "last.first"];
function localPart(pattern: string, first: string, last: string) {
  const f = fold(first).toLowerCase().replace(/[^a-z]/g, ""), l = fold(last).toLowerCase().replace(/[^a-z]/g, "");
  switch (pattern) {
    case "flast": return f[0] + l;
    case "first": return f;
    case "firstl": return f + l[0];
    case "first_last": return `${f}_${l}`;
    case "last.first": return `${l}.${f}`;
    default: return `${f}.${l}`;
  }
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Uniform in [0, 1), a pure function of the string. */
const u = (s: string) => parseInt(sha(s).slice(0, 12), 16) / 2 ** 48;

export interface WorldIndex {
  world: World;
  byKey: Map<string, WorldCompany>;
  byId: Map<string, WorldCompany>;
  byDomain: Map<string, WorldCompany>;
  employees: Map<string, WorldPerson[]>;
  byName: Map<string, WorldPerson[]>;
  mailboxes: Set<string>;
  junk: Set<string>;
  extra: Set<string>;
  webmail: Set<string>;
  placeholder: Set<string>;
  /** One person per company the vendor still lists there although they have left. */
  former: Map<string, WorldPerson>;
}

const indexes = new WeakMap<World, WorldIndex>();
export function indexWorld(world: World): WorldIndex {
  const hit = indexes.get(world);
  if (hit) return hit;
  const byKey = new Map<string, WorldCompany>(), byId = new Map<string, WorldCompany>(), byDomain = new Map<string, WorldCompany>();
  for (const c of world.companies) { byKey.set(companyKey(c.name), c); byId.set(c.id, c); if (!c.parent_id) byDomain.set(c.domain, c); }
  for (const c of world.companies) { for (const a of c.aliases) { const k = companyKey(a); if (!byKey.has(k)) byKey.set(k, c); } if (!byDomain.has(c.domain)) byDomain.set(c.domain, c); }
  const employees = new Map<string, WorldPerson[]>(), byName = new Map<string, WorldPerson[]>();
  const mailboxes = new Set<string>(world.meta.shared_mailboxes);
  for (const p of world.people) {
    mailboxes.add(p.email.toLowerCase());
    if (p.company_id) { if (!employees.has(p.company_id)) employees.set(p.company_id, []); employees.get(p.company_id)!.push(p); }
    const k = nameKey(p.full_name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(p);
  }
  const extras = world.people.filter((p) => p.company_id && !p.attending);
  const former = new Map<string, WorldPerson>();
  for (const c of world.companies) {
    if (c.list_status) continue;
    for (let i = 0; i < 20; i++) {
      const p = extras[Math.floor(u(`former${c.id}${i}`) * extras.length)];
      if (p.company_id !== c.id && byId.get(p.company_id!)!.domain !== c.domain) { former.set(c.id, p); break; }
    }
  }
  const idx: WorldIndex = {
    world, byKey, byId, byDomain, employees, byName, mailboxes,
    junk: new Set(world.junk_company_keys), extra: new Set(world.meta.extra_domains), webmail: new Set(world.meta.webmail_domains),
    placeholder: new Set(world.meta.placeholder_domains), former,
  };
  indexes.set(world, idx);
  return idx;
}

let cached: World | null = null;
/** The world written by scripts/gen-world.ts. Throws a clear message when the file is missing. */
export function loadWorld(): World {
  if (cached) return cached;
  try { cached = JSON.parse(readFileSync(new URL("../../samples/world.json", import.meta.url), "utf8")) as World; }
  catch { throw new Error("samples/world.json is missing. Run: node scripts/gen-world.ts"); }
  return cached;
}

/* ---------------------------------------------------------------- vendors */

const TYPO_DOMAINS = new Set(["gmial.com", "gmai.com", "gnail.com", "hotmial.com", "yahooo.com", "outlok.com", "gmail.con", "yahoo.cmo"]);
const REAL_WEBMAIL = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "proton.me"]);

export function simVendors(world: World, s: Settings, opts: SimOpts = {}): Vendors {
  const idx = indexWorld(world);
  const mock = mockVendors(s);
  const calls = new Map<string, number>();
  const audit = opts.audit ?? (() => {});
  /** The call count makes a retry of the same input roll again, so an error does not repeat forever. */
  const attempt = (k: string) => { const n = calls.get(k) ?? 0; calls.set(k, n + 1); return n; };
  const fails = (vendor: string, key: string, rate: number) => {
    if (u(`err|${vendor}|${key}|${attempt(`${vendor}|${key}`)}`) >= rate) return;
    // Some failures are known not to have billed; the rest are not.
    throw new VendorError(u(`errkind|${vendor}|${key}`) < 0.6 ? 0 : "unknown");
  };
  const resolve = (company: string) => { const k = companyKey(company); const c = idx.byKey.get(k); return c ? { c } : idx.junk.has(k) ? { junk: true as const } : null; };

  const finder = (i: number): Vendors["finders"][number] => {
    const f = s.finders[i];
    const r = SIM_RATES.finder[Math.min(i, SIM_RATES.finder.length - 1)];
    return {
      name: f.name, cost: f.cost,
      async find(p) {
        const res = p.full_name ? resolve(p.company) : { junk: true as const };
        if (!res) return mock.finders[i].find(p);
        const key = `${p.full_name}|${p.company}`;
        fails(f.name, key, r.error);
        const done = (klass: SimClass, email: string | null, person: WorldPerson | null) => {
          audit({ vendor: f.name, op: "find", klass, email, truth: person?.email ?? null });
          const verified = email !== null && u(`fver|${email}`) < (klass === "wrong_pattern" ? SIM_RATES.apollo_verified.wrong_pattern : SIM_RATES.apollo_verified.hit);
          return { value: email, charged: f.cost, linkedin: email && person ? person.linkedin : null, apollo_verified: verified };
        };
        if ("junk" in res) return done("miss", null, null);
        const same = idx.byName.get(nameKey(p.full_name!)) ?? [];
        const roll = u(`find|${f.name}|${key}`);
        const atCompany = same.find((x) => x.company_id === res.c.id);
        if (atCompany) {
          if (roll < r.hit) return done("hit", atCompany.email, atCompany);
          if (roll < r.hit + r.wrong_pattern) {
            const other = PATTERNS.filter((x) => x !== res.c.email_pattern).map((x) => `${localPart(x, atCompany.first, atCompany.last)}@${res.c.domain}`).find((e) => e !== atCompany.email)!;
            return done("wrong_pattern", other, atCompany);
          }
          return done("miss", null, atCompany);
        }
        const stale = same.find((x) => x.listed_company_id === res.c.id) ?? same.find((x) => idx.former.get(res.c.id) === x);
        if (stale) return roll < r.stale_match ? done("stale_match", stale.email, stale) : done("miss", null, stale);
        const elsewhere = same[0];
        if (elsewhere && elsewhere.company_id) return roll < r.homonym ? done("homonym", elsewhere.email, elsewhere) : done("miss", null, elsewhere);
        return done("miss", null, null);
      },
    };
  };

  const W = SIM_RATES.waterfall;
  const decodeId = (id: string): { full_name: string; company: string } => JSON.parse(Buffer.from(id.slice(6), "base64url").toString());
  /** The answer is a pure function of the request id, so a poll after a crash reads the same result. */
  const waterfallOutcome = (full_name: string, company: string): WaterfallResult => {
    const none = (credits = 0): WaterfallResult => ({ email: null, linkedin: null, apollo_verified: false, zerobounce_pass: false, credits });
    const res = resolve(company)!;
    if ("junk" in res) return none();
    const key = `${full_name}|${company}`;
    const same = idx.byName.get(nameKey(full_name)) ?? [];
    const atCompany = same.find((x) => x.company_id === res.c.id);
    if (!atCompany) {
      const stale = same.find((x) => x.listed_company_id === res.c.id) ?? same.find((x) => idx.former.get(res.c.id) === x);
      const other = stale ?? same[0];
      if (other && u(`wfstale|${key}`) < (stale ? W.stale_match : W.homonym)) return { email: other.email, linkedin: other.linkedin, apollo_verified: true, zerobounce_pass: true, credits: 2 };
      return none(W.sources.filter((x) => x.charges === "lookup").length);
    }
    let credits = 0;
    let out = none();
    for (const src of W.sources) {
      const hit = u(`wf|${src.name}|${key}`) < src.hit;
      if (hit || src.charges === "lookup") credits += 1;
      if (!hit) continue;
      credits += 1;
      const wrong = u(`wfbad|${src.name}|${key}`) < W.wrong_pattern;
      const address = wrong ? PATTERNS.filter((x) => x !== res.c.email_pattern).map((x) => `${localPart(x, atCompany.first, atCompany.last)}@${res.c.domain}`).find((e) => e !== atCompany.email)! : atCompany.email;
      const pass = u(`wfpass|${src.name}|${key}`) < (wrong ? W.validator.false_pass : W.validator.real);
      out = { email: address, linkedin: atCompany.linkedin, apollo_verified: pass && u(`wfver|${key}`) < W.verified, zerobounce_pass: pass, credits: 0 };
      if (pass) break;
    }
    return { ...out, credits };
  };
  const waterfall: Waterfall = {
    name: s.waterfall.name, reserve: s.waterfall.reserve,
    async start(p) {
      if (!resolve(p.company)) return mock.waterfall!.start(p);
      fails(s.waterfall.name, `${p.full_name}|${p.company}`, W.error);
      return { request_id: `simwf:${Buffer.from(JSON.stringify({ full_name: p.full_name, company: p.company })).toString("base64url")}` };
    },
    async poll(id) {
      if (!id.startsWith("simwf:")) return mock.waterfall!.poll(id);
      if (attempt(`wfpoll|${id}`) < W.pending_polls) return { state: "pending", retry_after_ms: 0 };
      const { full_name, company } = decodeId(id);
      const result = waterfallOutcome(full_name, company);
      audit({ vendor: s.waterfall.name, op: "waterfall", klass: result.email ? "hit" : "miss", email: result.email });
      return { state: "done", result };
    },
  };

  const verifier = (i: number): Vendors["verifiers"][number] => {
    const v = s.verifiers[i];
    const r = SIM_RATES.verifier[Math.min(i, SIM_RATES.verifier.length - 1)];
    return {
      name: v.name, cost: v.cost,
      async verify(email) {
        const e = email.toLowerCase();
        const domain = e.split("@")[1] ?? "";
        const company = idx.byDomain.get(domain);
        const known = company || idx.extra.has(domain) || REAL_WEBMAIL.has(domain) || TYPO_DOMAINS.has(domain) || idx.placeholder.has(domain);
        if (!known) return mock.verifiers[i].verify(email);
        fails(v.name, e, r.error);
        const roll = u(`verify|${v.name}|${e}`);
        const done = (verdict: Verdict, klass: SimClass) => { audit({ vendor: v.name, op: "verify", klass, email: e }); return { verdict, charged: v.cost }; };
        if (TYPO_DOMAINS.has(domain) || idx.placeholder.has(domain)) return done("undeliverable", "correct");
        const real = idx.mailboxes.has(e) || (idx.extra.has(domain) && domain === "pavilionevents.example");
        if (company?.catch_all) return roll < r.catch_all_missed ? done("deliverable", "catch_all_missed") : done("catch_all", "correct");
        if (REAL_WEBMAIL.has(domain) && !real) return done(roll < 0.8 ? "deliverable" : roll < 0.95 ? "undeliverable" : "unknown", "ok");
        if (real) return roll < r.false_undeliverable ? done("undeliverable", "false_undeliverable") : roll < r.false_undeliverable + r.unknown ? done("unknown", "unknown") : done("deliverable", "correct");
        return roll < r.false_deliverable ? done("deliverable", "false_deliverable") : roll < r.false_deliverable + r.unknown ? done("unknown", "unknown") : done("undeliverable", "correct");
      },
    };
  };

  /* -------------------------------------------------------------- identity */
  const IR = SIM_RATES.identity;
  const clockNow = () => (opts.clock ? opts.clock.now() : Date.now());
  const asCandidate = (c: WorldCompany): CompanyCandidate => {
    const parent = c.parent_id ? idx.byId.get(c.parent_id) : null;
    return { name: c.name, domain: c.domain, parent_name: parent?.name ?? null, parent_domain: parent?.domain ?? null, country: c.country, employees: c.employees };
  };
  const keyed = world.companies.map((c) => ({ c, keys: [companyKey(c.name), ...c.aliases.map(companyKey)] }));
  const searchMemo = new Map<string, { c: WorldCompany; best: number }[]>();
  const byEmail = new Map(world.people.map((p) => [p.email.toLowerCase(), p])), byLinkedin = new Map(world.people.map((p) => [p.linkedin, p]));
  let searches = 0, episodeEnd = 0;
  const SIM_PROBE = { query: "Probe Known Co", domain: "probeknownco.example" };

  const identity: Identity = {
    companySearch: {
      name: "company_search_sim", probe: SIM_PROBE,
      async search(query) {
        if (opts.outage?.()) throw new VendorError(0);
        searches++;
        if (opts.throttle) {
          const now = clockNow();
          if (searches % opts.throttle.every === 0 && now >= episodeEnd) episodeEnd = now + opts.throttle.length_ms;
          // The throttle answers everything with an empty success, the known-good lookup included.
          if (now < episodeEnd) { audit({ vendor: "company_search_sim", op: "search", klass: "unknown" }); return { candidates: [], charged: 0 }; }
        }
        if (query === SIM_PROBE.query) return { candidates: [{ name: SIM_PROBE.query, domain: SIM_PROBE.domain }], charged: 0 };
        fails("company_search_sim", query, IR.search_error);
        const k = companyKey(query);
        if (!k || idx.junk.has(k)) return { candidates: [], charged: 0 };
        let scored = searchMemo.get(k);
        if (!scored) {
          scored = [];
          for (const { c, keys } of keyed) {
            if (u(`smiss|${c.id}`) < IR.search_miss) continue;
            let best = 0;
            for (const key of keys) best = Math.max(best, nameScore(k, key));
            if (best >= 0.62) scored.push({ c, best });
          }
          scored.sort((a, b) => b.best - a.best || a.c.id.localeCompare(b.c.id));
          scored = scored.slice(0, 5);
          // The right company left out, only a lookalike returned.
          if (scored.length && scored[0].best >= 0.85 && u(`swrong|${k}`) < IR.search_wrong_top) scored = scored.slice(1);
          searchMemo.set(k, scored);
        }
        return { candidates: scored.map((x) => asCandidate(x.c)), charged: 0 };
      },
    },
    personMatch: {
      name: "person_match_sim", cost: s.research.person_match_cost,
      async match(p) {
        const cost = s.research.person_match_cost;
        fails("person_match_sim", `${p.full_name}|${p.company}`, IR.person.error);
        const same = idx.byName.get(nameKey(p.full_name)) ?? [];
        const ck = companyKey(p.company);
        const roll = u(`pm|${p.full_name}|${p.company}`);
        const result = (x: WorldPerson): PersonMatchResult => {
          const co = x.company_id ? idx.byId.get(x.company_id) : null;
          return { vendor_person_id: x.id, full_name: x.full_name, email: x.email, linkedin: x.linkedin, employer: co?.name ?? null, employer_domain: co?.domain ?? null, title: x.title, email_verified: u(`pmver|${x.id}`) < SIM_RATES.apollo_verified.reveal };
        };
        const score = (x: WorldPerson, id: string | null) => { const co = id ? idx.byId.get(id) : null; return co ? Math.max(...[co.name, ...co.aliases].map((n) => nameScore(ck, companyKey(n)))) : 0; };
        let best: { x: WorldPerson; at: number; listed: number } | null = null;
        for (const x of same) { const at = score(x, x.company_id), listed = score(x, x.listed_company_id); if (!best || Math.max(at, listed) > Math.max(best.at, best.listed)) best = { x, at, listed }; }
        if (!best) { audit({ vendor: "person_match_sim", op: "match", klass: "miss" }); return { person: null, charged: cost }; }
        if (best.at >= 0.8) { const hit = roll < IR.person.hit; audit({ vendor: "person_match_sim", op: "match", klass: hit ? "hit" : "miss", truth: best.x.company_id }); return { person: hit ? result(best.x) : null, charged: cost }; }
        if (best.listed >= 0.8) { const hit = roll < IR.person.stale; audit({ vendor: "person_match_sim", op: "match", klass: hit ? "stale_match" : "miss", truth: best.x.company_id }); return { person: hit ? result(best.x) : null, charged: cost }; }
        const hit = roll < IR.person.homonym;
        audit({ vendor: "person_match_sim", op: "match", klass: hit ? "homonym" : "miss", truth: same[0].company_id });
        return { person: hit ? result(same[0]) : null, charged: cost };
      },
    },
    reverse: {
      name: "reverse_lookup_sim", cost: s.research.reverse_lookup_cost,
      async byEmail(email) {
        const cost = s.research.reverse_lookup_cost, e = email.toLowerCase();
        fails("reverse_lookup_sim", e, IR.reverse.error);
        const domain = e.split("@")[1] ?? "";
        if (REAL_WEBMAIL.has(domain) || TYPO_DOMAINS.has(domain) || idx.placeholder.has(domain)) return { company: null, charged: cost };
        const person = byEmail.get(e);
        const co = person?.company_id ? idx.byId.get(person.company_id) : idx.byDomain.get(domain);
        const hit = co && u(`rev|${e}`) < IR.reverse.work_email;
        audit({ vendor: "reverse_lookup_sim", op: "email", klass: hit ? "hit" : "miss", truth: co?.id ?? null });
        return { company: hit ? asCandidate(co!) : null, charged: cost };
      },
      async byLinkedin(url) {
        const cost = s.research.reverse_lookup_cost;
        fails("reverse_lookup_sim", url, IR.reverse.error);
        const person = byLinkedin.get(url.replace(/\/$/, ""));
        const co = person?.company_id ? idx.byId.get(person.company_id) : null;
        const hit = co && u(`revli|${url}`) < IR.reverse.linkedin;
        audit({ vendor: "reverse_lookup_sim", op: "linkedin", klass: hit ? "hit" : "miss", truth: co?.id ?? null });
        return { company: hit ? asCandidate(co!) : null, charged: cost };
      },
    },
    dns: { async hasMailServer(domain) { return domain.toLowerCase().endsWith(".example"); } },
  };

  return {
    identity,
    firmographics: simFirmographics(world, s),
    website: simWebsite(world),
    peopleSearch: simPeopleSearch(world, opts.asOf, opts),
    reveal: simReveal(world, s),
    discovery: {
      name: "discovery_sim", cost: s.discovery_cost,
      async find(company, limit) {
        const res = resolve(company);
        if (!res) return mock.discovery.find(company, limit);
        fails("discovery_sim", company, SIM_RATES.discovery.error);
        if ("junk" in res) return { people: [], charged: 0 };
        if (u(`dmiss|${res.c.id}`) < SIM_RATES.discovery.miss) { audit({ vendor: "discovery_sim", op: "search", klass: "miss" }); return { people: [], charged: 0 }; }
        const pool = (idx.employees.get(res.c.id) ?? []).filter((p) => p.title_tier !== null && p.title_tier <= 2).sort((a, b) => (a.title_tier! - b.title_tier!) || a.id.localeCompare(b.id));
        const people = pool.slice(0, limit).map((p, n) => {
          const stale = idx.former.get(res.c.id);
          const old = stale && u(`dstale|${res.c.id}|${n}`) < SIM_RATES.discovery.stale_employer;
          const who = old ? stale : p;
          audit({ vendor: "discovery_sim", op: "search", klass: old ? "stale_employer" : "correct", truth: who.company_id });
          return { full_name: who.full_name, title: who.title, linkedin: u(`dli|${who.id}`) < 0.6 ? who.linkedin : null };
        });
        return { people, charged: people.length * s.discovery_cost };
      },
    },
    finders: s.finders.map((_, i) => finder(i)),
    verifiers: s.verifiers.map((_, i) => verifier(i)),
    waterfall,
    linkedin: {
      name: s.linkedin.name, cost: s.linkedin.cost,
      async find(p) {
        const res = p.full_name ? resolve(p.company) : { junk: true as const };
        if (!res) return mock.linkedin.find(p);
        fails(s.linkedin.name, `${p.full_name}|${p.company}`, SIM_RATES.linkedin.error);
        const person = !("junk" in res) && p.full_name ? (idx.byName.get(nameKey(p.full_name)) ?? []).find((x) => x.company_id === res.c.id) : undefined;
        const found = person && u(`li|${person.id}`) < SIM_RATES.linkedin.hit ? person.linkedin : null;
        audit({ vendor: s.linkedin.name, op: "linkedin", klass: found ? "hit" : "miss", truth: person?.linkedin ?? null });
        return { value: found, charged: s.linkedin.cost, verified_email: person && p.email?.toLowerCase() === person.email.toLowerCase() && u(`liver|${person.id}`) < SIM_RATES.apollo_verified.lookup ? person.email : null };
      },
    },
  };
}

/* ----------------------------------------------------------- people search */

const shiftDay = (ymd: string, days: number) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);

/** Free search by domain, from the world's staff: everyone who works there, in the vendor's own order, with the failures in SIM_RATES.people. */
export function simPeopleSearch(world: World, asOf: string = today(), opts: SimOpts = {}): PeopleSearch {
  const idx = indexWorld(world);
  const R = SIM_RATES.people;
  const calls = new Map<string, number>();
  let searches = 0, episodeEnd = 0;
  const PROBE = { domain: "probeknownco.example", company: "Probe Known Co" };
  return {
    name: "people_search_sim", probe: PROBE,
    async search(q) {
      searches++;
      if (opts.peopleThrottle) {
        const now = opts.clock ? opts.clock.now() : Date.now();
        if (searches % opts.peopleThrottle.every === 0 && now >= episodeEnd) episodeEnd = now + opts.peopleThrottle.length_ms;
        // Silent throttling: an empty success for everything, the known-good lookup included.
        if (now < episodeEnd) return { people: [], charged: 0 };
      }
      if (q.domain === PROBE.domain) return { people: [{ vendor_person_id: "probe_1", first_name: "Probe", last_name: "Person", title: "VP Sales", linkedin: null, updated_at: asOf, has_email: true }], charged: 0 };
      const c = idx.byDomain.get(q.domain.toLowerCase());
      if (!c) return mockPeopleSearchFor(q);
      const n = calls.get(c.id) ?? 0; calls.set(c.id, n + 1);
      if (u(`perr|${c.id}|${n}`) < R.error) throw new VendorError(0);
      if (u(`pmiss|${c.id}`) < R.miss) return { people: [], charged: 0 };
      const staff = (idx.employees.get(c.id) ?? []).slice().sort((a, b) => u(`pord|${c.id}|${a.id}`) - u(`pord|${c.id}|${b.id}`));
      const people: FoundPerson[] = staff.slice(0, q.limit).map((p, i) => {
        const old = idx.former.get(c.id);
        const who = old && u(`pstale|${c.id}|${i}`) < R.stale_employer ? old : p;
        const age = Math.floor(u(`page|${who.id}`) * 160) + (u(`pold|${who.id}`) < R.stale_record ? 190 : 0);
        return {
          vendor_person_id: who.id, first_name: who.first, last_name: u(`phide|${who.id}`) < R.hidden_last_name ? null : who.last,
          title: who.title || null, linkedin: null, updated_at: shiftDay(asOf, age), has_email: u(`pmail|${who.id}`) < R.has_email ? true : (u(`pmail2|${who.id}`) < 0.5 ? false : null), country: c.country,
        };
      });
      return { people, charged: 0 };
    },
  };
}
const mockPeopleSearchFor: PeopleSearch["search"] = (q) => mockVendors(defaultsForSim()).peopleSearch!.search(q);
let defaultsCache: Settings | null = null;
function defaultsForSim(): Settings {
  if (!defaultsCache) defaultsCache = JSON.parse(readFileSync(new URL("../../config/defaults.json", import.meta.url), "utf8")) as Settings;
  return defaultsCache;
}

let worldTitlesCache: Record<string, { function: string; seniority: string; non_buyer: boolean }> | null = null;
/** The hand labels for the world's titles (samples/world-titles.json): function, seniority, non_buyer. */
export function loadWorldTitles() {
  if (!worldTitlesCache) {
    try { worldTitlesCache = JSON.parse(readFileSync(new URL("../../samples/world-titles.json", import.meta.url), "utf8")); }
    catch { throw new Error("samples/world-titles.json is missing. Run: node scripts/gen-world-titles.ts"); }
  }
  return worldTitlesCache!;
}

/** The reveal, from the world: the person's real address, LinkedIn and CURRENT employer. A person the search listed at a company they have left comes back with the
    new employer, which is what the employment check catches. Hit and error rates are authored (`SIM_RATES.reveal`). */
export function simReveal(world: World, s: Settings): Reveal {
  const idx = indexWorld(world);
  const byId = new Map(world.people.map((p) => [p.id, p]));
  const mock = mockVendors(s).reveal!;
  const cost = s.outreach?.reveal_cost ?? s.finders[0]?.cost ?? 1;
  const calls = new Map<string, number>();
  return {
    name: "reveal_sim", cost,
    async reveal(q) {
      const p = byId.get(q.vendor_person_id);
      if (!p) return mock.reveal(q);
      const n = calls.get(p.id) ?? 0; calls.set(p.id, n + 1);
      if (u(`rverr|${p.id}|${n}`) < SIM_RATES.reveal.error) throw new VendorError(u(`rverrk|${p.id}`) < 0.6 ? 0 : "unknown");
      // A paid call bills whether or not it finds the person.
      if (u(`rvhit|${p.id}`) >= SIM_RATES.reveal.hit) return { person: null, charged: cost };
      const co = p.company_id ? idx.byId.get(p.company_id) : null;
      // The detail a real reveal carries, simulated from the world: the hand label for the title gives seniority and department, the employer gives the country,
      // and the start of the current role is a deterministic month between half a year and seven years back. Simulated values, in the simulator only.
      const label = loadWorldTitles()[p.title.toLowerCase()];
      const months = 6 + Math.floor(u(`rvsince|${p.id}`) * 78);
      const since = new Date(`${today()}T00:00:00Z`); since.setUTCMonth(since.getUTCMonth() - months);
      return {
        person: {
          vendor_person_id: p.id, full_name: p.full_name, email: p.email, email_verified: u(`rvver|${p.id}`) < SIM_RATES.apollo_verified.reveal, linkedin: p.linkedin, employer: co?.name ?? null, employer_domain: co?.domain ?? null, title: p.title,
          location: co?.country ?? null, seniority: label?.seniority ?? null, departments: label ? [label.function] : null, role_since: since.toISOString().slice(0, 7),
        },
        charged: cost,
      };
    },
  };
}

/* ------------------------------------------------------------ firmographics */

const customersPhrase = (m: string) => (m === "B2C" ? "consumers" : m === "B2B2C" ? "businesses and consumers" : "business customers");
/** What a vendor's description of the company would say. It names the sector and the customers, never the tier. */
const describeCompany = (c: WorldCompany) => `${c.name} provides ${c.industry.toLowerCase()} to ${customersPhrase(c.business_model)}.`;

/** The vendor's view of a world company: the truth, minus what it lacks, plus a few wrong headcounts. Rates are in SIM_RATES.firmo. */
export function simFirmographics(world: World, s: Settings): FirmographicsLookup {
  const idx = indexWorld(world);
  const mock = mockVendors(s).firmographics!;
  const R = SIM_RATES.firmo;
  const calls = new Map<string, number>();
  const view = (c: WorldCompany) => {
    const noisy = u(`fnoise|${c.id}`) < R.employees_noise;
    const employees = noisy ? Math.max(1, Math.round(c.employees * (u(`fnoisek|${c.id}`) < 0.5 ? 0.5 : 1.6))) : c.employees;
    return { employees, industry: c.industry, business_model: c.business_model, country: c.country, description: describeCompany(c) } as Record<string, string | number>;
  };
  // Facts a real vendor returns on the same free search and no tier rule reads: founding year and annual revenue, simulated from the headcount. Simulator only.
  const detail = (c: WorldCompany): Record<string, number> => {
    const out: Record<string, number> = {};
    if (u(`fdfound|${c.id}`) < 0.8) out.founded = 1978 + Math.floor(u(`fdyear|${c.id}`) * 45);
    if (u(`fdrev|${c.id}`) < 0.65) { const perHead = 90_000 + Math.floor(u(`fdph|${c.id}`) * 170_000); const raw = c.employees * perHead; out.revenue = Number(raw.toPrecision(3)); }
    return out;
  };
  const maybeFail = (domain: string) => {
    const n = calls.get(domain) ?? 0; calls.set(domain, n + 1);
    if (u(`ferr|${domain}|${n}`) < R.error) throw new VendorError(u(`ferrk|${domain}`) < 0.6 ? 0 : "unknown");
  };
  return {
    name: "firmographics_sim", cost: s.research.firmographics_cost,
    async search(domain, name) {
      const c = idx.byDomain.get(domain.toLowerCase());
      if (!c) return mock.search(domain, name);
      maybeFail(domain);
      if (u(`fnone|${c.id}`) < R.none) return { firmo: null, charged: 0 };
      const v = view(c), out: Record<string, unknown> = { ...detail(c) };
      for (const f of Object.keys(R.search) as (keyof typeof R.search)[]) if (u(`fs|${c.id}|${f}`) < R.search[f]) out[f] = v[f];
      return { firmo: cleanFirmo(out), charged: 0 };
    },
    async enrich(domain, name) {
      const c = idx.byDomain.get(domain.toLowerCase());
      if (!c) return mock.enrich(domain, name);
      maybeFail(domain);
      // A paid call bills whether or not it finds the company.
      if (u(`fnone|${c.id}`) < R.none) return { firmo: null, charged: s.research.firmographics_cost };
      const v = view(c), out: Record<string, unknown> = { ...detail(c) };
      for (const f of Object.keys(R.enrich) as (keyof typeof R.enrich)[]) if (u(`fs|${c.id}|${f}`) < R.search[f as keyof typeof R.search] || u(`fe|${c.id}|${f}`) < R.enrich[f]) out[f] = v[f];
      return { firmo: cleanFirmo(out), charged: s.research.firmographics_cost };
    },
  };
}

/** The company's own site, as text. It says what the company does and who it sells to, and nothing about headcount. */
export function simWebsite(world: World): WebsiteReader {
  const idx = indexWorld(world);
  return {
    name: "website_sim",
    async read(domain) {
      const c = idx.byDomain.get(domain.toLowerCase());
      if (!c) return domain.endsWith(".example") ? `Welcome to ${domain.split(".")[0]}. We build products for businesses.` : null;
      if (u(`fweb|${c.id}`) < SIM_RATES.firmo.website_none) return null;
      return `${c.name}. We provide ${c.industry.toLowerCase()}. Customers: ${customersPhrase(c.business_model)}. Contact us for a demo.`;
    },
  };
}

/* ------------------------------------------------------------------ model */

const fieldOf = (input: string, label: string) => input.split("\n").find((l) => l.toLowerCase().startsWith(`${label.toLowerCase()}:`))?.slice(label.length + 1).trim() ?? "";
const REASON_FOR = { 1: "icp_match", 2: "partial_icp_match", 3: "outside_icp" } as const;
const MASH = /^(.)\1{2,}$|^(asdf|qwer|xxx|jkl|sdf|zzz|hhh|aaa)/i;

/* The sector a reader would put a company in, from the words of its industry and description. */
const SECTORS: [string, RegExp][] = [
  ["agency", /agency|media buying|creative studio/],
  ["consultancy", /consult|advisory services/],
  ["payments", /payment|merchant|treasury|invoicing|settlement/],
  ["logistics technology", /logistic|freight|fleet|telematics|warehouse|supply chain/],
  ["software", /software|saas|cloud|data platform|workflow|platform/],
];
const STRONG = new Set(["software", "logistics technology", "payments"]);
const SEGMENT_OF: Record<string, string | null> = { software: "software", "logistics technology": "logistics_technology", payments: "payments", agency: "agencies", consultancy: "consultancies", other: null };
const TYPE_OF: Record<string, string | null> = { software: "software_vendor", "logistics technology": "logistics_technology_provider", payments: "payments_provider", agency: "agency", consultancy: "consultancy", other: null };
const FACT_LABELS = /^(employees|industry|sells to|description|from its own website):/i;

/** Applies the seller's tier rule to the facts it was handed. Returns the tier a careful reader would give, and whether the facts decide it. */
function readFacts(input: string) {
  const lines = input.split("\n").map((l) => l.trim()).filter(Boolean);
  const val = (label: string) => lines.find((l) => l.toLowerCase().startsWith(`${label.toLowerCase()}:`))?.slice(label.length + 1).trim() ?? "";
  const emp = val("Employees").replace(/[,\s]/g, "").match(/^\d+/)?.[0];
  const employees = emp ? Number(emp) : null;
  const industry = val("Industry"), sells = val("Sells to"), text = `${val("Description")} ${val("From its own website")}`.toLowerCase();
  let bm: "B2B" | "B2C" | "B2B2C" | null = null;
  const sellsLower = sells.toLowerCase();
  if (sellsLower) bm = /b2b2c|and consumers|both/.test(sellsLower) ? "B2B2C" : /consumer|b2c/.test(sellsLower) ? "B2C" : /business|b2b/.test(sellsLower) ? "B2B" : null;
  if (!bm && text) bm = /businesses and consumers/.test(text) ? "B2B2C" : /customers: consumers|to consumers|consumers\./.test(text) ? "B2C" : /business/.test(text) ? "B2B" : null;
  const sectorText = `${industry} ${text}`.toLowerCase().trim();
  const sector = sectorText ? (SECTORS.find(([, re]) => re.test(sectorText))?.[0] ?? "other") : null;
  const strong = sector ? STRONG.has(sector) : false;
  const inRange = employees === null ? null : employees >= 200 && employees <= 5000;
  // What the rule gives with every deciding fact in hand, and with the missing ones assumed favorable.
  let certain = true;
  let tier: 1 | 2 | 3;
  if (bm === "B2C") tier = 3;
  else if (sector === "agency" || sector === "consultancy") tier = 3;
  else if (!sector) { certain = false; tier = 2; }
  else {
    if (bm === null) certain = false;
    if (inRange === null) certain = false;
    const range = inRange ?? true;
    tier = strong && range ? 1 : strong || range ? 2 : 3;
  }
  const fact = employees !== null ? `Employees: ${emp}` : lines.find((l) => /^industry:/i.test(l)) ?? lines.find((l) => /^sells to:/i.test(l)) ?? lines.find((l) => /^(description|from its own website):/i.test(l)) ?? null;
  const exact = lines.find((l) => l.toLowerCase().startsWith("employees:")) ?? fact;
  return { tier, certain, sector, fact: employees !== null ? exact : fact, any: lines.some((l) => FACT_LABELS.test(l)) };
}

/** A deterministic model. With no facts under INPUT it answers from the world's truth by company name, as it always did (the single-card flow).
    With facts it reads them and applies the seller's tier rule, with the errors in SIM_RATES.tier: it sees only what it is handed, so a missing
    headcount or business model makes it say unknown, or guess. A second instance with another `salt` rolls independently, as a second model would. */
export function simLlm(world: World, opts: { salt?: string } = {}): Llm {
  const idx = indexWorld(world);
  const r = SIM_RATES.llm, T = SIM_RATES.tier;
  const salt = opts.salt ?? "";
  return {
    model: salt ? `sim-deterministic-${salt}` : "sim-deterministic",
    simulated: true,
    async complete(step, prompt, hint) {
      if (step === "perspective") return draftReply(hint);
      const input = prompt.slice(prompt.lastIndexOf("INPUT") + 5).trim();
      const out = (o: unknown) => ({ text: JSON.stringify(o), input_tokens: 0, output_tokens: 0 });
      if (step === "title_parse") {
        const title = fieldOf(input, "Title");
        const truth = loadWorldTitles()[title.toLowerCase()];
        const rules = parseTitle(title);
        const base = truth ?? { function: rules.function ?? "other", seniority: rules.seniority ?? "individual", non_buyer: rules.non_buyer };
        const key = `${salt}|tp|${title.toLowerCase()}`;
        let fn = base.function, sen = base.seniority;
        if (u(`${key}|fn`) < SIM_RATES.people.title_function_wrong) { const others = FUNCTIONS.filter((f) => f !== fn); fn = others[Math.floor(u(`${key}|fnk`) * others.length)]; }
        if (u(`${key}|sen`) < SIM_RATES.people.title_seniority_off) { const i = SENIORITIES.indexOf(sen as never); sen = SENIORITIES[Math.min(SENIORITIES.length - 1, Math.max(0, i + (u(`${key}|sd`) < 0.5 ? -1 : 1)))]; }
        return out({ function: fn, seniority: sen, non_buyer: base.non_buyer });
      }
      if (step === "website_read") {
        const page = prompt.slice(prompt.lastIndexOf("<<<PAGE") + 7, prompt.lastIndexOf("PAGE>>>")).replace(/\s+/g, " ").trim();
        return out({ description: page.slice(0, 300) });
      }
      if (step === "company_tier" && readFacts(input).any) {
        const f = readFacts(input);
        const roll = (k: string) => u(`${salt}|${step}|${k}|${input}`);
        const unknown = () => out({ tier: "unknown", segment: null, company_type: null, reason: "insufficient_information", fact: null });
        let tier = f.tier;
        if (f.certain) {
          if (roll("obscure") < T.unknown_though_decisive) return unknown();
          if (roll("off") < T.off_by_one) tier = (tier === 2 ? (roll("dir") < 0.5 ? 1 : 3) : 2) as 1 | 2 | 3;
        } else if (roll("guess") >= T.guess_when_missing) return unknown();
        const sector = f.sector ?? "other";
        const fact = roll("fab") < T.fabricated_fact ? "Annual revenue: 40 million" : f.fact;
        return out({ tier, segment: SEGMENT_OF[sector] ?? null, company_type: TYPE_OF[sector] ?? null, reason: REASON_FOR[tier], fact });
      }
      if (step === "company_tier") {
        const name = fieldOf(input, "Company");
        const k = companyKey(name);
        const c = idx.byKey.get(k);
        if (c) {
          const roll = u(`ct|${c.id}`);
          if (roll < r.company_obscure) return out({ tier: 2, reason: "insufficient_information" });
          let tier: number = c.tier;
          if (roll < r.company_obscure + r.company_off_by_one) tier = c.tier === 2 ? (u(`ct2|${c.id}`) < 0.5 ? 1 : 3) : 2;
          return out({ tier, reason: tier === c.tier ? REASON_FOR[c.tier] : REASON_FOR[tier as 1 | 2 | 3] });
        }
        if (idx.junk.has(k)) return out(u(`cj|${k}`) < 0.7 ? { tier: 3, reason: "insufficient_information" } : { tier: 2, reason: "insufficient_information" });
      }
      if (step === "title_tier") {
        const truth = world.titles[fieldOf(input, "Title").toLowerCase()];
        if (truth) {
          const off = u(`tt|${input}`) < r.title_off;
          const tier = off ? (truth === 2 ? 1 : 2) : truth;
          return out({ tier, reason: tier === 1 ? "decision_maker" : tier === 2 ? "influencer" : "not_relevant" });
        }
      }
      if (step === "review") {
        const name = fieldOf(input, "Name"), company = fieldOf(input, "Company");
        const flags: string[] = [];
        const c = idx.byKey.get(companyKey(company));
        const person = (idx.byName.get(nameKey(name)) ?? []).find((p) => p.company_id === c?.id || p.listed_company_id === c?.id);
        if (MASH.test(name.split(" ")[0] ?? "")) flags.push("name_looks_wrong");
        else if (person && person.listed_company_id === c?.id && !person.there) { if (u(`rv|${person.id}`) < r.review_recall) flags.push("likely_left_company"); }
        else if (person && person.kind !== "employee" && u(`rv|${person.id}`) < r.review_recall) flags.push("title_company_mismatch");
        else if (!person && c && u(`rvfp|${input}`) < r.review_false_positive) flags.push("title_company_mismatch");
        if (c || flags.length || idx.byName.has(nameKey(name))) return out({ flags });
      }
      return mockLlm.complete(step, prompt);
    },
  };
}

/* -------------------------------------------------------------------- CRM */

/** A CRM that knows the world by domain. Its heat and deals are the mock's; its account type is the world's customers, plus a few the exclusion list does not carry (a stated rate).
    Its do not contact data is a fixed share of the world's people, in memory, and a write changes only that memory. It stands in for Salesforce, which is not connected. */
export function simCrm(world: World = loadWorld()): Crm {
  const idx = indexWorld(world);
  const R = SIM_RATES.crm;
  const byEmail = new Map<string, CrmRecord[]>(), byNameAt = new Map<string, CrmRecord[]>();
  const put = (m: Map<string, CrmRecord[]>, k: string, r: CrmRecord) => { if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); };
  const nameAt = (name: string, domain: string) => `${nameKey(name)}|${domain.toLowerCase()}`;
  for (const p of world.people) {
    if (u(`crmfile|${p.id}`) >= R.on_file) continue;
    const domain = p.company_id ? idx.byId.get(p.company_id)?.domain ?? null : null;
    const rec = (id: string, object: CrmRecord["object"], email: string | null) => {
      const r: CrmRecord = { id, object, email, email_opt_out: u(`crmoo|${id}`) < R.email_opt_out, do_not_contact: u(`crmdnc|${id}`) < R.do_not_contact, do_not_call: u(`crmcall|${id}`) < R.do_not_call,
        bounced_at: email && u(`crmbnc|${id}`) < R.bounced ? `${shiftDay(today(), Math.floor(u(`crmbd|${id}`) * 20))}T09:00:00Z` : null };
      if (email) put(byEmail, email.toLowerCase(), r);
      if (domain) put(byNameAt, nameAt(p.full_name, domain), r);
    };
    rec(`sim_con_${p.id}`, "Contact", p.email);
    if (u(`crmlead|${p.id}`) >= R.second_record) continue;
    const kind = u(`crmaddr|${p.id}`);
    rec(`sim_led_${p.id}`, "Lead", kind < R.blank_email ? null : kind < R.blank_email + R.other_address ? `old.${p.email}` : p.email);
  }
  const accountOf = (domain: string | null, name: string | null) => (domain ? idx.byDomain.get(domain.toLowerCase()) : undefined) ?? (name ? idx.byKey.get(companyKey(name)) : undefined);
  return {
    name: "crm_sim",
    connected: true,
    lookup: (company, asOf) => mockCrm.lookup(company, asOf),
    async lookupByDomain(domain, company, asOf) {
      const base = await mockCrm.lookup(company, asOf);
      const c = idx.byDomain.get(domain.toLowerCase());
      const type: AccountType = c?.list_status === "existing_customer" ? "customer" : c?.list_status === "excluded" ? "competitor" : c && u(`crmcust|${domain}`) < SIM_RATES.identity.crm_unlisted_customer ? "customer" : u(`crmtype|${domain}`) < 0.3 ? "prospect" : "none";
      return { ...base, account_type: type };
    },
    async personFlags(people) {
      const out: Record<string, CrmRecord[]> = {};
      for (const p of people) {
        const domain = accountOf(p.domain, p.company)?.domain ?? p.domain;
        const hits = [...(p.email ? byEmail.get(p.email.toLowerCase()) ?? [] : []), ...(p.full_name && domain ? byNameAt.get(nameAt(p.full_name, domain)) ?? [] : [])];
        out[p.ref] = hits.filter((r, i) => hits.findIndex((x) => x.id === r.id) === i);
      }
      return out;
    },
    async accountFlags(accounts) {
      const out: Record<string, { do_not_prospect: boolean }> = {};
      for (const a of accounts) { const c = accountOf(a.domain, a.name); out[a.ref] = { do_not_prospect: Boolean(c && !c.list_status && u(`crmdnp|${c.id}`) < R.do_not_prospect) }; }
      return out;
    },
    async write(record, patch) { Object.assign(record, patch); if (patch.email) put(byEmail, patch.email.toLowerCase(), record); },
  };
}

/** The pair the demo and the sample workbook run with. */
export function simDeps(world: World = loadWorld(), opts: SimOpts = {}): Deps {
  return { llm: simLlm(world), vendorsFor: (s) => simVendors(world, s, opts), crm: simCrm(world) };
}
