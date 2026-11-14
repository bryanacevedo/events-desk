/* The year plan on Overview (docs/EVENT-PLAN.md 9, 11): every event once, hosted events as their own rows, totals equal the sum of the rows, actual from eventCost. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { setBudgetLine } from "../src/server/budget-lines.ts";
import { recordTicket } from "../src/server/budget.ts";
import { eventCost, recordEventCost } from "../src/server/closeout.ts";
import type { Db } from "../src/server/db.ts";
import { moveEvent } from "../src/server/events.ts";
import type { LifecycleDeps } from "../src/server/lifecycle-deps.ts";
import { addPerson, createPlan, syncAllPlanStages, yearPlan } from "../src/server/plan.ts";
import { freshDb } from "./helpers.ts";
import { approvedPlan, as, CAMILLE, DAN, draftPlan, MAYA, one } from "./plan-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
const at = (day: string) => ({ now: () => new Date(`${day}T12:00:00Z`) }) as LifecycleDeps;
const money = (x: unknown): string[] => Array.isArray(x) ? x.flatMap(money) : x && typeof x === "object" ? Object.entries(x).flatMap(([k, v]) => (/cents/.test(k) ? [k] : money(v))) : [];

async function hosted(name: string, starts_on: string, conference?: string) {
  const { id } = await createPlan(db, CAMILLE, { name, venue: "A restaurant", starts_on, seat_price_cents: 0, reason: "Customers", hosted: { format: "dinner", conference_event_id: conference ?? null } });
  await setBudgetLine(db, CAMILLE, id, { category: "dinners", planned_cents: 400_000 });
  return id;
}

describe("the year plan", () => {
  it("lists every non-declined, non-top-up event once, with a side event as its own row and totals that equal the rows", async () => {
    const conf = await approvedPlan(db, { name: "Summit", starts_on: "2027-06-01", ends_on: "2027-06-03", passes_cents: 300_000 });
    const side = await hosted("Summit Dinner", "2027-06-02", conf);
    const alone = await hosted("Spring Dinner", "2027-03-10");
    const lost = await draftPlan(db, { name: "Lost Expo", starts_on: "2027-08-01", ends_on: "2027-08-02" });
    await moveEvent(db, lost, "declined", DAN, { reason: "No budget" });
    await db.query("INSERT INTO events (id, name, starts_on, seat_count, seat_price_cents, stage, requested_by, parent_event_id) SELECT 'evt_topup', name, starts_on, 0, 0, 'mapped', 'x', id FROM events WHERE id = $1", [conf]);
    await draftPlan(db, { name: "Last Year Expo", starts_on: "2026-02-01", ends_on: "2026-02-02" });
    const y = await yearPlan(db, at("2026-11-13"), CAMILLE, 2027);
    expect(y.events.map((e) => e.name)).toEqual(["Spring Dinner", "Summit", "Summit Dinner"]);
    expect(y.events.map((e) => e.event_id)).toEqual([alone, conf, side]);
    const row = (id: string) => y.events.find((e) => e.event_id === id)!;
    // The side event hangs off the conference by name, and its money is not in the conference's row.
    expect(row(side)).toMatchObject({ conference_event_id: conf, conference_name: "Summit", planned_cents: 400_000, involvement_words: "Dinner" });
    expect(row(conf).planned_cents).toBe(300_000);
    expect(row(conf).involvement_words).toBe("Passes");
    expect(y.total_planned_cents).toBe(y.events.reduce((n, e) => n + e.planned_cents, 0));
    expect(y.total_planned_cents).toBe(1_100_000);
    expect(y.total_contracted_cents).toBe(0);
    expect(y.events.some((e) => e.event_id === "evt_topup" || e.event_id === lost)).toBe(false);
    expect((await yearPlan(db, at("2026-11-13"), CAMILLE, 2026)).events.map((e) => e.name)).toEqual(["Last Year Expo"]);
  });

  it("actual equals the Cost tab to the cent, with a ticket, travel, a ledger line, and a top-up that spent", async () => {
    const id = await approvedPlan(db, { name: "Summit", starts_on: "2027-06-01", ends_on: "2027-06-03", passes_cents: 300_000 });
    const p = await addPerson(db, CAMILLE, id, { person: MAYA, team: "Sales", role_title: "SDR", needs_pass: true });
    await recordTicket(db, DAN, p.seat_request_id!, 900);
    await db.query("UPDATE seat_requests SET travel_cents = 120000 WHERE id = $1", [p.seat_request_id]);
    await recordEventCost(db, id, DAN, "sponsorship", 1_000_000, "Gold");
    await db.query("INSERT INTO events (id, name, starts_on, seat_count, seat_price_cents, stage, requested_by, parent_event_id) SELECT 'evt_topup', name, starts_on, 0, 0, 'mapped', 'x', id FROM events WHERE id = $1", [id]);
    await db.query("INSERT INTO event_settings (event_id, settings) SELECT 'evt_topup', settings FROM event_settings WHERE event_id = $1", [id]);
    await recordEventCost(db, "evt_topup", DAN, "tools", 50_000, "Enrichment");
    const y = await yearPlan(db, at("2026-11-13"), DAN, 2027);
    expect(y.events).toHaveLength(1);
    expect(y.events[0].actual_cents).toBe((await eventCost(db, id)).total_cents);
    expect(y.events[0].actual_cents).toBeGreaterThanOrEqual(90_000 + 120_000 + 1_000_000);
    expect(y.total_actual_cents).toBe(y.events[0].actual_cents);
  });

  it("a rep's year has no key that holds dollars, and a planner's has them", async () => {
    await approvedPlan(db, { name: "Summit", starts_on: "2026-12-05", ends_on: "2026-12-06", passes_cents: 300_000 });
    expect(money(await yearPlan(db, at("2026-11-13"), MAYA))).toEqual([]);
    expect(money(await yearPlan(db, at("2026-11-13"), CAMILLE))).toContain("total_planned_cents");
    const app = createApp(db, { demo: true, lifecycle: at("2026-11-13") });
    const rep = await (await app.request("/api/overview", { headers: as(MAYA) })).json() as { year: { events: unknown[] } };
    expect(rep.year.events).toHaveLength(1);
    expect(money(rep)).toEqual([]);
  });

  it("the plan stage on a row follows the deps clock, and syncPlanStage writes it while the wall clock has not moved", async () => {
    const id = await approvedPlan(db, { name: "Summit", starts_on: "2027-06-01", ends_on: "2027-06-03" });
    expect((await yearPlan(db, at("2026-11-13"), DAN, 2027)).events[0].plan_stage).toBe("confirmed");
    expect((await yearPlan(db, at("2027-06-10"), DAN, 2027)).events[0].plan_stage).toBe("following_up");
    expect((await one<{ plan_stage: string }>(db, "SELECT plan_stage FROM events WHERE id = $1", [id])).plan_stage).toBe("confirmed");
    expect(await syncAllPlanStages(db, at("2027-06-10"))).toBe(1);
    expect((await one<{ plan_stage: string }>(db, "SELECT plan_stage FROM events WHERE id = $1", [id])).plan_stage).toBe("following_up");
  });
});
