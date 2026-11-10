/* A reply, a meeting or a deal shows the account it belongs to, and the other people from that account on the event with where each
   stands. The person the sheet is about is not listed again among them. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { bookMeeting } from "../src/server/meetings.ts";
import { meetingDetail } from "../src/server/rep-day.ts";
import { createApp } from "../src/server/app.ts";
import { freshDb } from "./helpers.ts";
import { clock, deliveredInMotion, MAYA, personAt } from "./lifecycle-harness.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

describe("the account on a sheet", () => {
  it("a meeting carries its company and the others from it, without the person met", async () => {
    const h = await deliveredInMotion(db, { time: clock("2027-01-05T12:00:00Z") });
    const ana = await personAt(db, h.id, "Ana Ruiz");
    const m = await bookMeeting(db, h.deps, { contact_id: ana.id, scheduled_at: "2027-01-15T15:00:00Z", source: "manual", rep: MAYA }, MAYA);
    const d = await meetingDetail(db, m.id) as { account: { name: string; others: { id: string; state: string }[] } | null };
    const [co] = await db.query<{ name: string; n: number }>("SELECT co.name, (SELECT count(*)::int FROM contacts k WHERE k.company_id = co.id AND k.dropped_at IS NULL) AS n FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.id = $1", [ana.id]);
    expect(d.account?.name).toBe(co.name);
    expect(d.account?.others.some((o) => o.id === ana.id)).toBe(false);
    expect(d.account?.others.length).toBe(Math.min(8, co.n - 1));
    for (const o of d.account?.others ?? []) expect(["meeting", "replied", "met", "reached", "listed"]).toContain(o.state);
  });

  it("a company opened from the list carries everyone kept from it", async () => {
    const h = await deliveredInMotion(db, { time: clock("2027-01-05T12:00:00Z") });
    const [co] = await db.query<{ id: string; n: number }>("SELECT co.id, (SELECT count(*)::int FROM contacts k WHERE k.company_id = co.id AND k.dropped_at IS NULL) AS n FROM companies co WHERE co.event_id = $1 ORDER BY 2 DESC LIMIT 1", [h.id]);
    const app = createApp(db, { demo: true, lifecycle: h.deps });
    const r = await app.request(`/api/events/${h.id}/companies/${co.id}`, { headers: { "x-actor": "GTM Team" } });
    expect(r.status).toBe(200);
    const d = await r.json() as { company_id: string; others: unknown[] };
    expect(d.company_id).toBe(co.id);
    expect(d.others).toHaveLength(co.n);
    expect((await app.request(`/api/events/${h.id}/companies/co_nope`, { headers: { "x-actor": "GTM Team" } })).status).toBe(404);
  });
});
