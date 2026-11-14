/* A rep's hosted reads carry no company money, in a key or in text (docs/HOSTED.md 3.3, 21.12). Leadership and planners read the same page with the figures. */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { recordEventCost } from "../src/server/closeout.ts";
import { checkIn, closeAttendance, patchHosted, updateGuest } from "../src/server/hosted.ts";
import { putCohost, putVenue } from "../src/server/hosted-view.ts";
import { addPerson } from "../src/server/plan.ts";
import { mockLlm } from "../src/server/providers.ts";
import { freshDb } from "./helpers.ts";
import { AFTER, BEFORE, depsAt, hostedDinner, ON_THE_DAY, tokenOf, yes } from "./hosted-helpers.ts";
import { CAMILLE, DAN, MAYA } from "./plan-helpers.ts";

/** Every place a dollar figure hides: a money-named key with a number, or "$12" in text. */
export function money(x: unknown, path = ""): string[] {
  if (Array.isArray(x)) return x.flatMap((v, i) => money(v, `${path}[${i}]`));
  if (x && typeof x === "object") return Object.entries(x).flatMap(([k, v]) =>
    /cents|pipeline|amount|dollars|price|llm/i.test(k) && !/with_pipeline$/.test(k) && typeof v === "number" && v !== 0 ? [`${path}.${k} = ${v}`] : money(v, `${path}.${k}`));
  return typeof x === "string" && /\$\s?\d/.test(x) ? [`${path} = "${x.slice(0, 80)}"`] : [];
}

async function setup() {
  const db = await freshDb();
  const id = await hostedDinner(db, { capacity: 10 });
  const a = await yes(db, depsAt(BEFORE), id, "Ana Ruiz");
  const b = await yes(db, depsAt(BEFORE), id, "Ben Cole");
  await patchHosted(db, CAMILLE, id, { welcome: "Dinner is $90 a head, on us." });
  const [line] = await db.query<{ id: string }>("SELECT id FROM budget_lines WHERE event_id = $1", [id]);
  await putVenue(db, depsAt(BEFORE), CAMILLE, id, { name: "Pier Room", budget_line_id: line.id, minimum_spend_cents: 450_000, guarantee_headcount: 8, guarantee_by: "2027-06-01", note: "The minimum is $4,500 before wine.", steps: [{ by_date: "2027-06-03", rule: "Fee of $2,000 after this", fee_cents: 200_000 }] });
  await putCohost(db, CAMILLE, id, { partner: "Partner Co", our_share_percent: 60, lead_rule: "own_invites", note: "We pay $3,000 of it." });
  await recordEventCost(db, id, DAN, "dinners", 480_000, "Venue and food");
  await checkIn(db, depsAt(ON_THE_DAY), CAMILLE, id, a);
  await updateGuest(db, CAMILLE, id, a, { notes: "Budget for a $50,000 pilot." });
  await closeAttendance(db, depsAt(AFTER), CAMILLE, id);
  return { db, id, a, b, app: createApp(db, { demo: true, lifecycle: { connectors: {}, llm: mockLlm, now: () => AFTER } as never }) };
}
const as = (a: string) => ({ "x-actor": encodeURIComponent(a) });

describe("a rep's hosted reads", () => {
  it("the page, the follow-up, the owner's list, the suggestions and the public link carry no cents key and no dollar text", async () => {
    const { db, id, a, app } = await setup();
    await db.query("INSERT INTO target_accounts (id, name, owner, open_deal, created_by) VALUES ('tac_1', 'Acme', 'Maya Ortiz', 'Renewal worth $90,000', 'x')");
    const tok = await tokenOf(db, a);
    const reads = [`/api/events/${id}/hosted`, `/api/events/${id}/follow-up`, `/api/events/${id}/guests/suggestions`, "/api/hosted/mine", `/api/rsvp/${tok}`];
    const found: string[] = [];
    for (const path of reads) {
      const r = await app.request(path, { headers: as("Priya Nair") });
      if (r.status !== 200) continue;
      const j = await r.json();
      if (!/rsvp/.test(path)) found.push(...money(j).map((f) => `${path}: ${f}`));
      expect(JSON.stringify(j), path).not.toMatch(/"[a-z_]*cents"/);
    }
    expect(found).toEqual([]);
    // The rep's page still has the venue, the co-host and the guests, with the words and without the figures.
    const page = await (await app.request(`/api/events/${id}/hosted`, { headers: as("Priya Nair") })).json() as any;
    expect(page.venue).toMatchObject({ name: "Pier Room", guarantee_headcount: 8, guarantee_by: "2027-06-01" });
    expect(page.venue.note).toBe("");
    expect(page.settings.welcome).toBe("");
    expect(page.cohost).toMatchObject({ partner: "Partner Co", our_share_percent: 60, note: "" });
    expect(page.guests).toHaveLength(2);
    expect(page.guests.find((g: any) => g.id === a).notes).toBe("");
  });

  it("a rep's suggestions carry no deal text with a dollar figure, and a planner's still do", async () => {
    const { db, id, app } = await setup();
    await db.query("INSERT INTO target_accounts (id, name, owner, open_deal, deal_stage, created_by) VALUES ('tac_2', 'Zed Corp', 'Maya Ortiz', 'Renewal worth $90,000', 'Won $90,000', 'x')");
    const rep = JSON.stringify(await (await app.request(`/api/events/${id}/guests/suggestions`, { headers: as("Priya Nair") })).json());
    expect(rep).not.toContain("$90,000");
    expect(rep).toContain("Zed Corp");
    expect(JSON.stringify(await (await app.request(`/api/events/${id}/guests/suggestions`, { headers: as(CAMILLE) })).json())).toContain("$90,000");
  });

  it("a venue PUT without a field keeps what is stored, and only someone who sees money changes the money fields", async () => {
    const { db, id, app } = await setup();
    const put = (who: string, body: unknown) => app.request(`/api/events/${id}/venue`, { method: "PUT", headers: { ...as(who), "content-type": "application/json" }, body: JSON.stringify(body) });
    const read = async () => (await db.query<any>("SELECT name, address, budget_line_id, minimum_spend_cents::float8 AS m, guarantee_headcount, guarantee_by::text AS by, note FROM event_venues WHERE event_id = $1", [id]))[0];
    const first = await read();
    expect((await put(CAMILLE, { guarantee_headcount: 9 })).status).toBe(200);
    expect(await read()).toEqual({ ...first, guarantee_headcount: 9 });
    // A host with no money rights: the money fields are ignored, never erased.
    await addPerson(db, CAMILLE, id, { person: "Priya Nair", roles: ["host"] });
    const r = await put("Priya Nair", { note: "Use the side door.", minimum_spend_cents: 1, budget_line_id: null });
    expect(r.status).toBe(200);
    expect(await read()).toEqual({ ...first, guarantee_headcount: 9, note: "Use the side door." });
    // The planner can clear them on purpose.
    expect((await put(CAMILLE, { minimum_spend_cents: null })).status).toBe(200);
    expect((await read()).m).toBeNull();
  });

  it("leadership and a planner read the same page with the figures", async () => {
    const { id, app } = await setup();
    for (const who of [DAN, CAMILLE]) {
      const page = await (await app.request(`/api/events/${id}/hosted`, { headers: as(who) })).json() as any;
      expect(page.venue.minimum_spend_cents, who).toBe(450_000);
      expect(page.cohost).toMatchObject({ cost_cents: 480_000, our_share_cents: 288_000 });
      expect(page.cost.per_attendee_cents).toBe(480_000);
      expect(page.settings.welcome).toBe("Dinner is $90 a head, on us.");
      const f = await (await app.request(`/api/events/${id}/follow-up`, { headers: as(who) })).json() as any;
      expect(f.cost.total_cents).toBe(480_000);
    }
  });

  it("a rep cannot write the money: the venue and the co-host split are for the host and planners", async () => {
    const { id, app } = await setup();
    const put = (who: string, path: string, body: unknown) => app.request(`/api/events/${id}${path}`, { method: "PUT", headers: { ...as(who), "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await put("Priya Nair", "/venue", { minimum_spend_cents: 1 })).status).toBe(403);
    expect((await put("Priya Nair", "/cohosts", { partner: "X" })).status).toBe(403);
    expect((await put(MAYA, "/venue", { minimum_spend_cents: 1 })).status).toBe(403);
    expect((await put(CAMILLE, "/venue", { name: "Pier Room", minimum_spend_cents: 300_000 })).status).toBe(200);
  });
});
