/* The routes the screen, the tools and the simulator use, over HTTP. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { demoConnectors } from "../src/server/connectors/setup.ts";
import type { Db } from "../src/server/db.ts";
import { withDemoCrm } from "../src/server/demo-run.ts";
import type { LifecycleDeps } from "../src/server/lifecycle-deps.ts";
import { mockLlm } from "../src/server/providers.ts";
import { deliverEvent, freshDb } from "./helpers.ts";
import { LIST, MAYA } from "./lifecycle-harness.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

async function app(demo = true) {
  const { connectors, tools } = await demoConnectors(db);
  const lifecycle: LifecycleDeps = { connectors, llm: mockLlm };
  return { http: createApp(db, { demo, lifecycle, demoTools: demo ? tools : undefined }), tools, lifecycle };
}
const post = (h: { request: (p: string, i: RequestInit) => Response | Promise<Response> }, p: string, body?: unknown, actor = MAYA, headers: Record<string, string> = {}) => h.request(p, { method: "POST", headers: { "x-actor": encodeURIComponent(actor), "content-type": "application/json", ...headers }, body: JSON.stringify(body ?? {}) });

describe("over HTTP", () => {
  it("shows the motion, and a missing event is a 404", async () => {
    const { http } = await app();
    const id = await deliverEvent(db, LIST, {}, "E");
    const r = await (await http.request(`/api/events/${id}/motion`)).json() as { motion: string; simulated: boolean };
    expect(r).toMatchObject({ motion: "none", simulated: true });
    expect((await http.request("/api/events/nope/motion")).status).toBe(404);
  });

  it("a rule broken returns the reason, not a crash", async () => {
    const { http } = await app();
    const id = await deliverEvent(db, LIST, {}, "E");
    const r = await post(http, `/api/events/${id}/motion/start`, {}, "Someone Else");
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/uploaded/);
  });

  it("a webhook without the secret is refused, with no actor needed", async () => {
    const { http } = await app();
    expect((await http.request("/hooks/sequencer/instantly", { method: "POST", body: JSON.stringify({ event_type: "reply_received", lead_email: "a@b.example" }) })).status).toBe(401);
    expect((await http.request("/hooks/sequencer/nothing", { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("a real webhook is accepted and recorded", async () => {
    const { http, tools } = await app();
    const r = await http.request("/hooks/sequencer/instantly", { method: "POST", headers: { "x-desk-secret": tools.instantly.webhookSecret }, body: JSON.stringify({ event_type: "reply_received", lead_email: "stranger@b.example", email_id: "m1", reply_text: "hello", timestamp: "2027-01-01T00:00:00Z" }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: 1 });
    await new Promise((d) => setTimeout(d, 200));
    expect(await db.query("SELECT 1 FROM inbound_messages WHERE status = 'unmatched'")).toHaveLength(1);
  });

  it("the simulator walks an event from delivered to in market, through every real rule", async () => {
    const { http, lifecycle } = await app();
    lifecycle.crm = withDemoCrm(undefined, db, () => new Date());
    const id = await deliverEvent(db, LIST, {}, "E");
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) { const r = await post(http, `/api/demo/motion/${id}/advance`); expect(r.status).toBe(200); seen.push(((await (await http.request(`/api/events/${id}/motion`)).json()) as { motion: string }).motion); }
    expect(seen.at(-1)).toBe("in_market");
    expect(await db.query("SELECT 1 FROM enrollments WHERE event_id = $1", [id])).not.toHaveLength(0);
  });

  it("the simulator does not exist outside demo mode", async () => {
    const { http } = await app(false);
    const id = await deliverEvent(db, LIST, {}, "E");
    expect((await post(http, `/api/demo/motion/${id}/advance`)).status).toBe(404);
  });

  it("only GTM Engineering can stop all sending or approve templates", async () => {
    const { http } = await app();
    expect((await post(http, "/api/motion/stop", { reason: "x" })).status).toBe(409);
    expect((await post(http, "/api/motion/templates", { name: "x", channel: "email", phase: "pre", steps: [{ day: 0, subject: "s", body: "b" }] })).status).toBe(409);
    expect((await post(http, "/api/motion/templates", { name: "x", channel: "email", phase: "pre", steps: [{ day: 0, subject: "s", body: "b" }] }, "GTM Team")).status).toBe(200);
  });
});
