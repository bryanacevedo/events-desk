/* What is owed to Salesforce (docs/DATA-HYGIENE.md, sections 5 and 6a). A row is queued in the same transaction as the thing that caused it, and sent by a sweep started at boot, never by a
   run, so a failed write cannot touch a delivery. Nothing is queued unless the CRM can write: `noCrm` cannot, so live mode queues nothing.

   It fills blank fields and never overwrites a Salesforce value. Email Opt Out is a checkbox, so an opt-out sets it: that is the one exception. A write goes to every record that matches, and
   the seam has no way to create one. */

import type { Db } from "./db.ts";
import { newId } from "./events.ts";
import { askPeople, crmConnected } from "./crm-checks.ts";
import type { Crm, CrmPatch, CrmRecord } from "./providers.ts";

export const MAX_ATTEMPTS = 5;
export const canWrite = (crm: Crm | null | undefined): crm is Crm => crmConnected(crm) && typeof crm.write === "function";

export type OutboxKind = "email" | "opt_out";
export interface OutboxPayload { email: string | null; full_name: string | null; company: string | null; domain: string | null; event_id?: string }

/** Each kept person with an address checked twice. Runs inside the delivery's own transaction. */
export async function queueDeliveredEmails(q: Db["query"], eventId: string, crm: Crm | null | undefined, payloadEventId: string = eventId) {
  if (!canWrite(crm)) return;
  const rows = await q<{ person_id: string | null; email: string; full_name: string | null; company: string; domain: string | null }>(
    `SELECT k.person_id, lower(k.email) AS email, k.full_name, co.name AS company, co.primary_domain AS domain FROM contacts k JOIN companies co ON co.id = k.company_id
     WHERE k.event_id = $1 AND k.dropped_at IS NULL AND k.priority IS NOT NULL AND k.email IS NOT NULL AND k.verify_1 = 'deliverable' AND k.verify_2 = 'deliverable' ORDER BY k.id`, [eventId]);
  for (const r of rows) await q("INSERT INTO crm_outbox (id, person_id, kind, payload) VALUES ($1, $2, 'email', $3::jsonb)", [newId("obx"), r.person_id, JSON.stringify({ email: r.email, full_name: r.full_name, company: r.company, domain: r.domain, event_id: payloadEventId })]);
}

/** Keyed by address or by name, as the opt-out was recorded. */
export async function queueOptOut(q: Db["query"], crm: Crm | null | undefined, p: { email: string | null; name: string | null; company: string | null }) {
  if (!canWrite(crm)) return;
  await q("INSERT INTO crm_outbox (id, kind, payload) VALUES ($1, 'opt_out', $2::jsonb)", [newId("obx"), JSON.stringify({ email: p.email, full_name: p.name, company: p.company, domain: null })]);
}

/** What one record should get. Null when it has nothing blank to fill. */
export function patchFor(kind: OutboxKind, record: CrmRecord, p: OutboxPayload): CrmPatch | null {
  if (kind === "opt_out") return record.email_opt_out ? null : { email_opt_out: true };
  return record.email || !p.email ? null : { email: p.email };
}

/** Sends what is queued. A row that fails is tried again by a later sweep, up to MAX_ATTEMPTS, and then stays as `failed`. Each write only fills blanks, so repeating one is harmless. */
export async function drainOutbox(db: Db, crm: Crm | null | undefined, limit = 500) {
  const out = { sent: 0, failed: 0, none: 0 };
  if (!canWrite(crm)) return out;
  const rows = await db.query<{ id: string; kind: OutboxKind; payload: OutboxPayload; attempts: number }>("SELECT id, kind, payload, attempts FROM crm_outbox WHERE status = 'queued' ORDER BY created_at, id LIMIT $1", [limit]);
  for (const r of rows) {
    try {
      const p = r.payload;
      // By address and by name at the account: a record with a blank email can only be found by name.
      const records = (await askPeople(crm, [{ ref: r.id, email: p.email, full_name: p.full_name, company: p.company, domain: p.domain }]))[r.id];
      for (const record of records) {
        const patch = patchFor(r.kind, record, p);
        if (patch) await crm.write!(record, patch);
      }
      if (!records.length) out.none++;
      await db.query("UPDATE crm_outbox SET status = 'done', attempts = attempts + 1, last_error = NULL, done_at = now() WHERE id = $1", [r.id]);
      out.sent++;
    } catch (e) {
      const tries = r.attempts + 1;
      await db.query("UPDATE crm_outbox SET attempts = $2, status = $3, last_error = $4 WHERE id = $1", [r.id, tries, tries >= MAX_ATTEMPTS ? "failed" : "queued", String((e as Error)?.message ?? e).slice(0, 300)]);
      out.failed++;
    }
  }
  return out;
}

/** A sweep that cannot fail: called from the timer in node.ts. */
export const drainQuietly = (db: Db, crm: Crm | null | undefined) => drainOutbox(db, crm).catch((e) => { console.error("crm outbox", e); return null; });
