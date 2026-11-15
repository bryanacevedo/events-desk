/* Step 6 part 2 (docs/SHARED-WORLD.md section 12): member, activity and money writes, from the sweep. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { drainOutbox } from "../src/server/crm-outbox.ts";
import { moneyOf, syncCrm, longWaiting } from "../src/server/crm-sync.ts";
import { ingestCrmMeetings, bookMeeting, recordOutcome } from "../src/server/meetings.ts";
import { checkIn, undoCheckIn } from "../src/server/hosted.ts";
import { forgetPerson } from "../src/server/operating.ts";
import { freshDb } from "./helpers.ts";
import { clock, deliveredInMotion, fakeCrm, MAYA, personAt } from "./lifecycle-harness.ts";
import { AFTER, BEFORE, depsAt, hostedDinner, guest, invite, ON_THE_DAY, yes } from "./hosted-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
afterEach(() => { delete process.env.CRM_CAMPAIGN_MONEY; });

/** A CRM that records every call and knows every address. */
function recorder(over: Record<string, unknown> = {}) {
  const log: { call: string; arg: any }[] = [];
  const crm: any = fakeCrm({
    async personFlags(people: any[]) { return Object.fromEntries(people.map((p) => [p.ref, p.email ? [{ id: `rec:${p.email}`, object: "Contact", email: p.email, email_opt_out: false, do_not_contact: false, do_not_call: false, bounced_at: null }] : []])); },
    write: async () => {}, findCampaignByKey: async () => null,
    createCampaign: async (a: any) => { log.push({ call: "campaign", arg: a }); return { id: `cmp_${log.length}` }; },
    createCampaignMember: async (a: any) => { log.push({ call: "member", arg: a }); return { id: "m" }; },
    updateCampaignMemberStatus: async (a: any) => { log.push({ call: "move", arg: a }); },
    createActivity: async (a: any) => { log.push({ call: "activity", arg: a }); return { id: `act_${log.length}` }; },
    updateActivity: async (a: any) => { log.push({ call: "activity_update", arg: a }); },
    updateCampaignMoney: async (a: any) => { log.push({ call: "money", arg: a }); },
    ...over,
  } as never);
  return { crm, log, of: (c: string) => log.filter((l) => l.call === c) };
}
const drainAll = async (crm: any, n = 3) => { for (let i = 0; i < n; i++) await drainOutbox(db, crm); };
const statuses = (r: ReturnType<typeof recorder>) => [...r.of("member"), ...r.of("move")].map((l) => l.arg.status);

describe("member rows", () => {
  it("a guest's moves are sent in order, one row each, and the sweep twice queues once", async () => {
    const id = await hostedDinner(db);
    const r = recorder();
    const g = await guest(db, id, "Ana Ruiz");
    await invite(db, id, g.id);
    await syncCrm(db, r.crm);
    const first = await db.query("SELECT 1 FROM crm_outbox WHERE kind = 'campaign_member'");
    await syncCrm(db, r.crm);
    expect(await db.query("SELECT 1 FROM crm_outbox WHERE kind = 'campaign_member'")).toHaveLength(first.length);
    await drainAll(r.crm);
    expect(r.of("campaign")).toHaveLength(1);
    expect(statuses(r)).toEqual(["sent"]);
  });

  it("a check-in undone goes back to registered and is sent (a status that returns is a new row)", async () => {
    const id = await hostedDinner(db);
    const r = recorder();
    const deps = depsAt(ON_THE_DAY);
    const gid = await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    await syncCrm(db, r.crm); await drainAll(r.crm);
    await checkIn(db, deps, "Camille Laurent", id, gid);
    await syncCrm(db, r.crm); await drainAll(r.crm);
    await undoCheckIn(db, deps, "Camille Laurent", id, gid);
    await syncCrm(db, r.crm); await drainAll(r.crm);
    const moves = statuses(r);
    expect(moves).toEqual(["registered", "attended", "registered"]);
    expect(await db.query("SELECT desk_key FROM crm_outbox WHERE kind = 'campaign_member' ORDER BY created_at, desk_key")).toHaveLength(3);
  });

  it("waitlist, declined and listed are not sent, and a guest who was sent then declines is counted", async () => {
    const id = await hostedDinner(db);
    const r = recorder();
    const deps = depsAt(BEFORE);
    const gid = await yes(db, deps, id, "Ana Ruiz");
    await guest(db, id, "Bo Chen");                               // listed
    await syncCrm(db, r.crm);
    expect(await db.query("SELECT 1 FROM crm_outbox WHERE kind = 'campaign_member'")).toHaveLength(1);
    await db.query("UPDATE event_guests SET status = 'declined' WHERE id = $1", [gid]);
    const again = await syncCrm(db, r.crm);
    expect(again.awaiting_contract).toBe(1);
    expect(await db.query("SELECT 1 FROM crm_outbox WHERE kind = 'campaign_member'")).toHaveLength(1);
  });

  it("a member row waits for its campaign without using an attempt, and an alert rises after 24 hours", async () => {
    const id = await hostedDinner(db);
    const r = recorder({ createCampaign: async () => { throw new Error("later"); } });
    await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    await syncCrm(db, r.crm);
    await db.query("UPDATE crm_outbox SET attempts = 0 WHERE kind = 'campaign'");
    // The campaign fails; hold it back so only the member row is drained.
    await db.query("UPDATE crm_outbox SET status = 'cancelled' WHERE kind = 'campaign'");
    await db.query("UPDATE crm_outbox SET status = 'queued' WHERE kind = 'campaign_member'");
    await drainOutbox(db, r.crm);
    const [m] = await db.query<{ attempts: number; status: string; last_error: string }>("SELECT attempts, status, last_error FROM crm_outbox WHERE kind = 'campaign_member'");
    expect(m).toMatchObject({ attempts: 0, status: "queued", last_error: "campaign not in the CRM yet" });
    expect(await longWaiting(db)).toEqual([]);
    await db.query("UPDATE crm_outbox SET created_at = now() - interval '25 hours' WHERE kind = 'campaign_member'");
    expect((await longWaiting(db))[0]).toMatchObject({ event_id: id, n: 1 });
  });

  it("an older status never goes after a newer one", async () => {
    const id = await hostedDinner(db);
    const r = recorder();
    const deps = depsAt(ON_THE_DAY);
    const gid = await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    await syncCrm(db, r.crm);
    await db.query("UPDATE crm_outbox SET created_at = created_at - interval '1 minute'");
    await checkIn(db, deps, "Camille Laurent", id, gid);
    await syncCrm(db, r.crm);
    await drainAll(r.crm);
    expect(statuses(r)).toEqual(["attended"]);
    expect((await db.query<{ status: string }>("SELECT status FROM crm_outbox WHERE desk_key LIKE '%:registered:1'"))[0].status).toBe("cancelled");
  });

  it("an erased address is never written, and its queued rows go", async () => {
    const id = await hostedDinner(db);
    const r = recorder();
    await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    await syncCrm(db, r.crm);
    await forgetPerson(db, { crm: r.crm, now: () => BEFORE } as never, "ana.ruiz@acme.example", "Privacy");
    expect((await db.query<{ status: string }>("SELECT status FROM crm_outbox WHERE kind = 'campaign_member'")).every((x) => x.status === "cancelled")).toBe(true);
    await syncCrm(db, r.crm);
    expect(await db.query("SELECT 1 FROM crm_outbox WHERE kind = 'campaign_member' AND status = 'queued'")).toHaveLength(0);
  });

  it("no CRM that can write, nothing queued", async () => {
    const id = await hostedDinner(db);
    await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    await syncCrm(db, null);
    expect(await db.query("SELECT 1 FROM crm_outbox")).toHaveLength(0);
  });
});

describe("activities", () => {
  async function conference() {
    const r = recorder();
    const h = await deliveredInMotion(db, { crm: r.crm, time: clock("2027-01-10T12:00:00Z") });
    const ana = await personAt(db, h.id, "Ana Ruiz");
    return { r, h, ana };
  }
  it("a meeting is one create and then a status update that waits for the create", async () => {
    const { r, h, ana } = await conference();
    const m = await bookMeeting(db, h.deps, { contact_id: ana.id, scheduled_at: "2027-01-15T15:00:00Z", source: "manual", rep: MAYA }, MAYA);
    await syncCrm(db, r.crm);
    await recordOutcome(db, h.deps, m.id, "held", MAYA);
    await syncCrm(db, r.crm);
    await drainAll(r.crm, 4);
    expect(r.of("activity").filter((a) => a.arg.type === "meeting")).toHaveLength(1);
    expect(r.of("activity")[0].arg.meeting.status).toBe("booked");
    expect(r.of("activity_update")[0].arg).toMatchObject({ meeting_status: "held" });
    // And it comes back through the CRM's change feed without being booked a second time.
    const created = (await db.query<{ result_id: string }>("SELECT result_id FROM crm_outbox WHERE kind = 'activity' AND desk_key LIKE 'activity:meeting:%'"))[0].result_id;
    r.crm.meetings = async () => [{ id: created, email: "ana@tallgrasssoftware.example", start: "2027-01-15T15:00:00Z", timezone: "UTC", organizer: null, status: "held" }];
    await ingestCrmMeetings(db, h.deps);
    expect(await db.query("SELECT 1 FROM meetings WHERE external_key LIKE 'cal:crm:%'")).toHaveLength(0);
  });
  it("a meeting read from the CRM is not written back", async () => {
    const { r, h } = await conference();
    r.crm.meetings = async () => [{ id: "crm_act_9", email: "ana@tallgrasssoftware.example", start: "2027-01-15T15:00:00Z", timezone: "UTC", organizer: null, status: "booked" }];
    await ingestCrmMeetings(db, h.deps);
    await syncCrm(db, r.crm);
    expect(await db.query("SELECT 1 FROM crm_outbox WHERE kind IN ('activity', 'activity_update')")).toHaveLength(0);
  });
  it("a send and a matched reply are activities once; a bounce or an unmatched reply is not", async () => {
    const { r, h, ana } = await conference();
    await db.query("INSERT INTO touches (id, domain, contact_id, event_id, kind, channel, source, dedup_key, step) VALUES ('t1', $2, $1, $3, 'send', 'email', 'instantly', 'k1', 2)", [ana.id, "tallgrasssoftware.example", h.id]);
    await db.query("INSERT INTO inbound_messages (id, connector, provider_message_id, event_id, contact_id, channel, signal, body, received_at) VALUES ('i1', 'x', 'p1', $1, $2, 'email', 'reply', 'secret body', now()), ('i2', 'x', 'p2', $1, $2, 'email', 'bounce', NULL, now()), ('i3', 'x', 'p3', $1, NULL, 'email', 'reply', 'x', now())", [h.id, ana.id]);
    await syncCrm(db, r.crm); await syncCrm(db, r.crm);
    await drainAll(r.crm);
    const a = r.of("activity").map((x) => x.arg);
    expect(a.map((x) => [x.type, x.direction, x.key]).sort()).toEqual([["email", "in", "activity:reply:i1"], ["email", "out", "activity:send:t1"]]);
    expect(JSON.stringify(a)).not.toContain("secret body");
    expect(a.find((x) => x.key === "activity:send:t1").subject).toBe("Payments Summit outreach, step 2");
  });
  it("an accepted debrief fact is a note with the quote, only when one person at that account held a meeting", async () => {
    const { r, h, ana } = await conference();
    const m = await bookMeeting(db, h.deps, { contact_id: ana.id, scheduled_at: "2027-01-15T15:00:00Z", source: "manual", rep: MAYA }, MAYA);
    await recordOutcome(db, h.deps, m.id, "held", MAYA);
    await db.query("INSERT INTO debriefs (id, event_id, author, status) VALUES ('d1', $1, 'Rep', 'accepted')", [h.id]);
    await db.query("INSERT INTO debrief_facts (id, debrief_id, account, theme, fact, quote) VALUES ('f1', 'd1', 'Tallgrass Software', 'pricing', 'MODEL TEXT', 'we need usage billing'), ('f2', 'd1', 'Nobody Inc', 'x', 'y', 'z')");
    const out = await syncCrm(db, r.crm);
    expect(out).toMatchObject({ debriefs: 1, debrief_unplaced: 1 });
    await drainAll(r.crm);
    const note = r.of("activity").map((x) => x.arg).find((x) => x.type === "note");
    expect(note.body).toBe('pricing: "we need usage billing"');
    expect(JSON.stringify(note)).not.toContain("MODEL TEXT");
  });
});

describe("campaign money", () => {
  async function priced() {
    const id = await hostedDinner(db);
    await db.query("UPDATE events SET crm_campaign_id = 'cmp_x' WHERE id = $1", [id]);
    await db.query("INSERT INTO event_costs (id, event_id, category, amount_cents, recorded_by) VALUES ('c1', $1, 'booth', 12345, 'GTM Team')", [id]);
    return id;
  }
  it("is off by default: nothing queued, nothing written", async () => {
    await priced();
    const r = recorder();
    await syncCrm(db, r.crm); await drainAll(r.crm);
    expect(r.of("money")).toHaveLength(0);
    expect(await db.query("SELECT 1 FROM crm_outbox WHERE kind = 'campaign_money'")).toHaveLength(0);
  });
  it("on, it writes whole USD cents once and the latest numbers at drain; a change writes again", async () => {
    const id = await priced();
    process.env.CRM_CAMPAIGN_MONEY = "usd";
    const r = recorder();
    await syncCrm(db, r.crm); await syncCrm(db, r.crm); await drainAll(r.crm);
    expect(r.of("money").map((m) => m.arg)).toEqual([{ campaign: "cmp_x", budget_cents: 500_000, actual_cost_cents: 12_345 }]);
    await db.query("UPDATE event_costs SET amount_cents = 1000 WHERE event_id = $1", [id]);
    await syncCrm(db, r.crm); await drainAll(r.crm);
    expect(r.of("money").at(-1)!.arg.actual_cost_cents).toBe(1000);
    expect(await moneyOf(db.query, id)).toEqual({ budget_cents: 500_000, actual_cost_cents: 1000 });
  });
  it("a row queued while on is not sent after it is turned off", async () => {
    await priced();
    process.env.CRM_CAMPAIGN_MONEY = "usd";
    const r = recorder();
    await syncCrm(db, r.crm);
    delete process.env.CRM_CAMPAIGN_MONEY;
    await drainAll(r.crm);
    expect(r.of("money")).toHaveLength(0);
    expect((await db.query<{ status: string }>("SELECT status FROM crm_outbox WHERE kind = 'campaign_money'"))[0].status).toBe("queued");
  });
});
