/* The meeting goal tracker (docs/CHOOSING.md, section 5). Counts only: held and booked meetings by rep against the event's goal, and who goes with nothing
   booked. Nothing is sent from here and no dollar key is read. */

import type { Db } from "./db.ts";
import { RuleError } from "./events.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { goalResult, choosingToday as todayOf } from "./plan.ts";

export type TrackerPhase = "before" | "during" | "after";
export interface RepRow { rep: string; going: boolean; held: number; booked: number; nothing_booked: boolean }
export interface GoalTracker {
  goal: number | null;
  phase?: TrackerPhase;
  /** Held, booked (booked or rescheduled, never held), what counts toward the goal, and booked meetings still waiting for an outcome after the event. */
  held?: number; booked?: number; counted?: number; waiting?: number;
  days_out?: number; day?: number; days?: number; ended_days_ago?: number;
  by_rep?: RepRow[]; no_rep?: number; nothing_booked?: string[];
  accounts?: { goal: number; actual: number; basis: "target_list" | "tier1"; caption: string } | null;
  words?: string;
}

const dayNum = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export const BASIS_WORDS = { target_list: "from your target account list", tier1: "tier 1 companies" } as const;

/** The tracker for one event. `goal: null` when the event has no meeting goal (or a goal of 0), and the screen shows nothing. */
export async function goalTracker(db: Db, deps: LifecycleDeps | undefined, eventId: string): Promise<GoalTracker> {
  const [e] = await db.query<{ starts_on: string; ends_on: string | null; goal: number | null; accounts_goal: number | null }>("SELECT starts_on::text AS starts_on, ends_on::text AS ends_on, goal_meetings_held AS goal, goal_accounts_met AS accounts_goal FROM events WHERE id = $1", [eventId]);
  if (!e) throw new RuleError("That event does not exist.");
  if (!e.goal) return { goal: null };
  const today = dayNum(todayOf(deps)), start = dayNum(e.starts_on), end = dayNum(e.ends_on ?? e.starts_on);
  const phase: TrackerPhase = today < start ? "before" : today <= end ? "during" : "after";

  // One row per person: a held meeting wins over a booked one with the same person, so nobody is counted twice.
  const ms = await db.query<{ who: string; status: string; rep: string | null }>(
    "SELECT coalesce(contact_id, id) AS who, status, nullif(trim(rep), '') AS rep FROM meetings WHERE event_id = $1 AND status IN ('booked', 'rescheduled', 'held')", [eventId]);
  const heldBy = new Map<string, Set<string>>(), bookedBy = new Map<string, Set<string>>(), display = new Map<string, string>();
  const heldAll = new Set<string>(), bookedAll = new Set<string>();
  const noRep = new Set<string>();
  const add = (m: Map<string, Set<string>>, k: string, who: string) => { if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(who); };
  for (const m of ms) {
    const key = m.rep?.toLowerCase() ?? "";
    if (m.rep && !display.has(key)) display.set(key, m.rep);
    if (m.status === "held") { heldAll.add(m.who); if (key) add(heldBy, key, m.who); }
    else { bookedAll.add(m.who); if (key) add(bookedBy, key, m.who); }
    if (!key) noRep.add(m.who);
  }
  for (const w of heldAll) bookedAll.delete(w);
  for (const [k, set] of bookedBy) for (const w of [...set]) if (heldBy.get(k)?.has(w)) set.delete(w);

  const result = await goalResult(db, deps, eventId);
  // After the event the held figure is the one the Result reads, so the Plan tab never shows two.
  const held = phase === "after" && result.meetings ? result.meetings.actual : heldAll.size;
  const booked = bookedAll.size;
  const counted = phase === "after" ? held : held + booked;
  const waiting = phase === "after" ? booked : 0;

  const going = await db.query<{ person: string }>("SELECT DISTINCT person FROM who_goes WHERE event_id = $1 AND (roles && ARRAY['attend', 'host']::text[]) AND (seat_status IS NULL OR seat_status = 'approved') ORDER BY person", [eventId]);
  const reps = new Map<string, { rep: string; going: boolean }>();
  for (const g of going) { const k = g.person.trim().toLowerCase(); if (k && !reps.has(k)) reps.set(k, { rep: g.person.trim(), going: true }); }
  for (const k of new Set([...heldBy.keys(), ...bookedBy.keys()])) if (!reps.has(k)) reps.set(k, { rep: display.get(k) ?? k, going: false });
  const by_rep: RepRow[] = [...reps.entries()].map(([k, r]) => {
    const h = heldBy.get(k)?.size ?? 0, b = bookedBy.get(k)?.size ?? 0;
    return { rep: r.rep, going: r.going, held: h, booked: b, nothing_booked: phase !== "after" && r.going && h === 0 && b === 0 };
  }).sort((a, b) => (b.held + b.booked) - (a.held + a.booked) || a.rep.localeCompare(b.rep));

  const days_out = phase === "before" ? start - today : undefined;
  const days = end - start + 1, day = phase === "during" ? today - start + 1 : undefined;
  const ended_days_ago = phase === "after" ? today - end : undefined;
  const words = phase === "before" ? `${counted} of ${e.goal} meetings booked, ${plural(days_out!, "day")} out`
    : phase === "during" ? `${counted} of ${e.goal} meetings booked or held, day ${day} of ${days}`
    : `${counted} of ${e.goal} meetings held, ended ${plural(ended_days_ago!, "day")} ago${waiting ? `, ${waiting} booked and waiting for an outcome` : ""}`;

  const accounts = result.accounts && result.accounts_basis ? { goal: result.accounts.goal, actual: result.accounts.actual, basis: result.accounts_basis, caption: BASIS_WORDS[result.accounts_basis] } : null;
  return { goal: e.goal, phase, held, booked, counted, waiting, days_out, day, days, ended_days_ago, by_rep, no_rep: noRep.size, nothing_booked: by_rep.filter((r) => r.nothing_booked).map((r) => r.rep), accounts, words };
}
