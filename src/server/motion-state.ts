/* The one way an event's motion changes. Like moveEvent for stages: there is no route that sets it. */

import type { Db } from "./db.ts";
import { logActivity, RuleError } from "./events.ts";
import { motionError, type Motion } from "../shared/motion.ts";

export async function moveMotion(q: Db["query"], eventId: string, to: Motion, actor: string, detail: string) {
  const [e] = await q<{ motion: Motion; stage: string; parent_event_id: string | null }>("SELECT motion, stage, parent_event_id FROM events WHERE id = $1 FOR UPDATE", [eventId]);
  if (!e) throw new RuleError("That event does not exist.");
  if (e.parent_event_id) throw new RuleError("New registrations have no motion of their own. Their people join the parent event.");
  if (e.stage !== "delivered") throw new RuleError("Only a delivered event has a motion.");
  const err = motionError(e.motion, to);
  if (err) throw new RuleError(err);
  await q("UPDATE events SET motion = $2, motion_changed_at = now(), updated_at = now() WHERE id = $1", [eventId, to]);
  // A "mine" hold lasts until the event is scored.
  if (to === "scored") await q("UPDATE holds SET expires_at = now() WHERE event_id = $1 AND cause = 'mine' AND released_at IS NULL", [eventId]);
  await logActivity(q, eventId, actor, "motion", detail);
}
