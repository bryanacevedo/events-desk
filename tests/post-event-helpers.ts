/* Shared by the post-event tests: launching the pre-event sequences, and reading who went where. */

import type { Db } from "../src/server/db.ts";
import { attachCampaign, confirmLaunchChecklist, createDrafts, drainOps, observeSequences } from "../src/server/sequences.ts";
import { MAYA, type Harness } from "./lifecycle-harness.ts";

/** Sets up, attaches and launches every pre-event sequence, the way a person would. */
export async function launched(db: Db, h: Harness) {
  const seqOf = async (channel: string) => (await db.query<{ id: string; external_id: string }>("SELECT id, external_id FROM sequences WHERE event_id = $1 AND channel = $2 ORDER BY created_at LIMIT 1", [h.id, channel]))[0];
  await createDrafts(db, h.deps, h.id, MAYA);
  await attachCampaign(db, h.deps, (await seqOf("linkedin")).id, h.li.newSeq(), MAYA);
  for (const s of await db.query<{ id: string }>("SELECT id FROM sequences WHERE event_id = $1", [h.id])) await confirmLaunchChecklist(db, s.id, MAYA);
  const e = await seqOf("email"), l = await seqOf("linkedin");
  h.email.launch(e.external_id); h.li.launch(l.external_id);
  await observeSequences(db, h.deps); await drainOps(db, h.deps);
  return { e, l };
}

/** Who is in a post-event sequence on this channel, with the sequence's group and template. */
export const sequenced = (db: Db, eventId: string, channel: string) => db.query<{ contact_id: string; priority: string; template: string }>(
  `SELECT n.contact_id, s.priority, t.name AS template FROM enrollments n JOIN sequences s ON s.id = n.sequence_id JOIN sequence_templates t ON t.id = s.template_id
   WHERE n.event_id = $1 AND s.channel = $2 AND s.phase = 'post' AND n.state <> 'removed'`, [eventId, channel]);
