/* Leadership approves the budget, not each seat (docs/EVENT-PLAN.md 6.1 and 6.2). Nobody approves their own spend. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { setBudgetLine } from "../src/server/budget-lines.ts";
import { moveEvent } from "../src/server/events.ts";
import { addInvolvement, addPerson, approvePlan, createPlan, declinePlan, planView, submitPlan, updatePlan } from "../src/server/plan.ts";
import { decideSeat, parseSeatRequest, requestSeat } from "../src/server/seats.ts";
import { freshDb } from "./helpers.ts";
import { approvedPlan, as, CAMILLE, DAN, draftPlan, LEO, MAYA, one, TODAY } from "./plan-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
const PRIYA = "Priya Natarajan";
const seats = (id: string) => db.query<{ requester: string; status: string; decided_by: string | null }>("SELECT requester, status, decided_by FROM seat_requests WHERE event_id = $1 ORDER BY created_at, id", [id]);
const stage = async (id: string) => (await one<{ stage: string; plan_stage: string; seat_count: number }>(db, "SELECT stage, plan_stage, seat_count FROM events WHERE id = $1", [id]));

describe("asking for approval", () => {
  it("refuses a plan with no reason, no involvement, no goal or no line", async () => {
    const { id } = await createPlan(db, CAMILLE, { name: "T", starts_on: "2027-06-01", seat_price_cents: 0 });
    await expect(submitPlan(db, CAMILLE, id)).rejects.toThrow("Write why the team is going");
    await updatePlan(db, CAMILLE, id, { reason: "Because the buyers are there." });
    await expect(submitPlan(db, CAMILLE, id)).rejects.toThrow("at least one way the team takes part");
    await addInvolvement(db, CAMILLE, id, { kind: "passes" });
    await expect(submitPlan(db, CAMILLE, id)).rejects.toThrow("Set at least one goal");
    await updatePlan(db, CAMILLE, id, { goal_accounts_met: 5 });
    await expect(submitPlan(db, CAMILLE, id)).rejects.toThrow("at least one budget line");
    await setBudgetLine(db, CAMILLE, id, { category: "passes", planned_cents: 0 });
    await submitPlan(db, CAMILLE, id);
    await expect(submitPlan(db, CAMILLE, id)).rejects.toThrow("already been asked for");
    expect((await one<{ plan_submitted_at: string | null }>(db, "SELECT plan_submitted_at FROM events WHERE id = $1", [id])).plan_submitted_at).not.toBeNull();
  });
});

describe("approving the plan", () => {
  it("the maker cannot approve their own plan, with and without userMap", async () => {
    const id = await draftPlan(db, { maker: DAN });
    await submitPlan(db, DAN, id);
    await expect(approvePlan(db, { eventId: id, actor: DAN })).rejects.toThrow("Nobody can approve their own plan.");
    const live = await draftPlan(db, { maker: DAN, approvers: ["U_DAN"], name: "Live Summit" });
    await submitPlan(db, DAN, live);
    await expect(approvePlan(db, { eventId: live, actor: "U_DAN", userMap: { [DAN]: "U_DAN" } })).rejects.toThrow("Nobody can approve their own plan.");
  });

  it("a non-approver cannot approve, and an unsubmitted plan cannot be approved", async () => {
    const id = await draftPlan(db);
    await expect(approvePlan(db, { eventId: id, actor: DAN })).rejects.toThrow("has not asked for approval");
    await submitPlan(db, CAMILLE, id);
    await expect(approvePlan(db, { eventId: id, actor: MAYA })).rejects.toThrow("is not one of this event's approvers");
    await expect(approvePlan(db, { eventId: id, actor: CAMILLE })).rejects.toThrow("is not one of this event's approvers");
  });

  it("approving moves requested to approved through moveWithin and sets the approver and the amount", async () => {
    const id = await draftPlan(db);
    await submitPlan(db, CAMILLE, id);
    expect(await stage(id)).toMatchObject({ stage: "requested", plan_stage: "planning" });
    const r = await approvePlan(db, { eventId: id, actor: DAN, today: TODAY });
    expect(r.changed).toBe(true);
    expect(await stage(id)).toMatchObject({ stage: "approved", plan_stage: "confirmed" });
    expect(await one(db, "SELECT plan_approved_by, approved_budget_cents::float8 AS a FROM events WHERE id = $1", [id])).toEqual({ plan_approved_by: DAN, a: 300_000 });
    const log = await db.query<{ kind: string; detail: string }>("SELECT kind, detail FROM activity_log WHERE event_id = $1 AND kind IN ('stage', 'approval') ORDER BY created_at, id", [id]);
    expect(log.map((l) => l.detail)).toContain("Approved the plan at $3,000");
  });

  it("declining needs a reason, by moveError and by the database, and keeps the plan stage", async () => {
    const id = await draftPlan(db);
    await submitPlan(db, CAMILLE, id);
    await expect(declinePlan(db, { eventId: id, actor: DAN, reason: " " })).rejects.toThrow("Say why before declining.");
    await declinePlan(db, { eventId: id, actor: DAN, reason: "Budget is spoken for" });
    expect(await one(db, "SELECT stage, plan_stage, decline_reason FROM events WHERE id = $1", [id])).toEqual({ stage: "declined", plan_stage: "planning", decline_reason: "Budget is spoken for" });
    await expect(db.query("UPDATE events SET stage = 'declined', decline_reason = '' WHERE id = $1", [id])).rejects.toThrow();
  });

  it("approves only the seats that fit and leaves the rest pending", async () => {
    // Two passes at 1,000 dollars fit in a 2,000 dollar passes line.
    const id = await draftPlan(db, { passes_cents: 200_000 });
    for (const who of [MAYA, LEO, "Ana Duarte"]) await addPerson(db, CAMILLE, id, { person: who, team: "Sales", role_title: "SDR", needs_pass: true });
    expect((await seats(id)).map((s) => s.status)).toEqual(["pending", "pending", "pending"]);
    await submitPlan(db, CAMILLE, id);
    const r = await approvePlan(db, { eventId: id, actor: DAN, today: TODAY });
    expect(r.approved_seats).toEqual([MAYA, LEO]);
    expect((await seats(id)).map((s) => [s.status, s.decided_by])).toEqual([["approved", DAN], ["approved", DAN], ["pending", null]]);
    expect((await stage(id)).seat_count).toBe(2);
  });

  it("the approver's own seat stays pending, with and without userMap, and a second approver decides it", async () => {
    const id = await draftPlan(db, { approvers: [DAN, PRIYA] });
    await addPerson(db, CAMILLE, id, { person: DAN, team: "Leadership", role_title: "VP", needs_pass: true });
    await addPerson(db, CAMILLE, id, { person: MAYA, team: "Sales", role_title: "SDR", needs_pass: true });
    await submitPlan(db, CAMILLE, id);
    const r = await approvePlan(db, { eventId: id, actor: DAN, today: TODAY });
    expect(r.own_waiting).toEqual([DAN]);
    expect((await seats(id)).map((s) => [s.requester, s.status])).toEqual([[DAN, "pending"], [MAYA, "approved"]]);
    const v = (await planView(db, undefined, id, CAMILLE)) as { notes: string[] };
    expect(v.notes).toContain("Dan Whitlock's own pass waits on another approver.");
    const [dan] = await db.query<{ id: string }>("SELECT id FROM seat_requests WHERE event_id = $1 AND requester = $2", [id, DAN]);
    await expect(decideSeat(db, { requestId: dan.id, actor: DAN, decision: "approve" })).rejects.toThrow("Nobody can approve their own request.");
    await decideSeat(db, { requestId: dan.id, actor: PRIYA, decision: "approve" });
    expect((await seats(id))[0].status).toBe("approved");
    expect((await stage(id)).stage).toBe("approved");
    // The same with a Slack map: the requester is a name, the approver an ID.
    const live = await draftPlan(db, { approvers: ["U_DAN", "U_P"], name: "Live Summit" });
    await addPerson(db, CAMILLE, live, { person: DAN, team: "Leadership", role_title: "VP", needs_pass: true }, { userMap: { [DAN]: "U_DAN" } });
    await submitPlan(db, CAMILLE, live);
    const r2 = await approvePlan(db, { eventId: live, actor: "U_DAN", userMap: { [DAN]: "U_DAN" }, today: TODAY });
    expect(r2.own_waiting).toEqual([DAN]);
  });

  it("a line raised past the approved amount reads over budget, the new seat waits, and approving again approves it once without moving the list", async () => {
    const id = await approvedPlan(db);
    await moveEvent(db, id, "mapped", DAN);
    const before = (await db.query("SELECT 1 FROM activity_log WHERE event_id = $1 AND kind = 'stage'", [id])).length;
    const [line] = await db.query<{ id: string }>("SELECT id FROM budget_lines WHERE event_id = $1", [id]);
    await setBudgetLine(db, CAMILLE, id, { id: line.id, category: "passes", planned_cents: 500_000 });
    const over = (await planView(db, undefined, id, CAMILLE)) as { approval: { over_budget: boolean }; notes: string[] };
    expect(over.approval.over_budget).toBe(true);
    expect(over.notes[0]).toBe("Over the approved budget by $2,000. Waiting on Dan Whitlock.");
    const rep = (await planView(db, undefined, id, MAYA)) as { notes: string[]; budget?: unknown };
    expect(rep.notes[0]).toBe("Over the approved budget. Waiting on Dan Whitlock.");
    expect(rep.budget).toBeUndefined();
    const added = await addPerson(db, CAMILLE, id, { person: MAYA, team: "Sales", role_title: "SDR", needs_pass: true });
    expect(added.seat_status).toBe("pending");
    const r = await approvePlan(db, { eventId: id, actor: DAN, today: TODAY });
    expect(r).toMatchObject({ changed: true, first: false, approved_seats: [MAYA] });
    expect((await seats(id))[0].status).toBe("approved");
    expect((await db.query("SELECT 1 FROM activity_log WHERE event_id = $1 AND kind = 'stage'", [id])).length).toBe(before);
    expect((await db.query("SELECT 1 FROM activity_log WHERE event_id = $1 AND detail = 'Approved the plan again at $5,000'", [id])).length).toBe(1);
    // Approving a plan that is not over and has no waiting seat changes nothing and logs nothing.
    const logs = (await db.query("SELECT 1 FROM activity_log WHERE event_id = $1", [id])).length;
    expect((await approvePlan(db, { eventId: id, actor: DAN, today: TODAY })).changed).toBe(false);
    expect((await db.query("SELECT 1 FROM activity_log WHERE event_id = $1", [id])).length).toBe(logs);
  });

  it("an approval amount of 0 means every plan needs an approver, even a zero-total one; above 0, 'over' is strictly greater", async () => {
    const zero = await draftPlan(db, { passes_cents: 0, price: 0 });
    await submitPlan(db, CAMILLE, zero);
    expect((await one<{ plan_approved_at: string | null }>(db, "SELECT plan_approved_at FROM events WHERE id = $1", [zero])).plan_approved_at).toBeNull();
    for (const [cents, name, auto] of [[500_000, "At the line", true], [500_001, "One cent over", false]] as const) {
      const id = await draftPlan(db, { passes_cents: cents, name });
      await db.query("UPDATE event_settings SET settings = jsonb_set(settings, '{plan,approval_over_cents}', '500000') WHERE event_id = $1", [id]);
      const r = await submitPlan(db, CAMILLE, id, { today: TODAY });
      expect(r.auto_approved).toBe(auto);
      const e = await one<{ plan_approved_by: string | null; stage: string }>(db, "SELECT plan_approved_by, stage FROM events WHERE id = $1", [id]);
      expect(e.plan_approved_by).toBe(auto ? "Under the approval amount" : null);
      expect(e.stage).toBe(auto ? "approved" : "requested");
    }
  });
});

describe("a rep asks to go", () => {
  const catalog = async () => { await db.query("INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents) VALUES ('cat_a', 'Listed Summit', 'Hall', 'Lisbon', 'Portugal', '2027-06-01', '2027-06-03', 'https://example.com', 100000)"); };

  it("makes no second event and leaves one event_people row and one pending seat", async () => {
    await catalog();
    const { id } = await createPlan(db, CAMILLE, { catalog_id: "cat_a", reason: "Buyers are there." });
    const made = await requestSeat(db, MAYA, parseSeatRequest(MAYA, { catalog_id: "cat_a", team: "Sales", role: "SDR" }, { relaxed: true }));
    expect(made).toMatchObject({ event_id: id, budget_mode: true });
    expect((await db.query("SELECT 1 FROM events WHERE catalog_id = 'cat_a'")).length).toBe(1);
    expect(await db.query("SELECT person, roles, team, role_title FROM event_people WHERE event_id = $1", [id])).toEqual([{ person: MAYA, roles: ["attend"], team: "Sales", role_title: "SDR" }]);
    expect((await seats(id)).map((s) => s.status)).toEqual(["pending"]);
    await expect(requestSeat(db, MAYA, parseSeatRequest(MAYA, { catalog_id: "cat_a", team: "Sales", role: "SDR" }, { relaxed: true }))).rejects.toThrow("One seat each");
  });

  it("over HTTP the long answers are optional on a plan and still required on a per-seat event", async () => {
    await catalog();
    await db.query("INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents) VALUES ('cat_b', 'Old Summit', 'Hall', 'Lisbon', 'Portugal', '2027-06-01', '2027-06-03', 'https://example.com', 100000)");
    await createPlan(db, CAMILLE, { catalog_id: "cat_a", reason: "Buyers are there." });
    const app = createApp(db, { demo: true });
    const post = (b: Record<string, unknown>) => app.request("/api/seat-requests", { method: "POST", headers: as(MAYA), body: JSON.stringify(b) });
    expect((await post({ catalog_id: "cat_a", team: "Sales", role: "SDR" })).status).toBe(201);
    expect((await post({ catalog_id: "cat_b", team: "Sales", role: "SDR" })).status).toBe(400);
  });

  it("decideSeat on a budget-mode seat never moves the list stage; approving a seat cannot approve a plan", async () => {
    await catalog();
    const { id } = await createPlan(db, CAMILLE, { catalog_id: "cat_a", reason: "Buyers are there." });
    const made = await requestSeat(db, MAYA, parseSeatRequest(MAYA, { catalog_id: "cat_a", team: "Sales", role: "SDR" }, { relaxed: true }));
    await decideSeat(db, { requestId: made.id, actor: DAN, decision: "approve" });
    expect((await stage(id)).stage).toBe("requested");
    const other = await requestSeat(db, LEO, parseSeatRequest(LEO, { catalog_id: "cat_a", team: "Sales", role: "SDR" }, { relaxed: true }));
    await decideSeat(db, { requestId: other.id, actor: DAN, decision: "decline", reason: "Not this one" });
    await db.query("UPDATE seat_requests SET status = 'declined', decline_reason = 'x' WHERE id = $1", [made.id]);
    expect((await stage(id)).stage).toBe("requested");
  });

  it("createPlan refuses a catalog entry that already has a live event", async () => {
    await catalog();
    await createPlan(db, CAMILLE, { catalog_id: "cat_a" });
    await expect(createPlan(db, CAMILLE, { catalog_id: "cat_a" })).rejects.toThrow("This event already has a plan.");
  });

  it("an event that is not listed gets its catalog entry in the same transaction", async () => {
    const { id } = await createPlan(db, CAMILLE, { name: "Unlisted Forum", starts_on: "2027-05-01", city: "Oslo", country: "Norway" });
    const [c] = await db.query<{ source: string; name: string }>("SELECT c.source, c.name FROM catalog_events c JOIN events e ON e.catalog_id = c.id WHERE e.id = $1", [id]);
    expect(c).toEqual({ source: "listed", name: "Unlisted Forum" });
    expect((await db.query("SELECT 1 FROM approvals WHERE event_id = $1", [id])).length).toBe(0);
  });
});
