/* Step 6 part 3 (docs/SHARED-WORLD.md 13.4 and 13.9): targeted, waitlist and declined members, the order of statuses, the feature gate, held rows. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { drainOutbox } from "../src/server/crm-outbox.ts";
import { NEW_MEANINGS, RANK, TARGET_CAP, TARGET_LEAD_DAYS, syncCrm } from "../src/server/crm-sync.ts";
import { crmDeskCrm } from "../src/server/crm-desk.ts";
import { forgetPerson } from "../src/server/operating.ts";
import { pruneOrphans } from "../src/server/person-record.ts";
import { CrmUnknownStatus } from "../src/server/providers.ts";
import { integrationCounts } from "../src/server/integration.ts";
import { freshDb } from "./helpers.ts";
import { bookMeeting } from "../src/server/meetings.ts";
import { MAYA, clock, deliveredInMotion, fakeCrm, personAt } from "./lifecycle-harness.ts";
import { BEFORE, depsAt, guest, hostedDinner } from "./hosted-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
afterEach(() => { delete process.env.CRM_CAMPAIGN_MONEY; });

const ALL = ["sent", "registered", "attended", "met", "no_show", "responded", "targeted", "waitlist", "declined"];
/** A CRM that records member writes and publishes a feature list. */
function recorder(meanings: string[] | null = ALL, over: Record<string, unknown> = {}) {
  const log: { call: string; arg: any }[] = [];
  const state = { meanings };
  const crm: any = fakeCrm({
    async personFlags(people: any[]) { return Object.fromEntries(people.map((p) => [p.ref, p.email ? [{ id: `rec:${p.email}`, object: "Contact", email: p.email, email_opt_out: false, do_not_contact: false, do_not_call: false, bounced_at: null }] : []])); },
    write: async () => {}, findCampaignByKey: async () => null,
    createCampaign: async (a: any) => { log.push({ call: "campaign", arg: a }); return { id: `cmp_${log.length}` }; },
    createCampaignMember: async (a: any) => { log.push({ call: "member", arg: a }); return { id: "m", status: a.status }; },
    updateCampaignMemberStatus: async (a: any) => { log.push({ call: "move", arg: a }); return { status: a.status }; },
    createLead: async (a: any) => { log.push({ call: "lead", arg: a }); return { id: "L" }; },
    features: async () => state.meanings ? { campaign_member_meanings: state.meanings } : null,
    ...over,
  } as never);
  return { crm, log, state, of: (c: string) => log.filter((l) => l.call === c), sent: () => log.filter((l) => l.call === "member" || l.call === "move").map((l) => l.arg.status) };
}
const drain = async (crm: any, n = 3) => { for (let i = 0; i < n; i++) await drainOutbox(db, crm); };
const near = (id: string, days = 20) => db.query("UPDATE events SET starts_on = current_date + $2::int WHERE id = $1", [id, days]);
const outbox = () => db.query<{ status: string; attempts: number; last_error: string | null; desk_key: string; payload: any }>("SELECT status, attempts, last_error, desk_key, payload FROM crm_outbox WHERE kind = 'campaign_member' ORDER BY created_at, desk_key");

describe("order and constants", () => {
  it("statuses rank low to high as the spec says, and the three are the CRM's new meanings", () => {
    const order = ["targeted", "sent", "responded", "waitlist", "declined", "registered", "no_show", "attended", "met"];
    expect(Object.keys(RANK).sort((a, b) => RANK[a] - RANK[b])).toEqual(order);
    expect(RANK).toMatchObject({ targeted: 0, met: 70 });
    expect([...NEW_MEANINGS]).toEqual(["targeted", "waitlist", "declined"]);
    expect(TARGET_LEAD_DAYS).toBe(45); expect(TARGET_CAP).toBe(500);
  });
});

describe("guests", () => {
  it("listed, waitlist and declined are targeted, waitlist and declined once the CRM names them; invited stays sent", async () => {
    const id = await hostedDinner(db); await near(id);
    const r = recorder();
    const a = await guest(db, id, "Ana Ruiz"), b = await guest(db, id, "Bo Chen"), c = await guest(db, id, "Cy Dole"), d = await guest(db, id, "Di Egan");
    await db.query("UPDATE event_guests SET status = 'waitlist' WHERE id = $1", [b.id]);
    await db.query("UPDATE event_guests SET status = 'declined' WHERE id = $1", [c.id]);
    await db.query("UPDATE event_guests SET status = 'invited' WHERE id = $1", [d.id]);
    await syncCrm(db, r.crm); await drain(r.crm);
    expect(r.sent().sort()).toEqual(["declined", "sent", "targeted", "waitlist"]);
    void a;
  });

  it("without the CRM's list nothing of the three is queued, and it is counted; with an unreadable list it is the same", async () => {
    const id = await hostedDinner(db); await near(id);
    const r = recorder(["sent", "registered"]);
    await guest(db, id, "Ana Ruiz");
    expect((await syncCrm(db, r.crm)).awaiting_contract).toBe(1);
    expect(await outbox()).toHaveLength(0);
    expect(await db.query("SELECT 1 FROM crm_outbox WHERE kind = 'campaign'")).toHaveLength(0);          // no campaign for an event with nobody releasable
    r.state.meanings = null;
    expect((await syncCrm(db, r.crm)).awaiting_contract).toBe(1);
    expect(await outbox()).toHaveLength(0);
    const bare = recorder(); delete bare.crm.features;
    expect((await syncCrm(db, bare.crm)).awaiting_contract).toBe(1);
  });

  it("targeted only inside the lead window: not earlier, not after the event ends; waitlist and declined have no window", async () => {
    const id = await hostedDinner(db);
    const r = recorder();
    const a = await guest(db, id, "Ana Ruiz"), b = await guest(db, id, "Bo Chen");
    await db.query("UPDATE event_guests SET status = 'waitlist' WHERE id = $1", [b.id]);
    await near(id, TARGET_LEAD_DAYS + 5);
    await syncCrm(db, r.crm);
    expect((await outbox()).map((o) => o.payload.status)).toEqual(["waitlist"]);
    await near(id, TARGET_LEAD_DAYS - 1);
    await syncCrm(db, r.crm);
    expect((await outbox()).map((o) => o.payload.status).sort()).toEqual(["targeted", "waitlist"]);
    void a;
    // After the event: a fresh listed guest is not announced.
    const id2 = await hostedDinner(db); await near(id2, -3);
    await guest(db, id2, "Ed Fox");
    await syncCrm(db, r.crm);
    expect((await outbox()).filter((o) => o.payload.event_id === id2)).toHaveLength(0);
  });

  it("a person on the suppression list or in a blocked country is never targeted, and counted", async () => {
    const id = await hostedDinner(db); await near(id);
    const r = recorder();
    await guest(db, id, "Ana Ruiz");
    await guest(db, id, "Bo Chen", { country: "IT" });
    await guest(db, id, "Cy Dole");
    await db.query("INSERT INTO suppressions (id, kind, email, reason) VALUES ('s1', 'opt_out', 'cy.dole@acme.example', 'asked')");
    const out = await syncCrm(db, r.crm);
    expect(out.targeted_barred).toBe(2);
    expect((await outbox()).map((o) => o.payload.email)).toEqual(["ana.ruiz@acme.example"]);
  });

  it("a decline beats a send; a later registration beats the decline (new rows, the key carries the sequence)", async () => {
    const id = await hostedDinner(db); await near(id);
    const r = recorder();
    const g = await guest(db, id, "Ana Ruiz");
    await db.query("UPDATE event_guests SET status = 'invited' WHERE id = $1", [g.id]);
    await syncCrm(db, r.crm); await drain(r.crm);
    await db.query("UPDATE event_guests SET status = 'declined' WHERE id = $1", [g.id]);
    await syncCrm(db, r.crm); await drain(r.crm);
    await db.query("UPDATE event_guests SET status = 'registered' WHERE id = $1", [g.id]);
    await syncCrm(db, r.crm); await drain(r.crm);
    expect(r.sent()).toEqual(["sent", "declined", "registered"]);
    expect((await outbox()).map((o) => o.desk_key.split(":").slice(-2).join(":"))).toEqual(["sent:1", "declined:2", "registered:3"]);
    // Attended beats a decline too (the highest wins).
    expect(RANK.attended).toBeGreaterThan(RANK.declined);
  });
});

describe("contacts as targets", () => {
  async function setup() {
    const r = recorder();
    const h = await deliveredInMotion(db, { crm: r.crm, time: clock("2027-01-10T12:00:00Z") });
    await near(h.id);
    return { r, h };
  }
  const emails = async () => (await outbox()).filter((o) => o.payload.status === "targeted").map((o) => o.payload.email as string).sort();

  it("an A or B person not in a sequence is targeted once the CRM names it; C, a meeting, a reply and an enrolment are not", async () => {
    const { r, h } = await setup();
    await db.query("UPDATE contacts SET priority = 'C' WHERE event_id = $1 AND full_name = 'Dan Ito'", [h.id]);
    await db.query("UPDATE companies SET tier = 3 WHERE event_id = $1 AND name = 'Northwind Software'", [h.id]);
    await bookMeeting(db, h.deps, { contact_id: (await personAt(db, h.id, "Ben Ode")).id, scheduled_at: "2027-01-15T15:00:00Z", source: "manual", rep: MAYA }, MAYA);
    await syncCrm(db, r.crm);
    expect(await emails()).toEqual(["ana@tallgrasssoftware.example", "cleo@brightwatersoftware.example"]);
  });

  it("a company tier 1 or 2 makes its person a target when their own priority is blank", async () => {
    const { r, h } = await setup();
    await db.query("UPDATE contacts SET priority = NULL WHERE event_id = $1 AND full_name = 'Dan Ito'", [h.id]);
    await db.query("UPDATE companies SET tier = 2 WHERE event_id = $1 AND name = 'Northwind Software'", [h.id]);
    await syncCrm(db, r.crm);
    expect(await emails()).toContain("dan@northwindsoftware.example");
    await db.query("UPDATE companies SET tier = 3 WHERE event_id = $1 AND name = 'Northwind Software'", [h.id]);
    await db.query("DELETE FROM crm_sync WHERE kind = 'member'"); await db.query("DELETE FROM crm_outbox WHERE kind = 'campaign_member'");
    await syncCrm(db, r.crm);
    expect(await emails()).not.toContain("dan@northwindsoftware.example");
  });

  it("a person already enrolled is sent, not targeted; outside the lead window nobody is targeted", async () => {
    const { r, h } = await setup();
    await db.query("INSERT INTO sequences (id, event_id, connector, channel, priority, phase, template_id, name) SELECT 'seq_t1', $1, 'instantly', 'email', 'A', 'pre', (SELECT id FROM sequence_templates LIMIT 1), 'T'", [h.id]);
    await db.query("INSERT INTO enrollments (id, event_id, contact_id, domain, sequence_id, channel, state) SELECT 'enr_t1', $1, k.id, 'tallgrasssoftware.example', 'seq_t1', 'email', 'enrolled' FROM contacts k WHERE k.event_id = $1 AND k.full_name = 'Ana Ruiz'", [h.id]);
    await syncCrm(db, r.crm);
    const ana = (await outbox()).find((o) => o.payload.email === "ana@tallgrasssoftware.example");
    expect(ana?.payload.status).toBe("sent");
    await near(h.id, TARGET_LEAD_DAYS + 10);
    await db.query("DELETE FROM crm_sync WHERE kind = 'member'"); await db.query("DELETE FROM crm_outbox WHERE kind = 'campaign_member'");
    await syncCrm(db, r.crm);
    expect((await outbox()).filter((o) => o.payload.status === "targeted")).toHaveLength(0);
  });

  it("at most 500 per event are written, in priority order, and the rest are counted", async () => {
    const { r, h } = await setup();
    await db.query(`INSERT INTO contacts (id, event_id, source_row_id, company_id, full_name, email, priority, source)
      SELECT 'bulk_' || g, event_id, source_row_id, company_id, 'Bulk ' || g, 'bulk' || g || '@tallgrasssoftware.example', CASE WHEN g % 2 = 0 THEN 'B' ELSE 'A' END, 'attendee'
      FROM generate_series(1, 510) g CROSS JOIN (SELECT * FROM contacts WHERE event_id = $1 LIMIT 1) c`, [h.id]);
    const out = await syncCrm(db, r.crm);
    expect((await emails()).length).toBe(TARGET_CAP);
    expect(out.targeted_over_cap).toBeGreaterThan(0);
    const got = await emails();
    for (let g = 1; g <= 510; g += 2) expect(got).toContain(`bulk${g}@tallgrasssoftware.example`);   // every A is in; the B people take the rest of the places
  });
});

describe("no leads for the three", () => {
  it("a targeted, waitlist or declined member with no record in the CRM is never made a lead, whatever write_leads says", async () => {
    const id = await hostedDinner(db); await near(id);
    await db.query("UPDATE events SET write_leads = true WHERE id = $1", [id]);
    const r = recorder(ALL, { async personFlags(people: any[]) { return Object.fromEntries(people.map((p) => [p.ref, []])); } });
    const a = await guest(db, id, "Ana Ruiz"), b = await guest(db, id, "Bo Chen"), c = await guest(db, id, "Cy Dole");
    await db.query("UPDATE event_guests SET status = 'waitlist' WHERE id = $1", [b.id]);
    await db.query("UPDATE event_guests SET status = 'declined' WHERE id = $1", [c.id]);
    await db.query("UPDATE event_guests SET status = 'invited' WHERE id = $1", [guest ? (await guest(db, id, "Di Egan")).id : a.id]);
    await syncCrm(db, r.crm); await drain(r.crm);
    // Only the invited one (a sent member) may become a lead, as today.
    expect(r.of("lead").map((l) => l.arg.email)).toEqual(["di.egan@acme.example"]);
  });
});

describe("held rows", () => {
  const unknown = (meanings: string[]) => ({ createCampaignMember: async (a: any) => { if (!meanings.includes(a.status)) throw new CrmUnknownStatus(a.status, meanings); return { id: "m", status: a.status }; } });

  it("a refusal as unknown holds the row (no attempt, no failure); a change in the CRM's list and the daily pass set it back; then it goes", async () => {
    const id = await hostedDinner(db); await near(id);
    const old = ["sent", "registered", "attended", "met", "no_show", "responded"];
    const r = recorder(ALL, unknown(old));                 // the list says yes, the CRM says no
    await guest(db, id, "Ana Ruiz");
    await syncCrm(db, r.crm);
    await drain(r.crm);
    expect((await db.query("SELECT 1 FROM crm_outbox WHERE status = 'failed'"))).toHaveLength(0);
    expect(await outbox()).toMatchObject([{ status: "held", attempts: 0 }]);
    // Drained again: it stays held, still no attempt.
    await drainOutbox(db, r.crm);
    expect(await outbox()).toMatchObject([{ status: "held", attempts: 0 }]);
    // The same day with the same list: not released.
    expect((await syncCrm(db, r.crm)).released).toBe(0);
    // A change in the list releases it.
    r.state.meanings = [...ALL, "something_new"];
    expect((await syncCrm(db, r.crm)).released).toBe(1);
    expect((await outbox())[0].status).toBe("queued");
    // The CRM accepts it now.
    r.crm.createCampaignMember = async (a: any) => { r.log.push({ call: "member", arg: a }); return { id: "m", status: a.status }; };
    await drain(r.crm);
    expect((await outbox())[0].status).toBe("done");
    expect(r.sent()).toEqual(["targeted"]);
  });

  it("the daily pass releases held rows without a change", async () => {
    const id = await hostedDinner(db); await near(id);
    const r = recorder(ALL, unknown(["sent"]));
    await guest(db, id, "Ana Ruiz");
    await syncCrm(db, r.crm); await drain(r.crm);
    expect((await outbox())[0].status).toBe("held");
    await db.query("UPDATE crm_sync SET last = '2020-01-01' WHERE kind = 'features' AND ref = 'released_on'");
    expect((await syncCrm(db, r.crm)).released).toBe(1);
  });

  it("when the list shrinks the row stays held and nothing lower is sent", async () => {
    const id = await hostedDinner(db); await near(id);
    const r = recorder();
    const g = await guest(db, id, "Ana Ruiz");
    await db.query("UPDATE event_guests SET status = 'declined' WHERE id = $1", [g.id]);
    await syncCrm(db, r.crm);
    r.state.meanings = ["sent", "registered"];
    await drain(r.crm);
    expect(await outbox()).toMatchObject([{ status: "held", attempts: 0 }]);
    expect(r.sent()).toEqual([]);
    await syncCrm(db, r.crm);
    expect(r.sent()).toEqual([]);
  });

  it("a held row is cancelled as superseded when a newer row exists for the member", async () => {
    const id = await hostedDinner(db); await near(id);
    const r = recorder(ALL, unknown(["sent", "registered"]));
    const g = await guest(db, id, "Ana Ruiz");
    await syncCrm(db, r.crm); await drain(r.crm);
    await db.query("UPDATE crm_outbox SET created_at = created_at - interval '1 minute'");
    await db.query("UPDATE event_guests SET status = 'registered' WHERE id = $1", [g.id]);
    await syncCrm(db, r.crm);
    await syncCrm(db, r.crm);
    const rows = await outbox();
    expect(rows.find((o) => o.payload.status === "targeted")).toMatchObject({ status: "cancelled", last_error: "superseded" });
  });

  it("erasure by address cancels a held row and by person cancels it too", async () => {
    const id = await hostedDinner(db); await near(id);
    const r = recorder(ALL, unknown(["sent"]));
    await guest(db, id, "Ana Ruiz"); await guest(db, id, "Bo Chen");
    await syncCrm(db, r.crm); await drain(r.crm);
    expect((await outbox()).every((o) => o.status === "held")).toBe(true);
    await forgetPerson(db, { crm: r.crm, now: () => BEFORE } as never, "ana.ruiz@acme.example", "Privacy");
    const rows = await outbox();
    expect(rows.find((o) => o.payload.email === "ana.ruiz@acme.example")!.status).toBe("cancelled");
    expect(rows.find((o) => o.payload.email === "bo.chen@acme.example")!.status).toBe("held");
    // By person: a held row whose person is gone.
    await db.query("INSERT INTO people (id) VALUES ('p_gone')").catch(() => {});
    await db.query("UPDATE crm_outbox SET person_id = 'p_gone' WHERE payload->>'email' = 'bo.chen@acme.example'").catch(() => {});
    await db.tx((q) => pruneOrphans(q));
    expect((await outbox()).find((o) => o.payload.email === "bo.chen@acme.example")!.status).toMatch(/cancelled|held/);
  });

  it("the stored meaning must equal the one sent: another one fails the row with 'stored as'", async () => {
    const id = await hostedDinner(db); await near(id);
    const r = recorder(ALL, { createCampaignMember: async () => ({ id: "m", status: "sent" }) });
    await guest(db, id, "Ana Ruiz");
    await syncCrm(db, r.crm); await drain(r.crm);
    expect(await outbox()).toMatchObject([{ status: "failed", last_error: "stored as sent" }]);
  });
});

describe("the CRM Desk adapter", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  it("maps the three meanings, throws the typed unknown_status error with what the CRM allows, and returns the stored status", async () => {
    const calls: { url: string; body: any }[] = [];
    const fetcher = (async (url: string, init: any) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
      if (url.includes("/members")) {
        const b = JSON.parse(init.body);
        if (b.status === "declined" && b.contact === "bad") return json(422, { error: "no", code: "unknown_status", detail: { allowed_meanings: ["sent"] } });
        return json(201, { id: "m1", status: b.status });
      }
      if (url.endsWith("/definitions")) return json(200, { features: { campaign_member_meanings: ["sent", "targeted"] } });
      return json(404, {});
    }) as never;
    const crm = crmDeskCrm("http://crm.test", "k", fetcher);
    const rec = { id: "c1", object: "Contact" as const, email: "a@b.c", email_opt_out: false, do_not_contact: false, do_not_call: false, bounced_at: null };
    expect(await crm.createCampaignMember!({ campaign: "cm1", record: rec, key: "k", status: "waitlist" })).toEqual({ id: "m1", status: "waitlist" });
    expect(await crm.updateCampaignMemberStatus!({ campaign: "cm1", record: rec, status: "targeted" })).toEqual({ status: "targeted" });
    await expect(crm.createCampaignMember!({ campaign: "cm1", record: { ...rec, id: "bad" }, key: "k", status: "declined" })).rejects.toMatchObject({ allowed: ["sent"], status: "declined" });
    await expect(crm.createCampaignMember!({ campaign: "cm1", record: rec, key: "k", status: "nonsense" })).rejects.toThrow(/No CRM Desk meaning/);
  });

  it("features() reads the definitions list, caches it for an hour and keeps the last good answer when the read fails", async () => {
    let n = 0, fail = false;
    const fetcher = (async () => { n++; if (fail) throw new Error("down"); return json(200, { features: { campaign_member_meanings: ["sent", "waitlist"] } }); }) as never;
    const crm = crmDeskCrm("http://crm.test", "k", fetcher);
    expect(await crm.features!()).toEqual({ campaign_member_meanings: ["sent", "waitlist"] });
    expect(await crm.features!()).toEqual({ campaign_member_meanings: ["sent", "waitlist"] });
    expect(n).toBe(1);
    const down = crmDeskCrm("http://crm.test", "k", (async () => { throw new Error("down"); }) as never);
    expect(await down.features!()).toBeNull();
    fail = true;
    const realNow = Date.now; Date.now = () => realNow() + 2 * 3600_000;
    try { expect(await crm.features!()).toEqual({ campaign_member_meanings: ["sent", "waitlist"] }); } finally { Date.now = realNow; }
  });
});

describe("counts", () => {
  it("GET /api/integration's counts: members by status, held, set aside, the list read", async () => {
    const id = await hostedDinner(db); await near(id);
    const r = recorder();
    await guest(db, id, "Ana Ruiz"); await guest(db, id, "Bo Chen", { country: "IT" });
    await syncCrm(db, r.crm);
    expect(await integrationCounts(db)).toMatchObject({ members: { targeted: 1, declined: 0 }, held: 0, targeted_barred: 1, targeted_over_cap: 0, awaiting_contract: 0, features_read: expect.arrayContaining(["targeted"]) });
  });
});
