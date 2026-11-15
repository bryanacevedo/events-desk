/* Bring in (docs/DIRECTORY.md 8 and 13): the staged reads become the event's list through today's intake, with the source on each person. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { bringIn, dismissRead, keepRead, purgeDirectoryData, authCapture, captureAdd, createRecording, readFrame } from "../src/server/directory.ts";
import { forgetPerson } from "../src/server/operating.ts";
import { mockLlm } from "../src/server/providers.ts";
import { requestResearchCard } from "../src/server/research.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { deliverEvent, freshDb } from "./helpers.ts";
import { fakeCrm } from "./lifecycle-harness.ts";
import { approvedEvent, bearer, confirmTerms, count, frame, JPEG, keyFor, MAYA, person, seeing, send } from "./directory-helpers.ts";

const NOW = new Date("2026-11-14T12:00:00Z");
let db: Db;
beforeEach(async () => { db = await freshDb(); });

const add = async (ev: string, people: unknown[], platform = "swapcard", owner = MAYA) => {
  const k = await keyFor(db, owner, "k");
  return captureAdd(db, await authCapture(db, `Bearer ${k.key}`), { event_id: ev, platform, people }, NOW);
};
const contacts = (ev: string) => db.query<any>("SELECT c.*, s.raw FROM contacts c JOIN source_rows s ON s.id = c.source_row_id WHERE c.event_id = $1 ORDER BY s.row_number", [ev]);
const reads = (ev: string) => db.query<any>("SELECT * FROM directory_reads WHERE event_id = $1 ORDER BY created_at, id", [ev]);

describe("what comes in", () => {
  it("takes the staged reads only, holds the ones to check back, and says how many wait", async () => {
    const ev = await approvedEvent(db);
    await add(ev, [person("Ana Lima"), person("Ben Ode", { company: "Pinefold" }), person("Madonna")]);
    const out = await bringIn(db, ev, MAYA, NOW);
    expect(out.brought_in).toBe(2);
    expect((await contacts(ev)).map((c) => c.full_name).sort()).toEqual(["Ana Lima", "Ben Ode"]);
    const rs = await reads(ev);
    expect(rs.map((r) => [r.full_name, r.state]).sort()).toEqual([["Ana Lima", "brought_in"], ["Ben Ode", "brought_in"], ["Madonna", "to_check"]]);
    expect((await db.query<any>("SELECT stage FROM events WHERE id = $1", [ev]))[0].stage).toBe("mapped");
    // The second time there is nothing staged, and the one waiting is named.
    await expect(bringIn(db, ev, MAYA, NOW)).rejects.toThrow(/Nothing is ready to bring in\. 1 is waiting on a check/);
  });
  it("refuses with Nothing is ready when no read is staged", async () => {
    const ev = await approvedEvent(db);
    await expect(bringIn(db, ev, MAYA, NOW)).rejects.toThrow(/^Nothing is ready to bring in\.$/);
  });
  it("a dismissed read is never brought in, and a later send of that person does not reopen it", async () => {
    const ev = await approvedEvent(db);
    await add(ev, [person("Ana Lima"), person("Ben Ode", { company: "Pinefold" })]);
    const ana = (await reads(ev)).find((r) => r.full_name === "Ana Lima");
    await dismissRead(db, ev, ana.id);
    await add(ev, [person("Ana Lima")]);
    await bringIn(db, ev, MAYA, NOW);
    expect((await contacts(ev)).map((c) => c.full_name)).toEqual(["Ben Ode"]);
    expect((await db.query<any>("SELECT state FROM directory_reads WHERE id = $1", [ana.id]))[0].state).toBe("dismissed");
  });
  it("a read kept after an edit becomes staged and is brought in with the edit", async () => {
    const ev = await approvedEvent(db);
    await add(ev, [person("Madonna"), person("Ana Lima")]);
    const [mad] = await db.query<any>("SELECT id FROM directory_reads WHERE event_id = $1 AND full_name = 'Madonna'", [ev]);
    await expect(keepRead(db, ev, mad.id, { name: "1234" })).rejects.toThrow(/needs letters/);
    const kept = await keepRead(db, ev, mad.id, { name: "Madonna Ciccone", company: "Maverick" });
    expect(kept).toMatchObject({ state: "staged", full_name: "Madonna Ciccone", company: "Maverick", check_reason: null });
    await expect(keepRead(db, ev, mad.id, {})).rejects.toThrow(/already staged/);
    await bringIn(db, ev, MAYA, NOW);
    expect((await contacts(ev)).map((c) => c.full_name).sort()).toEqual(["Ana Lima", "Madonna Ciccone"]);
  });
  it("an event that is not approved, or past mapped, or delivered, gets a plain sentence", async () => {
    const early = await approvedEvent(db, "Early", { approve: false });
    await db.query("INSERT INTO directory_reads (id, event_id, dedupe_key, full_name, via, platform, read_by, read_on, source_text, terms_note, state) VALUES ('r1', $1, 'n:a b|', 'A B', 'extension', 'swapcard', 'x', current_date, 's', 't', 'staged')", [early]);
    await expect(bringIn(db, early, MAYA, NOW)).rejects.toThrow(/not approved yet/);
    const busy = await approvedEvent(db, "Busy");
    await db.query("UPDATE events SET stage = 'tiering' WHERE id = $1", [busy]);
    await expect(bringIn(db, busy, MAYA, NOW)).rejects.toThrow(/already being worked on; a list can no longer be replaced/);
    const done = await deliverEvent(db, "Company,Name,Title,Email\nOrrery,Ana Lima,CFO,ana@orrery.example\n", {}, "Done");
    await db.query("INSERT INTO directory_reads (id, event_id, dedupe_key, full_name, via, platform, read_by, read_on, source_text, terms_note, state) VALUES ('r2', $1, 'n:a b|', 'A B', 'extension', 'swapcard', 'x', current_date, 's', 't', 'staged')", [done]);
    await expect(bringIn(db, done, MAYA, NOW)).rejects.toThrow(/This outreach list is delivered/);
    expect(await count(db, "uploads", `event_id = '${done}'`)).toBe(1);
  });
});

describe("what each person keeps", () => {
  it("the source sentence, the terms note, the place and the path land on each contact and its source row", async () => {
    const ev = await approvedEvent(db, "AWS re:Invent 2026");
    await confirmTerms(db, ev, "No copying of attendee data");
    await add(ev, [person("Ana Lima", { location: "Lisbon, Portugal", profile_url: "https://app.swapcard.com/person/ana" }), person("Cy Ruiz", { company: "Pinefold", profile_url: "https://www.linkedin.com/in/cy-ruiz" })]);
    await bringIn(db, ev, MAYA, NOW);
    const cs = await contacts(ev);
    const ana = cs.find((c) => c.full_name === "Ana Lima"), cy = cs.find((c) => c.full_name === "Cy Ruiz");
    expect(ana.read_note).toBe(`read from the Swapcard directory of AWS re:Invent 2026 by Maya Ortiz on 2026-11-14`);
    expect(ana.read_terms).toBe("Terms: No copying of attendee data");
    expect(ana).toMatchObject({ list_source: "directory_extension", person_location: "Lisbon, Portugal", source: "attendee" });
    expect(cy.linkedin).toBe("https://www.linkedin.com/in/cy-ruiz");
    expect(cy.person_location).toBeNull();
    expect(ana.raw.Profile).toBe("https://app.swapcard.com/person/ana");
    const [up] = await db.query<any>("SELECT * FROM uploads WHERE event_id = $1", [ev]);
    expect(up).toMatchObject({ list_source: "directory_extension", filename: expect.stringMatching(/^directory-reads-\d{4}-\d{2}-\d{2}\.csv$/) });
    expect(up.source_note).toMatch(/^2 people read from Swapcard on /);
    expect((await db.query<any>("SELECT DISTINCT list_source FROM source_rows WHERE event_id = $1", [ev])).map((r) => r.list_source)).toEqual(["directory_extension"]);
    const rs = await reads(ev);
    expect(rs.every((r) => r.state === "brought_in" && r.contact_id)).toBe(true);
    expect(rs.find((r) => r.full_name === "Ana Lima").contact_id).toBe(ana.id);
  });
  it("each person keeps the path they came by when extension and recording reads are brought in together", async () => {
    const ev = await approvedEvent(db, "Mixed Event");
    await add(ev, [person("Ana Lima"), person("Ben Ode", { company: "Pinefold" })]);
    const llm = seeing([frame([{ name: "Cy Ruiz", title: "CTO", company: "Larkspur" }, { name: "Di Park", title: "VP", company: "Brightwater", location: "Berlin, Germany" }])]);
    const rec = await createRecording(db, llm, ev, MAYA, "Brella");
    await readFrame(db, llm, MAYA, rec.id, 0, JPEG, NOW);
    await bringIn(db, ev, MAYA, NOW);
    const bySource = Object.fromEntries((await contacts(ev)).map((c) => [c.full_name, c.list_source]));
    expect(bySource).toEqual({ "Ana Lima": "directory_extension", "Ben Ode": "directory_extension", "Cy Ruiz": "screen_recording", "Di Park": "screen_recording" });
    const di = (await contacts(ev)).find((c) => c.full_name === "Di Park");
    expect(di.read_note).toMatch(/^read from a screen recording of Brella for Mixed Event by Maya Ortiz on /);
    expect(di.person_location).toBe("Berlin, Germany");
    // Two from each: ties go to the extension, and the upload says where the list came from.
    expect((await db.query<any>("SELECT list_source, source_note FROM uploads WHERE event_id = $1", [ev]))[0]).toMatchObject({ list_source: "directory_extension" });
  });
  it("a list that is mostly recordings is a screen recording upload", async () => {
    const ev = await approvedEvent(db);
    const llm = seeing([frame([{ name: "Cy Ruiz", title: "CTO", company: "Larkspur" }, { name: "Di Park", title: "VP", company: "Brightwater" }])]);
    const rec = await createRecording(db, llm, ev, MAYA, "Whova");
    await readFrame(db, llm, MAYA, rec.id, 0, JPEG, NOW);
    await bringIn(db, ev, MAYA, NOW);
    expect((await db.query<any>("SELECT list_source FROM uploads WHERE event_id = $1", [ev]))[0].list_source).toBe("screen_recording");
  });
  it("Layer 0 does what it does for any file: a duplicate is dropped with its reason, and the read stays tied to its person", async () => {
    const ev = await approvedEvent(db);
    // Two links, one person: different keys, so two reads, and one person after Layer 0.
    await add(ev, [person("Ana Lima", { profile_url: "https://app.swapcard.com/person/a1" }), person("Ana Lima", { profile_url: "https://app.swapcard.com/person/a2" }), person("Ben Ode", { company: "Pinefold" })]);
    expect(await count(db, "directory_reads", `event_id = '${ev}'`)).toBe(3);
    await bringIn(db, ev, MAYA, NOW);
    const cs = await contacts(ev);
    expect(cs.filter((c) => c.drop_reason === "duplicate")).toHaveLength(1);
    expect(cs.filter((c) => !c.drop_reason)).toHaveLength(2);
    expect(await count(db, "directory_reads", `event_id = '${ev}' AND state = 'brought_in'`)).toBe(3);
  });
  it("a read with no company becomes a row Layer 0 drops, and is not offered again", async () => {
    const ev = await approvedEvent(db);
    await add(ev, [{ name: "Ana Lima", title: "CFO" }, person("Ben Ode", { company: "Pinefold" })]);
    await bringIn(db, ev, MAYA, NOW);
    expect(await count(db, "directory_reads", `event_id = '${ev}' AND state = 'brought_in'`)).toBe(2);
    expect((await contacts(ev)).filter((c) => !c.drop_reason).map((c) => c.full_name)).toEqual(["Ben Ode"]);
  });
  it("a formula-looking cell is stored as text, not neutralised and not quoted wrongly", async () => {
    const ev = await approvedEvent(db);
    await add(ev, [person("Ana Lima", { title: '=SUM(A1), "quoted"', company: "Orrery, Inc." })]);
    await bringIn(db, ev, MAYA, NOW);
    const [c] = await contacts(ev);
    expect(c.title).toBe('=SUM(A1), "quoted"');
    expect(c.raw.Company).toBe("Orrery, Inc.");
  });
});

describe("replacing what bring in made", () => {
  it("a second bring in replaces the list with every read, and voids a card that was waiting", async () => {
    const ev = await approvedEvent(db);
    await add(ev, [person("Ana Lima"), person("Ben Ode", { company: "Pinefold" })]);
    await bringIn(db, ev, MAYA, NOW);
    await requestResearchCard(db, ev, MAYA);
    expect(await count(db, "approvals", `event_id = '${ev}' AND status = 'pending'`)).toBe(1);
    await add(ev, [person("Cy Ruiz", { company: "Larkspur" })]);
    await bringIn(db, ev, DAN2, NOW);
    expect((await contacts(ev)).map((c) => c.full_name).sort()).toEqual(["Ana Lima", "Ben Ode", "Cy Ruiz"]);
    expect(await count(db, "uploads", `event_id = '${ev}'`)).toBe(1);
    expect(await count(db, "approvals", `event_id = '${ev}' AND status = 'pending'`)).toBe(0);
    expect((await db.query<any>("SELECT reason FROM approvals WHERE event_id = $1 AND status = 'declined'", [ev]))[0].reason).toMatch(/Replaced/);
    expect(await count(db, "cost_cards", `event_id = '${ev}' AND status = 'pending'`)).toBe(0);
    // Every read points at its new person; nobody fell out.
    const rs = await reads(ev);
    expect(rs).toHaveLength(3);
    for (const r of rs) expect((await db.query<any>("SELECT full_name FROM contacts WHERE id = $1", [r.contact_id]))[0].full_name).toBe(r.full_name);
    expect((await db.query<any>("SELECT note FROM (SELECT detail AS note FROM activity_log WHERE event_id = $1 AND kind = 'reupload') x", [ev])).length).toBe(1);
  });
  it("refuses on a list that came another way, naming it, and changes nothing", async () => {
    const ev = await approvedEvent(db);
    await ingestUpload(db, ev, MAYA, "a.csv", "Company,Name,Title\nOrrery,Ana Lima,CFO\n", { kind: "sponsor_export", note: "" });
    await add(ev, [person("Ben Ode", { company: "Pinefold" })]);
    await expect(bringIn(db, ev, MAYA, NOW)).rejects.toThrow(/already has a list \(sponsor export\)/);
    expect((await contacts(ev)).map((c) => c.full_name)).toEqual(["Ana Lima"]);
    expect((await reads(ev))[0].state).toBe("staged");
  });
  it("refuses when a list from another source is on the event even if one of this path is too", async () => {
    const ev = await approvedEvent(db);
    await add(ev, [person("Ben Ode", { company: "Pinefold" })]);
    await bringIn(db, ev, MAYA, NOW);
    await db.query("UPDATE uploads SET list_source = 'other' WHERE event_id = $1", [ev]);
    await add(ev, [person("Cy Ruiz", { company: "Larkspur" })]);
    await expect(bringIn(db, ev, MAYA, NOW)).rejects.toThrow(/already has a list/);
  });
  it("the precondition runs inside the lock and a throw there changes nothing", async () => {
    const ev = await approvedEvent(db);
    await expect(ingestUpload(db, ev, MAYA, "a.csv", "Company,Name,Title\nOrrery,Ana Lima,CFO\n", undefined, { precondition: async () => { throw new Error("stop"); } })).rejects.toThrow("stop");
    expect(await count(db, "uploads", `event_id = '${ev}'`)).toBe(0);
    expect((await db.query<any>("SELECT stage FROM events WHERE id = $1", [ev]))[0].stage).toBe("approved");
  });
  it("two bring ins at once make one list: the second finds nothing staged", async () => {
    const ev = await approvedEvent(db);
    await add(ev, [person("Ana Lima"), person("Ben Ode", { company: "Pinefold" })]);
    const both = await Promise.allSettled([bringIn(db, ev, MAYA, NOW), bringIn(db, ev, MAYA, NOW)]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = both.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(lost.reason.message)).toMatch(/Nothing is ready|changed while/);
    expect(await count(db, "uploads", `event_id = '${ev}'`)).toBe(1);
    expect((await contacts(ev))).toHaveLength(2);
  });
});

describe("over HTTP", () => {
  it("the panel shows the rule and what bring in would do, bring in answers with the event, and the card is priced as for an upload", async () => {
    const app = createApp(db, { demo: true, autoQuote: true });
    const ev = await approvedEvent(db);
    await add(ev, [person("Ana Lima"), person("Madonna")]);
    const h = { "x-actor": "Maya%20Ortiz", "content-type": "application/json" };
    const panel = await (await app.request(`/api/events/${ev}/directory`, { headers: h })).json() as any;
    expect(panel.counts).toEqual({ staged: 1, to_check: 1, brought_in: 0, dismissed: 0 });
    expect(panel.rule).toMatch(/Italy, Switzerland, Sweden, Denmark, Belgium, Austria, Norway and Germany/);
    expect(panel.to_check[0]).toMatchObject({ full_name: "Madonna", check_reason: "Name is one word" });
    expect(panel.staged[0].source_text).toMatch(/^read from the Swapcard directory/);
    expect(panel.bring_in.refusal).toBeNull();
    const r = await app.request(`/api/events/${ev}/directory/bring-in`, { method: "POST", headers: h, body: "{}" });
    expect(r.status).toBe(200);
    expect((await r.json() as any).brought_in).toBe(1);
    expect((await db.query<any>("SELECT stage FROM events WHERE id = $1", [ev]))[0].stage).toBe("quoted");
    expect(await count(db, "approvals", `event_id = '${ev}' AND status = 'pending' AND kind IN ('card', 'research', 'outreach')`)).toBe(1);
    const again = await app.request(`/api/events/${ev}/directory/bring-in`, { method: "POST", headers: h, body: "{}" });
    expect(again.status).toBe(409);
    expect((await again.json() as any).error).toMatch(/Nothing is ready to bring in\. 1 is waiting/);
    const [mad] = await db.query<any>("SELECT id FROM directory_reads WHERE event_id = $1 AND state = 'to_check'", [ev]);
    const kept = await app.request(`/api/events/${ev}/directory/reads/${mad.id}/keep`, { method: "POST", headers: h, body: JSON.stringify({ name: "Madonna Ciccone", company: "Maverick" }) });
    expect(kept.status).toBe(200);
    const gone = await app.request(`/api/events/${ev}/directory/reads/${mad.id}/dismiss`, { method: "POST", headers: h, body: "{}" });
    expect(gone.status).toBe(200);
    expect((await app.request(`/api/events/${ev}/directory/reads/nope/dismiss`, { method: "POST", headers: h, body: "{}" })).status).toBe(404);
  });
  it("a key's own captures show up on the panel the same", async () => {
    const app = createApp(db, { demo: true });
    const ev = await approvedEvent(db);
    const k = await keyFor(db);
    await send(app, "/api/capture/people", k.key, { event_id: ev, platform: "cvent", people: [person("Ana Lima")] });
    const panel = await (await app.request(`/api/events/${ev}/directory`)).json() as any;
    expect(panel.paths.extension.reads).toBe(1);
    expect(panel.sources).toEqual([{ via: "extension", platform: "cvent", n: 1 }]);
    void bearer;
  });
});

const DAN2 = "Dan Whitlock";

describe("erasure and retention", () => {
  const deps = () => ({ connectors: {}, llm: mockLlm, now: () => NOW, crm: { ...fakeCrm({ owner: "Dana Owner" }), write: async () => ({ id: "x" }) } as never, userMap: {} }) as never;
  it("an erased person takes their reads, found by contact, by name and company on any event, and by profile link, dismissed ones too", async () => {
    // Ana is on a real list with an address; the same person was read from a directory on two other events.
    const listed = await approvedEvent(db, "Listed");
    await ingestUpload(db, listed, MAYA, "a.csv", "Company,Name,Title,Email,LinkedIn\nOrrery,Ana Lima,CFO,ana@orrery.example,https://www.linkedin.com/in/ana-lima\nPinefold,Ben Ode,CEO,ben@pinefold.example,\n");
    const other = await approvedEvent(db, "Other One");
    await add(other, [person("Ana Lima", { company: "Orrery" }), person("Lima Ana", { company: "ORRERY, Inc." }), person("Ben Ode", { company: "Pinefold" }), person("Ana L", { company: "Elsewhere", profile_url: "https://linkedin.com/in/ana-lima" })]);
    await bringIn(db, other, MAYA, NOW);
    const third = await approvedEvent(db, "Third");
    await add(third, [person("Ana Lima", { company: "Orrery" }), person("Cy Ruiz", { company: "Larkspur" })]);
    const [dismissed] = await db.query<any>("SELECT id FROM directory_reads WHERE event_id = $1 AND full_name = 'Ana Lima'", [third]);
    await dismissRead(db, third, dismissed.id);
    await forgetPerson(db, deps(), "ana@orrery.example", "GTM Team");
    const left = (await db.query<any>("SELECT e.name AS event, r.full_name FROM directory_reads r JOIN events e ON e.id = r.event_id ORDER BY 1, 2")).map((r) => `${r.event}:${r.full_name}`);
    expect(left).toEqual(["Other One:Ben Ode", "Third:Cy Ruiz"]);
  });
  it("reads never brought in go 90 days after the event's last day, and brought in ones stay", async () => {
    const ev = await approvedEvent(db);
    await add(ev, [person("Ana Lima"), person("Madonna")]);
    const keepEv = await approvedEvent(db, "Kept");
    await add(keepEv, [person("Cy Ruiz", { company: "Larkspur" })]);
    await bringIn(db, keepEv, MAYA, NOW);
    await db.query("UPDATE events SET starts_on = '2026-08-01', ends_on = '2026-08-02'");
    await purgeDirectoryData(db, NOW);
    expect((await reads(ev))).toHaveLength(0);
    expect((await reads(keepEv))).toHaveLength(1);
    await db.query("UPDATE events SET starts_on = '2026-09-01', ends_on = '2026-09-02'");
    await add(ev, [person("Ana Lima")]);
    await purgeDirectoryData(db, NOW);
    expect((await reads(ev))).toHaveLength(1);
  });
});
