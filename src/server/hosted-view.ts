/* What a hosted event reads as (docs/HOSTED.md 9, 10, 12, 21): the whole page, the expected no-shows, the venue and the co-host, the two follow-up groups, and a person's own guests across events.
   Money keys end in `cents`, so forRep strips them for a rep; free text goes through the activity feed's `$12` filter for a rep too (21.12). */

import type { Db } from "./db.ts";
import { newId, RuleError } from "./events.ts";
import { eventCost } from "./closeout.ts";
import { forRep } from "./money.ts";
import { reminderPreview } from "./hosted-reminders.ts";
import {
  capacityOf, dayIn, firstName, GUEST_COLS, hostedConfig, hostedEvent, HostedInvalid, mailBlock, nowOf, readHosted, shortDay, text, type GuestRow, type HostedDeps, type HostedEvent, type HostedRow,
} from "./hosted.ts";
import { daysBetween } from "../shared/motion.ts";
import { HOSTED_WORDS, type HostedFormat } from "../shared/plan.ts";
import { STATUS_WORDS } from "../shared/rsvp.ts";

type Q = Db["query"];

/** A rep reads no dollar figure, in a key or in text. Any string that looks like one is blanked, as the activity feed leaves such an entry out. */
export function repText<T>(o: T): T {
  if (typeof o === "string") return (/\$\s?\d/.test(o) ? "" : o) as T;
  if (Array.isArray(o)) return o.map(repText) as T;
  if (o && typeof o === "object") return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, repText(v)])) as T;
  return o;
}
export const asRep = <T>(o: T): T => forRep(repText(o));

/* ------------------------------------------------------------------ expected no-shows */

export interface Estimate { rate_pct: number; basis: "default" | "set" | "history"; yes: number; expected_attending: number; confirm_to_fill: number | null; capacity: number | null; words: string }

/** Default, the planner's own number, or the team's history once there is enough of it. History counts closed, non-webinar hosted events; "said yes" is registered, attended or no-show at closing, walk-ins left out. */
export async function noshowEstimate(q: Q, ev: HostedEvent, h: HostedRow): Promise<Estimate> {
  const cfg = hostedConfig();
  const cap = capacityOf(h, ev);
  let rate = cfg.noshow_default_pct, basis: Estimate["basis"] = "default", words = `Using ${rate} percent, a starting guess. Your own events replace it after ${cfg.history_min_events} closed events with ${cfg.history_min_yes} yes answers.`;
  const [hist] = await q<{ events: number; yes: number; no_show: number }>(
    `SELECT count(DISTINCT he.event_id)::int AS events,
            count(g.id) FILTER (WHERE g.status IN ('registered', 'attended', 'no_show') AND g.source <> 'walk_in')::int AS yes,
            count(g.id) FILTER (WHERE g.status = 'no_show')::int AS no_show
       FROM hosted_events he
       JOIN involvements i ON i.event_id = he.event_id AND i.kind = 'hosted' AND i.status <> 'dropped' AND i.hosted_format <> 'webinar'
       JOIN events e ON e.id = he.event_id AND e.stage <> 'declined'
       LEFT JOIN event_guests g ON g.event_id = he.event_id AND g.removed_at IS NULL
      WHERE he.closed_at IS NOT NULL`);
  if (h.noshow_pct !== null) { rate = h.noshow_pct; basis = "set"; words = `Set for this event at ${rate} percent.`; }
  else if (hist.events >= cfg.history_min_events && hist.yes >= cfg.history_min_yes) {
    rate = Math.min(90, Math.round((hist.no_show / hist.yes) * 100)); basis = "history";
    words = `Your own events: ${hist.no_show} of ${hist.yes} said yes and did not come.`;
  }
  const [c] = await q<{ yes: number; attended: number; reg: number }>(
    "SELECT count(*) FILTER (WHERE status IN ('registered', 'attended', 'no_show') AND source <> 'walk_in')::int AS yes, count(*) FILTER (WHERE status = 'attended')::int AS attended, count(*) FILTER (WHERE status = 'registered')::int AS reg FROM event_guests WHERE event_id = $1 AND removed_at IS NULL", [ev.id]);
  const pct = Math.min(90, rate);
  return { rate_pct: rate, basis, yes: c.yes, expected_attending: h.closed_at ? c.attended : Math.round((c.reg * (100 - pct)) / 100), confirm_to_fill: cap === null ? null : Math.ceil((cap * 100) / (100 - pct)), capacity: cap, words };
}

/* ------------------------------------------------------------------ the venue and the co-host */

export interface VenueInput {
  name?: string; address?: string; budget_line_id?: string | null; minimum_spend_cents?: number | null; guarantee_headcount?: number | null; guarantee_by?: string | null; guarantee_confirmed?: boolean; note?: string;
  steps?: { id?: string; by_date?: string; rule?: string; fee_cents?: number | null; done?: boolean }[];
}
const ymd = (v: unknown, what: string) => { if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new HostedInvalid(`Give ${what} as a date.`); return v; };
const wholeOrNull = (v: unknown, what: string) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new HostedInvalid(`Give ${what} as a whole number, zero or more.`);
  return v;
};

/** Saves the venue with its cancellation steps (replaced as a set). The minimum spend is a field of an existing budget line of category dinners or other: it adds nothing to the plan's total. */
export async function putVenue(db: Db, deps: HostedDeps, actor: string, eventId: string, input: VenueInput) {
  const now = nowOf(deps);
  return db.tx(async (q) => {
    const ev = await hostedEvent(q, eventId);
    const [old] = await q<{ guarantee_confirmed_on: string | null }>("SELECT guarantee_confirmed_on::text AS guarantee_confirmed_on FROM event_venues WHERE event_id = $1", [eventId]);
    let line: string | null = null;
    if (input.budget_line_id) {
      const [l] = await q<{ id: string; category: string }>("SELECT id, category FROM budget_lines WHERE id = $1 AND event_id = $2", [input.budget_line_id, eventId]);
      if (!l) throw new HostedInvalid("That budget line is not on this event's plan.");
      if (l.category !== "dinners" && l.category !== "other") throw new HostedInvalid("The venue sits on a dinners line or an other line.");
      line = l.id;
    }
    const by = input.guarantee_by ? ymd(input.guarantee_by, "the guarantee day") : null;
    const confirmed = input.guarantee_confirmed === undefined ? old?.guarantee_confirmed_on ?? null : input.guarantee_confirmed ? old?.guarantee_confirmed_on ?? dayIn(now, ev.zone) : null;
    await q(
      `INSERT INTO event_venues (event_id, name, address, budget_line_id, minimum_spend_cents, guarantee_headcount, guarantee_by, guarantee_confirmed_on, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (event_id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, budget_line_id = EXCLUDED.budget_line_id, minimum_spend_cents = EXCLUDED.minimum_spend_cents,
         guarantee_headcount = EXCLUDED.guarantee_headcount, guarantee_by = EXCLUDED.guarantee_by, guarantee_confirmed_on = EXCLUDED.guarantee_confirmed_on, note = EXCLUDED.note`,
      [eventId, text(input.name).slice(0, 160), text(input.address).slice(0, 300), line, wholeOrNull(input.minimum_spend_cents, "the minimum spend"), wholeOrNull(input.guarantee_headcount, "the headcount guarantee"), by, confirmed, text(input.note).slice(0, 600)]);
    if (input.steps !== undefined) {
      if (!Array.isArray(input.steps) || input.steps.length > 20) throw new HostedInvalid("A venue has up to 20 cancellation steps.");
      await q("DELETE FROM venue_cancellation_steps WHERE event_id = $1", [eventId]);
      for (const [i, s] of input.steps.entries()) {
        const rule = text(s.rule);
        if (!rule) throw new HostedInvalid("Each cancellation step says what happens.");
        await q("INSERT INTO venue_cancellation_steps (id, event_id, position, by_date, rule, fee_cents, done) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [s.id && /^vcs_/.test(s.id) ? s.id : newId("vcs"), eventId, i, ymd(s.by_date, "the step's day"), rule.slice(0, 200), wholeOrNull(s.fee_cents, "the fee"), s.done === true]);
      }
    }
    void actor;
    return { event_id: eventId };
  });
}

export async function venueView(q: Q, ev: HostedEvent, est: Estimate, registered: number, today: string) {
  const [v] = await q<{ name: string; address: string; budget_line_id: string | null; minimum_spend_cents: number | null; guarantee_headcount: number | null; guarantee_by: string | null; guarantee_confirmed_on: string | null; note: string }>(
    "SELECT name, address, budget_line_id, minimum_spend_cents::float8 AS minimum_spend_cents, guarantee_headcount, guarantee_by::text AS guarantee_by, guarantee_confirmed_on::text AS guarantee_confirmed_on, note FROM event_venues WHERE event_id = $1", [ev.id]);
  if (!v) return null;
  const steps = await q<{ id: string; position: number; by_date: string; rule: string; fee_cents: number | null; done: boolean }>("SELECT id, position, by_date::text AS by_date, rule, fee_cents::float8 AS fee_cents, done FROM venue_cancellation_steps WHERE event_id = $1 ORDER BY by_date, position, id", [ev.id]);
  const dates: { date: string; label: string; kind: "guarantee" | "cancellation" }[] = [];
  if (v.guarantee_by && !v.guarantee_confirmed_on) dates.push({ date: v.guarantee_by, label: "Headcount guarantee to the venue", kind: "guarantee" });
  for (const s of steps) if (!s.done) dates.push({ date: s.by_date, label: `Venue cancellation: ${s.rule}`, kind: "cancellation" });
  dates.sort((a, b) => a.date.localeCompare(b.date));
  const next = dates[0] ? { ...dates[0], days_away: daysBetween(today, dates[0].date), words: daysBetween(today, dates[0].date) < 0 ? `${-daysBetween(today, dates[0].date)} days late` : daysBetween(today, dates[0].date) === 0 ? "Today" : `In ${daysBetween(today, dates[0].date)} days` } : null;
  const [line] = v.budget_line_id ? await q<{ id: string; label: string; category: string; planned_cents: number }>("SELECT id, label, category, planned_cents::float8 AS planned_cents FROM budget_lines WHERE id = $1", [v.budget_line_id]) : [];
  const guarantee = v.guarantee_headcount !== null && v.guarantee_by ? `, guarantee ${v.guarantee_headcount} by ${shortDay(v.guarantee_by)}` : "";
  return {
    ...v, steps, next_date: next, budget_line: line ?? null,
    line: `Registered ${registered}, expected ${est.expected_attending} at ${est.rate_pct} percent${guarantee}`,
  };
}

export const LEAD_RULES = ["own_invites", "by_account", "partner_keeps_theirs"] as const;
export const LEAD_WORDS: Record<(typeof LEAD_RULES)[number], string> = { own_invites: "Each side keeps the guests it invited", by_account: "The side that owns the account keeps all its guests", partner_keeps_theirs: "The partner keeps theirs; ours stay ours" };

export async function putCohost(db: Db, actor: string, eventId: string, input: { partner?: string; our_share_percent?: number; lead_rule?: string; note?: string }) {
  void actor;
  return db.tx(async (q) => {
    await hostedEvent(q, eventId);
    const share = input.our_share_percent ?? 50;
    if (typeof share !== "number" || !Number.isInteger(share) || share < 0 || share > 100) throw new HostedInvalid("Our share is a whole number from 0 to 100 percent.");
    const rule = input.lead_rule ?? "own_invites";
    if (!(LEAD_RULES as readonly string[]).includes(rule)) throw new HostedInvalid(`The lead rule is one of: ${LEAD_RULES.join(", ")}.`);
    const partner = text(input.partner);
    if (!partner) throw new HostedInvalid("Name the partner.");
    await q(`INSERT INTO cohosts (event_id, partner, our_share_percent, lead_rule, note) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (event_id) DO UPDATE SET partner = EXCLUDED.partner, our_share_percent = EXCLUDED.our_share_percent, lead_rule = EXCLUDED.lead_rule, note = EXCLUDED.note`, [eventId, partner.slice(0, 120), share, rule, text(input.note).slice(0, 600)]);
    return { event_id: eventId };
  });
}

export async function cohostView(db: Db, eventId: string) {
  const [c] = await db.query<{ partner: string; our_share_percent: number; lead_rule: (typeof LEAD_RULES)[number]; note: string }>("SELECT partner, our_share_percent, lead_rule, note FROM cohosts WHERE event_id = $1", [eventId]);
  if (!c) return null;
  const cost = await eventCost(db, eventId);
  return { ...c, lead_rule_words: LEAD_WORDS[c.lead_rule], cost_cents: cost.total_cents, our_share_cents: Math.round((cost.total_cents * c.our_share_percent) / 100) };
}

/* ------------------------------------------------------------------ the guest, as the page reads it */

async function lastInvites(q: Q, eventId: string) {
  const rows = await q<{ guest_id: string; sent_by: string; sent_on: string; mailbox: string }>(
    "SELECT DISTINCT ON (guest_id) guest_id, sent_by, sent_on::text AS sent_on, mailbox FROM guest_invitations WHERE event_id = $1 ORDER BY guest_id, sent_on DESC, logged_at DESC", [eventId]);
  return new Map(rows.map((r) => [r.guest_id, r]));
}

export interface GuestOut extends Omit<GuestRow, "rsvp_token" | "prior_status" | "removed_at" | "removed_reason" | "event_id"> {
  rsvp_token?: string; status_word: string; invited_words: string | null; last_invitation: { sent_on: string; sent_by: string; mailbox: string } | null; can_email: boolean; email_block: string | null; can_write: boolean; account_name: string | null;
}

async function guestOut(q: Q, g: GuestRow, invite: { sent_on: string; sent_by: string; mailbox: string } | undefined, actor: string, canWrite: boolean): Promise<GuestOut> {
  const { rsvp_token, prior_status: _p, removed_at: _r, removed_reason: _rr, event_id: _e, ...rest } = g;
  const block = await mailBlock(q, g);
  const mine = canWrite || g.owner === actor;
  return {
    ...rest, ...(mine ? { rsvp_token } : {}), status_word: STATUS_WORDS[g.status],
    invited_words: invite ? `Invited ${shortDay(invite.sent_on)} by ${firstName(invite.sent_by)}` : g.invited_at ? `Invited ${shortDay(g.invited_at.slice(0, 10))}` : null,
    last_invitation: invite ?? null, can_email: !block, email_block: block?.reason ?? null, can_write: mine, account_name: null,
  };
}

export interface Flags { money: boolean; can_write: boolean; can_check_in: boolean }

/** The whole hosted page: guests with statuses, counts, estimate, venue, co-host and reminder state. A rep reads it through forRep and the free-text filter. */
export async function hostedView(db: Db, deps: HostedDeps, eventId: string, actor: string, flags: Flags) {
  const now = nowOf(deps);
  const ev = await hostedEvent(db.query, eventId);
  const h = await readHosted(db.query, eventId);
  const today = dayIn(now, ev.zone);
  const guestRows = await db.query<GuestRow>(`SELECT ${GUEST_COLS} FROM event_guests WHERE event_id = $1 AND removed_at IS NULL ORDER BY lower(name), id`, [eventId]);
  const invites = await lastInvites(db.query, eventId);
  const names = new Map((await db.query<{ id: string; name: string }>("SELECT id, name FROM target_accounts")).map((a) => [a.id, a.name]));
  const guests: GuestOut[] = [];
  for (const g of guestRows) guests.push({ ...(await guestOut(db.query, g, invites.get(g.id), actor, flags.can_write)), account_name: g.account_id ? names.get(g.account_id) ?? null : null });
  const n = (s: string) => guests.filter((g) => g.status === s).length;
  const est = await noshowEstimate(db.query, ev, h);
  const registered = n("registered"), cap = capacityOf(h, ev);
  const counts = {
    total: guests.length, listed: n("listed"), invited: n("invited"), registered, waitlist: n("waitlist"), declined: n("declined"), attended: n("attended"), no_show: n("no_show"),
    walk_ins: guests.filter((g) => g.source === "walk_in").length, capacity: cap, over_capacity: cap !== null && registered > cap, in: n("attended"), expected: est.expected_attending,
    answered: registered + n("waitlist") + n("declined"),
  };
  const venue = await venueView(db.query, ev, est, registered, today);
  const cohost = await cohostView(db, eventId);
  const reminders = await reminderPreview(db, eventId, "reminder", { live: deps.live, hasSender: Boolean(deps.sender) });
  const hosts = (await db.query<{ person: string }>("SELECT person FROM event_people WHERE event_id = $1 AND removed_at IS NULL AND 'host' = ANY(roles) ORDER BY created_at, id", [eventId])).map((p) => p.person);
  const next = guests.find((g) => g.status === "listed" && g.can_email) ?? null;
  const [lastRun] = await db.query<{ id: string; kind: string; created_at: string; sent_count: number; skipped: unknown }>("SELECT id, kind, created_at::text AS created_at, sent_count, skipped FROM reminder_runs WHERE event_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [eventId]);
  const cost = flags.money ? await eventCost(db, eventId) : null;
  const view = {
    event: {
      id: ev.id, name: ev.name, starts_on: ev.starts_on, last_day: ev.last_day, venue: ev.venue, country: ev.country, stage: ev.stage, format: ev.format, format_words: HOSTED_WORDS[ev.format as HostedFormat] ?? "Hosted",
      webinar: ev.webinar, conference_event_id: ev.conference_event_id, today, day_began: today >= ev.starts_on, closed_at: h.closed_at, hosts,
    },
    settings: {
      capacity: h.capacity, capacity_effective: cap, capacity_words: cap === null ? "No limit set" : `${cap} places`, noshow_pct: h.noshow_pct, host_name: h.host_name, host_email: h.host_email, doors_at: h.doors_at, address: h.address,
      welcome: h.welcome, rsvp_open: h.rsvp_open,
    },
    can_write: flags.can_write, can_check_in: flags.can_check_in, can_see_money: flags.money,
    empty: guests.length === 0, empty_words: guests.length === 0 ? "No guests yet" : null,
    guests, counts, estimate: est, venue, cohost,
    reminders: { can_send: reminders.can_send, refusal: reminders.refusal, audience_count: reminders.count, skipped: reminders.skipped, last_run: lastRun ?? null },
    primary: next ? { action: "invite", guest_id: next.id, name: next.name } : registered > 0 && !ev.webinar ? { action: "remind", guest_id: null, name: null } : { action: "none", guest_id: null, name: null },
    ...(cost ? { cost: { total_cents: cost.total_cents, per_attendee_cents: counts.attended ? Math.round(cost.total_cents / counts.attended) : null } } : {}),
  };
  return flags.money ? view : asRep(view);
}

/* ------------------------------------------------------------------ after the event */

export const FOLLOW_UP_WORDING = {
  attended: "Hi {first_name},\n\nThank you for coming to {event}. It was good to have you there. If any of what we talked about is worth a longer conversation, tell me when suits you.\n\n{owner}",
  no_show: "Hi {first_name},\n\nWe missed you at {event}. If you would still like to talk, tell me when suits you and I will make the time.\n\n{owner}",
} as const;

const wording = (kind: "attended" | "no_show", g: { name: string; owner: string }, event: string) =>
  FOLLOW_UP_WORDING[kind].replaceAll("{first_name}", firstName(g.name)).replaceAll("{event}", event).replaceAll("{owner}", firstName(g.owner));

/** Which side follows up a guest, by the co-host's lead rule. by_account: the side that owns the account keeps all of its guests; ours when any guest of that account is ours. */
function sideFollows(rule: (typeof LEAD_RULES)[number] | null, g: GuestRow, all: GuestRow[]): "us" | "partner" {
  if (!rule || rule !== "by_account") return g.side;
  const key = (x: GuestRow) => (x.account_id ? `a:${x.account_id}` : x.company ? `c:${x.company.toLowerCase()}` : `g:${x.id}`);
  const k = key(g);
  return all.some((x) => key(x) === k && x.side === "us") ? "us" : "partner";
}

/** The two follow-up groups, attended and no-show, each with its owners and the host's notes and the fixed wording. Waitlist and no-answer are shown apart and followed up as neither. */
export async function followUp(db: Db, deps: HostedDeps, eventId: string, flags: Pick<Flags, "money">) {
  const ev = await hostedEvent(db.query, eventId);
  const h = await readHosted(db.query, eventId);
  const rows = await db.query<GuestRow>(`SELECT ${GUEST_COLS} FROM event_guests WHERE event_id = $1 AND removed_at IS NULL ORDER BY lower(name), id`, [eventId]);
  const co = await cohostView(db, eventId);
  const rule = co?.lead_rule ?? null;
  const out = (g: GuestRow, kind: "attended" | "no_show" | null) => ({
    id: g.id, name: g.name, company: g.company, title: g.title, owner: g.owner, side: g.side, follows_up: sideFollows(rule, g, rows), status: g.status, status_word: STATUS_WORDS[g.status], notes: g.notes, source: g.source,
    text: kind ? wording(kind, g, ev.name) : null,
  });
  const group = (kind: "attended" | "no_show") => { const gs = rows.filter((g) => g.status === kind).map((g) => out(g, kind)); return { count: gs.length, wording: FOLLOW_UP_WORDING[kind], guests: gs }; };
  const unanswered = rows.filter((g) => g.status === "listed" || g.status === "invited").map((g) => out(g, null));
  const waiting = rows.filter((g) => g.status === "waitlist").map((g) => out(g, null));
  const cost = flags.money ? await eventCost(db, eventId) : null;
  const attended = rows.filter((g) => g.status === "attended").length;
  const view = {
    event: { id: ev.id, name: ev.name, starts_on: ev.starts_on, closed_at: h.closed_at },
    closed: Boolean(h.closed_at), registered_pending: rows.filter((g) => g.status === "registered").length,
    attended: group("attended"), no_show: group("no_show"),
    did_not_answer: { count: unanswered.length, guests: unanswered }, waitlist: { count: waiting.length, guests: waiting }, declined: { count: rows.filter((g) => g.status === "declined").length },
    attendance: { came: attended, walk_ins: rows.filter((g) => g.source === "walk_in").length, said_yes: rows.filter((g) => ["registered", "attended", "no_show"].includes(g.status) && g.source !== "walk_in").length },
    cohost: co ? { ...co, lead_rule_words: LEAD_WORDS[co.lead_rule] } : null,
    ...(cost ? { cost: { total_cents: cost.total_cents, per_attendee_cents: attended ? Math.round(cost.total_cents / attended) : null } } : {}),
  };
  void deps;
  return flags.money ? view : asRep(view);
}

/** A person's own guests across events: status, notes and the follow-up group. `GET /api/hosted/mine`. */
export async function myGuests(db: Db, actor: string, flags: Pick<Flags, "money">) {
  const own = await db.query<GuestRow>(`SELECT ${GUEST_COLS} FROM event_guests WHERE owner = $1 AND removed_at IS NULL ORDER BY lower(name), id`, [actor]);
  const evs = new Map((await db.query<{ id: string; name: string; starts_on: string; closed_at: string | null }>(
    `SELECT e.id, e.name, e.starts_on::text AS starts_on, h.closed_at::text AS closed_at FROM events e JOIN involvements i ON i.event_id = e.id AND i.kind = 'hosted' AND i.status <> 'dropped'
       LEFT JOIN hosted_events h ON h.event_id = e.id WHERE e.id = ANY($1::text[]) AND e.stage <> 'declined'`, [[...new Set(own.map((g) => g.event_id))]])).map((e) => [e.id, e]));
  const rows = own.filter((g) => evs.has(g.event_id)).map((g) => ({ ...g, event_name: evs.get(g.event_id)!.name, starts_on: evs.get(g.event_id)!.starts_on, closed_at: evs.get(g.event_id)!.closed_at }))
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on) || a.name.localeCompare(b.name));
  const guests = rows.map((g) => ({
    id: g.id, event_id: g.event_id, event_name: g.event_name, starts_on: g.starts_on, name: g.name, company: g.company, status: g.status, status_word: STATUS_WORDS[g.status], notes: g.notes, side: g.side,
    group: g.status === "attended" ? "attended" : g.status === "no_show" ? "no_show" : g.status === "listed" || g.status === "invited" ? "did_not_answer" : g.status, closed: Boolean(g.closed_at),
    ...(g.status === "attended" || g.status === "no_show" ? { text: wording(g.status, g, g.event_name) } : {}),
  }));
  const view = { guests, count: guests.length };
  return flags.money ? view : asRep(view);
}

/* ------------------------------------------------------------------ who to add */

export interface ConferenceSuggestion { company_id: string; name: string; owner: string | null; owner_decision: string | null; owner_words: string; can_add_by: string | null }

/** Target accounts with an open deal or an owner that are not on the list, with their owner; and, for an event that hangs off a conference, that conference's tier 1 companies (a suggestion list only). */
export async function suggestions(db: Db, eventId: string) {
  const ev = await hostedEvent(db.query, eventId);
  const accounts = await db.query<{ id: string; name: string; domain: string | null; country: string | null; owner: string | null; open_deal: string | null; deal_stage: string | null }>(
    `SELECT t.id, t.name, t.domain, t.country, t.owner, t.open_deal, t.deal_stage FROM target_accounts t
      WHERE (t.open_deal IS NOT NULL OR t.owner IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM event_guests g WHERE g.event_id = $1 AND g.removed_at IS NULL AND (g.account_id = t.id OR lower(g.company) = lower(t.name)))
      ORDER BY (t.open_deal IS NULL), lower(t.name)`, [eventId]);
  let conference: ConferenceSuggestion[] = [];
  if (ev.conference_event_id) {
    const rows = await db.query<{ id: string; name: string; owner: string | null; status: string | null; decided_by: string | null }>(
      `SELECT co.id, co.name, co.account_owner AS owner, d.status, d.owner AS decided_by FROM companies co LEFT JOIN owner_decisions d ON d.event_id = co.event_id AND d.company_id = co.id
        WHERE co.event_id = $1 AND co.tier = 1
          AND NOT EXISTS (SELECT 1 FROM event_guests g WHERE g.event_id = $2 AND g.removed_at IS NULL AND lower(g.company) = lower(co.name)) ORDER BY lower(co.name)`, [ev.conference_event_id, eventId]);
    const words: Record<string, string> = { mine: "Owner has it", include: "Owner agreed", handed: "Handed over", pending: "Owner has not said" };
    conference = rows.map((r) => ({ company_id: r.id, name: r.name, owner: r.owner, owner_decision: r.status, owner_words: r.status ? words[r.status] : r.owner ? "Owner has not said" : "No owner", can_add_by: r.status === "mine" ? r.owner : null }));
  }
  return { accounts, conference };
}

/** A conference company the owner kept is added only by that owner. */
export async function conferenceOwnerGateFor(db: Db, eventId: string, companyName: string, actor: string) {
  const ev = await hostedEvent(db.query, eventId);
  if (!ev.conference_event_id) return;
  const [r] = await db.query<{ owner: string | null; status: string | null }>(
    "SELECT co.account_owner AS owner, d.status FROM companies co LEFT JOIN owner_decisions d ON d.event_id = co.event_id AND d.company_id = co.id WHERE co.event_id = $1 AND lower(co.name) = lower($2) LIMIT 1", [ev.conference_event_id, companyName]);
  if (r?.status === "mine" && r.owner && r.owner !== actor) throw new RuleError(`${r.owner} has this account. They add their own guests.`);
}

