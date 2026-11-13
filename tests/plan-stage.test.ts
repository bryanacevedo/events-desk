/* The plan stage (docs/EVENT-PLAN.md section 5): one pure function, written beside the list stage and never in place of it. */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createEvent, moveEvent } from "../src/server/events.ts";
import { lifecycleTick } from "../src/server/lifecycle-tick.ts";
import { syncPlanStage, syncAllPlanStages, todayOf } from "../src/server/plan.ts";
import type { Db } from "../src/server/db.ts";
import { moveError, STAGES, type Stage } from "../src/shared/domain.ts";
import { planStageOf, planWaitingOn, type PlanFields } from "../src/shared/plan.ts";
import { clock } from "./lifecycle-harness.ts";
import { freshDb } from "./helpers.ts";
import { approvedPlan, DAN, draftPlan, one, TODAY } from "./plan-helpers.ts";
import { submitPlan } from "../src/server/plan.ts";

let db: Db;

const ev = (o: Partial<PlanFields> = {}): PlanFields => ({ stage: "requested", starts_on: "2027-03-01", last_day: "2027-03-03", motion: "none", approval_mode: "per_seat", plan_approved_at: null, judged_at: null, plan_stage: "preparing", ...o });

describe("planStageOf, rule by rule", () => {
  it("1. a declined event keeps the stage it had", () => {
    expect(planStageOf(ev({ stage: "declined", plan_stage: "planning", approval_mode: "budget" }), "2027-04-01")).toBe("planning");
    expect(planStageOf(ev({ stage: "declined", plan_stage: "preparing" }), "2027-04-01")).toBe("preparing");
  });
  it("2. judged when judged_at is set or the motion is scored", () => {
    expect(planStageOf(ev({ judged_at: "2027-03-10T00:00:00Z" }), "2027-03-04")).toBe("judged");
    expect(planStageOf(ev({ motion: "scored", stage: "delivered" }), "2027-03-04")).toBe("judged");
  });
  it("3. a budget-mode plan not yet approved is planning, whatever the date", () => {
    expect(planStageOf(ev({ approval_mode: "budget" }), "2027-03-02")).toBe("planning");
    expect(planStageOf(ev({ approval_mode: "budget" }), "2027-09-01")).toBe("planning");
  });
  it("4. after the last day is following up", () => {
    expect(planStageOf(ev({ stage: "delivered" }), "2027-03-04")).toBe("following_up");
    expect(planStageOf(ev({ stage: "delivered" }), "2027-03-03")).toBe("live");
  });
  it("5. the first day to the last day is live", () => {
    expect(planStageOf(ev({ stage: "delivered" }), "2027-03-01")).toBe("live");
    expect(planStageOf(ev({ stage: "delivered" }), "2027-03-02")).toBe("live");
  });
  it("6. preparing: per-seat, past the approval stages, or inside the last 70 days", () => {
    expect(planStageOf(ev(), "2026-01-01")).toBe("preparing");
    const budget = ev({ approval_mode: "budget", plan_approved_at: "2026-11-01T00:00:00Z", stage: "approved" });
    expect(planStageOf({ ...budget, stage: "mapped" }, "2026-11-13")).toBe("preparing");
    expect(planStageOf(budget, "2026-12-21")).toBe("preparing");
  });
  it("7. otherwise confirmed, with the last 70 days as the edge", () => {
    const budget = ev({ approval_mode: "budget", plan_approved_at: "2026-11-01T00:00:00Z", stage: "approved" });
    expect(planStageOf(budget, "2026-11-13")).toBe("confirmed");
    expect(planStageOf(budget, "2026-12-20")).toBe("confirmed");
    expect(planStageOf(budget, "2026-12-21")).toBe("preparing");
    expect(planStageOf({ ...budget, stage: "requested" }, "2026-11-13")).toBe("confirmed");
  });
  it("paused never changes the plan stage", () => {
    expect(planStageOf(ev({ stage: "paused" }), "2027-01-01")).toBe("preparing");
  });
});

describe("what the plan waits on", () => {
  it("a budget plan at requested waits on the planner or the approver, never on seats", () => {
    expect(planWaitingOn({ stage: "requested", approval_mode: "budget" }, { hosted: false, submitted: false })).toBe("Planner: ask for approval");
    expect(planWaitingOn({ stage: "requested", approval_mode: "budget" }, { hosted: false, submitted: true })).toBe("Approver: the plan");
    expect(planWaitingOn({ stage: "requested", approval_mode: "per_seat" }, { hosted: false, submitted: false })).toBe("Approver: seats");
  });
  it("a hosted event never waits on an attendee list", () => {
    expect(planWaitingOn({ stage: "approved", approval_mode: "budget" }, { hosted: true, submitted: true })).toBe("Nobody");
    expect(planWaitingOn({ stage: "approved", approval_mode: "budget" }, { hosted: false, submitted: true })).toBe("Requester: attendee list");
  });
});

/** The shortest walk from requested to each stage, by the edges moveError allows. */
function walkTo(target: Stage): Stage[] {
  const seen = new Map<string, Stage[]>([["requested|", []]]);
  const queue: { stage: Stage; paused_from: Stage | null }[] = [{ stage: "requested", paused_from: null }];
  while (queue.length) {
    const cur = queue.shift()!;
    const path = seen.get(`${cur.stage}|${cur.paused_from ?? ""}`)!;
    if (cur.stage === target) return path;
    for (const to of STAGES) {
      if (moveError({ stage: cur.stage, paused_from: cur.paused_from }, to, "r")) continue;
      const next = { stage: to, paused_from: to === "paused" ? cur.stage : null };
      const key = `${next.stage}|${next.paused_from ?? ""}`;
      if (!seen.has(key)) { seen.set(key, [...path, to]); queue.push(next); }
    }
  }
  throw new Error(`no walk to ${target}`);
}

describe("every old list stage stays reachable inside preparing", () => {
  let shared: Db;
  beforeAll(async () => { shared = await freshDb(); });
  for (const target of STAGES) {
    it(`a per-seat event reaches ${target} while preparing`, async () => {
      const e = await createEvent(shared, "Maya Ortiz", { name: `Walk ${target}`, starts_on: "2027-09-01", seat_count: 1, seat_price_cents: 0, flow: "two_card" });
      expect(planStageOf(e, TODAY)).toBe("preparing");
      for (const to of walkTo(target)) {
        const moved = await moveEvent(shared, e.id, to, "Dan Whitlock", { reason: "r" });
        expect(planStageOf(moved, TODAY), `${moved.stage}`).toBe("preparing");
      }
      expect((await one<{ stage: string }>(shared, "SELECT stage FROM events WHERE id = $1", [e.id])).stage).toBe(target);
    });
  }

  it("a budget-mode plan is planning, then confirmed at approved, then preparing from mapped on", async () => {
    const id = await draftPlan(shared, { starts_on: "2027-09-01", ends_on: "2027-09-03" });
    const read = async () => planStageOf((await shared.query<PlanFields>("SELECT stage, starts_on::text AS starts_on, motion, approval_mode, plan_approved_at, judged_at, plan_stage FROM events WHERE id = $1", [id]))[0], TODAY);
    expect(await read()).toBe("planning");
    await submitPlan(shared, "Camille Laurent", id, { today: TODAY });
    expect(await read()).toBe("planning");
    const { approvePlan } = await import("../src/server/plan.ts");
    await approvePlan(shared, { eventId: id, actor: DAN, today: TODAY });
    expect(await read()).toBe("confirmed");
    for (const to of walkTo("finding_people").slice(1)) { await moveEvent(shared, id, to, DAN, { reason: "r" }); expect(await read()).toBe("preparing"); }
  });
});

describe("the stage is written by syncPlanStage, once", () => {
  beforeEach(async () => { db = await freshDb(); });
  it("a budget plan is planning on creation and confirmed after approval; syncing again does nothing", async () => {
    const id = await approvedPlan(db, { starts_on: "2027-09-01", ends_on: "2027-09-03" });
    expect((await one<{ plan_stage: string }>(db, "SELECT plan_stage FROM events WHERE id = $1", [id])).plan_stage).toBe("confirmed");
    expect(await db.tx((q) => syncPlanStage(q, id, TODAY))).toBe(false);
  });

  it("logs one activity line on a move and is a no-op the second time", async () => {
    const id = await approvedPlan(db, { starts_on: "2027-09-01", ends_on: "2027-09-03" });
    expect(await db.tx((q) => syncPlanStage(q, id, "2027-08-01"))).toBe(true);
    expect(await db.tx((q) => syncPlanStage(q, id, "2027-08-01"))).toBe(false);
    const lines = await db.query<{ detail: string }>("SELECT detail FROM activity_log WHERE event_id = $1 AND kind = 'plan_stage'", [id]);
    expect(lines.map((l) => l.detail)).toEqual(["Plan stage: planning to confirmed", "Plan stage: confirmed to preparing"]);
  });

  it("follows the deps clock, not the wall clock", async () => {
    const id = await approvedPlan(db, { starts_on: "2027-03-01", ends_on: "2027-03-03" });
    const time = clock("2027-03-10T12:00:00Z");
    expect(todayOf({ now: () => time.now })).toBe("2027-03-10");
    expect(await syncAllPlanStages(db, { now: () => time.now })).toBeGreaterThan(0);
    expect((await one<{ plan_stage: string }>(db, "SELECT plan_stage FROM events WHERE id = $1", [id])).plan_stage).toBe("following_up");
    time.set("2027-03-02T12:00:00Z");
    await syncAllPlanStages(db, { now: () => time.now });
    expect((await one<{ plan_stage: string }>(db, "SELECT plan_stage FROM events WHERE id = $1", [id])).plan_stage).toBe("live");
  });

  it("never touches a top-up", async () => {
    const parent = await createEvent(db, "Maya Ortiz", { name: "P", starts_on: "2027-03-01", seat_count: 1, seat_price_cents: 0 });
    await db.query("INSERT INTO events (id, name, venue, starts_on, seat_count, seat_price_cents, requested_by, parent_event_id) VALUES ('evt_top', 'P', '', '2027-03-01', 1, 0, 'Maya Ortiz', $1)", [parent.id]);
    await syncAllPlanStages(db, { now: () => new Date("2028-01-01T00:00:00Z") });
    expect((await one<{ plan_stage: string }>(db, "SELECT plan_stage FROM events WHERE id = 'evt_top'")).plan_stage).toBe("preparing");
    expect((await one<{ plan_stage: string }>(db, "SELECT plan_stage FROM events WHERE id = $1", [parent.id])).plan_stage).toBe("following_up");
  });
});

describe("backfill and the tick", () => {
  beforeEach(async () => { db = await freshDb(); });
  it("a migrated per-seat event is preparing, a scored one is judged, and one tick moves a past one to following up", async () => {
    const past = await createEvent(db, "Maya Ortiz", { name: "Past", starts_on: "2026-01-10", ends_on: "2026-01-12", seat_count: 1, seat_price_cents: 0 });
    const scored = await createEvent(db, "Maya Ortiz", { name: "Scored", starts_on: "2026-01-10", ends_on: "2026-01-12", seat_count: 1, seat_price_cents: 0 });
    // What migration 0049 does, run again on rows made before it: no dates, the same on any day.
    await db.query("UPDATE events SET motion = 'scored' WHERE id = $1", [scored.id]);
    await db.query("UPDATE events SET plan_stage = 'judged' WHERE motion = 'scored'");
    const stage = async (id: string) => (await one<{ plan_stage: string; approval_mode: string }>(db, "SELECT plan_stage, approval_mode FROM events WHERE id = $1", [id]));
    expect(await stage(past.id)).toEqual({ plan_stage: "preparing", approval_mode: "per_seat" });
    expect((await stage(scored.id)).plan_stage).toBe("judged");
    const time = clock("2026-06-01T12:00:00Z");
    await lifecycleTick(db, { connectors: {}, llm: { async complete() { return ""; } } as never, now: () => time.now });
    expect((await stage(past.id)).plan_stage).toBe("following_up");
    expect((await stage(scored.id)).plan_stage).toBe("judged");
  });
});
