import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { decideSeat, parseSeatRequest, requestSeat, type SeatInput } from "../src/server/seats.ts";
import { deliverEvent, freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock", ANA = "Ana Duarte", LEO = "Leo Marsh";
const body = (o: Record<string, unknown> = {}) => ({
  catalog_id: "cat_a", team: "Sales", role: "SDR", goal: "new_pipeline", why_event: "Their buyers are the people we sell to.", why_you: "I run outreach for this region and know the accounts.", expected_meetings: 6, ...o,
});
const input = (o: Record<string, unknown> = {}, actor = MAYA): SeatInput => parseSeatRequest(actor, body(o));
const as = (a: string) => ({ "x-actor": encodeURIComponent(a), "content-type": "application/json" });

let db: Db;
const stageOf = async (id: string) => (await db.query<{ stage: string; seat_count: number }>("SELECT stage, seat_count FROM events WHERE id = $1", [id]))[0];
const req = (who: string, o: Record<string, unknown> = {}) => requestSeat(db, who, input(o, who));
const decide = (id: string, actor: string, decision: "approve" | "decline" = "approve", reason?: string) => decideSeat(db, { requestId: id, actor, decision, reason });

beforeEach(async () => {
  db = await freshDb();
  await db.query("INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents) VALUES ('cat_a', 'Test Summit', 'Hall', 'Lisbon', 'Portugal', '2027-03-01', '2027-03-03', 'https://example.com', 100000)");
});

describe("seat requests", () => {
  it("makes the event row on the first request, in stage requested", async () => {
    const r = await req(MAYA);
    expect(await stageOf(r.event_id)).toEqual({ stage: "requested", seat_count: 1 });
  });

  it("is for your own seat only, enforced on the server", async () => {
    const app = createApp(db, { demo: true });
    const post = (b: Record<string, unknown>, who = MAYA) => app.request("/api/seat-requests", { method: "POST", headers: as(who), body: JSON.stringify(b) });
    expect((await post(body({ requester: DAN }))).status).toBe(403);
    expect((await post(body({ seats: 2 }))).status).toBe(403);
    expect((await post(body({ seat_count: 3 }))).status).toBe(403);
    const ok = await post(body({ requester: MAYA }));
    expect(ok.status).toBe(201);
    const [row] = await db.query<{ requester: string }>("SELECT requester FROM seat_requests");
    expect(row.requester).toBe(MAYA);
  });

  it("refuses a second open request from the same person for the same event", async () => {
    await req(MAYA);
    await expect(req(MAYA)).rejects.toThrow(/already have a seat request/);
  });

  it("takes several people on one event, each on their own row", async () => {
    const a = await req(MAYA), b = await req(ANA), c = await req(LEO);
    expect(new Set([a.event_id, b.event_id, c.event_id]).size).toBe(1);
    expect((await stageOf(a.event_id)).seat_count).toBe(3);
    expect((await db.query("SELECT 1 FROM events")).length).toBe(1);
  });

  it("moves the event to approved on the first approval, and the count follows the approvals", async () => {
    const a = await req(MAYA), b = await req(ANA), c = await req(LEO);
    await decide(a.id, DAN);
    expect(await stageOf(a.event_id)).toEqual({ stage: "approved", seat_count: 1 });
    await decide(b.id, DAN);
    expect((await stageOf(a.event_id)).seat_count).toBe(2);
    await decide(c.id, DAN, "decline", "Over budget");
    expect(await stageOf(a.event_id)).toEqual({ stage: "approved", seat_count: 2 });
  });

  it("cannot be approved by the person who asked, or by someone who is not an approver", async () => {
    const a = await req(MAYA);
    await db.query("UPDATE event_settings SET settings = jsonb_set(settings, '{approvers}', '[\"Dan Whitlock\", \"Maya Ortiz\"]')");
    await expect(decide(a.id, MAYA)).rejects.toThrow(/own request/);
    await expect(decide(a.id, "Random Person")).rejects.toThrow(/approvers/);
    expect((await decide(a.id, DAN)).status).toBe("approved");
  });

  it("declines the event when every request is declined, and a later request starts a new event", async () => {
    const a = await req(MAYA), b = await req(ANA);
    await decide(a.id, DAN, "decline", "No budget");
    expect((await stageOf(a.event_id)).stage).toBe("requested");
    await decide(b.id, DAN, "decline", "No budget");
    expect((await stageOf(a.event_id)).stage).toBe("declined");
    const again = await req(MAYA);
    expect(again.event_id).not.toBe(a.event_id);
    expect(await stageOf(again.event_id)).toEqual({ stage: "requested", seat_count: 1 });
  });

  it("leaves the pipeline alone when a request comes after delivery", async () => {
    const id = await deliverEvent(db, "Company,Name,Title,Email\nAcme,Ada Lovelace,VP Sales,ada@acme.com\n");
    await db.query("UPDATE events SET catalog_id = 'cat_a' WHERE id = $1", [id]);
    const before = await stageOf(id);
    expect(before.stage).toBe("delivered");
    const late = await req(LEO);
    expect(late.event_id).toBe(id);
    await decide(late.id, DAN);
    const after = await stageOf(id);
    expect(after.stage).toBe("delivered");
    expect(after.seat_count).toBe(1);
  });

  it("adds a suggested event to the catalog when its request is approved, not before", async () => {
    const suggestion = { name: "Orrery Customer Dinner", website: "https://orrery.example.com/dinner", starts_on: "2027-02-10", city: "Lisbon", country: "Portugal", price_dollars: 150 };
    const r = await requestSeat(db, MAYA, parseSeatRequest(MAYA, body({ catalog_id: undefined, suggestion })));
    expect((await db.query("SELECT 1 FROM catalog_events WHERE source = 'suggested'")).length).toBe(0);
    await decide(r.id, DAN);
    const [c] = await db.query<{ name: string; suggested_by: string; seat_price_cents: number }>("SELECT name, suggested_by, seat_price_cents FROM catalog_events WHERE source = 'suggested'");
    expect(c).toMatchObject({ name: "Orrery Customer Dinner", suggested_by: MAYA, seat_price_cents: 15000 });
    const [e] = await db.query<{ catalog_id: string | null }>("SELECT catalog_id FROM events WHERE id = $1", [r.event_id]);
    expect(e.catalog_id).not.toBeNull();
  });

  it("declining a suggestion adds nothing to the catalog", async () => {
    const suggestion = { name: "Nope Conf", website: "https://nope.example.com", starts_on: "2027-02-10", city: "Oslo", country: "Norway", price_dollars: 0 };
    const r = await requestSeat(db, MAYA, parseSeatRequest(MAYA, body({ catalog_id: undefined, suggestion })));
    await decide(r.id, DAN, "decline", "Not relevant");
    expect((await db.query("SELECT 1 FROM catalog_events WHERE source = 'suggested'")).length).toBe(0);
  });
});

describe("seat request validation", () => {
  const bad = (o: Record<string, unknown>, re: RegExp) => expect(() => parseSeatRequest(MAYA, body(o))).toThrow(re);
  it("asks for what is missing, in one sentence", () => {
    bad({ catalog_id: "" }, /Choose an event/);
    bad({ team: " " }, /team/);
    bad({ role: "" }, /role/);
    bad({ goal: "fun" }, /main goal/);
    bad({ why_event: "short" }, /why this event/i);
    bad({ why_you: "short" }, /why you/i);
    bad({ expected_meetings: "many" }, /meetings/);
    bad({ expected_meetings: undefined }, /meetings/);
    bad({ travel_dollars: -5 }, /travel/i);
    bad({ decide_by: "soon" }, /decide-by/);
  });
  it("checks a suggestion's own fields", () => {
    const s = { name: "X Conf", website: "https://x.example.com", starts_on: "2027-02-10", city: "Oslo", country: "Norway", price_dollars: 100 };
    const go = (o: Record<string, unknown>) => parseSeatRequest(MAYA, body({ catalog_id: undefined, suggestion: { ...s, ...o } }));
    expect(() => go({})).not.toThrow();
    expect(() => go({ name: "" })).toThrow(/Name the event/);
    expect(() => go({ website: "x" })).toThrow(/website/);
    expect(() => go({ starts_on: "tomorrow" })).toThrow(/start date/);
    expect(() => go({ ends_on: "2027-02-01" })).toThrow(/end date/);
    expect(() => go({ city: "" })).toThrow(/city and country/);
    expect(() => go({ price_dollars: "free" })).toThrow(/price/);
  });
  it("answers 400 over HTTP, and refuses an event that is not listed", async () => {
    const app = createApp(db, { demo: true });
    const r = await app.request("/api/seat-requests", { method: "POST", headers: as(MAYA), body: JSON.stringify(body({ why_you: "no" })) });
    expect(r.status).toBe(400);
    const missing = await app.request("/api/seat-requests", { method: "POST", headers: as(MAYA), body: JSON.stringify(body({ catalog_id: "cat_zzz" })) });
    expect(missing.status).toBe(400);
  });
});
