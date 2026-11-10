/* Event writes. Every one is a single transaction and adds an activity_log row.
   moveEvent is the only way a stage changes, and later slices call it from the
   approval and pipeline code. There is deliberately no public "set stage" route,
   so an approval can never be skipped over HTTP. */

import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { DEFAULT_FLOW, moveError, type EventRow, type Flow, type Stage } from "../shared/domain.ts";

export const newId = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

export const EVENT_COLS = `id, name, venue, starts_on::text AS starts_on, ends_on::text AS ends_on, seat_count, seat_price_cents, stage, paused_from,
  decline_reason, requested_by, created_at, updated_at, stage_changed_at, country, flow, parent_event_id, ended_at, merged_at, motion`;

export class RuleError extends Error {}
/** A top-up that was ended or has already merged never moves again. */
export class TopUpClosed extends RuleError {}

export const logActivity = (q: Db["query"], eventId: string, actor: string, kind: string, detail: string) =>
  q("INSERT INTO activity_log (id, event_id, actor, kind, detail) VALUES ($1, $2, $3, $4, $5)", [newId("act"), eventId, actor, kind, detail]);

export async function createEvent(db: Db, actor: string, b: { name: string; venue?: string; starts_on: string; ends_on?: string | null; seat_count: number; seat_price_cents: number; country?: string | null; flow?: Flow }, fixedId?: string, approvers?: string[]) {
  return db.tx(async (q) => {
    const id = fixedId ?? newId("evt");
    const [row] = await q<EventRow>(
      `INSERT INTO events (id, name, venue, starts_on, ends_on, seat_count, seat_price_cents, requested_by, country, flow)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${EVENT_COLS}`,
      [id, b.name.trim(), b.venue?.trim() ?? "", b.starts_on, b.ends_on || null, b.seat_count, b.seat_price_cents, actor, b.country?.trim() || null, b.flow ?? DEFAULT_FLOW],
    );
    await q("INSERT INTO event_settings (event_id, settings) VALUES ($1, $2::jsonb)", [id, JSON.stringify({ ...JSON.parse(readFileSync(new URL("../../config/defaults.json", import.meta.url), "utf8")), ...(approvers ? { approvers } : {}) })]);
    await q("INSERT INTO approvals (id, event_id, kind, requested_by) VALUES ($1, $2, 'seats', $3)", [newId("apr"), id, actor]);
    await logActivity(q, id, actor, "requested", `Asked for ${b.seat_count} seats`);
    return row;
  });
}

/** Moves an event inside a transaction the caller already holds. */
export async function moveWithin(q: Db["query"], id: string, to: Stage, actor: string, opts: { reason?: string; detail?: string } = {}) {
  const [e] = await q<EventRow>(`SELECT ${EVENT_COLS} FROM events WHERE id = $1 FOR UPDATE`, [id]);
  if (!e) throw new RuleError("That event does not exist.");
  if (e.ended_at || e.merged_at) throw new TopUpClosed("These new registrations are no longer running.");
  const err = moveError(e, to, opts.reason);
  if (err) throw new RuleError(err);
  const pausedFrom = to === "paused" ? e.stage : null;
  const [row] = await q<EventRow>(
    `UPDATE events SET stage = $2, paused_from = $3, decline_reason = coalesce($4, decline_reason), updated_at = now(), stage_changed_at = now()
     WHERE id = $1 RETURNING ${EVENT_COLS}`,
    [id, to, pausedFrom, to === "declined" ? opts.reason!.trim() : null],
  );
  await logActivity(q, id, actor, "stage", opts.detail ?? `${e.stage} to ${to}`);
  return row;
}

export const moveEvent = (db: Db, id: string, to: Stage, actor: string, opts: { reason?: string; detail?: string } = {}) =>
  db.tx((q) => moveWithin(q, id, to, actor, opts));

/** Ends a top-up at any stage, in a transaction the caller holds: a marker, because stages like researching cannot reach declined and moveError stays as it is.
    Its queued work is cancelled and its waiting card is closed. What was already spent stays on its ledger. The parent is not touched. */
export async function endTopUpWithin(q: Db["query"], id: string, actor: string, reason: string) {
  const [t] = await q<{ parent_event_id: string | null; ended_at: string | null; merged_at: string | null }>("SELECT parent_event_id, ended_at, merged_at FROM events WHERE id = $1 FOR UPDATE", [id]);
  if (!t) throw new RuleError("That event does not exist.");
  if (!t.parent_event_id) throw new RuleError("That is not a list of new registrations.");
  if (t.merged_at) throw new TopUpClosed("These new registrations are already on the outreach list.");
  if (t.ended_at) return { already: true };
  await q("UPDATE events SET ended_at = now(), ended_reason = $2, updated_at = now() WHERE id = $1", [id, reason]);
  await q("UPDATE jobs SET status = 'cancelled', lease_until = NULL WHERE event_id = $1 AND status IN ('queued', 'running')", [id]);
  await q("UPDATE approvals SET status = 'declined', decided_by = $2, decided_at = now(), reason = $3 WHERE event_id = $1 AND status = 'pending'", [id, actor, reason]);
  await q("UPDATE cost_cards SET status = 'declined' WHERE event_id = $1 AND status = 'pending'", [id]);
  await logActivity(q, id, actor, "ended", reason);
  return { already: false };
}
