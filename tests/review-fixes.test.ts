/* One test per finding from the two final reviews of v2 (2026-11-09). Each was a real way to reach someone who should not be reached, lose a stop, or count wrong. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import type { ToolEvent } from "../src/server/connectors/types.ts";
import { liveConnectors } from "../src/server/connectors/setup.ts";
import { runGate } from "../src/server/gate.ts";
import { bookMeeting, ingestCrmMeetings, recordOutcome } from "../src/server/meetings.ts";
import { captureOnsite, forgetPerson } from "../src/server/operating.ts";
import { openOwnerDecisions, ownerSweep, sendOwnerCards } from "../src/server/owners.ts";
import { ingestEvents, processInbound } from "../src/server/replies.ts";
import { attachCampaign, calendarSweep, confirmLaunchChecklist, createDrafts, drainOps, flagSweep, observeSequences, resumeDue, stopAllSending } from "../src/server/sequences.ts";
import { stopContacts } from "../src/server/enroll-ops.ts";
import { addHold } from "../src/server/touches.ts";
import { cleanReply } from "../src/shared/reply-clean.ts";
import { matchesUnsubscribe } from "../src/shared/motion.ts";
import { createApp } from "../src/server/app.ts";
import { freshDb } from "./helpers.ts";
import { clock, deliveredInMotion, enrollmentStates, fakeCrm, MAYA, OWNER, personAt, type Harness } from "./lifecycle-harness.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
const seqOf = async (h: Harness, channel: string) => (await db.query<{ id: string; external_id: string; state: string }>("SELECT id, external_id, state FROM sequences WHERE event_id = $1 AND channel = $2 ORDER BY created_at LIMIT 1", [h.id, channel]))[0];
let n = 0;
const ev = (who: string, body: string | null, seq: string, signal: ToolEvent["signal"] = "reply"): ToolEvent => ({ provider_message_id: `${signal}:f${++n}`, signal, channel: "email", sequence_external_id: seq, email: who, linkedin: null, external_contact_id: null, body, at: "2027-01-12T10:00:00Z" });
async function launched(h: Harness) {
  await createDrafts(db, h.deps, h.id, MAYA);
  await attachCampaign(db, h.deps, (await seqOf(h, "linkedin")).id, h.li.newSeq(), MAYA);
  for (const s of await db.query<{ id: string }>("SELECT id FROM sequences WHERE event_id = $1", [h.id])) await confirmLaunchChecklist(db, s.id, MAYA);
  const e = await seqOf(h, "email"), l = await seqOf(h, "linkedin");
  h.email.launch(e.external_id); h.li.launch(l.external_id);
  await observeSequences(db, h.deps); await drainOps(db, h.deps);
  return { e, l };
}

describe("a typed request to stop is never cleaned away", () => {
  it.each(["Please unsubscribe me from this email list.", "Unsubscribe me here please", "Opt out of this email, thanks", "Hi,\nPlease remove me from this email list.\nThanks"])("%s", (body) => {
    expect(matchesUnsubscribe(cleanReply(body))).toBe(true);
  });
  it("a real footer with a link is still removed", () => expect(cleanReply("Interested\nTo unsubscribe click here: https://x.example/u")).toBe("Interested"));
});

describe("nobody who said no is added back", () => {
  it("pressing set up again after a not interested adds nobody back", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await ingestEvents(db, h.deps, h.email.connector, [ev(ana.email, "Not interested, thanks", e.external_id)]);
    await processInbound(db, h.deps);
    await createDrafts(db, h.deps, h.id, MAYA);
    expect((await enrollmentStates(db, ana.id)).filter((x) => x.channel === "email").every((x) => x.state === "removed")).toBe(true);
    expect((await runGate(db, h.deps, h.id, [ana.id], "email", "add"))[0].reason).toBe("cool_off");
  });
});

describe("a stop is never lost or skipped", () => {
  it("a stop that lands while the add is in flight is carried out once the add answers", async () => {
    const h = await deliveredInMotion(db);
    await createDrafts(db, h.deps, h.id, MAYA);
    const e = await seqOf(h, "email"), ana = await personAt(db, h.id, "Ana Ruiz");
    await db.query("UPDATE enrollments SET pending_op = 'add', state = 'adding', external_contact_id = NULL WHERE contact_id = $1 AND channel = 'email'", [ana.id]);
    h.email.seqs.get(e.external_id)!.people.clear();
    const real = h.email.connector.addContacts;
    h.email.connector.addContacts = async (seq, people) => { await db.tx((q) => stopContacts(q, [ana.id], "remove", "unsubscribe")); return real(seq, people); };
    await drainOps(db, h.deps);
    h.email.connector.addContacts = real;
    await drainOps(db, h.deps);
    expect(h.email.seqs.get(e.external_id)!.people.has(ana.email)).toBe(false);
  });

  it("an add whose answer was lost is still taken back by a later stop", async () => {
    const h = await deliveredInMotion(db);
    await createDrafts(db, h.deps, h.id, MAYA);
    const e = await seqOf(h, "email"), ana = await personAt(db, h.id, "Ana Ruiz");
    await db.query("UPDATE enrollments SET external_contact_id = NULL, add_attempted = true, state = 'adding', pending_op = NULL WHERE contact_id = $1 AND channel = 'email'", [ana.id]);
    await db.tx((q) => stopContacts(q, [ana.id], "remove", "unsubscribe"));
    await drainOps(db, h.deps);
    expect(h.email.seqs.get(e.external_id)!.people.has(ana.email)).toBe(false);
  });

  it("a sequence that ends still takes back an add whose answer was lost", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    expect(h.email.seqs.get(e.external_id)!.people.has(ana.email)).toBe(true);
    await db.query("UPDATE enrollments SET external_contact_id = NULL, add_attempted = true, state = 'adding', pending_op = NULL WHERE contact_id = $1 AND channel = 'email'", [ana.id]);
    await db.query("UPDATE events SET motion = 'closing' WHERE id = $1", [h.id]);
    await calendarSweep(db, h.deps);
    await drainOps(db, h.deps);
    expect(h.email.seqs.get(e.external_id)!.people.has(ana.email)).toBe(false);
  });

  it("a new reason to pause cancels a resume that was waiting", async () => {
    const h = await deliveredInMotion(db);
    await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await db.query("UPDATE enrollments SET state = 'paused', pending_op = 'resume', cause = NULL WHERE contact_id = $1", [ana.id]);
    await db.tx((q) => stopContacts(q, [ana.id], "pause", "inbound", "m1"));
    expect((await enrollmentStates(db, ana.id)).every((x) => x.pending_op === null && x.cause === "inbound")).toBe(true);
  });

  it("an out-of-office does not set a resume on a pause it did not cause", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await bookMeeting(db, h.deps, { contact_id: ana.id, scheduled_at: "2027-01-20T15:00:00Z", source: "manual", rep: "R" }, "R");
    await ingestEvents(db, h.deps, h.email.connector, [ev(ana.email, "I am out of office until Monday.", e.external_id)]);
    await processInbound(db, h.deps);
    expect((await enrollmentStates(db, ana.id)).every((x) => x.cause === "inbound" || x.cause === "meeting")).toBe(true);
    expect((await db.query("SELECT 1 FROM enrollments WHERE contact_id = $1 AND resume_at IS NOT NULL AND cause = 'meeting'", [ana.id]))).toHaveLength(0);
  });

  it("a hold that ends restarts nobody, even with a resume date set before it", async () => {
    const h = await deliveredInMotion(db);
    await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await db.query("UPDATE enrollments SET state = 'paused', cause = 'out_of_office', resume_at = $2 WHERE contact_id = $1", [ana.id, h.time.now.toISOString()]);
    await db.tx((q) => addHold(q, { domain: "tallgrasssoftware.example", cause: "live_thread", cause_id: "x", expires_at: new Date(h.time.now.getTime() + 86_400_000) }));
    await resumeDue(db, h.deps);
    expect((await db.query("SELECT 1 FROM enrollments WHERE contact_id = $1 AND resume_at IS NOT NULL", [ana.id]))).toHaveLength(0);
  });

  it("a reply waiting on a person keeps them out at every gate", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await ingestEvents(db, h.deps, h.email.connector, [ev(ana.email, "asdf", e.external_id)]);
    await processInbound(db, h.deps);
    expect((await runGate(db, h.deps, h.id, [ana.id], "email", "resume"))[0].reason).toBe("reply_waiting");
  });

  it("all sending stopped holds even if someone starts the campaign in the tool", async () => {
    const h = await deliveredInMotion(db);
    await createDrafts(db, h.deps, h.id, MAYA);
    const e = await seqOf(h, "email");
    await confirmLaunchChecklist(db, e.id, MAYA);
    await stopAllSending(db, h.deps, "GTM Team", "x");
    h.email.launch(e.external_id);
    await observeSequences(db, h.deps);
    expect(h.email.seqs.get(e.external_id)!.status).toBe("2");
    expect(await db.query("SELECT 1 FROM enrollments WHERE sequence_id = $1 AND cause = 'gate:desk_stopped'", [e.id])).toHaveLength(0);
  });

  it("someone waiting to be added is checked again before going in", async () => {
    const h = await deliveredInMotion(db);
    h.email.connector.simulated = false;
    h.deps.firstCohort = 1;
    await createDrafts(db, h.deps, h.id, MAYA);
    const [w] = await db.query<{ contact_id: string; email: string }>("SELECT n.contact_id, k.email FROM enrollments n JOIN contacts k ON k.id = n.contact_id WHERE n.event_id = $1 AND n.channel = 'email' AND n.external_contact_id IS NULL AND n.state = 'adding' LIMIT 1", [h.id]);
    expect(w).toBeDefined();
    await db.query("UPDATE enrollments SET added_at = $1::timestamptz - interval '1 day'", [h.time.now.toISOString()]);
    await db.query("INSERT INTO suppressions (id, kind, email, reason) VALUES ('sz', 'opt_out', $1, 'x')", [w.email]);
    h.deps.firstCohort = 10;
    await drainOps(db, h.deps);
    expect((await enrollmentStates(db, w.contact_id)).find((x) => x.channel === "email")).toMatchObject({ state: "removed", cause: "gate:opted_out" });
  });

  it("the CRM sweep covers people still waiting to go in", async () => {
    const records: Record<string, any[]> = {};
    const h = await deliveredInMotion(db, { crm: fakeCrm({ records }) });
    await db.query("UPDATE events SET motion = 'sequencing' WHERE id = $1", [h.id]);
    await openOwnerDecisions(db, h.deps, h.id);
    await db.query("UPDATE owner_decisions SET status = 'include', via = 'default' WHERE event_id = $1", [h.id]);
    await createDrafts(db, h.deps, h.id, MAYA);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await db.query("UPDATE enrollments SET state = 'adding', pending_op = 'add' WHERE contact_id = $1", [ana.id]);
    records[ana.email] = [{ id: "1", object: "Lead", email: ana.email, email_opt_out: true, do_not_contact: false, do_not_call: false, bounced_at: null }];
    expect((await flagSweep(db, h.deps)).removed).toBeGreaterThan(0);
  });
});

describe("met in person", () => {
  it("stays out of this event's automated follow-up after the 14-day hold", async () => {
    const h = await deliveredInMotion(db, { time: clock("2027-01-05T12:00:00Z") });
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await captureOnsite(db, h.deps, h.id, "Rep A", { email: ana.email, met: true });
    h.time.forward(20);
    await db.query("UPDATE verification_cache SET checked_at = $1", [h.time.now.toISOString()]);
    expect((await runGate(db, h.deps, h.id, [ana.id], "email", "add"))[0].reason).toBe("met_in_person");
  });
});

describe("owners get their full two business days", () => {
  it("a card sent late Monday is not defaulted until late Wednesday", async () => {
    const t = clock("2027-01-11T23:50:00Z");
    const h = await deliveredInMotion(db, { crm: fakeCrm(), time: t });
    await openOwnerDecisions(db, h.deps, h.id); await sendOwnerCards(db, h.deps, h.id);
    t.set("2027-01-13T00:10:00Z"); await ownerSweep(db, h.deps, h.id);
    expect(await db.query("SELECT 1 FROM owner_decisions WHERE event_id = $1 AND status = 'pending'", [h.id])).not.toHaveLength(0);
    t.set("2027-01-13T23:55:00Z"); await ownerSweep(db, h.deps, h.id);
    expect(await db.query("SELECT 1 FROM owner_decisions WHERE event_id = $1 AND status = 'pending'", [h.id])).toHaveLength(0);
  });

  it("the uploader cannot overturn what the owner said", async () => {
    const h = await deliveredInMotion(db, { crm: fakeCrm() });
    await openOwnerDecisions(db, h.deps, h.id);
    const [d] = await db.query<{ id: string }>("SELECT id FROM owner_decisions WHERE event_id = $1 LIMIT 1", [h.id]);
    const { decideOwner } = await import("../src/server/owners.ts");
    await decideOwner(db, h.deps, d.id, OWNER, "mine");
    await expect(decideOwner(db, h.deps, d.id, MAYA, "include")).rejects.toThrow(/already decided/);
  });
});

describe("only the right person records a meeting's outcome", () => {
  it("someone else cannot mark it a no-show to release the hold", async () => {
    const h = await deliveredInMotion(db);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    const m = await bookMeeting(db, h.deps, { contact_id: ana.id, scheduled_at: "2027-01-20T15:00:00Z", source: "manual", rep: "Rep A" }, "Rep A");
    await expect(recordOutcome(db, h.deps, m.id, "no_show", "Stranger")).rejects.toThrow(/Only/);
    await recordOutcome(db, h.deps, m.id, "held", "Rep A");
  });

  it("a CRM meeting already known is not booked again on every poll", async () => {
    const h = await deliveredInMotion(db);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    h.deps.crm = fakeCrm({ meetings: async () => [{ id: "e1", email: ana.email, start: "2027-01-12T15:00:00Z", timezone: null, organizer: "R", status: "booked" }] } as never);
    await ingestCrmMeetings(db, h.deps);
    const before = (await db.query("SELECT 1 FROM touches WHERE kind = 'meeting_booked'")).length;
    await ingestCrmMeetings(db, h.deps);
    expect((await db.query("SELECT 1 FROM touches WHERE kind = 'meeting_booked'")).length).toBe(before);
  });
});

describe("erasure", () => {
  it("reaches the person's LinkedIn-only records and blocks their name at the company", async () => {
    const h = await deliveredInMotion(db);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await forgetPerson(db, h.deps, ana.email, "GTM Team");
    expect(await db.query("SELECT 1 FROM suppressions WHERE name_key IS NOT NULL AND company_key IS NOT NULL")).not.toHaveLength(0);
  });
});

describe("webhooks", () => {
  it("records the events before answering, so a crash after the answer loses nothing", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    const http = createApp(db, { demo: true, lifecycle: h.deps });
    const { request } = h.email.reply(e.external_id, ana.email, "Sounds good");
    const r = await http.request("/hooks/sequencer/instantly", { method: "POST", headers: request.headers, body: JSON.stringify(request.body) });
    expect(r.status).toBe(200);
    expect(await db.query("SELECT 1 FROM inbound_messages")).toHaveLength(1);
  });

  it("refuses a body that is too large", async () => {
    const h = await deliveredInMotion(db);
    const http = createApp(db, { demo: true, lifecycle: h.deps });
    const r = await http.request("/hooks/sequencer/instantly", { method: "POST", headers: { "x-desk-secret": h.email.webhookSecret }, body: "x".repeat(1_100_000) });
    expect(r.status).toBe(413);
  });
});

describe("real sending", () => {
  it("refuses to start without a real login, the real model, and webhooks", () => {
    const base = { LIVE_SEND: "1", WRITE_KEY: "k", SEQUENCER_WEBHOOK_SECRET: "s", LIVE_SPEND: "1", WEBHOOK_BASE: "https://x" };
    expect(() => liveConnectors(base)).toThrow(/login/);
    expect(() => liveConnectors({ ...base, DESK_LOGIN: "1", LIVE_SPEND: "" })).toThrow(/LIVE_SPEND/);
    expect(() => liveConnectors({ ...base, DESK_LOGIN: "1", WEBHOOK_BASE: "" })).toThrow(/WEBHOOK_BASE/);
    expect(liveConnectors({})).toEqual({});
  });
});

/* Each of these protections had no test of its own: switching it off in the code went unnoticed (mutation check, 2026-11-09). */
describe("each protection, on its own", () => {
  it("the gate refuses someone opted out by name at their company, on LinkedIn where there is no email to match", async () => {
    const h = await deliveredInMotion(db);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    const [k] = await db.query<{ name_key: string; company_key: string }>("SELECT lower(regexp_replace(k.full_name, '\\s+', ' ', 'g')) AS name_key, co.key AS company_key FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.id = $1", [ana.id]);
    const { nameKey } = await import("../src/shared/email.ts");
    await db.query("INSERT INTO suppressions (id, kind, name_key, company_key, reason) VALUES ('sn', 'opt_out', $1, $2, 'x')", [nameKey("Ana Ruiz"), k.company_key]);
    expect((await runGate(db, h.deps, h.id, [ana.id], "linkedin", "add"))[0].reason).toBe("opted_out");
  });

  it("the gate refuses people at an account its owner kept", async () => {
    const h = await deliveredInMotion(db, { crm: fakeCrm() });
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await openOwnerDecisions(db, h.deps, h.id);
    await db.query("UPDATE owner_decisions SET status = 'mine', via = 'owner' WHERE event_id = $1", [h.id]);
    expect((await runGate(db, h.deps, h.id, [ana.id], "email", "add"))[0].reason).toBe("owner_mine");
  });

  it("someone paused for a meeting stays paused for the meeting when they also reply", async () => {
    const h = await deliveredInMotion(db);
    await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await db.query("UPDATE enrollments SET state = 'paused', cause = 'meeting', cause_id = 'm1' WHERE contact_id = $1", [ana.id]);
    await db.tx((q) => stopContacts(q, [ana.id], "pause", "inbound", "r1"));
    expect((await enrollmentStates(db, ana.id)).every((x) => x.cause === "meeting")).toBe(true);
  });

  it("a changed daily limit in the tool reads as changed", async () => {
    const { sameSettings, settingsFor } = await import("../src/server/sending.ts");
    const want = settingsFor("americas" as never, "United States", 40);
    expect(sameSettings({ ...want, days: [...want.days].reverse() }, want)).toBe(true);
    expect(sameSettings({ ...want, daily_limit: 400 }, want)).toBe(false);
  });

  it("after the event, someone who replied is not followed up, even with nothing else holding them back", async () => {
    const h = await deliveredInMotion(db);
    await db.query("UPDATE events SET starts_on = '2027-01-08' WHERE id = $1", [h.id]);
    const ben = await personAt(db, h.id, "Ben Ode");
    await db.query("INSERT INTO inbound_messages (id, connector, provider_message_id, event_id, contact_id, channel, signal, received_at, status, code) VALUES ('ir', 'instantly', 'pr', $1, $2, 'email', 'reply', '2026-12-01T00:00:00Z', 'done', 'interested')", [h.id, ben.id]);
    expect((await runGate(db, h.deps, h.id, [ben.id], "email", "add"))[0].passed).toBe(true);
    await createDrafts(db, h.deps, h.id, MAYA);
    expect(await db.query("SELECT 1 FROM enrollments WHERE contact_id = $1", [ben.id])).toHaveLength(0);
  });
});
