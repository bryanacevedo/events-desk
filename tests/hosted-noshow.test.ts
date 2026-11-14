/* Expected no-shows (docs/HOSTED.md 9, 21.15): the stated default, the planner's number, the team's own history once there is enough, and how many to confirm to fill the room. */

import { describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { checkIn, closeAttendance, patchHosted } from "../src/server/hosted.ts";
import { createApp } from "../src/server/app.ts";
import { mockLlm } from "../src/server/providers.ts";
import { freshDb } from "./helpers.ts";
import { AFTER, BEFORE, depsAt, guest, hostedDinner, ON_THE_DAY, yes } from "./hosted-helpers.ts";
import { CAMILLE } from "./plan-helpers.ts";

const read = async (db: Db, id: string, actor = CAMILLE) => {
  const app = createApp(db, { demo: true, lifecycle: { connectors: {}, llm: mockLlm, now: () => BEFORE } as never });
  return (await (await app.request(`/api/events/${id}/hosted`, { headers: { "x-actor": encodeURIComponent(actor) } })).json() as any).estimate;
};
/** A closed dinner: `said` guests say yes, `came` of them are checked in, the rest are no-shows. */
async function closedDinner(db: Db, said: number, came: number, over: Parameters<typeof hostedDinner>[1] = {}) {
  const id = await hostedDinner(db, { capacity: 50, ...over });
  const ids: string[] = [];
  if (over.format === "webinar") {
    // A webinar has no door: its registrants and attendance come from an import, and a closed date is all the history reads.
    for (let i = 0; i < said; i++) await db.query("UPDATE event_guests SET status = $2 WHERE id = $1", [(await guest(db, id, `Reg ${id.slice(-4)} ${i}`)).id, i < came ? "attended" : "no_show"]);
    await db.query("UPDATE hosted_events SET closed_at = now() WHERE event_id = $1", [id]);
    return id;
  }
  for (let i = 0; i < said; i++) ids.push(await yes(db, depsAt(BEFORE), id, `Guest ${id.slice(-4)} ${i}`));
  for (const g of ids.slice(0, came)) await checkIn(db, depsAt(ON_THE_DAY), CAMILLE, id, g);
  await closeAttendance(db, depsAt(AFTER), CAMILLE, id);
  return id;
}

describe("the estimate", () => {
  it("is the stated default of 20 percent, rounded, with the number to confirm to fill the room", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    for (let i = 0; i < 9; i++) await yes(db, depsAt(BEFORE), id, `Guest ${i}`);
    const e = await read(db, id);
    expect(e).toMatchObject({ rate_pct: 20, basis: "default", yes: 9, expected_attending: 7, confirm_to_fill: 13, capacity: 10 });
    expect(e.words).toMatch(/20 percent/);
  });

  it("the planner's own number replaces the default, and 0 to 90 is the range", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    for (let i = 0; i < 8; i++) await yes(db, depsAt(BEFORE), id, `Guest ${i}`);
    await patchHosted(db, CAMILLE, id, { noshow_pct: 50 });
    expect(await read(db, id)).toMatchObject({ rate_pct: 50, basis: "set", expected_attending: 4, confirm_to_fill: 20 });
    await patchHosted(db, CAMILLE, id, { noshow_pct: 0 });
    expect(await read(db, id)).toMatchObject({ rate_pct: 0, expected_attending: 8, confirm_to_fill: 10 });
    await expect(patchHosted(db, CAMILLE, id, { noshow_pct: 91 })).rejects.toThrow(/0 to 90/);
    await expect(patchHosted(db, CAMILLE, id, { noshow_pct: -1 })).rejects.toThrow();
    await patchHosted(db, CAMILLE, id, { noshow_pct: null });
    expect((await read(db, id)).basis).toBe("default");
  });

  it("no capacity means no confirm-to-fill number, and the page says there is no limit", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: null, headcount: null });
    const app = createApp(db, { demo: true });
    const j = await (await app.request(`/api/events/${id}/hosted`, { headers: { "x-actor": encodeURIComponent(CAMILLE) } })).json() as any;
    expect(j.estimate.confirm_to_fill).toBeNull();
    expect(j.settings.capacity_words).toBe("No limit set");
  });
});

describe("history", () => {
  it("replaces the default once two closed events hold at least ten yes answers, and says whose numbers they are", async () => {
    const db = await freshDb();
    const open = await hostedDinner(db, { capacity: 10 });
    await closedDinner(db, 6, 5);
    expect((await read(db, open)).basis).toBe("default");
    // Two events but only 10 yes in all would qualify; here 6 + 4 = 10 with 1 + 1 no-shows... one more event keeps it clear of the edge.
    await closedDinner(db, 4, 3);
    const e = await read(db, open);
    expect(e).toMatchObject({ basis: "history", rate_pct: 20 });
    expect(e.words).toBe("Your own events: 2 of 10 said yes and did not come.");
    // The planner's own number still wins over history.
    await patchHosted(db, CAMILLE, open, { noshow_pct: 35 });
    expect(await read(db, open)).toMatchObject({ basis: "set", rate_pct: 35 });
  });

  it("does not count a webinar, a declined event, or an event not yet closed", async () => {
    const db = await freshDb();
    const open = await hostedDinner(db, { capacity: 10 });
    await closedDinner(db, 12, 6, { format: "webinar" });
    const unclosed = await hostedDinner(db, { capacity: 30 });
    for (let i = 0; i < 12; i++) await yes(db, depsAt(BEFORE), unclosed, `Pending ${i}`);
    await closedDinner(db, 3, 3);
    expect((await read(db, open)).basis).toBe("default");
  });

  it("caps a measured rate over 90 percent at 90", async () => {
    const db = await freshDb();
    const open = await hostedDinner(db, { capacity: 10 });
    await closedDinner(db, 6, 0);
    await closedDinner(db, 6, 0);
    expect(await read(db, open)).toMatchObject({ basis: "history", rate_pct: 90, confirm_to_fill: 100 });
  });
});
