/* One pass over everything with a clock or a queue after delivery. Started on a timer in node.ts; tests call it directly with a chosen time. A step that fails is logged and the rest still run. */

import type { Db } from "./db.ts";
import { closeOut } from "./motion.ts";
import { drainQuietly } from "./crm-outbox.ts";
import { extractDebriefs, integrityCheck, proposeEdits, sendDebriefPrompts, writeScorecards } from "./closeout.ts";
import { nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { ingestCrmMeetings, meetingReminders } from "./meetings.ts";
import { openOwnerDecisions, ownerSweep, sendOwnerCards } from "./owners.ts";
import { ingestEvents, processInbound } from "./replies.ts";
import { bounceWatch, calendarSweep, drainOps, flagSweep, observeSequences, pauseSequenceById, resumeDue } from "./sequences.ts";
import { senderSweep } from "./sending.ts";
import { blindSweep, drainNotifications, escalateWaiting, purgeOldBodies, raiseAlert, recordRun } from "./operating.ts";
import { dailyDigest } from "./closeout.ts";

export async function pollTools(db: Db, deps: LifecycleDeps) {
  const since = new Date(nowOf(deps).getTime() - 3 * 86_400_000).toISOString();
  for (const c of Object.values(deps.connectors)) {
    if (c.capabilities.events === "webhook") continue;
    // A campaign that ended still gets replies, and "remove me" can come late: they are read for 30 days after.
    const seqs = await db.query<{ external_id: string }>("SELECT external_id FROM sequences WHERE connector = $1 AND launched_at IS NOT NULL AND external_id IS NOT NULL AND (state <> 'archived' OR launched_at > $2::timestamptz - interval '120 days')", [c.name, nowOf(deps).toISOString()]);
    if (!seqs.length) continue;
    try { const events = await c.events(since, seqs.map((s) => s.external_id)); await ingestEvents(db, deps, c, events); await recordRun(db, c.name, true, events.length, undefined, nowOf(deps)); }
    catch (e) { await recordRun(db, c.name, false, 0, (e as Error).message, nowOf(deps)); console.error("poll", c.name, (e as Error).message); }
  }
}

const running = { deps: null as LifecycleDeps | null, db: null as Db | null };
const quietly = async (name: string, run: () => Promise<unknown>) => { try { await run(); } catch (e) { console.error("lifecycle", name, e); if (running.db && running.deps) await raiseAlert(running.db, running.deps, `step:${name}`, `The ${name} step failed: ${(e as Error).message}`).catch(() => {}); } };

export async function ownerStep(db: Db, deps: LifecycleDeps) {
  for (const e of await db.query<{ id: string }>("SELECT id FROM events WHERE motion IN ('owners', 'sequencing', 'in_market') AND EXISTS (SELECT 1 FROM owner_decisions d WHERE d.event_id = events.id AND d.status = 'pending') OR motion = 'owners'")) {
    await openOwnerDecisions(db, deps, e.id);
    await sendOwnerCards(db, deps, e.id);
    await ownerSweep(db, deps, e.id);
  }
}

const lastOk = (db: Db) => async (connector: string) => { const [r] = await db.query<{ last_ok_at: string | null }>("SELECT last_ok_at::text AS last_ok_at FROM connector_runs WHERE connector = $1", [connector]); return r?.last_ok_at ? new Date(r.last_ok_at) : null; };

let ticking = false;
/** When the last pass started and finished in this process. /api/health reads it, so a tick that died or hangs is seen from outside. */
export const tickState = { startedAt: null as Date | null, finishedAt: null as Date | null };
/** A pass still running after this long is stuck: every stop, sweep and escalation waits behind it. */
export const TICK_STUCK_MINUTES = 15;

/** One pass at a time in this process. Every drain also claims its rows, so a webhook running alongside never repeats a call. */
export async function lifecycleTick(db: Db, deps: LifecycleDeps, opts: { flags?: boolean; nightly?: boolean } = {}) {
  if (ticking) {
    const since = tickState.startedAt;
    if (since && nowOf(deps).getTime() - since.getTime() > TICK_STUCK_MINUTES * 60_000)
      await raiseAlert(db, deps, "tick:stuck", `The desk's background pass has been running since ${since.toISOString().slice(11, 16)} UTC and has not finished. Stops, replies and escalations are waiting behind it. Restart the service.`).catch(() => {});
    return;
  }
  ticking = true;
  tickState.startedAt = nowOf(deps);
  try { await tickOnce(db, deps, opts); tickState.finishedAt = nowOf(deps); } finally { ticking = false; }
}

/** The tick is stale when a pass has started in this process and none has finished in the last 20 minutes (four missed passes). */
export function tickStale(now: Date = new Date()) {
  if (!tickState.startedAt) return false;
  const last = tickState.finishedAt ?? tickState.startedAt;
  return now.getTime() - last.getTime() > 20 * 60_000;
}

async function tickOnce(db: Db, deps: LifecycleDeps, opts: { flags?: boolean; nightly?: boolean }) {
  running.db = db; running.deps = deps;
  await quietly("owners", () => ownerStep(db, deps));
  await quietly("observe", () => observeSequences(db, deps));
  await quietly("ops", () => drainOps(db, deps));
  await quietly("poll", () => pollTools(db, deps));
  await quietly("blind", () => blindSweep(db, deps, lastOk(db)));
  await quietly("inbound", () => processInbound(db, deps));
  await quietly("notify", () => drainNotifications(db, deps));
  await quietly("escalate", () => escalateWaiting(db, deps));
  await quietly("resume", () => resumeDue(db, deps));
  if (opts.flags) await quietly("flags", () => flagSweep(db, deps));
  await quietly("bounces", () => bounceWatch(db, deps));
  await quietly("senders", () => senderSweep(db, deps, (id, reason) => pauseSequenceById(db, deps, id, reason)));
  await quietly("reminders", () => meetingReminders(db, deps));
  await quietly("crm meetings", () => ingestCrmMeetings(db, deps));
  await quietly("debrief", () => sendDebriefPrompts(db, deps));
  await quietly("extract", () => extractDebriefs(db, deps));
  await quietly("close", () => closeOut(db, deps));
  await quietly("calendar", () => calendarSweep(db, deps));
  await quietly("score", () => writeScorecards(db, deps));
  await quietly("outbox", () => drainQuietly(db, deps.crm));
  if (opts.nightly) { await quietly("digest", () => dailyDigest(db, deps)); await quietly("purge", () => purgeOldBodies(db, deps)); await quietly("learn", () => proposeEdits(db)); await quietly("integrity", () => integrityCheck(db, deps)); }
}
