/* What an event returned, and who may see it. Company money stays with leadership and GTM Engineering on every read; a score waits for
   five held meetings; the 30-day scorecard moves the event to Scored; every rep who held a meeting is asked for a debrief, Slack or not;
   nobody reviews their own; and a deal a later event took over is counted once in the Results totals. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { createApp } from "../src/server/app.ts";
import { computeScorecard, recordEventCost, reviewDebrief, sendDebriefPrompts, writeScorecards } from "../src/server/closeout.ts";
import { bookMeeting, recordOutcome } from "../src/server/meetings.ts";
import { withoutMoney } from "../src/server/money.ts";
import type { CrmOpportunity } from "../src/server/providers.ts";
import { freshDb } from "./helpers.ts";
import { clock, deliveredInMotion, fakeCrm, MAYA, personAt } from "./lifecycle-harness.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
const as = (a: string) => ({ "x-actor": encodeURIComponent(a) });
const DAN = "Dan Whitlock", GTM = "GTM Team", D = "tallgrasssoftware.example";
const opp = (o: Partial<CrmOpportunity> = {}): CrmOpportunity => ({ id: "new", stage: "Proposal", amount_cents: 5_000_000, created_date: "2027-02-01", stage_history: [], ...o });

async function heldAt(opps: Record<string, CrmOpportunity[]>) {
  const crm = fakeCrm({ opportunities: async (a: any[]) => Object.fromEntries(a.map((x: any) => [x.ref, opps[x.ref] ?? []])) } as never);
  const h = await deliveredInMotion(db, { crm, time: clock("2027-03-01T12:00:00Z") });
  await db.query("UPDATE events SET motion = 'closing', starts_on = '2027-01-10', ends_on = '2027-01-12', catalog_id = NULL WHERE id = $1", [h.id]);
  await recordEventCost(db, h.id, DAN, "sponsorship", 1_000_000, "Gold");
  const ana = await personAt(db, h.id, "Ana Ruiz");
  const m = await bookMeeting(db, h.deps, { contact_id: ana.id, scheduled_at: "2027-01-15T15:00:00Z", source: "manual", rep: MAYA }, MAYA);
  await recordOutcome(db, h.deps, m.id, "held", MAYA);
  return h;
}

describe("company money", () => {
  it("Budget, Usage and Results refuse anyone but leadership and GTM, on the read itself", async () => {
    const app = createApp(db, { demo: true });
    for (const path of ["/api/budget?year=2027", "/api/usage", "/api/results"]) {
      expect((await app.request(path, { headers: as(MAYA) })).status).toBe(403);
      expect((await app.request(path)).status).toBe(403);
    }
    expect((await app.request("/api/budget?year=2027", { headers: as(DAN) })).status).toBe(200);
    expect((await app.request("/api/usage", { headers: as(GTM) })).status).toBe(200);
  });

  it("Overview leaves out Did it pay? for a rep", async () => {
    const h = await heldAt({ [D]: [opp()] });
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    expect((await (await app.request("/api/overview", { headers: as(MAYA) })).json() as { results: unknown[] }).results).toEqual([]);
    expect((await (await app.request("/api/overview", { headers: as(DAN) })).json() as { results: unknown[] }).results.length).toBeGreaterThan(0);
  });

  it("an event's data reaches a rep with every dollar taken out, and meetings kept", async () => {
    const h = await heldAt({ [D]: [opp()] });
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    const rep = await (await app.request(`/api/events/${h.id}/motion`, { headers: as(MAYA) })).json() as { live_score: any };
    const lead = await (await app.request(`/api/events/${h.id}/motion`, { headers: as(DAN) })).json() as { live_score: any };
    expect(lead.live_score.influence.pipeline_cents).toBe(5_000_000);
    expect(rep.live_score.influence.pipeline_cents).toBe(0);
    expect(rep.live_score.influence.deals).toEqual([]);
    expect(rep.live_score.cost.dollars_cents).toBe(0);
    expect(rep.live_score.roi.pipeline_per_dollar).toBeNull();
    expect(rep.live_score.held_all).toBe(lead.live_score.held_all);
    expect(withoutMoney(null)).toBeNull();
  });

  it("only leadership and GTM enter costs, and an unknown category is refused", async () => {
    const h = await heldAt({});
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    const post = (who: string, b: unknown) => app.request(`/api/events/${h.id}/motion/costs`, { method: "POST", headers: { ...as(who), "content-type": "application/json" }, body: JSON.stringify(b) });
    expect((await post(MAYA, { category: "booth", amount_cents: 100 })).status).toBe(409);
    expect((await post(DAN, { category: "booth", amount_cents: 100 })).status).toBe(200);
    await expect(recordEventCost(db, h.id, DAN, "lunch", 100, "")).rejects.toThrow(/A cost is one of/);
  });
});

describe("scoring", () => {
  it("a ratio waits for five held meetings: one held reads the figures with no score", async () => {
    const h = await heldAt({ [D]: [opp()] });
    const s = await computeScorecard(db, h.deps, h.id, 30);
    expect(s.held_all).toBe(1);
    expect(s.roi.pipeline_per_dollar).toBe(5);
    expect(s.score).toBeNull();
  });

  it("the 30-day scorecard moves the event to Scored, and later windows are written as their days come", async () => {
    const h = await heldAt({ [D]: [opp()] });
    h.time.set("2027-02-10T12:00:00Z"); // 29 days after 12 Jan
    await writeScorecards(db, h.deps);
    expect((await db.query<{ motion: string }>("SELECT motion FROM events WHERE id = $1", [h.id]))[0].motion).toBe("closing");
    h.time.set("2027-03-14T12:00:00Z"); // 61 days
    await writeScorecards(db, h.deps);
    expect((await db.query<{ motion: string }>("SELECT motion FROM events WHERE id = $1", [h.id]))[0].motion).toBe("scored");
    expect((await db.query<{ w: number }>("SELECT window_days AS w FROM scorecards WHERE event_id = $1 ORDER BY 1", [h.id])).map((r) => r.w)).toEqual([30, 60]);
  });
});

describe("debriefs", () => {
  it("every rep who held a meeting is asked, with or without Slack, and nobody reviews their own", async () => {
    const h = await heldAt({});
    h.deps.notify = undefined; h.deps.userMap = {};
    await sendDebriefPrompts(db, h.deps);
    const [d] = await db.query<{ id: string; author: string; status: string }>("SELECT id, author, status FROM debriefs WHERE event_id = $1", [h.id]);
    expect(d).toMatchObject({ author: MAYA, status: "waiting" });
    await db.query("UPDATE debriefs SET status = 'answered', body = 'Busy floor.' WHERE id = $1", [d.id]);
    await expect(reviewDebrief(db, d.id, MAYA, "accepted")).rejects.toThrow(/Someone else reviews/);
    expect(await reviewDebrief(db, d.id, DAN, "accepted")).toEqual({ status: "accepted" });
  });
});

describe("notes owed", () => {
  it("a rep sees the notes they owe on My day, and opens them; nobody else but leadership and GTM can read them", async () => {
    const h = await heldAt({});
    h.deps.notify = undefined; h.deps.userMap = {};
    await sendDebriefPrompts(db, h.deps);
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    const day = await (await app.request(`/api/motion/my-day?rep=${encodeURIComponent(MAYA)}`, { headers: as(MAYA) })).json() as { notes: { id: string; held: number }[] };
    expect(day.notes).toHaveLength(1);
    expect(day.notes[0].held).toBe(1);
    const id = day.notes[0].id;
    const mine = await (await app.request(`/api/motion/debriefs/${id}`, { headers: as(MAYA) })).json() as { met: { full_name: string }[]; status: string };
    expect(mine.status).toBe("waiting");
    expect(mine.met.map((m) => m.full_name)).toEqual(["Ana Ruiz"]);
    expect((await app.request(`/api/motion/debriefs/${id}`, { headers: as("Tomas Reyes") })).status).toBe(403);
    expect((await app.request(`/api/motion/debriefs/${id}`, { headers: as(DAN) })).status).toBe(200);
    // Sent, it leaves My day.
    expect((await app.request(`/api/motion/debriefs/${id}/answer`, { method: "POST", headers: { ...as(MAYA), "content-type": "application/json" }, body: JSON.stringify({ body: "Busy floor." }) })).status).toBe(200);
    const after = await (await app.request(`/api/motion/my-day?rep=${encodeURIComponent(MAYA)}`, { headers: as(MAYA) })).json() as { notes: unknown[] };
    expect(after.notes).toEqual([]);
  });

  it("a meeting booked without a zone takes its event's: the city where the country spans zones", async () => {
    const h = await heldAt({});
    await db.query("UPDATE events SET venue = 'Venetian Expo, Las Vegas', country = 'United States' WHERE id = $1", [h.id]);
    const ben = await personAt(db, h.id, "Ana Ruiz");
    const m = await bookMeeting(db, h.deps, { contact_id: ben.id, scheduled_at: "2027-01-16T18:00:00Z", source: "manual", rep: MAYA }, MAYA);
    const [row] = await db.query<{ timezone: string }>("SELECT timezone FROM meetings WHERE id = $1", [m.id]);
    expect(row.timezone).toBe("America/Los_Angeles");
  });
});

describe("Results", () => {
  it("counts a deal once: a written card's money comes from the deal ledger, where the deal belongs to one event", async () => {
    const h = await heldAt({ [D]: [opp()] });
    h.time.set("2027-02-20T12:00:00Z");
    await writeScorecards(db, h.deps);
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    const read = async () => (await (await app.request("/api/results", { headers: as(DAN) })).json() as { events: { id: string; pipeline_cents: number; deals: number }[] }).events.find((e) => e.id === h.id)!;
    expect(await read()).toMatchObject({ pipeline_cents: 5_000_000, deals: 1 });
    // A later event takes the deal over: this event's written card is unchanged, but Results no longer counts it here.
    await db.query(`INSERT INTO events SELECT (jsonb_populate_record(null::events, to_jsonb(e) || '{"id": "evt_later", "name": "Later", "slack_channel": null}'::jsonb)).* FROM events e WHERE e.id = $1`, [h.id]);
    await db.query("UPDATE attribution_claims SET event_id = 'evt_later' WHERE opportunity_id = 'new'");
    expect(await read()).toMatchObject({ pipeline_cents: 0, deals: 0 });
    expect((await db.query<{ cents: number }>("SELECT (metrics->'influence'->>'pipeline_cents')::int AS cents FROM scorecards WHERE event_id = $1 AND window_days = 30", [h.id]))[0].cents).toBe(5_000_000);
  });
});
