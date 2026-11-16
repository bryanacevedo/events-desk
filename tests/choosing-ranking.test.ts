/* Choosing events: cost kinds, past return and the median, the fixed order, its stability, declined last, series links (docs/CHOOSING.md section 6). */

import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { addSeriesLink, seriesKey } from "../src/server/overlap.ts";
import { candidates, compareCandidates, groupOf, medianOf, orderCandidates, vsMedian, type OrderKey } from "../src/server/ranking.ts";
import { addPast, clockOnly, demoWithResults, lifecycle } from "./choosing-helpers.ts";

const row = (id: string, o: Partial<OrderKey> = {}): OrderKey => ({ group: 0, cost: { kind: "plan", cents: 1_000_00 }, likely: { accounts: 10 }, starts_on: "2027-03-01", catalog_id: id, ...o });

describe("the order, as a pure function", () => {
  it("puts the three groups first, then the cost kind, and never divides a plan by a pass", () => {
    const list = [
      row("a", { group: 2 }), row("b", { group: 1 }), row("c", { cost: { kind: "unknown", cents: null } }), row("d", { cost: { kind: "one_pass_estimate", cents: 50_000 } }),
      row("e", { cost: { kind: "one_pass", cents: 50_000 }, likely: { accounts: 1 } }), row("f", { cost: { kind: "plan", cents: 90_000_000 }, likely: { accounts: 1 } }),
    ];
    expect(orderCandidates(list).map((r) => r.catalog_id)).toEqual(["f", "e", "d", "c", "b", "a"]);
  });

  it("compares accounts per dollar by cross multiplication, so equal ratios tie exactly and ties go to more accounts, then date, then id", () => {
    const a = row("a", { likely: { accounts: 1 }, cost: { kind: "plan", cents: 300 } });
    const b = row("b", { likely: { accounts: 2 }, cost: { kind: "plan", cents: 600 } });
    expect(compareCandidates(a, b)).toBeGreaterThan(0); // equal per dollar, b has more accounts
    const hi = row("hi", { likely: { accounts: 7 }, cost: { kind: "plan", cents: 100 } }), lo = row("lo", { likely: { accounts: 900 }, cost: { kind: "plan", cents: 1_000_000 } });
    expect(orderCandidates([lo, hi]).map((r) => r.catalog_id)).toEqual(["hi", "lo"]);
    const early = row("z", { starts_on: "2027-01-01" }), late = row("a", { starts_on: "2027-02-01" });
    expect(orderCandidates([late, early]).map((r) => r.catalog_id)).toEqual(["z", "a"]);
    expect(orderCandidates([row("b"), row("a")]).map((r) => r.catalog_id)).toEqual(["a", "b"]);
  });

  it("is the same in any input order, and adding or removing an unrelated row never moves two others relative to each other", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const kinds = ["plan", "one_pass", "one_pass_estimate", "unknown"] as const;
    const rows = Array.from({ length: 40 }, (_, i) => row(`c${String(i).padStart(2, "0")}`, { group: (i % 3) as 0 | 1 | 2, cost: { kind: kinds[i % 4], cents: kinds[i % 4] === "unknown" ? null : 10_000 * (1 + (i % 7)) }, likely: { accounts: i % 9 }, starts_on: `2027-0${1 + (i % 9)}-01` }));
    const base = orderCandidates(rows).map((r) => r.catalog_id);
    for (let t = 0; t < 5; t++) {
      const shuffled = [...rows].sort(() => rnd() - 0.5);
      expect(orderCandidates(shuffled).map((r) => r.catalog_id)).toEqual(base);
      const drop = rows[Math.floor(rnd() * rows.length)].catalog_id;
      const extra = row("zz-new", { group: 1, likely: { accounts: 50 } });
      expect(orderCandidates(rows.filter((r) => r.catalog_id !== drop)).map((r) => r.catalog_id)).toEqual(base.filter((id) => id !== drop));
      expect(orderCandidates([...rows, extra]).map((r) => r.catalog_id).filter((id) => id !== "zz-new")).toEqual(base);
    }
  });

  it("groups declined last, then below the median, then the rest", () => {
    expect(groupOf(true, "below")).toBe(2);
    expect(groupOf(false, "below")).toBe(1);
    expect(groupOf(false, "above")).toBe(0);
    expect(groupOf(false, null)).toBe(0);
  });
});

describe("the median and vs_median", () => {
  const card = (n: number, h: number | null) => ({ event_id: `e${n}`, name: `E${n}`, starts_on: "2025-01-01", ends_on: null, parent_event_id: null, series_key: `e${n}`, window_days: 30, metrics: { score: h === null ? null : { held_per_thousand: h, pipeline_per_dollar: null } } as never });
  const past = (h: number | null) => ({ event_id: "x", name: "X", year: 2025, written: true, held: 9, cost_cents: 1, held_per_thousand: h, pipeline_per_dollar: null, scored: h !== null });

  it("needs two scored events, and reads above, below or the same", () => {
    expect(medianOf([card(1, 1.2)])).toEqual({ value: null, n: 1 });
    expect(medianOf([card(1, 1.2), card(2, null)])).toEqual({ value: null, n: 1 });
    const med = medianOf([card(1, 1), card(2, 2), card(3, 4)]);
    expect(med).toEqual({ value: 2, n: 3 });
    expect(vsMedian(past(3), med)).toBe("above");
    expect(vsMedian(past(0.5), med)).toBe("below");
    expect(vsMedian(past(2), med)).toBe("same");
    expect(vsMedian(past(null), med)).toBeNull();
    expect(vsMedian(null, med)).toBeNull();
    expect(vsMedian(past(3), { value: null, n: 1 })).toBeNull();
  });
});

describe("the candidates in the demo", () => {
  let db: Db;
  let out: Awaited<ReturnType<typeof candidates>>;
  beforeAll(async () => { db = await demoWithResults(); out = await candidates(db, lifecycle); }, 600_000);
  const by = (name: string) => out.candidates.filter((c) => c.name === name);

  it("offers the catalog rows from 30 to 400 days out, and not next week's", () => {
    expect(out.today).toBe("2026-11-24");
    expect(out.window).toEqual({ from: "2026-12-24", to: "2027-12-29" });
    for (const c of out.candidates) { expect(c.starts_on >= "2026-12-24").toBe(true); expect(c.starts_on <= "2027-12-29").toBe(true); }
    expect(out.candidates.some((c) => c.name === "GITEX Global 2026")).toBe(false);
  });

  it("reads each cost kind in words: the plan, one pass at the listed price, one pass estimated, not known", () => {
    expect(by("SaaStr Annual 2027")[0].cost).toMatchObject({ kind: "plan", cents: 2_400_000 });
    expect(by("Money20/20 Asia 2027")[0].cost.kind).toBe("one_pass");
    expect(by("NRF 2027: Retail's Big Show")[0].cost.kind).toBe("one_pass_estimate");
    expect(by("Money20/20 Europe 2027").map((c) => c.cost.kind).sort()).toEqual(["one_pass_estimate", "unknown"]);
    expect(by("Money20/20 Europe 2027").find((c) => c.cost.kind === "unknown")!.cost.cents).toBeNull();
  });

  it("treats a price of 0 cents as not known", async () => {
    await db.query("INSERT INTO catalog_events (id, name, city, country, starts_on, ends_on, seat_price_cents) VALUES ('cat_free', 'Free Fair 2027', 'X', 'Spain', '2027-04-01', '2027-04-02', 0)");
    const again = await candidates(db, lifecycle);
    expect(again.candidates.find((c) => c.catalog_id === "cat_free")!.cost).toMatchObject({ kind: "unknown", cents: null });
    await db.query("DELETE FROM catalog_events WHERE id = 'cat_free'");
  });

  it("gives Money20/20 USA 2027 its earlier edition's return, 10 held, and reads it against the median of the two scored events", () => {
    expect(out.median.n).toBe(2);
    const m = by("Money20/20 USA 2027")[0];
    expect(m.past).toMatchObject({ name: "Money20/20 USA 2026", held: 10, written: true, scored: true });
    expect(m.past!.held_per_thousand).toBeGreaterThan(0);
    expect(m.vs_median).toBe("below");
    expect(m.group).toBe(1);
    expect(by("Dreamforce 2027")[0].vs_median).toBe("above");
    expect(by("Dreamforce 2027")[0].group).toBe(0);
    expect(m.reasons.some((r) => /Last time \(Money20\/20 USA 2026\): 10 held meetings, .* per \$1,000, below the median/.test(r))).toBe(true);
  });

  it("puts the declined candidate last with its reason, and the below-median one after the rest", () => {
    const groups = out.candidates.map((c) => c.group);
    expect([...groups].sort()).toEqual(groups);
    const last = out.candidates[out.candidates.length - 1];
    expect(last).toMatchObject({ name: "Cannes Lions 2027", group: 2 });
    expect(last.reasons.some((r) => r.startsWith("Declined: "))).toBe(true);
    expect(out.candidates.filter((c) => c.group === 1).map((c) => c.name)).toEqual(["Money20/20 USA 2027"]);
  });

  it("counts the target accounts named on the two sample pages, with the sentence built by code", () => {
    const s = by("SaaStr Annual 2027")[0], f = by("Forrester B2B Summit North America 2027")[0];
    expect(s.likely.accounts).toBe(12);
    expect(f.likely.accounts).toBe(12);
    expect(s.reasons[0]).toBe("12 target accounts likely there: 12 named on a page");
    expect(s.reasons[1]).toBe("Cost: the plan, $24,000");
    expect(s.likely.by_kind.past).toBe(0);
  });

  it("orders each cost kind by target accounts per dollar, highest first, with the plan before one pass", () => {
    const ids = out.candidates.filter((c) => c.group === 0).map((c) => c.name);
    expect(ids.indexOf("Forrester B2B Summit North America 2027")).toBeGreaterThan(ids.indexOf("SaaStr Annual 2027"));
    const forrester = out.candidates.findIndex((c) => c.name.startsWith("Forrester")), saastr = out.candidates.findIndex((c) => c.name === "SaaStr Annual 2027");
    expect(saastr).toBeLessThan(forrester); // the plan kind sorts before one pass, whatever the ratio
    expect(out.how_ordered).toHaveLength(3);
  });

  it("joins SaaStr Annual to SaaStr AI Annual by the planner's link, and refuses a chain", async () => {
    expect(await seriesKey(db, "SaaStr Annual 2027")).toBe("saastr-ai-annual");
    expect(by("SaaStr Annual 2027")[0].series_key).toBe("saastr-ai-annual");
    await expect(addSeriesLink(db, "Camille Laurent", { name: "SaaStr Summit 2028", same_as: "SaaStr Annual 2027", reason: "x" })).rejects.toThrow(/Link to the earliest name/);
  });

  it("shows the latest repeat decision beside the row, and a past edition read without writing for an event in motion closing", async () => {
    await db.query("INSERT INTO repeat_decisions (id, series_key, decision, reason, decided_by, evidence) VALUES ('rdc_1', 'dreamforce', 'drop', 'Too far from the team', 'Dan Whitlock', '{}'::jsonb)");
    await db.query("INSERT INTO repeat_decisions (id, series_key, decision, reason, decided_by, decided_at, evidence) VALUES ('rdc_2', 'dreamforce', 'repeat', NULL, 'Dan Whitlock', now() + interval '1 minute', '{}'::jsonb)");
    const again = await candidates(db, lifecycle);
    expect(again.candidates.find((c) => c.name === "Dreamforce 2027")!.ours_last).toMatchObject({ decision: "repeat", decided_by: "Dan Whitlock" });
  });
});

describe("a past edition without a written scorecard", () => {
  it("is not scored and has no vs_median when the series has fewer than two scored events", async () => {
    const { freshDb } = await import("./helpers.ts");
    const db = await freshDb();
    await addPast(db, { n: 1, name: "Solo Summit 2025", held: 9, goal: 10, cost_cents: 900_000 });
    await db.query("INSERT INTO catalog_events (id, name, city, country, starts_on, ends_on, seat_price_cents) VALUES ('cat_solo_2027', 'Solo Summit 2027', 'X', 'Spain', '2027-04-01', '2027-04-02', 100000)");
    const out = await candidates(db, clockOnly as never);
    const c = out.candidates.find((x) => x.catalog_id === "cat_solo_2027")!;
    expect(c.past).toMatchObject({ name: "Solo Summit 2025", held: 9, scored: true });
    expect(out.median).toEqual({ value: null, n: 1 });
    expect(c.vs_median).toBeNull();
  }, 60_000);
});
