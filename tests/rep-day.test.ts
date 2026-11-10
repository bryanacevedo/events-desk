/* The rep's day, meeting slots, badge scans and audience templates. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { captureOnsite } from "../src/server/operating.ts";
import { addSlots, bookSlot, meetingDetail, prepBrief, repDay, replyDetail } from "../src/server/rep-day.ts";
import { bookMeeting } from "../src/server/meetings.ts";
import { listSummary } from "../src/server/uploads.ts";
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
    await db.query("UPDATE events SET starts_on = '2027-01-01' WHERE id = $1", [h.id]);
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

describe("a reply and a meeting, each as its own thing", () => {
  it("a reply carries its whole message, its thread, its clock, the meeting it led to, and every step so far", async () => {
    const h = await deliveredInMotion(db, { time: clock("2026-12-31T08:00:00Z") });
    const ana = await personAt(db, h.id, "Ana Ruiz");
    const body = "Happy to book a call. Thursday afternoon works for me, and my colleague would like to join.";
    const touch = (kind: string, at: string) => db.query("INSERT INTO touches (id, contact_id, event_id, kind, channel, at, source, dedup_key) VALUES ($1, $2, $3, $4, 'email', $5, 'test', $1)", [`t_${kind}`, ana.id, h.id, kind, at]);
    await touch("send", "2026-12-20T09:00:00Z");
    await touch("reply_meeting_request", "2026-12-22T10:00:00Z");
    await db.query("INSERT INTO inbound_messages (id, connector, provider_message_id, event_id, contact_id, channel, signal, body, received_at, code, owner, respond_by, thread_url) VALUES ('inb_t1', 'instantly', 'p1', $1, $2, 'email', 'reply', $3, '2026-12-22T10:00:00Z', 'meeting_request', 'Rep A', '2026-12-23T10:00:00Z', 'https://app.instantly.ai/app/unibox')", [h.id, ana.id, body]);
    await db.query("INSERT INTO inbound_messages (id, connector, provider_message_id, event_id, contact_id, channel, signal, received_at) VALUES ('inb_b1', 'instantly', 'p2', $1, $2, 'email', 'bounce', '2026-12-22T11:00:00Z')", [h.id, ana.id]);
    const m = await bookMeeting(db, h.deps, { contact_id: ana.id, scheduled_at: "2027-01-07T15:00:00Z", source: "reply", rep: "Rep A" }, MAYA);

    const r = await replyDetail(db, "inb_t1");
    expect(r).toMatchObject({ full_name: "Ana Ruiz", company: "Tallgrass Software", body, code: "meeting_request", thread_url: "https://app.instantly.ai/app/unibox", rep: "Rep A", handled_at: null });
    expect(r!.meeting).toMatchObject({ id: m.id, status: "booked" });
    const kinds = r!.path.map((p) => p.kind);
    // Oldest first. Booking stamps the real clock, so only the order of the dated steps is fixed here.
    expect(kinds.indexOf("send")).toBeLessThan(kinds.indexOf("reply_meeting_request"));
    expect(kinds).toEqual(expect.arrayContaining(["send", "reply_meeting_request", "meeting_booked"]));

    const d = await meetingDetail(db, m.id);
    expect(d).toMatchObject({ full_name: "Ana Ruiz", status: "booked", rep: "Rep A" });
    expect(d!.reply).toMatchObject({ id: "inb_t1", body });
    expect(d!.brief?.said).toBe(body);

    // Only replies are replies, and an unknown id is nothing, not an error.
    expect(await replyDetail(db, "inb_b1")).toBeNull();
    expect(await replyDetail(db, "inb_nope")).toBeNull();
    expect(await meetingDetail(db, "mtg_nope")).toBeNull();
  });
});

describe("the list's count", () => {
  it("leaves out people met at the booth, who were never on the list", async () => {
    const h = await deliveredInMotion(db);
    const before = (await listSummary(db, h.id)).people;
    const prioritised = (await listSummary(db, h.id)).priorities.reduce((n, p) => n + p.n, 0);
    expect(before).toBe(prioritised);
    await captureOnsite(db, h.deps, h.id, "Rep A", { full_name: "Walk Up", email: "walk.up@booth-only.example", company: "Booth Only Ltd", note: "Stopped by", met: true, temperature: "warm" });
    expect(await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND source = 'onsite'", [h.id])).toHaveLength(1);
    expect((await listSummary(db, h.id)).people).toBe(before);
  });
});
