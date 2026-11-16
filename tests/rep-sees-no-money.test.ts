/* Company money (cost, pipeline, deals, return, AI spend) is leadership's and GTM's on every read, not only on the screens that show it.
   This walks every read a rep's screens make and fails on any dollar figure in the answer. The ticket price of an event in the catalog
   is the one exception: a rep sees it to ask for a seat. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { createApp } from "../src/server/app.ts";
import { recordEventCost, sendDebriefPrompts } from "../src/server/closeout.ts";
import { bookMeeting, recordOutcome } from "../src/server/meetings.ts";
import { freshDb } from "./helpers.ts";
import { clock, deliveredInMotion, fakeCrm, MAYA, personAt } from "./lifecycle-harness.ts";
import { setBudgetLine } from "../src/server/budget-lines.ts";
import { addInvolvement, addPerson, updatePlan } from "../src/server/plan.ts";
import { approvedPlan, CAMILLE } from "./plan-helpers.ts";
import { saveSponsorship, updateDeliverable } from "../src/server/sponsorship.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
const as = (a: string) => ({ "x-actor": encodeURIComponent(a) });

/** Every place a dollar figure hides in a JSON answer: a money-named key with a value, or a "$12" in text. Counts of accounts with pipeline are the comparison, not money. */
function money(x: unknown, path = ""): string[] {
  if (Array.isArray(x)) return x.flatMap((v, i) => money(v, `${path}[${i}]`));
  if (x && typeof x === "object") return Object.entries(x).flatMap(([k, v]) =>
    /cents|pipeline|amount|dollars|price|llm/i.test(k) && !/with_pipeline$/.test(k) && typeof v === "number" && v !== 0 ? [`${path}.${k} = ${v}`] : money(v, `${path}.${k}`));
  return typeof x === "string" && /\$\s?\d/.test(x) ? [`${path} = "${x.slice(0, 80)}"`] : [];
}

describe("a rep's reads carry no company money", () => {
  it("the event, its motion, people, cases, overview, events, My day, a meeting and the notes", async () => {
    const crm = fakeCrm({ opportunities: async (a: any[]) => Object.fromEntries(a.map((x: any) => [x.ref, [{ id: "o1", stage: "Proposal", amount_cents: 5_000_000, created_date: "2027-02-01", stage_history: [] }]])) } as never);
    const h = await deliveredInMotion(db, { crm, time: clock("2027-03-01T12:00:00Z") });
    await db.query("UPDATE events SET motion = 'closing', starts_on = '2027-01-10', ends_on = '2027-01-12', catalog_id = NULL WHERE id = $1", [h.id]);
    await recordEventCost(db, h.id, "Dan Whitlock", "sponsorship", 1_000_000, "Gold");
    const ana = await personAt(db, h.id, "Ana Ruiz");
    const m = await bookMeeting(db, h.deps, { contact_id: ana.id, scheduled_at: "2027-01-15T15:00:00Z", source: "manual", rep: MAYA }, MAYA);
    await recordOutcome(db, h.deps, m.id, "held", MAYA);
    h.deps.notify = undefined; h.deps.userMap = {};
    await sendDebriefPrompts(db, h.deps);
    const [d] = await db.query<{ id: string }>("SELECT id FROM debriefs WHERE event_id = $1", [h.id]);
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    const reads = [`/api/events/${h.id}`, `/api/events/${h.id}/motion`, `/api/events/${h.id}/people`, `/api/events/${h.id}/cases`, `/api/events/${h.id}/next`,
      "/api/overview", "/api/events", `/api/motion/my-day?rep=${encodeURIComponent(MAYA)}`, `/api/motion/meetings/${m.id}`, `/api/motion/debriefs/${d.id}`, "/api/approvals"];
    const found: string[] = [];
    for (const path of reads) {
      const r = await app.request(path, { headers: as(MAYA) });
      if (r.status !== 200) continue;
      found.push(...money(await r.json()).map((f) => `${path}: ${f}`));
    }
    expect(found).toEqual([]);
  });
});

describe("a plan's reads carry no company money to a rep, and a planner reads what they write", () => {
  it("the plan read answers a rep with counts and words, and the money reads are refused", async () => {
    const h = await deliveredInMotion(db, { crm: fakeCrm(), time: clock("2027-03-01T12:00:00Z") });
    const id = await approvedPlan(db, { passes_cents: 300_000 });
    const { id: spo } = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship", label: "Gold" });
    await setBudgetLine(db, CAMILLE, id, { category: "sponsorship", involvement_id: spo, planned_cents: 1_500_000, contracted_cents: 1_400_000 });
    await updatePlan(db, CAMILLE, id, { goal_pipeline_cents: 40_000_000, goal_meetings_held: 25 });
    await addPerson(db, CAMILLE, id, { person: MAYA, team: "Sales", role_title: "SDR", needs_pass: true });
    // Over its approved budget now: the rep's words say so with no figure.
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    const rep = await app.request(`/api/events/${id}/plan`, { headers: as(MAYA) });
    expect(rep.status).toBe(200);
    const body = await rep.json() as { approval: { over_budget: boolean }; notes: string[] };
    expect(body.approval.over_budget).toBe(true);
    expect(body.notes[0]).toBe("Over the approved budget. Waiting on Dan Whitlock.");
    expect(money(body)).toEqual([]);
    for (const path of [`/api/events/${id}/budget-lines`, "/api/budget", "/api/results", "/api/usage", `/api/events/${id}/cost`]) expect((await app.request(path, { headers: as(MAYA) })).status, path).toBe(403);
    // The plan stage rides on the events list with no money in it.
    const list = await (await app.request("/api/events", { headers: as(MAYA) })).json() as { events: { id: string; plan_stage: string }[] };
    expect(list.events.find((e) => e.id === id)?.plan_stage).toBe("confirmed");
    expect(money(list)).toEqual([]);
    // A planner reads the plan's money, and not Usage.
    for (const path of ["/api/budget", "/api/results", `/api/events/${id}/budget-lines`, `/api/events/${id}/cost`]) expect((await app.request(path, { headers: as(CAMILLE) })).status, path).toBe(200);
    expect((await app.request("/api/usage", { headers: as(CAMILLE) })).status).toBe(403);
    const planner = await (await app.request(`/api/events/${id}/plan`, { headers: as(CAMILLE) })).json() as { notes: string[]; budget: { total_planned_cents: number } };
    expect(planner.budget.total_planned_cents).toBe(1_800_000);
    expect(planner.notes[0]).toBe("Over the approved budget by $15,000. Waiting on Dan Whitlock.");
    // The plan year rides on /api/budget for leadership and planners.
    const year = await (await app.request("/api/budget?year=2027", { headers: as(CAMILLE) })).json() as { plan: { events: { event_id: string }[] } };
    expect(year.plan.events.map((e) => e.event_id)).toContain(id);
  });
});

describe("sponsorship, deadlines and the year reach a rep with no dollars", () => {
  it("the plan read, the overview's year and week, the events list and the list source carry no money, and the money reads stay refused", async () => {
    const id = await approvedPlan(db, { passes_cents: 300_000, starts_on: "2026-12-05", ends_on: "2026-12-06" });
    const { id: spo } = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship", label: "Gold" });
    await saveSponsorship(db, CAMILLE, id, spo, { tier: "Gold", price_cents: 2_500_000, contract_signed_on: "2026-10-01", deposit_cents: 1_000_000, deposit_due_on: "2026-11-15", balance_due_on: "2026-11-30" });
    await updatePlan(db, CAMILLE, id, { goal_pipeline_cents: 40_000_000, goal_meetings_held: 25 });
    const [d] = await db.query<{ id: string }>("SELECT id FROM sponsorship_deliverables WHERE event_id = $1 ORDER BY position", [id]);
    await updateDeliverable(db, CAMILLE, id, d.id, { due_on: "2026-11-14", owner: MAYA }, { planner: true });
    const app = createApp(db, { demo: true, lifecycle: { now: () => new Date("2026-11-13T12:00:00Z") } as never });
    const found: string[] = [];
    for (const path of [`/api/events/${id}/plan`, "/api/overview", "/api/events", `/api/events/${id}`]) {
      const r = await app.request(path, { headers: as(MAYA) });
      expect(r.status, path).toBe(200);
      found.push(...money(await r.json()).map((f) => `${path}: ${f}`));
    }
    expect(found).toEqual([]);
    const rep = await (await app.request("/api/overview", { headers: as(MAYA) })).json() as { year: { events: unknown[] }; deadlines: { label: string }[] };
    expect(rep.year.events).toHaveLength(1);
    expect(rep.deadlines.map((x) => x.label)).toContain("Sponsorship deposit");
    for (const path of [`/api/events/${id}/budget-lines`, "/api/budget", "/api/results"]) expect((await app.request(path, { headers: as(MAYA) })).status, path).toBe(403);
    // The planner reads the year's money on the same route, and the plan per event on Budget.
    const planner = await (await app.request("/api/overview", { headers: as(CAMILLE) })).json() as { year: { total_planned_cents: number } };
    expect(planner.year.total_planned_cents).toBeGreaterThan(0);
  });
});


describe("the assessment and the request to the organizer carry no money to anyone", () => {
  it("a rep reads and writes them with no dollar figure, on an event with a sponsorship price, budget lines and a pipeline goal", async () => {
    const id = await approvedPlan(db, { passes_cents: 300_000, starts_on: "2026-12-05", ends_on: "2026-12-06" });
    const { id: spo } = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship", label: "Gold" });
    await saveSponsorship(db, CAMILLE, id, spo, { tier: "Gold", price_cents: 2_500_000, contract_signed_on: "2026-10-01" });
    await updatePlan(db, CAMILLE, id, { goal_pipeline_cents: 40_000_000 });
    const app = createApp(db, { demo: true, lifecycle: { now: () => new Date("2026-11-13T12:00:00Z") } as never });
    const json = { "content-type": "application/json" };
    const call = (who: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { ...as(who), ...json }, body: body === undefined ? undefined : JSON.stringify(body) });
    const src = await (await call(MAYA, "POST", `/api/events/${id}/assessment/sources`, { input: "pasted", source_kind: "faq", text: "Attendees can browse the list in the app. The list cannot be downloaded by attendees." })).json() as { id: string };
    expect((await call(MAYA, "POST", `/api/events/${id}/assessment/propose`, { source_id: src.id })).status).toBe(200);
    expect((await call(MAYA, "PUT", `/api/events/${id}/assessment/answers/directory_present`, { answer: "yes", source_kind: "first_hand" })).status).toBe(200);
    const made = await call(CAMILLE, "POST", `/api/events/${id}/organizer-request`, {});
    expect(made.status).toBe(201);
    const found: string[] = [];
    for (const path of [`/api/events/${id}/assessment`, `/api/events/${id}/plan`]) {
      const r = await call(MAYA, "GET", path);
      expect(r.status, path).toBe(200);
      found.push(...money(await r.json()).map((f) => `${path}: ${f}`));
    }
    const view = await (await call(MAYA, "GET", `/api/events/${id}/assessment`)).json() as { organizer_request: { subject: string; body: string }; request_offered: boolean };
    expect(view.request_offered).toBe(true);
    expect(`${view.organizer_request.subject} ${view.organizer_request.body}`).not.toMatch(/\$\s?\d/);
    expect(found).toEqual([]);
    // The plan read carries both, and a planner's money is still on the plan read only for a planner.
    const rep = await (await call(MAYA, "GET", `/api/events/${id}/plan`)).json() as { assessment: { progress: { total: number } }; organizer_request: { status: string }; budget?: unknown };
    expect(rep.assessment.progress.total).toBe(7);
    expect(rep.organizer_request.status).toBe("drafted");
    expect(rep.budget).toBeUndefined();
  });
});

describe("a hosted event's reads carry no company money to a rep", () => {
  it("the hosted page, the follow-up, the owner's list and the venue answer a rep with words and counts", async () => {
    const { hostedDinner, depsAt, yes, BEFORE } = await import("./hosted-helpers.ts");
    const { putCohost, putVenue } = await import("../src/server/hosted-view.ts");
    const id = await hostedDinner(db, { capacity: 6 });
    await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
    await putVenue(db, depsAt(BEFORE), CAMILLE, id, { name: "Pier Room", minimum_spend_cents: 500_000, guarantee_headcount: 6, guarantee_by: "2027-06-01", steps: [{ by_date: "2027-06-03", rule: "Half is owed after this", fee_cents: 250_000 }] });
    await putCohost(db, CAMILLE, id, { partner: "Partner Co", our_share_percent: 50, lead_rule: "own_invites" });
    const app = createApp(db, { demo: true });
    const found: string[] = [];
    for (const path of [`/api/events/${id}/hosted`, `/api/events/${id}/follow-up`, "/api/hosted/mine", `/api/events/${id}/guests/suggestions`]) {
      const r = await app.request(path, { headers: as(MAYA) });
      expect(r.status, path).toBe(200);
      found.push(...money(await r.json()).map((f) => `${path}: ${f}`));
    }
    expect(found).toEqual([]);
  });
});

describe("choosing and the goal tracker", () => {
  it("the tracker is counts for a rep, and every choosing and target account read is refused", async () => {
    const h = await deliveredInMotion(db, { crm: fakeCrm(), time: clock("2027-01-01T12:00:00Z") });
    await db.query("UPDATE events SET starts_on = '2027-01-10', ends_on = '2027-01-12' WHERE id = $1", [h.id]);
    await updatePlan(db, CAMILLE, h.id, { goal_meetings_held: 12, goal_pipeline_cents: 20_000_000 });
    await recordEventCost(db, h.id, "Dan Whitlock", "sponsorship", 1_000_000, "Gold");
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    const r = await app.request(`/api/events/${h.id}/goal-tracker`, { headers: as(MAYA) });
    expect(r.status).toBe(200);
    const body = await r.json() as { goal: number; words: string };
    expect(body.goal).toBe(12);
    expect(money(body)).toEqual([]);
    for (const path of ["/api/target-accounts", "/api/choosing", "/api/choosing/repeat", "/api/choosing/c1/likely"]) expect((await app.request(path, { headers: as(MAYA) })).status, path).toBe(403);
    for (const path of ["/api/choosing/c1/pages", "/api/choosing/series-links"]) expect((await app.request(path, { method: "POST", headers: { ...as(MAYA), "content-type": "application/json" }, body: "{}" })).status, path).toBe(403);
    expect((await app.request("/api/target-accounts", { headers: as(CAMILLE) })).status).toBe(200);
  });
});
