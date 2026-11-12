/* Read-only numbers for the Overview. It answers three questions across every event: where is each one, what needs someone, and is it working.
   The rail and the v1 risks come from routes that already exist; this adds what happens after a list is delivered. */

import type { Db } from "./db.ts";
import { computeScorecard, COST_CATEGORIES } from "./closeout.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { postEventState } from "./post-event.ts";

export interface DeliveredLately {
  id: string; name: string; venue: string; starts_on: string; delivered_at: string; sheet_url: string | null;
  a: number; b: number; c: number; website: string | null;
}

/** Something after delivery that needs a person, on one event. */
export interface OutreachNeed { kind: "replies" | "follow_up" | "paused" | "meetings" | "costs"; event_id: string; name: string; website: string | null; n: number; overdue: number; detail: string }
/** An event with outreach going: how far it has got. */
export interface LiveRow { id: string; name: string; website: string | null; starts_on: string; motion: string; sheet_url: string | null; last_day: string; post_started_at: string | null; kept: number; sent: number; replied: number; held: number }
/** An event's result so far: what it cost against the pipeline it made or moved. */
export interface ResultRow { id: string; name: string; website: string | null; motion: string; final: boolean; cost_cents: number; pipeline_cents: number; held: number; per_dollar: number | null; scored: boolean; costs_missing: number }

const WEBSITE = "(SELECT k.website FROM catalog_events k WHERE k.id = e.catalog_id) AS website";

export async function overview(db: Db, deps?: LifecycleDeps): Promise<{ delivered: DeliveredLately[]; needs: OutreachNeed[]; live: LiveRow[]; results: ResultRow[] }> {
  const delivered = await db.query<DeliveredLately>(
    `SELECT e.id, e.name, e.venue, e.starts_on::text AS starts_on, e.stage_changed_at AS delivered_at, e.sheet_url, ${WEBSITE},
            (SELECT count(*)::int FROM contacts c WHERE c.event_id = e.id AND c.dropped_at IS NULL AND c.priority = 'A') AS a,
            (SELECT count(*)::int FROM contacts c WHERE c.event_id = e.id AND c.dropped_at IS NULL AND c.priority = 'B') AS b,
            (SELECT count(*)::int FROM contacts c WHERE c.event_id = e.id AND c.dropped_at IS NULL AND c.priority = 'C') AS c
     FROM events e WHERE e.stage = 'delivered' AND e.parent_event_id IS NULL ORDER BY e.stage_changed_at DESC, e.starts_on DESC LIMIT 8`);
  if (!deps) return { delivered, needs: [], live: [], results: [] };
  const now = (deps.now?.() ?? new Date()).toISOString();

  const counts = await db.query<{ id: string; name: string; website: string | null; motion: string; replies: number; overdue: number; paused: number; pause_reason: string | null; meetings: number }>(
    `SELECT e.id, e.name, e.motion, ${WEBSITE},
       (SELECT count(*)::int FROM inbound_messages m WHERE m.event_id = e.id AND m.respond_by IS NOT NULL AND m.handled_at IS NULL) AS replies,
       (SELECT count(*)::int FROM inbound_messages m WHERE m.event_id = e.id AND m.respond_by < $1::timestamptz AND m.handled_at IS NULL) AS overdue,
       (SELECT count(*)::int FROM sequences s WHERE s.event_id = e.id AND s.state = 'paused') AS paused,
       (SELECT s.pause_reason FROM sequences s WHERE s.event_id = e.id AND s.state = 'paused' ORDER BY s.created_at LIMIT 1) AS pause_reason,
       (SELECT count(*)::int FROM meetings m WHERE m.event_id = e.id AND m.status IN ('booked', 'rescheduled') AND m.outcome_at IS NULL AND m.scheduled_at < $1::timestamptz) AS meetings
     FROM events e WHERE e.stage = 'delivered' AND e.parent_event_id IS NULL AND e.motion <> 'none'`, [now]);
  const needs: OutreachNeed[] = [];
  for (const e of counts) {
    const base = { event_id: e.id, name: e.name, website: e.website };
    if (e.replies) needs.push({ ...base, kind: "replies", n: e.replies, overdue: e.overdue, detail: e.overdue ? `${e.overdue} past their time` : "" });
    if (["sequencing", "in_market"].includes(e.motion)) {
      const pe = await postEventState(db, deps, e.id);
      if (pe?.window === "after" && !pe.started_at) needs.push({ ...base, kind: "follow_up", n: 1, overdue: 0, detail: pe.last_press ? `until ${pe.last_press}` : "" });
    }
    if (e.paused) needs.push({ ...base, kind: "paused", n: e.paused, overdue: 0, detail: e.pause_reason ?? "" });
    if (e.meetings) needs.push({ ...base, kind: "meetings", n: e.meetings, overdue: 0, detail: "" });
  }

  // Once an event closes, what it cost has to be whole before its return means anything: each category entered, or marked as none.
  for (const e of await db.query<{ id: string; name: string; website: string | null; n: number }>(
    `SELECT e.id, e.name, ${WEBSITE}, (SELECT count(*)::int FROM unnest($1::text[]) k WHERE NOT EXISTS (SELECT 1 FROM event_costs c WHERE c.event_id = e.id AND c.category = k)) AS n
     FROM events e WHERE e.stage = 'delivered' AND e.parent_event_id IS NULL AND e.motion IN ('closing', 'scored') ORDER BY e.starts_on DESC`, [COST_CATEGORIES])) {
    if (e.n) needs.push({ event_id: e.id, name: e.name, website: e.website, kind: "costs", n: e.n, overdue: 0, detail: "" });
  }

  const live = await db.query<LiveRow>(
    `SELECT e.id, e.name, e.motion, e.sheet_url, e.starts_on::text AS starts_on, ${WEBSITE}, e.post_started_at::text AS post_started_at,
       coalesce((SELECT c.ends_on FROM catalog_events c WHERE c.id = e.catalog_id), e.ends_on, e.starts_on)::text AS last_day, f.kept, f.sent, f.replied, f.held_all AS held
     FROM events e JOIN event_funnel f ON f.event_id = e.id
     WHERE e.stage = 'delivered' AND e.parent_event_id IS NULL ORDER BY (e.motion IN ('none', 'scored')), e.stage_changed_at DESC LIMIT 6`);

  // A final scorecard when there is one; otherwise the event's result so far, read without writing anything.
  const scored = await db.query<{ id: string; name: string; website: string | null; motion: string; metrics: { held_all: number; cost: { dollars_cents: number }; influence: { sourced: { cents: number }; influenced: { cents: number } }; roi: { pipeline_per_dollar: number | null }; score: unknown } | null }>(
    `SELECT e.id, e.name, e.motion, ${WEBSITE},
       (SELECT s.metrics FROM scorecards s WHERE s.event_id = e.id ORDER BY s.window_days DESC LIMIT 1) AS metrics
     FROM events e WHERE e.stage = 'delivered' AND e.parent_event_id IS NULL AND e.motion IN ('closing', 'scored') ORDER BY e.starts_on DESC LIMIT 4`);
  const results: ResultRow[] = [];
  for (const e of scored) {
    const m = e.metrics ?? await computeScorecard(db, deps, e.id, 30, { write: false }).catch(() => null);
    if (!m) continue;
    results.push({ id: e.id, name: e.name, website: e.website, motion: e.motion, final: e.motion === "scored", cost_cents: m.cost.dollars_cents, pipeline_cents: m.influence.sourced.cents + m.influence.influenced.cents, held: m.held_all, per_dollar: m.roi.pipeline_per_dollar, scored: Boolean(m.score), costs_missing: ((m.roi as { cost_missing?: string[] }).cost_missing ?? []).length });
  }
  return { delivered, needs, live, results };
}
