/* The kit's offers (docs/SPEAKING.md 8). One row per person, event and role, written by whatever makes the offer true, in that write's own transaction.
   An offer holds no image. Firing twice is one row, and a dismissed offer stays dismissed until the person asks again. */

import type { Db } from "./db.ts";
import { logActivity, newId } from "./events.ts";

export const KIT_ROLES = ["attending", "speaking", "sponsoring", "hosting"] as const;
export type KitRole = (typeof KIT_ROLES)[number];
export type KitReason = "seat_approved" | "talk_accepted" | "hosted_confirmed" | "sponsorship_confirmed" | "asked";

export async function offerKit(q: Db["query"], o: { eventId: string; person: string; role: KitRole; reason: KitReason; sourceId?: string | null; actor: string }) {
  const person = o.person.trim();
  if (!person) return false;
  const made = await q<{ id: string }>(
    "INSERT INTO kit_offers (id, event_id, person, role, reason, source_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id, person, role) DO NOTHING RETURNING id",
    [newId("kit"), o.eventId, person, o.role, o.reason, o.sourceId ?? null]);
  if (made.length) await logActivity(q, o.eventId, o.actor, "kit", `A ${o.role === "attending" ? "going" : o.role} kit is ready for ${person}`);
  return made.length > 0;
}

/** Who a confirmed hosted event or sponsorship is offered to: the people on it with the host role, else whoever made the involvement. */
export async function offerForInvolvement(q: Db["query"], eventId: string, involvementId: string, kind: string, actor: string) {
  if (kind !== "hosted" && kind !== "sponsorship") return;
  const role: KitRole = kind === "hosted" ? "hosting" : "sponsoring";
  const reason: KitReason = kind === "hosted" ? "hosted_confirmed" : "sponsorship_confirmed";
  let people = kind === "hosted"
    ? (await q<{ person: string }>("SELECT person FROM event_people WHERE event_id = $1 AND removed_at IS NULL AND 'host' = ANY(roles)", [eventId])).map((r) => r.person)
    : [];
  if (!people.length) people = (await q<{ created_by: string }>("SELECT created_by FROM involvements WHERE id = $1", [involvementId])).map((r) => r.created_by);
  for (const person of people) await offerKit(q, { eventId, person, role, reason, sourceId: involvementId, actor });
}
