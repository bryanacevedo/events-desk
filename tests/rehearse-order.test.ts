import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The four-desk rehearsal must write the same calls on every run. An uploaded list's contact ids are random per run
// (events.ts newId), so a query that picks people "ORDER BY id LIMIT n" picks a different set each run (found 2026-11-16:
// three rehearsals, three different journals). Whatever the rehearsal picks with a LIMIT is ordered by the person.
describe("scripts/rehearse.ts", () => {
  const src = readFileSync(new URL("../scripts/rehearse.ts", import.meta.url), "utf8");
  it("never picks people by a random id", () => {
    for (const q of src.match(/ORDER BY [^`"]*LIMIT \d+/g) ?? []) expect(q, q).not.toMatch(/ORDER BY (\w+\.)?id\b/);
  });
  it("picks the thirty by email and name", () => {
    expect(src).toMatch(/ORDER BY lower\(k\.email\), k\.full_name LIMIT 30/);
  });
});

describe("scripts/rehearse.ts ids", () => {
  const src = readFileSync(new URL("../scripts/rehearse.ts", import.meta.url), "utf8");
  it("numbers the desk's ids before it seeds anything", () => {
    const patch = src.indexOf('defineProperty(globalThis.crypto, "randomUUID"');
    expect(patch).toBeGreaterThan(0);
    expect(patch).toBeLessThan(src.indexOf("await seed("));
  });
});

describe("scripts/rehearse.ts row order", () => {
  const src = readFileSync(new URL("../scripts/rehearse.ts", import.meta.url), "utf8");
  it("turns off vacuum and parallel scans before it seeds", () => {
    const off = src.indexOf("autovacuum_enabled = false");
    expect(off).toBeGreaterThan(0);
    expect(off).toBeLessThan(src.indexOf("await seed("));
    expect(src).toContain("max_parallel_workers_per_gather = 0");
  });
});

describe("scripts/rehearse.ts clock", () => {
  const src = readFileSync(new URL("../scripts/rehearse.ts", import.meta.url), "utf8");
  it("fixes the wall clock before it seeds", () => {
    const at = src.indexOf("globalThis.Date = FixedDate");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(src.indexOf("await seed("));
  });
});
