/* The exact one-sided Fisher test, against hand-computed hypergeometric tails (docs/CHOOSING.md section 8). */

import { describe, expect, it } from "vitest";
import { fisherGreater } from "../src/server/stats.ts";

describe("fisherGreater", () => {
  it("k of 0 is certain", () => {
    expect(fisherGreater(0, 5, 3, 10)).toBe(1);
    expect(fisherGreater(0, 1, 0, 1)).toBe(1);
  });

  it("matches hand-computed tails", () => {
    // 10 events, 4 met the goal, a group of 5, all 4 inside: C(4,4) C(6,1) / C(10,5) = 6/252.
    expect(fisherGreater(4, 5, 4, 10)).toBeCloseTo(6 / 252, 12);
    // k = 3: (C(4,3) C(6,2) + 6) / 252 = (60 + 6) / 252.
    expect(fisherGreater(3, 5, 4, 10)).toBeCloseTo(66 / 252, 12);
    // The classic tea-tasting table, 4 of 4 out of 8 with 4 successes: 1 / 70.
    expect(fisherGreater(4, 4, 4, 8)).toBeCloseTo(1 / 70, 12);
    // 6 of 7 in a group against 1 of 7 outside (5 and 1 of 14, 7 in group, 7 successes): sum over x = 6, 7 of C(7,x) C(7,7-x) / C(14,7) = (7 * 7 + 1) / 3432.
    expect(fisherGreater(6, 7, 7, 14)).toBeCloseTo(50 / 3432, 12);
  });

  it("an impossible table throws", () => {
    expect(() => fisherGreater(5, 4, 5, 10)).toThrow("not a 2x2 table");
    expect(() => fisherGreater(1, 9, 8, 10)).toThrow("not a 2x2 table");
    expect(() => fisherGreater(2, 3, 1, 10)).toThrow("not a 2x2 table");
    expect(() => fisherGreater(-1, 3, 1, 10)).toThrow();
    expect(() => fisherGreater(1.5, 3, 4, 10)).toThrow();
  });

  it("stays exact on large tables where a float binomial would overflow", () => {
    const p = fisherGreater(100, 200, 150, 400);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});
