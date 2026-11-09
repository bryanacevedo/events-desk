/* New registrations for a delivered event (docs/NEW-REGISTRATIONS.md, section 2, as corrected by 4a).

   A top-up is its own event row with `parent_event_id` set, invisible as an event. Stages, cards, the Run step, Slack and spend guards all apply to it as an event, and every query
   scoped by event_id reads only what is its own. The parent stays at `delivered` throughout. When the top-up reaches delivered, its rows move into the parent in the same transaction. */

import type { Db } from "./db.ts";
import { columnsOf, addSpelling, copyCompany, parentCompanies, type Outcome, type ParentCompany } from "./inherit.ts";
import { endTopUpWithin, logActivity, newId, RuleError } from "./events.ts";
import { queueDeliveredEmails } from "./crm-outbox.ts";
import { linkEventQuietly, linkQuietly } from "./person-record.ts";
import type { Crm } from "./providers.ts";
import { refreshSheet } from "./sheet-delivery.ts";
import { mockSheets, type SheetPublisher } from "./sheets.ts";
import { MAX_ROWS, toBytes, TYPES } from "./uploads.ts";
import { parseUpload, sniff } from "./xlsx-read.ts";
import { classifyEmail, nameSet } from "../shared/layer0.ts";
import { mapColumns, normalize, type Ingested, type IngestContact, type IngestSourceRow } from "../shared/ingest.ts";

export interface TopUpCounts { file_rows: number; already_in: number; new_rows: number; dropped: number; top_up_id: string | null }

/* --------------------------------------------------------------- already in */

interface PersonRow { source: string; company_id: string | null; full_name: string | null; name_hidden: boolean; email: string | null; linkedin: string | null; raw: Record<string, string>; issues: string[]; ignored: string[] }

/** What a parent's file row held as an address. `contacts.email` cannot say, because vendors overwrite it. Columns the upload ignored are not the email column; a shared mailbox was discarded for everyone at upload. */
export function fileEmails(raw: Record<string, string>, ignored: string[], issues: string[]): string[] {
  if (issues.includes("shared_email")) return [];
  const out = new Set<string>();
  for (const [k, v] of Object.entries(raw)) {
    if (ignored.includes(k) || !String(v ?? "").includes("@")) continue;
    const e = classifyEmail(String(v)).email;
    if (e) out.add(e.toLowerCase());
  }
  return [...out];
}

function indexPeople(people: PersonRow[]) {
  const emails = new Set<string>(), linkedins = new Set<string>(), names = new Set<string>(), namesNoEmail = new Set<string>();
  for (const p of people) {
    // A prospect's source row belongs to someone else, so it says nothing about the prospect's own address.
    const file = p.source === "attendee" ? fileEmails(p.raw ?? {}, p.ignored ?? [], p.issues ?? []) : [];
    for (const e of file) emails.add(e);
    if (p.email) emails.add(p.email.toLowerCase());
    if (p.linkedin) linkedins.add(p.linkedin);
    const name = p.full_name && !p.name_hidden && p.company_id ? `${nameSet(p.full_name)}|${p.company_id}` : null;
    if (name) { names.add(name); if (!file.length) namesNoEmail.add(name); }
  }
  return { emails, linkedins, names, namesNoEmail };
}

/** The rule ingest uses for duplicates within a file, against everyone on the parent, dropped or not: an email first, LinkedIn only when the row has no email, and a name only when an email is missing on one side. */
function personIsIn(index: ReturnType<typeof indexPeople>, c: IngestContact, company: ParentCompany | null) {
  const name = c.full_name && company ? `${nameSet(c.full_name)}|${company.id}` : null;
  const email = c.email?.toLowerCase() ?? null;
  if (email) return index.emails.has(email) || (name !== null && index.namesNoEmail.has(name));
  if (c.linkedin && index.linkedins.has(c.linkedin)) return true;
  return name !== null && index.names.has(name);
}

/* ------------------------------------------------------------------ create */

/** Reads the file, keeps only who the parent does not have, and creates the top-up at `mapped` in one transaction. With nothing new, no top-up exists and the file is not kept. */
export async function createTopUp(db: Db, parentId: string, actor: string, filename: string, file: string | Uint8Array | ArrayBuffer): Promise<TopUpCounts> {
  const bytes = toBytes(file);
  const parsed = await parseUpload(file);
  if (!parsed.rows.length) throw new RuleError("That file has no rows.");
  if (parsed.rows.length > MAX_ROWS) throw new RuleError(`That file has more than ${MAX_ROWS.toLocaleString("en-US")} rows.`);
  const { map, ignored, error, extras } = mapColumns(parsed);
  if (error) throw new RuleError(error);
  const data: Ingested = normalize(parsed, map, extras);

  const out = await db.tx(async (q): Promise<TopUpCounts> => {
    const [p] = await q<{ id: string; name: string; venue: string; starts_on: string; seat_price_cents: number; stage: string; country: string | null; parent_event_id: string | null; icp_version: number | null; icp_pinned_at: string | null }>(
      "SELECT id, name, venue, starts_on::text AS starts_on, seat_price_cents, stage, country, parent_event_id, icp_version, icp_pinned_at FROM events WHERE id = $1 FOR UPDATE", [parentId]);
    if (!p) throw new RuleError("That event does not exist.");
    if (p.parent_event_id) throw new RuleError("New registrations are added to the event itself.");
    if (p.stage !== "delivered") throw new RuleError("New registrations are added once the outreach list is delivered.");
    if ((await q("SELECT 1 FROM events WHERE parent_event_id = $1 AND ended_at IS NULL AND merged_at IS NULL", [parentId])).length) throw new RuleError("New registrations are already running for this event. Finish or discard them first.");

    const { companies, outcomes } = await parentCompanies(q, parentId);
    const byKey = new Map<string, ParentCompany>(), byDomain = new Map<string, ParentCompany>();
    for (const c of companies) {
      byKey.set(c.key, c);
      for (const m of c.merged_names ?? []) if (m.key && !byKey.has(m.key)) byKey.set(m.key, c);
      if (c.primary_domain) byDomain.set(c.primary_domain, c);
    }
    const evidence = new Map(data.companies.map((c) => [c.key, c]));
    /** The key, then the merged spellings, then the row's own website or email domain. */
    const companyOf = (key: string | null): ParentCompany | null => {
      if (!key) return null;
      const hit = byKey.get(key);
      if (hit) return hit;
      for (const e of evidence.get(key)?.evidence ?? []) { const d = byDomain.get(e.value); if (d) return d; }
      return null;
    };

    const index = indexPeople(await q<PersonRow>(
      `SELECT k.source, k.company_id, k.full_name, k.name_hidden, k.email, k.linkedin, r.raw, r.issues, u.ignored
       FROM contacts k JOIN source_rows r ON r.id = k.source_row_id JOIN uploads u ON u.id = r.upload_id WHERE k.event_id = $1`, [parentId]));
    const contactByRow = new Map(data.contacts.map((c) => [c.row_number, c]));

    const fresh: IngestSourceRow[] = [];
    let dropped = 0, alreadyIn = 0;
    for (const r of data.sourceRows) {
      // Junk rows, name-only rows and repeats within this file are counted apart and are never new.
      if (r.drop_reason) { dropped++; continue; }
      const c = contactByRow.get(r.row_number);
      const company = companyOf(r.company_key);
      const known = c ? personIsIn(index, c, company) : company !== null;
      if (known) alreadyIn++; else fresh.push(r);
    }
    const counts = { file_rows: parsed.rows.length, already_in: alreadyIn, new_rows: fresh.length, dropped };
    if (!fresh.length) return { ...counts, top_up_id: null };

    const id = newId("evt");
    await q(
      `INSERT INTO events (id, name, venue, starts_on, seat_count, seat_price_cents, stage, requested_by, country, flow, parent_event_id, icp_version, icp_pinned_at)
       VALUES ($1, $2, $3, $4, 0, $5, 'mapped', $6, $7, 'two_card', $8, $9, $10)`,
      [id, p.name, p.venue, p.starts_on, p.seat_price_cents, actor, p.country, parentId, p.icp_version, p.icp_pinned_at]);
    await q("INSERT INTO event_settings (event_id, settings) SELECT $1, settings FROM event_settings WHERE event_id = $2", [id, parentId]);
    const tt = await columnsOf(q, "title_tiers", ["event_id"]);
    await q(`INSERT INTO title_tiers (event_id, ${tt}) SELECT $1, ${tt} FROM title_tiers WHERE event_id = $2`, [id, parentId]);

    const uploadId = newId("upl");
    await q(
      "INSERT INTO uploads (id, event_id, filename, mapping, ignored, row_count, uploaded_by, quality, file_rows, already_in, top_up_id) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $2)",
      [uploadId, id, filename, JSON.stringify(map), JSON.stringify(ignored), fresh.length, actor, JSON.stringify(data.quality), parsed.rows.length, alreadyIn]);
    await q("INSERT INTO upload_files (upload_id, event_id, content_type, bytes) VALUES ($1, $2, $3, $4)", [uploadId, id, TYPES[sniff(bytes)], bytes]);

    // Each new row's company: a copy of the parent's, or a new one for this top-up.
    const companyIds = new Map<string, string>(), newCompanies: { id: string; key: string; name: string; evidence: unknown }[] = [];
    for (const key of new Set(fresh.map((r) => r.company_key).filter((k): k is string => Boolean(k)))) {
      const known = companyOf(key), info = evidence.get(key);
      const outcome: Outcome | undefined = known ? outcomes.get(known.id) : undefined;
      if (known && outcome && outcome.kind !== "assess") {
        const copy = await copyCompany(q, id, known.id, outcome);
        companyIds.set(key, copy);
        if (info) await addSpelling(q, copy, { key, name: info.name });
      } else {
        const cid = newId("co");
        companyIds.set(key, cid);
        newCompanies.push({ id: cid, key, name: info?.name ?? key, evidence: info?.evidence ?? [] });
      }
    }
    if (newCompanies.length) await q(
      `INSERT INTO companies (id, event_id, key, name, identity_evidence)
       SELECT id, $2, key, name, evidence FROM jsonb_to_recordset($1::jsonb) AS x(id text, key text, name text, evidence jsonb)`, [JSON.stringify(newCompanies), id]);

    const rowIds = new Map(fresh.map((r) => [r.row_number, newId("row")]));
    await q(
      `INSERT INTO source_rows (id, event_id, upload_id, row_number, raw, kind, company_id, website, issues)
       SELECT id, $2, $3, row_number, raw, kind, company_id, website, issues
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, row_number int, raw jsonb, kind text, company_id text, website text, issues jsonb)`,
      [JSON.stringify(fresh.map((r) => ({
        id: rowIds.get(r.row_number), row_number: r.row_number, raw: r.raw, kind: r.kind,
        company_id: r.company_key ? companyIds.get(r.company_key) : null, website: r.website, issues: [...new Set(r.issues)],
      }))), id, uploadId]);
    const people = fresh.flatMap((r) => { const c = contactByRow.get(r.row_number); return c ? [c] : []; });
    await q(
      `INSERT INTO contacts (id, event_id, source_row_id, company_id, full_name, title, email, linkedin)
       SELECT id, $2, source_row_id, company_id, full_name, title, email, linkedin
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, source_row_id text, company_id text, full_name text, title text, email text, linkedin text)`,
      [JSON.stringify(people.map((c) => ({
        id: newId("con"), source_row_id: rowIds.get(c.row_number), company_id: c.company_key ? companyIds.get(c.company_key) : null,
        full_name: c.full_name, title: c.title, email: c.email, linkedin: c.linkedin,
      }))), id]);
    await logActivity(q, id, actor, "mapped", `${filename || "A file"}: ${fresh.length} new, ${alreadyIn} already in, ${dropped} not usable`);
    return { ...counts, top_up_id: id };
  });
  if (out.top_up_id) await linkEventQuietly(db, out.top_up_id);
  return out;
}

/* --------------------------------------------------------------------- end */

export const endTopUp = (db: Db, id: string, actor: string, reason: string) => db.tx((q) => endTopUpWithin(q, id, actor, reason));

/* ------------------------------------------------------------------- merge */

interface TopCompany { id: string; key: string; name: string; primary_domain: string | null; inherited_from: string | null; merged_names: { key?: string; name?: string }[]; tier: number | null }

/** Moves everything a delivered top-up holds into its parent, in the caller's transaction, which is the one that moved it to delivered: a crash leaves it unmoved and still running.
    Runs after openLaterCases. Returns the people it brought, so they can be linked outside the transaction. */
export async function mergeTopUp(q: Db["query"], topUpId: string, actor: string, crm: Crm | null | undefined) {
  const [t] = await q<{ parent_event_id: string | null; merged_at: string | null; ended_at: string | null; stage: string }>("SELECT parent_event_id, merged_at, ended_at, stage FROM events WHERE id = $1 FOR UPDATE", [topUpId]);
  if (!t?.parent_event_id) throw new RuleError("That is not a list of new registrations.");
  if (t.merged_at) return { contact_ids: [] as string[], parent_id: t.parent_event_id };
  if (t.ended_at) throw new RuleError("These new registrations were stopped.");
  const parentId = t.parent_event_id;
  const [p] = await q<{ stage: string }>("SELECT stage FROM events WHERE id = $1 FOR UPDATE", [parentId]);
  if (p.stage !== "delivered") throw new RuleError("The event is not delivered, so nothing can be added to it.");

  // So outreach never reaches someone twice.
  const dupes = await q<{ id: string }>(
    `UPDATE contacts k SET drop_reason = 'duplicate', dropped_at = now()
     WHERE k.event_id = $1 AND k.dropped_at IS NULL AND k.email IS NOT NULL
       AND EXISTS (SELECT 1 FROM contacts x WHERE x.event_id = $2 AND x.dropped_at IS NULL AND lower(x.email) = lower(k.email)) RETURNING k.id`, [topUpId, parentId]);
  if (dupes.length) await q(
    "UPDATE review_cases SET status = 'skipped', decision = 'duplicate', decided_by = $3, decided_at = now() WHERE event_id = $1 AND status = 'open' AND contact_id = ANY($2::text[])", [topUpId, dupes.map((d) => d.id), actor]);
  // What Salesforce is owed is queued with the merge and not before, for exactly the people who are staying.
  await queueDeliveredEmails(q, topUpId, crm, parentId);

  const mine = await q<TopCompany>("SELECT id, key, name, primary_domain, inherited_from, merged_names, tier FROM companies WHERE event_id = $1", [topUpId]);
  const theirs = await q<{ id: string; key: string; primary_domain: string | null; merged_names: { key?: string }[] }>("SELECT id, key, primary_domain, merged_names FROM companies WHERE event_id = $1", [parentId]);
  const byKey = new Map<string, string>(), byDomain = new Map<string, string>();
  for (const c of theirs) {
    byKey.set(c.key, c.id);
    for (const m of c.merged_names ?? []) if (m.key && !byKey.has(m.key)) byKey.set(m.key, c.id);
    if (c.primary_domain) byDomain.set(c.primary_domain, c.id);
  }
  const moved: string[] = [], gone: string[] = [];
  for (const c of mine) {
    // A new company whose key or domain the parent has by now is folded in, rather than aborting on the key.
    const target = c.inherited_from ?? byKey.get(c.key) ?? (c.primary_domain ? byDomain.get(c.primary_domain) : undefined);
    if (!target) { moved.push(c.id); continue; }
    gone.push(c.id);
    for (const table of ["contacts", "source_rows", "review_cases"]) await q(`UPDATE ${table} SET company_id = $2 WHERE company_id = $1`, [c.id, target]);
    // Spellings the parent has not seen. A company the parent skipped and this run assessed gets its first assessment; a company the parent already tiered keeps its own.
    const spellings = [...(c.merged_names ?? []), ...(c.inherited_from ? [] : [{ key: c.key, name: c.name }])];
    for (const s of spellings) if (s.key && s.name) await addSpelling(q, target, { key: s.key, name: s.name });
    if (!c.inherited_from && c.tier !== null) await q(
      `UPDATE companies p SET tier = t.tier, tier_reason = t.tier_reason, segment = t.segment, company_type = t.company_type, tier_fact = t.tier_fact, tier_via = t.tier_via, tier_icp_version = t.tier_icp_version, baseline_tier = t.baseline_tier,
         firmo = coalesce(p.firmo, t.firmo), firmo_source = coalesce(p.firmo_source, t.firmo_source), website_note = coalesce(p.website_note, t.website_note), primary_domain = coalesce(p.primary_domain, t.primary_domain),
         identity_state = CASE WHEN p.primary_domain IS NULL THEN t.identity_state ELSE p.identity_state END, identity_via = coalesce(p.identity_via, t.identity_via), in_research = true,
         account_owner = coalesce(p.account_owner, t.account_owner), deal_name = coalesce(p.deal_name, t.deal_name), deal_stage = coalesce(p.deal_stage, t.deal_stage), last_activity = coalesce(p.last_activity, t.last_activity), heat = coalesce(p.heat, t.heat), account_type = coalesce(p.account_type, t.account_type)
       FROM companies t WHERE p.id = $1 AND t.id = $2 AND p.tier IS NULL`, [target, c.id]);
  }
  if (gone.length) await q("UPDATE companies SET parent_id = NULL WHERE parent_id = ANY($1::text[])", [gone]);

  const people = await q<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1", [topUpId]);
  if (moved.length) await q("UPDATE companies SET event_id = $2 WHERE id = ANY($1::text[])", [moved, parentId]);
  for (const table of ["source_rows", "contacts", "review_cases", "uploads", "upload_files"]) await q(`UPDATE ${table} SET event_id = $2 WHERE event_id = $1`, [topUpId, parentId]);
  const tt = await columnsOf(q, "title_tiers", ["event_id"]);
  await q(`INSERT INTO title_tiers (event_id, ${tt}) SELECT $2, ${tt} FROM title_tiers WHERE event_id = $1 ON CONFLICT DO NOTHING`, [topUpId, parentId]);
  await q("DELETE FROM title_tiers WHERE event_id = $1", [topUpId]);
  await q("DELETE FROM companies WHERE event_id = $1", [topUpId]);
  await q("UPDATE events SET merged_at = now(), updated_at = now() WHERE id = $1", [topUpId]);

  const kept = people.length - dupes.length;
  await logActivity(q, parentId, actor, "new_registrations", `Attendee list: added ${kept === 1 ? "1 person" : `${kept} people`} from new registrations`);
  return { contact_ids: people.map((r) => r.id), parent_id: parentId };
}

/** After a merge, outside its transaction: the person record links the people who arrived, and the parent's Sheet takes them. Neither can undo the merge. */
export async function afterMerge(db: Db, merged: { contact_ids: string[]; parent_id: string }, actor: string, sheets: SheetPublisher | undefined, vendor?: string | null) {
  for (const id of merged.contact_ids) await linkQuietly(db, id, { vendor });
  await refreshSheet(db, merged.parent_id, actor, sheets ?? mockSheets).catch((e) => console.error("sheet refresh", merged.parent_id, e));
}

/** At boot. A top-up left at delivered and not merged is merged now, so a crash cannot block the next one, and a merged one whose Sheet never took its rows is tried again. */
export async function retryMerges(db: Db, crm: Crm | null | undefined, sheets: SheetPublisher | undefined) {
  const SYSTEM = "Events Desk";
  const stuck = await db.query<{ id: string }>("SELECT id FROM events WHERE parent_event_id IS NOT NULL AND stage = 'delivered' AND merged_at IS NULL AND ended_at IS NULL");
  for (const { id } of stuck) {
    try { await afterMerge(db, await db.tx((q) => mergeTopUp(q, id, SYSTEM, crm)), SYSTEM, sheets); }
    catch (e) { console.error("top-up merge", id, e); }
  }
  const stale = await db.query<{ parent_event_id: string }>("SELECT DISTINCT parent_event_id FROM events WHERE merged_at IS NOT NULL AND sheet_refreshed_at IS NULL");
  for (const { parent_event_id } of stale) await refreshSheet(db, parent_event_id, SYSTEM, sheets ?? mockSheets).catch((e) => console.error("sheet refresh", parent_event_id, e));
  return { merged: stuck.length, refreshed: stale.length };
}

/* -------------------------------------------------------------------- read */

export interface TopUpItem { id: string; stage: string; ended_at: string | null; ended_reason: string | null; merged_at: string | null; created_at: string; upload_id: string | null; filename: string | null; uploaded_by: string | null; file_rows: number | null; already_in: number | null; new_rows: number | null; has_file: boolean }

export const topUpsOf = (db: Db, parentId: string) => db.query<TopUpItem>(
  `SELECT e.id, e.stage, e.ended_at, e.ended_reason, e.merged_at, e.created_at, u.id AS upload_id, u.filename, u.uploaded_by, u.file_rows, u.already_in, u.row_count AS new_rows,
          EXISTS (SELECT 1 FROM upload_files f WHERE f.upload_id = u.id) AS has_file
   FROM events e LEFT JOIN uploads u ON u.top_up_id = e.id WHERE e.parent_event_id = $1 ORDER BY e.created_at, e.id`, [parentId]);
