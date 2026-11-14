/* The door (docs/HOSTED.md 11, 12, 21.5, 21.13, 21.18): check-in, walk-ins, undo, closing, and who may do it. */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { checkIn, closeAttendance, undoCheckIn, updateGuest, walkIn } from "../src/server/hosted.ts";
import { mockLlm } from "../src/server/providers.ts";
import { addPerson } from "../src/server/plan.ts";
import { freshDb } from "./helpers.ts";
import { AFTER, answered, BEFORE, depsAt, guest, hostedDinner, invite, ON_THE_DAY, statusOf, yes } from "./hosted-helpers.ts";
import { CAMILLE, MAYA } from "./plan-helpers.ts";

const row = async (db: any, gid: string) => (await db.query("SELECT status, prior_status, checked_in_by, source, owner FROM event_guests WHERE id = $1", [gid]))[0];

describe("check-in", () => {
  it("checks in a registered guest, once, and records who", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db);
    const a = await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    const d = depsAt(ON_THE_DAY);
    await checkIn(db, d, "Leo Marsh", id, a);
    expect(await row(db, a)).toMatchObject({ status: "attended", prior_status: "registered", checked_in_by: "Leo Marsh" });
    await expect(checkIn(db, d, CAMILLE, id, a)).rejects.toThrow(/already checked in/);
  });

  it("a walk-in arrives attended, source walk_in, owned by the host by default, and capacity is not enforced at the door", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 1 });
    const a = await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    const d = depsAt(ON_THE_DAY);
    await checkIn(db, d, CAMILLE, id, a);
    const w1 = await walkIn(db, d, CAMILLE, id, { name: "Walt Inn", company: "Drop-in Co" });
    const w2 = await walkIn(db, d, CAMILLE, id, { name: "Wen Inn", email: "wen@dropin.example", owner: MAYA });
    expect(await row(db, w1.id)).toMatchObject({ status: "attended", source: "walk_in", owner: "Camille Laurent" });
    expect(await row(db, w2.id)).toMatchObject({ owner: MAYA });
    expect((await db.query("SELECT count(*)::int AS n FROM event_guests WHERE event_id = $1 AND status = 'attended'", [id]))[0].n).toBe(3);
    await expect(walkIn(db, d, CAMILLE, id, { name: "Wen Inn", email: "wen@dropin.example" })).rejects.toThrow(/already on the list/);
    await expect(walkIn(db, d, CAMILLE, id, { name: "" })).rejects.toThrow(/name/);
  });

  it("undo restores the status the guest had, and a walk-in is not put back", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db);
    const d = depsAt(ON_THE_DAY);
    const w = await guest(db, id, "Lia Listed");
    const a = await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    await checkIn(db, d, CAMILLE, id, w.id);
    await checkIn(db, d, CAMILLE, id, a);
    await undoCheckIn(db, d, CAMILLE, id, w.id);
    await undoCheckIn(db, d, CAMILLE, id, a);
    expect(await statusOf(db, w.id)).toBe("listed");
    expect(await statusOf(db, a)).toBe("registered");
    expect(await row(db, a)).toMatchObject({ prior_status: null, checked_in_by: null });
    const walk = await walkIn(db, d, CAMILLE, id, { name: "Walt Inn" });
    await expect(undoCheckIn(db, d, CAMILLE, id, walk.id)).rejects.toThrow(/walk-in/);
    await expect(undoCheckIn(db, d, CAMILLE, id, a)).rejects.toThrow(/not checked in/);
  });
});

describe("undo keeps the waitlist place and the room", () => {
  it("a waitlisted guest checked in and undone is back on the waitlist with their first place in line", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 1 });
    await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    const w = await yes(db, depsAt(BEFORE), id, "Ben Cole");
    expect(await statusOf(db, w)).toBe("waitlist");
    const [{ at: before }] = await db.query<{ at: string }>("SELECT waitlisted_at::text AS at FROM event_guests WHERE id = $1", [w]);
    await checkIn(db, depsAt(ON_THE_DAY), CAMILLE, id, w);
    await undoCheckIn(db, depsAt(ON_THE_DAY), CAMILLE, id, w);
    const [back] = await db.query<{ status: string; at: string }>("SELECT status, waitlisted_at::text AS at FROM event_guests WHERE id = $1", [w]);
    expect(back).toEqual({ status: "waitlist", at: before });
  });

  it("refuses when going back to registered would put the room over capacity", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 1 });
    const a = await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    await checkIn(db, depsAt(ON_THE_DAY), CAMILLE, id, a);
    await yes(db, depsAt(BEFORE), id, "Ben Cole");
    expect(await statusOf(db, a)).toBe("attended");
    await expect(undoCheckIn(db, depsAt(ON_THE_DAY), CAMILLE, id, a)).rejects.toThrow(/room is full/);
    expect(await statusOf(db, a)).toBe("attended");
  });
});

describe("closing attendance", () => {
  it("refuses before the event's day, then makes every registered guest a no-show and leaves the rest as they were", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 3 });
    const early = depsAt(BEFORE);
    const came = await yes(db, early, id, "Ana Ruiz");
    const missed = await yes(db, early, id, "Ben Cole");
    const wait = await yes(db, depsAt(new Date(BEFORE.getTime() + 9e4), { sender: early.sender }), id, "Cara Fox");
    await yes(db, depsAt(new Date(BEFORE.getTime() + 18e4), { sender: early.sender }), id, "Dan Lee");
    await yes(db, depsAt(new Date(BEFORE.getTime() + 27e4), { sender: early.sender }), id, "Eve Ray");
    const waitlisted = await yes(db, depsAt(new Date(BEFORE.getTime() + 36e4), { sender: early.sender }), id, "Fay Gil");
    const listed = (await guest(db, id, "Gus Hall")).id;
    await expect(closeAttendance(db, early, CAMILLE, id)).rejects.toThrow(/not started/);
    await checkIn(db, depsAt(ON_THE_DAY), CAMILLE, id, came);
    const r = await closeAttendance(db, depsAt(AFTER), CAMILLE, id);
    expect(r).toMatchObject({ attended: 1, no_show: 2 });
    expect(await statusOf(db, came)).toBe("attended");
    expect(await statusOf(db, missed)).toBe("no_show");
    expect(await statusOf(db, waitlisted)).toBe("waitlist");
    expect(await statusOf(db, listed)).toBe("listed");
    void wait;
    expect((await db.query("SELECT closed_at FROM hosted_events WHERE event_id = $1", [id]))[0].closed_at).toBeTruthy();
    await expect(closeAttendance(db, depsAt(AFTER), CAMILLE, id)).rejects.toThrow(/already closed/);
    // A late arrival after closing is checked in, and no_show becomes attended.
    await checkIn(db, depsAt(AFTER), CAMILLE, id, missed);
    expect(await statusOf(db, missed)).toBe("attended");
  });

  it("the door can be closed on the day itself, in the event's own time zone", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db);
    await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    // 02:00 UTC on the 10th is still the 9th in Chicago.
    await expect(closeAttendance(db, depsAt(new Date("2027-06-10T02:00:00Z")), CAMILLE, id)).rejects.toThrow(/not started/);
    await expect(closeAttendance(db, depsAt(new Date("2027-06-10T14:00:00Z")), CAMILLE, id)).resolves.toMatchObject({ no_show: 1 });
  });

  it("a webinar has no check-in, no seating and no door", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { format: "webinar" });
    const g = await guest(db, id, "Ana Ruiz");
    const d = depsAt(ON_THE_DAY);
    await expect(checkIn(db, d, CAMILLE, id, g.id)).rejects.toThrow(/webinar/i);
    await expect(walkIn(db, d, CAMILLE, id, { name: "X Y" })).rejects.toThrow(/webinar/i);
    await expect(closeAttendance(db, depsAt(AFTER), CAMILLE, id)).rejects.toThrow(/webinar/i);
    await expect(invite(db, id, g.id)).rejects.toThrow(/webinar/i);
    await expect(updateGuest(db, CAMILLE, id, g.id, { seat: "Table 2" })).rejects.toThrow(/seating/i);
  });
});

describe("who may check in", () => {
  it("planners and the people on the event's list; not a rep who is not on it; owners write notes and invite only their own", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db);
    await addPerson(db, CAMILLE, id, { person: "Leo Marsh", roles: ["attend"] });
    const a = await answered(db, depsAt(BEFORE), id, "Ana Ruiz");
    const other = await guest(db, id, "Ben Cole", { owner: "Leo Marsh" });
    const app = createApp(db, { demo: true, lifecycle: { connectors: {}, llm: mockLlm, now: () => ON_THE_DAY } as never });
    const as = (who: string) => ({ "x-actor": encodeURIComponent(who), "content-type": "application/json" });
    const post = (who: string, path: string, body: unknown = {}) => app.request(`/api/events/${id}${path}`, { method: "POST", headers: as(who), body: JSON.stringify(body) });
    expect((await post("Priya Natarajan", `/guests/${a}/check-in`)).status).toBe(403);
    expect((await post("Priya Natarajan", "/walk-ins", { name: "Walt Inn" })).status).toBe(403);
    expect((await post("Leo Marsh", `/guests/${a}/check-in`)).status).toBe(200);
    expect((await post("Leo Marsh", `/guests/${a}/undo-check-in`)).status).toBe(200);
    expect((await post("Leo Marsh", "/walk-ins", { name: "Walt Inn" })).status).toBe(201);
    // Moving someone off the waitlist is the host's or a planner's, not any person on the list.
    expect((await post("Leo Marsh", `/guests/${a}/move`, { to: "declined", reason: "x" })).status).toBe(403);
    expect((await post(CAMILLE, "/close-attendance")).status).toBe(200);
    // The guest's owner writes notes, and may log an invitation for their own guest only.
    const patch = (who: string, gid: string, body: unknown) => app.request(`/api/events/${id}/guests/${gid}`, { method: "PATCH", headers: as(who), body: JSON.stringify(body) });
    expect((await patch("Leo Marsh", other.id, { notes: "Wants a follow-up call." })).status).toBe(200);
    expect((await patch("Leo Marsh", other.id, { owner: "Leo Marsh", company: "Nope" })).status).toBe(409);
    expect((await patch("Priya Natarajan", other.id, { notes: "x" })).status).toBe(403);
  });
});
