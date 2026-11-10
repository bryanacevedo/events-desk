/* The post-event wave (docs/LIFECYCLE.md §5b). The day after an event's last day, its channel gets a card: who goes into the follow-up, in groups by what
   happened at the event, after every check. One press starts it. Nothing starts on its own: deciding to follow up, and with what, is a person's call. */

import type { Db } from "./db.ts";
import { runGate } from "./gate.ts";
import { nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { LAST_DAY_SQL } from "./motion.ts";
import { queueEvent } from "./operating.ts";
import { postEventCard, postEventReminderCard } from "./slack-cards.ts";
import { addBusinessDays, addDays, localDay, type Channel } from "../shared/motion.ts";

type Q = Db["query"];

/** After the event, what happened there decides the follow-up, more than the tier did. In this order: a person is in the first that fits. */
export const POST_GROUPS = ["met", "hot", "replied", "scanned", "reached", "not_reached"] as const;
export type PostGroup = (typeof POST_GROUPS)[number];
/** The groups that get a sequence. The others belong to a rep. */
export const SEQUENCED_GROUPS: PostGroup[] = ["scanned", "reached", "not_reached"];
export const GROUP_WORDS: Record<PostGroup, string> = {
  met: "met a rep or had a meeting", hot: "hot scans, already with a rep", replied: "replied before the event",
  scanned: "scanned at the booth", reached: "reached before, no reply", not_reached: "not reached before",
};

/** The press works until this many days after the last day. Later, the moment has passed. */
export const POST_START_LATEST_DAYS = 10;
/** Post-event sequences end this many days after the last day, so one started on the last allowed day still finishes its steps. */
export const POST_WAVE_END_DAYS = 24;
/** A post-event template's last step comes no later than this many days after its first. */
export const POST_TEMPLATE_MAX_DAYS = 10;

export type EventWindow = "before" | "during" | "after" | "closed";

/** Where an event stands, by its own local day. */
export function eventWindow(today: string, firstDay: string, lastDay: string): EventWindow {
  if (today < firstDay) return "before";
  if (today <= lastDay) return "during";
  return today <= addDays(lastDay, POST_START_LATEST_DAYS) ? "after" : "closed";
}

export async function eventDays(q: Q, eventId: string) {
  const [e] = await q<{ first_day: string; last_day: string; country: string | null }>(`SELECT e.starts_on::text AS first_day, ${LAST_DAY_SQL}::text AS last_day, e.country FROM events e WHERE e.id = $1`, [eventId]);
  return e;
}

/** Each person on the event, in the group that fits first. Walk-ups scanned at the booth are in it too, though they were never on the list. */
export async function postGroups(q: Q, eventId: string): Promise<Map<string, PostGroup>> {
  const rows = await q<{ id: string; met: boolean; hot: boolean; replied: boolean; scanned: boolean; reached: boolean }>(
    `SELECT k.id,
       EXISTS (SELECT 1 FROM meetings m WHERE m.contact_id = k.id AND (m.event_id = $1 OR m.source = 'onsite'))
         OR EXISTS (SELECT 1 FROM onsite_captures c WHERE c.contact_id = k.id AND c.event_id = $1 AND c.source = 'quick_add') AS met,
       EXISTS (SELECT 1 FROM onsite_captures c WHERE c.contact_id = k.id AND c.event_id = $1 AND c.temperature = 'hot') AS hot,
       EXISTS (SELECT 1 FROM inbound_messages i WHERE i.contact_id = k.id AND i.event_id = $1 AND i.signal = 'reply' AND (i.code IS NULL OR i.code NOT IN ('out_of_office', 'bounced'))) AS replied,
       k.followup_tier = 'scanned' AS scanned,
       EXISTS (SELECT 1 FROM touches t WHERE t.contact_id = k.id AND t.event_id = $1 AND t.kind = 'send') AS reached
     FROM contacts k WHERE k.event_id = $1 AND k.dropped_at IS NULL AND (k.priority IS NOT NULL OR k.followup_tier = 'scanned')`, [eventId]);
  const out = new Map<string, PostGroup>();
  for (const r of rows) out.set(r.id, r.met ? "met" : r.hot ? "hot" : r.replied ? "replied" : r.scanned ? "scanned" : r.reached ? "reached" : "not_reached");
  return out;
}

export interface WaveCounts { channel: Channel; group: PostGroup; people: number; passing: number }

/** What the card shows: per channel and group, everyone, and who would pass every check right now. The checks run for real, so the numbers are the ones a press will see. */
export async function waveCounts(db: Db, deps: LifecycleDeps, eventId: string): Promise<{ counts: WaveCounts[]; held: Record<string, number>; ready: number }> {
  const [e] = await db.query<{ tools: Partial<Record<Channel, string>> }>("SELECT tools FROM events WHERE id = $1", [eventId]);
  const groups = await postGroups(db.query, eventId);
  const people = await db.query<{ id: string; email: string | null; linkedin: string | null }>("SELECT id, email, linkedin FROM contacts WHERE id = ANY($1::text[])", [[...groups.keys()]]);
  const counts: WaveCounts[] = [], held: Record<string, number> = {}, ready = new Set<string>();
  for (const channel of (Object.keys(e?.tools ?? {}) as Channel[]).filter((c) => e.tools[c])) {
    for (const group of POST_GROUPS) {
      const ids = people.filter((p) => groups.get(p.id) === group && (channel === "email" ? p.email : p.linkedin)).map((p) => p.id);
      if (!ids.length) continue;
      if (!SEQUENCED_GROUPS.includes(group)) { counts.push({ channel, group, people: ids.length, passing: 0 }); continue; }
      const results = await runGate(db, deps, eventId, ids, channel, "add");
      for (const r of results) if (!r.passed) held[r.reason!] = (held[r.reason!] ?? 0) + 1;
      for (const r of results) if (r.passed) ready.add(r.contact_id);
      counts.push({ channel, group, people: ids.length, passing: results.filter((r) => r.passed).length });
    }
  }
  // A person reached on both channels is one person.
  return { counts, held, ready: ready.size };
}

/** Runs on the tick. The day after the last day: the card. One business day later with no press: one reminder. */
export async function postEventStep(db: Db, deps: LifecycleDeps) {
  const now = nowOf(deps);
  const events = await db.query<{ id: string; name: string; country: string | null; first_day: string; last_day: string; post_card_at: string | null; post_reminded_at: string | null; uploader: string | null }>(
    `SELECT e.id, e.name, e.country, e.starts_on::text AS first_day, ${LAST_DAY_SQL}::text AS last_day, e.post_card_at::text AS post_card_at, e.post_reminded_at::text AS post_reminded_at,
       (SELECT u.uploaded_by FROM uploads u WHERE u.event_id = e.id ORDER BY u.created_at DESC LIMIT 1) AS uploader
     FROM events e WHERE e.motion IN ('sequencing', 'in_market') AND e.post_started_at IS NULL`);
  let posted = 0;
  for (const e of events) {
    if (eventWindow(localDay(now, e.country), e.first_day, e.last_day) !== "after") continue;
    const mention = [e.uploader ? deps.userMap?.[e.uploader] : null];
    if (!e.post_card_at) {
      const { counts, held, ready } = await waveCounts(db, deps, e.id);
      const lastPress = addDays(e.last_day, POST_START_LATEST_DAYS);
      await db.tx(async (q) => {
        const claimed = await q("UPDATE events SET post_card_at = $2 WHERE id = $1 AND post_card_at IS NULL RETURNING id", [e.id, now.toISOString()]);
        if (claimed.length) await queueEvent(q, e.id, postEventCard({ event: e.name, event_id: e.id, counts, held, ready, last_press: lastPress }), mention);
      });
      posted++;
    } else if (!e.post_reminded_at && now >= addBusinessDays(new Date(e.post_card_at), 1, deps.holidays ?? [])) {
      await db.tx(async (q) => {
        const claimed = await q("UPDATE events SET post_reminded_at = $2 WHERE id = $1 AND post_reminded_at IS NULL RETURNING id", [e.id, now.toISOString()]);
        if (claimed.length) await queueEvent(q, e.id, postEventReminderCard({ event: e.name, event_id: e.id, last_press: addDays(e.last_day, POST_START_LATEST_DAYS) }), mention);
      });
    }
  }
  return { posted };
}

/** For the Outreach screen: where the event stands and the size of each group. The checks run at the press and on the card, not on every page load. */
export async function postEventState(db: Db, deps: LifecycleDeps, eventId: string) {
  const [e] = await db.query<{ country: string | null; post_started_at: string | null; post_started_by: string | null; post_card_at: string | null }>(
    "SELECT country, post_started_at::text AS post_started_at, post_started_by, post_card_at::text AS post_card_at FROM events WHERE id = $1", [eventId]);
  if (!e) return null;
  const days = await eventDays(db.query, eventId);
  const window = eventWindow(localDay(nowOf(deps), e.country), days.first_day, days.last_day);
  const groups: Partial<Record<PostGroup, number>> = {};
  if (window === "after" || e.post_started_at) for (const g of (await postGroups(db.query, eventId)).values()) groups[g] = (groups[g] ?? 0) + 1;
  return { window, first_day: days.first_day, last_day: days.last_day, last_press: addDays(days.last_day, POST_START_LATEST_DAYS), started_at: e.post_started_at, started_by: e.post_started_by, card_at: e.post_card_at, groups };
}
