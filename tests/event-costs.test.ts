/* What an event cost, entered by leadership or GTM on the Cost tab: each line set, edited, marked as none or taken off, every change
   in the event's history, a scored result repriced with it, and a closed event asking for what is still missing. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { createApp } from "../src/server/app.ts";
import { COST_CATEGORIES, eventCost, recordEventCost, writeScorecards } from "../src/server/closeout.ts";
import { bookMeeting, recordOutcome } from "../src/server/meetings.ts";
import { freshDb } from "./helpers.ts";
import { clock, deliveredInMotion, fakeCrm, MAYA, personAt } from "./lifecycle-harness.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
const as = (a: string) => ({ "x-actor": encodeURIComponent(a), "content-type": "application/json" });
const GTM = "GTM Team";

async function closed() {
  const crm = fakeCrm({ opportunities: async (a: any[]) => Object.fromEntries(a.map((x: any) => [x.ref, [{ id: "o1", stage: "Proposal", amount_cents: 6_000_000, created_date: "2027-01-20", stage_history: [] }]])) } as never);
  const h = await deliveredInMotion(db, { crm, time: clock("2027-03-01T12:00:00Z") });
  await db.query("UPDATE events SET motion = 'closing', starts_on = '2027-01-10', ends_on = '2027-01-12', catalog_id = NULL WHERE id = $1", [h.id]);
  const ana = await personAt(db, h.id, "Ana Ruiz");
  const m = await bookMeeting(db, h.deps, { contact_id: ana.id, scheduled_at: "2027-01-15T15:00:00Z", source: "manual", rep: MAYA }, MAYA);
  await recordOutcome(db, h.deps, m.id, "held", MAYA);
  return h;
}

describe("event costs", () => {
  it("a line is set, changed, marked none and taken off, and each change is in the history", async () => {
    const h = await closed();
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    const post = (body: object) => app.request(`/api/events/${h.id}/motion/costs`, { method: "POST", headers: as(GTM), body: JSON.stringify(body) });
    expect((await post({ category: "sponsorship", amount_cents: 1_500_000, note: "Gold tier" })).status).toBe(200);
    expect((await post({ category: "sponsorship", amount_cents: 1_250_000, note: "Gold tier, discounted" })).status).toBe(200);
    expect((await post({ category: "swag", amount_cents: 0, note: "" })).status).toBe(200);
    let c = await eventCost(db, h.id);
    expect(c.extras.find((x) => x.category === "sponsorship")).toMatchObject({ amount_cents: 1_250_000, note: "Gold tier, discounted", recorded_by: GTM });
    expect(c.missing).not.toContain("swag");
    expect((await app.request(`/api/events/${h.id}/costs/swag`, { method: "DELETE", headers: as(GTM) })).status).toBe(200);
    c = await eventCost(db, h.id);
    expect(c.missing).toContain("swag");
    const history = (await db.query<{ detail: string }>("SELECT detail FROM activity_log WHERE event_id = $1 AND kind = 'cost' ORDER BY created_at, id", [h.id])).map((r) => r.detail);
    expect(history).toEqual(["Sponsorship: $15,000", "Sponsorship: $12,500, was $15,000", "Swag: none", "Swag: taken off, was none"]);
  });

  it("only leadership and GTM enter costs; a rep's Overview asks for none", async () => {
    const h = await closed();
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    expect((await app.request(`/api/events/${h.id}/motion/costs`, { method: "POST", headers: as(MAYA), body: JSON.stringify({ category: "booth", amount_cents: 100 }) })).status).not.toBe(200);
    expect((await app.request(`/api/events/${h.id}/costs/booth`, { method: "DELETE", headers: as(MAYA) })).status).not.toBe(200);
    const lead = await (await app.request("/api/overview", { headers: as(GTM) })).json() as { needs: { kind: string; event_id: string; n: number }[] };
    expect(lead.needs.find((n) => n.kind === "costs" && n.event_id === h.id)?.n).toBe(COST_CATEGORIES.length);
    const rep = await (await app.request("/api/overview", { headers: as(MAYA) })).json() as { needs: { kind: string }[] };
    expect(rep.needs.some((n) => n.kind === "costs")).toBe(false);
  });

  it("a cost entered after scoring reprices the written result, keeping its pipeline", async () => {
    const h = await closed();
    h.time.set("2027-02-20T12:00:00Z");
    await writeScorecards(db, h.deps);
    const before = (await db.query<{ metrics: { influence: { pipeline_cents: number }; cost: { dollars_cents: number }; roi: { pipeline_per_dollar: number | null } } }>("SELECT metrics FROM scorecards WHERE event_id = $1 ORDER BY window_days DESC LIMIT 1", [h.id]))[0]?.metrics;
    expect(before).toBeTruthy();
    await recordEventCost(db, h.id, GTM, "sponsorship", 1_000_000, "");
    const after = (await db.query<typeof before & object>("SELECT metrics FROM scorecards WHERE event_id = $1 ORDER BY window_days DESC LIMIT 1", [h.id]))[0] as unknown as { metrics: typeof before };
    expect(after.metrics.influence.pipeline_cents).toBe(before.influence.pipeline_cents);
    expect(after.metrics.cost.dollars_cents).toBe(before.cost.dollars_cents + 1_000_000);
    if (after.metrics.roi.pipeline_per_dollar !== null) expect(after.metrics.roi.pipeline_per_dollar).toBeCloseTo(after.metrics.influence.pipeline_cents / after.metrics.cost.dollars_cents, 2);
  });
});
