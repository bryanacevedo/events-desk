/* The rep's day, meeting slots, badge scans and audience templates. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { captureOnsite } from "../src/server/operating.ts";
import { addSlots, bookSlot, prepBrief, repDay } from "../src/server/rep-day.ts";
import { approveTemplate, createDrafts } from "../src/server/sequences.ts";
import { freshDb } from "./helpers.ts";
import { clock, deliveredInMotion, enrollmentStates, MAYA, personAt } from "./lifecycle-harness.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
const seat = (eventId: string, rep: string) => db.query("INSERT INTO seat_requests (id, event_id, requester, team, role, goal, why_event, why_you, expected_meetings, status) VALUES ($1, $2, $3, 'Sales', 'AE', 'g', 'w', 'y', 4, 'approved')", [`sr_${rep.replace(/\W/g, "")}`, eventId, rep]);

describe("meeting slots", () => {
  it("are made only for people with a seat, never overlap, and hold one meeting each", async () => {
    const h = await deliveredInMotion(db);
    await expect(addSlots(db, h.id, MAYA, { rep: "No Seat", day: "2027-01-01", from: "09:00", to: "10:00", minutes: 30, location: "Booth" })).rejects.toThrow(/no approved seat/);
    await seat(h.id, "Rep A");
    expect((await addSlots(db, h.id, MAYA, { rep: "Rep A", day: "2027-01-01", from: "09:00", to: "11:00", minutes: 30, location: "Booth 12" })).made).toBe(4);
    expect((await addSlots(db, h.id, MAYA, { rep: "Rep A", day: "2027-01-01", from: "10:00", to: "12:00", minutes: 30, location: "Booth 12" })).made).toBe(2);
    const [slot] = await db.query<{ id: string }>("SELECT id FROM meeting_slots ORDER BY starts_at LIMIT 1");
    const ana = await personAt(db, h.id, "Ana Ruiz"), ben = await personAt(db, h.id, "Ben Ode");
    const m = await bookSlot(db, h.deps, slot.id, ana.id, MAYA);
    expect(m.rep).toBe("Rep A");
    await expect(bookSlot(db, h.deps, slot.id, ben.id, MAYA)).rejects.toThrow(/already taken/);
  });
});

describe("a rep's day", () => {
  it("shows their meetings with a brief built only from delivered facts", async () => {
    const h = await deliveredInMotion(db, { time: clock("2026-12-31T08:00:00Z") });
    await seat(h.id, "Rep A");
    await addSlots(db, h.id, MAYA, { rep: "Rep A", day: "2027-01-01", from: "09:00", to: "10:00", minutes: 30, location: "Booth 12" });
    const [slot] = await db.query<{ id: string }>("SELECT id FROM meeting_slots ORDER BY starts_at LIMIT 1");
    const ana = await personAt(db, h.id, "Ana Ruiz");
    const m = await bookSlot(db, h.deps, slot.id, ana.id, MAYA);
    const b = await prepBrief(db, m.meeting_id);
    expect(b).toMatchObject({ person: "Ana Ruiz", company: "Tallgrass Software" });
    const day = await repDay(db, h.deps, "Rep A");
    expect(day.meetings).toHaveLength(1);
    expect(day.meetings[0]).toMatchObject({ location: "Booth 12" });
    expect(day.slots).toHaveLength(1);
  });
});

describe("after the event", () => {
  it("a badge scan does not stop anyone: it gets the scanned follow-up, from its own template", async () => {
    const h = await deliveredInMotion(db, { time: clock("2027-01-05T12:00:00Z") });
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await captureOnsite(db, h.deps, h.id, "Rep A", { email: ana.email, source: "badge_scan" });
    expect((await db.query<{ followup_tier: string }>("SELECT followup_tier FROM contacts WHERE id = $1", [ana.id]))[0].followup_tier).toBe("scanned");
    await approveTemplate(db, "GTM", { name: "Scanned", channel: "email", phase: "post", audience: "scanned", steps: [{ day: 0, subject: "Thanks for stopping by", body: "Hi {{first_name}}" }], external_id: h.email.newSeq("tpl_scan") });
    await createDrafts(db, h.deps, h.id, MAYA);
    const [s] = await db.query<{ priority: string; template: string }>("SELECT s.priority, t.name AS template FROM sequences s JOIN sequence_templates t ON t.id = s.template_id JOIN enrollments n ON n.sequence_id = s.id WHERE n.contact_id = $1 AND s.channel = 'email'", [ana.id]);
    expect(s).toEqual({ priority: "scanned", template: "Scanned" });
    const ben = await personAt(db, h.id, "Ben Ode");
    const [b] = await db.query<{ template: string }>("SELECT t.name AS template FROM sequences s JOIN sequence_templates t ON t.id = s.template_id JOIN enrollments n ON n.sequence_id = s.id WHERE n.contact_id = $1 AND s.channel = 'email'", [ben.id]);
    expect(b.template).toBe("Post email");
    expect((await enrollmentStates(db, ana.id)).some((x) => x.state === "paused")).toBe(false);
  });

  it("someone met keeps their rep, and no automated follow-up", async () => {
    const h = await deliveredInMotion(db, { time: clock("2027-01-05T12:00:00Z") });
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await captureOnsite(db, h.deps, h.id, "Rep A", { email: ana.email, met: true, note: "Wants pricing" });
    await createDrafts(db, h.deps, h.id, MAYA);
    expect(await db.query("SELECT 1 FROM enrollments WHERE contact_id = $1", [ana.id])).toHaveLength(0);
  });
});
