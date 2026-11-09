/* The two-card flow's approvals: the Research card and the Outreach card
   (docs/TIERING-AND-ENRICHMENT.md, "The pipeline" and "Paying for it").

   Before the Research card, everything is free and code only: Layer 0 ran at upload, then
   the exact-name list matches and the free title pass run here, so the card prices only the
   companies that still need research. Declining the card puts all of that back, because the
   lists and settings are editable again. The Outreach card is quoted only once no blocking
   review case is open. */

import { nameKey } from "../shared/email.ts";
import type { Db } from "./db.ts";
import { getSettings } from "./approvals.ts";
import { openBlockingCount, openCase } from "./cases.ts";
import { dropAtCompany } from "./work.ts";
import { moveWithin, newId, RuleError } from "./events.ts";
import { exampleDns, freeIdentity, mailServers, undoFreeIdentity } from "./identity.ts";
import { pinnedIcpQ, spreadFor } from "./tiering.ts";
import { bestCaseTier } from "./people.ts";
import type { Dns } from "./providers.ts";
import { quoteOutreach, quoteResearch, titleRule, type OutreachInputs, type ResearchInputs, type Settings } from "../shared/cost.ts";
import { companyKey } from "../shared/ingest.ts";
import { relatedNames, similarity } from "../shared/layer0.ts";
import { priority } from "../shared/tiers.ts";

const isDomain = (s: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s.trim()) && !/\s/.test(s);
/** Lists accept names or domains. A name is matched here; a domain is matched once identity is confirmed. */
export const listNames = (entries: string[]) => entries.filter((e) => !isDomain(e)).map(companyKey);
export const listDomains = (entries: string[]) => entries.filter(isDomain).map((e) => e.trim().toLowerCase());

/** Exact normalized name match against the two lists, or null. Fuzzy matches never act alone. */
export function exactListMatch(key: string, s: Pick<Settings, "excluded_companies" | "existing_customers">): "excluded" | "existing_customer" | null {
  if (listNames(s.excluded_companies).includes(key)) return "excluded";
  if (listNames(s.existing_customers).includes(key)) return "existing_customer";
  return null;
}

export const LIST_DROP: Record<string, string> = { excluded: "excluded_company", existing_customer: "existing_customer" };

/** Free, in one transaction: exact-name list matches, then the title pass. Idempotent after undoFreePass. */
export async function freePass(q: Db["query"], eventId: string, s: Settings) {
  // Anyone opted out stops here, before the card is priced, so Research never sends their name or address to a vendor.
  const out = await q<{ email: string | null; name_key: string | null; company_key: string | null }>("SELECT email, name_key, company_key FROM suppressions WHERE kind = 'opt_out'");
  if (out.length) {
    const emails = new Set(out.map((o) => o.email).filter(Boolean)), names = new Set(out.filter((o) => o.name_key && o.company_key).map((o) => `${o.name_key}|${o.company_key}`));
    for (const k of await q<{ id: string; email: string | null; full_name: string | null; key: string | null }>("SELECT k.id, k.email, k.full_name, co.key FROM contacts k LEFT JOIN companies co ON co.id = k.company_id WHERE k.event_id = $1 AND k.dropped_at IS NULL", [eventId])) {
      if ((k.email && emails.has(k.email.toLowerCase())) || (k.full_name && k.key && names.has(`${nameKey(k.full_name)}|${k.key}`))) await q("UPDATE contacts SET drop_reason = 'opted_out', dropped_at = now() WHERE id = $1", [k.id]);
    }
  }
  for (const co of await q<{ id: string; key: string; inherited_from: string | null; inherited_drop: string | null; list_status: string | null; parent_status: string | null }>(
    "SELECT c.id, c.key, c.inherited_from, c.inherited_drop, c.list_status, (SELECT p.list_status FROM companies p WHERE p.id = c.inherited_from) AS parent_status FROM companies c WHERE c.event_id = $1", [eventId])) {
    // A company the parent settled stays as it is. A new person there still stops at a listed company, or wherever the parent's outcome was no usable tier. The parent's status is read as it stands now.
    if (co.inherited_from) {
      const status = co.parent_status ?? co.list_status ?? exactListMatch(co.key, s);
      const reason = status ? LIST_DROP[status] : co.inherited_drop;
      if (reason) await dropAtCompany(q, eventId, co.id, reason);
      continue;
    }
    const hit = exactListMatch(co.key, s);
    if (!hit) continue;
    await q("UPDATE companies SET list_status = $2, in_research = false WHERE id = $1", [co.id, hit]);
    await dropAtCompany(q, eventId, co.id, LIST_DROP[hit]);
  }
  // Free title pass: the keyword table decides what it can. Title 3 is C whatever the company, so those people stop here.
  for (const { title_key } of await q<{ title_key: string }>("SELECT DISTINCT lower(title) AS title_key FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND title IS NOT NULL", [eventId])) {
    const tier = titleRule(title_key, s.title_keywords);
    if (!tier) continue;
    await q("INSERT INTO title_tiers (event_id, title_key, tier, reason, source) VALUES ($1, $2, $3, 'keyword_table', 'rule') ON CONFLICT DO NOTHING", [eventId, title_key, tier]);
    if (tier === 3) await q("UPDATE contacts SET drop_reason = 'low_tier', dropped_at = now() WHERE event_id = $1 AND lower(title) = $2 AND dropped_at IS NULL", [eventId, title_key]);
  }
  // A company whose only people were Title 3 stops here, unless prospects are on and a better-titled person may be found.
  if (!s.add_prospects) {
    await q(
      `UPDATE companies SET in_research = false WHERE event_id = $1 AND in_research AND inherited_from IS NULL
         AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.company_id = companies.id AND c.dropped_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM source_rows r WHERE r.company_id = companies.id AND r.kind = 'company_only' AND r.dropped_at IS NULL)`, [eventId]);
  }
}

/** Puts back what freePass did. Only valid while the event is quoted or mapped: nothing else produces these reasons yet. */
export async function undoFreePass(q: Db["query"], eventId: string) {
  await undoFreeIdentity(q, eventId);
  const back = "drop_reason = NULL, dropped_at = NULL WHERE event_id = $1 AND drop_reason IN ('excluded_company', 'existing_customer', 'low_tier')";
  await q(`UPDATE contacts SET ${back}`, [eventId]);
  await q(`UPDATE source_rows SET ${back}`, [eventId]);
  await q("UPDATE companies SET list_status = NULL, in_research = true WHERE event_id = $1 AND inherited_from IS NULL", [eventId]);
  await q("DELETE FROM title_tiers WHERE event_id = $1 AND source = 'rule'", [eventId]);
}

export async function researchInputs(q: Db["query"], eventId: string): Promise<ResearchInputs> {
  const [r] = await q<ResearchInputs>(
    `SELECT (SELECT count(*)::int FROM companies WHERE event_id = $1 AND in_research AND inherited_from IS NULL) AS companies,
            (SELECT count(*)::int FROM companies WHERE event_id = $1 AND in_research AND inherited_from IS NULL AND list_status IS NULL AND identity_state = 'unresolved') AS unresolved_companies,
            (SELECT count(*)::int FROM companies co WHERE co.event_id = $1 AND co.in_research AND co.inherited_from IS NULL AND co.list_status IS NULL AND co.identity_state = 'unresolved'
               AND EXISTS (SELECT 1 FROM contacts k WHERE k.company_id = co.id AND k.dropped_at IS NULL AND k.full_name ~ '\\S+\\s+\\S+')) AS person_match_companies,
            (SELECT count(*)::int FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND company_id IS NULL) AS reverse_lookup_rows,
            (SELECT count(*)::int FROM contacts WHERE event_id = $1 AND dropped_at IS NULL) AS person_rows`, [eventId]);
  return r;
}

async function requireTwoCard(q: Db["query"], eventId: string) {
  const [e] = await q<{ flow: string }>("SELECT flow FROM events WHERE id = $1", [eventId]);
  if (!e) throw new RuleError("That event does not exist.");
  if (e.flow !== "two_card") throw new RuleError("This event uses the single cost card, not the Research and Outreach cards.");
}

/** Asks for the Research card. Free work runs first, so the card prices only what still needs research. */
export async function requestResearchCard(db: Db, eventId: string, actor: string, dns: Dns = exampleDns) {
  // Mail-server checks are made before the transaction opens, so a slow lookup never holds one.
  await requireTwoCard(db.query, eventId);
  const mail = await mailServers(db.query, eventId, dns);
  return db.tx(async (q) => {
    await requireTwoCard(q, eventId);
    const event = await moveWithin(q, eventId, "quoted", actor, { detail: "Requested the Research card" });
    const s = await getSettings(q, eventId);
    await freePass(q, eventId, s);
    // Free identity from the file's own evidence, so the card prices a person match only for companies that still need one.
    await freeIdentity(q, eventId, mail);
    const inputs = await researchInputs(q, eventId);
    const c = quoteResearch(inputs, s);
    const [up] = await q<{ quality: unknown }>("SELECT quality FROM uploads WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1", [eventId]);
    const id = newId("card");
    await q(
      `INSERT INTO cost_cards (id, event_id, kind, inputs, rates, lines, credits_cap, llm_cap, est_cents, step_caps) VALUES ($1, $2, 'research', $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb)`,
      [id, eventId, JSON.stringify({ ...inputs, quality: up?.quality ?? null }), JSON.stringify({ research: s.research, llm_call_cents: s.llm_call_cents }), JSON.stringify(c.lines), c.credits_cap, c.llm_cap, c.est_cents, JSON.stringify(c.step_caps)]);
    await q("INSERT INTO approvals (id, event_id, kind, card_id, requested_by, also_requested_by) VALUES ($1, $2, 'research', $3, $4, $5)", [newId("apr"), eventId, id, event.requested_by, actor]);
    return event;
  });
}

export async function outreachInputs(q: Db["query"], eventId: string, s: Settings): Promise<OutreachInputs> {
  // Attendees who are, or could still be, A or B. A title with no rule yet counts at its best case, so the card is never too low.
  const people = await q<{ tier: number | null; title_tier: number | null; email: string | null; company_id: string | null; title: string | null; has_rule: boolean }>(
    `SELECT co.tier, t.tier AS title_tier, c.email, c.company_id, c.title, t.title_key IS NOT NULL AS has_rule
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id LEFT JOIN title_tiers t ON t.event_id = c.event_id AND t.title_key = lower(c.title)
     WHERE c.event_id = $1 AND c.dropped_at IS NULL AND c.source = 'attendee'`, [eventId]);
  // With a pinned ICP the rules in code read each title (the keyword table's guess is replaced); one they cannot place counts at its best case.
  const pin = await pinnedIcpQ(q, eventId);
  const read = new Map<string, number | null>();
  if (pin) for (const p of people) if (p.title) { const k = p.title.toLowerCase(); if (!read.has(k)) read.set(k, bestCaseTier(pin, p.title)); }
  const eligible = people.filter((p) => {
    if (p.tier === null) return true;
    if (p.title === null) return priority(p.tier as 1 | 2 | 3, null) !== "C";
    if (pin) { const t = read.get(p.title.toLowerCase()); return t === null || t === undefined ? p.tier !== 3 : priority(p.tier as 1 | 2 | 3, t as 1 | 2 | 3) !== "C"; }
    if (p.has_rule) return priority(p.tier as 1 | 2 | 3, p.title_tier as 1 | 2 | 3) !== "C";
    return p.tier !== 3;
  });
  // Companies where people are searched: company-only rows at A or B, and attending companies when prospects are on.
  const searched = new Map<string, number>();
  for (const r of await q<{ company_id: string; tier: number }>(
    `SELECT DISTINCT r.company_id, co.tier FROM source_rows r JOIN companies co ON co.id = r.company_id
     WHERE r.event_id = $1 AND r.kind = 'company_only' AND r.dropped_at IS NULL AND co.tier IN (1, 2) AND co.inherited_from IS NULL`, [eventId])) searched.set(r.company_id, r.tier);
  if (s.add_prospects) {
    for (const r of await q<{ company_id: string; tier: number }>(
      `SELECT DISTINCT c.company_id, co.tier FROM contacts c JOIN companies co ON co.id = c.company_id
       WHERE c.event_id = $1 AND c.source = 'attendee' AND co.tier IN (1, 2) AND co.list_status IS NULL AND co.in_research AND co.inherited_from IS NULL
         AND NOT EXISTS (SELECT 1 FROM source_rows r WHERE r.company_id = c.company_id AND r.kind = 'company_only' AND r.dropped_at IS NULL)`, [eventId])) searched.set(r.company_id, r.tier);
  }
  const domains = new Set<string>([...searched.keys(), ...eligible.map((p) => p.company_id).filter((x): x is string => Boolean(x))]);
  const titles = pin
    // Titles the rules cannot place and the cache has not seen: the only ones that can cost a model call.
    ? (await q<{ title: string }>("SELECT DISTINCT lower(c.title) AS title FROM contacts c WHERE c.event_id = $1 AND c.dropped_at IS NULL AND c.title IS NOT NULL AND NOT EXISTS (SELECT 1 FROM title_cache k WHERE k.title_key = lower(c.title) AND k.persona_version = $2)", [eventId, String(pin.version)]))
        .filter((t) => bestCaseTier(pin, t.title) === null)
    : await q<{ title: string }>(
    `SELECT DISTINCT lower(c.title) AS title FROM contacts c LEFT JOIN title_tiers t ON t.event_id = c.event_id AND t.title_key = lower(c.title)
     WHERE c.event_id = $1 AND c.dropped_at IS NULL AND c.title IS NOT NULL AND t.title_key IS NULL`, [eventId]);
  return {
    attendees_ab: eligible.length,
    attendees_without_email: eligible.filter((p) => !p.email).length,
    search_companies_tier1: [...searched.values()].filter((t) => t === 1).length,
    search_companies_tier2: [...searched.values()].filter((t) => t === 2).length,
    domains: domains.size,
    titles_with_no_rule: titles.length,
  };
}

/** Asks for the Outreach card. It refuses while a blocking case is open or research is still finishing, so the quote can never be exceeded by a late answer. */
export async function requestOutreachCard(db: Db, eventId: string, actor: string) {
  return db.tx(async (q) => {
    await requireTwoCard(q, eventId);
    const [e] = await q<{ stage: string; requested_by: string; parent_event_id: string | null }>("SELECT stage, requested_by, parent_event_id FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (e.stage !== "ready_for_review") throw new RuleError(`The Outreach card is asked for once research is done. This event is ${e.stage.replace(/_/g, " ")}.`);
    const pending = await q("SELECT 1 FROM approvals WHERE event_id = $1 AND kind = 'outreach' AND status = 'pending'", [eventId]);
    if (pending.length) throw new RuleError("The Outreach card is already waiting for approval.");
    const open = await openBlockingCount(q, eventId);
    if (open) throw new RuleError(`${open} ${open === 1 ? "case is" : "cases are"} still open. Answer them or skip what remains before the Outreach card can be quoted.`);
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE event_id = $1 AND status IN ('queued', 'running')", [eventId]);
    if (n) throw new RuleError("Research is still finishing the companies you just settled. Try again in a moment.");
    const s = await getSettings(q, eventId);
    const inputs = await outreachInputs(q, eventId, s);
    // A top-up delivers no Summary and has no Concierge of its own.
    const c = quoteOutreach(inputs, s, { topUp: Boolean(e.parent_event_id) });
    // The spread check rides on the card, so the approver sees the warnings before approving.
    const spread = await spreadFor(q, eventId, s);
    const id = newId("card");
    await q(
      `INSERT INTO cost_cards (id, event_id, kind, inputs, rates, lines, credits_cap, llm_cap, est_cents, step_caps) VALUES ($1, $2, 'outreach', $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb)`,
      [id, eventId, JSON.stringify({ ...inputs, spread }), JSON.stringify({ finders: s.finders, verifiers: s.verifiers, linkedin: s.linkedin, discovery_cost: s.discovery_cost, outreach: s.outreach, estimate: s.estimate, llm_call_cents: s.llm_call_cents }),
        JSON.stringify(c.lines), c.credits_cap, c.llm_cap, c.est_cents, JSON.stringify(c.step_caps)]);
    await q("INSERT INTO approvals (id, event_id, kind, card_id, requested_by, also_requested_by) VALUES ($1, $2, 'outreach', $3, $4, $5)", [newId("apr"), eventId, id, e.requested_by, actor]);
    return { card_id: id, ...c };
  });
}

/** Free: opens a review case for every live company whose name is close to, but not exactly, a listed name. */
export async function fuzzyListCases(db: Db, eventId: string, s: Settings) {
  const lists: [string, string[]][] = [["excluded", s.excluded_companies], ["existing_customer", s.existing_customers]];
  const companies = await db.query<{ id: string; key: string; name: string }>("SELECT id, key, name FROM companies WHERE event_id = $1 AND in_research AND inherited_from IS NULL AND list_status IS NULL ORDER BY name", [eventId]);
  let opened = 0;
  await db.tx(async (q) => {
    for (const co of companies) {
      for (const [status, entries] of lists) {
        for (const entry of entries.filter((e) => !isDomain(e))) {
          const k = companyKey(entry);
          if (k === co.key) continue;
          const sim = similarity(co.key, k);
          if (!(sim >= 0.85 || relatedNames(co.key, k))) continue;
          const where = status === "excluded" ? "excluded companies" : "existing customers";
          const id = await openCase(q, {
            eventId, kind: "fuzzy_list_match", companyId: co.id,
            summary: `Is "${co.name}" the same company as "${entry}" on the ${where} list?`,
            facts: [{ on_the_attendee_list: co.name }, { on_the_list: entry, list: where }],
            suggested: sim >= 0.9 ? "same_company" : "different_company", payload: { status, list_entry: entry, similarity: Number(sim.toFixed(2)) },
          });
          if (id) opened++;
          break;
        }
      }
    }
  });
  return opened;
}
