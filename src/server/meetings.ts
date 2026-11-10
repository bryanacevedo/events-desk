/* Meetings (docs/LIFECYCLE.md, section 8). Booking stops everyone at the domain and is kept. Cancelled or no-show releases the hold only after a rep confirms. */

import { AFTER_OUTCOME_HOLD_DAYS, DAY, MEETING_HOLD_DAYS } from "../shared/policy.ts";
import type { Db } from "./db.ts";
import { scheduleResume, stopDomain } from "./enroll-ops.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { canWrite, queueCreate } from "./crm-outbox.ts";
import { drainOps } from "./sequences.ts";
import { postToEvent } from "./operating.ts";
import { nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { meetingReminderCard } from "./slack-cards.ts";
import { addHold, addTouch, creditedEvent, releaseHold } from "./touches.ts";

export const MEETING_STATUSES = ["proposed", "booked", "held", "no_show", "cancelled", "rescheduled"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export interface MeetingInput { contact_id: string; scheduled_at: string; timezone?: string; source: "reply" | "sheet" | "calendar" | "manual"; rep?: string | null; external_key?: string; status?: "proposed" | "booked" }

/** Books a meeting, or moves one already known under this key. The event credited is the one whose sequence sent last. */
export async function bookMeeting(db: Db, deps: LifecycleDeps, m: MeetingInput, actor: string) {
  const now = nowOf(deps);
  if (Number.isNaN(Date.parse(m.scheduled_at))) throw new RuleError("That is not a date and time.");
  const out = await db.tx(async (q) => {
    const [k] = await q<{ id: string; event_id: string; person_id: string | null; domain: string | null; full_name: string | null; company: string }>("SELECT k.id, k.event_id, k.person_id, co.primary_domain AS domain, k.full_name, co.name AS company FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.id = $1", [m.contact_id]);
    if (!k) throw new RuleError("That person is not on a list.");
    if (!k.domain) throw new RuleError("That company has no website on record, so it cannot be held.");
    const eventId = (await creditedEvent(q, { contact_id: k.id, person_id: k.person_id, domain: k.domain })) ?? k.event_id;
    const [en] = await q("SELECT 1 FROM enrollments WHERE contact_id = $1 AND state <> 'adding' LIMIT 1", [k.id]);
    const key = m.external_key ?? `desk:${k.id}:${newId("m")}`;
    const [before] = await q<{ id: string; scheduled_at: string }>("SELECT id, scheduled_at::text AS scheduled_at FROM meetings WHERE external_key = $1 FOR UPDATE", [key]);
    const moved = before && Date.parse(before.scheduled_at) !== Date.parse(m.scheduled_at);
    const id = before?.id ?? newId("mtg");
    if (before) await q("UPDATE meetings SET scheduled_at = $2, timezone = $3, status = CASE WHEN $4 THEN 'rescheduled' ELSE status END, rep = coalesce($5, rep) WHERE id = $1", [id, m.scheduled_at, m.timezone ?? "UTC", moved, m.rep ?? null]);
    else await q("INSERT INTO meetings (id, event_id, contact_id, domain, external_key, status, scheduled_at, timezone, source, rep, enrolled) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)", [id, eventId, k.id, k.domain, key, m.status ?? "booked", m.scheduled_at, m.timezone ?? "UTC", m.source, m.rep ?? null, Boolean(en)]);
    // Everyone at the domain stops, kept and never deleted. Thirty days after the meeting the hold runs out on its own if nobody says what happened.
    await stopDomain(q, k.domain, "pause", "meeting", id);
    await addHold(q, { domain: k.domain, cause: "meeting", cause_id: id, expires_at: new Date(Date.parse(m.scheduled_at) + MEETING_HOLD_DAYS * DAY) });
    await addTouch(q, { domain: k.domain, person_id: k.person_id, contact_id: k.id, event_id: eventId, kind: "meeting_booked", source: actor, dedup_key: `mtg:${id}:${Date.parse(m.scheduled_at)}` });
    // A booked meeting is the answer to their reply: it stops waiting on a rep everywhere (the event, Overview, My day).
    await q("UPDATE inbound_messages SET handled_at = $2, handled_by = $3 WHERE contact_id = $1 AND handled_at IS NULL AND respond_by IS NOT NULL", [k.id, now.toISOString(), actor]);
    await logActivity(q, eventId, actor, "meeting", `${moved ? "Moved" : before ? "Updated" : "Booked"} a meeting with ${k.full_name ?? "someone"} at ${k.company}`);
    return { id, event_id: eventId, status: moved ? "rescheduled" : m.status ?? "booked" };
  });
  await drainOps(db, deps);
  return out;
}

/** The meeting's rep, the person who uploaded the list, or a system source records what happened. Nobody else. */
const SYSTEM_SOURCES = ["Calendar", "CRM", "Events Desk"];
async function mayActOn(q: Db["query"], m: { event_id: string; rep: string | null }, actor: string) {
  if (SYSTEM_SOURCES.includes(actor) || actor === m.rep) return;
  const [up] = await q<{ uploaded_by: string }>("SELECT uploaded_by FROM uploads WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1", [m.event_id]);
  if (actor !== up?.uploaded_by) throw new RuleError(`Only ${m.rep ?? "the meeting's rep"} or the person who uploaded the list can record this.`);
}

/** Held, no-show, cancelled. A real outcome sets when the hold ends. */
export async function recordOutcome(db: Db, deps: LifecycleDeps, meetingId: string, status: "held" | "no_show" | "cancelled", actor: string) {
  const now = nowOf(deps);
  return db.tx(async (q) => {
    const [m] = await q<{ id: string; event_id: string; domain: string; contact_id: string | null; rep: string | null }>("SELECT id, event_id, domain, contact_id, rep FROM meetings WHERE id = $1 FOR UPDATE", [meetingId]);
    if (!m) throw new RuleError("That meeting does not exist.");
    await mayActOn(q, m, actor);
    await q("UPDATE meetings SET status = $2, outcome_at = $3 WHERE id = $1", [m.id, status, now.toISOString()]);
    await q("UPDATE holds SET expires_at = $2 WHERE cause = 'meeting' AND cause_id = $1 AND released_at IS NULL", [m.id, new Date(now.getTime() + AFTER_OUTCOME_HOLD_DAYS * DAY).toISOString()]);
    await addTouch(q, { domain: m.domain, contact_id: m.contact_id, event_id: m.event_id, kind: `meeting_${status}`, source: actor, dedup_key: `mtg_out:${m.id}:${status}:${now.getTime()}` });
    if (status === "held" && m.contact_id && canWrite(deps.crm)) {
      const [p] = await q<{ person_id: string | null; email: string | null; full_name: string | null; company: string; name: string }>("SELECT k.person_id, k.email, k.full_name, co.name AS company, e.name FROM contacts k JOIN companies co ON co.id = k.company_id JOIN events e ON e.id = $2 WHERE k.id = $1", [m.contact_id, m.event_id]);
      if (p?.email) await queueCreate(q, "campaign_member", `cm:${m.event_id}:${m.contact_id}:met`, p.person_id, { email: p.email.toLowerCase(), full_name: p.full_name, company: p.company, domain: m.domain, event_id: m.event_id, campaign: p.name, status: "Met" });
    }
    await logActivity(q, m.event_id, actor, "meeting", `Recorded ${status.replace("_", " ")} on a meeting`);
    return { id: m.id, status };
  });
}

/** After a cancellation or no-show a rep confirms it is over. The hold goes, and the people it paused come back through the gate. */
export async function confirmRelease(db: Db, deps: LifecycleDeps, meetingId: string, actor: string) {
  const now = nowOf(deps);
  return db.tx(async (q) => {
    const [m] = await q<{ id: string; status: string; event_id: string; rep: string | null }>("SELECT id, status, event_id, rep FROM meetings WHERE id = $1 FOR UPDATE", [meetingId]);
    if (!m) throw new RuleError("That meeting does not exist.");
    await mayActOn(q, m, actor);
    if (!["cancelled", "no_show"].includes(m.status)) throw new RuleError("Only a cancelled meeting or a no-show can release its hold.");
    await q("UPDATE meetings SET release_confirmed_by = $2 WHERE id = $1", [m.id, actor]);
    await releaseHold(q, "meeting", m.id, actor);
    await scheduleResume(q, { cause: "meeting", causeId: m.id }, now);
    await logActivity(q, m.event_id, actor, "meeting", "Confirmed the meeting is off, and released the hold");
    return { released: true };
  });
}

/** Three days after a meeting nobody has said anything about, the rep is asked. Once. */
export async function meetingReminders(db: Db, deps: LifecycleDeps) {
  const now = nowOf(deps);
  const due = await db.query<{ id: string; event_id: string; rep: string; person: string | null; company: string; scheduled_at: string }>(
    `SELECT m.id, m.event_id, m.rep, k.full_name AS person, co.name AS company, m.scheduled_at::text AS scheduled_at FROM meetings m JOIN contacts k ON k.id = m.contact_id JOIN companies co ON co.id = k.company_id
     WHERE m.status IN ('booked', 'rescheduled') AND m.outcome_at IS NULL AND m.reminded_at IS NULL AND m.rep IS NOT NULL AND m.scheduled_at < $1::timestamptz - interval '3 days'`, [now.toISOString()]);
  let sent = 0;
  for (const m of due) {
    const slackId = deps.userMap?.[m.rep];
    if (!slackId || !deps.notify) continue;
    const ok = await postToEvent(db, deps, m.event_id, meetingReminderCard({ person: m.person ?? "them", company: m.company, when: new Date(m.scheduled_at).toUTCString().slice(0, 16), meeting_id: m.id }), [slackId]);
    if (ok) { await db.query("UPDATE meetings SET reminded_at = $2 WHERE id = $1", [m.id, now.toISOString()]); sent++; }
  }
  return { sent };
}

/** Meetings logged only in the CRM still set a hold and count. One per person, not one per attendee row. */
export async function ingestCrmMeetings(db: Db, deps: LifecycleDeps) {
  if (!deps.crm?.meetings) return { booked: 0 };
  const since = new Date(nowOf(deps).getTime() - 7 * DAY).toISOString();
  const rows = await deps.crm.meetings(since);
  const seen = new Set<string>();
  const out = { booked: 0 };
  for (const m of rows) {
    const key = `${m.id}:${m.email.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [known] = await db.query<{ scheduled_at: string; status: string }>("SELECT scheduled_at::text AS scheduled_at, status FROM meetings WHERE external_key = $1", [`cal:crm:${key}`]);
    if (known && Date.parse(known.scheduled_at) === Date.parse(m.start) && (m.status !== "cancelled" || known.status === "cancelled") && (m.status !== "held" || known.status === "held")) continue;
    const r = await ingestCalendar(db, deps, [{ id: `crm:${key}`, attendee_email: m.email, start: m.start, timezone: m.timezone ?? "UTC", cancelled: m.status === "cancelled", organizer: m.organizer }]);
    if (m.status === "held" && r.booked) { const [mt] = await db.query<{ id: string }>("SELECT id FROM meetings WHERE external_key = $1", [`cal:crm:${key}`]); if (mt) await recordOutcome(db, deps, mt.id, "held", "CRM"); }
    out.booked += r.booked;
  }
  return out;
}

/** The `Calendar` seam: a booking system says what changed. Keyed by its own id, so a reschedule updates the row. */
export interface CalendarEvent { id: string; attendee_email: string; start: string; timezone: string; cancelled?: boolean; organizer?: string | null }
export async function ingestCalendar(db: Db, deps: LifecycleDeps, events: CalendarEvent[]) {
  const out = { booked: 0, cancelled: 0, unmatched: 0 };
  for (const e of events) {
    const [k] = await db.query<{ id: string }>(`SELECT k.id FROM contacts k JOIN events ev ON ev.id = k.event_id WHERE lower(k.email) = $1 AND k.dropped_at IS NULL ORDER BY ev.created_at DESC LIMIT 1`, [e.attendee_email.toLowerCase()]);
    if (!k) { out.unmatched++; continue; }
    const key = `cal:${e.id}`;
    const [known] = await db.query<{ id: string }>("SELECT id FROM meetings WHERE external_key = $1", [key]);
    if (e.cancelled) { if (known) { await recordOutcome(db, deps, known.id, "cancelled", "Calendar"); out.cancelled++; } continue; }
    await bookMeeting(db, deps, { contact_id: k.id, scheduled_at: e.start, timezone: e.timezone, source: "calendar", rep: e.organizer ?? null, external_key: key }, "Calendar");
    out.booked++;
  }
  return out;
}
