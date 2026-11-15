/* Step 6 part 3 (docs/SHARED-WORLD.md 13.3, 13.7, 13.9 items 2, 12, 13): the demo on the shared world. */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Db } from "../src/server/db.ts";
import { seed } from "../src/server/seed.ts";
import { worldData, worldSlice } from "../src/server/world-slice.ts";
import { freshDb } from "./helpers.ts";

let db: Db;
beforeAll(async () => { db = await freshDb(); await seed(db, { real: true, today: "2026-11-24", world: true }); }, 600_000);

describe("the vendored slice", () => {
  it("is v1.3.0 at f9d183d, every public file checked against the manifest and the pin", () => {
    const w = worldSlice();
    expect(w.pin).toMatchObject({ tag: "v1.3.0", commit: "f9d183dd39fd7fbfd9ee0df6a452daca25a497ab", world_version: "1.3.0" });
    expect(worldData().today).toBe("2026-11-24");
  });
  it("holds public files only and the loader reads nothing outside samples/lumen-world", () => {
    expect(readdirSync("samples/lumen-world").some((f) => /truth|people|deals|portrait/i.test(f))).toBe(false);
    const src = readFileSync("src/server/seed-world.ts", "utf8") + readFileSync("src/server/world-slice.ts", "utf8");
    expect(src).not.toMatch(/truth\//);
    expect(readFileSync("src/server/seed-world.ts", "utf8")).not.toMatch(/readFileSync|readdirSync/);
  });
});

describe("the demo on the world", () => {
  it("the 11 conferences keep the demo's events and take the world's id; the other 7 are made", async () => {
    const ids = (await db.query<{ external_id: string }>("SELECT external_id FROM events WHERE external_id IS NOT NULL")).map((r) => r.external_id).sort();
    const world = worldSlice().events.map((e) => e.id);
    for (const id of world) expect(ids).toContain(id);
    const kinds = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM involvements i JOIN events e ON e.id = i.event_id WHERE i.kind = 'hosted' AND e.external_id = ANY($1::text[])", [world]);
    expect(kinds[0].n).toBe(7 + 0);
  });

  it("the Las Vegas dinner hangs off Money20/20 USA 2026, seats 24, and every state is there with attended plus no show within the seats", async () => {
    const [d] = await db.query<{ id: string; conference_event_id: string; capacity: number }>("SELECT e.id, i.conference_event_id, h.capacity FROM events e JOIN involvements i ON i.event_id = e.id JOIN hosted_events h ON h.event_id = e.id WHERE e.external_id = 'ev_11c1de1ec2'");
    expect(d.capacity).toBe(24);
    const [parent] = await db.query<{ external_id: string }>("SELECT external_id FROM events WHERE id = $1", [d.conference_event_id]);
    expect(parent.external_id).toBe("ev_d81ee8da8d");
    const by = Object.fromEntries((await db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM event_guests WHERE event_id = $1 GROUP BY status", [d.id])).map((r) => [r.status, r.n]));
    expect(Object.keys(by).sort()).toEqual(["attended", "declined", "no_show", "waitlist"]);
    expect(by.attended + by.no_show).toBeLessThanOrEqual(24);
    expect(by.invited ?? 0).toBe(0);
  });

  it("the demo's own customer dinner at Money20/20 USA is not made (the world's takes its place)", async () => {
    expect(await db.query("SELECT 1 FROM events WHERE id = 'evt_m2020_usa_2026_dinner'")).toHaveLength(0);
  });

  it("Money20/20 USA 2025, the sponsorship, the talk and the assessment source are in", async () => {
    expect(await db.query("SELECT 1 FROM events WHERE external_id = 'ev_ccd7569a7f' AND starts_on = '2025-10-26'")).toHaveLength(1);
    const [s] = await db.query<{ price_cents: string; name: string }>("SELECT s.price_cents::text, e.name FROM sponsorships s JOIN events e ON e.id = s.event_id WHERE e.name = 'SaaStr Annual 2027'");
    expect(s.price_cents).toBe("2400000");
    expect(await db.query("SELECT 1 FROM talks t JOIN events e ON e.id = t.event_id WHERE e.name = 'SaaStr Annual 2027' AND t.status = 'accepted'")).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM assessment_answers a JOIN event_assessments x ON x.id = a.assessment_id JOIN events e ON e.id = x.event_id WHERE e.name = 'Money20/20 USA 2026' AND a.detail LIKE 'Sample:%'")).length).toBe(1);
  });

  it("the targets of the four coming conferences are contacts with a priority", async () => {
    const n = await db.query<{ name: string; n: number }>("SELECT e.name, count(*)::int AS n FROM contacts k JOIN events e ON e.id = k.event_id JOIN source_rows r ON r.id = k.source_row_id JOIN uploads u ON u.id = r.upload_id WHERE u.filename LIKE '%(world).csv' AND k.source = 'prospect' AND k.priority IN ('A', 'B') GROUP BY e.name ORDER BY e.name");
    expect(n.map((r) => r.name).sort()).toEqual(["AWS re:Invent 2026", "Forrester B2B Summit North America 2027", "Money20/20 Europe 2027", "SaaStr Annual 2027"]);
  });

  it("loading is deterministic: a digest of what it wrote, left out of generated ids and times, is the same on a second database", async () => {
    const digest = async (d: Db) => {
      const parts: string[] = [];
      parts.push(JSON.stringify(await d.query("SELECT external_id, name, starts_on::text FROM events WHERE external_id IS NOT NULL ORDER BY external_id")));
      parts.push(JSON.stringify(await d.query("SELECT e.external_id, lower(g.email) AS email, g.status FROM event_guests g JOIN events e ON e.id = g.event_id WHERE e.external_id IS NOT NULL ORDER BY 1, 2")));
      parts.push(JSON.stringify(await d.query("SELECT e.external_id, lower(k.email) AS email, k.priority, k.source FROM contacts k JOIN events e ON e.id = k.event_id JOIN source_rows r ON r.id = k.source_row_id JOIN uploads u ON u.id = r.upload_id WHERE u.filename LIKE '%(world).csv' ORDER BY 1, 2")));
      parts.push(JSON.stringify(await d.query("SELECT e.external_id, c.category, c.amount_cents FROM event_costs c JOIN events e ON e.id = c.event_id WHERE e.external_id IS NOT NULL ORDER BY 1, 2")));
      return parts.map((x) => createHash("sha256").update(x).digest("hex").slice(0, 8)).join(" ");
    };
    const second = await freshDb();
    await seed(second, { real: true, today: "2026-11-24", world: true });
    expect(await digest(second)).toBe(await digest(db));
  }, 600_000);
});

describe("scoring Money20/20 USA 2025", () => {
  it("is scored through the real path on a clock thirty days after its last day, with no cost invented", async () => {
    const { seedWorldScored } = await import("../src/server/seed-world.ts");
    await seedWorldScored(db, { crm: null, connectors: {}, now: () => new Date("2026-11-24T12:00:00Z") } as never);
    const [e] = await db.query<{ motion: string }>("SELECT motion FROM events WHERE external_id = 'ev_ccd7569a7f'");
    expect(e.motion).toBe("scored");
    expect(await db.query("SELECT 1 FROM event_costs c JOIN events e ON e.id = c.event_id WHERE e.external_id = 'ev_ccd7569a7f'")).toHaveLength(0);
  }, 120_000);
});
