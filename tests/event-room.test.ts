/* An event's Slack channel: everyone going is in it from the start, its topic names the event, later approvals join, and it closes
   ninety days after the event's last day. A failure in any of this never stops a card. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { roomStep } from "../src/server/event-room.ts";
import { postToEvent } from "../src/server/operating.ts";
import { ROOM_ARCHIVE_DAYS } from "../src/shared/policy.ts";
import { freshDb } from "./helpers.ts";
import { clock, deliveredInMotion, fakeNotifier, type Harness } from "./lifecycle-harness.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
const card = (text: string) => ({ text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
const seat = (h: Harness, rep: string, status = "approved") => db.query("INSERT INTO seat_requests (id, event_id, requester, team, role, goal, why_event, why_you, expected_meetings, status) VALUES ($1, $2, $3, 'Sales', 'AE', 'new_pipeline', 'w', 'w', 3, $4)", [`sr_${rep.replace(/\W/g, "")}`, h.id, rep, status]);
const invitedAt = async (rep: string) => (await db.query<{ at: string | null }>("SELECT channel_invited_at::text AS at FROM seat_requests WHERE requester = $1", [rep]))[0].at;

async function setup() {
  const h = await deliveredInMotion(db, { time: clock("2027-01-10T12:00:00Z") });
  const notify = fakeNotifier({ rooms: true });
  h.deps.notify = notify;
  h.deps.userMap = { ...h.deps.userMap, "Rep A": "UREPA", "Rep B": "UREPB" };
  h.deps.appUrl = "https://desk.example.com/";
  await db.query("UPDATE events SET starts_on = '2027-01-04', ends_on = '2027-01-06', venue = 'The Venetian, Las Vegas', catalog_id = NULL WHERE id = $1", [h.id]);
  return { h, notify };
}

describe("an event's room", () => {
  it("opens with its topic and everyone going, once; someone with no Slack user waits", async () => {
    const { h, notify } = await setup();
    await seat(h, "Rep A"); await seat(h, "No Slack"); await seat(h, "Rep B", "pending");
    expect(await postToEvent(db, h.deps, h.id, card("first"))).toBe(true);
    expect(notify.topics).toHaveLength(1);
    expect(notify.topics[0].text).toMatch(/4 Jan to 6 Jan 2027  ·  Las Vegas  ·  https:\/\/desk\.example\.com\/event\//);
    expect(notify.invited).toEqual([{ channel: `C_${h.id}`, users: ["UREPA"] }]);
    expect(await invitedAt("Rep A")).not.toBeNull();
    expect(await invitedAt("No Slack")).toBeNull();
    // The second card reuses the room: no new topic, no new invites.
    await postToEvent(db, h.deps, h.id, card("second"));
    expect(notify.topics).toHaveLength(1);
    expect(notify.invited).toHaveLength(1);
  });

  it("invites people approved after it opened, once, on the background pass", async () => {
    const { h, notify } = await setup();
    await postToEvent(db, h.deps, h.id, card("first"));
    await seat(h, "Rep B");
    expect((await roomStep(db, h.deps)).invited).toBe(1);
    expect(notify.invited.at(-1)).toEqual({ channel: `C_${h.id}`, users: ["UREPB"] });
    expect((await roomStep(db, h.deps)).invited).toBe(0);
  });

  it("a failed invite never stops the card, and the pass tries again", async () => {
    const { h, notify } = await setup();
    await seat(h, "Rep A");
    notify.inviteFails = true;
    expect(await postToEvent(db, h.deps, h.id, card("first"))).toBe(true);
    expect(notify.posts).toHaveLength(1);
    expect(await invitedAt("Rep A")).toBeNull();
    notify.inviteFails = false;
    expect((await roomStep(db, h.deps)).invited).toBe(1);
  });

  it(`closes ${ROOM_ARCHIVE_DAYS} days after the event's last day, says so first, and anything later goes to ops`, async () => {
    const { h, notify } = await setup();
    await postToEvent(db, h.deps, h.id, card("first"));
    h.time.set("2027-04-05T12:00:00Z"); // 89 days after 6 Jan
    expect((await roomStep(db, h.deps)).archived).toBe(0);
    h.time.set("2027-04-06T12:00:00Z"); // 90 days
    const before = notify.posts.length;
    expect((await roomStep(db, h.deps)).archived).toBe(1);
    expect(notify.posts.length).toBe(before + 1);
    expect(notify.posts.at(-1)!.text).toMatch(/ended 90 days ago\. This channel is closing/);
    expect(notify.archived).toEqual([`C_${h.id}`]);
    expect((await roomStep(db, h.deps)).archived).toBe(0);
    expect(await postToEvent(db, h.deps, h.id, card("late reply"))).toBe(true);
    expect(notify.opsPosts.at(-1)!.text).toMatch(/: late reply$/);
    expect(notify.posts.length).toBe(before + 1);
  });
});
