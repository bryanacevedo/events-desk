/* What keeps a failing or throttling vendor from doing damage (docs/TIERING-AND-ENRICHMENT.md, "Vendors").

   Each vendor gets a guard with
     - a rate limit (token bucket),
     - a circuit breaker (closed, open after a run of failures, half-open for one trial after a cool-down),
     - silent-throttling detection: Apollo can answer a burst with an empty success that looks like "no match".
       So an empty answer is final only after a known-good lookup still works. If that lookup fails, the vendor
       is marked throttled, the breaker opens, and the caller gets a VendorDown to wait on. Nobody is reported
       "not found" because a vendor stopped answering.

   State is kept in memory, per process, behind an injectable clock so tests never sleep. The guard is wired
   into the identity seams (company search, person match, reverse lookup). The finder and verifier waterfall
   keeps the older rule (pause after five errors in a row) until the email loop is rebuilt. */

import { VendorError } from "./providers.ts";

export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** A clock for tests: sleeping moves time forward and returns at once. */
export function fakeClock(start = 1_000_000): Clock & { advance(ms: number): void; slept: number } {
  const c = { t: start, slept: 0, now: () => c.t, async sleep(ms: number) { c.t += ms; c.slept += ms; }, advance(ms: number) { c.t += ms; } };
  return c;
}

/** The vendor cannot be used right now. A caller waits `retry_after_ms` and tries again, or pauses the event. It is never a "not found". */
export class VendorDown extends Error {
  vendor: string;
  reason: "breaker_open" | "throttled" | "errors";
  retry_after_ms: number;
  constructor(vendor: string, reason: VendorDown["reason"], retryAfterMs: number) {
    super(`${vendor} is ${reason === "throttled" ? "throttling" : "down"}`);
    this.vendor = vendor; this.reason = reason; this.retry_after_ms = Math.max(0, retryAfterMs);
  }
}

export interface GuardConfig {
  /** Calls per second. Infinity turns the limiter off. */
  per_second: number;
  burst: number;
  /** Failures in a row that open the breaker. */
  failure_threshold: number;
  cooldown_ms: number;
  /** Retries of one call after a failure, before the caller hears of it. */
  retries: number;
  backoff_ms: number;
}
export const DEFAULT_GUARD: GuardConfig = { per_second: 2, burst: 5, failure_threshold: 5, cooldown_ms: 30_000, retries: 2, backoff_ms: 500 };
export const UNLIMITED: Partial<GuardConfig> = { per_second: Infinity, burst: Infinity, backoff_ms: 0, cooldown_ms: 1_000 };

export interface GuardStats { calls: number; failures: number; empties: number; probes: number; probe_failures: number; throttle_events: number; waited_ms: number; breaker_opens: number }

export class VendorGuard {
  name: string;
  cfg: GuardConfig;
  clock: Clock;
  state: "closed" | "open" | "half_open" = "closed";
  failures = 0;
  openUntil = 0;
  tokens: number;
  lastRefill: number;
  throttledUntil = 0;
  throttleStreak = 0;
  trialInFlight = false;
  stats: GuardStats = { calls: 0, failures: 0, empties: 0, probes: 0, probe_failures: 0, throttle_events: 0, waited_ms: 0, breaker_opens: 0 };

  constructor(name: string, cfg: GuardConfig, clock: Clock) {
    this.name = name; this.cfg = cfg; this.clock = clock; this.tokens = cfg.burst; this.lastRefill = clock.now();
  }

  /** Throws VendorDown when the breaker is open or the vendor is marked throttled and its back-off has not passed. */
  assertAvailable() {
    const now = this.clock.now();
    if (this.throttledUntil > now) throw new VendorDown(this.name, "throttled", this.throttledUntil - now);
    if (this.state === "open") {
      if (now < this.openUntil) throw new VendorDown(this.name, "breaker_open", this.openUntil - now);
      this.state = "half_open";
    }
    if (this.state === "half_open" && this.trialInFlight) throw new VendorDown(this.name, "breaker_open", this.cfg.backoff_ms);
  }

  private async take() {
    if (!Number.isFinite(this.cfg.per_second)) return;
    for (;;) {
      const now = this.clock.now();
      this.tokens = Math.min(this.cfg.burst, this.tokens + ((now - this.lastRefill) / 1000) * this.cfg.per_second);
      this.lastRefill = now;
      if (this.tokens >= 1) { this.tokens -= 1; return; }
      const wait = Math.ceil(((1 - this.tokens) / this.cfg.per_second) * 1000);
      this.stats.waited_ms += wait;
      await this.clock.sleep(wait);
    }
  }

  private fail() {
    this.stats.failures++;
    this.failures++;
    if (this.state === "half_open" || this.failures >= this.cfg.failure_threshold) {
      this.state = "open"; this.openUntil = this.clock.now() + this.cfg.cooldown_ms; this.stats.breaker_opens++;
    }
  }
  private ok() { this.failures = 0; this.state = "closed"; }

  /** One guarded call: rate limit, breaker, and a few retries with back-off. A failure still counts toward the breaker.
      A `paid` call is made once and its failure is handed back as it came, because whether it billed is the ledger's business, not a reason to try again. */
  async call<T>(fn: () => Promise<T>, opts: { paid?: boolean } = {}): Promise<T> {
    const retries = opts.paid ? 0 : this.cfg.retries;
    for (let attempt = 0; attempt <= retries; attempt++) {
      this.assertAvailable();
      const trial = this.state === "half_open";
      if (trial) this.trialInFlight = true;
      await this.take();
      this.stats.calls++;
      try {
        const out = await fn();
        this.ok();
        return out;
      } catch (e) {
        if (!(e instanceof VendorError)) throw e;
        this.fail();
        if (opts.paid) throw e;
      } finally { if (trial) this.trialInFlight = false; }
      if (attempt < retries) { this.stats.waited_ms += this.cfg.backoff_ms * 2 ** attempt; await this.clock.sleep(this.cfg.backoff_ms * 2 ** attempt); }
    }
    throw new VendorDown(this.name, "errors", Math.max(0, this.openUntil - this.clock.now()) || this.cfg.cooldown_ms);
  }

  /** The vendor answered a known-good lookup with nothing: it is throttling. Back off longer each time it happens in a row. */
  markThrottled() {
    this.stats.throttle_events++;
    this.throttleStreak++;
    const wait = Math.min(300_000, 2_000 * 2 ** (this.throttleStreak - 1));
    this.throttledUntil = this.clock.now() + wait;
  }
  clearThrottle() { this.throttleStreak = 0; this.throttledUntil = 0; }

  /** Runs an empty answer through the known-good lookup. Passes quietly when the vendor still answers; otherwise throws VendorDown('throttled'). */
  async confirmEmpty(probe: () => Promise<boolean>) {
    this.stats.empties++;
    this.stats.probes++;
    const ok = await this.call(probe);
    if (!ok) {
      this.stats.probe_failures++;
      this.markThrottled();
      throw new VendorDown(this.name, "throttled", this.throttledUntil - this.clock.now());
    }
    this.clearThrottle();
  }
}

/** One guard per vendor name. */
export class VendorHealth {
  clock: Clock;
  base: GuardConfig;
  guards = new Map<string, VendorGuard>();
  constructor(opts: { clock?: Clock; config?: Partial<GuardConfig> } = {}) {
    this.clock = opts.clock ?? realClock;
    this.base = { ...DEFAULT_GUARD, ...opts.config };
  }
  guard(name: string, override: Partial<GuardConfig> = {}): VendorGuard {
    let g = this.guards.get(name);
    if (!g) { g = new VendorGuard(name, { ...this.base, ...override }, this.clock); this.guards.set(name, g); }
    return g;
  }
  stats() { return Object.fromEntries([...this.guards].map(([k, g]) => [k, { ...g.stats, state: g.state }])); }
}
