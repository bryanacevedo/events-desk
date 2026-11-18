/* The meeting goal tracker (docs/CHOOSING.md section 5): phases, what counts, one held figure with the Result, by rep, and accounts met. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { goalTracker } from "../src/server/goal-tracker.ts";
import { bookMeeting, recordOutcome } from "../src/server/meetings.ts";
import { goalResult, updatePlan } from "../src/server/plan.ts";
import { freshDb } from "./helpers.ts";
import { clock, deliveredInMotion, fakeCrm, MAYA, personAt, type Harness } from "./lifecycle-harness.ts";
import { as, CAMILLE } from "./plan-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

const LEO = "Leo Marsh";
async function event(today: string, starts = "2027-01-10", ends = "2027-01-12") {
  const h = await deliveredInMotion(db, { crm: fakeCrm(), time: clock(`${today}T12:00:00Z`) });
  await db.query("UPDATE events SET starts_on = $2, ends_on = $3, catalog_id = NULL WHERE id = $1", [h.id, starts, ends]);
  await updatePlan(db, CAMILLE, h.id, { goal_meetings_held: 30 });
  return h;
}
async function meet(h: Harness, who: string, status: "booked" | "held" | "no_show" | "cancelled" | "proposed" | "rescheduled", rep: string | null = MAYA, at = "2027-01-11T15:00:00Z") {
  const p = await personAt(db, h.id, who);
  const m = await bookMeeting(db, h.deps, { contact_id: p.id, scheduled_at: at, source: "manual", rep, status: status === "proposed" ? "proposed" : "booked" }, MAYA);
  if (status === "held" || status === "no_show" || status === "cancelled") await recordOutcome(db, h.deps, m.id, status, MAYA);
  else if (status === "rescheduled") await db.query("UPDATE meetings SET status = 'rescheduled' WHERE id = $1", [m.id]);
  if (rep === null) await db.query("UPDATE meetings SET rep = NULL WHERE id = $1", [m.id]);
  return m.id;
}
const going = (h: Harness, person: string, roles = ["attend"]) => db.query("INSERT INTO event_people (id, event_id, person, roles, added_by) VALUES ($1, $2, $3, $4::text[], 'x')", [crypto.randomUUID(), h.id, person, roles]);

describe("goal tracker", () => {
  it("is null with no goal or a goal of 0", async () => {
    const h = await event("2027-01-01");
    await db.query("UPDATE events SET goal_meetings_held = NULL WHERE id = $1", [h.id]);
    expect(await goalTracker(db, h.deps, h.id)).toEqual({ goal: null });
    await db.query("UPDATE events SET goal_meetings_held = 0 WHERE id = $1", [h.id]);
    expect(await goalTracker(db, h.deps, h.id)).toEqual({ goal: null });
    await expect(goalTracker(db, h.deps, "nope")).rejects.toThrow("does not exist");
  });

  it("before: held and booked count, rescheduled stays live, the rest never count, and the words say days out", async () => {
    const h = await event("2027-01-01");
    await meet(h, "Ana Ruiz", "booked");
    await meet(h, "Ben Ode", "rescheduled");
    await meet(h, "Cleo Park", "held");
    await meet(h, "Dan Ito", "no_show");
    const t = await goalTracker(db, h.deps, h.id);
    expect(t).toMatchObject({ goal: 30, phase: "before", held: 1, booked: 2, counted: 3, days_out: 9, words: "3 of 30 meetings booked, 9 days out" });
    await db.query("UPDATE events SET starts_on = '2027-01-02' WHERE id = $1", [h.id]);
    expect((await goalTracker(db, h.deps, h.id)).words).toBe("3 of 30 meetings booked, 1 day out");
  });

  it("a person with a held and a booked meeting counts once, as held", async () => {
    const h = await event("2027-01-01");
    await meet(h, "Ana Ruiz", "held", MAYA, "2027-01-11T15:00:00Z");
    await meet(h, "Ana Ruiz", "booked", MAYA, "2027-01-12T15:00:00Z");
    expect(await goalTracker(db, h.deps, h.id)).toMatchObject({ held: 1, booked: 0, counted: 1 });
  });

  it("during: day of days, booked or held", async () => {
    const h = await event("2027-01-11");
    await meet(h, "Ana Ruiz", "booked");
    await meet(h, "Ben Ode", "held");
    expect(await goalTracker(db, h.deps, h.id)).toMatchObject({ phase: "during", day: 2, days: 3, counted: 2, words: "2 of 30 meetings booked or held, day 2 of 3" });
  });

  it("after: held only, read from the Result so there is one held figure, and booked ones wait for an outcome", async () => {
    const h = await event("2027-02-15");
    await meet(h, "Ana Ruiz", "held");
    await meet(h, "Ben Ode", "held");
    await meet(h, "Cleo Park", "booked");
    const t = await goalTracker(db, h.deps, h.id);
    expect(t).toMatchObject({ phase: "after", held: 2, waiting: 1, counted: 2, ended_days_ago: 34, words: "2 of 30 meetings held, ended 34 days ago, 1 booked and waiting for an outcome" });
    expect(t.held).toBe((await goalResult(db, h.deps, h.id)).meetings!.actual);
    await db.query("UPDATE meetings SET status = 'cancelled' WHERE status = 'booked' AND event_id = $1", [h.id]);
    expect((await goalTracker(db, h.deps, h.id)).words).toBe("2 of 30 meetings held, ended 34 days ago");
  });

  it("by rep: going and nothing booked, a rep with meetings who is not going, and meetings with no rep", async () => {
    const h = await event("2027-01-01");
    await going(h, MAYA); await going(h, LEO); await going(h, "Priya Natarajan", ["speak"]);
    await meet(h, "Ana Ruiz", "held", MAYA);
    await meet(h, "Ben Ode", "booked", "maya okafor");
    await meet(h, "Cleo Park", "booked", "Outside Rep");
    await meet(h, "Dan Ito", "booked", null);
    const t = await goalTracker(db, h.deps, h.id);
    expect(t.by_rep).toEqual([
      { rep: MAYA, going: true, held: 1, booked: 1, nothing_booked: false },
      { rep: "Outside Rep", going: false, held: 0, booked: 1, nothing_booked: false },
      { rep: LEO, going: true, held: 0, booked: 0, nothing_booked: true },
    ]);
    expect(t.nothing_booked).toEqual([LEO]);
    expect(t.no_rep).toBe(1);
    expect(t.counted).toBe(4);
  });

  it("a per-seat request shows through who goes, and a declined one does not", async () => {
    const h = await event("2027-01-01");
    await db.query("INSERT INTO seat_requests (id, event_id, requester, team, role, goal, why_event, why_you, expected_meetings, status) VALUES ('s1', $1, $2, 'Sales', 'SDR', 'g', 'a', 'b', 3, 'approved'), ('s2', $1, 'Nina West', 'Sales', 'SDR', 'g', 'a', 'b', 3, 'declined')", [h.id, LEO]);
    expect((await goalTracker(db, h.deps, h.id)).nothing_booked).toEqual([LEO]);
  });

  it("held counts each person once and skips a held meeting with no contact, so the figure is the same before, during and after", async () => {
    const h = await event("2027-01-01");
    await meet(h, "Ana Ruiz", "held"); await meet(h, "Ana Ruiz", "held", MAYA, "2027-01-12T15:00:00Z"); const orphan = await meet(h, "Ben Ode", "held");
    await db.query("UPDATE meetings SET contact_id = NULL WHERE id = $1", [orphan]);
    const phases: number[] = [];
    for (const day of ["2027-01-01", "2027-01-11", "2027-02-20"]) {
      const t = await goalTracker(db, { ...h.deps, now: () => new Date(`${day}T12:00:00Z`) } as never, h.id);
      phases.push(t.held!);
    }
    expect(phases).toEqual([1, 1, 1]);
  });

  it("accounts met: target accounts when the team has them, tier 1 companies when it has none, and the caption says which", async () => {
    const h = await event("2027-02-15");
    await db.query("UPDATE companies SET tier = 1 WHERE event_id = $1", [h.id]);
    await updatePlan(db, CAMILLE, h.id, { goal_accounts_met: 4 });
    await meet(h, "Ana Ruiz", "held"); await meet(h, "Ben Ode", "held"); await meet(h, "Cleo Park", "held");
    let r = await goalResult(db, h.deps, h.id);
    expect(r.accounts).toEqual({ goal: 4, actual: 2, short_by: 2 });
    expect(r.accounts_basis).toBe("tier1");
    expect((await goalTracker(db, h.deps, h.id)).accounts).toEqual({ goal: 4, actual: 2, basis: "tier1", caption: "tier 1 companies" });
    // The list names Tallgrass by domain, Brightwater by name, and one company not met.
    const [d] = await db.query<{ domain: string }>("SELECT primary_domain AS domain FROM companies WHERE event_id = $1 AND name = 'Tallgrass Software'", [h.id]);
    await db.query("INSERT INTO target_accounts (id, name, domain, created_by) VALUES ('a1', 'Tallgrass', $1, 'x'), ('a2', 'Brightwater Software Inc', NULL, 'x'), ('a3', 'Elsewhere', 'elsewhere.com', 'x')", [d.domain]);
    r = await goalResult(db, h.deps, h.id);
    expect(r.accounts).toEqual({ goal: 4, actual: 2, short_by: 2 });
    expect(r.accounts_basis).toBe("target_list");
    await db.query("UPDATE companies SET tier = 2 WHERE event_id = $1", [h.id]);
    expect((await goalResult(db, h.deps, h.id)).accounts?.actual).toBe(2);
    await db.query("DELETE FROM target_accounts WHERE id = 'a2'");
    expect((await goalTracker(db, h.deps, h.id)).accounts).toEqual({ goal: 4, actual: 1, basis: "target_list", caption: "from your target account list" });
  });

  it("answers over HTTP to a rep and a planner with counts and no money key", async () => {
    const h = await event("2027-01-01");
    await meet(h, "Ana Ruiz", "booked");
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    for (const who of [MAYA, CAMILLE]) {
      const r = await app.request(`/api/events/${h.id}/goal-tracker`, { headers: as(who) });
      expect(r.status).toBe(200);
      const body = await r.json() as { counted: number };
      expect(body.counted).toBe(1);
      expect(JSON.stringify(body)).not.toMatch(/cents|\$\d/);
    }
    expect((await app.request("/api/events/nope/goal-tracker", { headers: as(MAYA) })).status).toBe(404);
  });
});
