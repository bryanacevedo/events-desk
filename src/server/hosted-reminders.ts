/* Reminders and logistics for a hosted event (docs/HOSTED.md 8 and 21.10, 21.11). The audience is guests whose status is exactly `registered`, with an email the desk may use.
   Everyone else is counted by the reason they were skipped and never mailed. The text is a fixed template; the host's logistics note, at most 600 characters, sits inside the same frame.
   The send goes through the transactional sender after the database commit, one reminder_sends row per guest, so a retry never repeats a send and an unknown outcome is never sent again. */

import type { Db } from "./db.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { integratedWith } from "./integration.ts";
import { deliverOutbox, NO_SENDER, simulatedSender, type TransactionalSender } from "./transactional.ts";
import { firstName, GUEST_COLS, hostedEvent, HostedInvalid, lockHosted, logGuest, longDay, mailBlock, nowOf, readHosted, rsvpLink, text, type GuestRow, type HostedDeps } from "./hosted.ts";

export type ReminderKind = "reminder" | "logistics";
export const MAX_LOGISTICS = 600;
export const MIN_GAP_MINUTES = 10;

export interface Skipped { not_registered: number; no_email: number; country: number; opted_out: number; wrong_person: number }
const noSkips = (): Skipped => ({ not_registered: 0, no_email: 0, country: 0, opted_out: 0, wrong_person: 0 });

export interface ReminderPreview {
  kind: ReminderKind;
  subject: string;
  /** The fixed text with {first_name} and {link} where each guest's own go. */
  body: string;
  /** The same text for the first guest in the audience, or null when there is none. */
  example: string | null;
  audience: { guest_id: string; name: string; email: string }[];
  count: number;
  skipped: Skipped;
  /** False when a send would be refused, with the sentence why. */
  can_send: boolean;
  refusal: string | null;
  last_run: { id: string; kind: ReminderKind; created_at: string; sent_count: number; skipped: Skipped } | null;
  integrated_with: string[];
}

function template(ev: { name: string; starts_on: string }, h: { doors_at: string | null; address: string; host_name: string }, venue: string, kind: ReminderKind, note: string, signer: string) {
  const place = [venue, h.address].filter(Boolean).join(", ");
  const lines = [
    "Hi {first_name}", "",
    kind === "reminder"
      ? `A reminder that ${ev.name} is on ${longDay(ev.starts_on)}${h.doors_at ? `, doors at ${h.doors_at}` : ""}${place ? `, at ${place}` : ""}.`
      : `A note before ${ev.name} on ${longDay(ev.starts_on)}${h.doors_at ? `, doors at ${h.doors_at}` : ""}${place ? `, at ${place}` : ""}.`,
    ...(kind === "logistics" && note ? ["", note] : []),
    "", "If your plans change, tell us on your link: {link}", "", signer || h.host_name || "The team",
  ];
  return { subject: kind === "reminder" ? `Reminder: ${ev.name}` : `Details for ${ev.name}`, body: lines.join("\n").replace("Hi {first_name}", "Hi {first_name},") };
}
const fill = (body: string, g: Pick<GuestRow, "name" | "rsvp_token">, origin: string) => body.replaceAll("{first_name}", firstName(g.name)).replaceAll("{link}", rsvpLink(origin, g.rsvp_token));

async function audienceOf(q: Db["query"], eventId: string) {
  const all = await q<GuestRow>(`SELECT ${GUEST_COLS} FROM event_guests WHERE event_id = $1 AND removed_at IS NULL ORDER BY name, id`, [eventId]);
  const skipped = noSkips();
  const audience: GuestRow[] = [];
  for (const g of all) {
    if (g.status !== "registered") { skipped.not_registered++; continue; }
    const block = await mailBlock(q, g);
    if (block) { skipped[block.code]++; continue; }
    audience.push(g);
  }
  return { audience, skipped };
}

const noteOf = (kind: ReminderKind, v: unknown) => {
  const n = text(v);
  if (kind === "logistics") {
    if (!n) throw new HostedInvalid("Write the note guests need before the day.");
    if (n.length > MAX_LOGISTICS) throw new HostedInvalid(`Keep the note to ${MAX_LOGISTICS} characters.`);
  }
  return kind === "logistics" ? n : "";
};

/** The audience and the text, and what was skipped and why. Sends nothing. */
export async function reminderPreview(db: Db, eventId: string, kind: ReminderKind, opts: { note?: string; origin?: string; live?: boolean; hasSender?: boolean; actor?: string } = {}): Promise<ReminderPreview> {
  if (kind !== "reminder" && kind !== "logistics") throw new HostedInvalid("A reminder is a reminder or logistics.");
  const ev = await hostedEvent(db.query, eventId);
  const h = await readHosted(db.query, eventId);
  const [v] = await db.query<{ name: string }>("SELECT name FROM event_venues WHERE event_id = $1", [eventId]);
  const { audience, skipped } = await audienceOf(db.query, eventId);
  const note = kind === "logistics" ? text(opts.note).slice(0, MAX_LOGISTICS) : "";
  const t = template(ev, h, v?.name || ev.venue, kind, note, opts.actor ?? "");
  const [last] = await db.query<{ id: string; kind: ReminderKind; created_at: string; sent_count: number; skipped: Skipped }>("SELECT id, kind, created_at::text AS created_at, sent_count, skipped FROM reminder_runs WHERE event_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [eventId]);
  let refusal: string | null = null;
  if (ev.webinar) refusal = "A webinar has registrants, not reminders from here.";
  else if (opts.live && !opts.hasSender) refusal = NO_SENDER;
  else if (!audience.length) refusal = "Nobody is registered with an email the desk may use.";
  return {
    kind, subject: t.subject, body: t.body, example: audience[0] ? fill(t.body, audience[0], opts.origin ?? "") : null,
    audience: audience.map((g) => ({ guest_id: g.id, name: g.name, email: g.email! })), count: audience.length, skipped,
    can_send: refusal === null, refusal, last_run: last ?? null, integrated_with: integratedWith(),
  };
}

export interface ReminderSent { run_id: string; queued: number; sent: number; failed: number; unknown: number; skipped: Skipped }

/** Queues and sends one reminder to every registered guest the desk may email. It does not depend on the sequencer: INTEGRATED_WITH changes nothing here. */
export async function sendReminder(db: Db, deps: HostedDeps, actor: string, eventId: string, kind: ReminderKind, input: { note?: string; origin?: string } = {}): Promise<ReminderSent> {
  if (kind !== "reminder" && kind !== "logistics") throw new HostedInvalid("A reminder is a reminder or logistics.");
  const now = nowOf(deps);
  const note = noteOf(kind, input.note);
  const sender: TransactionalSender | null = deps.sender ?? (deps.live ? null : simulatedSender());
  if (!sender) throw new RuleError(NO_SENDER);
  const ids: string[] = [];
  const out = await db.tx(async (q) => {
    const ev = await hostedEvent(q, eventId);
    if (ev.webinar) throw new RuleError("A webinar has registrants, not reminders from here.");
    if (ev.stage === "declined") throw new RuleError("This event was declined, so there is nothing to remind.");
    const h = await lockHosted(q, eventId);
    const [recent] = await q("SELECT 1 FROM reminder_runs WHERE event_id = $1 AND kind = $2 AND created_at <= $3::timestamptz AND created_at > $3::timestamptz - ($4::text || ' minutes')::interval LIMIT 1", [eventId, kind, now.toISOString(), String(MIN_GAP_MINUTES)]);
    if (recent) throw new RuleError(`A ${kind} went out in the last ${MIN_GAP_MINUTES} minutes. Wait before sending another.`);
    const { audience, skipped } = await audienceOf(q, eventId);
    if (!audience.length) throw new RuleError("Nobody is registered with an email the desk may use.");
    const [v] = await q<{ name: string }>("SELECT name FROM event_venues WHERE event_id = $1", [eventId]);
    const t = template(ev, h, v?.name || ev.venue, kind, note, actor);
    const run = newId("rem");
    await q("INSERT INTO reminder_runs (id, event_id, kind, subject, body, created_by, created_at, skipped) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)", [run, eventId, kind, t.subject, t.body, actor, now.toISOString(), JSON.stringify(skipped)]);
    for (const g of audience) {
      await q("INSERT INTO reminder_sends (id, run_id, guest_id, email) VALUES ($1, $2, $3, $4)", [newId("rs"), run, g.id, g.email]);
      const id = newId("tx");
      await q("INSERT INTO transactional_outbox (id, event_id, guest_id, run_id, kind, to_email, subject, body, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [id, eventId, g.id, run, kind, g.email, t.subject, fill(t.body, g, input.origin ?? deps.appUrl ?? ""), now.toISOString()]);
      ids.push(id);
      await logGuest(q, eventId, g.id, "reminder", `${kind === "reminder" ? "Reminder" : "Logistics note"} queued`, actor, now);
    }
    await logActivity(q, eventId, actor, "hosted", `Sent a ${kind} to ${audience.length} registered guests`);
    return { run, skipped, queued: audience.length };
  });
  const r = await deliverOutbox(db, sender, ids, now);
  return { run_id: out.run, queued: out.queued, ...r, skipped: out.skipped };
}
