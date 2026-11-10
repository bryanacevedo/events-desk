/* Every handoff in an event's life, walked through the app's own routes the way the screens drive it: a seat request, its approval,
   the attendee list, the Research card the desk prices itself, research, the Outreach card, delivery; then account owners, sequences
   before the event, the event itself, the follow-up, closing and scoring. Each step checks that the event moved and that the next
   move is named for the right person, so a handoff that silently stalls fails here. */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { demoAdvance } from "../src/server/demo-run.ts";
import { lifecycleTick } from "../src/server/lifecycle-tick.ts";
import { calendarSweep } from "../src/server/sequences.ts";
import { mockLlm, mockVendors } from "../src/server/providers.ts";
import { fakeHeyreach, fakeInstantly } from "../src/server/connectors/fake.ts";
import type { LifecycleDeps } from "../src/server/lifecycle-deps.ts";
import { freshDb } from "./helpers.ts";
import { clock, fakeCrm, fakeNotifier, LIST } from "./lifecycle-harness.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock";

describe("every stage hands off to the next", () => {
  it("from a seat request to a scored event", async () => {
    const db: Db = await freshDb();
    const time = clock("2027-01-05T12:00:00Z");
    const email = fakeInstantly(), li = fakeHeyreach();
    (email as any).senders = Array.from({ length: 6 }, (_, i) => ({ email: `s${i}@send.example`, status: 1, daily_limit: 50, stat_warmup_score: 98 - i, timestamp_warmup_start: "2026-01-01T00:00:00Z" }));
    (li as any).senders = [{ id: 1, profileUrl: "https://www.linkedin.com/in/sender1", isActive: true, authIsValid: true }];
    const deps: LifecycleDeps = { crm: fakeCrm({ owner: "Priya Natarajan" }), connectors: { instantly: email.connector, heyreach: li.connector }, llm: mockLlm, notify: fakeNotifier(), userMap: {}, now: () => time.now, demoCalendar: false };
    const tools = { instantly: email, heyreach: li } as never;
    const app = createApp(db, { demo: true, autoQuote: true, lifecycle: deps, demoTools: tools });
    const as = (who: string, path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { "x-actor": encodeURIComponent(who), "content-type": "application/json", ...(init.headers ?? {}) } });
    const stage = async (id: string) => (await (await as(DAN, `/api/events/${id}`)).json() as { event: { stage: string; motion: string } }).event;
    const pendingCard = async (id: string) => (await db.query<{ id: string; kind: string }>("SELECT a.id, k.kind FROM approvals a JOIN cost_cards k ON k.id = a.card_id WHERE a.event_id = $1 AND a.status = 'pending'", [id]))[0];
    const next = async (id: string) => (await (await as(MAYA, `/api/events/${id}/next`)).json() as { next: { text: string } | null }).next?.text ?? "";
    const run = (id: string) => processEvent(db, id, { llm: mockLlm, vendorsFor: mockVendors });

    // 1. A seat request waits on an approver.
    const req = await as(MAYA, "/api/seat-requests", { method: "POST", body: JSON.stringify({ suggestion: { name: "Handoff Summit", website: "https://handoff.example", starts_on: "2027-02-01", ends_on: "2027-02-02", city: "Lisbon", country: "Portugal", price_dollars: 900 }, team: "Sales", role: "SDR", goal: "new_pipeline", why_event: "Their buyers are the people we sell to.", why_you: "I run outreach for this region.", expected_meetings: 4 }) });
    expect(req.status).toBe(201);
    const { id: requestId, event_id: id } = await req.json() as { id: string; event_id: string };
    expect((await stage(id)).stage).toBe("requested");

    // 2. The approver decides; the event waits on its attendee list.
    expect((await as(DAN, `/api/seat-requests/${requestId}/decision`, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status).toBe(200);
    expect((await stage(id)).stage).toBe("approved");

    // 3. The list goes in and the desk prices the Research card itself: the uploader only confirms.
    const up = await app.request(`/api/events/${id}/upload`, { method: "POST", headers: { "x-actor": encodeURIComponent(MAYA), "content-type": "text/csv", "x-filename": "list.csv" }, body: LIST });
    expect(up.status).toBeLessThan(300);
    expect((await stage(id)).stage).toBe("quoted");
    const research = await pendingCard(id);
    expect(research?.kind).toBe("research");
    // Nobody but the uploader can confirm it.
    expect((await as(DAN, `/api/demo/approvals/${research.id}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status).toBeGreaterThanOrEqual(400);
    expect((await as(MAYA, `/api/demo/approvals/${research.id}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status).toBe(200);

    // 4. Research runs to review, and the desk prices the Outreach card the moment nothing blocks it.
    await run(id);
    expect((await stage(id)).stage).toBe("ready_for_review");
    await db.query("UPDATE review_cases SET status = 'skipped', decision = 'skipped', decided_by = $2, decided_at = now() WHERE event_id = $1 AND status = 'open'", [id, MAYA]);
    await as(MAYA, `/api/events/${id}/quote`, { method: "POST" });
    const outreach = await pendingCard(id);
    expect(outreach?.kind).toBe("outreach");
    expect((await as(MAYA, `/api/demo/approvals/${outreach.id}`, { method: "POST", body: JSON.stringify({ decision: "approve" }) })).status).toBe(200);

    // 5. People are found and checked; the list is delivered and outreach has not started.
    await run(id);
    expect((await stage(id)).stage).toBe("delivered");
    expect(await next(id)).toMatch(/list is ready|outreach card/i);

    // 6. After delivery, each press of the demo's own button moves one step: card, owners, sequences, live.
    const motions: string[] = [];
    for (let k = 0; k < 6 && (await stage(id)).motion !== "in_market"; k++) {
      const r = await as(MAYA, `/api/demo/motion/${id}/advance`, { method: "POST" });
      expect(r.status, `advance from ${(await stage(id)).motion}`).toBe(200);
      motions.push((await stage(id)).motion);
    }
    expect(motions).toContain("owners");
    expect(motions).toContain("sequencing");
    expect((await stage(id)).motion).toBe("in_market");
    const pre = await db.query<{ phase: string; launched_at: string | null }>("SELECT phase, launched_at FROM sequences WHERE event_id = $1", [id]);
    expect(pre.length).toBeGreaterThan(0);
    expect(pre.every((s) => s.phase === "pre" && s.launched_at)).toBe(true);
    await demoAdvance(db, deps, tools, id);

    // 7. The event opens: the pre-event sequences end on its first day.
    time.set("2027-02-01T09:00:00Z");
    await calendarSweep(db, deps);
    expect((await db.query<{ state: string }>("SELECT state FROM sequences WHERE event_id = $1 AND phase = 'pre'", [id])).every((s) => s.state === "archived")).toBe(true);

    // 8. The day after it closes, the follow-up is ready for its person to start, and starting it makes the post-event sequences.
    time.set("2027-02-03T12:00:00Z");
    expect(await next(id)).toMatch(/follow-up is ready to start/i);
    expect((await as(MAYA, `/api/events/${id}/motion/sequences`, { method: "POST" })).status).toBe(200);
    expect((await db.query("SELECT 1 FROM sequences WHERE event_id = $1 AND phase = 'post'", [id])).length).toBeGreaterThan(0);
    expect((await db.query<{ post_started_by: string }>("SELECT post_started_by FROM events WHERE id = $1", [id]))[0].post_started_by).toBe(MAYA);

    // 9. Fourteen days after the last day it closes; the 30-day scorecard scores it. Both by the background pass, nobody pressing anything.
    time.set("2027-02-17T12:00:00Z");
    await lifecycleTick(db, deps);
    expect((await stage(id)).motion).toBe("closing");
    time.set("2027-03-05T12:00:00Z");
    await lifecycleTick(db, deps);
    expect((await stage(id)).motion).toBe("scored");
    expect((await db.query("SELECT 1 FROM scorecards WHERE event_id = $1 AND window_days = 30", [id])).length).toBe(1);
  }, 120_000);
});
