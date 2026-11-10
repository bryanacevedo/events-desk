/* The desk prices each cost card itself; the person who uploaded the list only confirms it. A setting changed while the card waits sets
   that card aside and prices a new one, so settings never lock anyone out before the card is confirmed. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { createEvent, moveEvent } from "../src/server/events.ts";
import { freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock", ANA = "Ana Duarte";
const hdr = (a: string) => ({ "x-actor": encodeURIComponent(a) });
const LIST = "Company,Name,Title,Email\nAcme,Ada Lovelace,VP Sales,ada@acme.com\nKestrel Foods,Bo Lindqvist,Head of Growth,bo@kestrel.example\n";
let db: Db;
beforeEach(async () => { db = await freshDb(); });

async function approvedEvent() {
  const id = (await createEvent(db, MAYA, { name: "Auto", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 100 })).id;
  await moveEvent(db, id, "approved", DAN);
  return id;
}
const pending = (id: string) => db.query<{ id: string; kind: string; requested_by: string }>("SELECT id, kind, requested_by FROM approvals WHERE event_id = $1 AND status = 'pending' AND kind <> 'seats'", [id]);

describe("cost cards priced by the desk", () => {
  it("prices the card as soon as the list is mapped, in the uploader's name, and asking again changes nothing", async () => {
    const app = createApp(db, { demo: true, autoQuote: true });
    const id = await approvedEvent();
    const r = await app.request(`/api/events/${id}/upload`, { method: "POST", headers: { ...hdr(ANA), "x-filename": "list.csv", "content-type": "text/csv" }, body: LIST });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { stage: string }).stage).toBe("quoted");
    expect(await pending(id)).toHaveLength(1);
    const [asked] = await db.query<{ actor: string }>("SELECT actor FROM activity_log WHERE event_id = $1 AND detail LIKE 'Requested the Research card%' ORDER BY created_at DESC LIMIT 1", [id]);
    expect(asked?.actor).toBe(ANA);
    expect((await app.request(`/api/events/${id}/quote`, { method: "POST", headers: hdr(MAYA) })).status).toBe(200);
    expect(await pending(id)).toHaveLength(1);
  });

  it("a setting changed while the card waits prices a new card; the old one is set aside with the reason", async () => {
    const app = createApp(db, { demo: true, autoQuote: true });
    const id = await approvedEvent();
    await app.request(`/api/events/${id}/upload`, { method: "POST", headers: { ...hdr(MAYA), "x-filename": "list.csv", "content-type": "text/csv" }, body: LIST });
    const [first] = await pending(id);
    const r = await app.request(`/api/events/${id}/settings`, { method: "PATCH", headers: { ...hdr(MAYA), "content-type": "application/json" }, body: JSON.stringify({ add_prospects: false }) });
    expect(r.status).toBe(200);
    const [next] = await pending(id);
    expect(next.id).not.toBe(first.id);
    const [old] = await db.query<{ status: string; reason: string }>("SELECT status, reason FROM approvals WHERE id = $1", [first.id]);
    expect(old).toMatchObject({ status: "declined", reason: "Priced again: settings changed" });
    const [{ stage }] = await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]);
    expect(stage).toBe("quoted");
  });

  it("without the switch, the card waits to be asked for, as before", async () => {
    const app = createApp(db, { demo: true });
    const id = await approvedEvent();
    await app.request(`/api/events/${id}/upload`, { method: "POST", headers: { ...hdr(MAYA), "x-filename": "list.csv", "content-type": "text/csv" }, body: LIST });
    expect(await pending(id)).toHaveLength(0);
  });
});
