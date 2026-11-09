/* One record per person across events (docs/DATA-HYGIENE.md, sections 4 and 6a). A contact is linked at upload and again whenever an address, a LinkedIn profile or a vendor id is learned,
   matched in that order. A name alone never links. Role addresses and shared ones never link either. Two rows found to be one are merged, the older id surviving.

   Nothing in a run reads this. Every call from the pipeline goes through a `Quietly` function, in its own transaction and caught, so an error here cannot change a run. */

import type { Db } from "./db.ts";
import { newId } from "./events.ts";
import { isDisposable, isRoleAddress, nameKey } from "../shared/email.ts";

export interface LinkOpts {
  /** The vendor behind this contact's vendor_person_id. Without it the id is not used. */
  vendor?: string | null;
  /** The contact's address has just passed. */
  verified?: boolean;
}

/** Clearly two people? Word order, a middle name and an initial do not make two people. Either name missing says nothing. */
export function differentPeople(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const x = nameKey(a).split(" ").filter(Boolean), y = nameKey(b).split(" ").filter(Boolean);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const fits = (t: string) => long.includes(t) || long.some((l) => (t.length === 1 && l.startsWith(t)) || (l.length === 1 && t.startsWith(l)));
  return !short.every(fits);
}

/** May this address identify a person? Not a role or disposable mailbox, and not one used under another person's name. A shared address found late is taken back from whoever held it. */
async function linkable(q: Db["query"], email: string, name: string | null, contactId: string) {
  if (isRoleAddress(email) || isDisposable(email)) return false;
  const others = await q<{ full_name: string | null }>("SELECT full_name FROM contacts WHERE lower(email) = $1 AND id <> $2 AND full_name IS NOT NULL AND NOT name_hidden", [email, contactId]);
  if (!others.some((o) => differentPeople(o.full_name, name))) return true;
  await q("DELETE FROM person_emails WHERE email = $1", [email]);
  await q("UPDATE people SET email = NULL WHERE email = $1", [email]);
  return false;
}

interface PersonRow { id: string; email: string | null; linkedin: string | null; vendor: string | null; vendor_person_id: string | null; full_name: string | null; first_seen: string; last_seen: string; last_verified_at: string | null }

/** Folds the rows into the oldest. Everything that points at a row that goes is repointed first. */
async function mergePeople(q: Db["query"], ids: string[]): Promise<string> {
  const rows = await q<PersonRow>("SELECT id, email, linkedin, vendor, vendor_person_id, full_name, first_seen, last_seen, last_verified_at FROM people WHERE id = ANY($1::text[]) ORDER BY first_seen, id", [ids]);
  const [keep, ...rest] = rows;
  for (const lose of rest) {
    await q("UPDATE contacts SET person_id = $2 WHERE person_id = $1", [lose.id, keep.id]);
    await q("UPDATE crm_outbox SET person_id = $2 WHERE person_id = $1", [lose.id, keep.id]);
    await q("UPDATE person_emails SET person_id = $2 WHERE person_id = $1", [lose.id, keep.id]);
    await q("DELETE FROM people WHERE id = $1", [lose.id]);
    await q(
      `UPDATE people SET email = coalesce(email, $2), linkedin = coalesce(linkedin, $3), vendor = coalesce(vendor, $4), vendor_person_id = CASE WHEN vendor IS NULL THEN $5 ELSE vendor_person_id END, full_name = coalesce(full_name, $6),
         first_seen = least(first_seen, $7::timestamptz), last_seen = greatest(last_seen, $8::timestamptz), last_verified_at = greatest(last_verified_at, $9::timestamptz) WHERE id = $1`,
      [keep.id, lose.email, lose.linkedin, lose.vendor, lose.vendor_person_id, lose.full_name, lose.first_seen, lose.last_seen, lose.last_verified_at]);
    if (!keep.vendor && lose.vendor) keep.vendor = lose.vendor;
  }
  return keep.id;
}

export async function linkContact(q: Db["query"], contactId: string, opts: LinkOpts = {}): Promise<string | null> {
  const [k] = await q<{ email: string | null; linkedin: string | null; vendor_person_id: string | null; full_name: string | null; name_hidden: boolean; drop_reason: string | null; person_id: string | null }>(
    "SELECT email, linkedin, vendor_person_id, full_name, name_hidden, drop_reason, person_id FROM contacts WHERE id = $1", [contactId]);
  if (!k || k.drop_reason === "junk_row") return null;
  const name = k.name_hidden ? null : k.full_name;
  let email = k.email?.toLowerCase().trim() || null;
  if (email && !(await linkable(q, email, name, contactId))) email = null;
  const linkedin = k.linkedin || null;
  const vendor = k.vendor_person_id && opts.vendor ? { vendor: opts.vendor, id: k.vendor_person_id } : null;
  if (!email && !linkedin && !vendor) return null;

  const found: string[] = [];
  if (email) found.push(...(await q<{ id: string }>("SELECT person_id AS id FROM person_emails WHERE email = $1", [email])).map((r) => r.id));
  if (linkedin) found.push(...(await q<{ id: string }>("SELECT id FROM people WHERE linkedin = $1", [linkedin])).map((r) => r.id));
  if (vendor) found.push(...(await q<{ id: string }>("SELECT id FROM people WHERE vendor = $1 AND vendor_person_id = $2", [vendor.vendor, vendor.id])).map((r) => r.id));
  if (k.person_id) found.push(k.person_id);
  const ids = [...new Set(found)];

  let id: string;
  if (!ids.length) {
    id = newId("per");
    await q("INSERT INTO people (id, email, linkedin, vendor, vendor_person_id, full_name) VALUES ($1, $2, $3, $4, $5, $6)", [id, email, linkedin, vendor?.vendor ?? null, vendor?.id ?? null, name]);
  } else {
    id = ids.length === 1 ? ids[0] : await mergePeople(q, ids);
    await q(
      `UPDATE people SET email = coalesce($2, email), linkedin = coalesce(linkedin, $3), vendor = coalesce(vendor, $4), vendor_person_id = CASE WHEN vendor IS NULL THEN $5 ELSE vendor_person_id END, full_name = coalesce(full_name, $6), last_seen = now() WHERE id = $1`,
      [id, email, linkedin, vendor?.vendor ?? null, vendor?.id ?? null, name]);
  }
  if (email) await q("INSERT INTO person_emails (email, person_id) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET last_seen = now()", [email, id]);
  if (opts.verified) await q("UPDATE people SET last_verified_at = greatest(last_verified_at, coalesce((SELECT checked_at FROM verification_cache WHERE email = $2), now())) WHERE id = $1", [id, email]);
  if (k.person_id !== id) await q("UPDATE contacts SET person_id = $2 WHERE id = $1", [contactId, id]);
  return id;
}

export async function linkQuietly(db: Db, contactId: string, opts: LinkOpts = {}) {
  try { await db.tx((q) => linkContact(q, contactId, opts)); }
  catch (e) { console.error("people link", contactId, e); }
}

/** Every contact of an event, after an upload. */
export async function linkEventQuietly(db: Db, eventId: string) {
  try {
    const ids = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 ORDER BY id", [eventId]);
    await db.tx(async (q) => { for (const { id } of ids) await linkContact(q, id); });
  } catch (e) { console.error("people link", eventId, e); }
}

/** After contacts have gone: a person nobody points at is removed, and what was still waiting to be written about them goes too. Opt-outs have no person_id and stay. */
export async function pruneOrphans(q: Db["query"]) {
  const gone = "(SELECT p.id FROM people p WHERE NOT EXISTS (SELECT 1 FROM contacts k WHERE k.person_id = p.id))";
  await q(`UPDATE crm_outbox SET status = 'cancelled', person_id = NULL, done_at = now() WHERE status = 'queued' AND person_id IN ${gone}`);
  await q(`DELETE FROM people WHERE id IN ${gone}`);
}
export const pruneQuietly = (db: Db) => db.tx(pruneOrphans).catch((e) => console.error("people prune", e));
