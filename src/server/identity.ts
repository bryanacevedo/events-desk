/* Company identity (docs/TIERING-AND-ENRICHMENT.md, "Layer 1"): who is this company, as a confirmed
   primary domain, with its parent when known.

   Three parts:
   - `resolveCompany`: the evidence order for one company, against the vendor seams, behind a guard
     (rate limit, circuit breaker, throttling probe). It has no database and no ledger: what it may
     spend and what it stores are handed in, so the same code runs in the pipeline and in the
     measurements.
   - the free pass before the Research card, from the file's own evidence;
   - the database half of stage 4: reverse lookups, merging rows that resolve to one domain, the
     domain gates, parent handling, and the CRM read by domain.

   An outage is never "not found": a vendor that is down or throttling raises VendorDown, and the
   caller waits or pauses the event. */

import { resolveMx, resolve4 } from "node:dns/promises";
import type { Db } from "./db.ts";
import { VendorDown, type VendorHealth } from "./vendor-health.ts";
import type { CompanyCandidate, Crm, Dns, Identity, PersonMatchResult } from "./providers.ts";
import { openCase } from "./cases.ts";
import { dropAtCompany, enqueue } from "./work.ts";
import { logActivity, newId } from "./events.ts";
import { mapNameToDomain, MISS_DAYS } from "./caches.ts";
import { checkAccounts, crmConnected } from "./crm-checks.ts";
import { adoptFromParent } from "./inherit.ts";
import { companyKey } from "../shared/ingest.ts";
import { isFreeWebmail, isPlaceholderDomain, nameSet, resemblesDomain } from "../shared/layer0.ts";
import { companyDomain, emailDomainChoice, employerMatches, IDENTITY, splitName, weigh, type FileEvidence } from "../shared/identity.ts";
import type { Settings } from "../shared/cost.ts";

/* -------------------------------------------------------------------- DNS */

/** Mock and simulated domains all end in .example and have a mail server by definition. Nothing here touches a network. */
export const exampleDns: Dns = { async hasMailServer(domain) { return domain.toLowerCase().endsWith(".example"); } };

/** The real check, used in live mode only: an MX record, or failing that an address record. */
export const systemDns: Dns = {
  async hasMailServer(domain) {
    try { return (await resolveMx(domain)).length > 0; } catch { /* no MX */ }
    try { return (await resolve4(domain)).length > 0; } catch { return false; }
  },
};

/* -------------------------------------------------------------- the stores */

/** What a person match returned, by what was asked, so the same question is never bought twice. A miss is remembered too. */
export interface RevealStore {
  /** `fetched_at` and `age_days` say how old the stored record is. Absent on the in-memory store. */
  find(vendor: string, queryKey: string): Promise<{ person: PersonMatchResult | null; fetched_at?: string; age_days?: number; event_id?: string | null } | null>;
  put(vendor: string, queryKey: string, person: PersonMatchResult | null): Promise<void>;
}

export function memoryReveals(): RevealStore & { size(): number } {
  const m = new Map<string, PersonMatchResult | null>();
  return {
    async find(v, k) { return m.has(`${v}|${k}`) ? { person: m.get(`${v}|${k}`)! } : null; },
    async put(v, k, p) { m.set(`${v}|${k}`, p); },
    size: () => m.size,
  };
}

/** Stored reveals and person matches. A found person older than `freshness_days`, by `reveals.fetched_at`, is treated as absent; a miss is remembered for 30 days. */
export function dbReveals(db: Db, freshnessDays = 180, eventId: string | null = null): RevealStore {
  return {
    async find(vendor, queryKey) {
      const [r] = await db.query<{ reveal_id: string | null; data: PersonMatchResult | null; fetched_at: string; age_days: number; event_id: string | null }>(
        `SELECT q.reveal_id, r.data, coalesce(r.fetched_at, q.created_at)::text AS fetched_at, coalesce(r.event_id, q.event_id) AS event_id, extract(epoch FROM now() - coalesce(r.fetched_at, q.created_at))::float / 86400 AS age_days
         FROM reveal_queries q LEFT JOIN reveals r ON r.id = q.reveal_id
         WHERE q.vendor = $1 AND q.query_key = $2
           AND ((q.reveal_id IS NULL AND q.created_at > now() - ($3::text || ' days')::interval) OR r.fetched_at > now() - ($4::text || ' days')::interval)`, [vendor, queryKey, String(MISS_DAYS), String(freshnessDays)]);
      if (!r) return null;
      return { person: r.reveal_id ? (r.data as PersonMatchResult) : null, fetched_at: r.fetched_at, age_days: r.age_days, event_id: r.event_id };
    },
    async put(vendor, queryKey, person) {
      await db.tx(async (q) => {
        let id: string | null = null;
        if (person) {
          const [row] = await q<{ id: string }>(
            `INSERT INTO reveals (id, vendor, vendor_person_id, email, employer, linkedin, data, event_id) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
             ON CONFLICT (vendor, vendor_person_id) DO UPDATE SET email = EXCLUDED.email, employer = EXCLUDED.employer, linkedin = EXCLUDED.linkedin, data = EXCLUDED.data, event_id = EXCLUDED.event_id, fetched_at = now()
             RETURNING id`, [newId("rev"), vendor, person.vendor_person_id, person.email, person.employer, person.linkedin, JSON.stringify(person), eventId]);
          id = row.id;
        }
        await q("INSERT INTO reveal_queries (vendor, query_key, reveal_id, event_id) VALUES ($1, $2, $3, $4) ON CONFLICT (vendor, query_key) DO UPDATE SET reveal_id = EXCLUDED.reveal_id, event_id = EXCLUDED.event_id, created_at = now()", [vendor, queryKey, id, eventId]);
      });
    },
  };
}

/* ------------------------------------------------------------- resolving */

export interface ResolveInput {
  key: string; name: string; evidence: FileEvidence[];
  /** People filed under this company, best first. Only a full name is needed. */
  people: { full_name: string; title?: string | null }[];
}
export type PersonMatchPay = (run: () => Promise<{ value: PersonMatchResult | null; charged: number }>) => Promise<{ kind: "ok"; value: PersonMatchResult | null } | { kind: "refused" } | { kind: "error" }>;
export interface ResolveEnv {
  health: VendorHealth; identity: Identity; country: string | null;
  domainsForName?: (key: string) => Promise<string[]>;
  reveals?: RevealStore;
  /** Pays for one person match. Absent in a measurement without a ledger, where the call is simply made. */
  pay?: PersonMatchPay;
  /** The step the call must be refused at before it is paid for, so a down vendor never costs a reservation. */
  beforePay?: () => void;
  /** A stored person match answered instead of a paid one. Told only when it found someone: a stored miss saved nothing, because a miss is free on the vendor. */
  onReused?: (fetchedAt: string, eventId: string | null) => Promise<void>;
}
export interface Resolution {
  state: "resolved" | "ambiguous" | "not_found";
  domain?: string; via?: string; parent_name?: string | null; parent_domain?: string | null;
  candidates?: { name: string; domain: string; score: number; country?: string | null }[];
  /** What happened to the one allowed person match. */
  person_match: "none" | "reused" | "paid" | "refused" | "error";
  note?: string;
}

const done = (r: Omit<Resolution, "person_match"> & { person_match?: Resolution["person_match"] }): Resolution => ({ person_match: "none", ...r });
const fromCandidate = (c: CompanyCandidate, via: string) => done({ state: "resolved", domain: c.domain, via, parent_name: c.parent_name ?? null, parent_domain: c.parent_domain ?? null });

/** Company search behind the guard. An empty answer is final only after the known-good lookup still works; if it does not, the vendor is throttling and this throws VendorDown. */
export async function guardedSearch(env: Pick<ResolveEnv, "health" | "identity" | "country">, query: string): Promise<CompanyCandidate[]> {
  const cs = env.identity.companySearch;
  const g = env.health.guard(cs.name);
  const r = await g.call(() => cs.search(query, { country: env.country }));
  if (!r.candidates.length) await g.confirmEmpty(async () => (await cs.search(cs.probe.query, {})).candidates.some((c) => c.domain === cs.probe.domain));
  return r.candidates;
}

export async function resolveCompany(env: ResolveEnv, input: ResolveInput): Promise<Resolution> {
  const { key, name, evidence } = input;
  const dns = env.identity.dns;

  // 1. A work email domain that resembles the name and has a mail server. Free; normally done before the card.
  const free = emailDomainChoice(key, evidence);
  if (free && (await dns.hasMailServer(free.domain))) return done({ state: "resolved", domain: free.domain, via: "email_domain" });

  // The name-to-domain map: one fresh answer for this name is used without asking a vendor.
  const cached = (await env.domainsForName?.(key)) ?? [];
  if (cached.length === 1) return done({ state: "resolved", domain: cached[0], via: "cache" });

  // 2. Company search by name, free.
  const topEmail = [...evidence].filter((e) => e.source === "email_domain" && !isFreeWebmail(e.value) && !isPlaceholderDomain(e.value)).sort((a, b) => b.rows - a.rows)[0]?.value ?? null;
  const cands = await guardedSearch(env, name);
  const w = weigh(key, cands, { country: env.country, emailDomain: topEmail, candidateKey: companyKey });
  if (w.state === "resolved" && w.chosen) return fromCandidate(w.chosen, w.via ?? "search");

  // 5 (free, so before the paid step). The form's website, only if it resolves and nothing stronger disagrees.
  const site = evidence.filter((e) => e.source === "form_website").sort((a, b) => b.rows - a.rows)[0]?.value ?? null;
  const close = w.close.map((x) => x.c.domain);
  if (site && (await dns.hasMailServer(site))) {
    const stronger = w.close[0] && w.best >= IDENTITY.strong && w.close[0].c.domain !== site && !close.includes(site);
    if (close.includes(site)) return fromCandidate(w.close.find((x) => x.c.domain === site)!.c, "search+website");
    if (!stronger) return done({ state: "resolved", domain: site, via: "form_website" });
  }

  // 3. One person match, only when the free evidence failed.
  const who = input.people.map((p) => ({ p, n: splitName(p.full_name) })).find((x) => x.n);
  let pm: Resolution["person_match"] = "none";
  if (who?.n) {
    const pmv = env.identity.personMatch;
    const g = env.health.guard(pmv.name);
    const qk = `pm|${nameSet(who.p.full_name)}|${key}`;
    const stored = await env.reveals?.find(pmv.name, qk);
    let person: PersonMatchResult | null = null;
    if (stored) { person = stored.person; pm = "reused"; if (person && stored.fetched_at) await env.onReused?.(stored.fetched_at, stored.event_id ?? null); }
    else {
      env.beforePay?.();
      g.assertAvailable();
      const run = async () => { const o = await g.call(() => pmv.match({ first: who.n!.first, last: who.n!.last, full_name: who.p.full_name, company: name, title: who.p.title ?? null }), { paid: true }); return { value: o.person, charged: o.charged }; };
      const paid = env.pay ? await env.pay(run) : ({ kind: "ok", value: (await run()).value } as const);
      if (paid.kind === "refused") return done({ state: w.state === "ambiguous" ? "ambiguous" : "not_found", person_match: "refused", note: "The person match was not run: the Research card's limit for it was reached.", ...(w.state === "ambiguous" ? { candidates: w.close.map((x) => ({ name: x.c.name, domain: x.c.domain, score: x.score, country: x.c.country })) } : {}) });
      if (paid.kind === "error") pm = "error";
      else { person = paid.value; pm = "paid"; await env.reveals?.put(pmv.name, qk, person); }
    }
    const dom = companyDomain(person?.employer_domain);
    // The vendor is known to return the right name at the wrong company, so the employer has to be the row's company.
    if (person?.employer && dom && employerMatches(key, companyKey(person.employer)) && (await dns.hasMailServer(dom))) {
      const sibling = w.close.find((x) => x.c.domain === dom);
      return { ...(sibling ? fromCandidate(sibling.c, "person_match") : done({ state: "resolved", domain: dom, via: "person_match" })), person_match: pm };
    }
  }

  if (w.state === "ambiguous") return done({ state: "ambiguous", person_match: pm, candidates: w.close.map((x) => ({ name: x.c.name, domain: x.c.domain, score: Number(x.score.toFixed(2)), country: x.c.country })) });
  return done({ state: "not_found", person_match: pm });
}

/* ------------------------------------------------------ before the card */

/** Mail-server checks for every domain the free pass could use, made before the transaction so a slow lookup never holds one open. */
export async function mailServers(q: Db["query"], eventId: string, dns: Dns): Promise<Map<string, boolean>> {
  const rows = await q<{ key: string; identity_evidence: FileEvidence[] }>("SELECT key, identity_evidence FROM companies WHERE event_id = $1 AND inherited_from IS NULL", [eventId]);
  const domains = new Set<string>();
  for (const r of rows) { const c = emailDomainChoice(r.key, r.identity_evidence ?? []); if (c) domains.add(c.domain); }
  const out = new Map<string, boolean>();
  await Promise.all([...domains].map(async (d) => { out.set(d, await dns.hasMailServer(d)); }));
  return out;
}

/** Free identity from the file's evidence (rule 1). Also records the domain of companies that a name-list match dropped, so a spelling variant that resolves to the same domain is caught after identity. */
export async function freeIdentity(q: Db["query"], eventId: string, mail: Map<string, boolean>) {
  const rows = await q<{ id: string; key: string; identity_evidence: FileEvidence[]; identity_state: string }>("SELECT id, key, identity_evidence, identity_state FROM companies WHERE event_id = $1 AND identity_state = 'unresolved' AND inherited_from IS NULL", [eventId]);
  let n = 0;
  for (const r of rows) {
    const c = emailDomainChoice(r.key, r.identity_evidence ?? []);
    if (!c || !mail.get(c.domain)) continue;
    await q("UPDATE companies SET primary_domain = $2, identity_state = 'resolved', identity_via = 'email_domain', identity_evidence = identity_evidence || $3::jsonb WHERE id = $1", [r.id, c.domain, JSON.stringify([{ source: "resolved", via: "email_domain", value: c.domain, rows: c.rows }])]);
    n++;
  }
  return n;
}

/** Puts back what freeIdentity did. */
export async function undoFreeIdentity(q: Db["query"], eventId: string) {
  await q(
    `UPDATE companies SET primary_domain = NULL, identity_state = 'unresolved', identity_via = NULL,
       identity_evidence = coalesce((SELECT jsonb_agg(e) FROM jsonb_array_elements(identity_evidence) e WHERE e->>'source' <> 'resolved'), '[]'::jsonb)
     WHERE event_id = $1 AND identity_via = 'email_domain' AND inherited_from IS NULL`, [eventId]);
}

/* --------------------------------------------------------------- stage 4 */

export interface IdentityJobInput { company: { id: string; key: string; name: string }; input: ResolveInput }

export async function loadIdentityInput(db: Db, companyId: string): Promise<IdentityJobInput | null> {
  const [co] = await db.query<{ id: string; key: string; name: string; identity_evidence: (FileEvidence & { source: string })[] }>("SELECT id, key, name, identity_evidence FROM companies WHERE id = $1", [companyId]);
  if (!co) return null;
  const people = await db.query<{ full_name: string; title: string | null }>(
    "SELECT full_name, title FROM contacts WHERE company_id = $1 AND dropped_at IS NULL AND full_name IS NOT NULL ORDER BY (email IS NULL), id LIMIT 8", [companyId]);
  const evidence = (co.identity_evidence ?? []).filter((e) => e.source === "email_domain" || e.source === "form_website");
  return { company: { id: co.id, key: co.key, name: co.name }, input: { key: co.key, name: co.name, evidence, people } };
}

/** Records the outcome. A resolved company is mapped name to domain; an ambiguous one or one not found opens a review case. */
export async function applyResolution(db: Db, eventId: string, company: { id: string; key: string; name: string }, r: Resolution) {
  if (r.state === "resolved") {
    await db.query(
      "UPDATE companies SET primary_domain = $2, identity_state = 'resolved', identity_via = $3, parent_name = $4, parent_domain = $5, identity_evidence = identity_evidence || $6::jsonb WHERE id = $1",
      [company.id, r.domain, r.via ?? null, r.parent_name ?? null, r.parent_domain ?? null, JSON.stringify([{ source: "resolved", via: r.via, value: r.domain, person_match: r.person_match }])]);
    if (r.via && r.via !== "cache") await mapNameToDomain(db, company.key, r.domain!, r.via);
    return;
  }
  if (r.state === "ambiguous") {
    await db.query("UPDATE companies SET identity_state = 'ambiguous' WHERE id = $1", [company.id]);
    const cands = r.candidates ?? [];
    await db.tx((q) => openCase(q, {
      eventId, kind: "ambiguous_identity", companyId: company.id,
      summary: `Which company is "${company.name}"?`,
      facts: cands.map((c) => ({ name: c.name, website: c.domain, country: c.country ?? "not given" })),
      suggested: cands[0] ? `pick:${cands[0].domain}` : "drop",
      payload: { candidates: cands },
      options: [...cands.map((c) => ({ value: `pick:${c.domain}`, label: `${c.name} (${c.domain})`, effect: `Uses ${c.domain} as this company's identity and finishes its research.` })), { value: "drop", label: "Neither, drop it", effect: "Nobody at this company is looked up or paid for." }],
    }));
    return;
  }
  await db.query("UPDATE companies SET identity_state = 'not_found' WHERE id = $1", [company.id]);
  await db.tx((q) => openCase(q, {
    eventId, kind: "company_not_found", companyId: company.id,
    summary: `No website could be found for "${company.name}".`,
    facts: [{ company: company.name, note: r.note ?? "Free evidence, company search and one person match found nothing." }],
    suggested: "drop", payload: { person_match: r.person_match },
  }));
}

/** Settles which row survives when several companies resolve to one domain. */
function survivorOf<T extends { id: string; key: string; name: string; rows: number; parent_name: string | null; in_research: boolean; list_status: string | null; inherited: boolean }>(group: T[], domain: string): T {
  const score = (c: T) => [c.inherited ? 1 : 0, c.parent_name ? 0 : 1, c.list_status ? 1 : 0, resemblesDomain(c.key, domain) ? 1 : 0, c.rows, -c.key.length] as const;
  return [...group].sort((a, b) => { const x = score(a), y = score(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]; return a.key.localeCompare(b.key); })[0];
}

export interface MergeSummary { groups: number; merged: number; duplicates: number; mapped: [string, string][] }

/** Rows that resolve to one domain become one company, before anything further is paid. Rows move to the survivor, the other spellings are kept on it, and a person who is now listed twice is dropped as a duplicate. */
export async function mergeByDomain(q: Db["query"], eventId: string): Promise<MergeSummary> {
  const cos = await q<{ id: string; key: string; name: string; primary_domain: string; parent_name: string | null; parent_domain: string | null; in_research: boolean; list_status: string | null; rows: number; inherited: boolean }>(
    `SELECT c.id, c.key, c.name, c.primary_domain, c.parent_name, c.parent_domain, c.in_research, c.list_status, c.inherited_from IS NOT NULL AS inherited,
            ((SELECT count(*) FROM contacts k WHERE k.company_id = c.id) + (SELECT count(*) FROM source_rows r WHERE r.company_id = c.id AND r.kind = 'company_only'))::int AS rows
     FROM companies c WHERE c.event_id = $1 AND c.primary_domain IS NOT NULL`, [eventId]);
  const byDomain = new Map<string, typeof cos>();
  for (const c of cos) byDomain.set(c.primary_domain, [...(byDomain.get(c.primary_domain) ?? []), c]);
  const out: MergeSummary = { groups: 0, merged: 0, duplicates: 0, mapped: [] };
  for (const [domain, group] of byDomain) {
    if (group.length < 2) continue;
    out.groups++;
    const keep = survivorOf(group, domain);
    const names: object[] = [];
    let listStatus = keep.list_status, inResearch = keep.in_research;
    for (const lose of group) {
      // A row copied from the parent is never removed.
      if (lose.id === keep.id || lose.inherited) continue;
      out.merged++;
      names.push({ name: lose.name, key: lose.key, rows: lose.rows, parent_name: lose.parent_name, parent_domain: lose.parent_domain });
      out.mapped.push([lose.key, domain]);
      listStatus = listStatus ?? lose.list_status;
      inResearch = inResearch && lose.in_research;
      // Where each row was filed is kept, since the company row it pointed at is about to go.
      await q("UPDATE source_rows SET listed_name = coalesce(listed_name, $3), company_id = $2 WHERE company_id = $1", [lose.id, keep.id, lose.name]);
      await q("UPDATE contacts SET company_id = $2 WHERE company_id = $1", [lose.id, keep.id]);
      await q("UPDATE review_cases SET company_id = $2 WHERE company_id = $1", [lose.id, keep.id]);
      await q("UPDATE companies SET parent_id = $2 WHERE parent_id = $1", [lose.id, keep.id]);
      await q("DELETE FROM companies WHERE id = $1", [lose.id]);
    }
    // A copy of the parent's company takes the new spellings and keeps its outcome.
    if (keep.inherited) { listStatus = keep.list_status; await q("UPDATE companies SET merged_names = merged_names || $2::jsonb WHERE id = $1", [keep.id, JSON.stringify(names)]); }
    else await q("UPDATE companies SET merged_names = merged_names || $2::jsonb, list_status = $3, in_research = $4, identity_evidence = identity_evidence || $5::jsonb WHERE id = $1",
      [keep.id, JSON.stringify(names), listStatus, inResearch && !listStatus, JSON.stringify([{ source: "merged", value: domain, names: group.length }])]);
    // A spelling that merged into a listed company is that company: its people are dropped for the same reason.
    if (listStatus) await dropAtCompany(q, eventId, keep.id, listStatus === "excluded" ? "excluded_company" : "existing_customer");
    else out.duplicates += await dedupeAt(q, eventId, keep.id);
  }
  return out;
}

/** After a merge the same person can be on the list twice, once under each spelling. Same address, or the same name when one side has no address. */
async function dedupeAt(q: Db["query"], eventId: string, companyId: string) {
  const people = await q<{ id: string; full_name: string | null; email: string | null }>("SELECT id, full_name, email FROM contacts WHERE company_id = $1 AND dropped_at IS NULL AND source = 'attendee' ORDER BY (email IS NULL), id", [companyId]);
  const seenEmail = new Set<string>(), nameNoEmail = new Map<string, string>(), named = new Map<string, string>();
  let dropped = 0;
  for (const p of people) {
    const ns = p.full_name ? nameSet(p.full_name) : "";
    let dup = false;
    if (p.email) { dup = seenEmail.has(p.email) || (ns !== "" && nameNoEmail.has(ns)); }
    else dup = ns !== "" && named.has(ns);
    if (dup) { await q("UPDATE contacts SET drop_reason = 'duplicate', dropped_at = now() WHERE id = $1", [p.id]); dropped++; continue; }
    if (p.email) seenEmail.add(p.email); else if (ns) nameNoEmail.set(ns, p.id);
    if (ns) named.set(ns, p.id);
  }
  return dropped;
}

/** Called when a person gives or picks a domain: if another company already has it, the two become one. */
export async function mergeAfterAnswer(q: Db["query"], eventId: string, companyId: string) {
  const [co] = await q<{ primary_domain: string | null }>("SELECT primary_domain FROM companies WHERE id = $1", [companyId]);
  if (!co?.primary_domain) return companyId;
  const group = await q<{ id: string }>("SELECT id FROM companies WHERE event_id = $1 AND primary_domain = $2", [eventId, co.primary_domain]);
  if (group.length < 2) return companyId;
  await mergeByDomain(q, eventId);
  const [after] = await q<{ id: string }>("SELECT id FROM companies WHERE event_id = $1 AND primary_domain = $2 LIMIT 1", [eventId, co.primary_domain]);
  return after.id;
}

/* ------------------------------------------------- gates, parents and CRM */

const isDomainEntry = (s: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s.trim()) && !/\s/.test(s);

/** Finishes stage 4 once every identity and reverse job is done: merge, then the domain gates, parents, the CRM by domain, and the tier jobs for the companies that are settled. */
export async function finishIdentity(db: Db, eventId: string, s: Settings, crm: Crm) {
  // On a top-up, a company whose confirmed domain the parent has becomes the parent's copy first, so nothing further is paid for it.
  await db.tx((q) => adoptFromParent(q, eventId));
  const merge = await db.tx((q) => mergeByDomain(q, eventId));
  for (const [key, domain] of merge.mapped) await mapNameToDomain(db, key, domain, "merge");

  const listDomains = (entries: string[]) => new Set(entries.filter(isDomainEntry).map((e) => e.trim().toLowerCase()));
  const excludedDomains = listDomains(s.excluded_companies), customerDomains = listDomains(s.existing_customers);
  const excludedKeys = new Set(s.excluded_companies.filter((e) => !isDomainEntry(e)).map(companyKey)), customerKeys = new Set(s.existing_customers.filter((e) => !isDomainEntry(e)).map(companyKey));

  // A company a name-list match dropped before the card keeps the domain the file's own evidence gave it. A spelling variant that resolves to that domain is the same company.
  // Not one the CRM excluded: a CRM flag never becomes a case, and a subsidiary of a flagged parent would raise one here.
  const listed = await db.query<{ primary_domain: string; list_status: string }>("SELECT primary_domain, list_status FROM companies WHERE event_id = $1 AND list_status IS NOT NULL AND primary_domain IS NOT NULL AND crm_checked_at IS NULL", [eventId]);
  for (const l of listed) (l.list_status === "excluded" ? excludedDomains : customerDomains).add(l.primary_domain);

  // Do not prospect, by confirmed domain, before anything further is paid. A connected CRM that cannot answer raises CrmDown and the run pauses; the merge above is safe to repeat.
  if (crmConnected(crm)) await checkAccounts(db, crm, eventId, "resolved");

  const cos = await db.query<{ id: string; name: string; primary_domain: string; parent_name: string | null; parent_domain: string | null; merged_names: { name: string; parent_name: string | null; parent_domain: string | null }[]; list_status: string | null }>(
    "SELECT id, name, primary_domain, parent_name, parent_domain, merged_names, list_status FROM companies WHERE event_id = $1 AND in_research AND identity_state = 'resolved' AND list_status IS NULL AND inherited_from IS NULL ORDER BY name", [eventId]);
  const byDomain = new Map(cos.map((c) => [c.primary_domain, c.id]));
  let dropped = 0, cases = 0;
  for (const c of cos) {
    // Parent handling: a parent recorded, or a spelling that was a subsidiary, that sits on a list raises a case instead of acting.
    const parents = [{ name: c.parent_name, domain: c.parent_domain }, ...c.merged_names.map((m) => ({ name: m.parent_name, domain: m.parent_domain }))].filter((p) => p.name || p.domain);
    const parentOn = (status: "excluded" | "existing_customer") => parents.find((p) => (p.domain && (status === "excluded" ? excludedDomains : customerDomains).has(p.domain)) || (p.name && (status === "excluded" ? excludedKeys : customerKeys).has(companyKey(p.name))));
    // The name is read too: the free name pass ran before a reverse lookup could add this company.
    const nameKeyOf = companyKey(c.name);
    const own = excludedDomains.has(c.primary_domain) || excludedKeys.has(nameKeyOf) ? "excluded" : customerDomains.has(c.primary_domain) || customerKeys.has(nameKeyOf) ? "existing_customer" : null;
    const parentHit = (["excluded", "existing_customer"] as const).map((st) => ({ st, p: parentOn(st) })).find((x) => x.p);
    if (parentHit && (c.merged_names.some((m) => m.parent_name) || c.parent_name)) {
      const where = parentHit!.st === "excluded" ? "excluded companies" : "existing customers";
      const id = await db.tx((q) => openCase(q, {
        eventId, kind: "subsidiary_inheritance", companyId: c.id,
        summary: `"${c.name}" is a subsidiary of ${parentHit!.p!.name ?? parentHit!.p!.domain}, which is on the ${where} list. Does it share that status?`,
        facts: [{ company: c.name, website: c.primary_domain }, { parent: parentHit!.p!.name ?? "not named", parent_website: parentHit!.p!.domain ?? "not given", list: where }],
        suggested: "inherit", payload: { status: parentHit!.st },
      }));
      if (id) cases++;
      continue;
    }
    if (own) {
      await db.tx(async (q) => {
        await q("UPDATE companies SET list_status = $2, in_research = false WHERE id = $1", [c.id, own]);
        await dropAtCompany(q, eventId, c.id, own === "excluded" ? "excluded_company" : "existing_customer");
      });
      dropped++;
    }
  }

  // Parent links: a parent that is also on this list.
  for (const c of cos) if (c.parent_domain && byDomain.has(c.parent_domain) && byDomain.get(c.parent_domain) !== c.id) await db.query("UPDATE companies SET parent_id = $2 WHERE id = $1", [c.id, byDomain.get(c.parent_domain)]);

  // CRM by confirmed domain. A company the CRM calls a customer that the list missed is a case.
  const asOf = new Date().toISOString().slice(0, 10);
  const live = await db.query<{ id: string; name: string; primary_domain: string }>("SELECT id, name, primary_domain FROM companies WHERE event_id = $1 AND in_research AND list_status IS NULL AND primary_domain IS NOT NULL AND heat IS NULL AND inherited_from IS NULL ORDER BY name", [eventId]);
  let crmFailed = 0;
  for (const c of live) {
    try {
      const a = crm.lookupByDomain ? await crm.lookupByDomain(c.primary_domain, c.name, asOf) : await crm.lookup(c.name, asOf);
      await db.query("UPDATE companies SET account_owner = $2, deal_name = $3, deal_stage = $4, last_activity = $5, heat = $6, account_type = $7 WHERE id = $1", [c.id, a.owner, a.deal_name, a.deal_stage, a.last_activity, a.heat, a.account_type ?? null]);
      if (a.account_type === "customer") {
        const id = await db.tx((q) => openCase(q, {
          eventId, kind: "crm_customer_mismatch", companyId: c.id,
          summary: `The CRM calls "${c.name}" a customer, but it is not on the existing-customers list.`,
          facts: [{ company: c.name, website: c.primary_domain, crm_says: "customer", list_says: "not listed" }], suggested: "is_customer", payload: { status: "existing_customer" },
        }));
        if (id) cases++;
      }
    } catch { crmFailed++; }
  }
  if (crmFailed) await db.tx((q) => logActivity(q, eventId, "Events Desk", "crm", `${crm.name} had no answer for ${crmFailed} of ${live.length} companies`));

  // Tier jobs for every company that is settled and has no open case on it.
  const ready = await db.query<{ id: string }>(
    `SELECT c.id FROM companies c WHERE c.event_id = $1 AND c.in_research AND c.list_status IS NULL AND c.identity_state = 'resolved' AND c.tier IS NULL AND c.inherited_from IS NULL
       AND NOT EXISTS (SELECT 1 FROM review_cases r WHERE r.company_id = c.id AND r.status = 'open' AND r.blocking)
       AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.event_id = c.event_id AND j.kind = 'company_tier' AND j.payload->>'company_id' = c.id)
       AND (EXISTS (SELECT 1 FROM contacts k WHERE k.company_id = c.id AND k.dropped_at IS NULL) OR EXISTS (SELECT 1 FROM source_rows r WHERE r.company_id = c.id AND r.kind = 'company_only' AND r.dropped_at IS NULL))
     ORDER BY c.name`, [eventId]);
  await db.tx(async (q) => {
    for (const co of ready) await enqueue(q, eventId, "company_tier", { company_id: co.id });
    await q("UPDATE events SET phase = 'tier' WHERE id = $1", [eventId]);
    const [t] = await q<{ resolved: number; open: number }>("SELECT count(*) FILTER (WHERE identity_state = 'resolved')::int AS resolved, count(*) FILTER (WHERE identity_state IN ('ambiguous', 'not_found') AND in_research)::int AS open FROM companies WHERE event_id = $1", [eventId]);
    await logActivity(q, eventId, "Events Desk", "identity", `Identity: ${t.resolved} companies resolved, ${merge.merged} spellings merged into ${merge.groups} companies, ${dropped} dropped by domain, ${t.open} waiting on a person`);
  });
  return { merged: merge.merged, groups: merge.groups, dropped, cases };
}

/* ---------------------------------------------------------- reverse lookup */

/** Attaches a person who came in with no company to the company a reverse lookup found: the event's company at that domain, or a new one. */
export async function attachReverse(db: Db, eventId: string, contactId: string, found: CompanyCandidate, via: string) {
  const domain = companyDomain(found.domain);
  if (!domain || !found.name) return false;
  await db.tx(async (q) => {
    let [co] = await q<{ id: string }>("SELECT id FROM companies WHERE event_id = $1 AND primary_domain = $2 LIMIT 1", [eventId, domain]);
    if (!co) {
      const key = companyKey(found.name);
      [co] = await q<{ id: string }>("SELECT id FROM companies WHERE event_id = $1 AND key = $2", [eventId, key]);
      if (co) await q("UPDATE companies SET primary_domain = $2, identity_state = 'resolved', identity_via = $3, identity_evidence = identity_evidence || $4::jsonb WHERE id = $1 AND identity_state <> 'resolved'", [co.id, domain, via, JSON.stringify([{ source: "resolved", via, value: domain }])]);
      else {
        const id = newId("co");
        await q("INSERT INTO companies (id, event_id, key, name, primary_domain, identity_state, identity_via, parent_name, parent_domain, identity_evidence) VALUES ($1, $2, $3, $4, $5, 'resolved', $6, $7, $8, $9::jsonb)",
          [id, eventId, key, found.name, domain, via, found.parent_name ?? null, found.parent_domain ?? null, JSON.stringify([{ source: "resolved", via, value: domain }])]);
        co = { id };
      }
    }
    await q("UPDATE contacts SET company_id = $2 WHERE id = $1", [contactId, co.id]);
    await q("UPDATE source_rows SET company_id = $2 WHERE id = (SELECT source_row_id FROM contacts WHERE id = $1)", [contactId, co.id]);
  });
  return true;
}

export { VendorDown };
