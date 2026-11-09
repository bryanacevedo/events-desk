/* How many inboxes a sequence needs, and which ones (docs/LIFECYCLE.md, section 5a). */

import { describe, expect, it } from "vitest";
import { DEFAULT_SENDING_RULES as R, peakDailySends, pickSenders, planCapacity, type SenderInfo } from "../src/shared/sending.ts";

const s = (id: string, over: Partial<SenderInfo> = {}): SenderInfo => ({ id, address: `${id}@a.example`, domain: "a.example", channel: "email", active: true, daily_limit: 50, health: 95, warm_days: 40, bounce_rate: 0.005, spam_rate: 0.001, ...over });

describe("how many", () => {
  it("adds later steps on top of first touches", () => {
    expect(peakDailySends(100, [0], 5).peak).toBe(20);
    // Step 2 lands 3 days later, while first touches are still going out.
    expect(peakDailySends(100, [0, 3], 5).peak).toBe(40);
    // Far enough apart that they never overlap.
    expect(peakDailySends(100, [0, 10], 5).peak).toBe(20);
  });

  it("never sends more in total than people times steps", () => {
    for (const [n, steps, days] of [[7, [0, 2, 5], 5], [1000, [0, 3, 7, 12], 5], [13, [0], 3]] as const) {
      const { per_day } = peakDailySends(n, [...steps], days);
      expect(per_day.reduce((a, b) => a + b, 0)).toBe(n * steps.length);
    }
  });

  it("turns the busiest day into inboxes, with spares", () => {
    const p = planCapacity(600, [0, 3, 7], "email");
    expect(p.peak_daily).toBe(240);
    expect(p.needed).toBe(8);
    expect(p.spares).toBe(2);
    expect(planCapacity(0, [0], "email")).toMatchObject({ needed: 0, spares: 0 });
  });

  it("uses the LinkedIn cap for LinkedIn", () => {
    expect(planCapacity(100, [0], "linkedin").needed).toBe(1);
    expect(planCapacity(500, [0], "linkedin").needed).toBe(5);
  });
});

describe("which ones", () => {
  const plan = planCapacity(150, [0], "email"); // 30 a day: one inbox, one spare

  it("takes the healthiest first", () => {
    const got = pickSenders([s("low", { health: 91 }), s("high", { health: 99 }), s("mid", { health: 95 })], plan, {});
    expect(got.picked.map((p) => [p.sender.id, p.role])).toEqual([["high", "primary"], ["mid", "spare"]]);
    expect(got.short_by).toBe(0);
  });

  it("refuses every kind of unhealthy sender, and says why", () => {
    const got = pickSenders([
      s("off", { active: false }), s("sick", { health: 70 }), s("blank", { health: null }), s("new", { warm_days: 3 }),
      s("bouncy", { bounce_rate: 0.05 }), s("spammy", { spam_rate: 0.01 }),
    ], plan, {});
    expect(got.picked).toEqual([]);
    expect(Object.fromEntries(got.excluded.map((e) => [e.id, e.reason]))).toEqual({ off: "not_connected", sick: "low_health", blank: "health_unknown", new: "still_warming", bouncy: "high_bounce", spammy: "high_spam" });
    expect(got.short_by).toBe(1);
  });

  it("will not read a missing health score as a good one", () => {
    expect(pickSenders([s("a", { health: null })], plan, {}).short_by).toBe(1);
  });

  it("respects the tool's own higher floor", () => {
    expect(pickSenders([s("a", { health: 92 })], plan, {}, R, 95).excluded[0].reason).toBe("low_health");
  });

  it("spreads across domains", () => {
    const big = planCapacity(1500, [0], "email"); // 300 a day: 10 inboxes
    const all = [...Array.from({ length: 12 }, (_, i) => s(`a${i}`, { domain: "a.example", health: 99 })), ...Array.from({ length: 12 }, (_, i) => s(`b${i}`, { domain: "b.example", health: 92 })), ...Array.from({ length: 12 }, (_, i) => s(`c${i}`, { domain: "c.example", health: 91 }))];
    const got = pickSenders(all, big, {});
    const per = new Map<string, number>();
    for (const p of got.picked) per.set(p.sender.domain, (per.get(p.sender.domain) ?? 0) + 1);
    expect([...per.values()].every((n) => n <= R.max_per_domain)).toBe(true);
    expect(per.size).toBe(3);
    expect(got.short_by).toBe(0);
  });

  it("counts what other live sequences already take, so an inbox is never double-booked", () => {
    const got = pickSenders([s("a"), s("b", { health: 90 })], plan, { a: 30 });
    expect(got.excluded).toEqual([{ id: "a", address: "a@a.example", reason: "fully_booked" }]);
    expect(got.picked[0].sender.id).toBe("b");
    const partly = pickSenders([s("a"), s("b", { health: 90 })], plan, { a: 20 });
    expect(partly.picked.filter((p) => p.role === "primary").map((p) => [p.sender.id, p.share])).toEqual([["a", 10], ["b", 20]]);
  });

  it("uses the lower of the tool's limit and the desk's cap", () => {
    const got = pickSenders([s("a", { daily_limit: 10 }), s("b", { health: 90, daily_limit: 500 })], plan, {});
    expect(got.picked.map((p) => p.share)).toEqual([10, 20]);
  });

  it("says exactly how many it is short", () => {
    const need = planCapacity(1000, [0], "email"); // 200 a day: 7 inboxes
    const got = pickSenders([s("a"), s("b")], need, {});
    expect(need.needed).toBe(7);
    expect(got.short_by).toBe(5);
  });
});
