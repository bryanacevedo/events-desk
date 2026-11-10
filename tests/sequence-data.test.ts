/* Each sequence keeps what the tools report about it (docs/SEQUENCES-VIEW.md): sends, LinkedIn invites and acceptances, replies,
   bounces and unsubscribes carry the sequence and step they came from, and the per-sequence read counts them one way. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { createApp } from "../src/server/app.ts";
import { ingestEvents, processInbound } from "../src/server/replies.ts";
import { attachCampaign, confirmLaunchChecklist, createDrafts, drainOps, observeSequences } from "../src/server/sequences.ts";
import { sequenceDetail, sequenceList } from "../src/server/sequence-view.ts";
import { heyreach, HEYREACH_EVENTS } from "../src/server/connectors/tools.ts";
import type { ToolEvent } from "../src/server/connectors/types.ts";
import { freshDb } from "./helpers.ts";
import { deliveredInMotion, MAYA, personAt, type Harness } from "./lifecycle-harness.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

let n = 0;
const ev = (over: Partial<ToolEvent> & Pick<ToolEvent, "signal">): ToolEvent => ({ provider_message_id: `${over.signal}:m${++n}`, channel: "email", sequence_external_id: null, email: null, linkedin: null, external_contact_id: null, body: null, at: "2027-01-12T10:00:00Z", ...over });
const seqOf = async (h: Harness, channel: string) => (await db.query<{ id: string; external_id: string }>("SELECT id, external_id FROM sequences WHERE event_id = $1 AND channel = $2 LIMIT 1", [h.id, channel]))[0];

async function launched(h: Harness) {
  await createDrafts(db, h.deps, h.id, MAYA);
  const raw = await seqOf(h, "linkedin");
  await attachCampaign(db, h.deps, raw.id, h.li.newSeq(), MAYA);
  for (const s of await db.query<{ id: string }>("SELECT id FROM sequences WHERE event_id = $1", [h.id])) await confirmLaunchChecklist(db, s.id, MAYA);
  const e = await seqOf(h, "email"), l = await seqOf(h, "linkedin");
  h.email.launch(e.external_id); h.li.launch(l.external_id);
  await observeSequences(db, h.deps); await drainOps(db, h.deps);
  return { e, l };
}

describe("tool events keep their sequence and step", () => {
  it("a send, a reply and a bounce carry the sequence; the reply takes the step of the last send", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await ingestEvents(db, h.deps, h.email.connector, [ev({ signal: "send", email: ana.email, sequence_external_id: e.external_id, step: 2, sender: "s0@send.example" })]);
    await ingestEvents(db, h.deps, h.email.connector, [ev({ signal: "reply", email: ana.email, sequence_external_id: e.external_id, body: "Sounds good, tell me more" })]);
    const [t] = await db.query<{ sequence_id: string; step: number; sender: string; action: string | null }>("SELECT sequence_id, step, sender, action FROM touches WHERE contact_id = $1 AND kind = 'send'", [ana.id]);
    expect(t).toMatchObject({ sequence_id: e.id, step: 2, sender: "s0@send.example", action: null });
    const [m] = await db.query<{ sequence_id: string; step: number }>("SELECT sequence_id, step FROM inbound_messages WHERE contact_id = $1", [ana.id]);
    expect(m).toEqual({ sequence_id: e.id, step: 2 });
    await processInbound(db, h.deps);
    const coded = await db.query<{ sequence_id: string }>("SELECT sequence_id FROM touches WHERE contact_id = $1 AND kind LIKE 'reply\\_%'", [ana.id]);
    expect(coded.length).toBeGreaterThan(0);
    expect(coded.every((x) => x.sequence_id === e.id)).toBe(true);
  });

  it("a LinkedIn invite is a send that pauses nobody and writes no inbound row; an acceptance is recorded", async () => {
    const h = await deliveredInMotion(db);
    const { l } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    const before = await db.query<{ state: string }>("SELECT state FROM enrollments WHERE contact_id = $1 AND channel = 'linkedin'", [ana.id]);
    await ingestEvents(db, h.deps, h.li.connector, [
      ev({ signal: "invite", channel: "linkedin", linkedin: ana.linkedin, external_contact_id: ana.linkedin, sequence_external_id: l.external_id }),
      ev({ signal: "accepted", channel: "linkedin", linkedin: ana.linkedin, external_contact_id: ana.linkedin, sequence_external_id: l.external_id }),
    ]);
    const touches = await db.query<{ kind: string; action: string | null; sequence_id: string }>("SELECT kind, action, sequence_id FROM touches WHERE contact_id = $1 AND channel = 'linkedin' AND kind IN ('send', 'accepted') ORDER BY kind DESC", [ana.id]);
    expect(touches).toEqual([{ kind: "send", action: "invite", sequence_id: l.id }, { kind: "accepted", action: null, sequence_id: l.id }]);
    expect(await db.query("SELECT 1 FROM inbound_messages WHERE contact_id = $1", [ana.id])).toHaveLength(0);
    expect(await db.query<{ state: string }>("SELECT state FROM enrollments WHERE contact_id = $1 AND channel = 'linkedin'", [ana.id])).toEqual(before);
  });

  it("the same event twice counts once", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    const send = ev({ signal: "send", email: ana.email, sequence_external_id: e.external_id, step: 1 });
    await ingestEvents(db, h.deps, h.email.connector, [send]);
    await ingestEvents(db, h.deps, h.email.connector, [send]);
    expect(await db.query("SELECT 1 FROM touches WHERE contact_id = $1 AND kind = 'send'", [ana.id])).toHaveLength(1);
  });
});

describe("HeyReach", () => {
  const secret = "s3cret";
  const hr = (fetch?: typeof globalThis.fetch) => heyreach({ apiKey: "k", webhookSecret: secret, fetch } as never);

  it("maps each event type to its signal and ignores one it does not know", () => {
    const c = hr();
    for (const [type, signal] of Object.entries(HEYREACH_EVENTS)) {
      const got = c.verifyWebhook({ headers: {}, query: { secret }, body: { event_type: type, lead: { profile_url: "https://www.linkedin.com/in/ana" }, campaign: { id: 7 }, timestamp: "2027-01-12T10:00:00Z" } });
      expect(got).toHaveLength(1);
      expect(got![0]).toMatchObject({ signal, channel: "linkedin", sequence_external_id: "7", step: null });
    }
    expect(c.verifyWebhook({ headers: {}, query: { secret }, body: { event_type: "LIKED_POST", lead: { profile_url: "x" } } })).toEqual([]);
  });

  it("adds the missing event types to a campaign that already has the reply webhook", async () => {
    const made: string[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      const body = init.body ? JSON.parse(String(init.body)) : {};
      if (String(url).includes("GetAllWebhooks")) return new Response(JSON.stringify({ items: [{ webhookUrl: `https://desk.example/hook?secret=${secret}`, campaignIds: [7], eventType: "MESSAGE_REPLY_RECEIVED" }] }), { status: 200 });
      if (String(url).includes("CreateWebhook")) { made.push(body.eventType); return new Response("{}", { status: 200 }); }
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    await hr(fetch).registerWebhooks!("7", "https://desk.example/hook");
    expect(made.sort()).toEqual(Object.keys(HEYREACH_EVENTS).sort());
  });
});

describe("the per-sequence read", () => {
  it("counts reach, replies and steps one way, and a rep can read it", async () => {
    const h = await deliveredInMotion(db);
    const { e, l } = await launched(h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await ingestEvents(db, h.deps, h.email.connector, [
      ev({ signal: "send", email: ana.email, sequence_external_id: e.external_id, step: 1, sender: "s0@send.example" }),
      ev({ signal: "send", email: ana.email, sequence_external_id: e.external_id, step: 2, sender: "s0@send.example" }),
      ev({ signal: "reply", email: ana.email, sequence_external_id: e.external_id, body: "Sounds good, tell me more" }),
    ]);
    await ingestEvents(db, h.deps, h.li.connector, [ev({ signal: "invite", channel: "linkedin", linkedin: ana.linkedin, external_contact_id: ana.linkedin, sequence_external_id: l.external_id })]);
    await processInbound(db, h.deps);
    const list = await sequenceList(db, h.deps, h.id);
    const em = list.find((s) => s.id === e.id)!, li = list.find((s) => s.id === l.id)!;
    expect(em).toMatchObject({ reached: 1, replied: 1, invites: null, accepted: null });
    expect(li).toMatchObject({ reached: 1, invites: 1, accepted: 0 });
    const d = (await sequenceDetail(db, h.deps, h.id, e.id))!;
    expect(d.messages_sent).toBe(2);
    expect(d.steps!.reduce((x, s) => x + s.sent, 0)).toBe(d.messages_sent);
    expect(d.steps!.find((s) => s.step === 2)!.replied).toBe(1);
    expect(d.senders).toEqual([{ sender: "s0@send.example", sends: 2, bounces: 0 }]);
    // HeyReach gives no step: no ladder rather than an empty one.
    expect((await sequenceDetail(db, h.deps, h.id, l.id))!.steps).toBeNull();
    const rep = await createApp(db, { demo: true, lifecycle: h.deps }).request(`/api/events/${h.id}/sequences/${e.id}`, { headers: { "x-actor": encodeURIComponent(MAYA) } });
    expect(rep.status).toBe(200);
    expect(JSON.stringify(await rep.json())).not.toMatch(/cents|\$\d/);
  });

  it("says a figure is not reported when the tool does not report it", async () => {
    const h = await deliveredInMotion(db);
    const { e } = await launched(h);
    (h.deps.connectors.instantly.capabilities as { reports: string[] }).reports = ["reply"];
    const [s] = (await sequenceList(db, h.deps, h.id)).filter((x) => x.id === e.id);
    expect(s.reached).toBeNull();
    expect(s.replied).toBeNull();
  });
});
