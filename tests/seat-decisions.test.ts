/* The in-app seat decision screen's routes (decision 103): managers decide, others are refused, a decision is never made twice,
   and the audit line is the one Slack's path writes, because both call decideSeat. */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock", PRIYA = "Priya Natarajan";

async function setup(opts: { slack?: boolean } = {}) {
  const db = await freshDb();
  const app = createApp(db, { demo: false, slack: opts.slack ? ({ signingSecret: "s", botToken: "t", channel: "C1", approvers: [DAN], userMap: {}, fetch: (async () => new Response("{}")) as never } as never) : undefined });
  const as = (who: string, path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { "x-actor": encodeURIComponent(who), "content-type": "application/json", ...(init.headers ?? {}) } });
  const ask = async (who = MAYA) => {
    const r = await as(who, "/api/seat-requests", { method: "POST", body: JSON.stringify({ suggestion: { name: "Decide Summit", website: "https://decide.example", starts_on: "2027-02-01", ends_on: "2027-02-02", city: "Lisbon", country: "Portugal", price_dollars: 900 }, team: "Sales", role: "SDR", goal: "new_pipeline", why_event: "Their buyers are who we sell to.", why_you: "I run outreach for this region.", expected_meetings: 4 }) });
    expect(r.status).toBe(201);
    return await r.json() as { id: string; event_id: string };
  };
  return { db, as, ask };
}
const decide = (as: Awaited<ReturnType<typeof setup>>["as"], who: string, id: string, body: object) => as(who, `/api/seat-decisions/${id}`, { method: "POST", body: JSON.stringify(body) });

describe("in-app seat decisions", () => {
  it("lists what a manager may decide, with the facts, and refuses everyone else", async () => {
    const { as, ask } = await setup();
    const { id } = await ask();
    const list = await as(DAN, "/api/seat-decisions");
    expect(list.status).toBe(200);
    const body = await list.json() as { requests: Array<{ id: string; requester: string; name: string; why_event: string; seat_price_cents: number }>; slack: boolean };
    expect(body.slack).toBe(false);
    expect(body.requests.map((r) => r.id)).toEqual([id]);
    expect(body.requests[0]).toMatchObject({ requester: MAYA, name: "Decide Summit", seat_price_cents: 90000 });
    expect((await as(MAYA, "/api/seat-decisions")).status).toBe(403);
    expect((await as("", "/api/seat-decisions")).status).toBe(403);
    expect((await decide(as, MAYA, id, { decision: "approve" })).status).toBe(403);
  });

  it("does not offer a manager their own request, and refuses approving it", async () => {
    const { as, ask } = await setup();
    const { id } = await ask(DAN);
    expect(((await (await as(DAN, "/api/seat-decisions")).json()) as { requests: unknown[] }).requests).toEqual([]);
    expect((await decide(as, DAN, id, { decision: "approve" })).status).toBe(409);
  });

  it("approves once, writes the audit line, and refuses a second decision", async () => {
    const { db, as, ask } = await setup();
    const { id, event_id } = await ask();
    const ok = await decide(as, DAN, id, { decision: "approve" });
    expect(ok.status).toBe(200);
    const [row] = await db.query<{ status: string; decided_by: string }>("SELECT status, decided_by FROM seat_requests WHERE id = $1", [id]);
    expect(row).toMatchObject({ status: "approved", decided_by: DAN });
    const log = await db.query<{ actor: string; detail: string }>("SELECT actor, detail FROM activity_log WHERE event_id = $1", [event_id]);
    expect(log.some((l) => l.actor === DAN && l.detail.includes(`Approved ${MAYA}'s seat`))).toBe(true);
    const again = await decide(as, DAN, id, { decision: "decline", reason: "changed my mind" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toMatch(/Already approved by Dan Whitlock/);
    expect((await db.query<{ status: string }>("SELECT status FROM seat_requests WHERE id = $1", [id]))[0].status).toBe("approved");
    expect(((await (await as(DAN, "/api/seat-decisions")).json()) as { requests: unknown[] }).requests).toEqual([]);
  });

  it("declines only with a reason", async () => {
    const { db, as, ask } = await setup();
    const { id } = await ask();
    expect((await decide(as, DAN, id, { decision: "decline" })).status).toBe(409);
    expect((await decide(as, DAN, id, { decision: "maybe" })).status).toBe(400);
    expect((await decide(as, DAN, id, { decision: "decline", reason: "Out of budget." })).status).toBe(200);
    expect((await db.query<{ status: string; decline_reason: string }>("SELECT status, decline_reason FROM seat_requests WHERE id = $1", [id]))[0]).toMatchObject({ status: "declined", decline_reason: "Out of budget." });
  });

  it("reports an unknown request", async () => {
    const { as } = await setup();
    expect((await decide(as, DAN, "sr_nope", { decision: "approve" })).status).toBe(404);
  });

  it("is the same decision when Slack is connected: either path works once", async () => {
    const { as, ask } = await setup({ slack: true });
    const { id } = await ask();
    expect(((await (await as(DAN, "/api/seat-decisions")).json()) as { slack: boolean }).slack).toBe(true);
    expect((await decide(as, DAN, id, { decision: "approve" })).status).toBe(200);
    expect((await decide(as, DAN, id, { decision: "approve" })).status).toBe(409);
  });
});
