/* Reminders and logistics (docs/HOSTED.md 8, 21.7, 21.8, 21.10, 21.11): only registered guests, the country rules, the sequencer is not involved, a seat that opens, and no repeated or unknown send. */

import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { moveGuest } from "../src/server/hosted.ts";
import { reminderPreview, sendReminder } from "../src/server/hosted-reminders.ts";
import { answerRsvp } from "../src/server/rsvp.ts";
import { recordOptOut } from "../src/server/suppression.ts";
import { freshDb } from "./helpers.ts";
import { answered, BEFORE, depsAt, guest, hostedDinner, invite, statusOf, tokenOf, yes } from "./hosted-helpers.ts";
import { CAMILLE } from "./plan-helpers.ts";

afterEach(() => { delete process.env.INTEGRATED_WITH; });
const outbox = (db: any, id: string) => db.query("SELECT guest_id, kind, to_email, state, subject, body FROM transactional_outbox WHERE event_id = $1 ORDER BY created_at, id", [id]);

describe("who is mailed", () => {
  it("only guests whose status is registered; everyone else is counted by the reason and never mailed", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    const d = depsAt(BEFORE);
    const reg = await yes(db, d, id, "Ana Ruiz");
    const listed = await guest(db, id, "Ben Cole");
    const inv = await guest(db, id, "Cara Fox"); await invite(db, id, inv.id);
    const decl = await guest(db, id, "Dee Park"); await answerRsvp(db, d, await tokenOf(db, decl.id), { answer: "no" });
    const noMail = await answered(db, d, id, "Eli Stone", { email: null as never });
    void noMail; void listed;
    const p = await reminderPreview(db, id, "reminder");
    expect(p.audience.map((a) => a.guest_id)).toEqual([reg]);
    expect(p.skipped).toMatchObject({ not_registered: 3 });
    const sent = await sendReminder(db, d, CAMILLE, id, "reminder", { origin: "https://desk.example" });
    expect(sent).toMatchObject({ queued: 1, sent: 1, failed: 0 });
    const rows = await outbox(db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guest_id: reg, kind: "reminder", state: "sent", to_email: "ana.ruiz@acme.example" });
    expect(rows[0].body).toContain("https://desk.example/rsvp/");
    expect(rows[0].body).toContain("Hi Ana,");
    expect(d.sender.sent).toHaveLength(1);
  });

  it("a guest with no email, a blocked country, an unknown country, an opt-out or a wrong address is skipped with its reason", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    const d = depsAt(BEFORE);
    // Registered by their own link, then the country rule is looked at again at send time: a German guest answering yes does not lift the block.
    await answered(db, d, id, "Hans Weber", { country: "DE" });
    await answered(db, d, id, "Uma Unknown", { country: null });
    await answered(db, d, id, "Olga Optout");
    await recordOptOut(db, CAMILLE, { email: "olga.optout@acme.example" });
    await answered(db, d, id, "Wanda Wrong");
    await db.query("INSERT INTO suppressions (id, kind, email, name_key) VALUES ('sup_w', 'wrong_person', 'wanda.wrong@acme.example', NULL)");
    const ok = await yes(db, d, id, "Ana Ruiz");
    const p = await reminderPreview(db, id, "reminder");
    expect(p.audience.map((a) => a.guest_id)).toEqual([ok]);
    expect(p.skipped.country).toBe(2);
    expect(p.skipped.opted_out).toBe(1);
    expect(p.skipped.wrong_person).toBe(1);
    await sendReminder(db, d, CAMILLE, id, "reminder");
    expect((await outbox(db, id)).map((r: any) => r.to_email)).toEqual(["ana.ruiz@acme.example"]);
  });

  it("an invitation is refused for a blocked or unknown country and for no address, with the desk's words", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db);
    const de = await guest(db, id, "Hans Weber", { country: "DE" });
    const unk = await guest(db, id, "Uma Unknown", { country: null });
    const bare = await guest(db, id, "Nell Nomail", { email: null as never, company: "Z" });
    const app = createApp(db, { demo: true });
    const h = { "x-actor": encodeURIComponent(CAMILLE), "content-type": "application/json" };
    const r1 = await app.request(`/api/events/${id}/guests/${de.id}/invitation`, { headers: h });
    expect(r1.status).toBe(409);
    expect((await r1.json() as any).error).toBe("Not emailed in this country");
    const r2 = await app.request(`/api/events/${id}/guests/${unk.id}/invitation`, { method: "POST", headers: h, body: "{}" });
    expect((await r2.json() as any).error).toBe("Their country is not known, so no email until it is");
    const r3 = await app.request(`/api/events/${id}/guests/${bare.id}/invitation`, { headers: h });
    expect(r3.status).toBe(409);
    expect(await statusOf(db, de.id)).toBe("listed");
  });
});

describe("the sender is not the sequencer", () => {
  it("INTEGRATED_WITH=account_desk still sends the reminder", async () => {
    process.env.INTEGRATED_WITH = "account_desk";
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    const d = depsAt(BEFORE);
    await yes(db, d, id, "Ana Ruiz");
    const p = await reminderPreview(db, id, "reminder");
    expect(p.integrated_with).toEqual(["account_desk"]);
    expect(await sendReminder(db, d, CAMILLE, id, "reminder")).toMatchObject({ sent: 1 });
    expect(d.sender.sent).toHaveLength(1);
  });

  it("no invitation, ever, is sent by the desk: logging one writes a row and sends nothing", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db);
    const d = depsAt(BEFORE);
    const g = await guest(db, id, "Ana Ruiz");
    await invite(db, id, g.id);
    expect(d.sender.sent).toHaveLength(0);
    expect(await outbox(db, id)).toEqual([]);
    expect((await db.query("SELECT sent_by, mailbox FROM guest_invitations WHERE guest_id = $1", [g.id]))[0]).toEqual({ sent_by: "Camille Laurent", mailbox: "camille@orrery.example" });
  });
});

describe("a seat that opens", () => {
  it("promotion on a decline sends one seat_open message, to that guest only", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 1 });
    const d = depsAt(BEFORE);
    const a = await yes(db, d, id, "Ana Ruiz");
    const b = await yes(db, depsAt(new Date(BEFORE.getTime() + 60_000), { sender: d.sender }), id, "Ben Cole");
    await yes(db, depsAt(new Date(BEFORE.getTime() + 120_000), { sender: d.sender }), id, "Cara Fox");
    await answerRsvp(db, d, await tokenOf(db, a), { answer: "no" });
    expect(await statusOf(db, b)).toBe("registered");
    const rows = await outbox(db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guest_id: b, kind: "seat_open", to_email: "ben.cole@acme.example", state: "sent" });
    expect(d.sender.sent.map((m) => m.to)).toEqual(["ben.cole@acme.example"]);
  });

  it("raising capacity promotes nobody; the host moves the guest in", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 1 });
    const d = depsAt(BEFORE);
    await yes(db, d, id, "Ana Ruiz");
    const b = await yes(db, d, id, "Ben Cole");
    await db.query("UPDATE hosted_events SET capacity = 5 WHERE event_id = $1", [id]);
    expect(await statusOf(db, b)).toBe("waitlist");
    await moveGuest(db, d, CAMILLE, id, b, "registered");
    expect(await statusOf(db, b)).toBe("registered");
  });
});

describe("one send per guest, and live mode needs a key", () => {
  it("a second run of the same kind inside ten minutes is refused, logistics needs its note, and a run row is the truth", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    const d = depsAt(BEFORE);
    await yes(db, d, id, "Ana Ruiz");
    await sendReminder(db, d, CAMILLE, id, "reminder");
    await expect(sendReminder(db, d, CAMILLE, id, "reminder")).rejects.toThrow(/10 minutes/);
    await expect(sendReminder(db, d, CAMILLE, id, "logistics", {})).rejects.toThrow(/note/i);
    await expect(sendReminder(db, d, CAMILLE, id, "logistics", { note: "x".repeat(601) })).rejects.toThrow(/600/);
    const later = depsAt(new Date(BEFORE.getTime() + 11 * 60_000), { sender: d.sender });
    await sendReminder(db, later, CAMILLE, id, "logistics", { note: "Park on the north side." });
    const bodies = (await outbox(db, id)).map((r: any) => r.body);
    expect(bodies[1]).toContain("Park on the north side.");
    expect((await db.query("SELECT count(*)::int AS n FROM reminder_sends"))[0].n).toBe(2);
    await expect(db.query("INSERT INTO reminder_sends (id, run_id, guest_id, email) SELECT 'dup', run_id, guest_id, email FROM reminder_sends LIMIT 1")).rejects.toThrow();
  });

  it("a send whose outcome is unknown is recorded unknown and never repeated", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    let calls = 0;
    const sender = { live: true, send: async () => { calls++; return { state: "unknown" as const, error: "timeout" }; } };
    const d = depsAt(BEFORE, { sender: sender as never });
    await yes(db, d, id, "Ana Ruiz");
    await sendReminder(db, d, CAMILLE, id, "reminder");
    expect(calls).toBe(1);
    expect((await outbox(db, id))[0].state).toBe("unknown");
    expect((await db.query("SELECT outcome FROM reminder_sends"))[0].outcome).toBe("unknown");
    const { deliverOutbox } = await import("../src/server/transactional.ts");
    await deliverOutbox(db, sender as never, (await db.query<{ id: string }>("SELECT id FROM transactional_outbox")).map((r) => r.id));
    expect(calls).toBe(1);
  });

  it("live mode without a sender refuses with a plain sentence, and the demo uses the simulated one", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    await expect(sendReminder(db, { now: () => BEFORE, live: true }, CAMILLE, id, "reminder")).rejects.toThrow(/no email sender is connected/);
    expect((await reminderPreview(db, id, "reminder", { live: true, hasSender: false })).can_send).toBe(false);
    expect(await sendReminder(db, { now: () => BEFORE }, CAMILLE, id, "reminder")).toMatchObject({ sent: 1 });
  });
});

describe("the ten-minute check looks only at runs that already happened", () => {
  it("a run dated in the future does not block a reminder now", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    const later = new Date(BEFORE.getTime() + 9 * 86_400_000);
    await sendReminder(db, { now: () => later }, CAMILLE, id, "reminder");
    expect(await sendReminder(db, { now: () => BEFORE }, CAMILLE, id, "reminder")).toMatchObject({ sent: 1 });
    await expect(sendReminder(db, { now: () => new Date(BEFORE.getTime() + 60_000) }, CAMILLE, id, "reminder")).rejects.toThrow(/last 10 minutes/);
  });

  it("live mode with no sender leaves the rows queued and the page says so", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 1 });
    await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    await db.query("INSERT INTO transactional_outbox (id, event_id, kind, to_email, subject, body, created_at) VALUES ('tx_q1', $1, 'reminder', 'a@b.example', 's', 'b', now())", [id]);
    const { hostedView } = await import("../src/server/hosted-view.ts");
    const v = await hostedView(db, { now: () => BEFORE, live: true, sender: null } as never, id, CAMILLE, { money: true, can_write: true, can_check_in: true }) as any;
    expect(v.reminders.not_sent).toBe("Not sent: no sender is set up");
    expect((await db.query("SELECT state FROM transactional_outbox WHERE id = 'tx_q1'"))[0]).toEqual({ state: "queued" });
  });
});
