/* The sequence naming convention (src/shared/sequence-name.ts, docs/SEQUENCES-VIEW.md §7 and §8): every part, in order, ASCII, unique, at most 120 characters. */

import { describe, expect, it } from "vitest";
import { sequenceName } from "../src/shared/sequence-name.ts";

const base = { event: "Shoptalk Spring 2026", startsOn: "2026-03-24", phase: "pre" as const, channel: "email" as const, audience: "attendees", region: "event", id: "seq_0123456ab154" };

describe("sequence names", () => {
  it("says every part, in one order, with no region now that every sequence sends on the event's zone", () => {
    expect(sequenceName(base)).toBe("Desk | 2026-03 Shoptalk Spring 2026 | Before | Email | Attendees | 6ab154");
    expect(sequenceName({ ...base, phase: "post", channel: "linkedin", audience: "prospects" })).toBe("Desk | 2026-03 Shoptalk Spring 2026 | Follow-up | LinkedIn | Prospects | 6ab154");
  });
  it("still names a region on a sequence made before the change", () => {
    expect(sequenceName({ ...base, audience: "A", region: "americas" })).toBe("Desk | 2026-03 Shoptalk Spring 2026 | Before | Email | Priority A | Americas | 6ab154");
  });
  it("keeps to 120 ASCII characters, shortening the event first, and never loses its id", () => {
    const long = sequenceName({ ...base, event: "Asia Tech x Singapore 2027 (ATxEnterprise) | The Very Long Annual Summit of Everything That Ever Was And Will Be Again" });
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long).toMatch(/^Desk \| 2026-03 Asia Tech/);
    expect(long.endsWith("| Before | Email | Attendees | 6ab154")).toBe(true);
    expect(long.split(" | ")).toHaveLength(6);
    expect(/^[\x20-\x7E]+$/.test(long)).toBe(true);
  });
  it("differs for two sequences of the same kind", () => {
    expect(sequenceName(base)).not.toBe(sequenceName({ ...base, id: "seq_0123456ffffff" }));
  });
});
