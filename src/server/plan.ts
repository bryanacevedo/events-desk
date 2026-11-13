/* The event as a plan (docs/EVENT-PLAN.md). A plan is an event's reason, goal, involvements, budget lines and who goes. The list engine, the gate,
   the money rules and the motion run inside it, unchanged. A planner writes the plan; an approver who did not write it approves the planned total,
   and that approval covers the passes inside it. moveWithin stays the only writer of events.stage. */

import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { defaultSettings, getSettings } from "./approvals.ts";
import { EVENT_COLS, logActivity, moveWithin, newId, RuleError } from "./events.ts";
import { recount } from "./seats.ts";
import { computeScorecard } from "./closeout.ts";
import { DESK, type LifecycleDeps } from "./lifecycle-deps.ts";
import { LAST_DAY_SQL } from "./motion.ts";
import { dollars, eventBudget, plannedTotal } from "./budget-lines.ts";
import { canPlan, forRep } from "./money.ts";
import { DEFAULT_FLOW, type EventRow, type Flow } from "../shared/domain.ts";
import {
  HOSTED_FORMATS, INVOLVEMENT_KINDS, INVOLVEMENT_WORDS, PERSON_ROLES, PREPARE_DAYS_BEFORE, planStageLabel, planStageOf, planWaitingOn,
  type InvolvementKind, type PersonRole, type PlanStage,
} from "../shared/plan.ts";
import { stageLabel } from "../shared/domain.ts";

/** What the plan reads as "today": the deps clock when the desk has one (a test clock and the demo clock move it), else the wall clock. */
export const todayOf = (deps?: Pick<LifecycleDeps, "now">) => (deps?.now?.() ?? new Date()).toISOString().slice(0, 10);
export const AUTO_APPROVER = "Under the approval amount";
const same = (userMap?: Record<string, string>) => (n: string) => userMap?.[n] ?? n;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const ymdOk = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const MAX_REASON = 1500;

export class PlanInvalid extends Error {}

const prepareDays = () => defaultSettings().plan?.prepare_days_before ?? PREPARE_DAYS_BEFORE;

/* ------------------------------------------------------------------ plan stage */

/** The plan stage as it reads right now, at the desk's clock. Reads use this so a screen is never a tick behind. */
export const stageNow = (e: Parameters<typeof planStageOf>[0], deps?: Pick<LifecycleDeps, "now">) => planStageOf(e, todayOf(deps), prepareDays());

/** Writes the plan stage when it differs from what planStageOf says for `today`, and logs the move once. Top-ups keep the default and are never touched. */
export async function syncPlanStage(q: Db["query"], eventId: string, today: string) {
  const [e] = await q<EventRow>(`SELECT ${EVENT_COLS} FROM events WHERE id = $1`, [eventId]);
  if (!e || e.parent_event_id) return false;
  const next = planStageOf(e, today, prepareDays());
  if (next === e.plan_stage) return false;
  await q("UPDATE events SET plan_stage = $2 WHERE id = $1", [eventId, next]);
  await logActivity(q, eventId, DESK, "plan_stage", `Plan stage: ${String(e.plan_stage).replace("_", " ")} to ${next.replace("_", " ")}`);
  return true;
}

/** The tick's pass: every event that is not a top-up, at the deps clock's day. */
export async function syncAllPlanStages(db: Db, deps: Pick<LifecycleDeps, "now">) {
  const today = todayOf(deps);
  let moved = 0;
  for (const { id } of await db.query<{ id: string }>("SELECT id FROM events WHERE parent_event_id IS NULL ORDER BY id")) if (await db.tx((q) => syncPlanStage(q, id, today))) moved++;
  return moved;
}

/* ------------------------------------------------------------------ making a plan */

export interface PlanInput {
  name?: string; venue?: string; city?: string; country?: string | null; starts_on?: string; ends_on?: string | null; catalog_id?: string | null;
  seat_price_cents?: number; reason?: string;
  /** A hosted event: one hosted involvement, no catalog entry, no passes. */
  hosted?: { format: string; conference_event_id?: string | null; headcount?: number | null; label?: string };
}

async function settingsJson(approvers?: string[]) {
  return JSON.stringify({ ...JSON.parse(readFileSync(new URL("../../config/defaults.json", import.meta.url), "utf8")), ...(approvers ? { approvers } : {}) });
}

/** Makes an event at stage requested in budget mode: a plan waiting to be written and asked for. It inserts no `approvals` row. */
export async function createPlan(db: Db, actor: string, input: PlanInput, opts: { id?: string; approvers?: string[]; flow?: Flow } = {}) {
  return db.tx(async (q) => {
    let name = text(input.name), venue = text(input.venue), country = text(input.country) || null, starts_on = input.starts_on ?? "", ends_on = input.ends_on || null;
    let price = input.seat_price_cents, catalog_id: string | null = null;
    if (input.catalog_id) {
      const [c] = await q<{ id: string; name: string; venue: string; city: string; country: string; starts_on: string; ends_on: string; seat_price_cents: number }>(
        "SELECT id, name, venue, city, country, starts_on::text AS starts_on, ends_on::text AS ends_on, seat_price_cents FROM catalog_events WHERE id = $1", [input.catalog_id]);
      if (!c) throw new PlanInvalid("That event is not on the list. Choose another, or say yours is not listed.");
      // One catalog entry never has two events: the lookup requestSeat uses.
      const [live] = await q("SELECT 1 FROM events WHERE catalog_id = $1 AND stage <> 'declined' AND parent_event_id IS NULL LIMIT 1", [c.id]);
      if (live) throw new RuleError("This event already has a plan.");
      catalog_id = c.id; name ||= c.name; venue ||= c.venue ? `${c.venue}, ${c.city}` : c.city; country ||= c.country || null; starts_on ||= c.starts_on; ends_on ||= c.ends_on; price ??= c.seat_price_cents;
    }
    if (!name) throw new PlanInvalid("Name the event.");
    if (!ymdOk(starts_on)) throw new PlanInvalid("Give the event's first day.");
    if (ends_on && (!ymdOk(ends_on) || ends_on < starts_on)) throw new PlanInvalid("The last day is a date on or after the first.");
    price ??= 0;
    if (!Number.isInteger(price) || price < 0) throw new PlanInvalid("Give the price per pass, zero or more.");
    const reason = text(input.reason);
    if (reason.length > MAX_REASON) throw new PlanInvalid(`Keep the reason under ${MAX_REASON} characters.`);
    if (input.hosted && catalog_id) throw new PlanInvalid("A hosted event is not on the conference list.");
    if (!input.hosted && !catalog_id) {
      // Not listed: the plan makes its catalog entry in the same transaction, so the event is findable like any other.
      catalog_id = newId("cat");
      await q(`INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents, price_is_estimate, source, suggested_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, false, 'listed', $9)`, [catalog_id, name.slice(0, 160), venue, text(input.city), country ?? "", starts_on, ends_on ?? starts_on, price, actor]);
    }
    const id = opts.id ?? newId("evt");
    await q(
      `INSERT INTO events (id, name, venue, starts_on, ends_on, seat_count, seat_price_cents, requested_by, country, flow, catalog_id, plan_stage, approval_mode, reason)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, 'planning', 'budget', $11)`,
      [id, name.slice(0, 160), venue, starts_on, ends_on, price, actor, country, opts.flow ?? DEFAULT_FLOW, catalog_id, reason]);
    await q("INSERT INTO event_settings (event_id, settings) VALUES ($1, $2::jsonb)", [id, await settingsJson(opts.approvers)]);
    await logActivity(q, id, actor, "requested", "Started a plan");
    if (input.hosted) await insertInvolvement(q, actor, id, { kind: "hosted", hosted_format: input.hosted.format, conference_event_id: input.hosted.conference_event_id ?? null, headcount: input.hosted.headcount ?? null, label: input.hosted.label });
    return { id };
  });
}

interface PlanEvent {
  id: string; name: string; stage: string; requested_by: string; approval_mode: string; parent_event_id: string | null; reason: string; plan_submitted_at: string | null;
  plan_approved_by: string | null; plan_approved_at: string | null; approved_budget_cents: number | null; seat_price_cents: number; catalog_id: string | null; judged_at: string | null;
  goal_meetings_held: number | null; goal_accounts_met: number | null; goal_pipeline_cents: number | null; plan_stage: PlanStage;
}
const PLAN_COLS = `id, name, stage, requested_by, approval_mode, parent_event_id, reason, plan_submitted_at::text AS plan_submitted_at, plan_approved_by, plan_approved_at::text AS plan_approved_at,
  approved_budget_cents::float8 AS approved_budget_cents, seat_price_cents, catalog_id, judged_at::text AS judged_at, goal_meetings_held, goal_accounts_met, goal_pipeline_cents::float8 AS goal_pipeline_cents, plan_stage`;

async function lockPlan(q: Db["query"], eventId: string): Promise<PlanEvent> {
  const [e] = await q<PlanEvent>(`SELECT ${PLAN_COLS} FROM events WHERE id = $1 FOR UPDATE`, [eventId]);
  if (!e) throw new RuleError("That event does not exist.");
  if (e.parent_event_id) throw new RuleError("New registrations have no plan of their own.");
  return e;
}
const openPlan = (e: PlanEvent) => { if (e.stage === "declined") throw new RuleError("This event was declined, so its plan is closed."); };

/** Reason, goal, dates and the pass price. Goal numbers are counts, and pipeline in cents; null clears one. */
export async function updatePlan(db: Db, actor: string, eventId: string, patch: Record<string, unknown>) {
  return db.tx(async (q) => {
    const e = await lockPlan(q, eventId);
    openPlan(e);
    const sets: string[] = [], vals: unknown[] = [eventId];
    const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.reason !== undefined) { const r = text(patch.reason); if (r.length > MAX_REASON) throw new PlanInvalid(`Keep the reason under ${MAX_REASON} characters.`); put("reason", r); }
    for (const k of ["goal_meetings_held", "goal_accounts_met", "goal_pipeline_cents"] as const) if (patch[k] !== undefined) {
      const v = patch[k];
      if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 0)) throw new PlanInvalid("A goal is a whole number, zero or more.");
      put(k, v);
    }
    if (patch.seat_price_cents !== undefined) { const v = patch.seat_price_cents; if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new PlanInvalid("Give the price per pass, zero or more."); put("seat_price_cents", v); }
    if (patch.starts_on !== undefined || patch.ends_on !== undefined) {
      const [d] = await q<{ starts_on: string; ends_on: string | null }>("SELECT starts_on::text AS starts_on, ends_on::text AS ends_on FROM events WHERE id = $1", [eventId]);
      const starts = patch.starts_on === undefined ? d.starts_on : patch.starts_on, ends = patch.ends_on === undefined ? d.ends_on : patch.ends_on || null;
      if (!ymdOk(starts)) throw new PlanInvalid("Give the event's first day.");
      if (ends && (!ymdOk(ends) || ends < starts)) throw new PlanInvalid("The last day is a date on or after the first.");
      put("starts_on", starts); put("ends_on", ends);
    }
    if (!sets.length) throw new PlanInvalid("Say what to change.");
    await q(`UPDATE events SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
    await logActivity(q, eventId, actor, "plan", "Changed the plan");
    return { id: eventId };
  });
}

/* ------------------------------------------------------------------ involvements */

export interface InvolvementInput { kind: string; label?: string; pass_count?: number | null; hosted_format?: string | null; headcount?: number | null; talk_title?: string | null; speaker?: string | null; conference_event_id?: string | null; status?: string }

async function insertInvolvement(q: Db["query"], actor: string, eventId: string, b: InvolvementInput) {
  const kind = b.kind as InvolvementKind;
  if (!(INVOLVEMENT_KINDS as readonly string[]).includes(kind)) throw new PlanInvalid(`An involvement is one of: ${INVOLVEMENT_KINDS.join(", ")}.`);
  const live = await q<{ kind: string }>("SELECT kind FROM involvements WHERE event_id = $1 AND status <> 'dropped'", [eventId]);
  if (kind === "hosted") {
    if (live.some((i) => i.kind === "hosted")) throw new RuleError("This event is already a hosted event.");
    if (live.length) throw new RuleError("A hosted event takes no passes, sponsorship or talk.");
    if (!(HOSTED_FORMATS as readonly string[]).includes(b.hosted_format ?? "")) throw new PlanInvalid(`A hosted event is one of: ${HOSTED_FORMATS.join(", ")}.`);
  } else if (live.some((i) => i.kind === "hosted")) throw new RuleError("A hosted event takes no passes, sponsorship or talk.");
  let conference: string | null = null;
  if (kind === "hosted" && b.conference_event_id) {
    if (b.conference_event_id === eventId) throw new PlanInvalid("An event cannot hang off itself.");
    const [c] = await q("SELECT 1 FROM events WHERE id = $1 AND parent_event_id IS NULL", [b.conference_event_id]);
    if (!c) throw new PlanInvalid("That conference does not exist.");
    conference = b.conference_event_id;
  }
  const count = (v: unknown, what: string) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new PlanInvalid(`Give ${what} as a whole number, zero or more.`);
    return v;
  };
  const id = newId("inv");
  await q(
    `INSERT INTO involvements (id, event_id, kind, label, conference_event_id, pass_count, hosted_format, headcount, talk_title, speaker, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, eventId, kind, text(b.label).slice(0, 120), conference, kind === "passes" ? count(b.pass_count, "the number of passes") : null, kind === "hosted" ? b.hosted_format : null,
      kind === "hosted" ? count(b.headcount, "the expected guests") : null, kind === "talk" ? text(b.talk_title).slice(0, 200) : null, kind === "talk" ? text(b.speaker).slice(0, 80) : null, actor]);
  await logActivity(q, eventId, actor, "plan", `Added ${INVOLVEMENT_WORDS[kind].toLowerCase()}${text(b.label) ? `: ${text(b.label)}` : ""}`);
  return id;
}

export async function addInvolvement(db: Db, actor: string, eventId: string, b: InvolvementInput) {
  return db.tx(async (q) => {
    const e = await lockPlan(q, eventId);
    openPlan(e);
    return { id: await insertInvolvement(q, actor, eventId, b) };
  });
}

export async function updateInvolvement(db: Db, actor: string, eventId: string, iid: string, patch: Partial<InvolvementInput>) {
  return db.tx(async (q) => {
    const e = await lockPlan(q, eventId);
    openPlan(e);
    const [i] = await q<{ kind: string; status: string }>("SELECT kind, status FROM involvements WHERE id = $1 AND event_id = $2 FOR UPDATE", [iid, eventId]);
    if (!i) throw new RuleError("That involvement is not on this event.");
    if (i.status === "dropped") throw new RuleError("That involvement was dropped.");
    const sets: string[] = [], vals: unknown[] = [iid];
    const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    const num = (v: unknown, what: string) => { if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 0)) throw new PlanInvalid(`Give ${what} as a whole number, zero or more.`); return v; };
    if (patch.label !== undefined) put("label", text(patch.label).slice(0, 120));
    if (patch.status !== undefined) { if (!["planned", "confirmed"].includes(patch.status)) throw new PlanInvalid("An involvement is planned or confirmed. Dropping it needs a reason."); put("status", patch.status); }
    if (patch.pass_count !== undefined && i.kind === "passes") put("pass_count", num(patch.pass_count, "the number of passes"));
    if (patch.headcount !== undefined && i.kind === "hosted") put("headcount", num(patch.headcount, "the expected guests"));
    if (i.kind === "talk") { if (patch.talk_title !== undefined) put("talk_title", text(patch.talk_title).slice(0, 200)); if (patch.speaker !== undefined) put("speaker", text(patch.speaker).slice(0, 80)); }
    if (patch.conference_event_id !== undefined && i.kind === "hosted") {
      if (patch.conference_event_id) {
        if (patch.conference_event_id === eventId) throw new PlanInvalid("An event cannot hang off itself.");
        const [c] = await q("SELECT 1 FROM events WHERE id = $1 AND parent_event_id IS NULL", [patch.conference_event_id]);
        if (!c) throw new PlanInvalid("That conference does not exist.");
      }
      put("conference_event_id", patch.conference_event_id || null);
    }
    if (!sets.length) throw new PlanInvalid("Say what to change.");
    await q(`UPDATE involvements SET ${sets.join(", ")} WHERE id = $1`, vals);
    await logActivity(q, eventId, actor, "plan", `Changed ${INVOLVEMENT_WORDS[i.kind as InvolvementKind].toLowerCase()}`);
    return { id: iid };
  });
}

/** Dropping an involvement needs a reason, and the database checks it as well. */
export async function dropInvolvement(db: Db, actor: string, eventId: string, iid: string, reason: string) {
  if (!text(reason)) throw new RuleError("Say why before dropping it.");
  return db.tx(async (q) => {
    const e = await lockPlan(q, eventId);
    openPlan(e);
    const [i] = await q<{ kind: string; status: string }>("SELECT kind, status FROM involvements WHERE id = $1 AND event_id = $2 FOR UPDATE", [iid, eventId]);
    if (!i) throw new RuleError("That involvement is not on this event.");
    if (i.status === "dropped") return { id: iid, already: true };
    await q("UPDATE involvements SET status = 'dropped', dropped_reason = $2 WHERE id = $1", [iid, text(reason)]);
    await logActivity(q, eventId, actor, "plan", `Dropped ${INVOLVEMENT_WORDS[i.kind as InvolvementKind].toLowerCase()}: ${text(reason)}`);
    return { id: iid, already: false };
  });
}

/* ------------------------------------------------------------------ who goes */

/** Does one more pass fit? People with an approved seat, plus this one, times the pass price, is at most the planned passes; and the planned total is at most the approved budget. The one function every add and every approval uses. */
export async function passFits(q: Db["query"], eventId: string) {
  const [e] = await q<{ price: number; budget: number | null }>("SELECT seat_price_cents AS price, approved_budget_cents::float8 AS budget FROM events WHERE id = $1", [eventId]);
  if (!e || e.budget === null) return false;
  const [{ approved }] = await q<{ approved: number }>("SELECT count(*)::int AS approved FROM seat_requests WHERE event_id = $1 AND status = 'approved'", [eventId]);
  const [{ passes }] = await q<{ passes: number }>("SELECT coalesce(sum(planned_cents), 0)::float8 AS passes FROM budget_lines WHERE event_id = $1 AND category = 'passes'", [eventId]);
  return (approved + 1) * Number(e.price) <= Number(passes) && (await plannedTotal(q, eventId)) <= Number(e.budget);
}

export interface PersonInput { person?: string; team?: string; role_title?: string; roles?: unknown; needs_pass?: boolean; involvement_id?: string | null }

function parseRoles(v: unknown): PersonRole[] {
  const roles = v === undefined ? ["attend"] : v;
  if (!Array.isArray(roles) || !roles.length || roles.some((r) => !(PERSON_ROLES as readonly string[]).includes(r as string))) throw new PlanInvalid(`A person attends, hosts or speaks: ${PERSON_ROLES.join(", ")}.`);
  return [...new Set(roles as PersonRole[])];
}

/** Makes the one pass for a person, filled from the plan and the person. It is approved when the plan is approved, the pass fits and the person is not the one who approved; otherwise it waits. */
async function makeSeat(q: Db["query"], actor: string, e: PlanEvent, p: { person: string; team: string; role_title: string }, userMap?: Record<string, string>) {
  const [dup] = await q("SELECT 1 FROM seat_requests WHERE event_id = $1 AND requester = $2 AND status IN ('pending', 'approved')", [e.id, p.person]);
  if (dup) throw new RuleError("That person already has a seat on this event. One seat each.");
  const approve = Boolean(e.plan_approved_at) && (await passFits(q, e.id)) && same(userMap)(p.person) !== same(userMap)(e.plan_approved_by ?? "");
  const id = newId("sr");
  await q(
    `INSERT INTO seat_requests (id, event_id, catalog_id, requester, team, role, goal, why_event, why_you, expected_meetings, status, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'new_pipeline', $7, '', 0, $8, $9, ${approve ? "now()" : "NULL"})`,
    [id, e.id, e.catalog_id, p.person, p.team, p.role_title, e.reason, approve ? "approved" : "pending", approve ? e.plan_approved_by : null]);
  await recount(q, e.id);
  return { id, status: approve ? "approved" : "pending" };
}

/** A planner adds a person to a budget-mode event. A person who needs a pass gets one seat request, whatever their roles. */
export async function addPerson(db: Db, actor: string, eventId: string, b: PersonInput, opts: { userMap?: Record<string, string> } = {}) {
  const person = text(b.person).slice(0, 80);
  if (!person) throw new PlanInvalid("Say who is going.");
  const roles = parseRoles(b.roles);
  return db.tx(async (q) => {
    const e = await lockPlan(q, eventId);
    openPlan(e);
    if (e.approval_mode !== "budget") throw new RuleError("This event approves seats one by one. Ask for a seat through Seats.");
    const [dup] = await q("SELECT 1 FROM event_people WHERE event_id = $1 AND person = $2 AND removed_at IS NULL", [eventId, person]);
    if (dup) throw new RuleError("That person is already on this event.");
    const team = text(b.team).slice(0, 60), role_title = text(b.role_title).slice(0, 60);
    if (b.involvement_id) { const [i] = await q("SELECT 1 FROM involvements WHERE id = $1 AND event_id = $2", [b.involvement_id, eventId]); if (!i) throw new RuleError("That involvement is not on this event."); }
    const pid = newId("ppl");
    let seat: { id: string; status: string } | null = null;
    if (b.needs_pass) {
      const [h] = await q("SELECT 1 FROM involvements WHERE event_id = $1 AND kind = 'hosted' AND status <> 'dropped'", [eventId]);
      if (h) throw new RuleError("A hosted event takes no passes.");
      if (!team || !role_title) throw new PlanInvalid("Say the person's team and job to ask for a pass.");
      if (!roles.includes("attend") && roles.length === 1) throw new PlanInvalid("A pass is for someone who attends.");
    }
    await q("INSERT INTO event_people (id, event_id, person, roles, team, involvement_id, role_title, added_by) VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8)", [pid, eventId, person, roles, team, b.involvement_id ?? null, role_title, actor]);
    if (b.needs_pass) {
      seat = await makeSeat(q, actor, e, { person, team, role_title }, opts.userMap);
      await q("UPDATE event_people SET seat_request_id = $2 WHERE id = $1", [pid, seat.id]);
    }
    await logActivity(q, eventId, actor, "people", `Added ${person} (${roles.join(", ")})${seat ? `, pass ${seat.status === "approved" ? "approved" : "waiting"}` : ""}`);
    return { id: pid, seat_request_id: seat?.id ?? null, seat_status: seat?.status ?? null };
  });
}

/** A rep asks to go through the door they use today (requestSeat). On a budget-mode event that writes a person on the plan and a waiting seat in one transaction, and posts no seat card. */
export async function askToGo(q: Db["query"], actor: string, ev: { id: string; stage: string }, b: { team: string; role: string; travel_cents?: number | null }) {
  const [e] = await q<{ reason: string; catalog_id: string | null }>("SELECT reason, catalog_id FROM events WHERE id = $1", [ev.id]);
  const [dup] = await q("SELECT 1 FROM seat_requests WHERE event_id = $1 AND requester = $2 AND status IN ('pending', 'approved')", [ev.id, actor]);
  if (dup) throw new RuleError("You already have a seat request for this event. One seat each.");
  const sid = newId("sr");
  await q(
    `INSERT INTO seat_requests (id, event_id, catalog_id, requester, team, role, goal, why_event, why_you, expected_meetings, travel_cents) VALUES ($1, $2, $3, $4, $5, $6, 'new_pipeline', $7, '', 0, $8)`,
    [sid, ev.id, e.catalog_id, actor, b.team, b.role, e.reason, b.travel_cents ?? null]);
  const [mine] = await q<{ id: string }>("SELECT id FROM event_people WHERE event_id = $1 AND person = $2 AND removed_at IS NULL FOR UPDATE", [ev.id, actor]);
  let pid = mine?.id;
  if (pid) await q("UPDATE event_people SET seat_request_id = $2, roles = (SELECT array_agg(DISTINCT r) FROM unnest(roles || ARRAY['attend']) r), team = CASE WHEN team = '' THEN $3 ELSE team END, role_title = CASE WHEN role_title = '' THEN $4 ELSE role_title END WHERE id = $1", [pid, sid, b.team, b.role]);
  else {
    pid = newId("ppl");
    await q("INSERT INTO event_people (id, event_id, person, roles, team, role_title, seat_request_id, added_by) VALUES ($1, $2, $3, ARRAY['attend']::text[], $4, $5, $6, $3)", [pid, ev.id, actor, b.team, b.role, sid]);
  }
  await recount(q, ev.id);
  await logActivity(q, ev.id, actor, "requested", "Asked to go");
  return { id: sid, event_id: ev.id, stage: ev.stage, budget_mode: true as const, person_id: pid };
}

/** The rep's own door: ask to go, on a budget-mode event, with their team and job. */
export async function askToGoOn(db: Db, actor: string, eventId: string, b: { team?: string; role_title?: string }) {
  const team = text(b.team).slice(0, 60), role = text(b.role_title).slice(0, 60);
  if (!team) throw new PlanInvalid("Say which team you are on.");
  if (!role) throw new PlanInvalid("Say your role.");
  return db.tx(async (q) => {
    const e = await lockPlan(q, eventId);
    openPlan(e);
    if (e.approval_mode !== "budget") throw new RuleError("This event approves seats one by one. Ask for a seat through Seats.");
    const [h] = await q("SELECT 1 FROM involvements WHERE event_id = $1 AND kind = 'hosted' AND status <> 'dropped'", [eventId]);
    if (h) throw new RuleError("A hosted event takes no passes.");
    return askToGo(q, actor, e, { team, role });
  });
}

export async function updatePerson(db: Db, actor: string, eventId: string, pid: string, b: PersonInput, opts: { userMap?: Record<string, string> } = {}) {
  return db.tx(async (q) => {
    const e = await lockPlan(q, eventId);
    openPlan(e);
    const [p] = await q<{ person: string; roles: string[]; team: string; role_title: string; seat_request_id: string | null }>("SELECT person, roles, team, role_title, seat_request_id FROM event_people WHERE id = $1 AND event_id = $2 AND removed_at IS NULL FOR UPDATE", [pid, eventId]);
    if (!p) throw new RuleError("That person is not on this event.");
    const roles = b.roles === undefined ? p.roles : parseRoles(b.roles);
    const team = b.team === undefined ? p.team : text(b.team).slice(0, 60), role_title = b.role_title === undefined ? p.role_title : text(b.role_title).slice(0, 60);
    let seat: { id: string; status: string } | null = null;
    if (b.needs_pass && !p.seat_request_id) {
      const [h] = await q("SELECT 1 FROM involvements WHERE event_id = $1 AND kind = 'hosted' AND status <> 'dropped'", [eventId]);
      if (h) throw new RuleError("A hosted event takes no passes.");
      if (!team || !role_title) throw new PlanInvalid("Say the person's team and job to ask for a pass.");
      seat = await makeSeat(q, actor, e, { person: p.person, team, role_title }, opts.userMap);
    }
    if (b.involvement_id) { const [i] = await q("SELECT 1 FROM involvements WHERE id = $1 AND event_id = $2", [b.involvement_id, eventId]); if (!i) throw new RuleError("That involvement is not on this event."); }
    await q("UPDATE event_people SET roles = $2::text[], team = $3, role_title = $4, seat_request_id = coalesce($5, seat_request_id), involvement_id = coalesce($6, involvement_id) WHERE id = $1", [pid, roles, team, role_title, seat?.id ?? null, b.involvement_id ?? null]);
    await logActivity(q, eventId, actor, "people", `Changed ${p.person} (${roles.join(", ")})`);
    return { id: pid, seat_request_id: seat?.id ?? p.seat_request_id, seat_status: seat?.status ?? null };
  });
}

/** Removing a person needs a reason. Their seat is declined with the same reason in the same transaction. A seat whose ticket is recorded is not declined: the removal is refused. */
export async function removePerson(db: Db, actor: string, eventId: string, pid: string, reason: string) {
  if (!text(reason)) throw new RuleError("Say why before taking someone off.");
  return db.tx(async (q) => {
    const [p] = await q<{ person: string; seat_request_id: string | null }>("SELECT person, seat_request_id FROM event_people WHERE id = $1 AND event_id = $2 AND removed_at IS NULL FOR UPDATE", [pid, eventId]);
    if (!p) throw new RuleError("That person is not on this event.");
    if (p.seat_request_id) {
      const [bought] = await q("SELECT 1 FROM ticket_purchases WHERE seat_request_id = $1", [p.seat_request_id]);
      if (bought) throw new RuleError("A ticket is recorded for this person. Take the ticket off first.");
      await q("UPDATE seat_requests SET status = 'declined', decided_by = $2, decided_at = now(), decline_reason = $3 WHERE id = $1 AND status IN ('pending', 'approved')", [p.seat_request_id, actor, text(reason)]);
      await recount(q, eventId);
    }
    await q("UPDATE event_people SET removed_at = now(), removed_reason = $2 WHERE id = $1", [pid, text(reason)]);
    await logActivity(q, eventId, actor, "people", `Took ${p.person} off: ${text(reason)}`);
    return { id: pid };
  });
}

/* ------------------------------------------------------------------ asking for approval, approving, declining */

const approvalOver = async (q: Db["query"], eventId: string) => Number((await getSettings(q, eventId)).plan?.approval_over_cents ?? 0);

/** Asks for approval. Needs a reason, an involvement, a goal and a budget line. A hosted event has no number goal until step 2 gives it a guest list, so it is not asked for one.
    With an approval amount above zero, a plan at or under it is confirmed by asking. */
export async function submitPlan(db: Db, actor: string, eventId: string, opts: { today?: string } = {}) {
  return db.tx(async (q) => {
    const e = await lockPlan(q, eventId);
    openPlan(e);
    if (e.approval_mode !== "budget") throw new RuleError("This event approves seats one by one.");
    if (e.plan_submitted_at) throw new RuleError("This plan has already been asked for.");
    const invs = await q<{ kind: string }>("SELECT kind FROM involvements WHERE event_id = $1 AND status <> 'dropped'", [eventId]);
    const hosted = invs.some((i) => i.kind === "hosted");
    if (!text(e.reason)) throw new RuleError("Write why the team is going before asking for approval.");
    if (!invs.length) throw new RuleError("Add at least one way the team takes part before asking for approval.");
    if (!hosted && e.goal_meetings_held === null && e.goal_accounts_met === null && e.goal_pipeline_cents === null) throw new RuleError("Set at least one goal before asking for approval.");
    const planned = await plannedTotal(q, eventId);
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM budget_lines WHERE event_id = $1", [eventId]);
    if (!n) throw new RuleError("Add at least one budget line before asking for approval.");
    await q("UPDATE events SET plan_submitted_at = now(), updated_at = now() WHERE id = $1", [eventId]);
    await logActivity(q, eventId, actor, "plan", `Asked for approval of ${dollars(planned)}`);
    const over = await approvalOver(q, eventId);
    if (over > 0 && planned <= over) await approveWithin(q, { eventId, actor: AUTO_APPROVER, auto: true, today: opts.today });
    else await syncPlanStage(q, eventId, opts.today ?? todayOf());
    return { id: eventId, auto_approved: over > 0 && planned <= over };
  });
}

export interface PlanDecision { eventId: string; actor: string; userMap?: Record<string, string>; today?: string; auto?: boolean }

async function approveWithin(q: Db["query"], d: PlanDecision) {
  const e = await lockPlan(q, d.eventId);
  openPlan(e);
  if (e.approval_mode !== "budget") throw new RuleError("This event approves seats one by one.");
  const sm = same(d.userMap);
  if (!d.auto) {
    const s = await getSettings(q, d.eventId);
    if (!s.approvers.includes(d.actor)) throw new RuleError(`${d.actor} is not one of this event's approvers.`);
    if (sm(d.actor) === sm(e.requested_by)) throw new RuleError("Nobody can approve their own plan.");
  }
  if (!e.plan_submitted_at) throw new RuleError("The planner has not asked for approval yet.");
  const planned = await plannedTotal(q, d.eventId);
  const first = !e.plan_approved_at;
  const over = !first && planned > Number(e.approved_budget_cents ?? 0);
  const budget = first || over ? planned : Number(e.approved_budget_cents ?? 0);
  // The waiting seats, oldest first, while they fit. The approver's own seat is skipped: it waits for a different approver.
  const [{ approved }] = await q<{ approved: number }>("SELECT count(*)::int AS approved FROM seat_requests WHERE event_id = $1 AND status = 'approved'", [d.eventId]);
  const [{ passes }] = await q<{ passes: number }>("SELECT coalesce(sum(planned_cents), 0)::float8 AS passes FROM budget_lines WHERE event_id = $1 AND category = 'passes'", [d.eventId]);
  const waiting = await q<{ id: string; requester: string }>("SELECT id, requester FROM seat_requests WHERE event_id = $1 AND status = 'pending' ORDER BY created_at, id", [d.eventId]);
  const take: { id: string; requester: string }[] = [], own: string[] = [];
  let count = approved;
  for (const w of waiting) {
    if (sm(w.requester) === sm(d.actor)) { own.push(w.requester); continue; }
    if ((count + 1) * Number(e.seat_price_cents) <= Number(passes) && planned <= budget) { take.push(w); count++; }
  }
  if (!first && !over && !take.length) return { changed: false, first: false, approved_seats: [] as string[], own_waiting: own, planned_cents: planned };
  await q("UPDATE events SET plan_approved_by = $2, plan_approved_at = now(), approved_budget_cents = $3, updated_at = now() WHERE id = $1", [d.eventId, d.actor, planned]);
  for (const w of take) await q("UPDATE seat_requests SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1", [w.id, d.actor]);
  await recount(q, d.eventId);
  await logActivity(q, d.eventId, d.actor, "approval", first ? `Approved the plan at ${dollars(planned)}` : `Approved the plan again at ${dollars(planned)}`);
  for (const w of take) await logActivity(q, d.eventId, d.actor, "approval", `Approved ${w.requester}'s seat`);
  if (first && e.stage === "requested") await moveWithin(q, d.eventId, "approved", d.actor, { detail: `Approved the plan at ${dollars(planned)}` });
  await syncPlanStage(q, d.eventId, d.today ?? todayOf());
  return { changed: true, first, approved_seats: take.map((t) => t.requester), own_waiting: own, planned_cents: planned };
}

/** Approves the plan, or approves it again once it has gone over its approved amount. The approver is in `settings.approvers` and did not write it. */
export const approvePlan = (db: Db, d: PlanDecision) => db.tx((q) => approveWithin(q, d));

/** Declines a plan that is not yet approved. The reason is demanded by moveError and checked by the database. */
export async function declinePlan(db: Db, d: PlanDecision & { reason: string }) {
  return db.tx(async (q) => {
    const e = await lockPlan(q, d.eventId);
    if (e.approval_mode !== "budget") throw new RuleError("This event approves seats one by one.");
    const sm = same(d.userMap);
    const s = await getSettings(q, d.eventId);
    if (!s.approvers.includes(d.actor)) throw new RuleError(`${d.actor} is not one of this event's approvers.`);
    if (sm(d.actor) === sm(e.requested_by)) throw new RuleError("Nobody can decide their own plan.");
    if (e.plan_approved_at) throw new RuleError("This plan is already approved.");
    await moveWithin(q, d.eventId, "declined", d.actor, { reason: d.reason, detail: `Declined the plan: ${text(d.reason)}` });
    return { status: "declined" as const, event_id: d.eventId };
  });
}

/** Closes the result of an event past its last day that has no motion (a hosted event before step 2). An event with a motion is judged when it is scored. */
export async function closeResult(db: Db, actor: string, eventId: string, today: string = todayOf()) {
  return db.tx(async (q) => {
    const [e] = await q<{ id: string; motion: string; judged_at: string | null; last_day: string; stage: string; parent_event_id: string | null }>(
      `SELECT e.id, e.motion, e.judged_at::text AS judged_at, e.stage, e.parent_event_id, ${LAST_DAY_SQL}::text AS last_day FROM events e WHERE e.id = $1 FOR UPDATE`, [eventId]);
    if (!e) throw new RuleError("That event does not exist.");
    if (e.parent_event_id) throw new RuleError("New registrations have no result of their own.");
    if (e.judged_at) return { already: true };
    if (e.stage === "declined") throw new RuleError("A declined event has no result to close.");
    if (e.motion !== "none") throw new RuleError("This event's result closes when it is scored.");
    if (today <= e.last_day) throw new RuleError("The result closes after the last day.");
    await q("UPDATE events SET judged_at = now(), judged_by = $2, updated_at = now() WHERE id = $1", [eventId, actor]);
    await logActivity(q, eventId, actor, "plan", "Closed the result");
    await syncPlanStage(q, eventId, today);
    return { already: false };
  });
}

/* ------------------------------------------------------------------ result against the goal */

export interface GoalLine { goal: number; actual: number; short_by: number }
export interface GoalResult { meetings: GoalLine | null; accounts: GoalLine | null; pipeline: { goal_cents: number; actual_cents: number; short_by_cents: number } | null }

/** The result against the goal. Held meetings come from the latest written scorecard, else one read without writing. Target accounts met are tier 1 companies with a held meeting
    (a stand-in until step 7 brings a target account list). Pipeline is sourced plus influenced. Money keys end in `cents`, so forRep strips the pipeline for a rep. */
export async function goalResult(db: Db, deps: LifecycleDeps | undefined, eventId: string): Promise<GoalResult> {
  const [g] = await db.query<{ m: number | null; a: number | null; p: number | null }>("SELECT goal_meetings_held AS m, goal_accounts_met AS a, goal_pipeline_cents::float8 AS p FROM events WHERE id = $1", [eventId]);
  const none: GoalResult = { meetings: null, accounts: null, pipeline: null };
  if (!g || (g.m === null && g.a === null && g.p === null)) return none;
  const [row] = await db.query<{ metrics: { held_all: number; influence: { sourced: { cents: number }; influenced: { cents: number } } } }>("SELECT metrics FROM scorecards WHERE event_id = $1 ORDER BY window_days DESC LIMIT 1", [eventId]);
  const m = row?.metrics ?? (deps ? await computeScorecard(db, deps, eventId, 30, { write: false }).catch(() => null) : null);
  const line = (goal: number, actual: number): GoalLine => ({ goal, actual, short_by: Math.max(0, goal - actual) });
  const out: GoalResult = { ...none };
  if (g.m !== null) out.meetings = line(g.m, m?.held_all ?? 0);
  if (g.a !== null) {
    const [r] = await db.query<{ n: number }>(
      "SELECT count(DISTINCT co.id)::int AS n FROM meetings mt JOIN contacts k ON k.id = mt.contact_id JOIN companies co ON co.id = k.company_id WHERE mt.event_id = $1 AND mt.status = 'held' AND co.tier = 1", [eventId]);
    out.accounts = line(g.a, r.n);
  }
  if (g.p !== null) {
    const actual = m ? Number(m.influence.sourced.cents) + Number(m.influence.influenced.cents) : 0;
    out.pipeline = { goal_cents: Number(g.p), actual_cents: actual, short_by_cents: Math.max(0, Number(g.p) - actual) };
  }
  return out;
}

/** The goal in words: counts, never percentages. The pipeline line carries dollars, so it is for leadership and planners only. */
export function goalWords(r: GoalResult, withMoney: boolean): string[] {
  if (!r.meetings && !r.accounts && !r.pipeline) return ["No goal was set."];
  const out: string[] = [];
  if (r.meetings) out.push(`Held ${r.meetings.actual} of ${r.meetings.goal} meetings`);
  if (r.accounts) out.push(`Met ${r.accounts.actual} of ${r.accounts.goal} target accounts`);
  if (r.pipeline && withMoney) out.push(`${dollars(r.pipeline.actual_cents)} of ${dollars(r.pipeline.goal_cents)} pipeline`);
  return out;
}

/* ------------------------------------------------------------------ the plan read */

/** Everything the Plan tab shows. A rep gets the same read with every key holding dollars taken out, no budget section, and the over-budget words with no figure. */
export async function planView(db: Db, deps: LifecycleDeps | undefined, eventId: string, actor: string) {
  const today = todayOf(deps);
  const [e] = await db.query<EventRow & { reason: string; plan_submitted_at: string | null; plan_approved_by: string | null; approved_budget_cents: number | null; goal_meetings_held: number | null; goal_accounts_met: number | null; goal_pipeline_cents: number | null; requested_by: string }>(
    `SELECT ${EVENT_COLS}, reason, plan_submitted_at::text AS plan_submitted_at, plan_approved_by, approved_budget_cents::float8 AS approved_budget_cents, goal_meetings_held, goal_accounts_met, goal_pipeline_cents::float8 AS goal_pipeline_cents FROM events WHERE id = $1`, [eventId]);
  if (!e) throw new RuleError("That event does not exist.");
  const money = canPlan(actor);
  const involvements = await db.query<{ id: string; kind: string; label: string; status: string; dropped_reason: string | null; conference_event_id: string | null; pass_count: number | null; hosted_format: string | null; headcount: number | null; talk_title: string | null; speaker: string | null }>(
    "SELECT id, kind, label, status, dropped_reason, conference_event_id, pass_count, hosted_format, headcount, talk_title, speaker FROM involvements WHERE event_id = $1 ORDER BY created_at, id", [eventId]);
  const hosted = involvements.some((i) => i.kind === "hosted" && i.status !== "dropped");
  const side = await db.query<{ id: string; name: string; starts_on: string; hosted_format: string; plan_stage: string }>(
    "SELECT ev.id, ev.name, ev.starts_on::text AS starts_on, i.hosted_format, ev.plan_stage FROM involvements i JOIN events ev ON ev.id = i.event_id WHERE i.conference_event_id = $1 AND i.status <> 'dropped' ORDER BY ev.starts_on, ev.name", [eventId]);
  const people = await db.query<{ id: string; person: string; roles: string[]; team: string; involvement_id: string | null; seat_request_id: string | null; seat_status: string | null }>(
    "SELECT id, person, roles, team, involvement_id, seat_request_id, seat_status FROM who_goes WHERE event_id = $1 ORDER BY created_at, id", [eventId]);
  const settings = await getSettings(db.query, eventId);
  const budget = await eventBudget(db, eventId);
  const plan_stage = planStageOf(e, today, prepareDays());
  const approvedAmount = e.approved_budget_cents;
  const over_budget = approvedAmount !== null && budget.total_planned_cents > approvedAmount;
  const over_plan = budget.total_planned_cents > 0 && budget.total_actual_cents > budget.total_planned_cents;
  const approvers = settings.approvers.filter((a) => a !== e.requested_by);
  const waitingSeats = people.filter((p) => p.seat_status === "pending");
  const ownWaiting = e.plan_approved_by ? waitingSeats.filter((p) => p.person === e.plan_approved_by).map((p) => p.person) : [];
  const notes: string[] = [];
  if (over_budget) notes.push(money ? `Over the approved budget by ${dollars(budget.total_planned_cents - (approvedAmount as number))}. Waiting on ${approvers.join(" or ")}.` : `Over the approved budget. Waiting on ${approvers.join(" or ")}.`);
  for (const n of ownWaiting) notes.push(`${n}'s own pass waits on another approver.`);
  if (over_plan) notes.push(money ? `Over plan by ${dollars(budget.total_actual_cents - budget.total_planned_cents)}.` : "Over plan.");
  const result = await goalResult(db, deps, eventId);
  const view = {
    event: { id: e.id, name: e.name, venue: e.venue, starts_on: e.starts_on, last_day: e.last_day, country: e.country ?? null, stage: e.stage, decline_reason: e.decline_reason, approval_mode: e.approval_mode ?? "per_seat", hosted },
    stage_line: { plan_stage, plan_stage_label: planStageLabel(plan_stage), list_stage: e.stage, list_stage_label: stageLabel(e.stage), waiting_on: planWaitingOn(e, { hosted, submitted: Boolean(e.plan_submitted_at) }), paused: e.stage === "paused" },
    reason: e.reason || "", reason_words: e.reason ? null : "No reason was written",
    goal: { meetings_held: e.goal_meetings_held, accounts_met: e.goal_accounts_met, pipeline_cents: e.goal_pipeline_cents },
    result: { ...result, words: goalWords(result, money) },
    approval: { submitted_at: e.plan_submitted_at, approved_by: e.plan_approved_by, approved_at: e.plan_approved_at ?? null, approved_budget_cents: approvedAmount, requested_by: e.requested_by, approvers, over_budget, over_plan, waiting_seats: waitingSeats.length },
    involvements, side_events: side, who_goes: people,
    notes,
    judged_at: e.judged_at ?? null,
    ...(money ? { budget } : {}),
  };
  return money ? view : forRep(view);
}
