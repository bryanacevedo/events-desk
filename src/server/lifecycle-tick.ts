/* One pass over everything with a clock or a queue after delivery. Started on a timer in node.ts; tests call it directly with a chosen time. A step that fails is logged and the rest still run. */

import type { Db } from "./db.ts";
import { closeOut } from "./motion.ts";
import { drainQuietly } from "./crm-outbox.ts";
import { extractDebriefs, integrityCheck, proposeEdits, sendDebriefPrompts, writeScorecards } from "./closeout.ts";
import { nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { meetingReminders } from "./meetings.ts";
import { openOwnerDecisions, ownerSweep, sendOwnerCards } from "./owners.ts";
import { ingestEvents, processInbound } from "./replies.ts";
import { bounceWatch, calendarSweep, drainOps, flagSweep, observeSequences, pauseSequenceById, resumeDue } from "./sequences.ts";
import { senderSweep } from "./sending.ts";

export async function pollTools(db: Db, deps: LifecycleDeps) {
  const since = new Date(nowOf(deps).getTime() - 3 * 86_400_000).toISOString();
  for (const c of Object.values(deps.connectors)) {
    if (c.capabilities.events === "webhook") continue;
    const seqs = await db.query<{ external_id: string }>("SELECT external_id FROM sequences WHERE connector = $1 AND launched_at IS NOT NULL AND state <> 'archived' AND external_id IS NOT NULL", [c.name]);
    if (!seqs.length) continue;
    try { await ingestEvents(db, deps, c, await c.events(since, seqs.map((s) => s.external_id))); }
    catch (e) { console.error("poll", c.name, (e as Error).message); }
  }
}

const quietly = async (name: string, run: () => Promise<unknown>) => { try { await run(); } catch (e) { console.error("lifecycle", name, e); } };

export async function ownerStep(db: Db, deps: LifecycleDeps) {
  for (const e of await db.query<{ id: string }>("SELECT id FROM events WHERE motion IN ('owners', 'sequencing', 'in_market') AND EXISTS (SELECT 1 FROM owner_decisions d WHERE d.event_id = events.id AND d.status = 'pending') OR motion = 'owners'")) {
    await openOwnerDecisions(db, deps, e.id);
    await sendOwnerCards(db, deps, e.id);
    await ownerSweep(db, deps, e.id);
  }
}

export async function lifecycleTick(db: Db, deps: LifecycleDeps, opts: { flags?: boolean; nightly?: boolean } = {}) {
  await quietly("owners", () => ownerStep(db, deps));
  await quietly("observe", () => observeSequences(db, deps));
  await quietly("ops", () => drainOps(db, deps));
  await quietly("poll", () => pollTools(db, deps));
  await quietly("inbound", () => processInbound(db, deps));
  await quietly("resume", () => resumeDue(db, deps));
  if (opts.flags) await quietly("flags", () => flagSweep(db, deps));
  await quietly("bounces", () => bounceWatch(db, deps));
  await quietly("senders", () => senderSweep(db, deps, (id, reason) => pauseSequenceById(db, deps, id, reason)));
  await quietly("reminders", () => meetingReminders(db, deps));
  await quietly("debrief", () => sendDebriefPrompts(db, deps));
  await quietly("extract", () => extractDebriefs(db, deps));
  await quietly("close", () => closeOut(db, deps));
  await quietly("calendar", () => calendarSweep(db, deps));
  await quietly("score", () => writeScorecards(db, deps));
  await quietly("outbox", () => drainQuietly(db, deps.crm));
  if (opts.nightly) { await quietly("learn", () => proposeEdits(db)); await quietly("integrity", () => integrityCheck(db, deps)); }
}
