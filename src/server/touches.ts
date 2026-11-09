/* The touch log and holds (docs/LIFECYCLE.md, section 6). A hold's expiry never restarts anyone: it only makes them eligible, and a resume still passes the gate. */

import type { Db } from "./db.ts";
import { newId } from "./events.ts";

type Q = Db["query"];

export interface Touch { domain: string | null; person_id?: string | null; contact_id?: string | null; event_id: string | null; kind: string; channel?: string | null; reason?: string; at?: Date | string; source: string; dedup_key: string }

/** True when this is the first time the touch was seen. A replayed event writes nothing. */
export async function addTouch(q: Q, t: Touch) {
  const rows = await q(
    `INSERT INTO touches (id, domain, person_id, contact_id, event_id, kind, channel, reason, at, source, dedup_key) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()), $10, $11)
     ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    [newId("tch"), t.domain, t.person_id ?? null, t.contact_id ?? null, t.event_id, t.kind, t.channel ?? null, t.reason ?? "", t.at ? new Date(t.at).toISOString() : null, t.source, t.dedup_key]);
  return rows.length > 0;
}

export interface HoldInput { domain: string; person_id?: string | null; event_id?: string | null; cause: "meeting" | "mine" | "live_thread"; cause_id: string; expires_at: Date }

/** One hold per cause and domain. Setting it again moves its expiry and reopens it. */
export const addHold = (q: Q, h: HoldInput) => q(
  `INSERT INTO holds (id, domain, person_id, event_id, cause, cause_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
   ON CONFLICT (cause, cause_id, domain) DO UPDATE SET expires_at = EXCLUDED.expires_at, released_at = NULL, released_by = NULL`,
  [newId("hld"), h.domain, h.person_id ?? null, h.event_id ?? null, h.cause, h.cause_id, h.expires_at.toISOString()]);

export const releaseHold = (q: Q, cause: string, causeId: string, actor: string) =>
  q("UPDATE holds SET released_at = now(), released_by = $3 WHERE cause = $1 AND cause_id = $2 AND released_at IS NULL", [cause, causeId, actor]);

/** Holds that apply to this person on this event now. */
export const activeHolds = (q: Q, a: { domain: string; person_id: string | null; event_id: string; now: Date }) => q<{ id: string; cause: string; expires_at: string }>(
  `SELECT id, cause, expires_at::text AS expires_at FROM holds
   WHERE domain = $1 AND released_at IS NULL AND expires_at > $4::timestamptz
     AND (person_id IS NULL OR person_id = $2) AND (event_id IS NULL OR event_id = $3)
   ORDER BY expires_at DESC`, [a.domain, a.person_id, a.event_id, a.now.toISOString()]);

/** The event to credit for a reply or meeting: whose sequence sent the last message, else the most recent event the person was on the list for. */
export async function creditedEvent(q: Q, a: { contact_id: string | null; person_id: string | null; domain: string | null }): Promise<string | null> {
  const [sent] = await q<{ event_id: string }>(
    `SELECT event_id FROM touches WHERE kind = 'send' AND event_id IS NOT NULL AND ((person_id IS NOT NULL AND person_id = $1) OR (contact_id IS NOT NULL AND contact_id = $2)) ORDER BY at DESC, id DESC LIMIT 1`, [a.person_id, a.contact_id]);
  if (sent) return sent.event_id;
  const [on] = await q<{ event_id: string }>(
    `SELECT k.event_id FROM contacts k JOIN events e ON e.id = k.event_id WHERE (k.id = $1 OR (k.person_id IS NOT NULL AND k.person_id = $2)) ORDER BY e.created_at DESC, k.id LIMIT 1`, [a.contact_id, a.person_id]);
  return on?.event_id ?? null;
}
