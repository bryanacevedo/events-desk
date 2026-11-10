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
