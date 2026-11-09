import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { noCrm, mockLlm, mockVendors } from "../src/server/providers.ts";
import { decideSeat, parseSeatRequest, requestSeat } from "../src/server/seats.ts";
import { postApproval, postSeatRequest, type SlackConfig } from "../src/server/slack.ts";
import { deliverEvent, freshDb } from "./helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

describe("live mode never uses mock CRM data", () => {
  const LIST = "Company,Name,Email\nAcme Freight,Pat Q,pat@acmefreight.example\nBrightwater Logistics,Sam R,sam@brightwater.example\n";
  it("leaves owner, deal, activity and heat blank with the no-CRM provider", async () => {
    const id = await deliverEvent(db, LIST, { crm: noCrm });
    const rows = await db.query<Record<string, unknown>>("SELECT heat, account_owner, deal_name, deal_stage, last_activity FROM companies WHERE event_id = $1 AND in_research", [id]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toEqual({ heat: null, account_owner: null, deal_name: null, deal_stage: null, last_activity: null });
  });
  it("node.ts wires it in live mode", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/server/node.ts", "utf8")).toMatch(/live: true, crm: noCrm/);
  });
});

describe("a live seat cannot be approved by its own requester", () => {
  beforeEach(async () => {
    await db.query("INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents) VALUES ('cat_a', 'Test Summit', 'Hall', 'Lisbon', 'Portugal', '2027-03-01', '2027-03-03', 'https://example.com', 100000)");
  });
  const ask = () => requestSeat(db, "Maya Ortiz", parseSeatRequest("Maya Ortiz", { catalog_id: "cat_a", team: "Sales", role: "SDR", goal: "new_pipeline", why_event: "Their buyers are the people we sell to.", why_you: "I run outreach for this region and know the accounts.", expected_meetings: 6 }), { approvers: ["U01MAYA", "U02DAN"] });
  const userMap = { "Maya Ortiz": "U01MAYA", "Dan Whitlock": "U02DAN" };
  it("refuses Maya's own Slack ID, and accepts another approver", async () => {
    const r = await ask();
    const req = (await db.query<{ id: string }>("SELECT id FROM seat_requests WHERE event_id = $1", [r.event_id]))[0].id;
    await expect(decideSeat(db, { requestId: req, actor: "U01MAYA", decision: "approve", userMap })).rejects.toThrow(/own request/);
    expect((await decideSeat(db, { requestId: req, actor: "U02DAN", decision: "approve", userMap })).status).toBe("approved");
  });
  it("refuses it through a signed Slack click", async () => {
    const NOW = 2_000_000_000, calls: any[] = [];
    const cfg: SlackConfig = { signingSecret: "s", botToken: "t", channel: "C1", approvers: ["U01MAYA", "U02DAN"], userMap, now: () => NOW,
      fetch: (async (u: string, i: RequestInit) => { calls.push(JSON.parse(i.body as string)); return new Response(JSON.stringify({ ok: true })); }) as typeof fetch };
    const app = createApp(db, { demo: false, slack: cfg });
    const r = await ask();
    const req = (await db.query<{ id: string }>("SELECT id FROM seat_requests WHERE event_id = $1", [r.event_id]))[0].id;
    const body = new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", user: { id: "U01MAYA" }, trigger_id: "T", response_url: "https://hooks.example/r", actions: [{ action_id: "approve", value: req }] }) }).toString();
    await app.request("/slack/interactions", { method: "POST", body, headers: { "x-slack-request-timestamp": String(NOW), "x-slack-signature": `v0=${createHmac("sha256", "s").update(`v0:${NOW}:${body}`).digest("hex")}` } });
    expect((await db.query<{ status: string }>("SELECT status FROM seat_requests WHERE id = $1", [req]))[0].status).toBe("pending");
    expect(calls.at(-1).text).toMatch(/own request/);
  });
});

describe("a card Slack would not post is visible in the event's activity", () => {
  it("logs it for a seat request and for a cost card", async () => {
    await db.query("INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents) VALUES ('cat_a', 'Test Summit', 'Hall', 'Lisbon', 'Portugal', '2027-03-01', '2027-03-03', 'https://example.com', 100000)");
    const cfg: SlackConfig = { signingSecret: "s", botToken: "t", channel: "C1", approvers: ["U02DAN"], userMap: { "Maya Ortiz": "U01MAYA" },
      fetch: (async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))) as typeof fetch };
    const made = await requestSeat(db, "Maya Ortiz", parseSeatRequest("Maya Ortiz", { catalog_id: "cat_a", team: "Sales", role: "SDR", goal: "new_pipeline", why_event: "Their buyers are the people we sell to.", why_you: "I run outreach for this region and know the accounts.", expected_meetings: 6 }), { approvers: ["U02DAN"] });
    await postSeatRequest(db, cfg, made.id);
    const log = await db.query<{ detail: string }>("SELECT detail FROM activity_log WHERE event_id = $1 AND kind = 'slack'", [made.event_id]);
    expect(log).toHaveLength(1);
    expect(log[0].detail).toMatch(/did not post \(channel_not_found\)/);
    const [apr] = await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1", [made.event_id]);
    if (apr) { await postApproval(db, cfg, apr.id); expect((await db.query("SELECT 1 FROM activity_log WHERE event_id = $1 AND kind = 'slack'", [made.event_id])).length).toBe(2); }
  });
});
