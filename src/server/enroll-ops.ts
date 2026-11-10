/* Stopping and starting people. These only write rows: the call to the tool happens later, from `pending_op`, so a stop is durable the moment its transaction commits and a tool that is down cannot lose it. */

import type { Db } from "./db.ts";
import { SAME_COMPANY } from "./touches.ts";

type Q = Db["query"];
export type StopOp = "pause" | "remove";

/** Every open enrollment for these people, at every event: by contact, by the person record, and by address. */
async function enrollmentsOf(q: Q, contactIds: string[]) {
  if (!contactIds.length) return [];
  return q<{ id: string; state: string; external_contact_id: string | null; pending_op: string | null; add_attempted: boolean }>(
    `SELECT DISTINCT n.id, n.state, n.external_contact_id, n.pending_op, n.add_attempted FROM enrollments n JOIN contacts k ON k.id = n.contact_id
     WHERE n.state <> 'removed' AND (n.contact_id = ANY($1::text[])
       OR n.person_id IN (SELECT person_id FROM contacts WHERE id = ANY($1::text[]) AND person_id IS NOT NULL)
       OR lower(k.email) IN (SELECT lower(email) FROM contacts WHERE id = ANY($1::text[]) AND email IS NOT NULL))`, [contactIds]);
}

type Row = { id: string; state: string; external_contact_id: string | null; pending_op?: string | null; add_attempted?: boolean };

/** A row may be in the tool if it has an id there, or if an add was sent whose answer never came back. Either way the stop is owed to the tool. */
const inTool = (r: Row) => Boolean(r.external_contact_id || r.add_attempted);
/** The same rule as `inTool`, for an UPDATE over many rows: the remove the tool is still owed, or none. */
export const OWED_REMOVE_SQL = "CASE WHEN external_contact_id IS NULL AND NOT add_attempted THEN NULL ELSE 'remove' END";

async function applyStop(q: Q, rows: Row[], op: StopOp, cause: string, causeId: string | null) {
  for (const r of rows) {
    if (op === "remove") {
      await q("UPDATE enrollments SET state = 'removed', pending_op = $2, cause = $3, cause_id = $4, resume_at = NULL, changed_at = now() WHERE id = $1", [r.id, inTool(r) ? "remove" : null, cause, causeId]);
    } else if (r.state !== "paused") {
      await q("UPDATE enrollments SET state = 'paused', pending_op = $2, cause = $3, cause_id = $4, resume_at = NULL, changed_at = now() WHERE id = $1", [r.id, inTool(r) ? "pause" : null, cause, causeId]);
    } else {
      // Already paused: any scheduled or queued resume is cancelled, and nothing restarts on its own. The earlier reason stays (a meeting or a hold must not turn into a reply an out-of-office could restart); only no reason or an older out-of-office is replaced.
      await q("UPDATE enrollments SET pending_op = CASE WHEN pending_op = 'resume' THEN NULL ELSE pending_op END, cause = CASE WHEN cause IS NULL OR cause = 'out_of_office' THEN $2 ELSE cause END, cause_id = CASE WHEN cause IS NULL OR cause = 'out_of_office' THEN $3 ELSE cause_id END, resume_at = NULL, changed_at = now() WHERE id = $1", [r.id, cause, causeId]);
    }
  }
  return rows.length;
}

/** Removals that do not count against a later press: people removed for one of these causes may be added to the same event again. Every other cause (a no, an opt-out, a bounce, a gate refusal) keeps them out. */
export const RETURNABLE_CAUSES = ["event_started"];

export const stopContacts = async (q: Q, contactIds: string[], op: StopOp, cause: string, causeId: string | null = null) =>
  applyStop(q, await enrollmentsOf(q, contactIds), op, cause, causeId);

/** Everyone at a domain. `eventId` limits it to that event. */
export async function stopDomain(q: Q, domain: string, op: StopOp, cause: string, causeId: string | null, eventId: string | null = null) {
  const rows = await q<Row>(
    `SELECT id, state, external_contact_id, pending_op, add_attempted FROM enrollments WHERE domain IN ${SAME_COMPANY} AND state <> 'removed' AND ($2::text IS NULL OR event_id = $2)`, [domain, eventId]);
  return applyStop(q, rows, op, cause, causeId);
}

/** Only this event's sequences, for a person who said not interested or not now. */
export async function stopInEvent(q: Q, contactId: string, eventId: string, cause: string, causeId: string | null) {
  const rows = await q<Row>("SELECT id, state, external_contact_id, pending_op, add_attempted FROM enrollments WHERE contact_id = $1 AND event_id = $2 AND state <> 'removed'", [contactId, eventId]);
  return applyStop(q, rows, "remove", cause, causeId);
}

/** Marks paused people for a resume at `at`. The gate still decides when the time comes. */
export const scheduleResume = (q: Q, where: { cause: string; causeId?: string; contactIds?: string[] }, at: Date) => q(
  `UPDATE enrollments SET resume_at = $1 WHERE state = 'paused' AND cause = $2 AND ($3::text IS NULL OR cause_id = $3) AND ($4::text[] IS NULL OR contact_id = ANY($4::text[]))`,
  [at.toISOString(), where.cause, where.causeId ?? null, where.contactIds ?? null]);
