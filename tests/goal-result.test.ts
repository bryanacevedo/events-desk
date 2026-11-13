/* The result against the goal (docs/EVENT-PLAN.md 6.3). Counts reach everyone; money keys end in cents, so forRep takes them from a rep. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { writeScorecards } from "../src/server/closeout.ts";
import type { Db } from "../src/server/db.ts";
import { bookMeeting, recordOutcome } from "../src/server/meetings.ts";
import { closeResult, createPlan, goalResult, goalWords, planView, updatePlan } from "../src/server/plan.ts";
import { planStageOf } from "../src/shared/plan.ts";
import { freshDb } from "./helpers.ts";
import { as, CAMILLE, one } from "./plan-helpers.ts";
import { clock, deliveredInMotion, fakeCrm, MAYA, personAt, type Harness } from "./lifecycle-harness.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

async function held(h: Harness, names: string[]) {
  for (const n of names) {
    const p = await personAt(db, h.id, n);
    const m = await bookMeeting(db, h.deps, { contact_id: p.id, scheduled_at: "2027-01-15T15:00:00Z", source: "manual", rep: MAYA }, MAYA);
    await recordOutcome(db, h.deps, m.id, "held", MAYA);
  }
}
async function closed() {
  const crm = fakeCrm({ opportunities: async (a: any[]) => Object.fromEntries(a.map((x: any) => [x.ref, [{ id: `o_${x.ref}`, stage: "Proposal", amount_cents: 6_000_000, created_date: "2027-01-20", stage_history: [] }]])) } as never);
  const h = await deliveredInMotion(db, { crm, time: clock("2027-03-01T12:00:00Z") });
  await db.query("UPDATE events SET motion = 'closing', starts_on = '2027-01-10', ends_on = '2027-01-12', catalog_id = NULL WHERE id = $1", [h.id]);
  await db.query("UPDATE companies SET tier = 1 WHERE event_id = $1", [h.id]);
  return h;
}

describe("goal result", () => {
  it("held meetings against the goal, from an unwritten reading and then from the written scorecard", async () => {
    const h = await closed();
    await held(h, ["Ana Ruiz", "Cleo Park"]);
    await updatePlan(db, CAMILLE, h.id, { goal_meetings_held: 5 });
    expect((await goalResult(db, h.deps, h.id)).meetings).toEqual({ goal: 5, actual: 2, short_by: 3 });
    h.time.set("2027-02-20T12:00:00Z");
    await writeScorecards(db, h.deps);
    expect((await one(db, "SELECT count(*)::int AS n FROM scorecards WHERE event_id = $1", [h.id]) as { n: number }).n).toBeGreaterThan(0);
    expect((await goalResult(db, undefined, h.id)).meetings).toEqual({ goal: 5, actual: 2, short_by: 3 });
    await updatePlan(db, CAMILLE, h.id, { goal_meetings_held: 2 });
    expect((await goalResult(db, h.deps, h.id)).meetings).toEqual({ goal: 2, actual: 2, short_by: 0 });
  });

  it("target accounts met counts tier 1 companies once each, and pipeline is sourced plus influenced", async () => {
    const h = await closed();
    // Ana and Ben are both at Tallgrass: two held meetings, one company. Cleo is at Brightwater. Dan Ito (Northwind) is not met.
    await held(h, ["Ana Ruiz", "Ben Ode", "Cleo Park"]);
    await updatePlan(db, CAMILLE, h.id, { goal_accounts_met: 4, goal_pipeline_cents: 20_000_000 });
    const r = await goalResult(db, h.deps, h.id);
    expect(r.accounts).toEqual({ goal: 4, actual: 2, short_by: 2 });
    expect(r.pipeline).toEqual({ goal_cents: 20_000_000, actual_cents: 12_000_000, short_by_cents: 8_000_000 });
    await db.query("UPDATE companies SET tier = 2 WHERE event_id = $1 AND name = 'Brightwater Software'", [h.id]);
    expect((await goalResult(db, h.deps, h.id)).accounts?.actual).toBe(1);
  });

  it("no goal reads No goal was set", async () => {
    const h = await closed();
    const r = await goalResult(db, h.deps, h.id);
    expect(r).toEqual({ meetings: null, accounts: null, pipeline: null });
    expect(goalWords(r, true)).toEqual(["No goal was set."]);
  });

  it("the words are counts, and the pipeline line is for those who may see money", async () => {
    const r = { meetings: { goal: 25, actual: 14, short_by: 11 }, accounts: { goal: 10, actual: 6, short_by: 4 }, pipeline: { goal_cents: 40_000_000, actual_cents: 31_000_000, short_by_cents: 9_000_000 } };
    expect(goalWords(r, true)).toEqual(["Held 14 of 25 meetings", "Met 6 of 10 target accounts", "$310,000 of $400,000 pipeline"]);
    expect(goalWords(r, false)).toEqual(["Held 14 of 25 meetings", "Met 6 of 10 target accounts"]);
  });

  it("a rep's read has the counts and none of goal_cents, actual_cents or short_by_cents", async () => {
    const h = await closed();
    await held(h, ["Ana Ruiz"]);
    await updatePlan(db, CAMILLE, h.id, { goal_meetings_held: 3, goal_pipeline_cents: 20_000_000 });
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    const rep = await (await app.request(`/api/events/${h.id}/plan`, { headers: as(MAYA) })).json() as { result: { meetings: unknown; pipeline: unknown; words: string[] }; goal: Record<string, unknown> };
    expect(rep.result.meetings).toEqual({ goal: 3, actual: 1, short_by: 2 });
    expect(rep.result.pipeline).toEqual({});
    expect(JSON.stringify(rep)).not.toMatch(/goal_cents|actual_cents|short_by_cents|pipeline_cents/);
    expect(rep.result.words).toEqual(["Held 1 of 3 meetings"]);
    const lead = await (await app.request(`/api/events/${h.id}/plan`, { headers: as(CAMILLE) })).json() as { result: { pipeline: { goal_cents: number } } };
    expect(lead.result.pipeline.goal_cents).toBe(20_000_000);
    void planView;
  });

  it("close the result needs the last day to have passed and an event with no motion", async () => {
    const { id } = await createPlan(db, CAMILLE, { name: "Dinner", starts_on: "2026-10-01", ends_on: "2026-10-02", hosted: { format: "dinner" } });
    await expect(closeResult(db, "GTM Team", id, "2026-10-02")).rejects.toThrow("after the last day");
    await closeResult(db, "GTM Team", id, "2026-10-03");
    const e = await one<{ judged_by: string; plan_stage: string }>(db, "SELECT judged_by, plan_stage FROM events WHERE id = $1", [id]);
    expect(e).toEqual({ judged_by: "GTM Team", plan_stage: "judged" });
    expect((await closeResult(db, "GTM Team", id, "2026-10-04")).already).toBe(true);
    await expect(db.query("UPDATE events SET judged_by = NULL WHERE id = $1", [id])).rejects.toThrow();
    const h = await closed();
    await expect(closeResult(db, "GTM Team", h.id, "2027-06-01")).rejects.toThrow("closes when it is scored");
    expect(planStageOf({ stage: "delivered", starts_on: "2027-01-10", motion: "scored" }, "2027-02-01")).toBe("judged");
  });
});
