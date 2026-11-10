/* A rep's view of the work, across every event: replies waiting on them, meetings with a brief for each, people they met, and the slots they have free. On a phone at the event as much as at a desk. */

import type { Db } from "./db.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { bookMeeting } from "./meetings.ts";
import { LAST_DAY_SQL } from "./motion.ts";

const MIN = 60_000;

/** The people with an approved seat at this event: who can take a meeting there. */
export const roster = (db: Db, eventId: string) => db.query<{ rep: string }>("SELECT DISTINCT requester AS rep FROM seat_requests WHERE event_id = $1 AND status = 'approved' ORDER BY requester", [eventId]);

/** Makes a rep's bookable slots for one day at the event. Overlapping slots for the same rep are refused. */
export async function addSlots(db: Db, eventId: string, actor: string, s: { rep: string; day: string; from: string; to: string; minutes: number; location: string }) {
  const minutes = Math.round(s.minutes);
  if (!(minutes >= 10 && minutes <= 120)) throw new RuleError("A slot is between 10 and 120 minutes.");
  const start = Date.parse(`${s.day}T${s.from}:00Z`), end = Date.parse(`${s.day}T${s.to}:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw new RuleError("Give a day and a start before the end.");
  if (!(await roster(db, eventId)).some((r) => r.rep === s.rep)) throw new RuleError(`${s.rep} has no approved seat at this event.`);
  return db.tx(async (q) => {
    let made = 0;
    for (let t = start; t + minutes * MIN <= end; t += minutes * MIN) {
      const [clash] = await q("SELECT 1 FROM meeting_slots WHERE rep = $1 AND starts_at < $3::timestamptz AND ends_at > $2::timestamptz", [s.rep, new Date(t).toISOString(), new Date(t + minutes * MIN).toISOString()]);
      if (clash) continue;
      await q("INSERT INTO meeting_slots (id, event_id, rep, starts_at, ends_at, location) VALUES ($1, $2, $3, $4, $5, $6)", [newId("slot"), eventId, s.rep, new Date(t).toISOString(), new Date(t + minutes * MIN).toISOString(), s.location.trim().slice(0, 120) || "Booth"]);
      made++;
    }
    await logActivity(q, eventId, actor, "slots", `Opened ${made} meeting slots for ${s.rep}`);
    return { made };
  });
}

/** Books a person into a free slot. Two people can never hold one slot. */
export async function bookSlot(db: Db, deps: LifecycleDeps, slotId: string, contactId: string, actor: string) {
  const [slot] = await db.query<{ id: string; rep: string; starts_at: string; meeting_id: string | null; event_id: string }>("SELECT id, rep, starts_at::text AS starts_at, meeting_id, event_id FROM meeting_slots WHERE id = $1", [slotId]);
  if (!slot) throw new RuleError("That slot does not exist.");
  if (slot.meeting_id) throw new RuleError("That slot is already taken.");
  const m = await bookMeeting(db, deps, { contact_id: contactId, scheduled_at: new Date(slot.starts_at).toISOString(), source: "manual", rep: slot.rep, external_key: `slot:${slot.id}` }, actor);
  const rows = await db.query("UPDATE meeting_slots SET meeting_id = $2 WHERE id = $1 AND meeting_id IS NULL RETURNING id", [slot.id, m.id]);
  if (!rows.length) throw new RuleError("That slot was just taken.");
  return { meeting_id: m.id, rep: slot.rep, starts_at: slot.starts_at };
}

export interface Brief { person: string; title: string | null; company: string; tier: number | null; why: string | null; industry: string | null; employees: string | null; owner: string | null; deal: string | null; said: string | null; met_note: string | null }

/** What to know before the meeting, from facts the desk already delivered. Nothing new is looked up or invented. */
export async function prepBrief(db: Db, meetingId: string): Promise<Brief | null> {
  const [b] = await db.query<Brief>(
    `SELECT coalesce(k.full_name, 'Someone') AS person, k.title, co.name AS company, co.tier, co.tier_fact AS why, co.firmo->>'industry' AS industry, co.firmo->>'employees' AS employees,
            co.account_owner AS owner, nullif(concat_ws(', ', co.deal_name, co.deal_stage), '') AS deal,
            (SELECT i.body FROM inbound_messages i WHERE i.contact_id = k.id AND i.signal = 'reply' ORDER BY i.received_at DESC LIMIT 1) AS said,
            (SELECT c.note FROM onsite_captures c WHERE c.contact_id = k.id ORDER BY c.captured_at DESC LIMIT 1) AS met_note
     FROM meetings m JOIN contacts k ON k.id = m.contact_id JOIN companies co ON co.id = k.company_id WHERE m.id = $1`, [meetingId]);
  return b ?? null;
}

/** One rep's day, across events. */
export async function repDay(db: Db, deps: LifecycleDeps, rep: string) {
  const now = nowOf(deps);
  const [replies, meetings, captures, slots] = await Promise.all([
    db.query(`SELECT m.id, m.event_id, e.name AS event, k.id AS contact_id, k.full_name, co.name AS company, m.code, m.body, m.respond_by::text AS respond_by, (SELECT c.website FROM catalog_events c WHERE c.id = e.catalog_id) AS website, (SELECT c.brand_color FROM catalog_events c WHERE c.id = e.catalog_id) AS brand_color
              FROM inbound_messages m JOIN contacts k ON k.id = m.contact_id JOIN companies co ON co.id = k.company_id JOIN events e ON e.id = m.event_id
              WHERE m.owner = $1 AND m.handled_at IS NULL AND m.respond_by IS NOT NULL ORDER BY m.respond_by`, [rep]),
    db.query<{ id: string }>(`SELECT m.id, m.event_id, e.name AS event, m.status, m.scheduled_at::text AS scheduled_at, m.timezone, k.full_name, co.name AS company, s.location, (SELECT c.website FROM catalog_events c WHERE c.id = e.catalog_id) AS website, (SELECT c.brand_color FROM catalog_events c WHERE c.id = e.catalog_id) AS brand_color
              FROM meetings m JOIN contacts k ON k.id = m.contact_id JOIN companies co ON co.id = k.company_id JOIN events e ON e.id = m.event_id LEFT JOIN meeting_slots s ON s.meeting_id = m.id
              WHERE m.rep = $1 AND m.status IN ('booked', 'rescheduled') AND m.scheduled_at > $2::timestamptz - interval '1 day' ORDER BY m.scheduled_at LIMIT 50`, [rep, now.toISOString()]),
    db.query(`SELECT c.id, c.event_id, c.full_name, c.company, c.note, c.temperature, c.captured_at::text AS captured_at FROM onsite_captures c WHERE c.rep = $1 ORDER BY c.captured_at DESC LIMIT 20`, [rep]),
    db.query(`SELECT s.id, s.event_id, e.name AS event, s.starts_at::text AS starts_at, s.location FROM meeting_slots s JOIN events e ON e.id = s.event_id WHERE s.rep = $1 AND s.meeting_id IS NULL AND s.starts_at > $2::timestamptz AND s.starts_at::date <= ${LAST_DAY_SQL} ORDER BY s.starts_at LIMIT 30`, [rep, now.toISOString()]),
  ]);
  const briefs = await Promise.all(meetings.map(async (m) => ({ ...m, brief: await prepBrief(db, m.id) })));
  return { rep, replies, meetings: briefs, captures, slots };
}
