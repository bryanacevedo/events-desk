/* Involvements (docs/EVENT-PLAN.md 4.1): one event carries several ways to take part; a hosted event is its own event. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { addInvolvement, createPlan, dropInvolvement, planView } from "../src/server/plan.ts";
import { planWaitingOn } from "../src/shared/plan.ts";
import { freshDb } from "./helpers.ts";
import { as, CAMILLE, DAN, draftPlan, MAYA } from "./plan-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

const hosted = (name = "Side dinner", over: Record<string, unknown> = {}) => createPlan(db, CAMILLE, { name, venue: "The Larder", country: "United States", starts_on: "2027-02-24", reason: "Meet buyers in a quiet room.", hosted: { format: "dinner", headcount: 12 }, ...over } as never);

describe("involvements", () => {
  it("one event carries passes, a sponsorship and a talk", async () => {
    const id = await draftPlan(db);
    await addInvolvement(db, CAMILLE, id, { kind: "sponsorship", label: "Gold sponsorship" });
    await addInvolvement(db, CAMILLE, id, { kind: "talk", talk_title: "", speaker: "" });
    const v = (await planView(db, undefined, id, CAMILLE)) as { involvements: { kind: string; talk_title: string | null }[] };
    expect(v.involvements.map((i) => i.kind)).toEqual(["passes", "sponsorship", "talk"]);
    expect(v.involvements[2].talk_title).toBe("");
  });

  it("a hosted event stands alone, with one hosted involvement and no catalog entry", async () => {
    const { id } = await hosted();
    const [e] = await db.query<{ catalog_id: string | null; approval_mode: string; plan_stage: string; stage: string }>("SELECT catalog_id, approval_mode, plan_stage, stage FROM events WHERE id = $1", [id]);
    expect(e).toEqual({ catalog_id: null, approval_mode: "budget", plan_stage: "planning", stage: "requested" });
    const inv = await db.query<{ kind: string; hosted_format: string; headcount: number }>("SELECT kind, hosted_format, headcount FROM involvements WHERE event_id = $1", [id]);
    expect(inv).toEqual([{ kind: "hosted", hosted_format: "dinner", headcount: 12 }]);
  });

  it("a hosted event that names a conference shows on the conference's plan, and its money stays on the child", async () => {
    const conf = await draftPlan(db);
    const { id } = await hosted("Dinner at Test Summit", { hosted: { format: "dinner", conference_event_id: conf } });
    const v = (await planView(db, undefined, conf, CAMILLE)) as { side_events: { id: string; name: string }[]; budget: { total_planned_cents: number } };
    expect(v.side_events.map((s) => s.id)).toEqual([id]);
    expect(v.budget.total_planned_cents).toBe(300_000);
  });

  it("deleting the conference leaves the side event standing alone", async () => {
    const conf = await draftPlan(db);
    const { id } = await hosted("Dinner", { hosted: { format: "dinner", conference_event_id: conf } });
    await db.query("DELETE FROM events WHERE id = $1", [conf]);
    const [i] = await db.query<{ conference_event_id: string | null }>("SELECT conference_event_id FROM involvements WHERE event_id = $1", [id]);
    expect(i.conference_event_id).toBeNull();
    expect((await db.query("SELECT 1 FROM events WHERE id = $1", [id])).length).toBe(1);
  });

  it("a hosted event refuses passes, sponsorship and talk, and the reverse", async () => {
    const { id } = await hosted();
    await expect(addInvolvement(db, CAMILLE, id, { kind: "passes", pass_count: 2 })).rejects.toThrow("A hosted event takes no passes, sponsorship or talk.");
    const conf = await draftPlan(db);
    await expect(addInvolvement(db, CAMILLE, conf, { kind: "hosted", hosted_format: "dinner" })).rejects.toThrow("A hosted event takes no passes, sponsorship or talk.");
  });

  it("a second live hosted involvement is refused, by the code and by the index", async () => {
    const { id } = await hosted();
    await expect(addInvolvement(db, CAMILLE, id, { kind: "hosted", hosted_format: "dinner" })).rejects.toThrow("already a hosted event");
    await expect(db.query("INSERT INTO involvements (id, event_id, kind, hosted_format, created_by) VALUES ('inv_x', $1, 'hosted', 'dinner', 'x')", [id])).rejects.toThrow();
  });

  it("a hosted event's waiting words never mention an attendee list", async () => {
    const { id } = await hosted();
    await db.query("UPDATE events SET stage = 'approved' WHERE id = $1", [id]);
    const v = (await planView(db, undefined, id, CAMILLE)) as { stage_line: { waiting_on: string } };
    expect(v.stage_line.waiting_on).toBe("Nobody");
    expect(planWaitingOn({ stage: "approved", approval_mode: "budget" }, { hosted: true, submitted: true })).not.toMatch(/attendee list/);
  });

  it("a drop with no reason is refused by the code and by the database", async () => {
    const id = await draftPlan(db);
    const [i] = await db.query<{ id: string }>("SELECT id FROM involvements WHERE event_id = $1", [id]);
    await expect(dropInvolvement(db, CAMILLE, id, i.id, "  ")).rejects.toThrow("Say why before dropping it.");
    await expect(db.query("UPDATE involvements SET status = 'dropped' WHERE id = $1", [i.id])).rejects.toThrow();
    await expect(db.query("UPDATE involvements SET status = 'dropped', dropped_reason = '  ' WHERE id = $1", [i.id])).rejects.toThrow();
    await dropInvolvement(db, CAMILLE, id, i.id, "We are not buying passes this year");
    const [d] = await db.query<{ status: string; dropped_reason: string }>("SELECT status, dropped_reason FROM involvements WHERE id = $1", [i.id]);
    expect(d).toEqual({ status: "dropped", dropped_reason: "We are not buying passes this year" });
  });

  it("over HTTP a planner writes and a rep is refused", async () => {
    const app = createApp(db, { demo: true });
    const made = await app.request("/api/plans", { method: "POST", headers: as(CAMILLE), body: JSON.stringify({ name: "Web Summit", starts_on: "2027-11-01", reason: "x", seat_price_cents: 0 }) });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    expect((await app.request(`/api/events/${id}/involvements`, { method: "POST", headers: as(MAYA), body: JSON.stringify({ kind: "talk" }) })).status).toBe(403);
    const ok = await app.request(`/api/events/${id}/involvements`, { method: "POST", headers: as(CAMILLE), body: JSON.stringify({ kind: "talk", talk_title: "Why events" }) });
    expect(ok.status).toBe(201);
    const bad = await app.request(`/api/events/${id}/involvements`, { method: "POST", headers: as(CAMILLE), body: JSON.stringify({ kind: "nonsense" }) });
    expect(bad.status).toBe(400);
    expect((await app.request("/api/plans", { method: "POST", headers: as(MAYA), body: JSON.stringify({ name: "X", starts_on: "2027-11-01" }) })).status).toBe(403);
    void DAN;
  });
});
