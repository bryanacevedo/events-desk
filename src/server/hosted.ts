/* A hosted event's guest list and what happens to it (docs/HOSTED.md, with section 21 overriding): guests, invitations the host sends, seating, check-in, walk-ins, closing
   attendance. Every status change goes through `transition` (src/shared/rsvp.ts) and, for the ones that touch the count, under a row lock on `hosted_events`, so two answers
   never both take the last place. Nothing here sends an invitation. Templates, not a model, write anything a person sends. Reads are in hosted-view.ts. */

import { randomBytes } from "node:crypto";
import type { Db } from "./db.ts";
import { defaultSettings } from "./approvals.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { eventZone } from "./meetings.ts";
import { canPlan } from "./money.ts";
import { isOptedOut, isWrongPerson } from "./caches.ts";
import { postToEvent } from "./operating.ts";
import { deliverOutbox, type TransactionalSender } from "./transactional.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { emailAllowed, normalizeCountry } from "../shared/country-rules.ts";
import { nameKey } from "../shared/email.ts";
import { companyKey } from "../shared/ingest.ts";
import { isGuestStatus, REFUSAL, transition, undoTransition, type GuestStatus, type Mover } from "../shared/rsvp.ts";

type Q = Db["query"];
export class HostedInvalid extends Error {}

/** What the hosted code needs from the outside: the clock, Slack (for the owners' notes), the sender, and the desk's own address. Any of it may be absent. */
export interface HostedDeps { now?: () => Date; notify?: LifecycleDeps["notify"]; userMap?: Record<string, string>; appUrl?: string; sender?: TransactionalSender | null; /** Live mode: no sender means no mail. */ live?: boolean }
export const nowOf = (d?: Pick<HostedDeps, "now">) => d?.now?.() ?? new Date();

export const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const clip = (v: unknown, n: number, what: string) => { const s = text(v); if (s.length > n) throw new HostedInvalid(`Keep ${what} to ${n} characters.`); return s; };
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const newToken = () => randomBytes(24).toString("base64url");
export const firstName = (n: string) => n.trim().split(/\s+/)[0] ?? n;

export const GUEST_SOURCES = ["account", "deal", "nomination", "luma", "splash", "walk_in", "manual"] as const;

/** The blocked-country list: config/defaults.json email_country_rules.blocked. */
export const blockedCountries = (): string[] => defaultSettings().email_country_rules?.blocked ?? [];
export const hostedConfig = () => ({ noshow_default_pct: 20, history_min_events: 2, history_min_yes: 10, ...(defaultSettings().hosted ?? {}) });

/** The calendar day at `at` in an IANA zone. */
export const dayIn = (at: Date, zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const shortDay = (ymd: string) => `${Number(ymd.slice(8, 10))} ${MON[Number(ymd.slice(5, 7)) - 1]}`;
export const longDay = (ymd: string) => `${WEEKDAY[new Date(`${ymd}T00:00:00Z`).getUTCDay()]} ${shortDay(ymd)} ${ymd.slice(0, 4)}`;

/* ------------------------------------------------------------------ the event, its row, its lock */

export interface HostedEvent { id: string; name: string; starts_on: string; last_day: string; country: string | null; venue: string; stage: string; requested_by: string; format: string; headcount: number | null; conference_event_id: string | null; zone: string; webinar: boolean }

/** The hosted event as the guest code sees it. Refuses an event that is not hosted. */
export async function hostedEvent(q: Q, eventId: string): Promise<HostedEvent> {
  const [e] = await q<Omit<HostedEvent, "zone" | "webinar">>(
    `SELECT e.id, e.name, e.starts_on::text AS starts_on, coalesce(e.ends_on, e.starts_on)::text AS last_day, e.country, coalesce(e.venue, '') AS venue, e.stage, e.requested_by,
            i.hosted_format AS format, i.headcount, i.conference_event_id
       FROM events e JOIN involvements i ON i.event_id = e.id AND i.kind = 'hosted' AND i.status <> 'dropped' WHERE e.id = $1 AND e.parent_event_id IS NULL`, [eventId]);
  if (!e) throw new RuleError("This is not a hosted event.");
  return { ...e, zone: await eventZone(q, eventId), webinar: e.format === "webinar" };
}

export interface HostedRow { event_id: string; capacity: number | null; noshow_pct: number | null; host_name: string; host_email: string; doors_at: string | null; address: string; welcome: string; closed_at: string | null; rsvp_open: boolean }
const HOSTED_COLS = "event_id, capacity, noshow_pct, host_name, host_email, doors_at, address, welcome, closed_at::text AS closed_at, rsvp_open";

/** Makes the row if the event has none, then reads it under a lock. Every status-changing write starts here. */
export async function lockHosted(q: Q, eventId: string): Promise<HostedRow> {
  await q("INSERT INTO hosted_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING", [eventId]);
  const [h] = await q<HostedRow>(`SELECT ${HOSTED_COLS} FROM hosted_events WHERE event_id = $1 FOR UPDATE`, [eventId]);
  return h;
}
export async function readHosted(q: Q, eventId: string): Promise<HostedRow> {
  const [h] = await q<HostedRow>(`SELECT ${HOSTED_COLS} FROM hosted_events WHERE event_id = $1`, [eventId]);
  return h ?? { event_id: eventId, capacity: null, noshow_pct: null, host_name: "", host_email: "", doors_at: null, address: "", welcome: "", closed_at: null, rsvp_open: true };
}

/** The capacity: explicit, else the hosted involvement's headcount when it is at least 1, else none. */
export const capacityOf = (h: Pick<HostedRow, "capacity">, e: Pick<HostedEvent, "headcount">): number | null => h.capacity ?? (e.headcount !== null && e.headcount >= 1 ? e.headcount : null);

export const registeredCount = async (q: Q, eventId: string) => (await q<{ n: number }>("SELECT count(*)::int AS n FROM event_guests WHERE event_id = $1 AND status = 'registered' AND removed_at IS NULL", [eventId]))[0].n;

/* ------------------------------------------------------------------ guests */

export interface GuestRow {
  id: string; event_id: string; name: string; email: string | null; company: string; title: string; country: string | null; account_id: string | null; owner: string; side: "us" | "partner"; source: string;
  nominated_by: string | null; status: GuestStatus; prior_status: GuestStatus | null; rsvp_token: string; dietary: string; decline_note: string; invited_at: string | null; rsvp_at: string | null; waitlisted_at: string | null;
  checked_in_at: string | null; checked_in_by: string | null; seat: string; notes: string; removed_at: string | null; removed_reason: string | null; created_by: string; created_at: string;
}
export const GUEST_COLS = `id, event_id, name, email, company, title, country, account_id, owner, side, source, nominated_by, status, prior_status, rsvp_token, dietary, decline_note,
  invited_at::text AS invited_at, rsvp_at::text AS rsvp_at, waitlisted_at::text AS waitlisted_at, checked_in_at::text AS checked_in_at, checked_in_by, seat, notes, removed_at::text AS removed_at, removed_reason, created_by, created_at::text AS created_at`;

export async function guestOf(q: Q, eventId: string, gid: string, lock = false): Promise<GuestRow> {
  const [g] = await q<GuestRow>(`SELECT ${GUEST_COLS} FROM event_guests WHERE id = $1 AND event_id = $2 AND removed_at IS NULL${lock ? " FOR UPDATE" : ""}`, [gid, eventId]);
  if (!g) throw new RuleError("That guest is not on this list.");
  return g;
}

export const logGuest = (q: Q, eventId: string, guestId: string | null, kind: string, detail: string, actor: string, at?: Date) =>
  q("INSERT INTO guest_log (id, event_id, guest_id, kind, detail, actor, at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [newId("gl"), eventId, guestId, kind, detail, actor, (at ?? new Date()).toISOString()]);

/** Why the desk may not email this guest, or null. Country rules, no address, opt-out, wrong person (gate.ts is not consulted: hosted guests are not gate subjects). */
export async function mailBlock(q: Q, g: Pick<GuestRow, "email" | "country" | "name" | "company">): Promise<{ code: "no_email" | "country" | "opted_out" | "wrong_person"; reason: string } | null> {
  if (!g.email) return { code: "no_email", reason: "There is no email address for this guest." };
  const v = emailAllowed(g.country, blockedCountries());
  if (!v.ok) return { code: "country", reason: v.reason! };
  const db = { query: q } as Db;
  if (await isOptedOut(db, { email: g.email, name_key: nameKey(g.name), company_key: g.company ? companyKey(g.company) : null })) return { code: "opted_out", reason: "This person has opted out of email." };
  if (await isWrongPerson(db, g.email, nameKey(g.name))) return { code: "wrong_person", reason: "This address is known not to be theirs." };
  return null;
}

export interface GuestInput {
  name?: string; email?: string | null; company?: string; title?: string; country?: string | null; owner?: string; side?: string; source?: string; nominated_by?: string | null; account_id?: string | null;
  seat?: string; notes?: string; dietary?: string;
}

async function ensureFree(q: Q, eventId: string, email: string | null, name: string, company: string, exceptId?: string) {
  const dup = email
    ? await q("SELECT 1 FROM event_guests WHERE event_id = $1 AND lower(email) = $2 AND removed_at IS NULL AND ($3::text IS NULL OR id <> $3)", [eventId, email, exceptId ?? null])
    : await q("SELECT 1 FROM event_guests WHERE event_id = $1 AND email IS NULL AND lower(name) = lower($2) AND lower(coalesce(company, '')) = lower($3) AND removed_at IS NULL AND ($4::text IS NULL OR id <> $4)", [eventId, name, company, exceptId ?? null]);
  if (dup.length) throw new RuleError("This person is already on the list.");
}

function readCountry(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const c = normalizeCountry(s);
  if (!c) throw new HostedInvalid("Give the country as a two-letter code, such as US.");
  return c;
}

/** Adds one guest. The owner is one person: the one named, else the nominator, else the person adding. */
export async function addGuest(db: Db, actor: string, eventId: string, input: GuestInput, opts: { at?: Date } = {}) {
  return db.tx(async (q) => {
    const ev = await hostedEvent(q, eventId);
    if (ev.stage === "declined") throw new RuleError("This event was declined, so its list is closed.");
    const name = clip(input.name, 120, "the name");
    if (!name) throw new HostedInvalid("A guest needs a name.");
    const rawEmail = text(input.email).toLowerCase();
    if (rawEmail && !EMAIL_RE.test(rawEmail)) throw new HostedInvalid("That is not an email address.");
    const email = rawEmail || null;
    const source = (input.source ?? "manual") as (typeof GUEST_SOURCES)[number];
    if (!GUEST_SOURCES.includes(source) || source === "walk_in") throw new HostedInvalid(`A guest comes from one of: ${GUEST_SOURCES.filter((s) => s !== "walk_in").join(", ")}.`);
    const side = input.side === "partner" ? "partner" : "us";
    if (input.side && input.side !== "us" && input.side !== "partner") throw new HostedInvalid("Side is us or partner.");
    let company = clip(input.company, 120, "the company");
    let account: { id: string; name: string; owner: string | null; country: string | null } | undefined;
    if (input.account_id) {
      [account] = await q<{ id: string; name: string; owner: string | null; country: string | null }>("SELECT id, name, owner, country FROM target_accounts WHERE id = $1", [input.account_id]);
      if (!account) throw new HostedInvalid("That account is not in the target list.");
      company ||= account.name;
    }
    const nominated_by = source === "nomination" ? text(input.nominated_by) || actor : text(input.nominated_by) || null;
    const owner = text(input.owner) || (source === "nomination" ? nominated_by! : account?.owner || actor);
    if (!owner) throw new HostedInvalid("Every guest has one owner.");
    const country = readCountry(input.country) ?? (account?.country ? normalizeCountry(account.country) : null);
    await ensureFree(q, eventId, email, name, company);
    const id = newId("gst");
    await q(
      `INSERT INTO event_guests (id, event_id, name, email, company, title, country, account_id, owner, side, source, nominated_by, rsvp_token, dietary, seat, notes, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [id, eventId, name, email, company, clip(input.title, 120, "the title"), country, account?.id ?? null, owner.slice(0, 60), side, source, nominated_by, newToken(), clip(input.dietary, 300, "the dietary note"),
        clip(input.seat, 60, "the seat"), clip(input.notes, 2000, "the notes"), actor, (opts.at ?? new Date()).toISOString()]);
    await logGuest(q, eventId, id, "status", `Added to the list${source === "nomination" ? `, nominated by ${nominated_by}` : ""}`, actor, opts.at);
    return { id };
  });
}

/** What a guest's owner may change on their own: notes. The host, a planner, a lead and GTM may change the rest. */
export async function updateGuest(db: Db, actor: string, eventId: string, gid: string, patch: GuestInput, opts: { ownerOnly?: boolean } = {}) {
  return db.tx(async (q) => {
    await hostedEvent(q, eventId);
    const g = await guestOf(q, eventId, gid, true);
    const sets: string[] = [], vals: unknown[] = [gid];
    const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (patch.notes !== undefined) put("notes", clip(patch.notes, 2000, "the notes"));
    if (opts.ownerOnly) {
      for (const k of Object.keys(patch)) if (k !== "notes") throw new RuleError("The owner writes notes. The host or a planner changes the rest.");
    } else {
      if (patch.name !== undefined) { const n = clip(patch.name, 120, "the name"); if (!n) throw new HostedInvalid("A guest needs a name."); put("name", n); }
      if (patch.email !== undefined) {
        const e = text(patch.email).toLowerCase();
        if (e && !EMAIL_RE.test(e)) throw new HostedInvalid("That is not an email address.");
        put("email", e || null);
      }
      if (patch.company !== undefined) put("company", clip(patch.company, 120, "the company"));
      if (patch.title !== undefined) put("title", clip(patch.title, 120, "the title"));
      if (patch.country !== undefined) put("country", readCountry(patch.country));
      if (patch.seat !== undefined) put("seat", clip(patch.seat, 60, "the seat"));
      if (patch.dietary !== undefined) put("dietary", clip(patch.dietary, 300, "the dietary note"));
      if (patch.side !== undefined) { if (patch.side !== "us" && patch.side !== "partner") throw new HostedInvalid("Side is us or partner."); put("side", patch.side); }
      if (patch.owner !== undefined) {
        const o = text(patch.owner);
        if (!o) throw new HostedInvalid("Every guest has one owner.");
        if (o !== g.owner) { put("owner", o.slice(0, 60)); await logGuest(q, eventId, gid, "owner", `Owner changed from ${g.owner} to ${o}`, actor); }
      }
    }
    if (!sets.length) throw new HostedInvalid("Say what to change.");
    const next = { name: patch.name !== undefined ? text(patch.name) : g.name, email: patch.email !== undefined ? text(patch.email).toLowerCase() || null : g.email, company: patch.company !== undefined ? text(patch.company) : g.company };
    if (!opts.ownerOnly && (patch.name !== undefined || patch.email !== undefined || patch.company !== undefined)) await ensureFree(q, eventId, next.email, next.name, next.company, gid);
    await q(`UPDATE event_guests SET ${sets.join(", ")} WHERE id = $1`, vals);
    if (patch.notes !== undefined && patch.notes !== g.notes) await logGuest(q, eventId, gid, "note", "Notes changed", actor);
    return { id: gid };
  });
}

/* ------------------------------------------------------------------ the host's settings */

export interface HostedPatch { capacity?: number | null; noshow_pct?: number | null; host_name?: string; host_email?: string; doors_at?: string | null; address?: string; welcome?: string; rsvp_open?: boolean }

/** Capacity, expected no-shows, host, doors, address, welcome line and whether the list takes new yes answers. Lowering capacity below the registered count only warns. */
export async function patchHosted(db: Db, actor: string, eventId: string, patch: HostedPatch) {
  return db.tx(async (q) => {
    const ev = await hostedEvent(q, eventId);
    const h = await lockHosted(q, eventId);
    const sets: string[] = [], vals: unknown[] = [eventId];
    const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    const warnings: string[] = [];
    if (patch.capacity !== undefined) {
      const v = patch.capacity;
      if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 1)) throw new HostedInvalid("Capacity is a whole number from 1, or empty for no limit.");
      put("capacity", v);
      const reg = await registeredCount(q, eventId);
      if (v !== null && reg > v) warnings.push(`${reg} are registered and the capacity is now ${v}. Nobody is moved.`);
    }
    if (patch.noshow_pct !== undefined) {
      const v = patch.noshow_pct;
      if (v !== null && (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 90)) throw new HostedInvalid("Expected no-shows is a whole number from 0 to 90 percent, or empty for the default.");
      put("noshow_pct", v);
    }
    if (patch.host_name !== undefined) put("host_name", clip(patch.host_name, 80, "the host's name"));
    if (patch.host_email !== undefined) {
      const e = text(patch.host_email).toLowerCase();
      if (e && !EMAIL_RE.test(e)) throw new HostedInvalid("That is not an email address.");
      put("host_email", e);
    }
    if (patch.doors_at !== undefined) {
      const d = patch.doors_at === null ? null : text(patch.doors_at);
      if (d !== null && d !== "" && !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(d)) throw new HostedInvalid("Doors open at a time like 18:30.");
      put("doors_at", d || null);
    }
    if (patch.address !== undefined) put("address", clip(patch.address, 300, "the address"));
    if (patch.welcome !== undefined) put("welcome", clip(patch.welcome, 300, "the welcome line"));
    if (patch.rsvp_open !== undefined) { if (typeof patch.rsvp_open !== "boolean") throw new HostedInvalid("Choose whether the list is open."); put("rsvp_open", patch.rsvp_open); }
    if (!sets.length) throw new HostedInvalid("Say what to change.");
    await q(`UPDATE hosted_events SET ${sets.join(", ")} WHERE event_id = $1`, vals);
    await logActivity(q, eventId, actor, "hosted", "Changed the event's details");
    void h; void ev;
    return { event_id: eventId, warnings };
  });
}

/* ------------------------------------------------------------------ invitations the host sends */

export interface Invitation { subject: string; body: string; link: string }

/** The link a guest answers on: the desk's own address plus /rsvp/<token>. */
export const rsvpLink = (origin: string, token: string) => `${origin.replace(/\/$/, "")}/rsvp/${token}`;

/** The fixed text: the event, the day, the venue, the welcome line, the guest's first name and the link. No model writes it. */
export async function invitationText(db: Db, eventId: string, gid: string, origin: string): Promise<Invitation> {
  const ev = await hostedEvent(db.query, eventId);
  if (ev.webinar) throw new RuleError("A webinar has registrants, not invitations.");
  const h = await readHosted(db.query, eventId);
  const g = await guestOf(db.query, eventId, gid);
  const block = await mailBlock(db.query, g);
  if (block) throw new RuleError(block.reason);
  const [v] = await db.query<{ name: string; address: string }>("SELECT name, address FROM event_venues WHERE event_id = $1", [eventId]);
  const place = [v?.name || ev.venue, h.address || v?.address].filter(Boolean).join(", ");
  const link = rsvpLink(origin, g.rsvp_token);
  const host = h.host_name || "The team";
  const body = [
    `Hi ${firstName(g.name)},`, "",
    `${host} would like you to join us at ${ev.name} on ${longDay(ev.starts_on)}${h.doors_at ? `, doors at ${h.doors_at}` : ""}${place ? `, at ${place}` : ""}.`,
    ...(h.welcome ? ["", h.welcome] : []),
    "", `Please tell us whether you can come: ${link}`, "", host,
  ].join("\n");
  return { subject: `You are invited: ${ev.name}`, body, link };
}

/** Logs that the host sent the invitation from their own mailbox. The desk sends nothing. Listed becomes invited; a second nudge stays invited. */
export async function logInvitation(db: Db, actor: string, eventId: string, gid: string, input: { sent_on?: string; mailbox?: string; sent_by?: string } = {}, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  return db.tx(async (q) => {
    const ev = await hostedEvent(q, eventId);
    if (ev.webinar) throw new RuleError("A webinar has registrants, not invitations.");
    if (ev.stage === "declined") throw new RuleError("This event was declined, so its list is closed.");
    const h = await readHosted(q, eventId);
    const g = await guestOf(q, eventId, gid, true);
    const block = await mailBlock(q, g);
    if (block) throw new RuleError(block.reason);
    if (g.status !== "listed" && g.status !== "invited") throw new RuleError("They have already answered, so there is nothing to invite.");
    const err = transition(g.status, "invited", { by: "host" });
    if (err) throw new RuleError(err);
    const sent_on = text(input.sent_on) || dayIn(now, ev.zone);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sent_on) || Number.isNaN(Date.parse(sent_on))) throw new HostedInvalid("Give the day it was sent as a date.");
    const mailbox = text(input.mailbox) || h.host_email;
    await q("INSERT INTO guest_invitations (id, event_id, guest_id, sent_by, sent_on, mailbox, logged_by, logged_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [newId("inv"), eventId, gid, text(input.sent_by) || h.host_name || actor, sent_on, mailbox, actor, now.toISOString()]);
    await q("UPDATE event_guests SET status = 'invited', invited_at = $2 WHERE id = $1", [gid, now.toISOString()]);
    await logGuest(q, eventId, gid, "invitation_logged", `Invitation sent ${sent_on}${mailbox ? ` from ${mailbox}` : ""}`, actor, now);
    return { id: gid, status: "invited" as GuestStatus };
  });
}

/* ------------------------------------------------------------------ promotion and the seat that opens */

/** Queues one `seat_open` message to a guest just promoted off the waitlist. It is skipped, and logged, when the desk may not email them. Returns the outbox id, or null. */
export async function queueSeatOpen(q: Q, ev: HostedEvent, h: HostedRow, g: GuestRow, now: Date): Promise<string | null> {
  const block = await mailBlock(q, g);
  if (block) { await logGuest(q, ev.id, g.id, "seat_open", `A place opened and they were moved up. Not emailed: ${block.reason}`, "Events Desk", now); return null; }
  const id = newId("tx");
  const host = h.host_name || "The team";
  await q("INSERT INTO transactional_outbox (id, event_id, guest_id, run_id, kind, to_email, subject, body, created_at) VALUES ($1, $2, $3, NULL, 'seat_open', $4, $5, $6, $7)",
    [id, ev.id, g.id, g.email, `A place opened: ${ev.name}`, [`Hi ${firstName(g.name)},`, "", `A place opened and you are now on the list for ${ev.name} on ${longDay(ev.starts_on)}.`, "", `If you can no longer come, please tell us on your link.`, "", host].join("\n"), now.toISOString()]);
  await logGuest(q, ev.id, g.id, "seat_open", "A place opened and they were moved up from the waitlist", "Events Desk", now);
  return id;
}

/** Moves the first waitlisted guest (lowest waitlisted_at, then id) to registered when there is room. Returns the guest and the outbox id of their message. */
export async function promoteFirst(q: Q, ev: HostedEvent, h: HostedRow, actor: string, now: Date): Promise<{ guest: GuestRow; outbox: string | null } | null> {
  const cap = capacityOf(h, ev);
  if (cap === null || (await registeredCount(q, ev.id)) >= cap) return null;
  const [g] = await q<GuestRow>(`SELECT ${GUEST_COLS} FROM event_guests WHERE event_id = $1 AND status = 'waitlist' AND removed_at IS NULL ORDER BY waitlisted_at, id LIMIT 1 FOR UPDATE`, [ev.id]);
  if (!g) return null;
  const err = transition("waitlist", "registered", { by: "system" });
  if (err) return null;
  await q("UPDATE event_guests SET status = 'registered', waitlisted_at = NULL WHERE id = $1", [g.id]);
  await logGuest(q, ev.id, g.id, "status", "Moved up from the waitlist to registered", actor, now);
  return { guest: { ...g, status: "registered" }, outbox: await queueSeatOpen(q, ev, h, { ...g, status: "registered" }, now) };
}

/** After a commit: hands queued outbox rows to the sender. Without a sender (live mode, no key) they stay queued and the page shows it. */
export async function flushOutbox(db: Db, deps: HostedDeps, ids: (string | null | undefined)[]) {
  const list = ids.filter((x): x is string => Boolean(x));
  if (!list.length || !deps.sender) return;
  await deliverOutbox(db, deps.sender, list, nowOf(deps));
}

/* ------------------------------------------------------------------ the host moves someone */

/** Moves a guest off the waitlist, or to declined (with a reason, kept as the decline note). A registered guest declined this way opens a place for the waitlist. */
export async function moveGuest(db: Db, deps: HostedDeps, actor: string, eventId: string, gid: string, to: string, input: { reason?: string } = {}) {
  const now = nowOf(deps);
  const ids: (string | null)[] = [];
  const out = await db.tx(async (q) => {
    const ev = await hostedEvent(q, eventId);
    if (ev.webinar) throw new RuleError("A webinar has no waitlist to move.");
    const h = await lockHosted(q, eventId);
    const g = await guestOf(q, eventId, gid, true);
    if (!isGuestStatus(to) || (to !== "registered" && to !== "declined")) throw new HostedInvalid("A guest is moved to registered or to declined.");
    if (h.closed_at) throw new RuleError(REFUSAL.closed);
    const err = transition(g.status, to, { by: "host", reason: input.reason });
    if (err) throw new RuleError(err);
    if (to === "registered") {
      await q("UPDATE event_guests SET status = 'registered', waitlisted_at = NULL, rsvp_at = coalesce(rsvp_at, $2) WHERE id = $1", [gid, now.toISOString()]);
      await logGuest(q, eventId, gid, "status", "Moved from the waitlist to registered by the host", actor, now);
      const cap = capacityOf(h, ev);
      return { id: gid, status: "registered" as GuestStatus, over_capacity: cap !== null && (await registeredCount(q, eventId)) > cap, promoted: null as string | null };
    }
    const reason = clip(input.reason, 300, "the reason");
    await q("UPDATE event_guests SET status = 'declined', decline_note = $2, waitlisted_at = NULL, rsvp_at = $3 WHERE id = $1", [gid, reason, now.toISOString()]);
    await logGuest(q, eventId, gid, "status", `Moved to declined by the host: ${reason}`, actor, now);
    const p = g.status === "registered" ? await promoteFirst(q, ev, h, actor, now) : null;
    ids.push(p?.outbox ?? null);
    return { id: gid, status: "declined" as GuestStatus, over_capacity: false, promoted: p?.guest.id ?? null };
  });
  await flushOutbox(db, deps, ids);
  return out;
}

/** Takes a guest off the list. A reason is required and the database checks it. A registered guest removed opens a place, the same way a decline does. */
export async function removeGuest(db: Db, deps: HostedDeps, actor: string, eventId: string, gid: string, reason: string) {
  const now = nowOf(deps);
  const why = text(reason);
  if (!why) throw new HostedInvalid("Say why they are coming off the list.");
  const ids: (string | null)[] = [];
  const out = await db.tx(async (q) => {
    const ev = await hostedEvent(q, eventId);
    const h = await lockHosted(q, eventId);
    const g = await guestOf(q, eventId, gid, true);
    await q("UPDATE event_guests SET removed_at = $2, removed_reason = $3 WHERE id = $1", [gid, now.toISOString(), why.slice(0, 300)]);
    await logGuest(q, eventId, gid, "status", `Removed from the list: ${why.slice(0, 300)}`, actor, now);
    const p = g.status === "registered" ? await promoteFirst(q, ev, h, actor, now) : null;
    ids.push(p?.outbox ?? null);
    return { id: gid, promoted: p?.guest.id ?? null };
  });
  await flushOutbox(db, deps, ids);
  return out;
}

/* ------------------------------------------------------------------ the door: check-in, walk-ins, closing */

/** Checks a guest in. Capacity is not enforced at the door. Anyone not yet answered, registered, waitlisted, declined or marked no-show may be checked in. */
export async function checkIn(db: Db, deps: HostedDeps, actor: string, eventId: string, gid: string) {
  const now = nowOf(deps);
  return db.tx(async (q) => {
    const ev = await hostedEvent(q, eventId);
    if (ev.webinar) throw new RuleError("A webinar has no check-in. Import its attendance instead.");
    await lockHosted(q, eventId);
    const g = await guestOf(q, eventId, gid, true);
    if (g.status === "attended") throw new RuleError("They are already checked in.");
    const err = transition(g.status, "attended", { by: "host" });
    if (err) throw new RuleError(err);
    await q("UPDATE event_guests SET status = 'attended', prior_status = $2, checked_in_at = $3, checked_in_by = $4, waitlisted_at = NULL WHERE id = $1", [gid, g.status, now.toISOString(), actor]);
    await logGuest(q, eventId, gid, "status", `Checked in${g.status === "no_show" ? " after the door closed" : ""}`, actor, now);
    return { id: gid, status: "attended" as GuestStatus };
  });
}

/** Undoes a check-in made by mistake: the guest goes back to the status they had. Refused after attendance is closed, and for a walk-in (who is removed instead). */
export async function undoCheckIn(db: Db, deps: HostedDeps, actor: string, eventId: string, gid: string) {
  const now = nowOf(deps);
  return db.tx(async (q) => {
    await hostedEvent(q, eventId);
    const h = await lockHosted(q, eventId);
    const g = await guestOf(q, eventId, gid, true);
    if (g.status !== "attended") throw new RuleError("They are not checked in.");
    const refusal = undoTransition(g.prior_status, { closed: Boolean(h.closed_at) });
    if (refusal) throw new RuleError(refusal);
    const back = g.prior_status as GuestStatus;
    await q("UPDATE event_guests SET status = $2, prior_status = NULL, checked_in_at = NULL, checked_in_by = NULL, waitlisted_at = CASE WHEN $2 = 'waitlist' THEN coalesce(waitlisted_at, $3::timestamptz) ELSE NULL END WHERE id = $1", [gid, back, now.toISOString()]);
    await logGuest(q, eventId, gid, "status", `Check-in undone, back to ${back}`, actor, now);
    return { id: gid, status: back };
  });
}

/** A person who came and was not on the list: arrives attended with source walk_in. The owner defaults to the host. */
export async function walkIn(db: Db, deps: HostedDeps, actor: string, eventId: string, input: GuestInput) {
  const now = nowOf(deps);
  return db.tx(async (q) => {
    const ev = await hostedEvent(q, eventId);
    if (ev.webinar) throw new RuleError("A webinar has no check-in. Import its attendance instead.");
    if (ev.stage === "declined") throw new RuleError("This event was declined, so its list is closed.");
    const h = await readHosted(q, eventId);
    const name = clip(input.name, 120, "the name");
    if (!name) throw new HostedInvalid("A walk-in needs a name.");
    const rawEmail = text(input.email).toLowerCase();
    if (rawEmail && !EMAIL_RE.test(rawEmail)) throw new HostedInvalid("That is not an email address.");
    const email = rawEmail || null;
    const company = clip(input.company, 120, "the company");
    await ensureFree(q, eventId, email, name, company);
    const owner = (text(input.owner) || h.host_name || actor).slice(0, 60);
    const id = newId("gst");
    await q(
      `INSERT INTO event_guests (id, event_id, name, email, company, title, country, owner, side, source, status, rsvp_token, checked_in_at, checked_in_by, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'us', 'walk_in', 'attended', $9, $10, $11, $11, $10)`,
      [id, eventId, name, email, company, clip(input.title, 120, "the title"), readCountry(input.country), owner, newToken(), now.toISOString(), actor]);
    await logGuest(q, eventId, id, "walk_in", `Walked in${company ? ` from ${company}` : ""}`, actor, now);
    return { id, status: "attended" as GuestStatus };
  });
}

export interface ClosedRead { closed_at: string; no_show: number; attended: number; notes_logged: number; owners_told: string[] }

/** Closes attendance: every registered guest becomes a no-show, and the event's closed_at is set. Refused before the event's day. A guest on the waitlist, listed, invited or declined stays what they were.
    Each guest with notes gets one `note` row in the log, and the owner is told in Slack when they map to a Slack user. */
export async function closeAttendance(db: Db, deps: HostedDeps, actor: string, eventId: string): Promise<ClosedRead> {
  const now = nowOf(deps);
  const told: { owner: string; lines: string[] }[] = [];
  const out = await db.tx(async (q) => {
    const ev = await hostedEvent(q, eventId);
    if (ev.webinar) throw new RuleError("A webinar has no door to close.");
    const h = await lockHosted(q, eventId);
    if (h.closed_at) throw new RuleError("Attendance is already closed.");
    const today = dayIn(now, ev.zone);
    if (today < ev.starts_on) throw new RuleError("The event has not started, so attendance cannot be closed yet.");
    const reg = await q<GuestRow>(`SELECT ${GUEST_COLS} FROM event_guests WHERE event_id = $1 AND status = 'registered' AND removed_at IS NULL FOR UPDATE`, [eventId]);
    for (const g of reg) {
      const err = transition("registered", "no_show", { by: "system", dayBegan: true });
      if (err) throw new RuleError(err);
      await q("UPDATE event_guests SET status = 'no_show', prior_status = 'registered' WHERE id = $1", [g.id]);
      await logGuest(q, eventId, g.id, "status", "Did not come", actor, now);
    }
    await q("UPDATE hosted_events SET closed_at = $2 WHERE event_id = $1", [eventId, now.toISOString()]);
    const withNotes = await q<GuestRow>(`SELECT ${GUEST_COLS} FROM event_guests WHERE event_id = $1 AND removed_at IS NULL AND length(trim(notes)) > 0 AND status IN ('attended', 'no_show') ORDER BY owner, name`, [eventId]);
    for (const g of withNotes) {
      await logGuest(q, eventId, g.id, "note", `Notes for ${g.owner}: ${g.notes.slice(0, 300)}`, actor, now);
      const t = told.find((x) => x.owner === g.owner) ?? (told[told.push({ owner: g.owner, lines: [] }) - 1]);
      t.lines.push(`${g.name}${g.company ? `, ${g.company}` : ""}: ${g.notes.slice(0, 300)}`);
    }
    const [c] = await q<{ attended: number; no_show: number }>("SELECT count(*) FILTER (WHERE status = 'attended')::int AS attended, count(*) FILTER (WHERE status = 'no_show')::int AS no_show FROM event_guests WHERE event_id = $1 AND removed_at IS NULL", [eventId]);
    await logActivity(q, eventId, actor, "hosted", `Closed attendance: ${c.attended} came, ${c.no_show} did not`);
    return { closed_at: now.toISOString(), no_show: c.no_show, attended: c.attended, notes_logged: withNotes.length };
  });
  // The owners are told after the commit, and only when Slack knows them. A failed post never undoes the closing.
  const owners: string[] = [];
  if (deps.notify) for (const t of told) {
    const slack = deps.userMap?.[t.owner];
    if (!slack) continue;
    try { await postToEvent(db, deps as LifecycleDeps, eventId, { text: `Notes from the event for ${t.owner}:\n${t.lines.join("\n")}`, blocks: [] }, [slack]); owners.push(t.owner); } catch { /* the notes stay in the log */ }
  }
  return { ...out, owners_told: owners };
}

/* ------------------------------------------------------------------ who may do what */

/** Planners, leads and GTM; and the people on the event's list with the host role (21.13). */
export async function canWriteHosted(db: Db, actor: string, eventId: string): Promise<boolean> {
  if (!actor) return false;
  if (canPlan(actor)) return true;
  const r = await db.query("SELECT 1 FROM event_people WHERE event_id = $1 AND person = $2 AND removed_at IS NULL AND 'host' = ANY(roles) LIMIT 1", [eventId, actor]);
  return r.length > 0;
}
/** The same people, plus anyone on the event's people list. */
export async function canCheckInHosted(db: Db, actor: string, eventId: string): Promise<boolean> {
  if (await canWriteHosted(db, actor, eventId)) return true;
  const r = await db.query("SELECT 1 FROM event_people WHERE event_id = $1 AND person = $2 AND removed_at IS NULL LIMIT 1", [eventId, actor]);
  return r.length > 0;
}
export const ownsGuest = async (db: Db, actor: string, eventId: string, gid: string) => (await db.query("SELECT 1 FROM event_guests WHERE id = $1 AND event_id = $2 AND owner = $3 AND removed_at IS NULL", [gid, eventId, actor])).length > 0;

export type { Mover };
