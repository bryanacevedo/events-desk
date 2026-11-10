/* Starting outreach and the third card (docs/LIFECYCLE.md, sections 1 and 2), and the clocks that close an event out. */

import type { Db } from "./db.ts";
import { crmConnected } from "./crm-checks.ts";
import { currentUploader, getSettings } from "./approvals.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { DESK, nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { moveMotion } from "./motion-state.ts";
import { DEFAULT_MOTION_RATES, daysBetween, localDay, quoteMotion, type Motion } from "../shared/motion.ts";

export interface StartOptions { purpose?: "outreach" | "debrief_only"; verify_once?: boolean; write_leads?: boolean; holdout_percent?: number }

/** Asks for the Motion card. While it waits, the event stays where it is. */
export async function requestMotionCard(db: Db, deps: LifecycleDeps, eventId: string, actor: string, opts: StartOptions = {}) {
  return db.tx(async (q) => {
    const [e] = await q<{ stage: string; motion: Motion; flow: string; parent_event_id: string | null; requested_by: string }>("SELECT stage, motion, flow, parent_event_id, requested_by FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (!e) throw new RuleError("That event does not exist.");
    if (e.parent_event_id) throw new RuleError("New registrations join the parent event's outreach.");
    if (e.stage !== "delivered") throw new RuleError("Outreach starts after the list is delivered.");
    if (e.motion !== "none") throw new RuleError("Outreach has already started on this event.");
    // An old single-card event never quoted the steps that follow, so it cannot pay for them.
    const [old] = await q("SELECT 1 FROM cost_cards WHERE event_id = $1 AND status = 'approved' AND step_caps IS NULL LIMIT 1", [eventId]);
    if (e.flow !== "two_card" || old) throw new RuleError("This event used the older single cost card, so it cannot start outreach.");
    const up = await currentUploader(q, eventId);
    if (!up) throw new RuleError("This event has no attendee list.");
    if (actor !== up.uploaded_by) throw new RuleError(`Only ${up.uploaded_by}, who uploaded the attendee list, can start outreach.`);
    const [pending] = await q("SELECT 1 FROM approvals WHERE event_id = $1 AND kind = 'motion' AND status = 'pending' LIMIT 1", [eventId]);
    if (pending) throw new RuleError("A Motion card is already waiting to be confirmed.");
    const s = await getSettings(q, eventId);
    const [i] = await q<{ people: number; companies: number }>("SELECT count(*)::int AS people, count(DISTINCT company_id)::int AS companies FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND priority IS NOT NULL", [eventId]);
    const rates = { ...DEFAULT_MOTION_RATES, ...((s as unknown as { motion?: object }).motion ?? {}) };
    const c = quoteMotion(i, rates, s.llm_call_cents);
    const id = newId("card");
    const inputs = { ...i, purpose: opts.purpose ?? "outreach", crm_connected: crmConnected(deps.crm), verify_once: Boolean(opts.verify_once), write_leads: Boolean(opts.write_leads), holdout_percent: Math.min(50, Math.max(0, Math.round(opts.holdout_percent ?? 0))) };
    await q(`INSERT INTO cost_cards (id, event_id, kind, inputs, rates, lines, credits_cap, llm_cap, est_cents, step_caps) VALUES ($1, $2, 'motion', $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb)`,
      [id, eventId, JSON.stringify(inputs), JSON.stringify({ ...rates, llm_call_cents: s.llm_call_cents }), JSON.stringify(c.lines), c.credits_cap, c.llm_cap, c.est_cents, JSON.stringify(c.step_caps)]);
    await q("INSERT INTO approvals (id, event_id, kind, card_id, requested_by, also_requested_by) VALUES ($1, $2, 'motion', $3, $4, $5)", [newId("apr"), eventId, id, e.requested_by, actor]);
    await logActivity(q, eventId, actor, "motion", "Asked for the Motion card");
    return { card_id: id, ...c };
  });
}

/** Called from decideApproval, inside its transaction. */
export async function applyMotionCard(q: Db["query"], cardId: string, eventId: string, actor: string, status: "approved" | "declined", reason?: string) {
  await q("UPDATE cost_cards SET status = $2 WHERE id = $1", [cardId, status]);
  if (status === "declined") { await logActivity(q, eventId, actor, "motion", `Declined the Motion card: ${reason?.trim()}`); return; }
  const [c] = await q<{ inputs: { purpose: string; crm_connected: boolean; verify_once: boolean; write_leads: boolean; holdout_percent: number } }>("SELECT inputs FROM cost_cards WHERE id = $1", [cardId]);
  if (c.inputs.purpose !== "outreach") { await logActivity(q, eventId, actor, "motion", "Confirmed the Motion card for debriefs only"); return; }
  await q("UPDATE events SET outreach_started_by = $2, outreach_started_at = now(), verify_once = $3, write_leads = $4, holdout_percent = $5 WHERE id = $1", [eventId, actor, c.inputs.verify_once, c.inputs.write_leads, c.inputs.holdout_percent]);
  await moveMotion(q, eventId, c.inputs.crm_connected ? "owners" : "sequencing", actor, c.inputs.crm_connected ? "Started outreach: account owners get their say first" : "Started outreach. No CRM is connected, so there are no owners to ask");
}

export const CLOSE_DAYS = 14;
export const SCORE_DAYS = 30;

interface Clock { id: string; motion: Motion; country: string | null; last_day: string; delivered_on: string }
/** Events with a clock running. The last day is the catalog's end date, else the start date. */
export const clocks = (db: Db) => db.query<Clock>(
  `SELECT e.id, e.motion, e.country, coalesce((SELECT c.ends_on FROM catalog_events c WHERE c.id = e.catalog_id), e.starts_on)::text AS last_day, e.stage_changed_at::date::text AS delivered_on
   FROM events e WHERE e.stage = 'delivered' AND e.parent_event_id IS NULL AND e.motion <> 'scored'`);

export const daysPast = (c: Pick<Clock, "last_day" | "country">, now: Date) => daysBetween(c.last_day, localDay(now, c.country));

/** Moves events to closing when their time comes. Scoring moves them from there. */
export async function closeOut(db: Db, deps: LifecycleDeps) {
  const now = nowOf(deps);
  let moved = 0;
  for (const c of await clocks(db)) {
    if (!["none", "owners", "sequencing", "in_market"].includes(c.motion) || daysPast(c, now) < CLOSE_DAYS) continue;
    await db.tx((q) => moveMotion(q, c.id, "closing", DESK, `${CLOSE_DAYS} days after the event`));
    moved++;
  }
  return { moved };
}
