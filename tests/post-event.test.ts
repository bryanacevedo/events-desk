/* The post-event wave (docs/LIFECYCLE.md §5b): when it can start, who goes in and in which group, the card and its one reminder, how long it runs, and the fixes the spec review asked for. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { bookMeeting } from "../src/server/meetings.ts";
import { captureOnsite, drainNotifications } from "../src/server/operating.ts";
import { eventWindow, nextStep, postEventStep, postGroups, windowFor } from "../src/server/post-event.ts";
import { approveTemplate, calendarSweep, createDrafts, drainOps } from "../src/server/sequences.ts";
import { ingestEvents, processInbound } from "../src/server/replies.ts";
import { freshDb } from "./helpers.ts";
import { clock, deliveredInMotion, enrollmentStates, fakeCrm, MAYA, personAt, type Harness } from "./lifecycle-harness.ts";
import { launched, sequenced } from "./post-event-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

/** A three-day event, 1 to 3 February 2027, with the harness clock where each test wants it. */
async function threeDay(at: string, opts: Parameters<typeof deliveredInMotion>[1] = {}) {
  const t = clock(at);
  const h = await deliveredInMotion(db, { ...opts, time: t });
  await db.query("UPDATE events SET starts_on = '2027-02-01', ends_on = '2027-02-03' WHERE id = $1", [h.id]);
  h.deps.userMap = { ...h.deps.userMap, [MAYA]: "UMAYA", "Rep A": "UREPA" };
  return h;
}
const fresh = (h: Harness) => db.query("UPDATE verification_cache SET checked_at = $1", [h.time.now.toISOString()]);

describe("when the follow-up can start", () => {
  it("reads the event's own days, last day included", () => {
    expect(eventWindow("2027-01-31", "2027-02-01", "2027-02-03")).toBe("before");
    expect(eventWindow("2027-02-03", "2027-02-01", "2027-02-03")).toBe("during");
    expect(eventWindow("2027-02-04", "2027-02-01", "2027-02-03")).toBe("after");
    expect(eventWindow("2027-02-13", "2027-02-01", "2027-02-03")).toBe("after");
    expect(eventWindow("2027-02-14", "2027-02-01", "2027-02-03")).toBe("closed");
  });

  it("only the demo keeps a past event in its window, so its visitors can press through past conferences", () => {
    const live = { connectors: {}, llm: {} } as never, demo = { connectors: {}, llm: {}, demoCalendar: true } as never;
    expect(windowFor(live, "2026-11-09", "2026-10-18", "2026-10-21")).toBe("closed");
    expect(windowFor(demo, "2026-11-09", "2026-10-18", "2026-10-21")).toBe("after");
    expect(windowFor(demo, "2026-10-19", "2026-10-18", "2026-10-21")).toBe("during");
  });

  it("refuses while a multi-day event is on, and after the window closes", async () => {
    const h = await threeDay("2027-02-02T12:00:00Z");
    await expect(createDrafts(db, h.deps, h.id, MAYA)).rejects.toThrow(/is on/);
    h.time.set("2027-02-14T12:00:00Z");
    await expect(createDrafts(db, h.deps, h.id, MAYA)).rejects.toThrow(/window has closed/);
  });
});

describe("who goes in, by what happened at the event", () => {
  it("puts each person in the first group that fits, and sequences only scanned, reached and not reached", async () => {
    const h = await threeDay("2027-01-20T12:00:00Z");
    const { e } = await launched(db, h);
    const [ana, ben, cleo, dan] = await Promise.all(["Ana Ruiz", "Ben Ode", "Cleo Park", "Dan Ito"].map((n) => personAt(db, h.id, n)));
    // Ana gets the pre-event email and does not answer. Ben answers. Cleo is scanned at the booth. Dan is met by a rep.
    await db.query("INSERT INTO touches (id, domain, contact_id, event_id, kind, channel, at, source, dedup_key) VALUES ('t1', 'tallgrasssoftware.example', $1, $2, 'send', 'email', $3, 'test', 't1')", [ana.id, h.id, h.time.now.toISOString()]);
    await ingestEvents(db, h.deps, h.email.connector, [{ provider_message_id: "r1", signal: "reply", channel: "email", sequence_external_id: e.external_id, email: ben.email, linkedin: null, external_contact_id: null, body: "Tell me more after the show", at: h.time.now.toISOString() }]);
    await processInbound(db, h.deps);
    h.time.set("2027-02-02T12:00:00Z");
    await calendarSweep(db, h.deps);
    await captureOnsite(db, h.deps, h.id, "Rep A", { email: cleo.email, source: "badge_scan" });
    await captureOnsite(db, h.deps, h.id, "Rep A", { email: dan.email, met: true });
    const groups = await postGroups(db.query, h.id);
    expect(Object.fromEntries([ana, ben, cleo, dan].map((p) => [p.email.split("@")[0], groups.get(p.id)]))).toEqual({ ana: "reached", ben: "replied", cleo: "scanned", dan: "met" });
  });

  it("a walk-up scanned at the booth, never on the list, is in the scanned group", async () => {
    const h = await threeDay("2027-02-02T12:00:00Z");
    const { contact_id } = await captureOnsite(db, h.deps, h.id, "Rep A", { email: "zoe@brightwatersoftware.example", full_name: "Zoe Lin", company: "Brightwater Software", linkedin: "https://www.linkedin.com/in/zoe-lin", source: "badge_scan" });
    expect((await postGroups(db.query, h.id)).get(contact_id)).toBe("scanned");
  });

  it("starts the follow-up the day after: groups get their own sequences, and nobody a rep has goes in", async () => {
    const h = await threeDay("2027-02-02T12:00:00Z");
    const [ana, cleo, dan] = await Promise.all(["Ana Ruiz", "Cleo Park", "Dan Ito"].map((n) => personAt(db, h.id, n)));
    await captureOnsite(db, h.deps, h.id, "Rep A", { email: cleo.email, source: "badge_scan" });
    await captureOnsite(db, h.deps, h.id, "Rep A", { email: dan.email, met: true });
    await approveTemplate(db, "GTM", { name: "Scanned", channel: "email", phase: "post", audience: "scanned", steps: [{ day: 0, subject: "Thanks for stopping by", body: "Hi {{first_name}}" }], external_id: h.email.newSeq("tpl_s") });
    h.time.set("2027-02-04T12:00:00Z"); await fresh(h);
    await createDrafts(db, h.deps, h.id, MAYA);
    const rows = await sequenced(db, h.id, "email");
    expect(rows.find((r) => r.contact_id === cleo.id)).toMatchObject({ priority: "scanned", template: "Scanned" });
    expect(rows.find((r) => r.contact_id === ana.id)).toMatchObject({ priority: "not_reached", template: "Post email" });
    expect(rows.some((r) => r.contact_id === dan.id)).toBe(false);
    expect((await db.query<{ post_started_by: string }>("SELECT post_started_by FROM events WHERE id = $1", [h.id]))[0].post_started_by).toBe(MAYA);
  });
});

describe("the card and its reminder", () => {
  it("posts once the day after the last day, to the uploader in the event's channel, then reminds once after a business day", async () => {
    const h = await threeDay("2027-02-03T12:00:00Z");
    await postEventStep(db, h.deps); await drainNotifications(db, h.deps);
    expect(h.notify.posts.filter((c) => /Follow up on/.test(c.text + JSON.stringify(c.blocks)))).toHaveLength(0);
    h.time.set("2027-02-04T09:00:00Z"); await fresh(h);
    await postEventStep(db, h.deps); await postEventStep(db, h.deps); await drainNotifications(db, h.deps);
    const card = h.notify.sent.filter((x) => x.to === "UMAYA" && /is over/.test(x.card.text));
    expect(card).toHaveLength(1);
    expect(JSON.stringify(card[0].card.blocks)).toContain("post_event_start");
    // People, not people times channels.
    expect(card[0].card.text).toMatch(/4 people are ready/);
    h.time.set("2027-02-05T10:00:00Z");
    await postEventStep(db, h.deps); await postEventStep(db, h.deps); await drainNotifications(db, h.deps);
    expect(h.notify.sent.filter((x) => x.to === "UMAYA" && /has not started/.test(x.card.text))).toHaveLength(1);
  });

  it("says nothing once someone has started it", async () => {
    const h = await threeDay("2027-02-04T09:00:00Z"); await fresh(h);
    await createDrafts(db, h.deps, h.id, MAYA);
    await postEventStep(db, h.deps); await drainNotifications(db, h.deps);
    expect(h.notify.sent.filter((x) => /is over|has not started/.test(x.card.text))).toHaveLength(0);
  });
});

describe("how long it runs", () => {
  it("a post-event template finishes within ten days", async () => {
    await expect(approveTemplate(db, "GTM", { name: "Too long", channel: "email", phase: "post", steps: [{ day: 0, subject: "x", body: "Hi {{first_name}}" }, { day: 12, body: "Again {{first_name}}" }] })).rejects.toThrow(/10 days/);
  });

  it("the event closing does not cut the wave short: it ends 24 days after the last day", async () => {
    const h = await threeDay("2027-02-04T09:00:00Z"); await fresh(h);
    await createDrafts(db, h.deps, h.id, MAYA);
    await db.query("UPDATE events SET motion = 'closing' WHERE id = $1", [h.id]);
    h.time.set("2027-02-20T12:00:00Z"); await calendarSweep(db, h.deps);
    expect(await db.query("SELECT 1 FROM sequences WHERE event_id = $1 AND phase = 'post' AND state = 'archived'", [h.id])).toHaveLength(0);
    h.time.set("2027-02-27T12:00:00Z"); await calendarSweep(db, h.deps);
    // Drafts that never went out end too.
    expect(await db.query("SELECT 1 FROM sequences WHERE event_id = $1 AND phase = 'post' AND state <> 'archived'", [h.id])).toHaveLength(0);
  });
});

describe("found by the spec review", () => {
  it("the event starting does not relabel someone paused for a meeting, so they cannot come back into the follow-up", async () => {
    const h = await threeDay("2027-01-20T12:00:00Z");
    await launched(db, h);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await bookMeeting(db, h.deps, { contact_id: ana.id, scheduled_at: "2027-02-02T15:00:00Z", source: "manual", rep: "Rep A" }, "Rep A");
    h.time.set("2027-02-01T12:00:00Z");
    await calendarSweep(db, h.deps); await drainOps(db, h.deps);
    expect((await enrollmentStates(db, ana.id)).every((x) => x.cause === "meeting")).toBe(true);
  });

  it("a hot conversation at the booth goes to its rep the same day, with a CRM task, and never into a sequence", async () => {
    const h = await threeDay("2027-02-02T12:00:00Z", { crm: fakeCrm({ write: async () => {} }) });
    const cleo = await personAt(db, h.id, "Cleo Park");
    await captureOnsite(db, h.deps, h.id, "Rep A", { email: cleo.email, source: "badge_scan", temperature: "hot", note: "Wants pricing for 40 seats" });
    await drainNotifications(db, h.deps);
    // Named from the list, not by an email address.
    expect(h.notify.sent.filter((x) => x.to === "UREPA" && /Hot from the booth: Cleo Park/.test(x.card.text))).toHaveLength(1);
    expect(await db.query("SELECT 1 FROM crm_outbox WHERE kind = 'task' AND desk_key LIKE 'hot:%'")).toHaveLength(1);
    expect((await postGroups(db.query, h.id)).get(cleo.id)).toBe("hot");
  });
});

describe("what needs someone now, on the event page", () => {
  it("names one thing, in order: a waiting reply before the follow-up, and the follow-up with its button", async () => {
    const h = await threeDay("2027-02-04T09:00:00Z");
    await db.query("UPDATE events SET motion = 'in_market' WHERE id = $1", [h.id]);
    await db.query("UPDATE review_cases SET status = 'done' WHERE event_id = $1", [h.id]).catch(() => {});
    expect(await nextStep(db, h.deps, h.id)).toMatchObject({ tab: "outreach", action: "post_event_start" });
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await db.query("INSERT INTO inbound_messages (id, connector, provider_message_id, event_id, contact_id, channel, signal, received_at, status, respond_by) VALUES ('im1', 'instantly', 'p1', $1, $2, 'email', 'reply', $3, 'done', $3)", [h.id, ana.id, h.time.now.toISOString()]);
    expect(await nextStep(db, h.deps, h.id)).toEqual({ text: "1 reply is waiting on a rep", tab: "outreach" });
  });
});


describe("the people list tells attendees from prospects", () => {
  it("filters by where a person came from, and says so on each row", async () => {
    const h = await deliveredInMotion(db);
    const ana = await personAt(db, h.id, "Ana Ruiz");
    await db.query("UPDATE contacts SET source = 'prospect' WHERE id = $1", [ana.id]);
    const { createApp } = await import("../src/server/app.ts");
    const http = createApp(db, { demo: true });
    const read = async (source: string) => (await (await http.request(`/api/events/${h.id}/people?source=${source}`)).json()) as { total: number; rows: { id: string; source: string }[] };
    const prospects = await read("prospect"), attendees = await read("attendee"), everyone = await read("");
    expect(prospects.rows.map((r) => r.id)).toEqual([ana.id]);
    expect(attendees.rows.every((r) => r.source === "attendee")).toBe(true);
    expect(everyone.total).toBe(prospects.total + attendees.total);
  });
});
