/* Seats. A seat request is one person asking for their own seat at one event. Each request is
   approved or declined on its own. The first request on a catalog entry makes the event row, in
   stage requested. The first approval moves it to approved; each later approval adds one to
   seat_count, which is the number approved. A request that comes after the pipeline has started
   never moves the event. */

import { DEFAULT_FLOW } from "../shared/domain.ts";
import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { defaultSettings, getSettings } from "./approvals.ts";
import { logActivity, moveWithin, newId, RuleError } from "./events.ts";
import { isGtm } from "../shared/roles.ts";

export class Invalid extends Error {}
export class Forbidden extends Error {}

export const GOALS = {
  new_pipeline: "New pipeline", existing_customers: "Existing customers", partners: "Partners",
  speaking_sponsoring: "Speaking or sponsoring", market_learning: "Market learning",
} as const;
export type Goal = keyof typeof GOALS;
export const MIN_WHY = 20;

export interface Suggestion { name: string; website: string; starts_on: string; ends_on: string; city: string; country: string; price_cents: number }
export interface SeatInput {
  catalog_id: string | null; suggestion: Suggestion | null; team: string; role: string; goal: Goal; why_event: string; why_you: string;
  expected_meetings: number; known_accounts: string | null; travel_cents: number | null; decide_by: string | null;
}

const ymdOk = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
export const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** Checks the body of a seat request. Throws Invalid with one sentence a person can act on. */
export function parseSeatRequest(actor: string, b: Record<string, unknown>): SeatInput {
  // One person, one seat, their own. The server takes the requester from who is acting, never from the body.
  if (b.requester !== undefined && b.requester !== actor) throw new Forbidden("A seat request is for your own seat. Ask for yours.");
  for (const k of ["seats", "seat_count"]) if (b[k] !== undefined && b[k] !== 1) throw new Forbidden("A seat request is for one seat, your own.");
  let catalog_id: string | null = null, suggestion: Suggestion | null = null;
  if (b.suggestion !== undefined && b.suggestion !== null) {
    const s = b.suggestion as Record<string, unknown>;
    const price = Number(s.price_dollars);
    if (!text(s.name)) throw new Invalid("Name the event.");
    if (!ymdOk(s.starts_on)) throw new Invalid("Give the event's start date.");
    const ends_on = s.ends_on === undefined || s.ends_on === "" ? (s.starts_on as string) : s.ends_on;
    if (!ymdOk(ends_on) || ends_on < (s.starts_on as string)) throw new Invalid("The end date cannot be before the start date.");
    if (!text(s.city) || !text(s.country)) throw new Invalid("Give the city and country.");
    if (!/^https?:\/\/\S+\.\S+/.test(text(s.website))) throw new Invalid("Give the event's website, starting with https://.");
    if (!Number.isFinite(price) || price < 0) throw new Invalid("Give the ticket price in dollars.");
    suggestion = { name: text(s.name).slice(0, 160), website: text(s.website).slice(0, 300), starts_on: s.starts_on as string, ends_on, city: text(s.city).slice(0, 80), country: text(s.country).slice(0, 80), price_cents: Math.round(price * 100) };
    if (suggestion.starts_on < todayYmd()) throw new Invalid("That event has already started.");
  } else {
    catalog_id = text(b.catalog_id);
    if (!catalog_id) throw new Invalid("Choose an event, or say yours is not listed.");
  }
  const team = text(b.team), role = text(b.role);
  if (!team) throw new Invalid("Say which team you are on.");
  if (!role) throw new Invalid("Say your role.");
  if (typeof b.goal !== "string" || !(b.goal in GOALS)) throw new Invalid("Choose the main goal.");
  const why_event = text(b.why_event), why_you = text(b.why_you);
  if (why_event.length < MIN_WHY) throw new Invalid(`Say why this event, in at least ${MIN_WHY} characters.`);
  if (why_you.length < MIN_WHY) throw new Invalid(`Say why you, in at least ${MIN_WHY} characters.`);
  const meetings = Number(b.expected_meetings);
  if (b.expected_meetings === undefined || b.expected_meetings === "" || !Number.isInteger(meetings) || meetings < 0 || meetings > 500) throw new Invalid("Say how many meetings you expect, as a whole number.");
  const known = text(b.known_accounts) || null;
  if (known && known.length > 600) throw new Invalid("Keep the known accounts under 600 characters.");
  let travel_cents: number | null = null;
  if (b.travel_dollars !== undefined && b.travel_dollars !== null && b.travel_dollars !== "") {
    const t = Number(b.travel_dollars);
    if (!Number.isFinite(t) || t < 0) throw new Invalid("Give the travel estimate in dollars, or leave it blank.");
    travel_cents = Math.round(t * 100);
  }
  let decide_by: string | null = null;
  if (b.decide_by !== undefined && b.decide_by !== null && b.decide_by !== "") {
    if (!ymdOk(b.decide_by)) throw new Invalid("Give the decide-by date as a date, or leave it blank.");
    decide_by = b.decide_by;
  }
  return { catalog_id, suggestion, team: team.slice(0, 60), role: role.slice(0, 60), goal: b.goal as Goal, why_event: why_event.slice(0, 1500), why_you: why_you.slice(0, 1500), expected_meetings: meetings, known_accounts: known, travel_cents, decide_by };
}

/** A catalog entry as GTM Engineering or an approver adds it from the Events tab. Same fields as a suggestion, plus an optional venue. */
export interface CatalogInput extends Suggestion { venue: string; price_is_estimate: boolean }

export function parseCatalogEntry(b: Record<string, unknown>): CatalogInput {
  const price = b.price_dollars === undefined || b.price_dollars === "" ? NaN : Number(b.price_dollars);
  if (!text(b.name)) throw new Invalid("Name the event.");
  if (!ymdOk(b.starts_on)) throw new Invalid("Give the event's start date.");
  const ends_on = b.ends_on === undefined || b.ends_on === "" || b.ends_on === null ? (b.starts_on as string) : b.ends_on;
  if (!ymdOk(ends_on) || ends_on < (b.starts_on as string)) throw new Invalid("The end date cannot be before the start date.");
  if (!text(b.city) || !text(b.country)) throw new Invalid("Give the city and country.");
  if (!/^https?:\/\/\S+\.\S+/.test(text(b.website))) throw new Invalid("Give the event's website, starting with https://.");
  if (!Number.isFinite(price) || price < 0) throw new Invalid("Give the ticket price in dollars.");
  return { name: text(b.name).slice(0, 160), website: text(b.website).slice(0, 300), starts_on: b.starts_on as string, ends_on, city: text(b.city).slice(0, 80), country: text(b.country).slice(0, 80), venue: text(b.venue).slice(0, 160), price_cents: Math.round(price * 100), price_is_estimate: b.price_is_estimate === true };
}

/** Adds a listed event nobody has asked for yet. Only GTM Engineering and the seat approvers may; anyone else suggests one through a seat request. */
export async function addCatalogEntry(db: Db, actor: string, c: CatalogInput) {
  const approvers = (defaultSettings().approvers ?? []) as string[];
  if (!isGtm(actor) && !approvers.includes(actor)) throw new Forbidden("Only GTM Engineering and the seat approvers add events. Suggest one through a seat request.");
  const id = newId("cat");
  await db.query(
    `INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents, price_is_estimate, source, suggested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'listed', $11)`,
    [id, c.name, c.venue, c.city, c.country, c.starts_on, c.ends_on, c.website, c.price_cents, c.price_is_estimate, actor]);
  return { id };
}

interface EventLite { id: string; stage: string; seat_count: number }

/** seat_count follows the requests: the number approved, or while nothing is approved yet, the number waiting. */
async function recount(q: Db["query"], eventId: string) {
  const [c] = await q<{ approved: number; pending: number }>(
    "SELECT count(*) FILTER (WHERE status = 'approved')::int AS approved, count(*) FILTER (WHERE status = 'pending')::int AS pending FROM seat_requests WHERE event_id = $1", [eventId]);
  await q("UPDATE events SET seat_count = $2 WHERE id = $1", [eventId, Math.max(1, c.approved || c.pending)]);
  return c;
}

export async function requestSeat(db: Db, actor: string, input: SeatInput, opts: { approvers?: string[]; flow?: "single_card" | "two_card"; id?: string; today?: string } = {}) {
  return db.tx(async (q) => {
    let cat: { id: string | null; name: string; venue: string; country: string; starts_on: string; ends_on: string; price_cents: number } | null = null;
    if (input.catalog_id) {
      const [c] = await q<{ id: string; name: string; venue: string; city: string; country: string; starts_on: string; ends_on: string; seat_price_cents: number }>(
        "SELECT id, name, venue, city, country, starts_on::text AS starts_on, ends_on::text AS ends_on, seat_price_cents FROM catalog_events WHERE id = $1", [input.catalog_id]);
      if (!c) throw new Invalid("That event is not on the list. Choose another, or say yours is not listed.");
      if (c.ends_on < (opts.today ?? todayYmd())) throw new RuleError("That event is over.");
      cat = { id: c.id, name: c.name, venue: c.venue ? `${c.venue}, ${c.city}` : c.city, country: c.country, starts_on: c.starts_on, ends_on: c.ends_on, price_cents: c.seat_price_cents };
    } else {
      const s = input.suggestion!;
      cat = { id: null, name: s.name, venue: s.city, country: s.country, starts_on: s.starts_on, ends_on: s.ends_on, price_cents: s.price_cents };
    }
    let ev: EventLite | undefined;
    if (cat.id) [ev] = await q<EventLite>("SELECT id, stage, seat_count FROM events WHERE catalog_id = $1 AND stage <> 'declined' ORDER BY created_at DESC LIMIT 1 FOR UPDATE", [cat.id]);
    if (!ev) {
      const id = opts.id ?? newId("evt");
      await q(
        `INSERT INTO events (id, name, venue, starts_on, seat_count, seat_price_cents, requested_by, country, flow, catalog_id) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9)`,
        [id, cat.name, cat.venue, cat.starts_on, cat.price_cents, actor, cat.country || null, opts.flow ?? DEFAULT_FLOW, cat.id]);
      await q("INSERT INTO event_settings (event_id, settings) VALUES ($1, $2::jsonb)", [id, JSON.stringify({ ...JSON.parse(readFileSync(new URL("../../config/defaults.json", import.meta.url), "utf8")), ...(opts.approvers ? { approvers: opts.approvers } : {}) })]);
      [ev] = await q<EventLite>("SELECT id, stage, seat_count FROM events WHERE id = $1", [id]);
    }
    const [dup] = await q("SELECT 1 FROM seat_requests WHERE event_id = $1 AND requester = $2 AND status IN ('pending', 'approved')", [ev.id, actor]);
    if (dup) throw new RuleError("You already have a seat request for this event. One seat each.");
    const id = newId("sr");
    await q(
      `INSERT INTO seat_requests (id, event_id, catalog_id, requester, team, role, goal, why_event, why_you, expected_meetings, known_accounts, travel_cents, decide_by, suggestion)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
      [id, ev.id, cat.id, actor, input.team, input.role, input.goal, input.why_event, input.why_you, input.expected_meetings, input.known_accounts, input.travel_cents, input.decide_by, input.suggestion ? JSON.stringify(input.suggestion) : null]);
    await recount(q, ev.id);
    await logActivity(q, ev.id, actor, "requested", input.suggestion ? "Asked for a seat at a new event" : "Asked for a seat");
    return { id, event_id: ev.id, stage: ev.stage };
  });
}

/** `userMap` is person name to Slack user ID. In live mode the requester is a name and the decider a Slack ID, so both are put on the Slack ID before they are compared. */
export interface SeatDecision { requestId: string; actor: string; decision: "approve" | "decline"; reason?: string; userMap?: Record<string, string> }

export async function decideSeat(db: Db, d: SeatDecision) {
  return db.tx(async (q) => {
    const [r] = await q<{ id: string; event_id: string; requester: string; status: string; decided_by: string | null; catalog_id: string | null; suggestion: { name: string; website: string; starts_on: string; ends_on: string; city: string; country: string; price_cents: number } | null }>(
      "SELECT id, event_id, requester, status, decided_by, catalog_id, suggestion FROM seat_requests WHERE id = $1 FOR UPDATE", [d.requestId]);
    if (!r) throw new RuleError("That seat request does not exist.");
    if (r.status !== "pending") return { status: r.status, decided_by: r.decided_by ?? "", already_decided: true, event_id: r.event_id };
    const settings = await getSettings(q, r.event_id);
    if (!settings.approvers.includes(d.actor)) throw new RuleError(`${d.actor} is not one of this event's approvers.`);
    const same = (n: string) => d.userMap?.[n] ?? n;
    if (d.decision === "approve" && same(d.actor) === same(r.requester)) throw new RuleError("Nobody can approve their own request.");
    if (d.decision === "decline" && !d.reason?.trim()) throw new RuleError("Say why before declining.");
    const status = d.decision === "approve" ? "approved" : "declined";
    await q("UPDATE seat_requests SET status = $2, decided_by = $3, decided_at = now(), decline_reason = $4 WHERE id = $1", [r.id, status, d.actor, d.reason?.trim() || null]);
    const [ev] = await q<{ id: string; stage: string }>("SELECT id, stage FROM events WHERE id = $1 FOR UPDATE", [r.event_id]);
    if (status === "approved" && r.suggestion && !r.catalog_id) {
      // Approving a suggestion adds the event to the catalog.
      const s = r.suggestion, cid = newId("cat");
      await q(`INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents, price_is_estimate, source, suggested_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, 'suggested', $10)`, [cid, s.name, s.city, s.city, s.country, s.starts_on, s.ends_on, s.website, s.price_cents, r.requester]);
      await q("UPDATE seat_requests SET catalog_id = $2 WHERE id = $1", [r.id, cid]);
      await q("UPDATE events SET catalog_id = $2 WHERE id = $1", [ev.id, cid]);
    }
    const c = await recount(q, ev.id);
    if (status === "approved") {
      // Only an event still waiting on its first seat moves. A later seat, or a late one, just counts.
      if (ev.stage === "requested") await moveWithin(q, ev.id, "approved", d.actor, { detail: `Approved ${r.requester}'s seat` });
      else await logActivity(q, ev.id, d.actor, "approval", `Approved ${r.requester}'s seat`);
    } else if (ev.stage === "requested" && c.approved === 0 && c.pending === 0) {
      await moveWithin(q, ev.id, "declined", d.actor, { reason: d.reason, detail: `Declined the seats: ${d.reason!.trim()}` });
    } else await logActivity(q, ev.id, d.actor, "approval", `Declined ${r.requester}'s seat: ${d.reason!.trim()}`);
    return { status, decided_by: d.actor, already_decided: false, event_id: ev.id };
  });
}
