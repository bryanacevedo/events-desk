/* Sponsorship deliverables, promised against received, and the week's deadlines (docs/EVENT-PLAN.md 4.2). Fixed day: Friday 2026-11-13. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { addInvolvement, planView, weekDeadlines } from "../src/server/plan.ts";
import { addDeliverable, addPromise, saveSponsorship, updateDeliverable, updatePromise } from "../src/server/sponsorship.ts";
import { dueGroup, dueWords, promiseWords, STANDARD_DELIVERABLES, weekWindow } from "../src/shared/plan.ts";
import { freshDb } from "./helpers.ts";
import { as, CAMILLE, draftPlan, LEO, MAYA, one, TODAY } from "./plan-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

async function withSponsorship(over: Parameters<typeof draftPlan>[1] = {}) {
  const id = await draftPlan(db, over);
  const { id: iid } = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship", label: "Gold" });
  await saveSponsorship(db, CAMILLE, id, iid, { tier: "Gold", price_cents: 2_500_000 });
  return { id, iid };
}
const delivs = (id: string) => db.query<{ id: string; label: string; due_on: string | null; owner: string; done_at: string | null }>("SELECT id, label, due_on::text AS due_on, owner, done_at::text AS done_at FROM sponsorship_deliverables WHERE event_id = $1 ORDER BY position, created_at, id", [id]);

describe("a new sponsorship", () => {
  it("has the standard eight, with no dates, and fixed ids when given", async () => {
    const { id } = await withSponsorship();
    const d = await delivs(id);
    expect(d.map((x) => x.label)).toEqual(STANDARD_DELIVERABLES.map((x) => x.label));
    expect(d.every((x) => x.due_on === null && x.done_at === null)).toBe(true);
    const other = await draftPlan(db, { name: "Other Summit" });
    const { id: iid } = await addInvolvement(db, CAMILLE, other, { kind: "sponsorship" });
    const ids = STANDARD_DELIVERABLES.map((_, n) => `dlv_fixed_${n}`);
    await saveSponsorship(db, CAMILLE, other, iid, { price_cents: 100 }, { id: "spo_fixed", deliverable_ids: ids });
    expect((await delivs(other)).map((x) => x.id).sort()).toEqual([...ids].sort());
    expect((await one<{ id: string }>(db, "SELECT id FROM sponsorships WHERE event_id = $1", [other])).id).toBe("spo_fixed");
  });

  it("saving the package again never makes a second set of deliverables", async () => {
    const { id, iid } = await withSponsorship();
    await saveSponsorship(db, CAMILLE, id, iid, { tier: "Platinum" });
    expect(await delivs(id)).toHaveLength(8);
  });

  it("only a sponsorship involvement takes a package", async () => {
    const id = await draftPlan(db);
    const [passes] = await db.query<{ id: string }>("SELECT id FROM involvements WHERE event_id = $1", [id]);
    await expect(saveSponsorship(db, CAMILLE, id, passes.id, { price_cents: 1 })).rejects.toThrow("Only a sponsorship has a package");
  });
});

describe("due words, on a fixed day", () => {
  it("late, today, tomorrow, a weekday inside the week, a date beyond it, and no date", () => {
    expect(dueWords("2026-11-10", TODAY)).toBe("3 days late");
    expect(dueWords("2026-11-12", TODAY)).toBe("1 day late");
    expect(dueWords("2026-11-13", TODAY)).toBe("Today");
    expect(dueWords("2026-11-14", TODAY)).toBe("Tomorrow");
    expect(dueWords("2026-11-19", TODAY)).toBe("Due Thursday");
    expect(dueWords("2026-11-20", TODAY)).toBe("Due 20 Nov");
    expect(dueWords(null, TODAY)).toBe("No date yet");
    expect(weekWindow(TODAY)).toEqual({ from: "2026-11-13", to: "2026-11-19" });
    expect(dueGroup("2026-11-20", TODAY)).toBeNull();
  });
});

describe("the week's deadlines", () => {
  it("returns late and the next seven days across two events, not day eight, not done ones, not undated ones", async () => {
    const a = await withSponsorship({ name: "Alpha Summit" });
    const b = await withSponsorship({ name: "Beta Summit" });
    const [a1, a2, a3, a4] = await delivs(a.id);
    const [b1, b2] = await delivs(b.id);
    const set = (did: string, eid: string, due: string) => updateDeliverable(db, CAMILLE, eid, did, { due_on: due }, { planner: true });
    await set(a1.id, a.id, "2026-11-10");   // late
    await set(a2.id, a.id, "2026-11-13");   // today
    await set(a3.id, a.id, "2026-11-19");   // day seven: in
    await set(a4.id, a.id, "2026-11-20");   // day eight: out
    await set(b1.id, b.id, "2026-11-16");   // in
    await set(b2.id, b.id, "2026-11-11");   // late, then done: out
    await updateDeliverable(db, CAMILLE, b.id, b2.id, { done: true }, { planner: true });
    await saveSponsorship(db, CAMILLE, b.id, b.iid, { deposit_due_on: "2026-11-18" });
    const week = await weekDeadlines(db, TODAY);
    expect(week.map((w) => [w.event_name, w.label, w.due_on, w.group])).toEqual([
      ["Alpha Summit", "Logo and copy", "2026-11-10", "late"],
      ["Alpha Summit", "Booth graphics", "2026-11-13", "today"],
      ["Beta Summit", "Logo and copy", "2026-11-16", "week"],
      ["Beta Summit", "Sponsorship deposit", "2026-11-18", "week"],
      ["Alpha Summit", "Staff badges", "2026-11-19", "week"],
    ]);
    expect(week[0].due_words).toBe("3 days late");
  });

  it("a paid deposit leaves the week, and a declined event leaves it", async () => {
    const a = await withSponsorship({ name: "Alpha Summit" });
    await saveSponsorship(db, CAMILLE, a.id, a.iid, { deposit_due_on: "2026-11-15", deposit_cents: 100_000 });
    expect((await weekDeadlines(db, TODAY)).map((w) => w.kind)).toEqual(["deposit"]);
    await saveSponsorship(db, CAMILLE, a.id, a.iid, { deposit_paid_on: "2026-11-14" });
    expect(await weekDeadlines(db, TODAY)).toEqual([]);
  });
});

describe("who may change a deliverable", () => {
  it("an owner marks their own done; another rep cannot; a planner can change anything", async () => {
    const { id } = await withSponsorship();
    const [d] = await delivs(id);
    await updateDeliverable(db, CAMILLE, id, d.id, { owner: MAYA, due_on: "2026-11-15" }, { planner: true });
    const app = createApp(db, { demo: true });
    const patch = (who: string, b: object) => app.request(`/api/events/${id}/deliverables/${d.id}`, { method: "PATCH", headers: as(who), body: JSON.stringify(b) });
    expect((await patch(LEO, { done: true })).status).toBe(403);
    expect((await patch(MAYA, { due_on: "2026-12-01" })).status).toBe(403);
    expect((await patch(MAYA, { owner: MAYA, done: true })).status).toBe(403);
    expect((await patch(MAYA, { done: true })).status).toBe(200);
    expect(await one(db, "SELECT done_by FROM sponsorship_deliverables WHERE id = $1", [d.id])).toEqual({ done_by: MAYA });
    expect((await patch(CAMILLE, { due_on: "2026-12-01", owner: LEO })).status).toBe(200);
    expect((await patch(CAMILLE, { done: false })).status).toBe(200);
    expect((await one<{ done_at: string | null }>(db, "SELECT done_at FROM sponsorship_deliverables WHERE id = $1", [d.id])).done_at).toBeNull();
    // A done mark without a person is refused by the database.
    await expect(db.query("UPDATE sponsorship_deliverables SET done_at = now() WHERE id = $1", [d.id])).rejects.toThrow();
  });

  it("a rep cannot add a deliverable or save the package, and a bad body is a 400", async () => {
    const { id, iid } = await withSponsorship();
    const app = createApp(db, { demo: true });
    expect((await app.request(`/api/events/${id}/deliverables`, { method: "POST", headers: as(MAYA), body: JSON.stringify({ label: "Photo" }) })).status).toBe(403);
    expect((await app.request(`/api/events/${id}/sponsorships/${iid}`, { method: "PUT", headers: as(MAYA), body: JSON.stringify({ price_cents: 1 }) })).status).toBe(403);
    expect((await app.request(`/api/events/${id}/deliverables`, { method: "POST", headers: as(CAMILLE), body: JSON.stringify({ label: " " }) })).status).toBe(400);
    expect((await app.request(`/api/events/${id}/deliverables`, { method: "POST", headers: as(CAMILLE), body: JSON.stringify({ label: "Photo", due_on: "tomorrow" }) })).status).toBe(400);
    const r = await app.request(`/api/events/${id}/deliverables`, { method: "POST", headers: as(CAMILLE), body: JSON.stringify({ kind: "other", label: "Photographer pass", due_on: "2026-11-17", owner: MAYA }) });
    expect(r.status).toBe(201);
    expect(await delivs(id)).toHaveLength(9);
  });
});

describe("promised against received", () => {
  it("words for counted, not received, and received", () => {
    expect(promiseWords({ label: "10 passes", promised_qty: 10, received_qty: 8, received_on: null })).toBe("10 passes: 8 issued");
    expect(promiseWords({ label: "Passes", promised_qty: 10, received_qty: null, received_on: null })).toBe("10 passes: 0 issued");
    expect(promiseWords({ label: "Attendee list", promised_qty: null, received_qty: null, received_on: null })).toBe("Attendee list: not received");
    expect(promiseWords({ label: "Attendee list", promised_qty: null, received_qty: null, received_on: "2026-10-14" })).toBe("Attendee list: received 14 Oct");
  });

  it("promises are saved, read in words, and a count that arrived needs a count promised", async () => {
    const { id } = await withSponsorship();
    const { id: p1 } = await addPromise(db, CAMILLE, id, { item: "passes", label: "10 passes", promised_qty: 10, received_qty: 8 });
    const { id: p2 } = await addPromise(db, CAMILLE, id, { item: "attendee_list", label: "Attendee list" });
    await expect(addPromise(db, CAMILLE, id, { item: "attendee_list", label: "Bad", received_qty: 1 })).rejects.toThrow("how many were promised");
    await expect(db.query("UPDATE sponsorship_promises SET received_qty = 1 WHERE id = $1", [p2])).rejects.toThrow();
    let view = await planView(db, undefined, id, CAMILLE);
    expect((view as any).promises.map((p: any) => p.words)).toEqual(["10 passes: 8 issued", "Attendee list: not received"]);
    await updatePromise(db, CAMILLE, id, p2, { received_on: "2026-10-14" });
    await updatePromise(db, CAMILLE, id, p1, { received_qty: 10 });
    view = await planView(db, undefined, id, CAMILLE);
    expect((view as any).promises.map((p: any) => p.words)).toEqual(["10 passes: 10 issued", "Attendee list: received 14 Oct"]);
  });

  it("the plan read carries the package, deliverables and promises, and a rep gets no price or cents", async () => {
    const { id } = await withSponsorship();
    const app = createApp(db, { demo: true });
    const rep = await (await app.request(`/api/events/${id}/plan`, { headers: as(MAYA) })).json() as any;
    expect(rep.sponsorship.tier_name).toBe("Gold");
    expect(rep.deliverables).toHaveLength(8);
    expect(JSON.stringify(rep)).not.toMatch(/cents/);
    const planner = await (await app.request(`/api/events/${id}/plan`, { headers: as(CAMILLE) })).json() as any;
    expect(planner.sponsorship.price_cents).toBe(2_500_000);
    expect(planner.deliverables.map((d: any) => d.label)).toContain("Logo and copy");
  });
});
