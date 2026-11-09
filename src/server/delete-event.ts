/* Deleting an event, by hand, never by itself. The event's own rows go (its list, companies, people, cases, cards, settings, seat
   requests, history) and so do its stored files. What outlives it:
   - Lists that span events: suppressions and opt-outs, ICP versions, the vendor and company caches, reveals, the catalog entry it came from, and anyone in `people` still seen at another event.
   - Money already spent. Usage pools count credits and AI calls by date from the ledger, and the Budget counts tickets bought, so the
     ledger rows and the bought tickets are copied to ledger_kept and ticket_spend_kept in the same transaction. A pool then reads the same
     before and after. Seats not yet bought and money never spent leave with the event, as they do when an event is ended.
   The Google Sheet is not touched: it stays in Drive. */

import type { Db } from "./db.ts";
import { newId, RuleError } from "./events.ts";
import { Forbidden } from "./seats.ts";
import { defaultSettings } from "./approvals.ts";
import { pruneQuietly } from "./person-record.ts";
import { isGtm } from "../shared/roles.ts";

/** Stages in which a pipeline run is going. Deleting waits until it stops. */
export const RUNNING_STAGES = ["tiering", "enriching", "flagging", "researching", "finding_people"];

export function canDeleteEvent(actor: string, approvers: string[] = (defaultSettings().approvers ?? []) as string[]) {
  return isGtm(actor) || approvers.includes(actor);
}

export async function deleteEvent(db: Db, actor: string, eventId: string, approvers?: string[]) {
  if (!canDeleteEvent(actor, approvers)) throw new Forbidden("Only GTM Engineering and the seat approvers delete events.");
  const out = await db.tx(async (q) => {
    const [e] = await q<{ id: string; name: string; stage: string; starts_on: string; country: string | null; parent_event_id: string | null }>("SELECT id, name, stage, starts_on::text AS starts_on, country, parent_event_id FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (!e) throw new RuleError("That event does not exist.");
    if (e.parent_event_id) throw new RuleError("New registrations are discarded, not deleted.");
    const [seq] = await q("SELECT 1 FROM sequences WHERE event_id = $1 LIMIT 1", [eventId]);
    if (seq) throw new RuleError("This event has sequences, so its history has to stay. It cannot be deleted.");
    const [met] = await q("SELECT 1 FROM meetings WHERE event_id = $1 LIMIT 1", [eventId]);
    if (met) throw new RuleError("This event has meetings on record, so it cannot be deleted.");
    if (RUNNING_STAGES.includes(e.stage)) throw new RuleError("A run is in progress. Delete it once it stops.");
    // Its top-ups go with it, and what they spent is kept with what it spent.
    const family = [eventId, ...(await q<{ id: string }>("SELECT id FROM events WHERE parent_event_id = $1", [eventId])).map((t) => t.id)];
    if ((await q("SELECT 1 FROM events WHERE parent_event_id = $1 AND ended_at IS NULL AND merged_at IS NULL AND stage = ANY($2::text[])", [eventId, RUNNING_STAGES])).length) throw new RuleError("A run is in progress. Delete it once it stops.");
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM jobs j JOIN events ev ON ev.id = j.event_id WHERE j.event_id = ANY($1::text[]) AND j.status IN ('queued', 'running') AND ev.ended_at IS NULL", [family]);
    if (n > 0) throw new RuleError("Work is still queued for this event. Delete it once it finishes.");

    // Credits and AI calls already spent. The note of the reservation is resolved now, because the pool tally reads it from the reservation row.
    await q(
      `INSERT INTO ledger_kept (id, event_id, event_name, unit, kind, amount, reservation_id, note, step, created_at)
       SELECT l.id, l.event_id, $2, l.unit, l.kind, l.amount, l.reservation_id, coalesce((SELECT r.note FROM credit_ledger r WHERE r.id = l.reservation_id), l.note), l.step, l.created_at
       FROM credit_ledger l WHERE l.event_id = ANY($1::text[])`, [family, e.name]);

    // The tokens behind the AI calls, so real AI dollars stay truthful after the event is gone (llm_calls cascades with it).
    await q(
      `INSERT INTO llm_calls_kept (id, event_id, step, model, input_tokens, output_tokens, created_at)
       SELECT id, event_id, step, model, input_tokens, output_tokens, created_at FROM llm_calls WHERE event_id = ANY($1::text[])`, [family]);

    // Tickets recorded as bought are money spent, whatever became of the event.
    let ticketsKept = 0;
    {
      const kept = await q<{ amount_cents: number }>(
        `INSERT INTO ticket_spend_kept (id, event_id, event_name, starts_on, country, team, amount_cents)
         SELECT p.seat_request_id, $1, $2, $3, $4, r.team, p.amount_cents
         FROM ticket_purchases p JOIN seat_requests r ON r.id = p.seat_request_id WHERE p.event_id = $1 AND r.status = 'approved'
         RETURNING amount_cents`, [eventId, e.name, e.starts_on, e.country]);
      ticketsKept = kept.reduce((n, r) => n + r.amount_cents, 0);
      if (kept.length) {
        const money = `$${(ticketsKept / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
        await q("INSERT INTO budget_log (id, year, actor, detail) VALUES ($1, $2, $3, $4)", [newId("bl"), Number(e.starts_on.slice(0, 4)), actor, `Deleted ${e.name}; ${money} of tickets bought stays counted`]);
      }
    }

    // Everything the event owns cascades from this one row: uploads and their files, source rows, companies, contacts, cases, jobs,
    // cost cards, approvals, the ledger, settings, seat requests, ticket purchases and history.
    await q("DELETE FROM events WHERE id = $1", [eventId]);
    return { deleted: eventId, name: e.name, tickets_kept_cents: ticketsKept };
  });
  // Outside the delete's own transaction: the person record can never hold a delete back.
  await pruneQuietly(db);
  return out;
}
