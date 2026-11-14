/* The demo's hosted dinners run end to end (docs/HOSTED.md 17, 21.1 to 21.3, 21.21): through the code the routes use, on a fixed day. */

import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { createApp } from "../src/server/app.ts";
import { followUp } from "../src/server/hosted-view.ts";
import { weekDeadlines } from "../src/server/plan.ts";
import { mockLlm } from "../src/server/providers.ts";
import { ORRERY_DINNER, seedReal } from "../src/server/seed-real.ts";
import { restampDemoPlan, seedPlan } from "../src/server/seed-plan.ts";
import { CAPITOL, GOLDEN_GATE, LAKESIDE, RIVERBEND, CASCADIA } from "../src/server/seed-hosted.ts";
import { freshDb } from "./helpers.ts";
import { CAMILLE, MAYA, TODAY } from "./plan-helpers.ts";

let db: Db, app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await freshDb();
  await seedReal(db);
  await seedPlan(db, { today: TODAY });
  await restampDemoPlan(db, TODAY);
  app = createApp(db, { demo: true, lifecycle: { connectors: {}, llm: mockLlm, now: () => new Date(`${TODAY}T15:00:00Z`) } as never });
}, 180_000);

const hosted = async (id: string, who = CAMILLE) => (await (await app.request(`/api/events/${id}/hosted`, { headers: { "x-actor": encodeURIComponent(who) } })).json()) as any;
const q = <T>(sql: string, p: unknown[] = []) => db.query<T>(sql, p);

describe("Golden Gate Field Dinner, from the list to the reminder", () => {
  it("22 listed: eleven invited, five registered, one waitlisted, two declined, three unanswered, and eleven not yet invited", async () => {
    const h = await hosted(GOLDEN_GATE);
    expect(h.counts).toMatchObject({ total: 22, listed: 11, invited: 3, registered: 5, waitlist: 1, declined: 2, capacity: 10, over_capacity: false });
    expect(h.settings).toMatchObject({ capacity: 10, capacity_words: "10 places" });
    expect((await q("SELECT 1 FROM guest_invitations WHERE event_id = $1", [GOLDEN_GATE])).length).toBe(11);
    expect((await q("SELECT 1 FROM target_accounts")).length).toBe(14);
    // Raising the capacity to 10 promoted nobody: the host moves the waitlisted guest in.
    const w = h.guests.find((g: any) => g.status === "waitlist");
    expect(w).toBeTruthy();
    expect(h.estimate).toMatchObject({ basis: "history" });
    expect(h.primary.action).toBe("invite");
  });

  it("one reminder went to the registered only, and the guests the desk may not email are marked", async () => {
    const reg = (await q<{ id: string }>("SELECT id FROM event_guests WHERE event_id = $1 AND status = 'registered'", [GOLDEN_GATE])).map((g) => g.id).sort();
    const sent = (await q<{ guest_id: string; state: string }>("SELECT guest_id, state FROM transactional_outbox WHERE event_id = $1 AND kind = 'reminder'", [GOLDEN_GATE]));
    expect(sent.map((s) => s.guest_id).sort()).toEqual(reg);
    expect(sent.every((s) => s.state === "sent")).toBe(true);
    const h = await hosted(GOLDEN_GATE);
    expect(h.guests.filter((g: any) => !g.can_email).map((g: any) => g.email_block).sort()).toEqual(["Not emailed in this country", "Not emailed in this country", "Their country is not known, so no email until it is"]);
    expect(h.reminders.last_run).toMatchObject({ kind: "reminder", sent_count: 5 });
  });

  it("every invitation, yes answer and the reminder is dated before the demo's day, and Send reminder works now", async () => {
    const day = new Date(`${TODAY}T15:00:00Z`);
    const future = await q<{ n: number }>("SELECT count(*)::int AS n FROM guest_invitations WHERE event_id = $1 AND (logged_at > $2::timestamptz OR sent_on > $2::date)", [GOLDEN_GATE, day.toISOString()]);
    expect(future[0].n).toBe(0);
    expect((await q("SELECT 1 FROM event_guests WHERE event_id = $1 AND rsvp_at > $2::timestamptz", [GOLDEN_GATE, day.toISOString()])).length).toBe(0);
    expect((await q("SELECT 1 FROM reminder_runs WHERE event_id = $1 AND created_at > $2::timestamptz", [GOLDEN_GATE, day.toISOString()])).length).toBe(0);
    const r = await app.request(`/api/events/${GOLDEN_GATE}/reminders`, { method: "POST", headers: { "x-actor": encodeURIComponent(CAMILLE), "content-type": "application/json" }, body: JSON.stringify({ kind: "reminder" }) });
    expect(r.status).toBe(201);
    expect(((await r.json()) as any).sent).toBe(5);
  });

  it("the venue has a minimum spend on the plan's own line, a guarantee in 13 days, and two cancellation steps in date order", async () => {
    const h = await hosted(GOLDEN_GATE);
    expect(h.venue).toMatchObject({ name: "Ferry Building Room", minimum_spend_cents: 400_000, guarantee_headcount: 10, guarantee_by: "2026-11-26" });
    expect(h.venue.steps.map((s: any) => [s.by_date, s.rule])).toEqual([["2026-11-18", "Free cancellation ends"], ["2026-11-26", "Half the minimum spend is owed after this"]]);
    expect(h.venue.next_date).toMatchObject({ kind: "cancellation", days_away: 5 });
    expect(h.venue.line).toBe("Registered 5, expected 4 at 17 percent, guarantee 10 by 26 Nov");
    const [line] = await q<{ category: string }>("SELECT category FROM budget_lines WHERE id = $1", [h.venue.budget_line.id]);
    expect(line.category).toBe("dinners");
    // The venue adds nothing to the planned total: one line, as seedHosted made it.
    expect((await q("SELECT 1 FROM budget_lines WHERE event_id = $1", [GOLDEN_GATE])).length).toBe(1);
  });

  it("a venue date within seven days is on This week, read from the view, and is late until it is marked done", async () => {
    const w = (await weekDeadlines(db, TODAY)).filter((d) => d.event_id === GOLDEN_GATE);
    expect(w.map((d) => [d.kind, d.due_on, d.group])).toEqual([["venue", "2026-11-18", "week"]]);
    const later = (await weekDeadlines(db, "2026-11-20")).filter((d) => d.event_id === GOLDEN_GATE);
    expect(later.map((d) => [d.due_on, d.group, d.due_words])).toEqual([["2026-11-18", "late", "2 days late"], ["2026-11-26", "week", "Due Thursday"], ["2026-11-26", "week", "Due Thursday"]]);
    await q("UPDATE venue_cancellation_steps SET done = true WHERE id = 'vcs_seed_gg_free'");
    expect((await weekDeadlines(db, "2026-11-20")).filter((d) => d.event_id === GOLDEN_GATE).map((d) => d.due_on)).toEqual(["2026-11-26", "2026-11-26"]);
    await q("UPDATE venue_cancellation_steps SET done = false WHERE id = 'vcs_seed_gg_free'");
  });
});

describe("the closed dinners are the team's own history", () => {
  it("Riverbend, Cascadia and Lakeside are closed with attended and no-show, and the open dinner reads Your own events", async () => {
    for (const id of [RIVERBEND, CASCADIA, LAKESIDE]) {
      const f = await followUp(db, { now: () => new Date(`${TODAY}T15:00:00Z`) }, id, { money: true }) as any;
      expect(f.closed, id).toBe(true);
      expect(f.attended.count, id).toBeGreaterThan(4);
      expect(f.no_show.count, id).toBeGreaterThan(0);
      expect([...f.attended.guests, ...f.no_show.guests].every((g: any) => g.owner), id).toBe(true);
    }
    const yes = (await q<{ n: number }>("SELECT count(*)::int AS n FROM event_guests WHERE event_id IN ($1, $2, $3) AND status IN ('attended', 'no_show') AND source <> 'walk_in'", [RIVERBEND, CASCADIA, LAKESIDE]))[0].n;
    expect(yes).toBeGreaterThanOrEqual(10);
    const h = await hosted(GOLDEN_GATE);
    expect(h.estimate.basis).toBe("history");
    expect(h.estimate.words).toMatch(/^Your own events: \d+ of \d+ said yes and did not come\.$/);
  });

  it("Lakeside is co-hosted: the whole cost with our share beside it", async () => {
    const f = await followUp(db, {}, LAKESIDE, { money: true }) as any;
    expect(f.cohost).toMatchObject({ partner: "Lakeline Partners", our_share_percent: 50 });
    expect(f.cohost.our_share_cents).toBe(Math.round(f.cohost.cost_cents / 2));
    expect(f.cost.per_attendee_cents).toBeGreaterThan(0);
  });
});

describe("Capitol Revenue Roadshow, at the door on the demo's day", () => {
  it("is dated today, with registered guests, one checked in and one walk-in", async () => {
    expect((await q<{ starts_on: string }>("SELECT starts_on::text AS starts_on FROM events WHERE id = $1", [CAPITOL]))[0].starts_on).toBe(TODAY);
    const h = await hosted(CAPITOL, MAYA);
    expect(h.counts).toMatchObject({ registered: 9, attended: 2, walk_ins: 1, declined: 1, capacity: 12 });
    expect(h.event.day_began).toBe(true);
    expect(h.guests.filter((g: any) => g.status === "attended" && g.source === "walk_in")).toHaveLength(1);
  });
});

describe("the Orrery customer dinner in Lisbon is a hosted plan, not a seat suggestion", () => {
  it("has a host, six listed guests and no pending seat request", async () => {
    expect(await q("SELECT 1 FROM seat_requests WHERE suggestion IS NOT NULL AND status = 'pending'")).toEqual([]);
    const h = await hosted(ORRERY_DINNER);
    expect(h.event).toMatchObject({ name: "Orrery customer dinner, Lisbon", format: "customer_event", hosts: ["Maya Ortiz"] });
    expect(h.counts).toMatchObject({ total: 6, listed: 6 });
    expect(h.guests.every((g: any) => g.owner === "Maya Ortiz" && g.status === "listed" && g.can_email)).toBe(true);
    expect((await q("SELECT 1 FROM involvements WHERE event_id = $1 AND kind = 'hosted'", [ORRERY_DINNER])).length).toBe(1);
  });
});

describe("a rep reads the lists through forRep", () => {
  it("no key with cents, no tokens for guests that are not theirs, and the owner words stay", async () => {
    const h = await hosted(GOLDEN_GATE, "Priya Nair");
    expect(JSON.stringify(h)).not.toMatch(/cents/);
    expect(h.can_write).toBe(false);
    expect(h.guests.every((g: any) => !("rsvp_token" in g))).toBe(true);
    expect(h.guests.every((g: any) => typeof g.owner === "string" && g.owner.length > 0)).toBe(true);
    // A rep who is not on the event's list sees the link only for a guest they own.
    const [mine] = await q<{ id: string }>("SELECT id FROM event_guests WHERE event_id = $1 AND status = 'listed' ORDER BY id LIMIT 1", [GOLDEN_GATE]);
    await q("UPDATE event_guests SET owner = 'Priya Nair' WHERE id = $1", [mine.id]);
    const own = await hosted(GOLDEN_GATE, "Priya Nair");
    expect(own.guests.filter((g: any) => "rsvp_token" in g).map((g: any) => g.id)).toEqual([mine.id]);
    const lead = await hosted(GOLDEN_GATE, CAMILLE);
    expect(lead.guests.every((g: any) => typeof g.rsvp_token === "string")).toBe(true);
  });
});
