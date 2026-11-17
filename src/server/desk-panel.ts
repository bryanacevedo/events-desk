/* What the Outreach panel shows when Account Desk runs the outreach (docs/SHARED-WORLD.md 13.6), and the one read Events Desk gives Account Desk.

   Counts come from this desk's own sync table, so they never wait on a network call. The play status is read from Account Desk (`GET <ACCOUNT_DESK_URL>/api/desk/campaigns/<crm campaign>/plays`,
   Bearer ACCOUNT_DESK_READ_KEY), at most once a minute per event, on its own route so the panel never waits for it, and it carries counts only. A failed read keeps the last good one and says so. */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";
import { tracedFetch } from "./telemetry.ts";
import { RuleError } from "./events.ts";
import { LAST_DAY_SQL } from "./motion.ts";

type Env = Record<string, string | undefined>;
export const MEMBER_ORDER = ["targeted", "sent", "responded", "waitlist", "declined", "registered", "no_show", "attended", "met"] as const;
const STATUS_WORDS: Record<string, string> = { targeted: "Targeted", sent: "Sent", responded: "Responded", waitlist: "Waitlist", declined: "Declined", registered: "Registered", no_show: "No show", attended: "Attended", met: "Met" };
export const statusWord = (s: string) => STATUS_WORDS[s] ?? s;

/* ------------------------------------------------------------------ booking link */

/** An http or https address, up to 500 characters, or empty (which clears it). */
export function cleanBookingUrl(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  if (s.length > 500) throw new RuleError("Keep the booking link under 500 characters.");
  let u: URL;
  try { u = new URL(s); } catch { throw new RuleError("That is not a web address. Use one that starts with https:// or http://."); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new RuleError("The booking link starts with https:// or http://.");
  return u.href;
}

export async function setBookingUrl(db: Db, eventId: string, value: unknown) {
  const url = cleanBookingUrl(value);
  const r = await db.query("UPDATE events SET booking_url = $2 WHERE id = $1 AND parent_event_id IS NULL RETURNING id", [eventId, url]);
  if (!r.length) throw new RuleError("That event does not exist.");
  return { booking_url: url };
}

/* ------------------------------------------------------------------ the panel's own data */

export async function panelView(db: Db, eventId: string, env: Env = process.env) {
  const [e] = await db.query<{ booking_url: string | null; crm_campaign_id: string | null }>("SELECT booking_url, crm_campaign_id FROM events WHERE id = $1", [eventId]);
  if (!e) throw new RuleError("That event does not exist.");
  const counts: Record<string, number> = Object.fromEntries(MEMBER_ORDER.map((s) => [s, 0]));
  for (const r of await db.query<{ last: string; n: number }>("SELECT last, count(*)::int AS n FROM crm_sync WHERE kind = 'member' AND ref LIKE $1 GROUP BY last", [`${eventId}:%`])) if (r.last in counts) counts[r.last] = r.n;
  const [held] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM crm_outbox WHERE status = 'held' AND payload->>'event_id' = $1", [eventId]);
  return {
    booking_url: e.booking_url, counts, held: held.n, in_crm: Boolean(e.crm_campaign_id),
    plays_read: Boolean(env.ACCOUNT_DESK_URL && env.ACCOUNT_DESK_READ_KEY && e.crm_campaign_id),
  };
}

/* ------------------------------------------------------------------ play status from Account Desk */

export interface PlayRead { campaign_ref: string; plays: { key: string; name: string; states?: Record<string, number>; people: Record<string, number> }[]; as_of: string }
export interface PlayStatus { state: "ok" | "unavailable" | "off"; lines: string[]; read_at: string | null; last_good_at: string | null }

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; good: { lines: string[]; at: string } | null; status: PlayStatus }>();
export const clearPlayCache = () => cache.clear();

const n = (v: number | undefined) => (typeof v === "number" && v > 0 ? v : 0);
/** One line per play, in words, counts only: "Before the event: 12 in the play, 4 waiting for approval, 1 stopped because they declined". */
export function playLines(read: PlayRead): string[] {
  return read.plays.map((p) => {
    const g = p.people ?? {};
    const total = Object.values(g).reduce((a, v) => a + n(v), 0);
    const stoppedOther = n(g.stopped_other) + Object.entries(g).filter(([k]) => k.startsWith("stopped") && !["stopped_declined_event", "stopped_event_status_moved", "stopped_other"].includes(k)).reduce((a, [, v]) => a + n(v), 0);
    const parts = [
      `${total} in the play`, n(g.pending) && `${n(g.pending)} waiting for approval`, n(g.active) && `${n(g.active)} running`, n(g.paused) && `${n(g.paused)} paused`, n(g.replied) && `${n(g.replied)} replied`, n(g.done) && `${n(g.done)} finished`,
      n(g.stopped_declined_event) && `${n(g.stopped_declined_event)} stopped because they declined`, n(g.stopped_event_status_moved) && `${n(g.stopped_event_status_moved)} stopped because they answered`, stoppedOther && `${stoppedOther} stopped`,
    ].filter(Boolean);
    return `${p.name}: ${parts.join(", ")}`;
  });
}

/** The status, from the cache when it is under a minute old. A failure keeps the last good lines and the time of that read. Never throws. */
export async function playStatus(db: Db, eventId: string, env: Env = process.env, doFetch: typeof fetch = tracedFetch, now: () => number = Date.now): Promise<PlayStatus> {
  const base = env.ACCOUNT_DESK_URL?.trim(), key = env.ACCOUNT_DESK_READ_KEY?.trim();
  const [e] = await db.query<{ crm_campaign_id: string | null }>("SELECT crm_campaign_id FROM events WHERE id = $1", [eventId]);
  if (!base || !key || !e?.crm_campaign_id) return { state: "off", lines: [], read_at: null, last_good_at: null };
  const hit = cache.get(eventId), t = now();
  if (hit && t - hit.at < TTL_MS) return hit.status;
  let status: PlayStatus;
  try {
    const res = await doFetch(`${base.replace(/\/$/, "")}/api/desk/campaigns/${encodeURIComponent(e.crm_campaign_id)}/plays`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(String(res.status));
    const raw = await res.text();
    if (raw.length > 256 * 1024) throw new Error("too large");
    const read = JSON.parse(raw) as PlayRead;
    if (!Array.isArray(read?.plays)) throw new Error("shape");
    const at = new Date(t).toISOString();
    status = { state: "ok", lines: playLines(read), read_at: at, last_good_at: at };
    cache.set(eventId, { at: t, good: { lines: status.lines, at }, status });
  } catch {
    const good = hit?.good ?? null;
    status = { state: "unavailable", lines: good?.lines ?? [], read_at: new Date(t).toISOString(), last_good_at: good?.at ?? null };
    cache.set(eventId, { at: t, good, status });
  }
  return status;
}

/* ------------------------------------------------------------------ the read Account Desk makes of this desk */

const digest = (v: string) => createHash("sha256").update(v).digest();
export const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/** `GET /api/desk/campaigns/<crm campaign id>` with `Authorization: Bearer <DESK_READ_KEY>`: 404 when the key is unset, 401 when it is wrong. The body is about the event and carries no person. */
export async function deskCampaignRead(db: Db, ref: string, header: string | undefined, env: Env = process.env): Promise<{ status: number; body: unknown }> {
  const key = env.DESK_READ_KEY?.trim();
  if (!key) return { status: 404, body: { error: "Not found." } };
  const given = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  if (!given || !same(given, key)) return { status: 401, body: { error: "That key is not accepted." } };
  const [e] = await db.query<{ name: string; starts_on: string; ends_on: string; city: string | null; booking_url: string | null }>(
    `SELECT e.name, e.starts_on::text AS starts_on, (${LAST_DAY_SQL})::text AS ends_on, nullif((SELECT c.city FROM catalog_events c WHERE c.id = e.catalog_id), '') AS city, e.booking_url
     FROM events e WHERE e.crm_campaign_id = $1 AND e.parent_event_id IS NULL`, [ref]);
  if (!e) return { status: 404, body: { error: "No event has that campaign." } };
  return { status: 200, body: { event: e.name, starts_on: e.starts_on, ends_on: e.ends_on, city: e.city, booking_url: e.booking_url } };
}
