/* The year seed's dinners and roadshows are hosted plans, made through createPlan and the real approval path. */

import { beforeAll, describe, expect, it } from "vitest";
import { SEED_TODAY, seedYear, YEAR } from "../src/server/seed-year.ts";
import type { Db } from "../src/server/db.ts";
import { freshDb } from "./helpers.ts";

const HOSTED = ["evt_y04", "evt_y12", "evt_y18", "evt_y24", "evt_y32", "evt_y08", "evt_y22"];
let db: Db;
beforeAll(async () => { db = await freshDb(); await seedYear(db); }, 240_000);

describe("seedYear", () => {
  it("the five dinners and two roadshows each have one hosted involvement and no seat requests", async () => {
    expect(YEAR.filter((y) => y.hosted).map((y) => y.id).sort()).toEqual([...HOSTED].sort());
    for (const id of HOSTED) {
      const inv = await db.query<{ kind: string; hosted_format: string }>("SELECT kind, hosted_format FROM involvements WHERE event_id = $1", [id]);
      expect(inv.length, id).toBe(1);
      expect(inv[0].kind).toBe("hosted");
      expect((await db.query("SELECT 1 FROM seat_requests WHERE event_id = $1", [id])).length, id).toBe(0);
      expect((await db.query("SELECT 1 FROM uploads WHERE event_id = $1", [id])).length, id).toBe(0);
      expect((await db.query("SELECT 1 FROM event_people WHERE event_id = $1 AND 'host' = ANY(roles)", [id])).length, id).toBeGreaterThan(0);
      const [e] = await db.query<{ approval_mode: string; reason: string }>("SELECT approval_mode, reason FROM events WHERE id = $1", [id]);
      expect(e.approval_mode).toBe("budget");
      expect(e.reason.length).toBeGreaterThan(10);
    }
    expect((await db.query<{ hosted_format: string }>("SELECT hosted_format FROM involvements WHERE event_id IN ('evt_y08', 'evt_y22')")).every((i) => i.hosted_format === "roadshow_stop")).toBe(true);
  });

  it("y08 is declined with its reason, y22 y24 y32 are approved, and the past dinners carry their cost; y04 and y12 read judged", async () => {
    const stage = async (id: string) => (await db.query<{ stage: string; plan_stage: string; decline_reason: string | null }>("SELECT stage, plan_stage, decline_reason FROM events WHERE id = $1", [id]))[0];
    expect(await stage("evt_y08")).toEqual({ stage: "declined", plan_stage: "planning", decline_reason: "Sales kickoff moved to the same week" });
    for (const id of ["evt_y22", "evt_y24", "evt_y32"]) expect((await stage(id)).stage, id).toBe("approved");
    expect((await stage("evt_y22")).plan_stage).toBe("preparing");
    expect((await stage("evt_y32")).plan_stage).toBe("confirmed");
    for (const id of ["evt_y04", "evt_y12", "evt_y18"]) expect((await db.query("SELECT 1 FROM event_costs WHERE event_id = $1 AND category = 'dinners'", [id])).length, id).toBe(1);
    expect((await stage("evt_y04")).plan_stage).toBe("judged");
    expect((await stage("evt_y12")).plan_stage).toBe("judged");
    expect((await stage("evt_y18")).plan_stage).toBe("following_up");
    // Each carries one planned line: dinners for a dinner, Venue and catering for a roadshow.
    expect((await db.query<{ category: string; label: string }>("SELECT category, label FROM budget_lines WHERE event_id = 'evt_y22'"))).toEqual([{ category: "other", label: "Venue and catering" }]);
    expect((await db.query<{ category: string }>("SELECT category FROM budget_lines WHERE event_id = 'evt_y24'"))).toEqual([{ category: "dinners" }]);
    expect(SEED_TODAY).toBe("2026-11-08");
  });

  it("the conferences of the year are untouched and still per-seat", async () => {
    const [e] = await db.query<{ approval_mode: string }>("SELECT approval_mode FROM events WHERE id = 'evt_y01'");
    expect(e).toEqual({ approval_mode: "per_seat" });
    expect((await db.query("SELECT 1 FROM approvals WHERE event_id = 'evt_y01' AND kind = 'seats'")).length).toBe(1);
  });
});
