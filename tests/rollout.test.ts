/* Going live carefully, and the CRM's own view of the account. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import type { ToolEvent } from "../src/server/connectors/types.ts";
import { runGate } from "../src/server/gate.ts";
import { ingestCrmMeetings } from "../src/server/meetings.ts";
import { ingestEvents, processInbound } from "../src/server/replies.ts";
import { attachCampaign, confirmLaunchChecklist, createDrafts, drainOps, flagSweep, observeSequences, releaseSequence } from "../src/server/sequences.ts";
import { stopDomain } from "../src/server/enroll-ops.ts";
import { addHold } from "../src/server/touches.ts";
import { freshDb } from "./helpers.ts";
import { deliveredInMotion, enrollmentStates, fakeCrm, MAYA, personAt, type Harness } from "./lifecycle-harness.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
const seqOf = async (h: Harness, channel: string) => (await db.query<{ id: string; external_id: string; state: string }>("SELECT id, external_id, state FROM sequences WHERE event_id = $1 AND channel = $2 ORDER BY created_at LIMIT 1", [h.id, channel]))[0];
let n = 0;
const reply = (who: string, body: string, seq: string): ToolEvent => ({ provider_message_id: `reply:r${++n}`, signal: "reply", channel: "email", sequence_external_id: seq, email: who, linkedin: null, external_contact_id: null, body, at: "2027-01-12T10:00:00Z" });
async function launched(h: Harness) {
  await createDrafts(db, h.deps, h.id, MAYA);
  await attachCampaign(db, h.deps, (await seqOf(h, "linkedin")).id, h.li.newSeq(), MAYA);
  for (const s of await db.query<{ id: string }>("SELECT id FROM sequences WHERE event_id = $1", [h.id])) await confirmLaunchChecklist(db, s.id, MAYA);
  const e = await seqOf(h, "email"), l = await seqOf(h, "linkedin");
  h.email.launch(e.external_id); h.li.launch(l.external_id);
  await observeSequences(db, h.deps); await drainOps(db, h.deps);
  return { e, l };
}

describe("going live", () => {
  it("points each tool's webhooks at the desk, once", async () => {
    const h = await deliveredInMotion(db);
    h.deps.webhookBase = "https://desk.example/";
    await createDrafts(db, h.deps, h.id, MAYA);
    await createDrafts(db, h.deps, h.id, MAYA);
    expect((h.email as any).hooks).toEqual([expect.objectContaining({ target_hook_url: "https://desk.example/hooks/sequencer/instantly", headers: { "x-desk-secret": h.email.webhookSecret } })]);
  });

  it("on a real tool, sends a small first cohort and holds the rest until a person releases them", async () => {
    const h = await deliveredInMotion(db);
    h.deps.firstCohort = 2;
    h.email.connector.simulated = false;
    await db.query("UPDATE contacts SET priority = 'A' WHERE event_id = $1", [h.id]);
    await db.query("UPDATE contacts SET person_location = 'Madrid, Spain' WHERE event_id = $1", [h.id]);
    await db.query("UPDATE companies SET primary_domain = 'tallgrasssoftware.example' WHERE event_id = $1", [h.id]);
    await db.query("UPDATE contacts SET company_id = (SELECT company_id FROM contacts WHERE full_name = 'Ana Ruiz' AND event_id = $1) WHERE event_id = $1", [h.id]);
    await createDrafts(db, h.deps, h.id, MAYA);
    await db.query("UPDATE enrollments SET retry_after = NULL");
    await drainOps(db, h.deps);
    const e = await seqOf(h, "email");
    expect(h.email.seqs.get(e.external_id)!.people.size).toBe(2);
    await releaseSequence(db, h.deps, e.id, MAYA);
    expect(h.email.seqs.get(e.external_id)!.people.size).toBe(4);
    await expect(releaseSequence(db, h.deps, e.id, MAYA)).rejects.toThrow(/already/);
  });

  it("the demo's simulated tool is not held back", async () => {
    const h = await deliveredInMotion(db);
    h.deps.firstCohort = 1;
    h.email.connector.simulated = true;
    await createDrafts(db, h.deps, h.id, MAYA);
    const left = await db.query("SELECT 1 FROM enrollments WHERE event_id = $1 AND channel = 'email' AND state = 'adding' AND retry_after IS NULL", [h.id]);
    expect(left).toHaveLength(0);
    expect([...h.email.seqs.values()].reduce((n, x) => n + x.people.size, 0)).toBeGreaterThan(1);
  });
});

describe("one company, several domains", () => {
  it("a hold on one domain stops the same company's other domain", async () => {
    const h = await deliveredInMotion(db);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await db.query("INSERT INTO account_domains (domain, canonical, how, added_by) VALUES ('tallgrass-legacy.example', 'tallgrasssoftware.example', 'person', 'GTM')");
    await db.tx((q) => addHold(q, { domain: "tallgrass-legacy.example", cause: "meeting", cause_id: "m1", expires_at: new Date(h.time.now.getTime() + 86_400_000) }));
    expect((await runGate(db, h.deps, h.id, [ana.id], "email", "add"))[0].reason).toBe("hold:meeting");
  });

  it("stopping a domain reaches its aliases", async () => {
    const h = await deliveredInMotion(db);
    await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await db.query("INSERT INTO account_domains (domain, canonical, how, added_by) VALUES ('tallgrass.example', 'tallgrasssoftware.example', 'person', 'GTM')");
    await db.tx((q) => stopDomain(q, "tallgrass.example", "pause", "test", null));
    expect((await enrollmentStates(db, ana.id)).every((x) => x.state === "paused")).toBe(true);
  });
});

describe("the CRM's own view", () => {
  it("a meeting logged only in the CRM sets a hold, counted once per person", async () => {
    const h = await deliveredInMotion(db);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    h.deps.crm = fakeCrm({ meetings: async () => [{ id: "e1", email: ana.email, start: "2027-01-12T15:00:00Z", timezone: null, organizer: "R", status: "held" }, { id: "e1", email: ana.email, start: "2027-01-12T15:00:00Z", timezone: null, organizer: "R", status: "held" }] } as never);
    await ingestCrmMeetings(db, h.deps);
    expect(await db.query("SELECT 1 FROM meetings WHERE status = 'held'")).toHaveLength(1);
    expect((await runGate(db, h.deps, h.id, [ana.id], "email", "add"))[0].reason).toBe("hold:meeting");
  });

  it("a deal that reached a late stage after launch pauses that account for its owner", async () => {
    const crm = fakeCrm();
    const h = await deliveredInMotion(db, { crm });
    await db.query("UPDATE events SET motion = 'sequencing' WHERE id = $1", [h.id]);
    const { openOwnerDecisions } = await import("../src/server/owners.ts");
    await openOwnerDecisions(db, h.deps, h.id);
    await db.query("UPDATE owner_decisions SET status = 'include', via = 'default' WHERE event_id = $1", [h.id]);
    await launched(h);
    crm.lookupByDomain = async (d: string) => ({ owner: "P", deal_name: "x", deal_stage: d.startsWith("tallgrass") ? "Negotiation" : null, last_activity: null, heat: "cold" as never });
    const r = await flagSweep(db, h.deps);
    expect(r.paused).toBe(1);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    expect((await enrollmentStates(db, ana.id)).every((x) => x.state === "paused" && x.cause === "new_late_deal")).toBe(true);
  });
});

describe("a reply can say two things", () => {
  it("someone who left and named a replacement opens both the successor and the referral", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await ingestEvents(db, h.deps, h.email.connector, [reply(ana.email, "I left the company. Please talk to Jane Doe instead.", e.external_id)]);
    await processInbound(db, h.deps);
    const kinds = (await db.query<{ kind: string }>("SELECT kind FROM review_cases WHERE kind IN ('successor', 'referral') ORDER BY kind")).map((r) => r.kind);
    expect(kinds).toEqual(["referral", "successor"]);
  });

  it("a name the model made up is not used", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    h.deps.llm = { model: "t", complete: async () => ({ text: '{"code":"interested","referred":"Invented Person","same_person":true}', input_tokens: 0, output_tokens: 0 }) };
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await ingestEvents(db, h.deps, h.email.connector, [reply(ana.email, "Sounds good", e.external_id)]);
    await processInbound(db, h.deps);
    expect(await db.query("SELECT 1 FROM review_cases WHERE kind = 'referral'")).toHaveLength(0);
  });

  it("an assistant's yes is not read as the contact's", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await ingestEvents(db, h.deps, h.email.connector, [reply(ana.email, "Writing on behalf of Ana, she is interested.", e.external_id)]);
    await processInbound(db, h.deps);
    expect((await db.query<{ doubtful: boolean; code: string | null }>("SELECT doubtful, code FROM inbound_messages"))[0]).toEqual({ doubtful: true, code: null });
  });
});
