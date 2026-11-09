/* The one suite every sequencer must pass (docs/LIFECYCLE.md, section 5). Adding a tool means writing one connector and one fake, and passing this. */

import { describe, expect, it } from "vitest";
import { FAKES, type FakeTool } from "../src/server/connectors/fake.ts";
import type { PersonForTool } from "../src/server/connectors/types.ts";

const person = (i: number, over: Partial<PersonForTool> = {}): PersonForTool => ({ ref: `c${i}`, email: `p${i}@acme.example`, linkedin: `https://www.linkedin.com/in/p${i}`, first_name: "Pat", last_name: `N${i}`, company: "Acme", title: "VP", crm_id: `003${i}`, ...over });

async function setup(t: FakeTool, name = "Seq") {
  const c = t.connector;
  let id: string;
  if (c.capabilities.createsSequences) id = await c.createSequence(name, t.newSeq(), []);
  else id = t.newSeq();
  return id;
}
const add = async (t: FakeTool, seq: string, ps: PersonForTool[]) => {
  const withIds = await Promise.all(ps.map(async (p) => ({ ...p, external_id: await t.connector.ensureContact(p) })));
  return t.connector.addContacts(seq, withIds);
};
const ready = (t: FakeTool, seq: string) => { if (!t.connector.capabilities.addsWhileDraft) t.launch(seq); };

describe.each(Object.keys(FAKES) as (keyof typeof FAKES)[])("%s", (name) => {
  const make = () => FAKES[name]();

  it("declares what it can do", () => {
    const c = make().connector;
    expect(c.name).toBe(name);
    expect(c.channels.length).toBeGreaterThan(0);
    expect(["contact", "remove-only"]).toContain(c.capabilities.pause);
    expect(["webhook", "poll", "both"]).toContain(c.capabilities.events);
  });

  it("adds a person and returns one result each", async () => {
    const t = make(); const seq = await setup(t); ready(t, seq);
    const r = await add(t, seq, [person(1), person(2)]);
    expect(r.map((x) => x.ref)).toEqual(["c1", "c2"]);
    expect(r.every((x) => x.ok && x.external_id)).toBe(true);
    expect(t.seqs.get(seq)!.people.size).toBe(2);
  });

  it("adding the same person twice leaves one, as a replay after a crash does", async () => {
    const t = make(); const seq = await setup(t); ready(t, seq);
    const a = await add(t, seq, [person(1)]);
    const b = await add(t, seq, [person(1)]);
    expect(t.seqs.get(seq)!.people.size).toBe(1);
    expect(a[0].external_id).toBe(b[0].external_id);
  });

  it("takes a person out, the way its pause capability says", async () => {
    const t = make(); const seq = await setup(t); ready(t, seq);
    const [r] = await add(t, seq, [person(1)]);
    if (t.connector.capabilities.pause === "contact") {
      await t.connector.pauseContact(seq, r.external_id!);
      expect([...t.seqs.get(seq)!.people.values()][0].paused).toBe(true);
      await t.connector.resumeContact(seq, r.external_id!);
      expect([...t.seqs.get(seq)!.people.values()][0].paused).toBe(false);
    } else {
      await expect(t.connector.pauseContact(seq, r.external_id!)).rejects.toThrow();
    }
    await t.connector.removeContact(seq, r.external_id!);
    expect(t.seqs.get(seq)!.people.size).toBe(0);
  });

  it("says when a sequence went live, or says it cannot", async () => {
    const t = make(); const seq = await setup(t);
    if (!t.connector.capabilities.observesLaunch) { expect(await t.connector.sequenceState(seq)).toBe("active"); return; }
    expect(await t.connector.sequenceState(seq)).toBe("draft");
    t.launch(seq);
    expect(await t.connector.sequenceState(seq)).toBe("active");
    await t.connector.pauseSequence(seq);
    expect(await t.connector.sequenceState(seq)).toBe("paused");
  });

  it("reports replies with a stable id, so duplicates can be removed", async () => {
    const t = make(); const seq = await setup(t);
    if (t.connector.capabilities.events === "poll" && !t.connector.capabilities.replyBodies && name === "gong") return;
    const who = t.connector.channels.includes("email") ? "p1@acme.example" : "https://www.linkedin.com/in/p1";
    t.reply(seq, who, "Sounds good, tell me more");
    const [a] = await t.connector.events("2000-01-01", [seq]);
    const [b] = await t.connector.events("2000-01-01", [seq]);
    expect(a.signal).toBe("reply");
    expect(a.provider_message_id).toBe(b.provider_message_id);
    if (t.connector.capabilities.replyBodies) expect(a.body).toBe("Sounds good, tell me more");
    else expect(a.body).toBeNull();
  });

  it("turns away a webhook that is not from the tool", async () => {
    const t = make(); const seq = await setup(t);
    if (t.connector.capabilities.events === "poll") { expect(t.connector.verifyWebhook({ headers: {}, query: {}, body: {} })).toBeNull(); return; }
    const who = t.connector.channels.includes("email") ? "p1@acme.example" : "https://www.linkedin.com/in/p1";
    const { request } = t.reply(seq, who, "Yes");
    const good = t.connector.verifyWebhook(request);
    expect(good).toHaveLength(1);
    expect(good![0].signal).toBe("reply");
    expect(t.connector.verifyWebhook({ headers: {}, query: { secret: "wrong" }, body: { ...(request.body as object), secret_key: "wrong" } })).toBeNull();
  });

  it("reports a tool failure instead of swallowing it", async () => {
    const t = make(); const seq = await setup(t); ready(t, seq);
    t.down = true;
    await expect(add(t, seq, [person(1)]).then((r) => { if (r.some((x) => !x.ok)) throw new Error("refused"); })).rejects.toThrow();
  });

  it("carries a large batch in the sizes the tool allows", async () => {
    const t = make(); const seq = await setup(t); ready(t, seq);
    const r = await add(t, seq, Array.from({ length: 250 }, (_, i) => person(i)));
    expect(r.filter((x) => x.ok)).toHaveLength(250);
    expect(t.seqs.get(seq)!.people.size).toBe(250);
  });
});

describe("what each tool does on its own", () => {
  it("HeyReach: never adds to a paused campaign, which would restart it", async () => {
    const t = FAKES.heyreach(); const seq = t.newSeq();
    t.launch(seq); t.pause(seq);
    const [r] = await add(t, seq, [person(1)]);
    expect(r).toMatchObject({ ok: false, reason: "campaign_not_running" });
    expect(t.seqs.get(seq)!.status).toBe("PAUSED");
    expect(t.calls.some((c) => c.includes("AddLeads"))).toBe(false);
  });

  it("HeyReach: needs a LinkedIn profile, Instantly needs an address", async () => {
    await expect(FAKES.heyreach().connector.ensureContact(person(1, { linkedin: null }))).rejects.toThrow(/LinkedIn/);
    await expect(FAKES.instantly().connector.ensureContact(person(1, { email: null }))).rejects.toThrow(/email/);
  });

  it("Gong: refuses anyone without a CRM record", async () => {
    await expect(FAKES.gong().connector.ensureContact(person(1, { crm_id: null }))).rejects.toThrow(/CRM/);
    expect(FAKES.gong().connector.capabilities.needsCrmRecord).toBe(true);
  });

  it("a person the tool refuses comes back refused, with a time to try again", async () => {
    const t = FAKES.instantly(); const seq = await setup(t);
    t.refuse.add("p1@acme.example");
    const r = await add(t, seq, [person(1), person(2)]);
    expect(r[0]).toMatchObject({ ok: false, reason: "not_accepted", retry_after_minutes: 60 });
    expect(r[1].ok).toBe(true);
  });
});
