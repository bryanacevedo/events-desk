/* An event's Slack channel, its room. It opens with the first card that belongs to the event (the cost card, once the list is in).
   When it opens, its topic says which event it is, and everyone with an approved seat is invited, so the team sees every reply, owner
   card and hot lead from the start. Anyone approved later is invited by the background pass. Ninety days after the event's last day
   the room says it is closing and is archived. Slack keeps the history; the event's page keeps everything else. */

import type { Db } from "./db.ts";
import { nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { LAST_DAY_SQL } from "./motion.ts";
import { roomClosingCard } from "./slack-cards.ts";
import { ROOM_ARCHIVE_DAYS } from "../shared/policy.ts";

type Q = Db["query"];
export interface RoomTools { invite?(channel: string, users: string[]): Promise<boolean>; topic?(channel: string, text: string): Promise<boolean> }

const eventLink = (appUrl: string | undefined, eventId: string) => (appUrl ? `${appUrl.replace(/\/+$/, "")}/event/${eventId}` : null);
const day = (ymd: string, year = false) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });

/** One line: the event, its days, its city, and a link to its page when the desk knows its own address. Slack allows 250 characters. */
export async function roomTopic(q: Q, eventId: string, appUrl?: string) {
  const [e] = await q<{ name: string; starts_on: string; last_day: string; venue: string | null }>(`SELECT e.name, e.starts_on::text AS starts_on, (${LAST_DAY_SQL})::text AS last_day, e.venue FROM events e WHERE e.id = $1`, [eventId]);
  if (!e) return "";
  const days = e.last_day && e.last_day !== e.starts_on ? `${day(e.starts_on)} to ${day(e.last_day, true)}` : day(e.starts_on, true);
  const city = e.venue?.split(",").pop()?.trim() || null;
  return [e.name, days, city, eventLink(appUrl, eventId)].filter(Boolean).join("  ·  ").slice(0, 250);
}

/** Approved seats not yet in the room, with a Slack user to invite. Someone with no Slack user waits until they have one. */
async function dueInvites(q: Q, eventId: string, userMap?: Record<string, string>) {
  const rows = await q<{ id: string; requester: string }>("SELECT id, requester FROM seat_requests WHERE event_id = $1 AND status = 'approved' AND channel_invited_at IS NULL ORDER BY id", [eventId]);
  return rows.map((r) => ({ id: r.id, slack: userMap?.[r.requester] })).filter((r): r is { id: string; slack: string } => Boolean(r.slack));
}

async function inviteDue(q: Q, eventId: string, channel: string, tools: RoomTools, userMap?: Record<string, string>) {
  if (!tools.invite) return 0;
  const due = await dueInvites(q, eventId, userMap);
  if (!due.length || !(await tools.invite(channel, [...new Set(due.map((d) => d.slack))]).catch(() => false))) return 0;
  await q("UPDATE seat_requests SET channel_invited_at = now() WHERE id = ANY($1::text[])", [due.map((d) => d.id)]);
  return due.length;
}

/** The first time a room opens: its topic, and everyone already going. A failure here never stops the card that opened it. */
export async function welcomeRoom(q: Q, eventId: string, channel: string, tools: RoomTools, userMap?: Record<string, string>, appUrl?: string) {
  try { if (tools.topic) await tools.topic(channel, await roomTopic(q, eventId, appUrl)); } catch { /* the topic is a courtesy */ }
  try { await inviteDue(q, eventId, channel, tools, userMap); } catch { /* the background pass tries again */ }
}

/** The background pass: invite anyone approved since the room opened, and close rooms whose event ended ninety days ago. */
export async function roomStep(db: Db, deps: LifecycleDeps) {
  const n = deps.notify;
  let invited = 0, archived = 0;
  if (!n) return { invited, archived };
  if (n.invite) {
    const rooms = await db.query<{ id: string; slack_channel: string }>(
      `SELECT DISTINCT e.id, e.slack_channel FROM events e JOIN seat_requests r ON r.event_id = e.id
       WHERE e.slack_channel IS NOT NULL AND e.slack_archived_at IS NULL AND r.status = 'approved' AND r.channel_invited_at IS NULL`);
    for (const r of rooms) invited += await inviteDue(db.query, r.id, r.slack_channel, n, deps.userMap);
  }
  if (n.archive) {
    const now = nowOf(deps), today = now.toISOString().slice(0, 10);
    const due = await db.query<{ id: string; name: string; slack_channel: string }>(
      `SELECT e.id, e.name, e.slack_channel FROM events e WHERE e.slack_channel IS NOT NULL AND e.slack_archived_at IS NULL AND (${LAST_DAY_SQL})::date + ${ROOM_ARCHIVE_DAYS} <= $1::date ORDER BY e.id`, [today]);
    for (const e of due) {
      await n.post({ event_id: e.id, name: e.name, channel: e.slack_channel }, roomClosingCard({ event: e.name, days: ROOM_ARCHIVE_DAYS, url: eventLink(deps.appUrl, e.id) ?? undefined })).catch(() => null);
      if (await n.archive(e.slack_channel).catch(() => false)) { await db.query("UPDATE events SET slack_archived_at = $2 WHERE id = $1", [e.id, now.toISOString()]); archived++; }
    }
  }
  return { invited, archived };
}
