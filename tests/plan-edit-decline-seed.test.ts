/* The leftovers of redesign step 1: making a plan and editing it over HTTP, declining with a reason, and the demo's in-flight plan (AWS re:Invent 2026). */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { seedDemoPlan } from "../src/server/seed-plan.ts";
import { seedReal } from "../src/server/seed-real.ts";
import { freshDb } from "./helpers.ts";
import { as, CAMILLE, DAN, draftPlan, LEO, one, TODAY } from "./plan-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

describe("making and editing a plan over HTTP", () => {
  it("a planner makes a plan, edits reason, goal and lines, and asks; a rep may not write", async () => {
    const app = createApp(db, { demo: true });
    const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: as(who), body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await call(LEO, "POST", "/api/plans", { name: "X", starts_on: "2027-06-01" })).status).toBe(403);
    const made = await call(CAMILLE, "POST", "/api/plans", { name: "Summit Test", starts_on: "2027-06-01", city: "Lisbon", country: "Portugal", seat_price_cents: 100_000, reason: "Buyers meet here." });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    expect((await call(CAMILLE, "POST", `/api/events/${id}/involvements`, { kind: "passes", pass_count: 2 })).status).toBe(201);
    expect((await call(CAMILLE, "PATCH", `/api/events/${id}/plan`, { reason: "Buyers meet here, once a year.", goal_meetings_held: 10, goal_pipeline_cents: 2_000_000 })).status).toBe(200);
    const line = (await (await call(CAMILLE, "POST", `/api/events/${id}/budget-lines`, { category: "passes", planned_cents: 200_000 })).json()) as { id: string };
    expect((await call(CAMILLE, "PUT", `/api/events/${id}/budget-lines/${line.id}`, { category: "passes", label: "Two", planned_cents: 210_000, contracted_cents: null })).status).toBe(200);
    const view = (await (await call(CAMILLE, "GET", `/api/events/${id}/plan`)).json()) as { can_plan: boolean; reason: string; goal: { meetings_held: number }; budget: { total_planned_cents: number } };
    expect(view.can_plan).toBe(true);
    expect(view.reason).toBe("Buyers meet here, once a year.");
    expect(view.goal.meetings_held).toBe(10);
    expect(view.budget.total_planned_cents).toBe(210_000);
    expect((await call(CAMILLE, "POST", `/api/events/${id}/plan/submit`)).status).toBe(200);
    const rep = (await (await call(LEO, "GET", `/api/events/${id}/plan`)).json()) as { can_plan: boolean; budget?: unknown };
    expect(rep.can_plan).toBe(false);
    expect(rep.budget).toBeUndefined();
    expect((await call(LEO, "PATCH", `/api/events/${id}/plan`, { reason: "x" })).status).toBe(403);
    expect((await call(CAMILLE, "DELETE", `/api/events/${id}/budget-lines/${line.id}`)).status).toBe(200);
  });
});

describe("declining a plan", () => {
  it("needs the reason, an approver who is not the maker, and ends the event with that reason", async () => {
    const id = await draftPlan(db);
    const app = createApp(db, { demo: true });
    const decide = (who: string, body: unknown) => app.request(`/api/events/${id}/plan/decision`, { method: "POST", headers: as(who), body: JSON.stringify(body) });
    await app.request(`/api/events/${id}/plan/submit`, { method: "POST", headers: as(CAMILLE) });
    expect((await decide(CAMILLE, { decision: "decline", reason: "Changed my mind" })).status).toBe(409);
    expect((await decide(DAN, { decision: "decline", reason: "" })).status).toBeGreaterThanOrEqual(400);
    expect((await decide(DAN, { decision: "decline", reason: "Not a priority this quarter" })).status).toBe(200);
    const e = await one<{ stage: string; decline_reason: string }>(db, "SELECT stage, decline_reason FROM events WHERE id = $1", [id]);
    expect(e.stage).toBe("declined");
    expect(e.decline_reason).toContain("Not a priority this quarter");
    expect(TODAY).toBeTruthy();
  });
});

describe("the demo's in-flight plan", () => {
  it("is AWS re:Invent 2026, written onto the paused event that holds its list and twelve seats", async () => {
    await seedReal(db);
    await seedDemoPlan(db, TODAY);
    const e = await one<{ name: string; starts_on: string; approval_mode: string; plan_approved_by: string; catalog_id: string; reason: string }>(
      db, "SELECT name, starts_on::text AS starts_on, approval_mode, plan_approved_by, catalog_id, reason FROM events WHERE id = 'evt_aws-re-invent-2026'");
    expect(e.name).toBe("AWS re:Invent 2026");
    expect(e.starts_on).toBe("2026-11-30");
    expect(e.approval_mode).toBe("budget");
    expect(e.plan_approved_by).toBe(DAN);
    expect(e.catalog_id).toBe("cat_aws-re-invent-2026");
    // The plan sits on the event that already holds the seats and the list, not on a second event.
    expect((await db.query("SELECT 1 FROM events WHERE catalog_id = 'cat_aws-re-invent-2026'")).length).toBe(1);
    expect((await db.query("SELECT 1 FROM who_goes WHERE event_id = 'evt_aws-re-invent-2026' AND seat_status = 'approved'")).length).toBe(12);
    expect(e.reason.length).toBeGreaterThan(40);
    const kinds = (await db.query<{ kind: string }>("SELECT kind FROM involvements WHERE event_id = 'evt_aws-re-invent-2026' ORDER BY kind")).map((r) => r.kind);
    expect(kinds).toEqual(["passes", "sponsorship", "talk"]);
    expect((await db.query("SELECT 1 FROM events WHERE name ILIKE 'Money20/20 USA 2027%'")).length).toBe(0);
    expect((await one<{ stage: string }>(db, "SELECT stage FROM events WHERE id = 'evt_aws-re-invent-2026'")).stage).toBe("paused");
  }, 60_000);
});
