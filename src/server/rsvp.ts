/* The public RSVP link (docs/HOSTED.md 6 and 21.19). One link per guest, 24 random bytes. It needs no actor and no write key, so it answers only about the guest it names:
   the event's name, day, doors time, venue and address, the host's name, the welcome line, the guest's own first name, status and dietary note, and whether the list is open.
   It never carries another guest, the owner, the account, the company, an id, a count or a dollar. A bad token of any kind answers the same 404 with one indexed lookup. */

import type { Context, Hono } from "hono";
import type { Db } from "./db.ts";
import { RuleError } from "./events.ts";
import { capacityOf, dayIn, firstName, flushOutbox, GUEST_COLS, hostedEvent, HostedInvalid, logGuest, lockHosted, nowOf, promoteFirst, readHosted, registeredCount, text, type GuestRow, type HostedDeps } from "./hosted.ts";
import { REFUSAL, transition, type GuestStatus } from "../shared/rsvp.ts";

/** Anything that is not a base64url token of a sane length is looked up as "-", so a malformed token still costs the one indexed lookup and never reaches the database as a bad string. */
const SAFE = /^[A-Za-z0-9_-]{1,64}$/;
export const BAD_LINK = "This link is not valid.";
export class BadToken extends Error {}

/** The event a guest's link belongs to. A link whose event is no longer hosted is as dead as any bad token: the same 404. */
async function hostedOf(q: Db["query"], eventId: string) {
  try { return await hostedEvent(q, eventId); }
  catch (e) { if (e instanceof RuleError) throw new BadToken(BAD_LINK); throw e; }
}

/** The one row a token names, or a BadToken. The lookup is keyed on the token alone. */
async function byToken(q: Db["query"], token: string, lock = false): Promise<GuestRow> {
  const [g] = await q<GuestRow>(`SELECT ${GUEST_COLS} FROM event_guests WHERE rsvp_token = $1 AND removed_at IS NULL${lock ? " FOR UPDATE" : ""}`, [SAFE.test(String(token)) ? String(token) : "-"]);
  if (!g) throw new BadToken(BAD_LINK);
  return g;
}

export interface PublicRsvp {
  event: { name: string; day: string; doors_at: string | null; venue_name: string; address: string; host_name: string; welcome: string };
  guest: { first_name: string; status: GuestStatus; dietary: string };
  /** The list takes new yes answers. */
  list_open: boolean;
  /** A yes or a no may be given now. False once the day began, for a webinar, or after the door closed. */
  can_answer: boolean;
  /** One sentence for the page when the answer cannot be given. */
  message: string | null;
}

async function viewOf(q: Db["query"], g: GuestRow, now: Date): Promise<PublicRsvp> {
  const ev = await hostedOf(q, g.event_id);
  const h = await readHosted(q, g.event_id);
  const [v] = await q<{ name: string; address: string }>("SELECT name, address FROM event_venues WHERE event_id = $1", [g.event_id]);
  const began = dayIn(now, ev.zone) >= ev.starts_on;
  const cap = capacityOf(h, ev);
  const full = cap !== null && (await registeredCount(q, g.event_id)) >= cap;
  const answered = g.status === "attended" || g.status === "no_show";
  const declined = ev.stage === "declined";
  const open = h.rsvp_open && !full && !declined;
  let message: string | null = null;
  if (ev.webinar) message = "This event takes registrations from the organizer, not here.";
  else if (declined) message = REFUSAL.passed;
  else if (answered || began) message = began ? REFUSAL.passed : "Your answer is closed.";
  else if (!open && g.status !== "registered" && g.status !== "waitlist") message = "The list is full. You can still tell us you cannot come.";
  return {
    event: { name: ev.name, day: ev.starts_on, doors_at: h.doors_at, venue_name: v?.name || ev.venue, address: h.address || v?.address || "", host_name: h.host_name, welcome: h.welcome },
    guest: { first_name: firstName(g.name), status: g.status, dietary: g.dietary },
    list_open: open,
    can_answer: !ev.webinar && !answered && !began && !declined,
    message,
  };
}

export async function rsvpView(db: Db, token: string, now: Date = new Date()): Promise<PublicRsvp> {
  return viewOf(db.query, await byToken(db.query, token), now);
}

export interface RsvpAnswer { answer?: unknown; dietary?: unknown; note?: unknown }

/** Records a yes or a no from the guest. Under the event's row lock: the room is counted and the place taken in one step, and a no from a registered guest moves the first waitlisted guest up. */
export async function answerRsvp(db: Db, deps: HostedDeps, token: string, body: RsvpAnswer): Promise<PublicRsvp> {
  const now = nowOf(deps);
  const answer = body.answer;
  if (answer !== "yes" && answer !== "no") throw new HostedInvalid("Answer yes or no.");
  const dietary = text(body.dietary), note = text(body.note);
  if (dietary.length > 300 || note.length > 300) throw new HostedInvalid("Keep each note to 300 characters.");
  const ids: (string | null)[] = [];
  const view = await db.tx(async (q) => {
    const peek = await byToken(q, token);
    const ev = await hostedOf(q, peek.event_id);
    if (ev.webinar) throw new RuleError("This event takes registrations from the organizer, not here.");
    const h = await lockHosted(q, peek.event_id);
    const g = await byToken(q, token, true);
    if (ev.stage === "declined") throw new RuleError(REFUSAL.passed);
    if (g.status === "attended" || g.status === "no_show") throw new RuleError("Your answer is closed.");
    const dayBegan = dayIn(now, ev.zone) >= ev.starts_on;
    const cap = capacityOf(h, ev);
    if (answer === "yes") {
      const already = g.status === "registered" || g.status === "waitlist";
      if (!already && !h.rsvp_open) throw new RuleError(REFUSAL.full);
      const reg = await registeredCount(q, ev.id);
      const atCapacity = cap !== null && reg >= cap;
      const to: GuestStatus = already ? g.status : atCapacity ? "waitlist" : "registered";
      const err = transition(g.status, to, { by: "guest", atCapacity, dayBegan });
      if (err) throw new RuleError(err);
      if (!already) {
        await q("UPDATE event_guests SET status = $2, rsvp_at = $3, waitlisted_at = $4, dietary = $5, decline_note = '' WHERE id = $1", [g.id, to, now.toISOString(), to === "waitlist" ? now.toISOString() : null, dietary]);
        await logGuest(q, ev.id, g.id, "status", to === "waitlist" ? "Said yes and went on the waitlist" : "Said yes and registered", "guest", now);
      } else {
        await q("UPDATE event_guests SET dietary = $2 WHERE id = $1", [g.id, dietary]);
        await logGuest(q, ev.id, g.id, "status", "Changed the dietary note", "guest", now);
      }
    } else {
      if (g.status === "declined") await q("UPDATE event_guests SET decline_note = $2 WHERE id = $1", [g.id, note]);
      else {
        const err = transition(g.status, "declined", { by: "guest" });
        if (err) throw new RuleError(err);
        await q("UPDATE event_guests SET status = 'declined', rsvp_at = $2, waitlisted_at = NULL, decline_note = $3 WHERE id = $1", [g.id, now.toISOString(), note]);
        await logGuest(q, ev.id, g.id, "status", "Said no", "guest", now);
        if (g.status === "registered") ids.push((await promoteFirst(q, ev, h, "guest", now))?.outbox ?? null);
      }
    }
    return viewOf(q, await byToken(q, token), now);
  });
  await flushOutbox(db, deps, ids);
  return view;
}

/* ------------------------------------------------------------------ the routes and the bad-token limit */

const BAD_PER_MINUTE = 30;
const failures = new Map<string, { n: number; at: number }>();
/** The same key the public demo's write limit uses: the last x-forwarded-for entry, else "local". */
export const addressOf = (c: Context) => (c.req.header("x-forwarded-for") ?? "").split(",").pop()!.trim() || "local";

function overLimit(ip: string, now: number) { const w = failures.get(ip); return Boolean(w && now - w.at < 60_000 && w.n >= BAD_PER_MINUTE); }
function countFailure(ip: string, now: number) {
  const w = failures.get(ip);
  const cur = w && now - w.at < 60_000 ? w : { n: 0, at: now };
  cur.n += 1; failures.set(ip, cur);
  if (failures.size > 5000) for (const [k, v] of failures) if (now - v.at >= 60_000) failures.delete(k);
}
/** Test hook. */
export const resetBadTokens = () => failures.clear();

export function mountRsvp(app: Hono<any>, db: Db, deps: () => HostedDeps) {
  const bad = () => Response.json({ error: BAD_LINK }, { status: 404 });
  const guarded = async (c: Context, fn: () => Promise<PublicRsvp>) => {
    const ip = addressOf(c), t = Date.now();
    if (overLimit(ip, t)) return Response.json({ error: "Too many tries. Wait a minute." }, { status: 429 });
    try { return Response.json(await fn()); }
    catch (e) {
      if (e instanceof BadToken) { countFailure(ip, t); return bad(); }
      if (e instanceof HostedInvalid) return Response.json({ error: e.message }, { status: 400 });
      if (e instanceof RuleError) return Response.json({ error: e.message }, { status: 409 });
      throw e;
    }
  };
  app.get("/api/rsvp/:token", (c) => guarded(c, () => rsvpView(db, c.req.param("token") as string, nowOf(deps()))));
  app.post("/api/rsvp/:token", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as RsvpAnswer;
    return guarded(c, () => answerRsvp(db, deps(), c.req.param("token") as string, body ?? {}));
  });
}
