/* Who goes: one row a person, at most one pass, whatever their roles. A pass is still a seat_requests row. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { recordTicket } from "../src/server/budget.ts";
import { addPerson, createPlan, removePerson, updatePerson } from "../src/server/plan.ts";
import { requestSeat, parseSeatRequest } from "../src/server/seats.ts";
import { freshDb } from "./helpers.ts";
import { approvedPlan, CAMILLE, DAN, draftPlan, LEO, MAYA, one } from "./plan-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

describe("who goes", () => {
  it("a person who attends and speaks is one row and one seat, carrying their team and job", async () => {
    const id = await draftPlan(db);
    const r = await addPerson(db, CAMILLE, id, { person: MAYA, roles: ["attend", "speak"], team: "Sales", role_title: "SDR", needs_pass: true });
    const people = await db.query<{ person: string; roles: string[] }>("SELECT person, roles FROM event_people WHERE event_id = $1", [id]);
    expect(people).toEqual([{ person: MAYA, roles: ["attend", "speak"] }]);
    const seats = await db.query<{ team: string; role: string; goal: string; status: string; why_event: string; expected_meetings: number }>("SELECT team, role, goal, status, why_event, expected_meetings FROM seat_requests WHERE event_id = $1", [id]);
    expect(seats).toEqual([{ team: "Sales", role: "SDR", goal: "new_pipeline", status: "pending", why_event: "The buyers we sell to are in the room.", expected_meetings: 0 }]);
    expect(r.seat_request_id).toBe((await one<{ id: string }>(db, "SELECT id FROM seat_requests WHERE event_id = $1", [id])).id);
  });

  it("adding the same person twice is refused, and a pass needs a team and a job", async () => {
    const id = await draftPlan(db);
    await addPerson(db, CAMILLE, id, { person: MAYA, roles: ["speak"] });
    await expect(addPerson(db, CAMILLE, id, { person: MAYA, roles: ["attend"] })).rejects.toThrow("already on this event");
    await expect(addPerson(db, CAMILLE, id, { person: LEO, needs_pass: true, team: "Sales" })).rejects.toThrow("team and job");
    // A speaker added first can ask for their one pass later, and only one.
    await updatePerson(db, CAMILLE, id, (await one<{ id: string }>(db, "SELECT id FROM event_people WHERE person = $1", [MAYA])).id, { needs_pass: true, team: "Sales", role_title: "SDR", roles: ["speak", "attend"] });
    expect((await db.query("SELECT 1 FROM seat_requests WHERE event_id = $1", [id])).length).toBe(1);
    await expect(db.query("INSERT INTO event_people (id, event_id, person, roles, added_by) VALUES ('ppl_dup', $1, $2, ARRAY['host']::text[], 'x')", [id, MAYA])).rejects.toThrow();
  });

  it("removing a person needs a reason, declines their seat with it, and seat_count follows", async () => {
    const id = await approvedPlan(db, { passes_cents: 300_000 });
    const a = await addPerson(db, CAMILLE, id, { person: MAYA, team: "Sales", role_title: "SDR", needs_pass: true });
    await addPerson(db, CAMILLE, id, { person: LEO, team: "Sales", role_title: "AE", needs_pass: true });
    expect((await one<{ seat_count: number }>(db, "SELECT seat_count FROM events WHERE id = $1", [id])).seat_count).toBe(2);
    const pid = (await one<{ id: string }>(db, "SELECT id FROM event_people WHERE person = $1", [MAYA])).id;
    await expect(removePerson(db, CAMILLE, id, pid, " ")).rejects.toThrow("Say why before taking someone off.");
    await expect(db.query("UPDATE event_people SET removed_at = now() WHERE id = $1", [pid])).rejects.toThrow();
    await removePerson(db, CAMILLE, id, pid, "Cannot travel");
    expect(await one(db, "SELECT status, decline_reason, decided_by FROM seat_requests WHERE id = $1", [a.seat_request_id])).toEqual({ status: "declined", decline_reason: "Cannot travel", decided_by: CAMILLE });
    expect((await one<{ seat_count: number }>(db, "SELECT seat_count FROM events WHERE id = $1", [id])).seat_count).toBe(1);
    expect((await db.query("SELECT 1 FROM who_goes WHERE event_id = $1", [id])).length).toBe(1);
  });

  it("removing a person whose ticket is recorded is refused", async () => {
    const id = await approvedPlan(db);
    const a = await addPerson(db, CAMILLE, id, { person: MAYA, team: "Sales", role_title: "SDR", needs_pass: true });
    await recordTicket(db, DAN, a.seat_request_id!, 900);
    const pid = (await one<{ id: string }>(db, "SELECT id FROM event_people WHERE person = $1", [MAYA])).id;
    await expect(removePerson(db, CAMILLE, id, pid, "Changed plans")).rejects.toThrow("A ticket is recorded for this person. Take the ticket off first.");
    expect((await one<{ status: string }>(db, "SELECT status FROM seat_requests WHERE id = $1", [a.seat_request_id])).status).toBe("approved");
  });

  it("a hosted event takes hosts and no passes", async () => {
    const { id } = await createPlan(db, CAMILLE, { name: "Dinner", starts_on: "2027-02-01", hosted: { format: "dinner" } });
    await addPerson(db, CAMILLE, id, { person: MAYA, roles: ["host"] });
    await expect(addPerson(db, CAMILLE, id, { person: LEO, roles: ["host", "attend"], team: "Sales", role_title: "AE", needs_pass: true })).rejects.toThrow("A hosted event takes no passes.");
    expect((await db.query("SELECT 1 FROM seat_requests WHERE event_id = $1", [id])).length).toBe(0);
  });

  it("who_goes shows a per-seat event's requests with no event_people row", async () => {
    await db.query("INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents) VALUES ('cat_a', 'Old', 'Hall', 'Lisbon', 'Portugal', '2027-06-01', '2027-06-03', 'https://example.com', 100000)");
    const made = await requestSeat(db, MAYA, parseSeatRequest(MAYA, { catalog_id: "cat_a", team: "Sales", role: "SDR", goal: "new_pipeline", why_event: "Their buyers are the people we sell to.", why_you: "I run outreach for this region and know the accounts.", expected_meetings: 3 }));
    expect((await db.query("SELECT 1 FROM event_people WHERE event_id = $1", [made.event_id])).length).toBe(0);
    expect(await db.query("SELECT person, roles, seat_status FROM who_goes WHERE event_id = $1", [made.event_id])).toEqual([{ person: MAYA, roles: ["attend"], seat_status: "pending" }]);
  });
});
