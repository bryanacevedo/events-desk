/* The demo's before-the-list (docs/CHOOSING.md section 10): what the seed makes, that it is deterministic, and what the screens would read from it. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { goalTracker } from "../src/server/goal-tracker.ts";
import { candidates } from "../src/server/ranking.ts";
import { repeatView } from "../src/server/repeat.ts";
import { seed } from "../src/server/seed.ts";
import { SAMPLE_LIST_NOTE, SAMPLE_PAGES, TRACKED, TRACKED_BOOKINGS, TRACKED_GOAL } from "../src/server/seed-choosing.ts";
import { M2020 } from "../src/server/seed-plan.ts";
import { worldData } from "../src/server/world-slice.ts";
import { addDays } from "../src/shared/motion.ts";
import { demoWithResults, lifecycle, TODAY } from "./choosing-helpers.ts";
import { freshDb } from "./helpers.ts";

let db: Db;
beforeAll(async () => { db = await demoWithResults(); }, 600_000);
const q = <T>(sql: string, p: unknown[] = []) => db.query<T>(sql, p);

describe("what the seed makes", () => {
  it("the 142 companies of the world's people-to-meet file are target accounts, an uploaded sample list with no owner", async () => {
    const w = worldData().targets;
    expect(new Set(w.map((t) => t.company)).size).toBe(142);
    const mine = await q<{ name: string; owner: string | null; source: string; domain: string }>("SELECT name, owner, source, domain FROM target_accounts WHERE created_by = $1 ORDER BY name", [SAMPLE_LIST_NOTE]);
    expect(mine).toHaveLength(142);
    expect(mine.every((a) => a.source === "upload" && a.owner === null && a.domain)).toBe(true);
    expect(mine.map((a) => a.name).sort()).toEqual([...new Set(w.map((t) => t.company))].sort());
  });

  it("two sample pages are added to their events, named as samples, and match about twelve target accounts each, and not the ones that are not targets", async () => {
    for (const p of SAMPLE_PAGES) {
      expect(readFileSync(`samples/rosters/${p.file}`, "utf8").split("\n")[0]).toMatch(/^Sample page written for the demo/);
      const [pg] = await q<{ id: string; filename: string; kind: string; input: string; body: string }>("SELECT id, filename, kind, input, body FROM roster_pages WHERE catalog_id = $1", [p.catalog_id]);
      expect(pg).toMatchObject({ kind: p.kind, input: "uploaded" });
      expect(pg.filename).toMatch(/sample/);
      const m = await q<{ name: string; status: string }>("SELECT a.name, m.status FROM roster_matches m JOIN target_accounts a ON a.id = m.account_id WHERE m.page_id = $1", [pg.id]);
      expect(m).toHaveLength(12);
      expect(m.every((x) => x.status === "counted")).toBe(true);
      expect(pg.body).toMatch(/Velmora Systems|Corlane Dynamics/);
      expect(m.map((x) => x.name)).not.toContain("Velmora Systems");
    }
  });

  it("links SaaStr Annual to SaaStr AI Annual with its reason, and adds two sample catalog rows marked as suggested samples", async () => {
    expect(await q("SELECT alias_key, series_key, reason FROM series_links")).toEqual([{ alias_key: "saastr-annual", series_key: "saastr-ai-annual", reason: "Renamed for 2027" }]);
    const rows = await q<{ name: string; starts_on: string; ends_on: string; city: string; source: string; suggested_by: string }>("SELECT name, starts_on::text, ends_on::text, city, source, suggested_by FROM catalog_events WHERE suggested_by = 'sample' ORDER BY name");
    expect(rows).toEqual([
      { name: "Dreamforce 2027", starts_on: "2027-09-14", ends_on: "2027-09-16", city: "San Francisco", source: "suggested", suggested_by: "sample" },
      { name: "Money20/20 USA 2027", starts_on: "2027-10-18", ends_on: "2027-10-21", city: "Las Vegas", source: "suggested", suggested_by: "sample" },
    ]);
  });

  it("makes no repeat decision and no wording, and invents nothing model-worded", async () => {
    expect(await q("SELECT 1 FROM repeat_decisions")).toHaveLength(0);
    expect(await q("SELECT 1 FROM repeat_wordings")).toHaveLength(0);
    expect(await q("SELECT 1 FROM llm_calls WHERE step = 'repeat_word'")).toHaveLength(0);
  });
});

describe("the tracker", () => {
  it("shows days out on GITEX Global 2026: a goal, seven meetings booked by the real path across three reps, and the rest of those going with nothing booked", async () => {
    const t = await goalTracker(db, lifecycle, TRACKED);
    expect(t).toMatchObject({ goal: TRACKED_GOAL, phase: "before", held: 0, booked: TRACKED_BOOKINGS, counted: TRACKED_BOOKINGS, days_out: 13, no_rep: 0, words: "7 of 20 meetings booked, 13 days out" });
    expect(t.by_rep!.filter((r) => r.booked > 0).map((r) => [r.rep, r.booked])).toEqual([["Ana Duarte", 3], ["Camille Laurent", 2], ["Elena Petrova", 2]]);
    expect(t.nothing_booked!.length).toBe(7);
    expect(await q("SELECT 1 FROM meetings WHERE event_id = $1 AND status = 'booked' AND source = 'manual'", [TRACKED])).toHaveLength(7);
    const [ev] = await q<{ starts_on: string }>("SELECT starts_on::text FROM events WHERE id = $1", [TRACKED]);
    expect(addDays(TODAY, 13)).toBe(ev.starts_on);
  });

  it("reads Money20/20 USA 2026 after the event: 10 held of 16, one per rep across the reps who went", async () => {
    const t = await goalTracker(db, lifecycle, M2020);
    expect(t).toMatchObject({ goal: 16, phase: "after", held: 10, booked: 0, no_rep: 0 });
    expect(t.words).toMatch(/^10 of 16 meetings held, ended \d+ days ago$/);
    const held = t.by_rep!.filter((r) => r.held > 0);
    expect(held).toHaveLength(10);
    expect(held.every((r) => r.held === 1)).toBe(true);
    expect(t.accounts).toMatchObject({ goal: 10, basis: "target_list", caption: "from your target account list" });
  });
});

describe("what Choosing reads from it", () => {
  it("shows past return for Money20/20 USA 2027 and a below and an above the median reading", async () => {
    const out = await candidates(db, lifecycle);
    const m = out.candidates.find((c) => c.name === "Money20/20 USA 2027")!, d = out.candidates.find((c) => c.name === "Dreamforce 2027")!;
    expect(m.past).toMatchObject({ name: "Money20/20 USA 2026", held: 10, written: true });
    expect(d.past).toMatchObject({ name: "Dreamforce 2026", held: 8, written: true });
    expect(m.vs_median).toBe("below");
    expect(d.vs_median).toBe("above");
    expect(m.group).toBe(1);
    expect(out.candidates.filter((c) => c.likely.accounts > 0).map((c) => [c.name, c.likely.accounts])).toEqual(expect.arrayContaining([["SaaStr Annual 2027", 12], ["Forrester B2B Summit North America 2027", 12]]));
  });

  it("says too few to say for repeating: two scored events, no pair looked at, nothing passes", async () => {
    const v = await repeatView(db, lifecycle);
    expect(v).toMatchObject({ units: 2, pairs: 0, alpha_each: null });
    expect(v.patterns.every((p) => p.status === "too_few" && !p.passes)).toBe(true);
    expect(v.series.map((s) => [s.name, s.words])).toEqual([["Dreamforce", "one edition so far"], ["Money20/20 USA", "one edition so far"]]);
  });
});

describe("determinism", () => {
  it("a second seed writes the same accounts, pages, matches, link, catalog rows and bookings", async () => {
    const digest = async (d: Db) => {
      const parts = [
        await d.query("SELECT id, name, domain, source, created_by FROM target_accounts WHERE created_by = $1 ORDER BY id", [SAMPLE_LIST_NOTE]),
        await d.query("SELECT g.catalog_id, g.kind, g.filename, g.body_hash, a.name, m.matched_on, m.quote, m.status FROM roster_matches m JOIN roster_pages g ON g.id = m.page_id JOIN target_accounts a ON a.id = m.account_id ORDER BY 1, 5"),
        await d.query("SELECT alias_key, series_key, reason, created_by FROM series_links ORDER BY 1"),
        await d.query("SELECT id, name, starts_on::text, ends_on::text, seat_price_cents, source, suggested_by FROM catalog_events WHERE suggested_by = 'sample' ORDER BY id"),
        await d.query("SELECT e.goal_meetings_held, m.rep, m.scheduled_at::text, m.status, lower(k.email) AS email FROM meetings m JOIN events e ON e.id = m.event_id JOIN contacts k ON k.id = m.contact_id WHERE e.id = $1 ORDER BY lower(k.email)", [TRACKED]),
      ];
      return parts.map((x) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 10)).join(" ");
    };
    const second = await freshDb();
    await seed(second, { real: true, today: TODAY, world: true });
    expect(await digest(second)).toBe(await digest(db));
  }, 600_000);
});
