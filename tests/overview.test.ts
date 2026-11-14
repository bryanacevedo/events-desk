import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { seed } from "../src/server/seed.ts";
import { freshDb } from "./helpers.ts";
import type { LifecycleDeps } from "../src/server/lifecycle-deps.ts";
import { addInvolvement } from "../src/server/plan.ts";
import { saveSponsorship, updateDeliverable } from "../src/server/sponsorship.ts";
import { as, CAMILLE, draftPlan, MAYA } from "./plan-helpers.ts";

describe("the overview route", () => {
  it("lists delivered lists with people by priority and is read-only", async () => {
    const db = await freshDb();
    await seed(db);
    const app = createApp(db, { demo: true });
    const r = await app.request("/api/overview");
    expect(r.status).toBe(200);
    const { delivered } = await r.json() as { delivered: { id: string; a: number; b: number; c: number; sheet_url: string | null }[] };
    expect(delivered.map((d) => d.id)).toContain("evt_quarry");
    const q = delivered.find((d) => d.id === "evt_quarry")!;
    expect(q.a + q.b + q.c).toBeGreaterThan(0);
    expect(q.c).toBe(0);
    expect(await (await app.request("/api/overview", { method: "POST", headers: { "x-actor": "Maya Ortiz" }, body: "{}" })).status).toBe(404);
  });
});

describe("the overview gains the year and the week's deadlines", () => {
  it("keeps today's keys and adds year and deadlines, grouped late, today and this week, with no money for a rep", async () => {
    const db = await freshDb();
    const id = await draftPlan(db, { name: "Summit", starts_on: "2026-12-05", ends_on: "2026-12-06" });
    const { id: iid } = await addInvolvement(db, CAMILLE, id, { kind: "sponsorship" });
    await saveSponsorship(db, CAMILLE, id, iid, { tier: "Gold", price_cents: 2_000_000, deposit_due_on: "2026-11-15" });
    const [late, today] = (await db.query<{ id: string }>("SELECT id FROM sponsorship_deliverables WHERE event_id = $1 ORDER BY position", [id]));
    await updateDeliverable(db, CAMILLE, id, late.id, { due_on: "2026-11-11", owner: MAYA }, { planner: true });
    await updateDeliverable(db, CAMILLE, id, today.id, { due_on: "2026-11-13" }, { planner: true });
    const app = createApp(db, { demo: true, lifecycle: { now: () => new Date("2026-11-13T12:00:00Z") } as LifecycleDeps });
    const body = await (await app.request("/api/overview", { headers: as(CAMILLE) })).json() as { delivered: unknown[]; needs: unknown[]; live: unknown[]; results: unknown[]; year: { today: string; events: { name: string; planned_cents: number }[]; total_planned_cents: number }; deadlines: { label: string; group: string; due_words: string; owner: string; event_name: string }[] };
    for (const k of ["delivered", "needs", "live", "results"] as const) expect(Array.isArray(body[k])).toBe(true);
    expect(body.year.today).toBe("2026-11-13");
    expect(body.year.events.map((e) => [e.name, e.planned_cents])).toEqual([["Summit", 2_300_000]]);
    expect(body.deadlines.map((d) => [d.group, d.label, d.due_words])).toEqual([["late", "Logo and copy", "2 days late"], ["today", "Booth graphics", "Today"], ["week", "Sponsorship deposit", "Due Sunday"]]);
    expect(body.deadlines[0]).toMatchObject({ owner: MAYA, event_name: "Summit" });
    const rep = await (await app.request("/api/overview", { headers: as(MAYA) })).json() as typeof body;
    expect(rep.deadlines).toHaveLength(3);
    expect(JSON.stringify(rep.year)).not.toMatch(/cents/);
  });
});
