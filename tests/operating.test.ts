/* Who hears, how fast, whether anyone would notice it stopped, and whether the event paid for itself. */

import { beforeEach, describe, expect, it } from "vitest";
import { computeScorecard, recordEventCost, COST_CATEGORIES } from "../src/server/closeout.ts";
import type { Db } from "../src/server/db.ts";
import { fakeInstantly } from "../src/server/connectors/fake.ts";
import type { ToolEvent } from "../src/server/connectors/types.ts";
import { runGate } from "../src/server/gate.ts";
import { lifecycleTick, pollTools } from "../src/server/lifecycle-tick.ts";
import { blindSweep, captureOnsite, drainNotifications, escalateWaiting, forgetPerson, markHandled, raiseAlert, recordRun } from "../src/server/operating.ts";
import { bookMeeting, recordOutcome } from "../src/server/meetings.ts";
import { drainOutbox } from "../src/server/crm-outbox.ts";
import { ingestEvents, processInbound } from "../src/server/replies.ts";
import { attachCampaign, approveTemplate, confirmLaunchChecklist, createDrafts, drainOps, heldOut, observeSequences } from "../src/server/sequences.ts";
import { planSenders, recordConsent, recordPlacement, setDomainStatus } from "../src/server/sending.ts";
import { cleanNames, lintTemplate, renderStep } from "../src/shared/template-check.ts";
import { planCapacity, timingFits, pickSenders, type SenderInfo } from "../src/shared/sending.ts";
import type { CrmOpportunity, CrmRecord } from "../src/server/providers.ts";
import { freshDb } from "./helpers.ts";
import { clock, deliveredInMotion, enrollmentStates, fakeCrm, MAYA, OWNER, personAt, type Harness } from "./lifecycle-harness.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
let n = 0;
const reply = (who: string, body: string | null, seq: string, signal: ToolEvent["signal"] = "reply"): ToolEvent => ({ provider_message_id: `${signal}:o${++n}`, signal, channel: "email", sequence_external_id: seq, email: who, linkedin: null, external_contact_id: null, body, at: "2027-01-12T10:00:00Z" });
const seqOf = async (h: Harness, channel: string) => (await db.query<{ id: string; external_id: string; state: string }>("SELECT id, external_id, state FROM sequences WHERE event_id = $1 AND channel = $2 ORDER BY created_at LIMIT 1", [h.id, channel]))[0];
async function launched(h: Harness) {
  await createDrafts(db, h.deps, h.id, MAYA);
  await attachCampaign(db, h.deps, (await seqOf(h, "linkedin")).id, h.li.newSeq(), MAYA);
  for (const s of await db.query<{ id: string }>("SELECT id FROM sequences WHERE event_id = $1", [h.id])) await confirmLaunchChecklist(db, s.id, MAYA);
  const e = await seqOf(h, "email"), l = await seqOf(h, "linkedin");
  h.email.launch(e.external_id); h.li.launch(l.external_id);
  await observeSequences(db, h.deps); await drainOps(db, h.deps);
  return { e, l };
}
const open = (over: Partial<CrmOpportunity>): CrmOpportunity => ({ id: "o1", stage: "Proposal", amount_cents: 5_000_000, created_date: "2027-02-01", stage_history: [], ...over });

describe("who hears about a reply", () => {
  const go = async (crm = fakeCrm()) => {
    const h = await deliveredInMotion(db, { crm });
    await db.query("UPDATE events SET motion = 'sequencing' WHERE id = $1", [h.id]);
    const { openOwnerDecisions } = await import("../src/server/owners.ts");
    await openOwnerDecisions(db, h.deps, h.id);
    await db.query("UPDATE owner_decisions SET status = 'include', via = 'default' WHERE event_id = $1", [h.id]);
    const { e } = await launched(h);
    return { h, e, ana: await personAt(db, h.id, "Ana Ruiz"), ben: await personAt(db, h.id, "Ben Ode") };
  };

  it("goes straight to the account's owner, on a clock", async () => {
    const { h, e, ana } = await go();
    await ingestEvents(db, h.deps, h.email.connector, [reply(ana.email, "Sounds good, tell me more", e.external_id)]);
    await processInbound(db, h.deps); await drainNotifications(db, h.deps);
    expect(h.notify.sent.some((x) => x.to === "UOWNER" && /is interested/.test(x.card.text))).toBe(true);
    const [m] = await db.query<{ owner: string; respond_by: string | null }>("SELECT owner, respond_by::text AS respond_by FROM inbound_messages");
    expect(m.owner).toBe(OWNER); expect(m.respond_by).not.toBeNull();
  });

  it("a Slack outage loses nothing: the message waits and goes later", async () => {
    const { h, e, ana } = await go();
    await ingestEvents(db, h.deps, h.email.connector, [reply(ana.email, "Sounds good, tell me more", e.external_id)]);
    h.notify.fail = true;
    await processInbound(db, h.deps); await drainNotifications(db, h.deps);
    expect(h.notify.sent.filter((x) => /is interested/.test(x.card.text))).toHaveLength(0);
    h.notify.fail = false;
    await drainNotifications(db, h.deps);
    expect(h.notify.sent.filter((x) => /is interested/.test(x.card.text))).toHaveLength(1);
  });

  it("a message that never sends raises an alert instead of vanishing", async () => {
    const { h, e, ana } = await go();
    await ingestEvents(db, h.deps, h.email.connector, [reply(ana.email, "Sounds good, tell me more", e.external_id)]);
    await processInbound(db, h.deps);
    h.notify.fail = true;
    for (let i = 0; i < 5; i++) await drainNotifications(db, h.deps);
    expect((await db.query("SELECT 1 FROM alerts WHERE key LIKE 'notify:%'")).length).toBeGreaterThan(0);
  });

  it("nobody answering escalates to the uploader, once", async () => {
    const { h, e, ana } = await go();
    h.deps.userMap = { ...h.deps.userMap, [MAYA]: "UMAYA" };
    await ingestEvents(db, h.deps, h.email.connector, [reply(ana.email, "Sounds good, tell me more", e.external_id)]);
    await processInbound(db, h.deps);
    h.time.forward(5);
    await escalateWaiting(db, h.deps); await escalateWaiting(db, h.deps); await drainNotifications(db, h.deps);
    expect(h.notify.sent.filter((x) => x.to === "UMAYA" && /Nobody has answered/.test(x.card.text))).toHaveLength(1);
  });

  it("handled replies do not escalate", async () => {
    const { h, e, ana } = await go();
    await ingestEvents(db, h.deps, h.email.connector, [reply(ana.email, "Sounds good, tell me more", e.external_id)]);
    await processInbound(db, h.deps);
    const [m] = await db.query<{ id: string }>("SELECT id FROM inbound_messages");
    await markHandled(db, m.id, "R");
    h.time.forward(5);
    expect((await escalateWaiting(db, h.deps)).escalated).toBe(0);
  });

  it("a yes stops colleagues at the company too", async () => {
    const { h, e, ana, ben } = await go();
    await ingestEvents(db, h.deps, h.email.connector, [reply(ana.email, "Sounds good, tell me more", e.external_id)]);
    await processInbound(db, h.deps);
    expect((await enrollmentStates(db, ben.id)).every((x) => x.state === "paused" && x.cause === "colleague_replied")).toBe(true);
  });

  it("a positive reply creates its CRM trail, even with Leads off", async () => {
    const records: Record<string, CrmRecord[]> = {};
    const made: string[] = [];
    const crm = fakeCrm({ records, write: async () => {}, createLead: async () => { made.push("lead"); return { id: "L" }; }, createTask: async () => { made.push("task"); return { id: "T" }; }, findTaskByKey: async () => null, createCampaignMember: async (a: any) => { made.push(`member:${a.status}`); return { id: "M" }; } } as never);
    const { h, e, ana } = await go(crm);
    await ingestEvents(db, h.deps, h.email.connector, [reply(ana.email, "Sounds good, tell me more", e.external_id)]);
    await processInbound(db, h.deps);
    await drainOutbox(db, crm);
    expect(made).toContain("lead");
    records[ana.email] = [{ id: "003", object: "Lead", email: ana.email, email_opt_out: false, do_not_contact: false, do_not_call: false, bounced_at: null }];
    await db.query("UPDATE crm_outbox SET status = 'queued' WHERE kind IN ('task', 'campaign_member')");
    await drainOutbox(db, crm);
    expect(made).toContain("task");
    expect(made).toContain("member:Responded");
  });

  it("a reply nobody can be matched to is kept and raises an alert, and a stranger's opt-out still counts", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    await ingestEvents(db, h.deps, h.email.connector, [reply("colleague@else.example", "Please remove me from this", e.external_id)]);
    expect((await db.query<{ status: string }>("SELECT status FROM inbound_messages"))[0].status).toBe("unmatched");
    expect(await db.query("SELECT 1 FROM alerts WHERE key LIKE 'unmatched:%'")).toHaveLength(1);
    expect(await db.query("SELECT 1 FROM suppressions WHERE email = 'colleague@else.example'")).toHaveLength(1);
  });
});

describe("met in person", () => {
  it("stops the automated outreach right away, for someone on the list", async () => {
    const h = await deliveredInMotion(db);
    await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    const r = await captureOnsite(db, h.deps, h.id, "Rep A", { email: ana.email, note: "Wants a demo", temperature: "hot", met: true });
    expect(r.on_list).toBe(true);
    expect((await enrollmentStates(db, ana.id)).every((x) => x.state === "paused" && x.cause === "met_onsite")).toBe(true);
    expect(await db.query("SELECT 1 FROM meetings WHERE contact_id = $1 AND status = 'held' AND source = 'onsite'", [ana.id])).toHaveLength(1);
  });

  it("records a walk-up who is on no list, and counts the meeting", async () => {
    const h = await deliveredInMotion(db);
    const r = await captureOnsite(db, h.deps, h.id, "Rep A", { full_name: "Walk Up", email: "walk@newco.example", company: "NewCo", met: true });
    expect(r.on_list).toBe(false);
    expect((await db.query<{ source: string }>("SELECT source FROM contacts WHERE id = $1", [r.contact_id]))[0].source).toBe("onsite");
    expect((await db.query<{ held_all: number }>("SELECT held_all FROM event_funnel WHERE event_id = $1", [h.id]))[0].held_all).toBe(1);
  });

  it("needs something to identify the person", async () => {
    const h = await deliveredInMotion(db);
    await expect(captureOnsite(db, h.deps, h.id, "R", { note: "nice chat" })).rejects.toThrow(/Give an email/);
  });
});

describe("a no carries over", () => {
  it("not interested blocks the next event for six months, not now for three", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await ingestEvents(db, h.deps, h.email.connector, [reply(ana.email, "Not interested, thanks", e.external_id)]);
    await processInbound(db, h.deps);
    const h2 = await deliveredInMotion(db, { time: h.time });
    const a2 = await personAt(db, h2.id, "Ana Ruiz");
    h.time.forward(100);
    await db.query("UPDATE verification_cache SET checked_at = $1", [h.time.now.toISOString()]);
    expect((await runGate(db, h2.deps, h2.id, [a2.id], "email", "add"))[0].reason).toBe("cool_off");
    h.time.forward(100);
    await db.query("UPDATE verification_cache SET checked_at = $1", [h.time.now.toISOString()]);
    expect((await runGate(db, h2.deps, h2.id, [a2.id], "email", "add"))[0].reason).not.toBe("cool_off");
  });
});

describe("someone would notice", () => {
  it("records each poll, and a poll that fails or answers oddly is not silence", async () => {
    const h = await deliveredInMotion(db);
    await launched(h);
    await pollTools(db, h.deps);
    expect((await db.query<{ last_ok_at: string | null }>("SELECT last_ok_at FROM connector_runs WHERE connector = 'instantly'"))[0].last_ok_at).not.toBeNull();
    h.email.down = true;
    await pollTools(db, h.deps);
    expect((await db.query<{ last_error: string | null }>("SELECT last_error FROM connector_runs WHERE connector = 'instantly'"))[0].last_error).toMatch(/503/);
  });

  it("a tool that says OK with no list in it counts as a failure", async () => {
    const t = fakeInstantly();
    const real = fetch;
    void real;
    const { instantly } = await import("../src/server/connectors/tools.ts");
    const c = instantly({ apiKey: "k", webhookSecret: "s", fetch: (async () => new Response(JSON.stringify({ error: "auth" }), { status: 200 })) as typeof fetch });
    await expect(c.events("2000-01-01", ["x"])).rejects.toThrow(/no list/);
    void t;
  });

  it("a live sequence the desk cannot hear pauses and alerts", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    await recordRun(db, "instantly", true, 0);
    await recordRun(db, "heyreach", true, 0);
    h.time.set(new Date(Date.now() + 90 * 60_000).toISOString());
    const out = await blindSweep(db, h.deps, async () => new Date(Date.now()));
    expect(out.paused).toBe(2);
    expect((await seqOf(h, "email")).state).toBe("paused");
    expect(h.email.seqs.get(e.external_id)!.status).toBe("2");
    expect(await db.query("SELECT 1 FROM alerts WHERE key LIKE 'blind:%'")).toHaveLength(2);
  });

  it("raises one alert per problem per day", async () => {
    const h = await deliveredInMotion(db);
    expect(await raiseAlert(db, h.deps, "k", "x")).toBe(true);
    expect(await raiseAlert(db, h.deps, "k", "x")).toBe(false);
  });

  it("a full pass runs with a tool down and reports it", async () => {
    const h = await deliveredInMotion(db);
    await launched(h);
    h.email.down = true;
    await lifecycleTick(db, h.deps, { flags: true, nightly: true });
    expect((await db.query<{ failures: unknown[] }>("SELECT failures FROM integrity_runs"))).toHaveLength(1);
  });
});

describe("what goes out", () => {
  it("refuses a template with a broken field, an empty step or steps out of order", () => {
    expect(lintTemplate("email", [{ day: 0, subject: "x", body: "Hi {{frist_name}}" }]).errors[0]).toMatch(/cannot fill/);
    expect(lintTemplate("email", [{ day: 0, subject: "x", body: "  " }]).errors[0]).toMatch(/no text/);
    expect(lintTemplate("email", [{ day: 3, subject: "x", body: "a" }, { day: 1, body: "b" }]).errors[0]).toMatch(/after the step/);
    expect(lintTemplate("email", [{ day: 0, body: "a" }]).errors[0]).toMatch(/subject/);
    expect(lintTemplate("linkedin", [{ day: 0, body: "x".repeat(301) }]).errors[0]).toMatch(/300/);
  });

  it("names any field with no value in a preview", () => {
    const r = renderStep({ day: 0, body: "Hi {{first_name}} at {{booth}}" }, { first_name: "Ana", last_name: "", company: "A", title: null, event: "E" });
    expect(r.body).toBe("Hi Ana at [booth]"); expect(r.missing).toEqual(["booth"]);
  });

  it("cleans a name before anyone is greeted by it", () => {
    expect(cleanNames("DR. ANA RUIZ PHD")).toEqual({ first_name: "Ana", last_name: "Ruiz" });
    expect(cleanNames("Prof. María de la Cruz")).toEqual({ first_name: "María", last_name: "de la Cruz" });
    expect(cleanNames("mary-jane o'neil")).toEqual({ first_name: "Mary-Jane", last_name: "O'Neil" });
    expect(cleanNames("McKenzie DeWitt")).toEqual({ first_name: "McKenzie", last_name: "DeWitt" });
  });

  it("will not launch if someone edited the words in the tool", async () => {
    const h = await deliveredInMotion(db);
    await createDrafts(db, h.deps, h.id, MAYA);
    const e = await seqOf(h, "email");
    await confirmLaunchChecklist(db, e.id, MAYA);
    (h.email as any).settings.get(e.external_id).sequences[0].steps[0].variants[0].body = "Something else entirely";
    h.email.launch(e.external_id);
    await observeSequences(db, h.deps);
    expect((await seqOf(h, "email")).state).toBe("paused");
  });

  it("staggers people at one company", async () => {
    const h = await deliveredInMotion(db, { csv: `Company,Name,Title,Email,LinkedIn\n${[1, 2, 3, 4, 5].map((i) => `Tallgrass Software,P${i} Ode,VP Sales,p${i}@tallgrasssoftware.example,`).join("\n")}\n` });
    await createDrafts(db, h.deps, h.id, MAYA);
    const later = await db.query("SELECT 1 FROM enrollments WHERE event_id = $1 AND channel = 'email' AND retry_after IS NOT NULL", [h.id]);
    expect(later).toHaveLength(3);
  });

  it("says when a cadence cannot finish before the event", async () => {
    expect(timingFits([0, 3, 7], 5, 30).fits).toBe(true);
    expect(timingFits([0, 3, 7], 5, 8)).toEqual({ needed: 12, fits: false });
    const h = await deliveredInMotion(db, { time: clock("2026-12-30T12:00:00Z") });
    await createDrafts(db, h.deps, h.id, MAYA);
    expect((await db.query<{ timing_note: string | null }>("SELECT timing_note FROM sequences WHERE event_id = $1 AND channel = 'email'", [h.id]))[0].timing_note).toMatch(/cut off/);
  });
});

describe("senders", () => {
  const sender = (over: Partial<SenderInfo>): SenderInfo => ({ id: "a", address: "a@a.example", domain: "a.example", channel: "email", active: true, daily_limit: 50, health: 95, warm_days: 40, bounce_rate: 0, spam_rate: 0, ...over });

  it("sizes LinkedIn on connection requests, not on every step", () => {
    expect(planCapacity(100, [0, 3, 7], "linkedin").peak_daily).toBe(20);
    expect(planCapacity(100, [0, 3, 7], "email").peak_daily).toBeGreaterThan(20);
  });

  it("gives a sender still building up half a day's volume", () => {
    const plan = planCapacity(150, [0], "email");
    expect(pickSenders([sender({ warm_days: 20 }), sender({ id: "b", address: "b@a.example", health: 90 })], plan, {}).picked.map((p) => p.share)).toEqual([15, 15]);
  });

  it("refuses a sender with warmup switched off", () => {
    expect(pickSenders([sender({ warmup_on: false })], planCapacity(150, [0], "email"), {}).excluded[0].reason).toBe("warmup_off");
  });

  it("never uses a burned domain or the company's own", async () => {
    const h = await deliveredInMotion(db);
    await setDomainStatus(db, "send.example", "burned", "Spam complaints", "GTM");
    await createDrafts(db, h.deps, h.id, MAYA);
    const [s] = await db.query<{ sender_status: string; sender_excluded: { reason: string }[] }>("SELECT sender_status, sender_excluded FROM sequences WHERE event_id = $1 AND channel = 'email'", [h.id]);
    expect(s.sender_status).toBe("short"); expect(s.sender_excluded[0].reason).toBe("burned");
    await setDomainStatus(db, "send.example", "healthy", "", "GTM");
    h.deps.primaryDomains = ["send.example"];
    await planSenders(db, h.deps, (await seqOf(h, "email")).id);
    expect((await db.query<{ sender_excluded: { reason: string }[] }>("SELECT sender_excluded FROM sequences WHERE event_id = $1 AND channel = 'email'", [h.id]))[0].sender_excluded[0].reason).toBe("primary_domain");
  });

  it("judges placement at each mail provider, and an untested provider fails", async () => {
    const h = await deliveredInMotion(db);
    h.deps.placementRequired = true;
    await recordPlacement(db, { domain: "send.example", provider: "google", inbox_rate: 0.95, tool: "t", tested_at: h.time.now.toISOString() });
    await createDrafts(db, h.deps, h.id, MAYA);
    const reason = async () => (await db.query<{ sender_excluded: { reason: string }[] }>("SELECT sender_excluded FROM sequences WHERE event_id = $1 AND channel = 'email'", [h.id]))[0].sender_excluded[0]?.reason;
    expect(await reason()).toBe("not_tested");
    await recordPlacement(db, { domain: "send.example", provider: "microsoft", inbox_rate: 0.4, tool: "t", tested_at: h.time.now.toISOString() });
    await planSenders(db, h.deps, (await seqOf(h, "email")).id);
    expect(await reason()).toBe("failed_placement");
    await recordPlacement(db, { domain: "send.example", provider: "microsoft", inbox_rate: 0.9, tool: "t", tested_at: new Date(h.time.now.getTime() + 1000).toISOString() });
    await planSenders(db, h.deps, (await seqOf(h, "email")).id);
    expect((await db.query<{ sender_status: string }>("SELECT sender_status FROM sequences WHERE event_id = $1 AND channel = 'email'", [h.id]))[0].sender_status).toBe("ok");
  });

  it("uses no LinkedIn account until its rep has agreed", async () => {
    const h = await deliveredInMotion(db);
    await db.query("DELETE FROM sender_consents");
    await createDrafts(db, h.deps, h.id, MAYA);
    const li = await seqOf(h, "linkedin");
    await attachCampaign(db, h.deps, li.id, h.li.newSeq(), MAYA);
    const read = async () => (await db.query<{ sender_status: string; sender_excluded: { reason: string }[] }>("SELECT sender_status, sender_excluded FROM sequences WHERE id = $1", [li.id]))[0];
    expect(await read()).toMatchObject({ sender_status: "short" });
    expect((await read()).sender_excluded[0].reason).toBe("no_consent");
    await recordConsent(db, "heyreach", "1", "A Rep", MAYA);
    await planSenders(db, h.deps, li.id);
    expect((await read()).sender_status).toBe("ok");
  });
});

describe("erasure", () => {
  it("removes what is held and keeps only the block", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await ingestEvents(db, h.deps, h.email.connector, [reply(ana.email, "Sounds good", e.external_id)]);
    await forgetPerson(db, h.deps, ana.email, "GTM");
    const [c] = await db.query<{ full_name: string | null; email: string | null }>("SELECT full_name, email FROM contacts WHERE id = $1", [ana.id]);
    expect(c).toEqual({ full_name: null, email: null });
    expect((await db.query<{ body: string | null }>("SELECT body FROM inbound_messages"))[0].body).toBeNull();
    expect(await db.query("SELECT 1 FROM suppressions WHERE email = $1", [ana.email])).toHaveLength(1);
    expect((await enrollmentStates(db, ana.id)).every((x) => x.state === "removed")).toBe(true);
  });
});

describe("event ROI", () => {
  const scored = async (opps: Record<string, CrmOpportunity[]>, costs = true) => {
    const crm = fakeCrm({ opportunities: async (a: any[]) => Object.fromEntries(a.map((x: any) => [x.ref, opps[x.ref] ?? []])) } as never);
    const h = await deliveredInMotion(db, { crm });
    await db.query("UPDATE events SET motion = 'sequencing' WHERE id = $1", [h.id]);
    if (costs) await recordEventCost(db, h.id, MAYA, "sponsorship", 1_000_000, "Gold");
    const ana = await personAt(db, h.id, "Ana Ruiz");
    const m = await bookMeeting(db, h.deps, { contact_id: ana.id, scheduled_at: "2027-01-15T15:00:00Z", source: "manual", rep: "R" }, "R");
    await recordOutcome(db, h.deps, m.id, "held", "R");
    return { h, crm };
  };
  const D = "tallgrasssoftware.example";

  it("separates sourced from influenced, and reports per dollar", async () => {
    const { h } = await scored({ [D]: [open({ id: "new", created_date: "2027-02-01" }), open({ id: "old", amount_cents: 2_000_000, created_date: "2026-11-01", stage_history: [{ stage: "Negotiation", at: "2027-02-10" }] })] });
    const s = await computeScorecard(db, h.deps, h.id, 30);
    expect(s.influence.sourced).toEqual({ n: 1, cents: 5_000_000 });
    expect(s.influence.influenced).toEqual({ n: 1, cents: 2_000_000 });
    expect(s.roi.pipeline_per_dollar).toBe(7);
  });

  it("does not credit a deal that was already open and did not move", async () => {
    const { h } = await scored({ [D]: [open({ id: "old", created_date: "2026-11-01", stage_history: [{ stage: "Discovery", at: "2026-12-01" }] })] });
    expect((await computeScorecard(db, h.deps, h.id, 30)).influence.opportunities).toBe(0);
  });

  it("does not credit a deal that moved to lost", async () => {
    const { h } = await scored({ [D]: [open({ id: "old", created_date: "2026-11-01", stage_history: [{ stage: "Closed Lost", at: "2027-02-01" }] })] });
    expect((await computeScorecard(db, h.deps, h.id, 30)).influence.opportunities).toBe(0);
  });

  it("tracks closed-won separately", async () => {
    const { h } = await scored({ [D]: [open({ id: "w", is_won: true, is_closed: true })] });
    const s = await computeScorecard(db, h.deps, h.id, 90);
    expect(s.influence.won).toEqual({ n: 1, cents: 5_000_000 });
    expect(s.roi.won_per_dollar).toBe(5);
  });

  it("counts one deal for one event", async () => {
    const shared = { [D]: [open({ id: "same" })] };
    const a = await scored(shared);
    await computeScorecard(db, a.h.deps, a.h.id, 30);
    const crm = fakeCrm({ opportunities: async (x: any[]) => Object.fromEntries(x.map((y: any) => [y.ref, shared[y.ref as typeof D] ?? []])) } as never);
    const b = await deliveredInMotion(db, { crm });
    const ana2 = await personAt(db, b.id, "Ana Ruiz");
    const m = await bookMeeting(db, b.deps, { contact_id: ana2.id, scheduled_at: "2027-01-20T15:00:00Z", source: "manual", rep: "R" }, "R");
    await db.query("UPDATE meetings SET event_id = $2 WHERE id = $1", [m.id, b.id]);
    await recordOutcome(db, b.deps, m.id, "held", "R");
    await computeScorecard(db, b.deps, b.id, 30);
    expect((await db.query("SELECT 1 FROM attribution_claims WHERE opportunity_id = 'same'"))).toHaveLength(1);
    expect((await computeScorecard(db, a.h.deps, a.h.id, 30)).influence.opportunities).toBe(0);
    expect((await computeScorecard(db, b.deps, b.id, 30)).influence.opportunities).toBe(1);
  });

  it("names the costs nobody entered, instead of counting them as zero", async () => {
    const { h } = await scored({}, true);
    const s = await computeScorecard(db, h.deps, h.id, 30);
    expect(s.cost.other_cents).toBe(1_000_000);
    expect(s.roi.cost_missing).toEqual(COST_CATEGORIES.filter((c) => c !== "sponsorship"));
  });

  it("flags a deal long past its close date", async () => {
    const { h } = await scored({ [D]: [open({ close_date: "2026-01-01" })] });
    expect((await computeScorecard(db, h.deps, h.id, 30)).influence.stale).toBe(1);
  });

  it("compares accounts met with accounts nobody reached", async () => {
    const { h } = await scored({ [D]: [open({})], "northwindsoftware.example": [open({ id: "ctl" })] });
    const s = await computeScorecard(db, h.deps, h.id, 30);
    expect(s.control).toMatchObject({ available: true, met_accounts: 1, met_with_pipeline: 1, control_with_pipeline: 1 });
    expect(s.control.control_accounts).toBeGreaterThan(0);
  });

  it("counts held meetings from outside sequences in the score", async () => {
    const h = await deliveredInMotion(db);
    await recordEventCost(db, h.id, MAYA, "booth", 500_000, "");
    for (let i = 0; i < 5; i++) await captureOnsite(db, h.deps, h.id, "R", { full_name: `W ${i}`, email: `w${i}@co${i}.example`, company: `Co ${i}`, met: true });
    const s = await computeScorecard(db, h.deps, h.id, 30);
    expect(s.held_all).toBe(5); expect(s.funnel.held).toBe(0); expect(s.score?.held_per_thousand).toBe(1);
  });

  it("no CRM means not available, never zero", async () => {
    const h = await deliveredInMotion(db);
    const s = await computeScorecard(db, h.deps, h.id, 30);
    expect(s.influence.available).toBe(false); expect(s.roi.pipeline_per_dollar).toBeNull();
  });

  it("holds out the same accounts every time", () => {
    const pick = (d: string) => heldOut(d, 10);
    const all = Array.from({ length: 2000 }, (_, i) => `d${i}.example`);
    const out = all.filter(pick);
    expect(out.length).toBeGreaterThan(120); expect(out.length).toBeLessThan(280);
    expect(all.filter(pick)).toEqual(out);
    expect(heldOut("x.example", 0)).toBe(false);
  });
});

void approveTemplate;
