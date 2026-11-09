import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { approvalHeadroom, budgetView, recordTicket, setBudget } from "../src/server/budget.ts";
import type { Db } from "../src/server/db.ts";
import { spend } from "../src/server/ledger.ts";
import { decideSeat, parseSeatRequest, requestSeat } from "../src/server/seats.ts";
import { usageView } from "../src/server/usage.ts";
import { freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock", ANA = "Ana Duarte";
const body = (catalog_id: string) => ({ catalog_id, team: "Sales", role: "SDR", goal: "new_pipeline", why_event: "Their buyers are the people we sell to.", why_you: "I run outreach for this region and know the accounts.", expected_meetings: 4 });
const as = (a: string) => ({ "x-actor": encodeURIComponent(a), "content-type": "application/json" });
let db: Db;
const ask = (who: string, cat: string) => requestSeat(db, who, parseSeatRequest(who, body(cat)));
const approve = (id: string) => decideSeat(db, { requestId: id, actor: DAN, decision: "approve" });
const view = (year = 2027) => budgetView(db, { year });

beforeEach(async () => {
  db = await freshDb();
  const ins = (id: string, on: string, cents: number) => db.query("INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, seat_price_cents) VALUES ($1, $2, '', 'Lisbon', 'Portugal', $3, $3, $4)", [id, `Event ${id}`, on, cents]);
  await ins("q1", "2027-03-31", 100000); await ins("q2", "2027-04-01", 200000); await ins("y26", "2026-12-15", 50000);
});

describe("budget", () => {
  it("counts a seat once: waiting, then committed, then spent", async () => {
    const a = await ask(MAYA, "q1");
    expect((await view()).totals).toMatchObject({ waiting: 100000, committed: 0, spent: 0 });
    await approve(a.id);
    expect((await view()).totals).toMatchObject({ waiting: 0, committed: 100000, spent: 0 });
    await recordTicket(db, DAN, a.id, 900);
    expect((await view()).totals).toMatchObject({ waiting: 0, committed: 0, spent: 90000 });
    await recordTicket(db, DAN, a.id, 950);
    expect((await view()).totals).toMatchObject({ committed: 0, spent: 95000 });
    expect((await db.query("SELECT 1 FROM ticket_purchases")).length).toBe(1);
  });

  it("puts a seat in the quarter its event starts, and a year by its start date", async () => {
    await ask(MAYA, "q1"); await ask(MAYA, "q2"); await ask(MAYA, "y26");
    const v = await view();
    expect(v.quarters.map((q) => q.waiting)).toEqual([100000, 200000, 0, 0]);
    expect((await view(2026)).quarters[3].waiting).toBe(50000);
  });

  it("leaves out declined seats and ended events", async () => {
    const a = await ask(MAYA, "q1"), b = await ask(ANA, "q1");
    await decideSeat(db, { requestId: a.id, actor: DAN, decision: "decline", reason: "No" });
    expect((await view()).totals.waiting).toBe(100000);
    await decideSeat(db, { requestId: b.id, actor: DAN, decision: "decline", reason: "No" });
    expect((await view()).totals).toMatchObject({ waiting: 0, committed: 0, spent: 0 });
  });

  it("lets only approvers set the budget or record a ticket", async () => {
    const app = createApp(db, { demo: true });
    const a = await ask(MAYA, "q1"); await approve(a.id);
    const put = (path: string, who: string, b: unknown) => app.request(path, { method: "PUT", headers: as(who), body: JSON.stringify(b) });
    expect((await put("/api/budget/2027", MAYA, { quarters: [1, 1, 1, 1] })).status).toBe(403);
    expect((await put("/api/budget/2027", "GTM Team", { quarters: [1, 1, 1, 1] })).status).toBe(403);
    expect((await put(`/api/seat-requests/${a.id}/ticket`, MAYA, { amount_dollars: 5 })).status).toBe(403);
    expect((await put("/api/budget/2027", DAN, { quarters: [5000, 5000, 5000, 5000] })).status).toBe(200);
    expect((await put(`/api/seat-requests/${a.id}/ticket`, DAN, { amount_dollars: 950 })).status).toBe(200);
    const v = await view();
    expect(v.set).toBe(true);
    expect(v.totals.budget_cents).toBe(2_000_000);
    expect(v.log[0].detail).toMatch(/Set 2027 to \$20,000/);
    await expect(setBudget(db, MAYA, 2027, [1, 1, 1, 1])).rejects.toThrow(/approvers/);
  });

  it("warns when approving would pass the quarter and still lets it through", async () => {
    await setBudget(db, DAN, 2027, [1500, 0, 0, 0]);
    const a = await ask(MAYA, "q1"), b = await ask(ANA, "q1");
    expect((await approvalHeadroom(db)).get(a.id)).toMatchObject({ quarter: 1, left_after: 50000 });
    expect((await approve(a.id)).status).toBe("approved");
    expect((await approvalHeadroom(db)).get(b.id)!.left_after).toBe(-50000);
    expect((await approve(b.id)).status).toBe("approved");
    expect((await view()).quarters[0].left).toBe(150000 - 200000);
    const app = createApp(db, { demo: true });
    const rows = (await (await app.request("/api/seat-requests")).json() as { requests: { id: string; budget: unknown }[] }).requests;
    expect(rows).toHaveLength(2);
  });

  it("is tickets only: ledger spend never enters it", async () => {
    const a = await ask(MAYA, "q1"); await approve(a.id);
    const before = JSON.stringify((await view()).totals);
    const [{ event_id }] = await db.query<{ event_id: string }>("SELECT event_id FROM seat_requests");
    await db.query("INSERT INTO cost_cards (id, event_id, status, inputs, rates, lines, credits_cap, llm_cap, est_cents) VALUES ('c1', $1, 'approved', '{}', '{}', '{}', 100, 10, 800)", [event_id]);
    await db.query("INSERT INTO credit_ledger (id, event_id, card_id, unit, kind, amount, note) VALUES ('l1', $1, 'c1', 'credits', 'reserve', 40, 'apollo')", [event_id]);
    expect(JSON.stringify((await view()).totals)).toBe(before);
  });
});

describe("usage", () => {
  it("matches the ledger: reserved minus released, by vendor and in total", async () => {
    const a = await ask(MAYA, "q1"); await approve(a.id);
    const [{ event_id }] = await db.query<{ event_id: string }>("SELECT event_id FROM seat_requests");
    await db.query("INSERT INTO cost_cards (id, event_id, status, inputs, rates, lines, credits_cap, llm_cap, est_cents) VALUES ('c1', $1, 'approved', '{}', '{}', '{}', 100, 10, 800)", [event_id]);
    const led = (id: string, unit: string, kind: string, amount: number, note: string) => db.query("INSERT INTO credit_ledger (id, event_id, card_id, unit, kind, amount, note) VALUES ($1, $2, 'c1', $3, $4, $5, $6)", [id, event_id, unit, kind, amount, note]);
    await led("a", "credits", "reserve", 30, "apollo"); await led("b", "credits", "settle", 22, "apollo"); await led("c", "credits", "release", 8, "apollo");
    await led("d", "credits", "reserve", 10, "zerobounce"); await led("e", "llm", "reserve", 5, "tiering");
    const now = new Date();
    const u = await usageView(db, { year: now.getFullYear(), month: now.getMonth() + 1, simulated: true });
    const s = await spend(db, event_id);
    expect(u.ai.year_cents).toBe(s.llm * 1);
    expect(u.vendors.find((v) => v.vendor === "Apollo")!.used).toBe(22);
    expect(u.vendors.find((v) => v.vendor === "ZeroBounce")!.used).toBe(10);
    expect(u.events[0].credits.Apollo.used).toBe(22);
    expect(u.events[0].credits.ZeroBounce.used).toBe(10);
    expect(u.events[0].ai.cents).toBe(5);
    expect(u.simulated).toBe(true);
  });
  it("searches and pages the by-event table", async () => {
    const u = await usageView(db, { q: "nothing like it", simulated: false });
    expect(u.events).toEqual([]);
    expect(u.pages).toBe(1);
  });
});
