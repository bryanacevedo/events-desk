/* What each sequence did, read from what the tools reported (docs/SEQUENCES-VIEW.md §4). Read only, no money in it, open to reps.
   Counts are defined once here so nothing is counted two ways:
   - reached: distinct people with a send touch in the sequence (a LinkedIn invite is a send);
   - replied: distinct people with a reply in the sequence and a send in it, with the funnel's exclusions;
   - by step: messages sent (a count of sends, not people), and the people whose reply, bounce or unsubscribe carries that step.
   A figure built on a signal the sequence's tool does not report is null, which the screen reads as "not reported". */

import type { Db } from "./db.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import type { EventSignal } from "./connectors/types.ts";
import { LAST_DAY_SQL } from "./motion.ts";

const NOT_REPLIED = ["out_of_office", "bounced", "unsubscribe", "wrong_person", "departed"];
const NOT_REPLIED_SQL = NOT_REPLIED.map((c) => `'${c}'`).join(", ");

export interface SequenceRow {
  id: string; name: string; channel: "email" | "linkedin"; phase: "pre" | "post"; priority: string; zone_group: string | null; connector: string; state: string;
  launched_at: string | null; checklist_by: string | null; external_id: string | null;
  people: number; reached: number | null; replied: number | null; meetings: number; invites: number | null; accepted: number | null;
}

/** What a tool reports, from its connector. An unknown connector reports nothing the desk can count on. */
function reportsOf(deps: LifecycleDeps, connector: string): Set<EventSignal> {
  return new Set(deps.connectors?.[connector]?.capabilities.reports ?? []);
}

/** Every sequence of an event, before and after, with its headline figures. */
export async function sequenceList(db: Db, deps: LifecycleDeps, eventId: string): Promise<SequenceRow[]> {
  const rows = await db.query<Omit<SequenceRow, "reached" | "replied" | "invites" | "accepted"> & { reached: number; replied: number; invites: number; accepted: number }>(
    `SELECT s.id, s.name, s.channel, s.phase, s.priority, s.zone_group, s.connector, s.state, s.launched_at::text AS launched_at, s.checklist_by, s.external_id,
       (SELECT count(*) FROM enrollments n WHERE n.sequence_id = s.id)::int AS people,
       (SELECT count(DISTINCT t.contact_id) FROM touches t WHERE t.sequence_id = s.id AND t.kind = 'send')::int AS reached,
       (SELECT count(DISTINCT m.contact_id) FROM inbound_messages m WHERE m.sequence_id = s.id AND m.signal = 'reply' AND (m.code IS NULL OR m.code NOT IN (${NOT_REPLIED_SQL}))
          AND EXISTS (SELECT 1 FROM touches t WHERE t.contact_id = m.contact_id AND t.sequence_id = s.id AND t.kind = 'send'))::int AS replied,
       (SELECT count(DISTINCT g.contact_id) FROM meetings g WHERE g.event_id = s.event_id AND g.status IN ('booked', 'held', 'no_show', 'rescheduled')
          AND EXISTS (SELECT 1 FROM inbound_messages m WHERE m.contact_id = g.contact_id AND m.sequence_id = s.id AND m.signal = 'reply'))::int AS meetings,
       (SELECT count(DISTINCT t.contact_id) FROM touches t WHERE t.sequence_id = s.id AND t.kind = 'send' AND t.action = 'invite')::int AS invites,
       (SELECT count(DISTINCT t.contact_id) FROM touches t WHERE t.sequence_id = s.id AND t.kind = 'accepted')::int AS accepted
     FROM sequences s WHERE s.event_id = $1 ORDER BY s.phase DESC, s.channel, s.priority, s.zone_group, s.id`, [eventId]);
  return rows.map((r) => {
    const rep = reportsOf(deps, r.connector);
    const sends = rep.has("send") || rep.has("invite");
    return {
      ...r,
      reached: sends ? r.reached : null,
      replied: sends && rep.has("reply") ? r.replied : null,
      invites: r.channel === "linkedin" && rep.has("invite") ? r.invites : null,
      accepted: r.channel === "linkedin" && rep.has("accepted") ? r.accepted : null,
    };
  });
}

/** One sequence in full: who is in it, reach, the steps, what people said, meetings, senders, sends by day. Null when it is not this event's. */
export async function sequenceDetail(db: Db, deps: LifecycleDeps, eventId: string, sequenceId: string) {
  const head = (await sequenceList(db, deps, eventId)).find((s) => s.id === sequenceId);
  if (!head) return null;
  const rep = reportsOf(deps, head.connector);
  const [last] = await db.query<{ name: string; website: string | null; last_day: string; starts_on: string }>(
    `SELECT e.name, (SELECT c.website FROM catalog_events c WHERE c.id = e.catalog_id) AS website, e.starts_on::text AS starts_on, (${LAST_DAY_SQL})::text AS last_day FROM events e WHERE e.id = $1`, [eventId]);
  const who = await db.query<{ state: string; cause: string | null; n: number }>(
    "SELECT state, cause, count(*)::int AS n FROM enrollments WHERE sequence_id = $1 GROUP BY state, cause ORDER BY state, cause", [sequenceId]);
  // Steps: messages sent at each (count of sends), and people whose reply, bounce or unsubscribe carries it. Steps are numbered from 1.
  const sent = await db.query<{ step: number; action: string | null; n: number }>(
    "SELECT step, action, count(*)::int AS n FROM touches WHERE sequence_id = $1 AND kind = 'send' AND step IS NOT NULL GROUP BY step, action ORDER BY step", [sequenceId]);
  // What followed each step, by what it meant: a reply, a bounce, an opt-out (said in words or by the tool). Out of office is none of them.
  const after = await db.query<{ step: number; signal: string; n: number }>(
    `SELECT step, CASE WHEN signal = 'bounce' OR code = 'bounced' THEN 'bounce' WHEN signal = 'unsubscribe' OR code = 'unsubscribe' THEN 'unsubscribe'
                       WHEN code IS NULL OR code NOT IN (${NOT_REPLIED_SQL}) THEN 'reply' ELSE 'other' END AS signal, count(DISTINCT contact_id)::int AS n
     FROM inbound_messages WHERE sequence_id = $1 AND step IS NOT NULL GROUP BY 1, 2`, [sequenceId]);
  const steps = [...new Set([...sent.map((s) => s.step), ...after.map((a) => a.step)])].sort((a, b) => a - b).map((step) => ({
    step,
    sent: sent.filter((s) => s.step === step).reduce((n, s) => n + s.n, 0),
    invites: sent.filter((s) => s.step === step && s.action === "invite").reduce((n, s) => n + s.n, 0),
    replied: after.find((a) => a.step === step && a.signal === "reply")?.n ?? 0,
    bounced: after.find((a) => a.step === step && a.signal === "bounce")?.n ?? 0,
    unsubscribed: after.find((a) => a.step === step && a.signal === "unsubscribe")?.n ?? 0,
  }));
  const [msgs] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM touches WHERE sequence_id = $1 AND kind = 'send'", [sequenceId]);
  const replies = await db.query<{ id: string; code: string | null; body: string | null; received_at: string; full_name: string | null; company: string | null; contact_id: string | null; step: number | null }>(
    `SELECT m.id, m.code, m.body, m.received_at::text AS received_at, k.full_name, co.name AS company, m.contact_id, m.step FROM inbound_messages m
       LEFT JOIN contacts k ON k.id = m.contact_id LEFT JOIN companies co ON co.id = k.company_id
     WHERE m.sequence_id = $1 AND m.signal = 'reply' ORDER BY m.received_at DESC LIMIT 100`, [sequenceId]);
  const senders = await db.query<{ sender: string; name: string | null; sends: number; bounces: number }>(
    `SELECT t.sender, (SELECT x.display_name FROM sequence_senders x WHERE x.sequence_id = $1 AND x.address = t.sender LIMIT 1) AS name,
            count(*) FILTER (WHERE t.kind = 'send')::int AS sends, count(*) FILTER (WHERE t.kind = 'bounce')::int AS bounces
     FROM touches t WHERE t.sequence_id = $1 AND t.sender IS NOT NULL GROUP BY t.sender ORDER BY sends DESC, t.sender`, [sequenceId]);
  const days = await db.query<{ day: string; n: number }>(
    "SELECT (at AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS n FROM touches WHERE sequence_id = $1 AND kind = 'send' GROUP BY 1 ORDER BY 1", [sequenceId]);
  const [unplaced] = await db.query<{ sends: number; replies: number }>(
    `SELECT (SELECT count(*) FROM touches WHERE event_id = $1 AND kind = 'send' AND sequence_id IS NULL AND contact_id IS NOT NULL)::int AS sends,
            (SELECT count(*) FROM inbound_messages WHERE event_id = $1 AND signal = 'reply' AND sequence_id IS NULL AND contact_id IS NOT NULL)::int AS replies`, [eventId]);
  // Everyone put in it, each a link to their record: where they got to and, if they left, why.
  const people = await db.query<{ contact_id: string; full_name: string | null; company: string | null; state: string; cause: string | null; last_step: number | null; sent: number; accepted: boolean }>(
    `SELECT n.contact_id, k.full_name, co.name AS company, n.state, n.cause,
            (SELECT max(t.step) FROM touches t WHERE t.contact_id = n.contact_id AND t.sequence_id = n.sequence_id AND t.kind = 'send') AS last_step,
            (SELECT count(*)::int FROM touches t WHERE t.contact_id = n.contact_id AND t.sequence_id = n.sequence_id AND t.kind = 'send') AS sent,
            EXISTS (SELECT 1 FROM touches t WHERE t.contact_id = n.contact_id AND t.sequence_id = n.sequence_id AND t.kind = 'accepted') AS accepted
     FROM enrollments n JOIN contacts k ON k.id = n.contact_id LEFT JOIN companies co ON co.id = k.company_id WHERE n.sequence_id = $1 ORDER BY k.full_name`, [sequenceId]);
  // The cadence it runs: its template's steps, each with the day it goes and its words. LinkedIn's first step is the connection request.
  const [tpl] = await db.query<{ steps: { day: number; subject?: string | null; body: string }[] }>("SELECT t.steps FROM sequence_templates t JOIN sequences s ON s.template_id = t.id WHERE s.id = $1", [sequenceId]);
  const [msg] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM touches WHERE sequence_id = $1 AND kind = 'send' AND action = 'message'", [sequenceId]);
  const sends = rep.has("send") || rep.has("invite");
  return {
    ...head,
    cadence: (tpl?.steps ?? []).map((x, i) => ({ step: i + 1, day: x.day, subject: x.subject ?? null, body: x.body })),
    linkedin_messages: head.channel === "linkedin" && rep.has("send") ? msg.n : null,
    people_in: people,
    reports: [...rep],
    event: { name: last?.name ?? "", website: last?.website ?? null, starts_on: last?.starts_on ?? null, last_day: last?.last_day ?? null },
    who,
    messages_sent: sends ? msgs.n : null,
    // A tool that gives no step (HeyReach, Smartlead) has no ladder: null, not an empty one.
    steps: sends && steps.length ? steps : null,
    replies,
    senders: sends ? senders.map((s) => ({ ...s, bounces: rep.has("bounce") ? s.bounces : null })) : null,
    days: sends ? days : null,
    unplaced,
  };
}
