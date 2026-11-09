import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { parseCatalogEntry, parseSeatRequest, requestSeat } from "../src/server/seats.ts";
import { freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock", GTM = "GTM Team";
const as = (a: string) => ({ "x-actor": encodeURIComponent(a), "content-type": "application/json" });
const entry = (o: Record<string, unknown> = {}) => ({ name: "Orbit Summit 2027", website: "https://orbit.example.com", starts_on: "2027-04-10", ends_on: "2027-04-12", city: "Lisbon", country: "Portugal", venue: "Pier 9 Hall", price_dollars: 900, ...o });

let db: Db;
beforeEach(async () => { db = await freshDb(); });

describe("adding an event to the catalog", () => {
  const post = (b: Record<string, unknown>, who: string) => createApp(db, { demo: true }).request("/api/catalog", { method: "POST", headers: as(who), body: JSON.stringify(b) });

  it("GTM Engineering and the seat approvers may; anyone else is refused on the server", async () => {
    expect((await post(entry(), MAYA)).status).toBe(403);
    expect((await post(entry(), "Random Person")).status).toBe(403);
    expect((await post(entry(), GTM)).status).toBe(201);
    expect((await post(entry({ name: "Second Summit" }), DAN)).status).toBe(201);
    const rows = await db.query<{ name: string; source: string; suggested_by: string; website: string; seat_price_cents: number }>("SELECT name, source, suggested_by, website, seat_price_cents FROM catalog_events ORDER BY name");
    expect(rows).toEqual([
      { name: "Orbit Summit 2027", source: "listed", suggested_by: GTM, website: "https://orbit.example.com", seat_price_cents: 90000 },
      { name: "Second Summit", source: "listed", suggested_by: DAN, website: "https://orbit.example.com", seat_price_cents: 90000 },
    ]);
  });

  it("shows up on the catalog with nobody going, so Events lists it as not requested", async () => {
    const r = await (await post(entry(), GTM)).json() as { id: string };
    const { catalog } = await (await createApp(db, { demo: true }).request("/api/catalog")).json() as { catalog: { id: string; event_id: string | null; going: number; website: string }[] };
    const c = catalog.find((x) => x.id === r.id)!;
    expect(c).toMatchObject({ event_id: null, going: 0, website: "https://orbit.example.com" });
  });

  it("checks each field and says what is missing", async () => {
    const bad = (o: Record<string, unknown>, re: RegExp) => expect(() => parseCatalogEntry(entry(o))).toThrow(re);
    bad({ name: " " }, /Name the event/);
    bad({ starts_on: "April" }, /start date/);
    bad({ ends_on: "2027-04-01" }, /end date/);
    bad({ city: "" }, /city and country/);
    bad({ website: "orbit.example.com" }, /website/);
    bad({ price_dollars: -1 }, /price/);
    bad({ price_dollars: undefined }, /price/);
    expect(parseCatalogEntry(entry({ ends_on: "" })).ends_on).toBe("2027-04-10");
    expect((await post(entry({ website: "nope" }), GTM)).status).toBe(400);
  });

  it("gives every event its organizer's website, for the logo", async () => {
    const r = await (await post(entry(), GTM)).json() as { id: string };
    await requestSeat(db, MAYA, parseSeatRequest(MAYA, { catalog_id: r.id, team: "Sales", role: "SDR", goal: "new_pipeline", why_event: "Their buyers are the people we sell to.", why_you: "I run outreach for this region and know the accounts.", expected_meetings: 3 }));
    const app = createApp(db, { demo: true });
    const { events } = await (await app.request("/api/events")).json() as { events: { id: string; website: string | null }[] };
    expect(events[0].website).toBe("https://orbit.example.com");
    const one = await (await app.request(`/api/events/${events[0].id}`)).json() as { event: { website: string | null } };
    expect(one.event.website).toBe("https://orbit.example.com");
  });
});
