/* The sending layer (docs/LIFECYCLE.md, section 5a): how many inboxes each sequence needs, the healthiest ones to use, proof they land in the inbox, and watching them while the sequence runs. A sequence that does not have enough healthy senders does not go out. */

import type { Db } from "./db.ts";
import type { Connector, SendSettings } from "./connectors/types.ts";
import { logActivity } from "./events.ts";
import { DESK, nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { openLifecycleCase } from "./lifecycle-cases.ts";
import { DEFAULT_SENDING_RULES, pickSenders, planCapacity, senderWords, type SenderInfo, type SendingRules } from "../shared/sending.ts";
import { GROUP_ZONE, zoneOf, type Channel, type ZoneGroup } from "../shared/motion.ts";

const DAY = 86_400_000;
export interface PlacementResult { domain: string; inbox_rate: number; tool: string; tested_at: string }
/** A domain's mail records. Absent in a mock: nothing is claimed about authentication then. */
export interface MailAuth { hasSpfAndDmarc(domain: string): Promise<boolean> }

const rulesOf = (deps: LifecycleDeps): SendingRules => ({ ...DEFAULT_SENDING_RULES, ...deps.sendingRules });

export async function recordPlacement(db: Db, r: PlacementResult) {
  await db.query("INSERT INTO placement_results (domain, inbox_rate, tool, tested_at) VALUES ($1, $2, $3, $4) ON CONFLICT (domain, tool, tested_at) DO NOTHING", [r.domain.toLowerCase(), r.inbox_rate, r.tool, r.tested_at]);
}

/** The checks that need the outside world. They turn a sender into one the picker skips, with the reason on the screen. */
async function outsideChecks(db: Db, deps: LifecycleDeps, c: Connector, senders: SenderInfo[], r: SendingRules, now: Date) {
  const bad = new Map<string, string>();
  const domains = [...new Set(senders.filter((s) => s.channel === "email").map((s) => s.domain))];
  for (const d of domains) {
    if (deps.mailAuth && !(await deps.mailAuth.hasSpfAndDmarc(d).catch(() => false))) { bad.set(d, "no_auth"); continue; }
    if (!deps.placementRequired) continue;
    const [t] = await db.query<{ inbox_rate: number; tested_at: string }>("SELECT inbox_rate, tested_at::text AS tested_at FROM placement_results WHERE domain = $1 ORDER BY tested_at DESC LIMIT 1", [d]);
    if (!t || now.getTime() - Date.parse(t.tested_at) > r.placement_max_age_days * DAY) bad.set(d, "stale_placement");
    else if (t.inbox_rate < r.min_inbox_rate) bad.set(d, "failed_placement");
  }
  void c;
  return bad;
}

/** What other live sequences already take from each sender each day. */
async function committedShares(db: Db, connector: string, exceptSequence: string) {
  const rows = await db.query<{ sender_id: string; n: number }>(
    `SELECT x.sender_id, sum(x.daily_share)::int AS n FROM sequence_senders x JOIN sequences s ON s.id = x.sequence_id WHERE s.connector = $1 AND s.id <> $2 AND s.state IN ('draft', 'active') AND x.dropped_at IS NULL GROUP BY x.sender_id`, [connector, exceptSequence]);
  return Object.fromEntries(rows.map((r) => [r.sender_id, r.n]));
}

const stepDaysOf = (steps: { day?: number }[]) => steps.map((s, i) => (typeof s.day === "number" ? s.day : i * 3));

/** Works out what one sequence needs and picks its senders. A tool that cannot show its senders says so, and the screen says the desk cannot vouch for them. */
export async function planSenders(db: Db, deps: LifecycleDeps, sequenceId: string, actor: string = DESK) {
  const now = nowOf(deps), r = rulesOf(deps);
  const [s] = await db.query<{ id: string; event_id: string; connector: string; channel: Channel; name: string; external_id: string | null; steps: { day?: number }[]; people: number }>(
    `SELECT s.id, s.event_id, s.connector, s.channel, s.name, s.external_id, t.steps, (SELECT count(*)::int FROM enrollments n WHERE n.sequence_id = s.id AND n.state <> 'removed') AS people FROM sequences s JOIN sequence_templates t ON t.id = s.template_id WHERE s.id = $1`, [sequenceId]);
  const c = deps.connectors[s.connector];
  const plan = planCapacity(s.people, stepDaysOf(s.steps), s.channel, r);
  if (!c.listSenders) {
    await db.query("UPDATE sequences SET senders_needed = $2, peak_daily = $3, sender_status = 'not_visible' WHERE id = $1", [s.id, plan.needed, plan.peak_daily]);
    return { plan, status: "not_visible" as const, picked: [], excluded: [], short_by: 0 };
  }
  const all = (await c.listSenders()).filter((x) => x.channel === s.channel);
  const bad = await outsideChecks(db, deps, c, all, r, now);
  const committed = await committedShares(db, s.connector, s.id);
  const usable = all.filter((x) => !bad.has(x.domain));
  const pick = pickSenders(usable, plan, committed, r, c.healthFloor);
  const excluded = [...pick.excluded, ...all.filter((x) => bad.has(x.domain)).map((x) => ({ id: x.id, address: x.address, reason: bad.get(x.domain)! }))];
  const status = pick.short_by > 0 ? "short" : "ok";
  await db.tx(async (q) => {
    await q("UPDATE sequence_senders SET dropped_at = $2, drop_reason = 'replanned' WHERE sequence_id = $1 AND dropped_at IS NULL", [s.id, now.toISOString()]);
    for (const p of pick.picked) await q(
      `INSERT INTO sequence_senders (sequence_id, sender_id, address, domain, role, daily_share, health_at_pick, picked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (sequence_id, sender_id) DO UPDATE SET role = EXCLUDED.role, daily_share = EXCLUDED.daily_share, health_at_pick = EXCLUDED.health_at_pick, picked_at = EXCLUDED.picked_at, dropped_at = NULL, drop_reason = NULL`,
      [s.id, p.sender.id, p.sender.address, p.sender.domain, p.role, p.share, p.sender.health, now.toISOString()]);
    await q("UPDATE sequences SET senders_needed = $2, peak_daily = $3, sender_status = $4, sender_excluded = $5::jsonb WHERE id = $1", [s.id, plan.needed, plan.peak_daily, status, JSON.stringify(excluded.slice(0, 200))]);
    await logActivity(q, s.event_id, actor, "sending", status === "ok" ? `${s.name} needs ${plan.needed} ${s.channel === "email" ? "inboxes" : "senders"} on its busiest day (${plan.peak_daily} sends). The healthiest ${pick.picked.filter((p) => p.role === "primary").length} were chosen, with ${pick.picked.filter((p) => p.role === "spare").length} spare.` : `${s.name} is ${pick.short_by} short of the ${plan.needed} healthy senders it needs.`);
  });
  if (status === "ok" && c.assignSenders && s.external_id) await c.assignSenders(s.external_id, pick.picked.filter((p) => p.role === "primary").map((p) => p.sender));
  return { plan, status, picked: pick.picked, excluded, short_by: pick.short_by };
}

const WINDOW = { from: "09:00", to: "17:00", days: [1, 2, 3, 4, 5] };

/** Sets the window, tracking and stop-on-reply instead of inheriting them. A tool that will not take them leaves them to the launch checklist. */
export async function applySendSettings(db: Db, deps: LifecycleDeps, sequenceId: string) {
  const [s] = await db.query<{ id: string; connector: string; external_id: string | null; zone_group: ZoneGroup; country: string | null; peak_daily: number | null }>("SELECT s.id, s.connector, s.external_id, s.zone_group, e.country, s.peak_daily FROM sequences s JOIN events e ON e.id = s.event_id WHERE s.id = $1", [sequenceId]);
  const c = deps.connectors[s.connector];
  if (!c?.applySettings || !s.external_id) return null;
  const want = settingsFor(s.zone_group, s.country, s.peak_daily ?? 0);
  await c.applySettings(s.external_id, want);
  const got = await c.readSettings!(s.external_id);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  await db.query("UPDATE sequences SET settings_ok = $2 WHERE id = $1", [s.id, ok]);
  return { ok, want };
}

export const settingsFor = (zone: ZoneGroup, country: string | null, daily: number): SendSettings => ({
  timezone: zone === "event" ? zoneOf(country) ?? "UTC" : GROUP_ZONE[zone], ...WINDOW, stop_on_reply: true, track_opens: false, track_links: false, daily_limit: daily,
});

/** At launch the tool is read again: a setting someone changed since is caught here. */
export async function settingsConfirmed(db: Db, deps: LifecycleDeps, c: Connector, s: { id: string; external_id: string | null; zone_group: ZoneGroup; event_id: string; checklist_at: string | null }) {
  if (!s.checklist_at) return false;
  if (!c.readSettings || !c.capabilities.appliesSettings) return true;
  const [e] = await db.query<{ country: string | null; peak_daily: number | null }>("SELECT e.country, q.peak_daily FROM sequences q JOIN events e ON e.id = q.event_id WHERE q.id = $1", [s.id]);
  return JSON.stringify(await c.readSettings(s.external_id!)) === JSON.stringify(settingsFor(s.zone_group, e.country, e.peak_daily ?? 0));
}

/** True when the sequence may go out. A sequence that is short pauses instead of running on unhealthy senders. */
export async function launchAllowed(db: Db, sequenceId: string) {
  const [s] = await db.query<{ sender_status: string | null }>("SELECT sender_status FROM sequences WHERE id = $1", [sequenceId]);
  return s.sender_status !== "short";
}

/** While a sequence runs: re-reads each sender. One that goes bad is replaced from the spares. With no spare left to cover it, the sequence pauses and a person hears. */
export async function senderSweep(db: Db, deps: LifecycleDeps, pause: (sequenceId: string, reason: string) => Promise<void>) {
  const r = rulesOf(deps);
  const seqs = await db.query<{ id: string; event_id: string; connector: string; name: string; external_id: string; peak_daily: number | null }>("SELECT id, event_id, connector, name, external_id, peak_daily FROM sequences WHERE state = 'active' AND external_id IS NOT NULL AND sender_status = 'ok'");
  const out = { replaced: 0, paused: 0 };
  const lists = new Map<string, SenderInfo[]>();
  for (const s of seqs) {
    const c = deps.connectors[s.connector];
    if (!c?.listSenders) continue;
    if (!lists.has(s.connector)) { try { lists.set(s.connector, await c.listSenders()); } catch (e) { console.error("senders", s.connector, (e as Error).message); continue; } }
    const now = new Map(lists.get(s.connector)!.map((x) => [x.id, x]));
    const mine = await db.query<{ sender_id: string; role: string; daily_share: number }>("SELECT sender_id, role, daily_share FROM sequence_senders WHERE sequence_id = $1 AND dropped_at IS NULL", [s.id]);
    const sick = mine.filter((m) => {
      const x = now.get(m.sender_id);
      if (!x || !x.active) return true;
      return (x.health !== null && x.health < Math.max(r.min_health, c.healthFloor ?? 0)) || (x.bounce_rate !== null && x.bounce_rate > r.max_bounce_rate) || (x.spam_rate !== null && x.spam_rate > r.max_spam_rate);
    });
    if (!sick.length) continue;
    const spares = mine.filter((m) => m.role === "spare" && !sick.includes(m));
    let need = sick.filter((m) => m.role === "primary");
    await db.tx(async (q) => {
      for (const m of sick) await q("UPDATE sequence_senders SET dropped_at = now(), drop_reason = 'went_bad' WHERE sequence_id = $1 AND sender_id = $2", [s.id, m.sender_id]);
      for (const sp of spares.slice(0, need.length)) { await q("UPDATE sequence_senders SET role = 'primary', daily_share = $3 WHERE sequence_id = $1 AND sender_id = $2", [s.id, sp.sender_id, need[0].daily_share]); out.replaced++; }
    });
    const covered = Math.min(spares.length, need.length);
    need = need.slice(covered);
    if (need.length) {
      await pause(s.id, `${need.length} sending ${need.length === 1 ? "account" : "accounts"} went bad and there were no spares left.`);
      await db.query("UPDATE sequences SET sender_status = 'short' WHERE id = $1", [s.id]);
      await db.tx((q) => openLifecycleCase(q, { eventId: s.event_id, kind: "sending_capacity", summary: `${s.name} paused itself: ${need.length} sending ${need.length === 1 ? "account" : "accounts"} went bad with no spares left.`, facts: [{ sequence: s.name, senders_lost: sick.map((m) => m.sender_id) }], payload: { sequence_id: s.id } }));
      out.paused++;
    } else if (c.assignSenders) {
      const rows = await db.query<{ sender_id: string }>("SELECT sender_id FROM sequence_senders WHERE sequence_id = $1 AND dropped_at IS NULL AND role = 'primary'", [s.id]);
      await c.assignSenders(s.external_id, rows.map((x) => now.get(x.sender_id)!).filter(Boolean));
    }
  }
  void senderWords;
  return out;
}
