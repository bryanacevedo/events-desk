/* After the event (docs/HOSTED.md 12, 21.15): attended and no-show are two groups, each guest has their owner, the host's notes reach the owners, and a co-hosted event carries a cost split and a lead rule. */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { recordEventCost } from "../src/server/closeout.ts";
import { checkIn, closeAttendance, updateGuest } from "../src/server/hosted.ts";
import { followUp, putCohost } from "../src/server/hosted-view.ts";
import { freshDb } from "./helpers.ts";
import { AFTER, BEFORE, depsAt, guest, hostedDinner, ON_THE_DAY, yes } from "./hosted-helpers.ts";
import { CAMILLE, DAN, MAYA } from "./plan-helpers.ts";

async function closedDinner() {
  const db = await freshDb();
  const id = await hostedDinner(db, { capacity: 10 });
  const d = depsAt(BEFORE);
  const ana = await yes(db, d, id, "Ana Ruiz", { owner: MAYA, company: "Acme" });
  const ben = await yes(db, d, id, "Ben Cole", { owner: "Leo Marsh", company: "Beta", side: "partner" });
  const cara = await yes(db, d, id, "Cara Fox", { owner: MAYA, company: "Acme", side: "partner" });
  const dan = await guest(db, id, "Dan Lee", { owner: "Leo Marsh" });
  const waiter = await guest(db, id, "Wes Waits", { owner: MAYA });
  await db.query("UPDATE event_guests SET status = 'waitlist', waitlisted_at = now() WHERE id = $1", [waiter.id]);
  await checkIn(db, depsAt(ON_THE_DAY), CAMILLE, id, ana);
  await checkIn(db, depsAt(ON_THE_DAY), CAMILLE, id, cara);
  await updateGuest(db, CAMILLE, id, ana, { notes: "Wants a pilot in Q3." });
  await updateGuest(db, CAMILLE, id, ben, { notes: "Left a message." });
  return { db, id, ana, ben, cara, dan: dan.id, waiter: waiter.id };
}

describe("the two groups", () => {
  it("attended and no-show, each guest with an owner; waitlist and no-answer shown apart and followed up as neither", async () => {
    const { db, id, ana, ben, cara, dan, waiter } = await closedDinner();
    await closeAttendance(db, depsAt(AFTER), CAMILLE, id);
    const f = await followUp(db, depsAt(AFTER), id, { money: true }) as any;
    expect(f.closed).toBe(true);
    expect(f.attended.guests.map((g: any) => [g.id, g.owner]).sort()).toEqual([[ana, MAYA], [cara, MAYA]].sort());
    expect(f.no_show.guests.map((g: any) => [g.id, g.owner])).toEqual([[ben, "Leo Marsh"]]);
    expect(f.attended.count).toBe(2);
    expect(f.did_not_answer.guests.map((g: any) => g.id)).toEqual([dan]);
    expect(f.waitlist.guests.map((g: any) => g.id)).toEqual([waiter]);
    const anaOut = f.attended.guests.find((g: any) => g.id === ana);
    expect(anaOut.text).toContain("Thank you for coming");
    expect(anaOut.notes).toBe("Wants a pilot in Q3.");
    expect(f.no_show.guests[0].text).toContain("We missed you");
    expect(f.attended.guests.concat(f.no_show.guests).every((g: any) => g.text && !g.text.includes("{"))).toBe(true);
    expect(f.did_not_answer.guests[0].text).toBeNull();
  });

  it("closing writes one note row per guest with notes and tells the owner in Slack when they map to a Slack user", async () => {
    const { db, id } = await closedDinner();
    const posts: { text: string; mention?: string[] }[] = [];
    const notify = { post: async (_r: unknown, m: { text: string }, mention?: string[]) => { posts.push({ text: m.text, mention }); return "C123"; }, ops: async () => true };
    const r = await closeAttendance(db, depsAt(AFTER, { notify: notify as never, userMap: { [MAYA]: "U_MAYA" } }), CAMILLE, id);
    expect(r.notes_logged).toBe(2);
    expect((await db.query<{ detail: string }>("SELECT detail FROM guest_log WHERE event_id = $1 AND kind = 'note' AND detail LIKE 'Notes for%' ORDER BY detail", [id])).map((x) => x.detail)).toEqual(["Notes for Leo Marsh: Left a message.", "Notes for Maya Okafor: Wants a pilot in Q3."]);
    expect(r.owners_told).toEqual([MAYA]);
    expect(posts.filter((p) => p.mention?.includes("U_MAYA"))).toHaveLength(1);
    expect(posts.find((p) => p.mention?.includes("U_MAYA"))!.text).toContain("Ana Ruiz");
  });

  it("the owner's own list across events shows status, notes and the group", async () => {
    const { db, id } = await closedDinner();
    await closeAttendance(db, depsAt(AFTER), CAMILLE, id);
    const app = createApp(db, { demo: true });
    const r = await (await app.request("/api/hosted/mine", { headers: { "x-actor": encodeURIComponent("Leo Marsh") } })).json() as any;
    expect(r.guests.map((g: any) => [g.name, g.group, g.notes])).toEqual([["Ben Cole", "no_show", "Left a message."], ["Dan Lee", "did_not_answer", ""]]);
    expect(r.guests[0].text).toContain("We missed you");
  });
});

describe("a co-hosted event", () => {
  it("shows the whole cost with our share next to it, both gone for a rep", async () => {
    const { db, id } = await closedDinner();
    await closeAttendance(db, depsAt(AFTER), CAMILLE, id);
    await putCohost(db, CAMILLE, id, { partner: "Partner Co", our_share_percent: 40, lead_rule: "own_invites" });
    await recordEventCost(db, id, DAN, "dinners", 500_000, "Venue and food");
    const lead = await followUp(db, depsAt(AFTER), id, { money: true }) as any;
    expect(lead.cohost).toMatchObject({ partner: "Partner Co", our_share_percent: 40, cost_cents: 500_000, our_share_cents: 200_000 });
    expect(lead.cost.per_attendee_cents).toBe(250_000);
    const rep = await followUp(db, depsAt(AFTER), id, { money: false }) as any;
    expect(JSON.stringify(rep)).not.toMatch(/cents/);
    expect(rep.cohost).toMatchObject({ partner: "Partner Co", our_share_percent: 40 });
  });

  it("each lead rule says which side follows up", async () => {
    const { db, id, ana, ben, cara } = await closedDinner();
    await closeAttendance(db, depsAt(AFTER), CAMILLE, id);
    const side = async (rule: string) => {
      await putCohost(db, CAMILLE, id, { partner: "Partner Co", lead_rule: rule });
      const f = await followUp(db, depsAt(AFTER), id, { money: true }) as any;
      return Object.fromEntries([...f.attended.guests, ...f.no_show.guests].map((g: any) => [g.id, g.follows_up]));
    };
    expect(await side("own_invites")).toEqual({ [ana]: "us", [ben]: "partner", [cara]: "partner" });
    expect(await side("partner_keeps_theirs")).toEqual({ [ana]: "us", [ben]: "partner", [cara]: "partner" });
    // Ana (ours) and Cara (the partner's) are both at Acme: the side that owns the account keeps both.
    expect(await side("by_account")).toEqual({ [ana]: "us", [ben]: "partner", [cara]: "us" });
    await expect(putCohost(db, CAMILLE, id, { partner: "P", lead_rule: "nope" })).rejects.toThrow(/lead rule/);
    await expect(putCohost(db, CAMILLE, id, { partner: "P", our_share_percent: 101 })).rejects.toThrow(/0 to 100/);
  });
});

describe("a hosted event with no guests", () => {
  it("reads No guests yet, never an error", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db);
    const app = createApp(db, { demo: true });
    const r = await app.request(`/api/events/${id}/hosted`, { headers: { "x-actor": encodeURIComponent(MAYA) } });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ empty: true, empty_words: "No guests yet", guests: [], counts: { total: 0 } });
    const f = await followUp(db, depsAt(AFTER), id, { money: false }) as any;
    expect(f.attended.count).toBe(0);
  });
});
