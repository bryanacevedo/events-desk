/* Budget lines hold planned and contracted. Actual is read from eventCost, never stored, so the plan, the Cost tab and the Result cannot disagree. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { eventBudget, removeBudgetLine, setBudgetLine, yearBudget } from "../src/server/budget-lines.ts";
import { recordTicket } from "../src/server/budget.ts";
import { eventCost, recordEventCost } from "../src/server/closeout.ts";
import type { Db } from "../src/server/db.ts";
import { addInvolvement, addPerson } from "../src/server/plan.ts";
import { saveSponsorship } from "../src/server/sponsorship.ts";
import { freshDb } from "./helpers.ts";
import { deliveredInMotion, fakeCrm } from "./lifecycle-harness.ts";
import { approvedPlan, as, CAMILLE, DAN, draftPlan, MAYA, one } from "./plan-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
const cat = async (id: string, c: string) => (await eventBudget(db, id)).categories.find((x) => x.category === c)!;

describe("budget lines", () => {
  it("each category has planned, contracted and actual; actual for passes is the tickets recorded", async () => {
    const id = await approvedPlan(db, { passes_cents: 300_000 });
    const [line] = await db.query<{ id: string }>("SELECT id FROM budget_lines WHERE event_id = $1", [id]);
    await setBudgetLine(db, CAMILLE, id, { id: line.id, category: "passes", planned_cents: 300_000, contracted_cents: 250_000 });
    const p = await addPerson(db, CAMILLE, id, { person: MAYA, team: "Sales", role_title: "SDR", needs_pass: true });
    expect(p.seat_status).toBe("approved");
    expect(await cat(id, "passes")).toMatchObject({ planned_cents: 300_000, contracted_cents: 250_000, actual_cents: 0 });
    await recordTicket(db, DAN, p.seat_request_id!, 900);
    expect((await cat(id, "passes")).actual_cents).toBe(90_000);
    expect((await one<{ n: number }>(db, "SELECT sum(amount_cents)::int AS n FROM ticket_purchases WHERE event_id = $1", [id])).n).toBe(90_000);
  });

  it("actual for a ledger category is the ledger line, and null until one is entered", async () => {
    const id = await draftPlan(db);
    await addInvolvement(db, CAMILLE, id, { kind: "sponsorship" });
    await setBudgetLine(db, CAMILLE, id, { category: "sponsorship", planned_cents: 1_500_000 });
    expect((await cat(id, "sponsorship")).actual_cents).toBeNull();
    await recordEventCost(db, id, DAN, "sponsorship", 1_250_000, "Gold");
    expect(await cat(id, "sponsorship")).toMatchObject({ planned_cents: 1_500_000, contracted_cents: null, actual_cents: 1_250_000 });
  });

  it("two planned lines in one category sum, with one actual", async () => {
    const id = await draftPlan(db);
    await setBudgetLine(db, CAMILLE, id, { category: "booth", label: "Booth space", planned_cents: 100_000 });
    await setBudgetLine(db, CAMILLE, id, { category: "booth", label: "Booth build", planned_cents: 50_000, contracted_cents: 40_000 });
    await recordEventCost(db, id, DAN, "booth", 140_000, "");
    const booth = await cat(id, "booth");
    expect(booth).toMatchObject({ planned_cents: 150_000, contracted_cents: 40_000, actual_cents: 140_000 });
    expect(booth.line_ids.length).toBe(2);
  });

  it("a sponsorship involvement has one budget line, and a second is refused", async () => {
    const id = await draftPlan(db);
    const { id: inv } = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship" });
    await setBudgetLine(db, CAMILLE, id, { category: "sponsorship", involvement_id: inv, planned_cents: 100 });
    await expect(setBudgetLine(db, CAMILLE, id, { category: "sponsorship", involvement_id: inv, planned_cents: 200 })).rejects.toThrow("already has its budget line");
    await expect(db.query("INSERT INTO budget_lines (id, event_id, involvement_id, category, planned_cents, updated_by) VALUES ('bln_x', $1, $2, 'sponsorship', 1, 'x')", [id, inv])).rejects.toThrow();
  });

  it("refuses a bad category, a negative amount and a declined event, and a removed line is gone", async () => {
    const id = await draftPlan(db);
    await expect(setBudgetLine(db, CAMILLE, id, { category: "yacht", planned_cents: 1 })).rejects.toThrow("A budget line is one of");
    await expect(setBudgetLine(db, CAMILLE, id, { category: "swag", planned_cents: -5 })).rejects.toThrow("zero or more");
    const { id: line } = await setBudgetLine(db, CAMILLE, id, { category: "swag", planned_cents: 5000 });
    await removeBudgetLine(db, CAMILLE, id, line);
    expect((await eventBudget(db, id)).lines.some((l) => l.id === line)).toBe(false);
  });

  it("no key of the new reads says committed, and the year lists each event once with totals that add up", async () => {
    const a = await approvedPlan(db, { starts_on: "2027-06-01", name: "A Summit" });
    const b = await draftPlan(db, { starts_on: "2027-07-01", ends_on: "2027-07-02", name: "B Summit", passes_cents: 100_000 });
    const keys = (x: unknown): string[] => (Array.isArray(x) ? x.flatMap(keys) : x && typeof x === "object" ? Object.entries(x).flatMap(([k, v]) => [k, ...keys(v)]) : []);
    expect(keys(await eventBudget(db, a)).filter((k) => /commit/i.test(k))).toEqual([]);
    const y = await yearBudget(db, 2027);
    expect(y.events.map((e) => e.event_id).sort()).toEqual([a, b].sort());
    expect(y.total_planned_cents).toBe(400_000);
    expect(y.total_planned_cents).toBe(y.events.reduce((n, e) => n + e.planned_cents, 0));
    expect(keys(y).filter((k) => /commit/i.test(k))).toEqual([]);
  });

  it("the event's actual total equals eventCost to the cent, with a ticket, travel, a ledger line and AI all present", async () => {
    const h = await deliveredInMotion(db, { crm: fakeCrm() });
    const id = h.id;
    await db.query("INSERT INTO seat_requests (id, event_id, requester, team, role, goal, why_event, why_you, expected_meetings, status, travel_cents, decided_by) VALUES ('sr_t', $1, 'Maya Ortiz', 'Sales', 'SDR', 'new_pipeline', '', '', 0, 'approved', 45000, 'Dan Whitlock')", [id]);
    await recordTicket(db, DAN, "sr_t", 700);
    await recordEventCost(db, id, DAN, "booth", 220_000, "");
    await setBudgetLine(db, CAMILLE, id, { category: "booth", planned_cents: 200_000 });
    const cost = await eventCost(db, id);
    expect(cost.ai_cents).toBeGreaterThan(0);
    const b = await eventBudget(db, id);
    expect(b.total_actual_cents).toBe(cost.total_cents);
    expect(cost.total_cents).toBe(cost.tickets_cents + cost.travel_cents + cost.ai_cents + cost.other_cents);
    expect(b.categories.find((c) => c.category === "travel")?.actual_cents).toBe(45_000);
    expect(b.categories.find((c) => c.category === "passes")?.actual_cents).toBe(70_000);
    expect(b.ai_actual_cents).toBe(cost.ai_cents);
    // Entering the ledger line is the only place actual is typed: the plan stored none.
    expect(JSON.stringify(await db.query("SELECT * FROM budget_lines WHERE event_id = $1", [id]))).not.toMatch(/actual/);
  });

  it("over HTTP a planner reads and writes lines, a rep is refused with the money sentence", async () => {
    const id = await draftPlan(db);
    const app = createApp(db, { demo: true });
    const get = (who: string) => app.request(`/api/events/${id}/budget-lines`, { headers: as(who) });
    expect((await get(CAMILLE)).status).toBe(200);
    expect((await get(MAYA)).status).toBe(403);
    expect(((await (await get(MAYA)).json()) as { error: string }).error).toBe("Company money is for leadership and GTM Engineering.");
    const put = await app.request(`/api/events/${id}/budget-lines`, { method: "POST", headers: as(CAMILLE), body: JSON.stringify({ category: "swag", planned_cents: 5000 }) });
    expect(put.status).toBe(201);
    expect((await app.request(`/api/events/${id}/budget-lines`, { method: "POST", headers: as(MAYA), body: JSON.stringify({ category: "swag", planned_cents: 5000 }) })).status).toBe(403);
  });
});

describe("the sponsorship's budget line", () => {
  it("saving an unsigned package writes planned, signing writes contracted once, and saving twice never makes a second line", async () => {
    const id = await approvedPlan(db);
    const { id: iid } = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship", label: "Gold" });
    const lines = () => db.query<{ planned_cents: number; contracted_cents: number | null }>("SELECT planned_cents::float8 AS planned_cents, contracted_cents::float8 AS contracted_cents FROM budget_lines WHERE event_id = $1 AND category = 'sponsorship'", [id]);
    await saveSponsorship(db, CAMILLE, id, iid, { tier: "Gold", price_cents: 2_500_000 });
    expect(await lines()).toEqual([{ planned_cents: 2_500_000, contracted_cents: null }]);
    await saveSponsorship(db, CAMILLE, id, iid, { contract_signed_on: "2026-11-01" });
    await saveSponsorship(db, CAMILLE, id, iid, { contract_signed_on: "2026-11-01" });
    expect(await lines()).toEqual([{ planned_cents: 2_500_000, contracted_cents: 2_500_000 }]);
    // A price change after signing moves the contracted figure; unsigning again clears it.
    await saveSponsorship(db, CAMILLE, id, iid, { price_cents: 2_400_000 });
    expect((await lines())[0].contracted_cents).toBe(2_400_000);
    await saveSponsorship(db, CAMILLE, id, iid, { contract_signed_on: null });
    expect(await lines()).toEqual([{ planned_cents: 2_400_000, contracted_cents: null }]);
    // Paying is the ledger's: actual is read from eventCost, and the package stores no paid amount.
    await recordEventCost(db, id, DAN, "sponsorship", 1_000_000, "Deposit");
    expect((await cat(id, "sponsorship")).actual_cents).toBe(1_000_000);
    expect((await eventBudget(db, id)).total_actual_cents).toBe((await eventCost(db, id)).total_cents);
  });

  it("the package saved through the route is planner-only and its keys never say committed", async () => {
    const id = await approvedPlan(db);
    const { id: iid } = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship" });
    const app = createApp(db, { demo: true });
    const put = (who: string, b: object) => app.request(`/api/events/${id}/sponsorships/${iid}`, { method: "PUT", headers: as(who), body: JSON.stringify(b) });
    expect((await put(MAYA, { price_cents: 100 })).status).toBe(403);
    expect((await put(CAMILLE, { price_cents: -5 })).status).toBe(400);
    expect((await put(CAMILLE, { price_cents: 100, deposit_cents: 500 })).status).toBe(400);
    expect((await put(CAMILLE, { price_cents: 2_000_000, tier: "Gold", deposit_cents: 500_000, deposit_due_on: "2026-12-01" })).status).toBe(200);
    expect((await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM sponsorships WHERE event_id = $1", [id])).n).toBe(1);
    const view = await (await app.request(`/api/events/${id}/plan`, { headers: as(CAMILLE) })).json();
    expect(JSON.stringify(view)).not.toMatch(/committed/);
  });
});

