/* How many inboxes a sequence needs and which ones to use (docs/LIFECYCLE.md, section 5a). Pure arithmetic and rules, in code. Every number here is a default to confirm against real sending results. */

import type { Channel } from "./motion.ts";

export interface SendingRules {
  /** Sends one sender may make in a day, whatever the tool's own limit allows. */
  daily_cap: Record<Channel, number>;
  /** Business days over which first touches are spread. */
  launch_days: number;
  /** Extra senders held ready, as a share of those needed. */
  spare_share: number;
  /** Health below this and a sender is not used. Connectors may raise it to their tool's own guidance. */
  min_health: number;
  min_warm_days: number;
  full_volume_days: number;
  max_bounce_rate: number;
  max_spam_rate: number;
  /** Spread: no more than this many senders on one domain per sequence. */
  max_per_domain: number;
  /** A placement test older than this does not count. */
  placement_max_age_days: number;
  min_inbox_rate: number;
}

export const DEFAULT_SENDING_RULES: SendingRules = {
  daily_cap: { email: 30, linkedin: 20 }, launch_days: 5, spare_share: 0.2, min_health: 90, min_warm_days: 14, full_volume_days: 30,
  max_bounce_rate: 0.02, max_spam_rate: 0.003, max_per_domain: 4, placement_max_age_days: 7, min_inbox_rate: 0.8,
};

export interface SenderInfo { warmup_on?: boolean | null; id: string; address: string; domain: string; channel: Channel; active: boolean; daily_limit: number | null; health: number | null; warm_days: number | null; bounce_rate: number | null; spam_rate: number | null }

/** The busiest day of the sequence: first touches go out over `launchDays`, and each later step lands on top of them. */
export function peakDailySends(people: number, stepDays: number[], launchDays: number) {
  if (!people || !stepDays.length) return { peak: 0, per_day: [] as number[] };
  const perStart = Math.ceil(people / launchDays);
  const last = launchDays + Math.max(...stepDays);
  const per_day: number[] = [];
  let left = people;
  const starts = Array.from({ length: launchDays }, () => { const n = Math.min(perStart, left); left -= n; return n; });
  for (let d = 0; d < last; d++) per_day.push(stepDays.reduce((sum, o) => sum + (starts[d - o] ?? 0), 0));
  return { peak: Math.max(...per_day), per_day };
}

export interface CapacityPlan { people: number; steps: number; peak_daily: number; needed: number; spares: number; per_sender_cap: number }

/** LinkedIn is sized on connection requests, the scarce action: later steps reach only people who accepted, so they are not counted against the same cap. */
export function planCapacity(people: number, stepDays: number[], channel: Channel, r: SendingRules = DEFAULT_SENDING_RULES): CapacityPlan {
  const { peak } = peakDailySends(people, channel === "linkedin" ? stepDays.slice(0, 1) : stepDays, r.launch_days);
  const cap = r.daily_cap[channel];
  const needed = Math.ceil(peak / cap);
  return { people, steps: stepDays.length, peak_daily: peak, needed, spares: needed ? Math.ceil(needed * r.spare_share) : 0, per_sender_cap: cap };
}

/** Whether the whole cadence can finish before the event. */
export function timingFits(stepDays: number[], launchDays: number, businessDaysLeft: number) {
  const needed = launchDays + Math.max(0, ...stepDays);
  return { needed, fits: needed <= businessDaysLeft };
}

/** Why a sender cannot be used, or null. No data on a thing the tool does report is not a pass for health: it fails. */
export function senderProblem(s: SenderInfo, r: SendingRules, opts: { healthFloor?: number; remaining: number }): string | null {
  if (!s.active) return "not_connected";
  if (s.warmup_on === false) return "warmup_off";
  if (s.health === null) return "health_unknown";
  if (s.health < Math.max(r.min_health, opts.healthFloor ?? 0)) return "low_health";
  if (s.warm_days !== null && s.warm_days < r.min_warm_days) return "still_warming";
  if (s.bounce_rate !== null && s.bounce_rate > r.max_bounce_rate) return "high_bounce";
  if (s.spam_rate !== null && s.spam_rate > r.max_spam_rate) return "high_spam";
  if (opts.remaining <= 0) return "fully_booked";
  return null;
}

export interface Pick { sender: SenderInfo; share: number; role: "primary" | "spare" }
export interface SenderPick { picked: Pick[]; excluded: { id: string; address: string; reason: string }[]; capacity: number; short_by: number }

/** The healthiest first, spread across domains, until the busiest day is covered, then spares. `committed` is what other live sequences already take from each sender each day. */
export function pickSenders(all: SenderInfo[], plan: CapacityPlan, committed: Record<string, number>, r: SendingRules = DEFAULT_SENDING_RULES, healthFloor?: number): SenderPick {
  // A sender still building up sends less. Under 30 days warm, half the usual day.
  const ceiling = (s: SenderInfo) => (s.warm_days !== null && s.warm_days < r.full_volume_days ? Math.floor(plan.per_sender_cap / 2) : plan.per_sender_cap);
  const room = (s: SenderInfo) => Math.max(0, Math.min(s.daily_limit ?? ceiling(s), ceiling(s)) - (committed[s.id] ?? 0));
  const excluded: SenderPick["excluded"] = [];
  const usable: SenderInfo[] = [];
  for (const s of all) {
    const why = senderProblem(s, r, { healthFloor, remaining: room(s) });
    if (why) excluded.push({ id: s.id, address: s.address, reason: why });
    else usable.push(s);
  }
  usable.sort((a, b) => b.health! - a.health! || (a.bounce_rate ?? 0) - (b.bounce_rate ?? 0) || (b.warm_days ?? 0) - (a.warm_days ?? 0) || a.id.localeCompare(b.id));
  const perDomain = new Map<string, number>(), picked: Pick[] = [];
  let capacity = 0, left = plan.peak_daily, spares = plan.spares;
  for (const s of usable) {
    const onDomain = perDomain.get(s.domain) ?? 0;
    if (onDomain >= r.max_per_domain) { excluded.push({ id: s.id, address: s.address, reason: "domain_full" }); continue; }
    if (left > 0) {
      const share = Math.min(room(s), left);
      picked.push({ sender: s, share, role: "primary" });
      capacity += room(s); left -= share; perDomain.set(s.domain, onDomain + 1);
    } else if (spares > 0) { picked.push({ sender: s, share: 0, role: "spare" }); spares--; perDomain.set(s.domain, onDomain + 1); }
    else break;
  }
  return { picked, excluded, capacity, short_by: Math.ceil(Math.max(0, left) / plan.per_sender_cap) };
}

export const senderWords: Record<string, string> = {
  not_connected: "Not connected", health_unknown: "Health not reported", low_health: "Health too low", still_warming: "Still warming up", high_bounce: "Bounces too high", high_spam: "Spam rate too high",
  warmup_off: "Warmup is switched off", burned: "This domain is marked burned or retired", primary_domain: "This is the company's own domain", no_consent: "The rep has not agreed to this", not_tested: "No placement test at one of the mail providers",
  fully_booked: "Already fully used by other sequences", domain_full: "Enough senders on this domain already", no_auth: "Domain has no SPF or DMARC record", failed_placement: "Failed its placement test", stale_placement: "No recent placement test",
};
