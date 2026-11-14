/* The RSVP state machine, row by row (docs/HOSTED.md 5 and 21.5), and the same rules through the database. */

import { describe, expect, it } from "vitest";
import { GUEST_STATUSES, importMove, REFUSAL, transition, undoTransition, type GuestStatus, type MoveContext } from "../src/shared/rsvp.ts";
import { freshDb } from "./helpers.ts";
import { answerRsvp } from "../src/server/rsvp.ts";
import { checkIn, closeAttendance, moveGuest, undoCheckIn } from "../src/server/hosted.ts";
import { AFTER, BEFORE, depsAt, guest, hostedDinner, invite, ON_THE_DAY, statusOf, tokenOf, yes } from "./hosted-helpers.ts";
import { CAMILLE } from "./plan-helpers.ts";

const ok = (from: GuestStatus, to: GuestStatus, ctx: MoveContext) => expect(transition(from, to, ctx), `${from} to ${to} by ${ctx.by}`).toBeNull();
const no = (from: GuestStatus, to: GuestStatus, ctx: MoveContext) => expect(transition(from, to, ctx), `${from} to ${to} by ${ctx.by}`).toEqual(expect.any(String));

describe("transition, every row of the table", () => {
  it("the host logs an invitation: listed to invited, and a nudge stays invited", () => {
    ok("listed", "invited", { by: "host" });
    ok("invited", "invited", { by: "host" });
    no("invited", "invited", { by: "guest" });
    no("listed", "invited", { by: "guest" });
    no("registered", "invited", { by: "host" });
  });
  it("a guest's yes registers with room and waitlists at capacity, never the other way", () => {
    for (const from of ["listed", "invited", "declined"] as const) {
      ok(from, "registered", { by: "guest", atCapacity: false });
      ok(from, "waitlist", { by: "guest", atCapacity: true });
      expect(transition(from, "registered", { by: "guest", atCapacity: true })).toBe(REFUSAL.full);
      expect(transition(from, "waitlist", { by: "guest", atCapacity: false })).toBe(REFUSAL.room);
    }
    no("attended", "registered", { by: "guest" });
    no("no_show", "registered", { by: "guest" });
  });
  it("a repeated yes edits dietary text, in place", () => {
    ok("registered", "registered", { by: "guest" });
    ok("waitlist", "waitlist", { by: "guest" });
    no("registered", "registered", { by: "host" });
  });
  it("after the day began a yes is refused with one sentence", () => {
    expect(transition("invited", "registered", { by: "guest", dayBegan: true })).toBe(REFUSAL.passed);
    expect(transition("registered", "registered", { by: "guest", dayBegan: true })).toBe(REFUSAL.passed);
  });
  it("a no, from any open status, and the host's move to declined needs a reason", () => {
    for (const from of ["listed", "invited", "registered", "waitlist"] as const) { ok(from, "declined", { by: "guest" }); ok(from, "declined", { by: "host", reason: "Called to say" }); no(from, "declined", { by: "host" }); }
    no("declined", "declined", { by: "guest" });
    no("attended", "declined", { by: "guest" });
  });
  it("promotion and the host's move take a waitlisted guest to registered", () => {
    ok("waitlist", "registered", { by: "system" });
    ok("waitlist", "registered", { by: "host" });
    no("waitlist", "registered", { by: "guest" });
    no("registered", "waitlist", { by: "host" });
  });
  it("check-in takes anyone who is not already in, including a declined guest and a no-show", () => {
    for (const from of ["listed", "invited", "registered", "waitlist", "declined", "no_show"] as const) ok(from, "attended", { by: "host" });
    no("attended", "attended", { by: "host" });
    no("registered", "attended", { by: "guest" });
  });
  it("closing makes a registered guest a no-show, only from the event's day", () => {
    ok("registered", "no_show", { by: "system", dayBegan: true });
    no("registered", "no_show", { by: "system" });
    for (const from of ["listed", "invited", "waitlist", "declined", "attended"] as const) no(from, "no_show", { by: "system", dayBegan: true });
  });
  it("a guest is never attended and declined at once: no other move is legal", () => {
    for (const from of GUEST_STATUSES) for (const to of GUEST_STATUSES) {
      if (from === to) continue;
      const e = transition(from, to, { by: "host", reason: "x", dayBegan: true });
      if (to === "listed") expect(e).not.toBeNull();
      if (from === "attended") expect(e, `${from} to ${to}`).not.toBeNull();
    }
  });
  it("undo needs a prior status and an open door", () => {
    expect(undoTransition("registered", {})).toBeNull();
    expect(undoTransition("registered", { closed: true })).toBe(REFUSAL.closed);
    expect(undoTransition(null, {})).toMatch(/walk-in/);
  });
  it("an import moves forward only: listed, invited, waitlist, registered, attended", () => {
    expect(importMove("listed", "registered")).toBe(true);
    expect(importMove("registered", "attended")).toBe(true);
    expect(importMove("registered", "waitlist")).toBe(false);
    expect(importMove("declined", "registered")).toBe(false);
    expect(importMove("no_show", "registered")).toBe(false);
    expect(importMove("declined", "attended")).toBe(true);
    expect(importMove("no_show", "attended")).toBe(true);
    expect(importMove("attended", "registered")).toBe(false);
  });
});

describe("the writers use it", () => {
  it("a guest who declines frees the place and the first waitlisted guest moves up", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 1 });
    const d = depsAt(BEFORE);
    const a = await yes(db, d, id, "Ana Ruiz");
    const b = await yes(db, depsAt(new Date(BEFORE.getTime() + 60_000)), id, "Ben Cole");
    const c = await yes(db, depsAt(new Date(BEFORE.getTime() + 120_000)), id, "Cara Fox");
    expect([await statusOf(db, a), await statusOf(db, b), await statusOf(db, c)]).toEqual(["registered", "waitlist", "waitlist"]);
    await answerRsvp(db, d, await tokenOf(db, a), { answer: "no" });
    expect([await statusOf(db, a), await statusOf(db, b), await statusOf(db, c)]).toEqual(["declined", "registered", "waitlist"]);
  });

  it("the host's move off the waitlist and to declined, and an illegal move is refused", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 1 });
    const d = depsAt(BEFORE);
    await yes(db, d, id, "Ana Ruiz");
    const b = await yes(db, d, id, "Ben Cole");
    expect(await statusOf(db, b)).toBe("waitlist");
    expect((await moveGuest(db, d, CAMILLE, id, b, "registered")).over_capacity).toBe(true);
    await expect(moveGuest(db, d, CAMILLE, id, b, "declined", {})).rejects.toThrow(/why/i);
    await moveGuest(db, d, CAMILLE, id, b, "declined", { reason: "Has a clash" });
    expect(await statusOf(db, b)).toBe("declined");
    await expect(moveGuest(db, d, CAMILLE, id, b, "registered")).rejects.toThrow();
  });

  it("a declined guest can be checked in; undo restores what they were; undo is refused after closing", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db);
    const d = depsAt(ON_THE_DAY);
    const g = await guest(db, id, "Dee Park");
    await invite(db, id, g.id);
    await answerRsvp(db, depsAt(BEFORE), await tokenOf(db, g.id), { answer: "no" });
    await checkIn(db, d, CAMILLE, id, g.id);
    expect(await statusOf(db, g.id)).toBe("attended");
    await undoCheckIn(db, d, CAMILLE, id, g.id);
    expect(await statusOf(db, g.id)).toBe("declined");
    await checkIn(db, d, CAMILLE, id, g.id);
    await closeAttendance(db, depsAt(AFTER), CAMILLE, id);
    await expect(undoCheckIn(db, d, CAMILLE, id, g.id)).rejects.toThrow(/closed/i);
  });
});
