/* The request to the organizer: a fixed template a person copies and sends from their own mailbox. The desk keeps who copied it and the dates the person says.
   Nothing here sends mail, and no model writes a word of it. */

import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { draftOrganizerRequest, markRequestCopied, patchOrganizerRequest, setAnswer, followUpOn } from "../src/server/assessment.ts";
import { fakeHeyreach, fakeInstantly } from "../src/server/connectors/fake.ts";
import { weekDeadlines } from "../src/server/plan.ts";
import { mockLlm } from "../src/server/providers.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { dueWords } from "../src/shared/plan.ts";
import { renderOrganizerEmail } from "../src/shared/organizer-email.ts";
import { fakeNotifier } from "./lifecycle-harness.ts";
import { freshDb } from "./helpers.ts";
import { approvedPlan, as, CAMILLE, DAN, draftPlan, LEO, MAYA, one } from "./plan-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

async function findsNetworking(id: string) { await setAnswer(db, CAMILLE, id, "directory_present", { answer: "yes", source_kind: "first_hand" }); }
const req = (id: string) => one<{ id: string; status: string; subject: string; body: string; copied_by: string | null; sent_on: string | null; expected_on: string | null; follow_up_on: string | null; created_by: string; template: string }>(
  db, "SELECT id, status, subject, body, copied_by, sent_on::text AS sent_on, expected_on::text AS expected_on, follow_up_on::text AS follow_up_on, created_by, template FROM organizer_requests WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1", [id]);
const CSV = "Company,Name,Title,Email,LinkedIn\nTallgrass Software,Ana Ruiz,VP Sales,ana@tallgrasssoftware.example,https://www.linkedin.com/in/ana-ruiz\nBrightwater Software,Cleo Park,VP Marketing,cleo@brightwatersoftware.example,https://www.linkedin.com/in/cleo-park\n";

describe("the template", () => {
  it("fills the event, the ticket, the organizer and the sender, and leaves no placeholder", () => {
    for (const template of ["ask_for_list", "follow_up"] as const) {
      const m = renderOrganizerEmail(template, { event: "Harbourline Summit 2026", organizer: "Priya", sender: "Camille Laurent", company: "Orrery", ticket: "12 conference passes", first_sent_on: "2026-11-07" });
      const all = `${m.subject}\n${m.body}`;
      expect(all).toContain("Harbourline Summit 2026");
      expect(all).toContain("12 conference passes");
      expect(all).toContain("Camille Laurent");
      expect(all).toContain("Orrery");
      expect(all).toContain("Hello Priya,");
      expect(all).not.toMatch(/\{\{|\}\}|undefined|null|\[[A-Za-z ]+\]/);
      expect(all).not.toMatch(/[—–]/);
    }
  });
  it("asks whether the list is shared with ticket holders or sponsors, in what form, and on what date", () => {
    const m = renderOrganizerEmail("ask_for_list", { event: "X Expo", sender: "A", company: "Co", ticket: "2 conference passes" });
    expect(m.body).toMatch(/ticket holders or with sponsors/);
    expect(m.body).toMatch(/in what form/);
    expect(m.body).toMatch(/on what date/);
    expect(m.body.startsWith("Hello,")).toBe(true);
  });
  it("the follow-up quotes the first email's date", () => {
    const m = renderOrganizerEmail("follow_up", { event: "X Expo", sender: "A", company: "Co", ticket: "2 conference passes", first_sent_on: "2026-11-07" });
    expect(m.body).toContain("my note of 7 November");
    expect(renderOrganizerEmail("follow_up", { event: "X Expo", sender: "A", company: "Co", ticket: "t" }).body).toContain("my earlier note");
  });
});

describe("drafting, copying and the dates", () => {
  it("is offered once the assessment finds networking, and a planner can draft by hand before that", async () => {
    const id = await draftPlan(db);
    const app = createApp(db, { demo: true });
    const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: as(who), body: body === undefined ? undefined : JSON.stringify(body) });
    expect(((await (await call(LEO, "GET", `/api/events/${id}/assessment`)).json()) as { request_offered: boolean }).request_offered).toBe(false);
    expect((await call(LEO, "POST", `/api/events/${id}/organizer-request`, {})).status).toBe(409);
    await findsNetworking(id);
    const offered = (await (await call(LEO, "GET", `/api/events/${id}/assessment`)).json()) as { request_offered: boolean; finds_networking: boolean };
    expect(offered).toMatchObject({ request_offered: true, finds_networking: true });
    expect((await call(LEO, "POST", `/api/events/${id}/organizer-request`, {})).status).toBe(201);
    // Another event with no assessment: only a planner drafts it, by hand.
    const other = await draftPlan(db, { name: "Other Summit" });
    expect((await call(LEO, "POST", `/api/events/${other}/organizer-request`, {})).status).toBe(409);
    expect((await call(CAMILLE, "POST", `/api/events/${other}/organizer-request`, { organizer_name: "Sam" })).status).toBe(201);
    expect((await req(other)).body).toContain("Hello Sam,");
  });

  it("stores the email as rendered, with the event, the passes on the plan and the person who drafted it", async () => {
    const id = await draftPlan(db, { name: "Harbourline Summit 2026" });
    await draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true });
    const r = await req(id);
    expect(r).toMatchObject({ status: "drafted", template: "ask_for_list", created_by: CAMILLE });
    expect(r.subject).toBe("Attendee list for Harbourline Summit 2026");
    expect(r.body).toContain("3 conference passes");
    expect(r.body).toContain(CAMILLE);
    await expect(draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true })).rejects.toThrow(/already a request open/);
  });

  it("Copy records who pressed it and when, and moves a drafted request to copied", async () => {
    const id = await draftPlan(db);
    const { id: rid } = await draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true });
    await markRequestCopied(db, MAYA, id, rid);
    expect(await req(id)).toMatchObject({ status: "copied", copied_by: MAYA });
    expect((await one<{ copied_at: string | null }>(db, "SELECT copied_at::text AS copied_at FROM organizer_requests WHERE id = $1", [rid])).copied_at).not.toBeNull();
    await expect(markRequestCopied(db, MAYA, await draftPlan(db, { name: "Elsewhere" }), rid)).rejects.toThrow(/not on this event/);
  });

  it("the follow-up date is the expected date plus one day, or the sent date plus seven", async () => {
    expect(followUpOn("2026-11-07", "2026-11-17")).toBe("2026-11-18");
    expect(followUpOn("2026-11-07", null)).toBe("2026-11-14");
    expect(followUpOn(null, null)).toBeNull();
    const id = await draftPlan(db);
    const { id: rid } = await draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true });
    expect(await patchOrganizerRequest(db, CAMILLE, id, rid, { sent_on: "2026-11-07" })).toMatchObject({ status: "sent", sent_on: "2026-11-07", expected_on: null, follow_up_on: "2026-11-14" });
    expect(await patchOrganizerRequest(db, CAMILLE, id, rid, { expected_on: "2026-11-17", status: "will_share" })).toMatchObject({ status: "will_share", follow_up_on: "2026-11-18" });
    expect(await patchOrganizerRequest(db, CAMILLE, id, rid, { expected_on: null, status: "sent" })).toMatchObject({ follow_up_on: "2026-11-14" });
    expect(await req(id)).toMatchObject({ follow_up_on: "2026-11-14" });
  });

  it("refuses a status that needs a date it does not have, a bad date, and a made-up status", async () => {
    const id = await draftPlan(db);
    const { id: rid } = await draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true });
    await expect(patchOrganizerRequest(db, CAMILLE, id, rid, { status: "sent" })).rejects.toThrow(/day you sent it/);
    await expect(patchOrganizerRequest(db, CAMILLE, id, rid, { sent_on: "yesterday" })).rejects.toThrow(/as a date/);
    await expect(patchOrganizerRequest(db, CAMILLE, id, rid, { sent_on: "2026-11-07", status: "will_share" })).rejects.toThrow(/expects to share/);
    await expect(patchOrganizerRequest(db, CAMILLE, id, rid, { status: "drafted" })).rejects.toThrow(/status is one of/);
    await expect(patchOrganizerRequest(db, CAMILLE, id, rid, { status: "constructor" })).rejects.toThrow(/status is one of/);
    await patchOrganizerRequest(db, CAMILLE, id, rid, { sent_on: "2026-11-07", status: "will_not_share" });
    expect(await req(id)).toMatchObject({ status: "will_not_share", follow_up_on: null });
  });

  it("a follow-up draft replaces the text in place, quotes the first date, and waits to be copied and sent again", async () => {
    const id = await draftPlan(db);
    const { id: rid } = await draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true });
    await expect(draftOrganizerRequest(db, CAMILLE, id, { template: "follow_up" }, { planner: true })).rejects.toThrow(/has been sent/);
    await patchOrganizerRequest(db, CAMILLE, id, rid, { sent_on: "2026-11-07" });
    await markRequestCopied(db, MAYA, id, rid);
    await draftOrganizerRequest(db, CAMILLE, id, { template: "follow_up" }, { planner: true });
    const r = await req(id);
    expect(r).toMatchObject({ id: rid, template: "follow_up", status: "drafted", copied_by: null, follow_up_on: null });
    expect(r.body).toContain("my note of 7 November");
    expect((await db.query("SELECT 1 FROM organizer_requests WHERE event_id = $1", [id])).length).toBe(1);
  });
});

describe("the deadlines", () => {
  it("carry the person who drafted the request as owner, and the follow-up shows in the week once it is within six days and not before", async () => {
    const id = await draftPlan(db);
    const { id: rid } = await draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true });
    await patchOrganizerRequest(db, CAMILLE, id, rid, { sent_on: "2026-11-07", expected_on: "2026-11-17", status: "will_share" });
    const rows = await db.query<{ kind: string; owner: string; due_on: string; done: boolean }>("SELECT kind, owner, due_on::text AS due_on, done FROM event_deadlines WHERE event_id = $1 AND kind LIKE 'organizer%' ORDER BY kind", [id]);
    expect(rows).toEqual([{ kind: "organizer_expected", owner: CAMILLE, due_on: "2026-11-17", done: false }, { kind: "organizer_follow_up", owner: CAMILLE, due_on: "2026-11-18", done: false }]);
    const on = async (today: string) => (await weekDeadlines(db, today)).filter((d) => d.event_id === id).map((d) => d.kind);
    expect(await on("2026-11-10")).toEqual([]);
    expect(await on("2026-11-11")).toEqual(["organizer_expected"]);
    expect(await on("2026-11-12")).toEqual(["organizer_expected", "organizer_follow_up"]);
    // Past it, the follow-up is late and stays on the week until it is done.
    const late = (await weekDeadlines(db, "2026-11-20")).find((d) => d.kind === "organizer_follow_up");
    expect(late).toMatchObject({ group: "late", due_words: dueWords("2026-11-18", "2026-11-20") });
    expect(late!.due_words).toBe("2 days late");
    expect((await weekDeadlines(db, "2026-11-20")).find((d) => d.kind === "organizer_follow_up")!.owner).toBe(CAMILLE);
  });

  it("are done, and leave the week, when the organizer says no or the list arrives", async () => {
    const id = await draftPlan(db);
    const { id: rid } = await draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true });
    await patchOrganizerRequest(db, CAMILLE, id, rid, { sent_on: "2026-11-07", expected_on: "2026-11-10", status: "will_share" });
    expect((await weekDeadlines(db, "2026-11-12")).filter((d) => d.event_id === id)).toHaveLength(2);
    await patchOrganizerRequest(db, CAMILLE, id, rid, { status: "will_not_share" });
    expect((await weekDeadlines(db, "2026-11-12")).filter((d) => d.event_id === id)).toHaveLength(0);
  });
});

describe("a list emailed by the organizer", () => {
  it("closes the open request as received, in the upload's own transaction, and any other source leaves it open", async () => {
    const id = await approvedPlan(db);
    const { id: rid } = await draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true });
    await patchOrganizerRequest(db, CAMILLE, id, rid, { sent_on: "2026-11-07", expected_on: "2026-11-17", status: "will_share" });
    await ingestUpload(db, id, MAYA, "attendees.csv", CSV, { kind: "web_app_download", note: "" });
    expect((await req(id)).status).toBe("will_share");
    await ingestUpload(db, id, MAYA, "attendees.csv", CSV, { kind: "emailed_by_organizer", note: "" });
    expect(await req(id)).toMatchObject({ status: "received", follow_up_on: null });
    expect((await weekDeadlines(db, "2026-11-20")).filter((d) => d.event_id === id)).toHaveLength(0);
    expect((await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM uploads WHERE event_id = $1 AND list_source = 'emailed_by_organizer'", [id])).n).toBe(1);
    await expect(patchOrganizerRequest(db, CAMILLE, id, rid, { sent_on: "2026-11-08" })).rejects.toThrow(/closed/);
    // A new request can be drafted now that nothing is open.
    await draftOrganizerRequest(db, CAMILLE, id, {}, { planner: true });
    expect(await req(id)).toMatchObject({ status: "drafted" });
  });

  it("with no request on the event, an emailed list is stored as it is today", async () => {
    const id = await approvedPlan(db);
    await ingestUpload(db, id, MAYA, "attendees.csv", CSV, { kind: "emailed_by_organizer", note: "" });
    expect((await db.query("SELECT 1 FROM organizer_requests WHERE event_id = $1", [id])).length).toBe(0);
    expect((await one<{ stage: string }>(db, "SELECT stage FROM events WHERE id = $1", [id])).stage).toBe("mapped");
  });
});

describe("nothing here sends mail", () => {
  it("has no route that sends, no mailto, and the email tools and Slack are never called", async () => {
    const instantly = fakeInstantly(), heyreach = fakeHeyreach(), notify = fakeNotifier();
    const app = createApp(db, { demo: true, llm: mockLlm, lifecycle: { connectors: { instantly: instantly.connector, heyreach: heyreach.connector }, llm: mockLlm, notify }, demoTools: { instantly, heyreach } });
    const routes = app.routes.map((r) => `${r.method} ${r.path}`);
    const organizer = routes.filter((r) => /organizer-request/.test(r));
    expect(organizer.sort()).toEqual(["PATCH /api/events/:id/organizer-request/:rid", "POST /api/events/:id/organizer-request", "POST /api/events/:id/organizer-request/:rid/copied"]);
    expect(routes.filter((r) => /assessment|organizer/.test(r) && /send|mail/i.test(r))).toEqual([]);
    const id = await draftPlan(db);
    const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: as(who), body: body === undefined ? undefined : JSON.stringify(body) });
    const made = (await (await call(CAMILLE, "POST", `/api/events/${id}/organizer-request`, {})).json()) as { id: string };
    expect((await call(MAYA, "POST", `/api/events/${id}/organizer-request/${made.id}/copied`)).status).toBe(200);
    expect((await call(MAYA, "PATCH", `/api/events/${id}/organizer-request/${made.id}`, { sent_on: "2026-11-07", expected_on: "2026-11-17", status: "will_share" })).status).toBe(200);
    expect((await call(MAYA, "POST", `/api/events/${id}/organizer-request`, { template: "follow_up" })).status).toBe(201);
    expect((await call(MAYA, "POST", `/api/events/${id}/organizer-request/${made.id}/send`)).status).toBe(404);
    expect(instantly.calls).toEqual([]);
    expect(heyreach.calls).toEqual([]);
    expect([notify.sent.length, notify.posts.length, notify.opsPosts.length]).toEqual([0, 0, 0]);
    // The screens: no mailto link anywhere in the app, except the demo's one next-step link to Bryan (decision 111, src/app/start.tsx,
    // pinned to its exact address in tests/simfix.test.ts). That file may hold that one address and nothing else; every other screen holds none.
    const files = readdirSync("src/app").filter((f) => f.endsWith(".tsx"));
    const screens = files.filter((f) => f !== "start.tsx").map((f) => readFileSync(`src/app/${f}`, "utf8")).join("\n");
    expect(screens).not.toMatch(/mailto:/i);
    expect(readFileSync("src/app/start.tsx", "utf8").match(/mailto:[^"\s]*/gi)).toEqual(["mailto:bryan@leandrive.io?subject=Events%20Desk%20demo"]);
    expect(DAN).toBeTruthy();
  });
});
