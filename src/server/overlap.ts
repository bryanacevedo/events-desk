/* Which target accounts are likely at an event (docs/CHOOSING.md, sections 4 and 7). Code does the matching and shows the line it came from; a person
   adds the page and rejects a wrong match with a reason. Nothing here is a model. */

import { createHash } from "node:crypto";
import { conferenceKey, decodeEntities } from "../shared/assessment.ts";
import type { Db } from "./db.ts";
import { newId, RuleError } from "./events.ts";
/** A bad body is a 400, a missing row a 404; a rule of the desk is a RuleError (409). Not seats.ts's Invalid: seats imports plan, and plan imports this file. */
export class NotFound extends Error {}
export class Invalid extends Error {}

export const MAX_PAGE_CHARS = 60_000;
export const PAGE_KINDS = ["speaker", "sponsor"] as const;
export const PAGE_INPUTS = ["pasted", "uploaded"] as const;

/* ------------------------------------------------------------------ names */

const SUFFIXES = new Set(["inc", "llc", "ltd", "plc", "gmbh", "sa", "ag", "corp", "corporation", "co", "company", "limited", "holdings", "group"]);
/** Common words that are also company names. An account with one of these as its whole name is matched on its domain only. */
export const AMBIGUOUS_NAMES = new Set(["apple", "square", "target", "next", "open", "one", "go", "box", "slack", "line", "base", "form", "plaid", "notion", "front", "gap", "visa", "meta", "shift", "stack", "scale", "mission", "unity", "age", "now", "global", "international", "digital", "data", "cloud", "summit", "event", "world", "first", "central", "united", "american", "national", "advanced", "applied", "smart", "bright", "sage", "oracle", "express", "ramp"]);

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
const tokensOf = (s: string) => fold(s.replace(/\b(\p{L})\.(?=\p{L}\b)/gu, "$1").replace(/&/g, " and ")).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Lower case, accents folded, "&" as "and", punctuation as spaces, legal suffixes dropped from the end only, one space between words. */
export function normName(s: string): string {
  const t = tokensOf(s);
  while (t.length > 1 && SUFFIXES.has(t[t.length - 1])) t.pop();
  return t.join(" ");
}

const domainOnly = (norm: string) => { const t = norm.split(" "); return AMBIGUOUS_NAMES.has(norm) || (t.length === 1 && t[0].length < 3); };
const cleanDomain = (d: string | null | undefined) => (d ? d.trim().toLowerCase().replace(/^www\./, "") : "");

/* ------------------------------------------------------------------ the page */

/** The page as plain text: scripts and styles gone, block tags as line breaks, other tags removed, entities decoded, blank lines dropped. */
export function cleanPage(raw: string): string {
  return decodeEntities(
    raw.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/?(br|p|div|li|ul|ol|tr|table|h[1-6]|section|article|header|footer|figure|blockquote)\b[^>]*>/gi, "\n")
      .replace(/<\/?(td|th)\b[^>]*>/gi, " ").replace(/<[^>]*>/g, ""))
    .replace(/\r/g, "").split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
}

export interface MatchAccount { id: string; name: string; domain: string | null }
export interface PageMatch { account_id: string; matched_on: "domain" | "name"; quote: string }

const HOST = /[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const hostsOn = (line: string) => (line.match(HOST) ?? []).map((h) => cleanDomain(h));

/** Pure. One match per account per page, the first line that names it; domain is tried before name; accounts are taken in name order. */
export function matchPage(body: string, accounts: MatchAccount[]): PageMatch[] {
  const lines = cleanPage(body).split("\n");
  const hosts = lines.map(hostsOn);
  const toks = lines.map((l) => Array.from(l.replace(/\b(\p{L})\.(?=\p{L}\b)/gu, "$1").matchAll(/[\p{L}\p{N}]+|&/gu), (m) => ({ t: m[0] === "&" ? "and" : fold(m[0]), first: m[0][0], at: m.index ?? 0 })));
  const ordered = [...accounts].sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: PageMatch[] = [];
  const quote = (i: number) => lines[i].slice(0, 200).trim();
  for (const a of ordered) {
    const dom = cleanDomain(a.domain);
    if (dom) {
      const i = hosts.findIndex((h) => h.includes(dom));
      if (i >= 0) { out.push({ account_id: a.id, matched_on: "domain", quote: quote(i) }); continue; }
    }
    const norm = normName(a.name);
    if (!norm || domainOnly(norm)) continue;
    const want = norm.split(" ");
    for (let i = 0; i < lines.length; i++) {
      const t = toks[i];
      let hit = false;
      for (let s = 0; s + want.length <= t.length && !hit; s++) {
        if (want.every((w, j) => t[s + j].t === w) && /[\p{Lu}\p{N}]/u.test(t[s].first)) hit = true;
      }
      if (hit) { out.push({ account_id: a.id, matched_on: "name", quote: quote(i) }); break; }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ pages and matches */

interface PageInput { kind: string; input: string; filename?: string | null; text: string }

export async function addPage(db: Db, actor: string, catalogId: string, p: PageInput) {
  if (!(PAGE_KINDS as readonly string[]).includes(p.kind)) throw new Invalid("A page is a speaker page or a sponsor page.");
  if (!(PAGE_INPUTS as readonly string[]).includes(p.input)) throw new Invalid("A page is pasted or uploaded.");
  if (typeof p.text !== "string") throw new Invalid("Paste the text of the page.");
  if (p.text.length > MAX_PAGE_CHARS * 4) throw new Invalid(`That page is longer than ${MAX_PAGE_CHARS.toLocaleString("en-US")} characters. Paste the part with the names.`);
  const body = cleanPage(p.text);
  if (!body) throw new Invalid("There is no text on that page.");
  if (body.length > MAX_PAGE_CHARS) throw new Invalid(`That page is longer than ${MAX_PAGE_CHARS.toLocaleString("en-US")} characters. Paste the part with the names.`);
  const hash = createHash("sha256").update(body).digest("hex");
  try { return await addPageTx(db, actor, catalogId, p, body, hash); }
  catch (e) { if ((e as { code?: string })?.code === "23505") throw new RuleError("That page is already added."); throw e; }
}

async function addPageTx(db: Db, actor: string, catalogId: string, p: PageInput, body: string, hash: string) {
  return db.tx(async (q) => {
    const [cat] = await q("SELECT 1 FROM catalog_events WHERE id = $1", [catalogId]);
    if (!cat) throw new NotFound("That event is not in the list.");
    const [dup] = await q("SELECT 1 FROM roster_pages WHERE catalog_id = $1 AND body_hash = $2", [catalogId, hash]);
    if (dup) throw new RuleError("That page is already added for this event.");
    const id = newId("rpg");
    await q("INSERT INTO roster_pages (id, catalog_id, kind, input, filename, body, body_hash, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [id, catalogId, p.kind, p.input, p.filename ? String(p.filename).slice(0, 200) : null, body, hash, actor]);
    const accounts = await q<MatchAccount>("SELECT id, name, domain FROM target_accounts");
    // A rejection holds for the event, not the page: an account already rejected on any page of this event comes back rejected, with its reason.
    const prior = new Map((await q<{ account_id: string; rejected_by: string; rejected_reason: string }>(
      "SELECT DISTINCT ON (m.account_id) m.account_id, m.rejected_by, m.rejected_reason FROM roster_matches m JOIN roster_pages g ON g.id = m.page_id WHERE g.catalog_id = $1 AND m.status = 'rejected' ORDER BY m.account_id, m.rejected_at DESC", [catalogId])).map((r) => [r.account_id, r]));
    let counted = 0, rejected = 0;
    for (const m of matchPage(body, accounts)) {
      const r = prior.get(m.account_id);
      if (r) { rejected++; await q("INSERT INTO roster_matches (id, page_id, account_id, matched_on, quote, status, rejected_by, rejected_reason, rejected_at) VALUES ($1, $2, $3, $4, $5, 'rejected', $6, $7, now())", [newId("rmt"), id, m.account_id, m.matched_on, m.quote, r.rejected_by, r.rejected_reason]); }
      else { counted++; await q("INSERT INTO roster_matches (id, page_id, account_id, matched_on, quote) VALUES ($1, $2, $3, $4, $5)", [newId("rmt"), id, m.account_id, m.matched_on, m.quote]); }
    }
    return { id, matches: counted + rejected, counted, rejected };
  });
}

export async function removePage(db: Db, _actor: string, pageId: string) {
  const gone = await db.query("DELETE FROM roster_pages WHERE id = $1 RETURNING id", [pageId]);
  if (!gone.length) throw new NotFound("That page does not exist.");
  return { ok: true };
}

/** A rejection holds for the whole conference: every match of this account on every page of the same event goes together, in one transaction. */
export async function rejectMatch(db: Db, actor: string, matchId: string, reason: unknown) {
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) throw new Invalid("Say why this match is wrong.");
  return db.tx(async (q) => {
    const [m] = await q<{ account_id: string; catalog_id: string }>("SELECT m.account_id, g.catalog_id FROM roster_matches m JOIN roster_pages g ON g.id = m.page_id WHERE m.id = $1", [matchId]);
    if (!m) throw new NotFound("That match does not exist.");
    await q("UPDATE roster_matches SET status = 'rejected', rejected_by = $3, rejected_reason = $4, rejected_at = now() WHERE account_id = $1 AND page_id IN (SELECT id FROM roster_pages WHERE catalog_id = $2)", [m.account_id, m.catalog_id, actor, why.slice(0, 500)]);
    return { ok: true };
  });
}

export async function restoreMatch(db: Db, _actor: string, matchId: string) {
  return db.tx(async (q) => {
    const [m] = await q<{ account_id: string; catalog_id: string }>("SELECT m.account_id, g.catalog_id FROM roster_matches m JOIN roster_pages g ON g.id = m.page_id WHERE m.id = $1", [matchId]);
    if (!m) throw new NotFound("That match does not exist.");
    await q("UPDATE roster_matches SET status = 'counted', rejected_by = NULL, rejected_reason = NULL, rejected_at = NULL WHERE account_id = $1 AND page_id IN (SELECT id FROM roster_pages WHERE catalog_id = $2)", [m.account_id, m.catalog_id]);
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ series */

type Links = Map<string, string>;
const linksOf = async (db: Db): Promise<Links> => new Map((await db.query<{ alias_key: string; series_key: string }>("SELECT alias_key, series_key FROM series_links")).map((r) => [r.alias_key, r.series_key]));
const keyWith = (links: Links, name: string) => { const k = conferenceKey(name); return links.get(k) ?? k; };

/** The series a name belongs to: its conference key, after one planner-made link. */
export async function seriesKey(db: Db, name: string): Promise<string> { return keyWith(await linksOf(db), name); }
export { keyWith as seriesKeyWith, linksOf as seriesLinks };

/** Joins a later name to an earlier one. Both must name something; the target may not itself be an alias, and the alias may not already be a target. */
export async function addSeriesLink(db: Db, actor: string, input: { name?: unknown; same_as?: unknown; reason?: unknown }) {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new Invalid("Say why these are the same conference.");
  if (typeof input.name !== "string" || typeof input.same_as !== "string" || !input.name.trim() || !input.same_as.trim()) throw new Invalid("Give both names.");
  const alias = conferenceKey(input.name), target = conferenceKey(input.same_as);
  if (!alias || !target) throw new Invalid("Give both names.");
  if (alias === target) throw new Invalid("Those two names are already the same conference.");
  return db.tx(async (q) => {
    await q("LOCK TABLE series_links IN SHARE ROW EXCLUSIVE MODE");
    const [t] = await q("SELECT 1 FROM series_links WHERE alias_key = $1", [target]);
    if (t) throw new RuleError("That name is itself linked to another. Link to the earliest name instead.");
    const [a] = await q("SELECT 1 FROM series_links WHERE series_key = $1", [alias]);
    if (a) throw new RuleError("Another name is already linked to this one. Link that one to the earliest name instead.");
    const [have] = await q("SELECT 1 FROM series_links WHERE alias_key = $1", [alias]);
    if (have) throw new RuleError("That name is already linked.");
    await q("INSERT INTO series_links (alias_key, series_key, reason, created_by) VALUES ($1, $2, $3, $4)", [alias, target, reason.slice(0, 500), actor]);
    return { alias_key: alias, series_key: target };
  });
}

/* ------------------------------------------------------------------ likely there */

export type EvidenceKind = "page" | "past" | "captured";
export interface Likely {
  accounts: Array<{
    account_id: string; name: string; domain: string | null; owner: string | null; deal_stage: string | null; open_deal: string | null; kinds: EvidenceKind[];
    page: Array<{ match_id: string; page_id: string; kind: string; quote: string; matched_on: string }>;
    past: Array<{ catalog_id: string; name: string }>;
    captured: { people: number } | null;
  }>;
  totals: { accounts: number; by_kind: Record<EvidenceKind, number> };
  pages: Array<{ id: string; kind: string; input: string; filename: string | null; added_by: string; created_at: string; matches: Array<{ id: string; account_id: string; name: string; matched_on: string; quote: string; status: string; rejected_by: string | null; rejected_reason: string | null }> }>;
  past_lists: number;
}

interface CompanyRow { event_id: string; name: string; domain: string | null; people: number }

/** Per target account, the evidence that it will be at the candidate. People who count as evidence are attendees and onsite scans only: a prospect is a person the desk chose, not one who is going. */
export async function likelyThere(db: Db, today: string, catalogId: string): Promise<Likely> {
  const [cat] = await db.query<{ id: string; name: string; starts_on: string }>("SELECT id, name, starts_on::text AS starts_on FROM catalog_events WHERE id = $1", [catalogId]);
  if (!cat) throw new NotFound("That event is not in the list.");
  const accounts = await db.query<{ id: string; name: string; domain: string | null; owner: string | null; deal_stage: string | null; open_deal: string | null }>("SELECT id, name, domain, owner, deal_stage, open_deal FROM target_accounts ORDER BY lower(name), id");
  const rows = new Map(accounts.map((a) => [a.id, { account_id: a.id, name: a.name, domain: a.domain, owner: a.owner, deal_stage: a.deal_stage, open_deal: a.open_deal, kinds: [] as EvidenceKind[], page: [] as Likely["accounts"][number]["page"], past: [] as Likely["accounts"][number]["past"], captured: null as { people: number } | null }]));

  // Pages and their matches.
  const pageRows = await db.query<{ id: string; kind: string; input: string; filename: string | null; added_by: string; created_at: string }>("SELECT id, kind, input, filename, added_by, created_at::text AS created_at FROM roster_pages WHERE catalog_id = $1 ORDER BY created_at, id", [catalogId]);
  const matchRows = await db.query<{ id: string; page_id: string; account_id: string; matched_on: string; quote: string; status: string; rejected_by: string | null; rejected_reason: string | null; name: string }>(
    "SELECT m.id, m.page_id, m.account_id, m.matched_on, m.quote, m.status, m.rejected_by, m.rejected_reason, a.name FROM roster_matches m JOIN roster_pages g ON g.id = m.page_id JOIN target_accounts a ON a.id = m.account_id WHERE g.catalog_id = $1 ORDER BY lower(a.name), m.id", [catalogId]);
  const kindOf = new Map(pageRows.map((p) => [p.id, p.kind]));
  for (const m of matchRows) if (m.status === "counted") rows.get(m.account_id)?.page.push({ match_id: m.id, page_id: m.page_id, kind: kindOf.get(m.page_id) ?? "", quote: m.quote, matched_on: m.matched_on });

  // Earlier editions of the series that we hold a list for, and the candidate's own event.
  const links = await linksOf(db);
  const mine = keyWith(links, cat.name);
  const catalog = await db.query<{ id: string; name: string; starts_on: string }>("SELECT id, name, starts_on::text AS starts_on FROM catalog_events WHERE id <> $1 AND starts_on < $2::date AND starts_on < $3::date", [catalogId, cat.starts_on, today]);
  const earlier = catalog.filter((c) => keyWith(links, c.name) === mine);
  const companiesOf = (eventIds: string[]) => eventIds.length ? db.query<CompanyRow>(
    `SELECT co.event_id, co.name, lower(co.primary_domain) AS domain, count(DISTINCT k.id)::int AS people
     FROM companies co JOIN contacts k ON k.company_id = co.id WHERE co.event_id = ANY($1::text[]) AND k.source IN ('attendee', 'onsite')
     GROUP BY co.id, co.event_id, co.name, co.primary_domain`, [eventIds]) : Promise.resolve([] as CompanyRow[]);
  const byDomain = new Map<string, string>(), byName = new Map<string, string>();
  for (const a of accounts) {
    const d = cleanDomain(a.domain); if (d) byDomain.set(d, a.id);
    const n = normName(a.name); if (n && !domainOnly(n)) byName.set(n, a.id);
  }
  const accountFor = (c: CompanyRow) => { const d = cleanDomain(c.domain); return (d && byDomain.get(d)) || byName.get(normName(c.name)) || null; };

  let pastLists = 0;
  if (earlier.length) {
    const evs = await db.query<{ id: string; catalog_id: string }>("SELECT id, catalog_id FROM events WHERE catalog_id = ANY($1::text[])", [earlier.map((c) => c.id)]);
    const cats = new Map(earlier.map((c) => [c.id, c]));
    const evCat = new Map(evs.map((e) => [e.id, e.catalog_id]));
    const seen = new Set<string>();
    const has = new Set<string>();
    for (const c of await companiesOf(evs.map((e) => e.id))) {
      const cid = evCat.get(c.event_id)!;
      has.add(cid);
      const aid = accountFor(c);
      if (aid && !seen.has(`${aid}:${cid}`)) { seen.add(`${aid}:${cid}`); rows.get(aid)!.past.push({ catalog_id: cid, name: cats.get(cid)!.name }); }
    }
    pastLists = has.size;
  }
  const [own] = await db.query<{ id: string }>("SELECT id FROM events WHERE catalog_id = $1 AND parent_event_id IS NULL AND decline_reason IS NULL ORDER BY created_at DESC, id DESC LIMIT 1", [catalogId]);
  if (own) for (const c of await companiesOf([own.id])) {
    const aid = accountFor(c);
    if (aid) { const r = rows.get(aid)!; r.captured = { people: (r.captured?.people ?? 0) + c.people }; }
  }

  const list = [...rows.values()].filter((r) => { r.kinds = [...(r.page.length ? ["page" as const] : []), ...(r.past.length ? ["past" as const] : []), ...(r.captured ? ["captured" as const] : [])]; return r.kinds.length > 0; });
  const by_kind = { page: 0, past: 0, captured: 0 };
  for (const r of list) for (const k of r.kinds) by_kind[k]++;
  const pages = pageRows.map((p) => ({ ...p, matches: matchRows.filter((m) => m.page_id === p.id).map(({ page_id: _p, ...m }) => m) }));
  return { accounts: list, totals: { accounts: list.length, by_kind }, pages, past_lists: pastLists };
}

/** How many target accounts had a held meeting at the event: the meeting's domain equals the account's, else the contact's company reads as the account's name.
    Null when the team has no target accounts, so a caller keeps its older stand-in. */
export async function targetAccountsMet(db: Db, eventId: string): Promise<number | null> {
  const accounts = await db.query<{ id: string; name: string; domain: string | null }>("SELECT id, name, domain FROM target_accounts");
  if (!accounts.length) return null;
  const byDomain = new Map<string, string>(), byName = new Map<string, string>();
  for (const a of accounts) {
    const d = cleanDomain(a.domain); if (d) byDomain.set(d, a.id);
    const n = normName(a.name); if (n && !domainOnly(n)) byName.set(n, a.id);
  }
  const held = await db.query<{ domain: string | null; company: string | null }>("SELECT mt.domain, co.name AS company FROM meetings mt LEFT JOIN contacts k ON k.id = mt.contact_id LEFT JOIN companies co ON co.id = k.company_id WHERE mt.event_id = $1 AND mt.status = 'held'", [eventId]);
  const met = new Set<string>();
  for (const h of held) {
    const aid = (h.domain && byDomain.get(cleanDomain(h.domain))) || (h.company && byName.get(normName(h.company))) || null;
    if (aid) met.add(aid);
  }
  return met.size;
}
