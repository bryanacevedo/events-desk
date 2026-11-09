/* Finding people (docs/TIERING-AND-ENRICHMENT.md, "Layer 4"; build-order step 7). Everything here is free or capped by the Outreach card, and nothing here reveals a person.

     search      a free people search by company domain (the `PeopleSearch` seam), filtered by persona titles and the event's region
     parse       each title is read into a function and a seniority with rules in code; only a title the rules cannot place goes to the model (`title_parse`)
     tier        persona tiers from the event's pinned ICP, adjusted by company type and size; then priority through the existing matrix
     C stops     a priority C person is not stored, so nothing is ever paid for them
     rank        persona match, title tier, region, freshness, whether the vendor says an email exists, and variety across functions
     quota       prospects only: tier 1 up to 5, tier 2 up to 3. Attendees are never cut by a quota.

   A person whose last name is hidden ranks with everyone else; the paid reveal (email.ts) comes only after ranking.
   A company's Unknown tier is never turned into a priority here: companies with no tier are not searched, and `priority` is only computed from a real tier.
   An event with no pinned ICP keeps the keyword table for titles (settings), as before. */

import type { Db } from "./db.ts";
import { logReuse } from "./caches.ts";
import { decide, withVendorWait, attempt, type Ctx, type Job } from "./paid.ts";
import { enqueue } from "./work.ts";
import { fill } from "./prompts.ts";
import { mockPeopleSearch, type FoundPerson } from "./providers.ts";
import { pinnedIcp, type PinnedIcp } from "./tiering.ts";
import { newId } from "./events.ts";
import type { Tier } from "../shared/cost.ts";
import { titleRule } from "../shared/cost.ts";
import { cleanLinkedin } from "../shared/ingest.ts";
import { priority } from "../shared/tiers.ts";
import { adjustTier, matchPersona, parseTitle, personaTier, rankPeople, validTitleParse, type Candidate, type ParsedTitle } from "../shared/titles.ts";

const today = () => new Date().toISOString().slice(0, 10);

/* --------------------------------------------------------- title classes */

export interface TitleClass {
  parsed: ParsedTitle;
  /** The tier before the company's type and size adjust it. Null: neither the rules, the cache nor the model could place the title. */
  base: Tier | null;
  via: "rules" | "cache" | "model" | "none";
  /** When `via` is none: the card had no model calls left for this step, or the model's answer could not be read. */
  why?: "refused" | "unreadable";
}

const titleKey = (t: string) => t.toLowerCase().trim();

/** Reads a title: rules first, then the cache (any event, same ICP version), then the model once. A refused or failed model call leaves the title unplaced; it is not guessed. */
export async function classifyTitle(c: Ctx, pin: PinnedIcp, title: string): Promise<TitleClass> {
  const rules = parseTitle(title);
  const tierOf = (p: ParsedTitle) => personaTier(p, pin.icp.personas);
  if (rules.placed || rules.non_buyer) return { parsed: rules, base: tierOf(rules), via: "rules" };
  const key = titleKey(title);
  const [hit] = await c.db.query<{ tier: number; func: string | null; seniority: string | null; created_at: string; event_id: string | null }>(
    "SELECT tier, func, seniority, created_at::text AS created_at, event_id FROM title_cache WHERE title_key = $1 AND company_type = '*' AND size_band = '*' AND persona_version = $2", [key, String(pin.version)]);
  if (hit && hit.func && hit.seniority) {
    const parsed: ParsedTitle = { function: hit.func as never, seniority: hit.seniority as never, non_buyer: false, former: rules.former, placed: true };
    await logReuse(c.db.query, c.eventId, { target: key, step: "title_parse", vendor: "title_parse", unit: "llm", n: 1, answered_at: hit.created_at, answered_by: hit.event_id });
    return { parsed, base: hit.tier as Tier, via: "cache" };
  }
  const r = await decide(c, "title_parse", fill("title_parse", { title: title.replace(/\s+/g, " ").slice(0, 200) }), validTitleParse);
  if (r.kind !== "ok") return { parsed: rules, base: null, via: "none", why: r.kind === "refused" ? "refused" : "unreadable" };
  const parsed: ParsedTitle = { function: r.value.function, seniority: r.value.seniority, non_buyer: r.value.non_buyer, former: rules.former, placed: true };
  const base = tierOf(parsed);
  if (base !== null) await c.db.query(
    `INSERT INTO title_cache (title_key, company_type, size_band, persona_version, tier, func, seniority, event_id) VALUES ($1, '*', '*', $2, $3, $4, $5, $6)
     ON CONFLICT (title_key, company_type, size_band, persona_version) DO UPDATE SET tier = EXCLUDED.tier, func = EXCLUDED.func, seniority = EXCLUDED.seniority, event_id = EXCLUDED.event_id, created_at = now()`,
    [key, String(pin.version), base, parsed.function, parsed.seniority, c.eventId]);
  return { parsed, base, via: "model" };
}

export interface CompanyFacts { company_type: string | null; employees: number | null; segment: string | null }
export const companyFactsOf = (r: { company_type: string | null; firmo: { employees?: number | null } | null; segment: string | null }): CompanyFacts => ({ company_type: r.company_type, employees: r.firmo?.employees ?? null, segment: r.segment });

/** The title tier for this person at this company: persona tier, then the ICP's adjustments for the company's type and size. */
export const adjusted = (pin: PinnedIcp, t: TitleClass, co: CompanyFacts): Tier | null => (t.base === null ? null : adjustTier(t.base, t.parsed, pin.icp, co));

/** The best a title could be without calling the model, for counting who might be A or B before the card is quoted. Null: the rules cannot place it. */
export function bestCaseTier(pin: PinnedIcp, title: string): Tier | null {
  const p = parseTitle(title);
  const base = personaTier(p, pin.icp.personas);
  if (base === null) return null;
  // An adjustment can raise a tier by one (a founder at a very small company), so the best case allows it.
  const raises = pin.icp.title_adjustments.some((a) => a.delta > 0);
  return (raises ? Math.max(1, base - 1) : base) as Tier;
}

/* ---------------------------------------------------------- attendee titles */

/** After the Outreach card is approved: read every attendee title. Rules decide what they can, free; the rest are queued for the model. Replaces the keyword table's guess, except that Title 3 people were already stopped before the Research card. */
export async function readAttendeeTitles(db: Db, eventId: string, pin: PinnedIcp) {
  await db.tx(async (q) => {
    await q("UPDATE events SET titles_read = true WHERE id = $1", [eventId]);
    // Titles the parent already read came with its copied rows. Only the new ones are read, and only the unknown ones paid for.
    const known = new Set((await q<{ title_key: string }>("SELECT title_key FROM title_tiers WHERE event_id = $1 AND source IN ('persona', 'llm')", [eventId])).map((t) => t.title_key));
    const titles = await q<{ title_key: string; title: string }>(
      "SELECT DISTINCT ON (lower(title)) lower(title) AS title_key, title FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND title IS NOT NULL ORDER BY lower(title), title", [eventId]);
    for (const { title_key, title } of titles) {
      if (known.has(title_key)) continue;
      const p = parseTitle(title);
      const [cached] = p.placed || p.non_buyer ? [] : await q<{ tier: number; func: string; seniority: string; created_at: string; event_id: string | null }>("SELECT tier, func, seniority, created_at::text AS created_at, event_id FROM title_cache WHERE title_key = $1 AND company_type = '*' AND size_band = '*' AND persona_version = $2", [title_key, String(pin.version)]);
      const base = p.placed || p.non_buyer ? personaTier(p, pin.icp.personas) : cached?.tier ?? null;
      await q("DELETE FROM title_tiers WHERE event_id = $1 AND title_key = $2", [eventId, title_key]);
      if (cached) await logReuse(q, eventId, { target: title_key, step: "title_parse", vendor: "title_parse", unit: "llm", n: 1, answered_at: cached.created_at, answered_by: cached.event_id });
      if (base !== null) {
        await q("INSERT INTO title_tiers (event_id, title_key, tier, reason, source, func, seniority, non_buyer) VALUES ($1, $2, $3, $4, 'persona', $5, $6, $7)",
          [eventId, title_key, base, cached ? "cached_parse" : "persona_rule", p.function ?? cached?.func ?? null, p.seniority ?? cached?.seniority ?? null, p.non_buyer]);
      } else await enqueue(q, eventId, "title_tier", { title_key });
    }
  });
}

/** The model reads a title the rules could not place. Refused or failed: the people with that title drop, as the older path did. */
export async function titleTierWithIcp(c: Ctx, job: Job, lost: boolean, pin: PinnedIcp) {
  const { title_key } = job.payload;
  const fail = (reason: string) => c.db.query("UPDATE contacts SET drop_reason = $3, dropped_at = now() WHERE event_id = $1 AND lower(title) = $2 AND dropped_at IS NULL", [c.eventId, title_key, reason]);
  if (lost) return fail("tiering_failed");
  const [t] = await c.db.query<{ title: string }>("SELECT title FROM contacts WHERE event_id = $1 AND lower(title) = $2 LIMIT 1", [c.eventId, title_key]);
  const r = await classifyTitle(c, pin, t?.title ?? title_key);
  if (r.via === "none" || r.base === null) {
    // Refused at the cap, or the model could not read it.
    return fail(r.why === "refused" ? "budget_cap" : "tiering_failed");
  }
  await c.db.query("INSERT INTO title_tiers (event_id, title_key, tier, reason, source, func, seniority, non_buyer) VALUES ($1, $2, $3, $4, 'llm', $5, $6, $7) ON CONFLICT (event_id, title_key) DO UPDATE SET tier = EXCLUDED.tier, reason = EXCLUDED.reason, source = EXCLUDED.source, func = EXCLUDED.func, seniority = EXCLUDED.seniority, non_buyer = EXCLUDED.non_buyer",
    [c.eventId, title_key, r.base, r.via === "cache" ? "cached_parse" : "model_parse", r.parsed.function, r.parsed.seniority, r.parsed.non_buyer]);
}

/* ------------------------------------------------------------ the search */

interface Row { company_id: string; name: string; domain: string | null; priority: string | null; tier: Tier; company_type: string | null; segment: string | null; firmo: { employees?: number | null } | null }

/** Free people search for one company, then parse, tier, rank and cap. Stores the people it keeps as prospects and queues their email lookup (step 8 replaces that with a reveal). */
export async function peopleSearchJob(c: Ctx, job: Job, lost: boolean) {
  const { source_row_id } = job.payload;
  const adding = job.payload.add === true;
  // A failed prospect search costs the row nothing: its attendee is still on the list.
  const dropRow = async (reason: string) => { if (!adding) await c.db.query("UPDATE source_rows SET drop_reason = $2, dropped_at = now() WHERE id = $1 AND dropped_at IS NULL", [source_row_id, reason]); };
  if (lost) return dropRow("vendor_error");
  const [row] = await c.db.query<Row>(
    `SELECT r.company_id, co.name, co.primary_domain AS domain, r.priority, co.tier, co.company_type, co.segment, co.firmo FROM source_rows r JOIN companies co ON co.id = r.company_id WHERE r.id = $1`, [source_row_id]);
  if (!row || !row.domain || (row.tier !== 1 && row.tier !== 2)) return dropRow("no_people_found");
  const pin = await pinnedIcp(c.db, c.eventId);
  const o = c.settings.outreach;
  const quota = row.tier === 1 ? o.quota_tier1 : o.quota_tier2;
  const [{ n: have }] = await c.db.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts WHERE company_id = $1 AND source = 'prospect' AND dropped_at IS NULL", [row.company_id]);
  const room = Math.max(0, quota - have);
  if (!room) return;

  const ps = c.vendors.peopleSearch ?? mockPeopleSearch;
  const g = c.health.guard(ps.name);
  const titles = [...new Set([...(pin ? pin.icp.personas.flatMap((p) => p.titles) : []), ...c.settings.target_titles])];
  // An empty answer is final only after the known-good lookup still works. A vendor that is silently throttling answers everything with an empty success,
  // and that must wait or pause the event, never read as "no people found". The whole search is retried after a wait, not just the check.
  const found = await withVendorWait(c, async () => {
    const res = await g.call(() => ps.search({ domain: row.domain!, company: row.name, titles, country: c.country, limit: Math.min(25, quota * 4) }));
    if (!res.people.length && ps.probe) {
      const probe = ps.probe;
      await g.confirmEmpty(async () => (await ps.search({ domain: probe.domain, company: probe.company, titles: [], country: null, limit: 1 })).people.length > 0);
    }
    return res.people;
  });
  if (!found.length) { await attempt(c, source_row_id, ps.name, "people_search", "0 found"); return dropRow("no_people_found"); }

  // Dedupe before anything is stored or paid: by the vendor's person id, then by a visible name already on the list at this company.
  const known = await c.db.query<{ vendor_person_id: string | null; full_name: string | null }>("SELECT vendor_person_id, full_name FROM contacts WHERE company_id = $1", [row.company_id]);
  const ids = new Set(known.map((k) => k.vendor_person_id).filter(Boolean)), names = new Set(known.map((k) => (k.full_name ?? "").toLowerCase()));
  const seen = new Set<string>();
  let hidden = 0, dup = 0, untitled = 0, unplaced = 0, stoppedC = 0;
  const co = companyFactsOf(row);
  const cands: (Candidate & { p: FoundPerson; tier: Tier; titleTier: Tier | null; prio: "A" | "B"; parsed: ParsedTitle })[] = [];
  for (const p of found) {
    if (seen.has(p.vendor_person_id)) continue;
    seen.add(p.vendor_person_id);
    // A hidden last name is kept: the person ranks like anyone else and is revealed (paid) only if they make the quota. Until then they are known by first name and vendor id.
    if (!p.last_name) hidden++;
    const full = p.last_name ? `${p.first_name} ${p.last_name}` : p.first_name;
    if (ids.has(p.vendor_person_id) || (p.last_name && names.has(full.toLowerCase()))) { dup++; continue; }
    if (!p.title) { untitled++; continue; }
    let tier: Tier | null, parsed: ParsedTitle, persona: "primary" | "secondary" | null = null;
    if (pin) {
      const t = await classifyTitle(c, pin, p.title);
      tier = adjusted(pin, t, co); parsed = t.parsed;
      if (tier !== null) persona = matchPersona(parsed, pin.icp.personas, row.segment).priority;
    } else { tier = titleRule(p.title, c.settings.title_keywords); parsed = parseTitle(p.title); }
    // Without a pinned ICP a title the keyword table does not decide is "no title": the company tier alone sets the priority, as before.
    const prio = tier === null && pin ? null : priority(row.tier, tier);
    if (prio === null) { unplaced++; continue; }
    if (prio === "C") { stoppedC++; continue; }
    cands.push({ id: p.vendor_person_id, titleTier: tier, tier: tier ?? (row.tier as Tier), function: parsed.function, persona_priority: persona, country: p.country ?? null, updated_at: p.updated_at, has_email: p.has_email, p, prio, parsed });
  }
  const kept = rankPeople(cands, room, { country: c.country, today: today(), freshness_days: c.settings.limits.freshness_days });
  await attempt(c, source_row_id, ps.name, "people_search", `${found.length} found, ${kept.length} kept, ${stoppedC} stopped at C, ${hidden} with a hidden last name (revealed later, if kept), ${unplaced} unplaced, ${dup + untitled} dropped before ranking`);
  if (!kept.length) return dropRow("no_people_found");
  await c.db.tx(async (q) => {
    for (const k of kept as typeof cands) {
      const id = newId("con");
      await q(
        `INSERT INTO contacts (id, event_id, source_row_id, company_id, full_name, title, priority, title_tier, linkedin, source, vendor_person_id, found_at, title_function, title_seniority, name_hidden)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'prospect', $10, $11, $12, $13, $14)`,
        [id, c.eventId, source_row_id, row.company_id, k.p.last_name ? `${k.p.first_name} ${k.p.last_name}` : k.p.first_name, k.p.title, k.prio, k.titleTier, cleanLinkedin(k.p.linkedin), k.p.vendor_person_id, k.p.updated_at, k.parsed.function, k.parsed.seniority, !k.p.last_name]);
      await enqueue(q, c.eventId, "find", { contact_id: id, index: 0, errored: false });
    }
  });
}
