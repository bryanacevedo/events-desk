/* The live-mode plan card (docs/EVENT-PLAN.md 6.1): asking for approval posts a card with Approve and Decline, the decision is taken in Slack by a
   mapped approver who is not the maker, and a decline asks for a reason. The demo keeps its own decision route. Slack is a fake that records calls. */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import type { SlackConfig } from "../src/server/slack.ts";
import { freshDb } from "./helpers.ts";
import { as, CAMILLE, DAN, draftPlan, one } from "./plan-helpers.ts";

const NOW = 2_000_000_000;
const USERS = { [CAMILLE]: "U_CAM", [DAN]: "U_DAN" };
let db: Db, calls: { url: string; body: any }[], app: ReturnType<typeof createApp>, id: string;

const cfg = (): SlackConfig => ({
  signingSecret: "secret", botToken: "t", channel: "C1", seatsChannel: "CAPPROVALS", approvers: ["U_DAN", "U_CAM"], userMap: USERS, now: () => NOW,
  fetch: (async (u: string, i: RequestInit) => { calls.push({ url: String(u), body: JSON.parse(i.body as string) }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); }) as typeof fetch,
});
const post = (body: string) => app.request("/slack/interactions", { method: "POST", body, headers: { "x-slack-request-timestamp": String(NOW), "x-slack-signature": `v0=${createHmac("sha256", "secret").update(`v0:${NOW}:${body}`).digest("hex")}` } });
const interact = (payload: unknown) => post(new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
const click = (action_id: string, user: string) => interact({ type: "block_actions", user: { id: user }, trigger_id: "T", response_url: "https://hooks.example/r", actions: [{ action_id, value: id }] });
const reasonView = (reason: string) => ({ callback_id: "plan_decline_reason", private_metadata: id, state: { values: { reason: { value: { value: reason } } } } });
const row = () => one<{ stage: string; plan_approved_by: string | null; decline_reason: string | null }>(db, "SELECT stage, plan_approved_by, decline_reason FROM events WHERE id = $1", [id]);

beforeEach(async () => {
  calls = [];
  db = await freshDb();
  app = createApp(db, { demo: false, slack: cfg() });
  id = await draftPlan(db, { id: "evt_plan_live", approvers: ["U_DAN", "U_CAM"] });
});

describe("the plan card in live mode", () => {
  it("posts one card with Approve and Decline when the plan is asked for", async () => {
    const r = await app.request(`/api/events/${id}/plan/submit`, { method: "POST", headers: as(CAMILLE) });
    expect(r.status).toBe(200);
    const sent = calls.filter((c) => c.url.endsWith("chat.postMessage"));
    expect(sent).toHaveLength(1);
    expect(sent[0].body.channel).toBe("CAPPROVALS");
    const buttons = sent[0].body.blocks.find((b: any) => b.type === "actions").elements;
    expect(buttons.map((b: any) => [b.action_id, b.value])).toEqual([["plan_approve", id], ["plan_decline", id]]);
    expect(JSON.stringify(sent[0].body.blocks)).toContain(CAMILLE);
  });

  it("does not post the card in demo mode, and the demo keeps its decision route", async () => {
    const demo = createApp(db, { demo: true, slack: cfg() });
    await demo.request(`/api/events/${id}/plan/submit`, { method: "POST", headers: as(CAMILLE) });
    expect(calls.filter((c) => c.url.endsWith("chat.postMessage"))).toHaveLength(0);
    expect((await demo.request(`/api/events/${id}/plan/decision`, { method: "POST", headers: as("U_DAN"), body: JSON.stringify({ decision: "approve" }) })).status).toBe(200);
    // Live mode has no such route.
    expect((await app.request(`/api/events/${id}/plan/decision`, { method: "POST", headers: as(DAN), body: JSON.stringify({ decision: "approve" }) })).status).toBe(404);
  });

  it("the maker cannot approve their own plan from Slack, even as an approver", async () => {
    await app.request(`/api/events/${id}/plan/submit`, { method: "POST", headers: as(CAMILLE) });
    await click("plan_approve", "U_CAM");
    expect((await row()).plan_approved_by).toBeNull();
    expect(calls.at(-1)!.body.text).toMatch(/own plan/);
  });

  it("an approver who did not write it approves from the card, and the card is replaced", async () => {
    await app.request(`/api/events/${id}/plan/submit`, { method: "POST", headers: as(CAMILLE) });
    await click("plan_approve", "U_DAN");
    expect(await row()).toMatchObject({ stage: "approved", plan_approved_by: "U_DAN" });
    expect(calls.at(-1)!.body).toMatchObject({ replace_original: true });
    expect(calls.at(-1)!.body.text).toContain("U_DAN");
  });

  it("someone who is not an approver is refused and nothing changes", async () => {
    await app.request(`/api/events/${id}/plan/submit`, { method: "POST", headers: as(CAMILLE) });
    await click("plan_approve", "U_STRANGER");
    expect((await row()).plan_approved_by).toBeNull();
    expect(calls.at(-1)!.body.text).toMatch(/not one of this event's approvers/);
  });

  it("Decline opens a modal, a blank reason is refused, and a reason declines the plan", async () => {
    await app.request(`/api/events/${id}/plan/submit`, { method: "POST", headers: as(CAMILLE) });
    await click("plan_decline", "U_DAN");
    expect(calls.at(-1)!.url).toContain("views.open");
    const blank = await (await interact({ type: "view_submission", user: { id: "U_DAN" }, view: reasonView(" ") })).json() as any;
    expect(blank.response_action).toBe("errors");
    expect(blank.errors.reason).toMatch(/Say why/);
    expect((await row()).stage).toBe("requested");
    await interact({ type: "view_submission", user: { id: "U_DAN" }, view: reasonView("Budget is spoken for") });
    expect(await row()).toMatchObject({ stage: "declined", decline_reason: "Budget is spoken for" });
  });

  it("the maker cannot decline their own plan either", async () => {
    await app.request(`/api/events/${id}/plan/submit`, { method: "POST", headers: as(CAMILLE) });
    const r = await (await interact({ type: "view_submission", user: { id: "U_CAM" }, view: reasonView("No") })).json() as any;
    expect(r.response_action).toBe("errors");
    expect((await row()).stage).toBe("requested");
  });

  it("refuses an unsigned click", async () => {
    const body = new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", user: { id: "U_DAN" }, actions: [{ action_id: "plan_approve", value: id }] }) }).toString();
    const r = await app.request("/slack/interactions", { method: "POST", body, headers: { "x-slack-request-timestamp": String(NOW), "x-slack-signature": "v0=nope" } });
    expect(r.status).toBe(401);
  });
});
