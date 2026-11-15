/* INTEGRATED_WITH (docs/SHARED-WORLD.md section 3): the setting, the routes it closes, and that alone nothing changes. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { checkIntegration, integratedWith, integrationView, refusalFor } from "../src/server/integration.ts";
import { campaignShape, drainOutbox, queueCampaign } from "../src/server/crm-outbox.ts";
import { BODIES, hashOf, MEMBER_STATUSES, readDefinition, definitionVersions } from "../src/server/definitions.ts";
import { demoConnectors } from "../src/server/connectors/setup.ts";
import { mockLlm } from "../src/server/providers.ts";
import type { Db } from "../src/server/db.ts";
import { createHash } from "node:crypto";
import { freshDb } from "./helpers.ts";
import { as } from "./plan-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
afterEach(() => { delete process.env.INTEGRATED_WITH; });
const GTM = "GTM Team";

async function http() {
  const { connectors, tools } = await demoConnectors(db);
  return createApp(db, { demo: true, lifecycle: { connectors, llm: mockLlm }, demoTools: tools });
}
const post = (h: Awaited<ReturnType<typeof http>>, path: string, body: unknown = {}) => h.request(path, { method: "POST", headers: as(GTM), body: JSON.stringify(body) });

describe("the setting", () => {
  it("unset means alone; names are trimmed and lowered; a bad name stops boot", () => {
    expect(integratedWith({})).toEqual([]);
    expect(integratedWith({ INTEGRATED_WITH: " Account_Desk , market_desk" })).toEqual(["account_desk", "market_desk"]);
    expect(() => checkIntegration({ INTEGRATED_WITH: "account_desk,crm_desk,market_desk" })).not.toThrow();
    expect(() => checkIntegration({ INTEGRATED_WITH: "events_desk" })).toThrow(/use account_desk, market_desk, crm_desk/);
    expect(() => checkIntegration({ INTEGRATED_WITH: "nope" })).toThrow(/nope/);
  });
  it("says what it runs, and when crm_desk is named but not connected", () => {
    expect(integrationView(undefined, {})).toMatchObject({ with: [], crm: "none", sequencer: "events_desk", icp: "events_desk", crm_named_not_connected: false });
    expect(integrationView("crm_desk", { INTEGRATED_WITH: "account_desk,market_desk,crm_desk" })).toMatchObject({ crm: "crm_desk", sequencer: "account_desk", icp: "market_desk", crm_named_not_connected: false });
    expect(integrationView("no_crm", { INTEGRATED_WITH: "crm_desk" }).crm_named_not_connected).toBe(true);
  });
});

describe("the routes each name closes", () => {
  const SEQ = ["/api/events/e1/motion/tools", "/api/events/e1/motion/legal-basis", "/api/events/e1/motion/sequences", "/api/motion/sequences/s1/campaign", "/api/motion/sequences/s1/checklist",
    "/api/motion/sequences/s1/release", "/api/motion/sequences/s1/placement-override", "/api/motion/templates", "/api/motion/placement", "/api/motion/account-domains"];
  const ICP = ["/api/icp/documents", "/api/icp/compiles/c1/start", "/api/icp/compiles/c1/confirm", "/api/icp/compiles/c1/bench", "/api/icp/compiles/c1/bench/run", "/api/icp/compiles/c1/bench/example", "/api/icp/compiles/c1/publish", "/api/icp/compiles/c1/reopen", "/api/icp/compiles/c1/draft"];
  const KEPT = ["/api/motion/consent", "/api/motion/domains", "/api/events/e1/motion/contacts/c1/resume", "/api/motion/stop", "/api/motion/restart", "/api/events/e1/motion/capture", "/api/motion/replies/r1/handled", "/api/motion/forget", "/api/events/e1/motion/costs", "/api/events/e1/motion/slots",
    "/api/motion/meetings/m1/outcome", "/api/motion/debriefs/d1/review", "/api/icp/compiles/c1/cancel"];

  it("alone, every route is open", () => {
    for (const p of [...SEQ, ...ICP, ...KEPT, "/api/events/e1/motion/start"]) expect(refusalFor("POST", p, undefined, {}), p).toBeNull();
  });
  it("with account_desk, exactly the sequencer routes close, and a debrief-only card stays open", () => {
    const env = { INTEGRATED_WITH: "account_desk" };
    for (const p of SEQ) expect(refusalFor("POST", p, undefined, env)?.code, p).toBe("owned_by_account_desk");
    expect(refusalFor("POST", "/api/events/e1/motion/start", undefined, env)?.code).toBe("owned_by_account_desk");   // the default purpose is outreach
    expect(refusalFor("POST", "/api/events/e1/motion/start", "outreach", env)?.code).toBe("owned_by_account_desk");
    expect(refusalFor("POST", "/api/events/e1/motion/start", "debrief_only", env)).toBeNull();
    for (const p of [...ICP, ...KEPT]) expect(refusalFor("POST", p, undefined, env), p).toBeNull();
  });
  it("with market_desk, exactly the ICP routes close", () => {
    const env = { INTEGRATED_WITH: "market_desk" };
    for (const p of ICP) expect(refusalFor("POST", p, undefined, env)?.code, p).toBe("owned_by_market_desk");
    for (const p of [...SEQ, ...KEPT, "/api/events/e1/motion/start"]) expect(refusalFor("POST", p, undefined, env), p).toBeNull();
    expect(refusalFor("PUT", "/api/icp/compiles/c1/bench", undefined, env)?.code).toBe("owned_by_market_desk");
    expect(refusalFor("PATCH", "/api/icp/compiles/c1/draft", undefined, env)?.code).toBe("owned_by_market_desk");
    expect(refusalFor("GET", "/api/icp/compiles/c1", undefined, env)).toBeNull();
  });
  it("crm_desk alone closes nothing", () => {
    for (const p of [...SEQ, ...ICP]) expect(refusalFor("POST", p, undefined, { INTEGRATED_WITH: "crm_desk" }), p).toBeNull();
  });
  it("over HTTP: 409 naming the owner, and the route answers again when the name is removed", async () => {
    const h = await http();
    process.env.INTEGRATED_WITH = "account_desk,market_desk";
    const a = await post(h, "/api/events/e1/motion/sequences");
    expect(a.status).toBe(409);
    expect(await a.json()).toMatchObject({ code: "owned_by_account_desk", error: expect.stringMatching(/Account Desk/) });
    const m = await post(h, "/api/icp/documents", {});
    expect(m.status).toBe(409);
    expect(await m.json()).toMatchObject({ code: "owned_by_market_desk" });
    expect(await (await h.request("/api/integration")).json()).toMatchObject({ with: ["account_desk", "market_desk"], sequencer: "account_desk", icp: "market_desk" });
    delete process.env.INTEGRATED_WITH;
    expect(((await (await post(h, "/api/events/e1/motion/sequences")).json()) as { code?: string }).code).toBeUndefined();
  });
  it("every route the app has is classified: the closed set is the same list the middleware reads", async () => {
    const h = await http();
    const routes = (h as unknown as { routes: { method: string; path: string }[] }).routes.filter((r) => /^(POST|PUT|PATCH)$/.test(r.method)).map((r) => r.path.replace(/:[A-Za-z]+/g, "x"));
    const closed = (env: Record<string, string>) => [...new Set(routes)].filter((p) => ["POST", "PUT", "PATCH"].some((m) => refusalFor(m, p, "outreach", env))).sort();
    expect(closed({})).toEqual([]);
    expect(closed({ INTEGRATED_WITH: "account_desk" }).every((p) => /\/motion\//.test(p))).toBe(true);
    expect(closed({ INTEGRATED_WITH: "market_desk" }).every((p) => /^\/api\/icp\//.test(p))).toBe(true);
    expect(closed({ INTEGRATED_WITH: "account_desk" }).length).toBe(11);
    expect(closed({ INTEGRATED_WITH: "market_desk" }).length).toBe(9);
  });
});

describe("the published definition", () => {
  it("has CRM Desk's hash algorithm, one body, versions that append, and refuses edits", async () => {
    // A known body, hashed by hand with the documented rule (sorted keys, no spaces, non-ASCII kept).
    const body = { b: [2, 1], a: "é" };
    expect(hashOf(body)).toBe("sha256:" + createHash("sha256").update('{"a":"é","b":[2,1]}', "utf8").digest("hex"));
    const d = await readDefinition(db, "campaign_member_statuses");
    expect(d).toMatchObject({ version: 1, owner_desk: "events_desk", hash: hashOf(BODIES.campaign_member_statuses()) });
    expect((d!.body as { statuses: unknown[] }).statuses).toHaveLength(MEMBER_STATUSES.length);
    expect((await readDefinition(db, "campaign_member_statuses"))!.version).toBe(1);   // unchanged body, no new version
    expect(await readDefinition(db, "nope")).toBeNull();
    expect((await definitionVersions(db, "campaign_member_statuses"))!.versions).toHaveLength(1);
    await expect(db.query("UPDATE definition_versions SET changed_by = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM definition_versions")).rejects.toThrow(/append-only/);
    const h = await http();
    const list = (await (await h.request("/api/definitions")).json()) as { index: { name: string; version: number }[] };
    expect(list.index).toEqual([expect.objectContaining({ name: "campaign_member_statuses", version: 1 })]);
    expect((await h.request("/api/definitions/nope")).status).toBe(404);
  });
  it("a webinar has Watched later and no Met; applies lists are sorted", () => {
    const s = Object.fromEntries(MEMBER_STATUSES.map((x) => [x.key, x]));
    expect(s.met.applies).toEqual(["event"]);
    expect(s.watched_later.applies).toEqual(["webinar"]);
    for (const x of MEMBER_STATUSES) expect(x.applies).toEqual([...x.applies].sort());
  });
});

describe("campaign type and parent", () => {
  it("is webinar for a webinar and event otherwise, and a hosted event names its conference", async () => {
    const { hostedDinner } = await import("./hosted-helpers.ts");
    const id = await hostedDinner(db, { format: "webinar" });
    expect(await campaignShape(db, id)).toEqual({ type: "webinar", conference: null });
    const dinner = await hostedDinner(db, { format: "dinner" });
    expect(await campaignShape(db, dinner)).toEqual({ type: "event", conference: null });
  });
  it("a child row waits for its conference, without using an attempt, and goes once the conference is in", async () => {
    const { hostedDinner } = await import("./hosted-helpers.ts");
    const conf = await hostedDinner(db, { name: "Conference" });
    const child = await hostedDinner(db, { name: "Side dinner" });
    await db.query("UPDATE involvements SET conference_event_id = $2 WHERE event_id = $1 AND kind = 'hosted'", [child, conf]);
    const made: any[] = [];
    const crm: any = { name: "crm_desk", connected: true, write: async () => {}, personFlags: async () => ({}), findCampaignByKey: async () => null,
      createCampaign: async (a: any) => { made.push(a); return { id: `cmp_${made.length}` }; } };
    // Only the child is queued: the conference is not in the CRM yet.
    await db.query("INSERT INTO crm_outbox (id, kind, payload, desk_key) VALUES ('o1', 'campaign', $1::jsonb, $2)", [JSON.stringify({ event_id: child, name: "Side dinner", start: "2027-06-10", end: "2027-06-10", email: null, full_name: null, company: null, domain: null }), `campaign:${child}`]);
    await drainOutbox(db, crm);
    expect(made).toEqual([]);
    const [row] = await db.query<{ status: string; attempts: number; last_error: string }>("SELECT status, attempts, last_error FROM crm_outbox WHERE id = 'o1'");
    expect(row).toMatchObject({ status: "queued", attempts: 0, last_error: "parent not in the CRM yet" });
    // queueCampaign puts the conference first and then the child; the sweep sends them in order.
    await db.query("DELETE FROM crm_outbox");
    await queueCampaign(db.query, child, crm);
    await drainOutbox(db, crm);
    await drainOutbox(db, crm);
    expect(made.map((m) => [m.type, m.parent])).toEqual([["event", undefined], ["event", "cmp_1"]]);
  });
});
