/* A rep's view of the work, across every event: replies waiting on them, meetings with a brief for each, people they met, and the slots they have free. On a phone at the event as much as at a desk. */

import type { Db } from "./db.ts";
import type { Deal } from "./closeout.ts";
import type { Crm, CrmOpportunity } from "./providers.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { bookMeeting, eventZone } from "./meetings.ts";
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
    db.query(`SELECT m.id, m.event_id, e.name AS event, k.id AS contact_id, k.full_name, co.name AS company, m.code, m.body, m.respond_by::text AS respond_by, m.connector, m.thread_url, (SELECT c.website FROM catalog_events c WHERE c.id = e.catalog_id) AS website, (SELECT c.brand_color FROM catalog_events c WHERE c.id = e.catalog_id) AS brand_color
              FROM inbound_messages m JOIN contacts k ON k.id = m.contact_id JOIN companies co ON co.id = k.company_id JOIN events e ON e.id = m.event_id
              WHERE m.owner = $1 AND m.handled_at IS NULL AND m.respond_by IS NOT NULL ORDER BY m.respond_by`, [rep]),
    db.query<{ id: string }>(`SELECT m.id, m.event_id, k.id AS contact_id, e.name AS event, m.status, m.scheduled_at::text AS scheduled_at, m.timezone, k.full_name, co.name AS company, s.location, (SELECT c.website FROM catalog_events c WHERE c.id = e.catalog_id) AS website, (SELECT c.brand_color FROM catalog_events c WHERE c.id = e.catalog_id) AS brand_color
              FROM meetings m JOIN contacts k ON k.id = m.contact_id JOIN companies co ON co.id = k.company_id JOIN events e ON e.id = m.event_id LEFT JOIN meeting_slots s ON s.meeting_id = m.id
              WHERE m.rep = $1 AND m.status IN ('booked', 'rescheduled') AND m.scheduled_at > $2::timestamptz - interval '1 day' ORDER BY m.scheduled_at LIMIT 50`, [rep, now.toISOString()]),
    db.query(`SELECT c.id, c.event_id, c.contact_id, (SELECT e.name FROM events e WHERE e.id = c.event_id) AS event, c.full_name, c.company, c.note, c.temperature, c.captured_at::text AS captured_at FROM onsite_captures c WHERE c.rep = $1 ORDER BY c.captured_at DESC LIMIT 20`, [rep]),
    db.query(`SELECT s.id, s.event_id, e.name AS event, s.starts_at::text AS starts_at, s.location FROM meeting_slots s JOIN events e ON e.id = s.event_id WHERE s.rep = $1 AND s.meeting_id IS NULL AND s.starts_at > $2::timestamptz AND s.starts_at::date <= ${LAST_DAY_SQL} ORDER BY s.starts_at LIMIT 30`, [rep, now.toISOString()]),
  ]);
  const briefs = await Promise.all(meetings.map(async (m) => ({ ...m, brief: await prepBrief(db, m.id) })));
  // Notes the desk asked this rep for after an event, still unwritten.
  const notes = await db.query(`SELECT d.id, d.event_id, e.name AS event, ${BRAND_SQL}, d.prompted_at::text AS prompted_at, (${LAST_DAY_SQL})::text AS last_day,
      (SELECT count(*)::int FROM meetings m WHERE m.event_id = d.event_id AND m.rep = d.author AND m.status = 'held') AS held
    FROM debriefs d JOIN events e ON e.id = d.event_id WHERE d.author = $1 AND d.status = 'waiting' ORDER BY d.prompted_at`, [rep]);
  // Free slots read in the event's own zone, like the meetings beside them.
  const zones = new Map<string, string>();
  for (const id of new Set((slots as { id: string; event_id: string; event: string; starts_at: string; location: string }[]).map((s) => s.event_id))) zones.set(id, await eventZone((sql, args) => db.query(sql, args), id));
  const zoned = (slots as { id: string; event_id: string; event: string; starts_at: string; location: string }[]).map((s) => ({ ...s, timezone: zones.get(s.event_id) ?? "UTC" }));
  return { rep, replies, meetings: briefs, captures, slots: zoned, notes };
}

const BRAND_SQL = `(SELECT c.website FROM catalog_events c WHERE c.id = e.catalog_id) AS website, (SELECT c.brand_color FROM catalog_events c WHERE c.id = e.catalog_id) AS brand_color`;

/** One owed debrief as its own thing: the event, what was asked, and who the rep met there, so the notes start from the people. Its author's, and leadership's and GTM's. */
export async function debriefDetail(db: Db, debriefId: string) {
  const [d] = await db.query<{ event_id: string; author: string }>(`SELECT d.id, d.event_id, d.author, d.status, d.body, d.prompted_at::text AS prompted_at, d.answered_at::text AS answered_at, e.name AS event, ${BRAND_SQL}, (${LAST_DAY_SQL})::text AS last_day
    FROM debriefs d JOIN events e ON e.id = d.event_id WHERE d.id = $1`, [debriefId]);
  if (!d) return null;
  const met = await db.query(`SELECT m.id, k.full_name, co.name AS company, m.scheduled_at::text AS scheduled_at FROM meetings m JOIN contacts k ON k.id = m.contact_id JOIN companies co ON co.id = k.company_id
    WHERE m.event_id = $1 AND m.rep = $2 AND m.status = 'held' ORDER BY m.scheduled_at`, [d.event_id, d.author]);
  const walkups = await db.query(`SELECT c.id, c.full_name, c.company, c.note FROM onsite_captures c WHERE c.event_id = $1 AND c.rep = $2
    AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.external_key = 'onsite:' || c.id AND m.status = 'held') ORDER BY c.captured_at`, [d.event_id, d.author]);
  return { ...d, met, walkups };
}

const BRAND = `(SELECT c.website FROM catalog_events c WHERE c.id = e.catalog_id) AS website, (SELECT c.brand_color FROM catalog_events c WHERE c.id = e.catalog_id) AS brand_color`;

/** Everything the desk did with this person at this event, oldest first: added to a sequence, each send, the reply, the meeting and how it went. */
const pathOf = (db: Db, contactId: string, eventId: string) => db.query<{ kind: string; channel: string | null; at: string }>(
  `SELECT kind, channel, action, at::text AS at FROM touches WHERE contact_id = $1 AND event_id = $2 AND (kind IN ('sequence_add', 'send', 'accepted', 'meeting_booked', 'met_onsite', 'badge_scan') OR kind LIKE 'reply_%' OR kind LIKE 'meeting_%') ORDER BY at, kind LIMIT 40`, [contactId, eventId]);

/** One reply as its own thing: who wrote it and what, where the thread lives, how long is left to answer, who they are, and what has happened since. */
/** The account behind a reply, a meeting or a deal: its fit, size, owner and open deal, and the other people from it on this event,
    each with where they stand (a meeting, a reply, met at the booth, reached, or only on the list). */
export async function accountOf(db: Db, eventId: string, by: { contactId?: string | null; domain?: string | null; companyId?: string | null }, limit = 8) {
  const [co] = await db.query<{ id: string; name: string; tier: number | null; industry: string | null; employees: string | null; owner: string | null; deal: string | null; website: string | null }>(
    `SELECT co.id, co.name, co.tier, co.firmo->>'industry' AS industry, co.firmo->>'employees' AS employees, co.account_owner AS owner,
            nullif(concat_ws(', ', co.deal_name, co.deal_stage), '') AS deal, co.primary_domain AS website
     FROM companies co WHERE co.event_id = $1 AND ${by.companyId ? "co.id = $2" : by.contactId ? "co.id = (SELECT company_id FROM contacts WHERE id = $2)" : "co.primary_domain = $2"} LIMIT 1`, [eventId, by.companyId ?? by.contactId ?? by.domain]);
  if (!co) return null;
  const others = await db.query<{ id: string; full_name: string | null; title: string | null; state: string }>(
    `SELECT k.id, k.full_name, k.title,
            CASE WHEN EXISTS (SELECT 1 FROM meetings m WHERE m.contact_id = k.id AND m.event_id = k.event_id AND m.status IN ('booked', 'rescheduled', 'held')) THEN 'meeting'
                 WHEN EXISTS (SELECT 1 FROM inbound_messages i WHERE i.contact_id = k.id AND i.event_id = k.event_id AND i.signal = 'reply') THEN 'replied'
                 WHEN EXISTS (SELECT 1 FROM onsite_captures c WHERE c.contact_id = k.id AND c.event_id = k.event_id) THEN 'met'
                 WHEN EXISTS (SELECT 1 FROM touches t WHERE t.contact_id = k.id AND t.event_id = k.event_id AND t.kind = 'send') THEN 'reached'
                 ELSE 'listed' END AS state
     FROM contacts k WHERE k.event_id = $1 AND k.company_id = $2 AND k.dropped_at IS NULL AND ($3::text IS NULL OR k.id <> $3)
     ORDER BY k.full_name LIMIT ${Math.max(1, Math.min(200, limit))}`, [eventId, co.id, by.contactId ?? null]);
  return { company_id: co.id, ...co, others };
}

export async function replyDetail(db: Db, replyId: string) {
  const [r] = await db.query<{ id: string; event_id: string; contact_id: string | null; handled_at: string | null }>(
    `SELECT m.id, m.event_id, e.name AS event, ${BRAND}, m.contact_id, k.full_name, k.title, co.name AS company, co.tier, co.tier_fact AS why,
            co.firmo->>'industry' AS industry, co.firmo->>'employees' AS employees, co.account_owner AS owner, nullif(concat_ws(', ', co.deal_name, co.deal_stage), '') AS deal,
            m.code, m.body, m.channel, m.connector, m.thread_url, m.received_at::text AS received_at, m.respond_by::text AS respond_by, m.owner AS rep, m.handled_at::text AS handled_at,
            m.sequence_id, m.step, s.channel AS seq_channel, s.phase AS seq_phase, s.priority AS seq_audience, s.zone_group AS seq_zone
     FROM inbound_messages m JOIN events e ON e.id = m.event_id LEFT JOIN contacts k ON k.id = m.contact_id LEFT JOIN companies co ON co.id = k.company_id LEFT JOIN sequences s ON s.id = m.sequence_id
     WHERE m.id = $1 AND m.signal = 'reply'`, [replyId]);
  if (!r) return null;
  const [meeting] = r.contact_id ? await db.query("SELECT id, status, scheduled_at::text AS scheduled_at, timezone, rep FROM meetings WHERE contact_id = $1 AND event_id = $2 ORDER BY scheduled_at DESC LIMIT 1", [r.contact_id, r.event_id]) : [];
  const path = r.contact_id ? await pathOf(db, r.contact_id, r.event_id) : [];
  return { ...r, meeting: meeting ?? null, path, timezone: await eventZone((sql, args) => db.query(sql, args), r.event_id), account: await accountOf(db, r.event_id, { contactId: (r as { contact_id?: string | null }).contact_id }) };
}

/** One meeting as its own thing: when and with whom, the prep, the reply that led to it, and how it went. */
export async function meetingDetail(db: Db, meetingId: string) {
  const [m] = await db.query<{ id: string; event_id: string; contact_id: string | null }>(
    `SELECT m.id, m.event_id, e.name AS event, ${BRAND}, m.contact_id, k.full_name, co.name AS company, m.status, m.scheduled_at::text AS scheduled_at, m.timezone, m.source, m.rep, s.location
     FROM meetings m JOIN events e ON e.id = m.event_id LEFT JOIN contacts k ON k.id = m.contact_id LEFT JOIN companies co ON co.id = k.company_id LEFT JOIN meeting_slots s ON s.meeting_id = m.id
     WHERE m.id = $1`, [meetingId]);
  if (!m) return null;
  const [reply] = m.contact_id ? await db.query("SELECT id, body, code, received_at::text AS received_at FROM inbound_messages WHERE contact_id = $1 AND event_id = $2 AND signal = 'reply' ORDER BY received_at DESC LIMIT 1", [m.contact_id, m.event_id]) : [];
  const path = m.contact_id ? await pathOf(db, m.contact_id, m.event_id) : [];
  return { ...m, brief: await prepBrief(db, m.id), reply: reply ?? null, path, deals: (await eventDeals(db, m.event_id)).filter((d) => d.meeting_id === m.id), account: await accountOf(db, m.event_id, { contactId: m.contact_id }) };
}

/** The deals credited to an event, from its latest written scorecard. Money: the route keeps them to leadership and GTM. */
export async function eventDeals(db: Db, eventId: string) {
  const [s] = await db.query<{ deals: Deal[] | null }>("SELECT metrics->'influence'->'deals' AS deals FROM scorecards WHERE event_id = $1 ORDER BY window_days DESC LIMIT 1", [eventId]);
  return s?.deals ?? [];
}

/** One credited deal as its own thing: what it is, where it stands, the meeting it is credited to, and where it lives in the CRM. */
export async function dealDetail(db: Db, eventId: string, opportunityId: string, live?: Deal[], crm?: Crm | null) {
  const deal = (live ?? await eventDeals(db, eventId)).find((d) => d.opportunity_id === opportunityId);
  if (!deal) return null;
  // The CRM is the source of truth: when it is connected, the sheet shows the deal as it stands now, not as it was scored.
  let now: CrmOpportunity | undefined;
  if (crm?.opportunities && deal.domain) { try { now = (await crm.opportunities([{ ref: deal.domain, domain: deal.domain, name: deal.account }]))[deal.domain]?.find((o) => o.id === opportunityId); } catch { now = undefined; } }
  const crmNow = now ? { stage: now.stage, amount_cents: now.amount_cents ?? deal.amount_cents, won: Boolean(now.is_won), url: now.url ?? deal.url ?? null, owner: now.owner ?? null, next_step: now.next_step ?? null, close_date: now.close_date ?? null, created_date: now.created_date, stage_history: now.stage_history, live: true } : { live: false };
  const [e] = await db.query<{ name: string; website: string | null }>("SELECT e.name, (SELECT c.website FROM catalog_events c WHERE c.id = e.catalog_id) AS website FROM events e WHERE e.id = $1", [eventId]);
  const meeting = deal.meeting_id ? (await meetingDetail(db, deal.meeting_id)) as unknown as { id: string; scheduled_at: string; full_name: string | null; rep: string | null; status: string } | null : null;
  return { ...deal, ...crmNow, event_id: eventId, event: e?.name ?? "", website: e?.website ?? null, meeting: meeting ? { id: meeting.id, scheduled_at: meeting.scheduled_at, timezone: (meeting as { timezone?: string | null }).timezone ?? null, full_name: meeting.full_name, rep: meeting.rep, status: meeting.status } : null,
    account_info: await accountOf(db, eventId, { domain: deal.domain }) };
}

/** Meetings and replies for a set of people on one event: what the sheets list and link to. */
async function touchpoints(db: Db, eventId: string, contactIds: string[]) {
  if (!contactIds.length) return { meetings: [], replies: [] };
  const meetings = await db.query(
    `SELECT m.id, m.contact_id, k.full_name, m.status, m.scheduled_at::text AS scheduled_at, m.timezone, m.rep, m.source FROM meetings m LEFT JOIN contacts k ON k.id = m.contact_id
     WHERE m.event_id = $1 AND m.contact_id = ANY($2) ORDER BY m.scheduled_at DESC`, [eventId, contactIds]);
  const replies = await db.query(
    `SELECT i.id, i.contact_id, k.full_name, i.code, i.body, i.received_at::text AS received_at, i.sequence_id, s.name AS sequence, s.channel, s.phase, s.priority AS audience, i.step
     FROM inbound_messages i LEFT JOIN contacts k ON k.id = i.contact_id LEFT JOIN sequences s ON s.id = i.sequence_id
     WHERE i.contact_id = ANY($2) AND i.signal = 'reply' AND (i.event_id = $1 OR s.event_id = $1) ORDER BY i.received_at DESC LIMIT 50`, [eventId, contactIds]);
  return { meetings, replies };
}

/** One person as their own record: who they are, why they are on the list, every meeting, reply and sequence, what was said at the booth, and their account. */
export async function personDetail(db: Db, contactId: string) {
  const [p] = await db.query<{ id: string; event_id: string; company_id: string | null }>(
    `SELECT k.id, k.event_id, e.name AS event, ${BRAND}, k.full_name, k.title, k.email, k.linkedin, k.priority, k.title_tier, k.source, k.drop_reason, k.employer,
            co.id AS company_id, co.name AS company, co.tier AS company_tier, co.primary_domain AS domain,
            (SELECT pp.last_verified_at::text FROM people pp WHERE pp.id = k.person_id) AS last_verified_at,
            (SELECT count(DISTINCT coalesce(ev.parent_event_id, ev.id))::int FROM contacts x JOIN events ev ON ev.id = x.event_id WHERE x.person_id = k.person_id) AS seen_at,
            coalesce((SELECT array_agg(f.flag ORDER BY f.flag) FROM review_flags f WHERE f.contact_id = k.id), '{}') AS flags
     FROM contacts k JOIN events e ON e.id = k.event_id LEFT JOIN companies co ON co.id = k.company_id WHERE k.id = $1`, [contactId]);
  if (!p) return null;
  const { meetings, replies } = await touchpoints(db, p.event_id, [contactId]);
  const sequences = await db.query(
    `SELECT s.id, s.name, s.channel, s.phase, s.priority, s.zone_group, n.state, n.cause,
            (SELECT count(*)::int FROM touches t WHERE t.contact_id = n.contact_id AND t.sequence_id = s.id AND t.kind = 'send') AS sent,
            (SELECT max(t.step) FROM touches t WHERE t.contact_id = n.contact_id AND t.sequence_id = s.id AND t.kind = 'send') AS last_step,
            EXISTS (SELECT 1 FROM touches t WHERE t.contact_id = n.contact_id AND t.sequence_id = s.id AND t.kind = 'accepted') AS accepted
     FROM enrollments n JOIN sequences s ON s.id = n.sequence_id WHERE n.contact_id = $1 ORDER BY s.phase DESC, s.channel`, [contactId]);
  const met = await db.query("SELECT id, rep, note, temperature, captured_at::text AS captured_at FROM onsite_captures WHERE contact_id = $1 ORDER BY captured_at DESC", [contactId]);
  return { ...p, meetings, replies, sequences, met, path: await pathOf(db, contactId, p.event_id), timezone: await eventZone((sql, args) => db.query(sql, args), p.event_id), account: await accountOf(db, p.event_id, { contactId }) };
}

/** A company's meetings and replies on an event, for its sheet: who at it met us and who wrote back. */
export async function companyTouchpoints(db: Db, eventId: string, companyId: string) {
  const ids = (await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND company_id = $2", [eventId, companyId])).map((r) => r.id);
  return touchpoints(db, eventId, ids);
}
