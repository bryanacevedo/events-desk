/* Step 6 part 3 (docs/SHARED-WORLD.md 13.6 and 13.7): the deferral panel's counts, booking link and play status, and the read Account Desk makes of this desk. */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { clearPlayCache, cleanBookingUrl, panelView, playLines, playStatus, type PlayRead } from "../src/server/desk-panel.ts";
import { demoConnectors } from "../src/server/connectors/setup.ts";
import { mockLlm } from "../src/server/providers.ts";
import type { Db } from "../src/server/db.ts";
import { freshDb } from "./helpers.ts";
import { as } from "./plan-helpers.ts";
import { hostedDinner } from "./hosted-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); clearPlayCache(); });
afterEach(() => { delete process.env.DESK_READ_KEY; delete process.env.INTEGRATED_WITH; });

async function http() {
  const { connectors, tools } = await demoConnectors(db);
  return createApp(db, { demo: true, lifecycle: { connectors, llm: mockLlm }, demoTools: tools });
}
const withCampaign = async (ref = "cmp_1") => { const id = await hostedDinner(db); await db.query("UPDATE events SET crm_campaign_id = $2 WHERE id = $1", [id, ref]); return id; };

describe("GET /api/desk/campaigns/<crm campaign id>", () => {
  it("is 404 with no key set, 401 with a wrong or missing key, and 200 with the right one, past the desk's own sign-in", async () => {
    const h = await http(); await withCampaign("cmp_1");
    expect((await h.request("/api/desk/campaigns/cmp_1", { headers: { authorization: "Bearer x" } })).status).toBe(404);
    process.env.DESK_READ_KEY = "secret-key";
    expect((await h.request("/api/desk/campaigns/cmp_1", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await h.request("/api/desk/campaigns/cmp_1")).status).toBe(401);
    const ok = await h.request("/api/desk/campaigns/cmp_1", { headers: { authorization: "Bearer secret-key" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ event: expect.stringMatching(/Test Dinner/), starts_on: "2027-06-10", ends_on: "2027-06-10", city: null, booking_url: null });
    expect((await h.request("/api/desk/campaigns/nope", { headers: { authorization: "Bearer secret-key" } })).status).toBe(404);
  });
  it("carries the booking link once a person sets it, and nothing about a person", async () => {
    const h = await http(); const id = await withCampaign("cmp_2"); process.env.DESK_READ_KEY = "k";
    const put = await h.request(`/api/events/${id}/booking-url`, { method: "PUT", headers: as("Camille Laurent"), body: JSON.stringify({ booking_url: " https://cal.example.test/dinner " }) });
    expect(put.status).toBe(200);
    const body = await (await h.request("/api/desk/campaigns/cmp_2", { headers: { authorization: "Bearer k" } })).json() as Record<string, unknown>;
    expect(body.booking_url).toBe("https://cal.example.test/dinner");
    expect(Object.keys(body).sort()).toEqual(["booking_url", "city", "ends_on", "event", "starts_on"]);
  });
  it("is not served to a stranger as a write", async () => {
    const h = await http(); await withCampaign("cmp_3"); process.env.DESK_READ_KEY = "k";
    expect((await h.request("/api/desk/campaigns/cmp_3", { method: "POST", headers: { authorization: "Bearer k" } })).status).not.toBe(200);
  });
});

describe("the booking link", () => {
  it("is an http or https address up to 500 characters, or empty", () => {
    expect(cleanBookingUrl("")).toBeNull();
    expect(cleanBookingUrl("https://a.example/x?y=1")).toBe("https://a.example/x?y=1");
    expect(cleanBookingUrl("http://a.example")).toBe("http://a.example");
    for (const bad of ["javascript:alert(1)", "ftp://a.example", "a.example", "https://", "https://a b", "x".repeat(501)]) expect(() => cleanBookingUrl(bad), bad).toThrow();
  });
  it("the database refuses anything else too", async () => {
    const id = await withCampaign();
    await expect(db.query("UPDATE events SET booking_url = 'javascript:alert(1)' WHERE id = $1", [id])).rejects.toThrow();
    await db.query("UPDATE events SET booking_url = 'https://ok.example' WHERE id = $1", [id]);
    await db.query("UPDATE events SET booking_url = NULL WHERE id = $1", [id]);
  });
});

describe("the panel's counts", () => {
  it("count people by status from the desk's own table and what is held, with no network call", async () => {
    const id = await withCampaign();
    for (const [email, last] of [["a", "targeted"], ["b", "targeted"], ["c", "declined"], ["d", "registered"]]) await db.query("INSERT INTO crm_sync (kind, ref, last) VALUES ('member', $1, $2)", [`${id}:${email}@x.example`, last]);
    await db.query("INSERT INTO crm_outbox (id, kind, payload, status) VALUES ('o1', 'campaign_member', $1::jsonb, 'held')", [JSON.stringify({ event_id: id, email: "z@x.example" })]);
    const v = await panelView(db, id, {});
    expect(v.counts).toMatchObject({ targeted: 2, declined: 1, registered: 1, attended: 0 });
    expect(v).toMatchObject({ held: 1, in_crm: true, plays_read: false });
    expect(JSON.stringify(v)).not.toMatch(/@x\.example/);
  });
});

describe("the play status from Account Desk", () => {
  const read: PlayRead = { campaign_ref: "cmp_1", as_of: "2026-11-24T10:00:00Z", plays: [
    { key: "event_pre_event", name: "Before the event", states: { active: 1 }, people: { pending: 4, active: 5, replied: 2, stopped_declined_event: 1 } },
    { key: "event_follow_up", name: "After the event", people: { pending: 0 } }] };
  const env = { ACCOUNT_DESK_URL: "https://ad.example.test/", ACCOUNT_DESK_READ_KEY: "rk" };

  it("is words, counts only, one line per play", () => {
    expect(playLines(read)).toEqual(["Before the event: 12 in the play, 4 waiting for approval, 5 running, 2 replied, 1 stopped because they declined", "After the event: 0 in the play"]);
  });
  it("asks with the Bearer key, caches for a minute, and asks again after it", async () => {
    const id = await withCampaign("cmp_1");
    const calls: { url: string; auth: string }[] = [];
    let t = 1_000_000;
    const f = (async (url: string, init: any) => { calls.push({ url, auth: init.headers.authorization }); return new Response(JSON.stringify(read)); }) as never;
    const a = await playStatus(db, id, env, f, () => t), b = await playStatus(db, id, env, f, () => t + 30_000);
    expect(a.state).toBe("ok"); expect(b).toBe(a);
    expect(calls).toEqual([{ url: "https://ad.example.test/api/desk/campaigns/cmp_1/plays", auth: "Bearer rk" }]);
    t += 61_000; await playStatus(db, id, env, f, () => t);
    expect(calls).toHaveLength(2);
  });
  it("says unavailable with the time of the last good read, and keeps the last good lines; before any good read it has none", async () => {
    const id = await withCampaign("cmp_1");
    let t = 5_000_000, down = true;
    const f = (async () => { if (down) throw new Error("refused"); return new Response(JSON.stringify(read)); }) as never;
    const first = await playStatus(db, id, env, f, () => t);
    expect(first).toMatchObject({ state: "unavailable", lines: [], last_good_at: null });
    down = false; t += 61_000;
    const good = await playStatus(db, id, env, f, () => t);
    down = true; t += 61_000;
    const after = await playStatus(db, id, env, f, () => t);
    expect(after).toMatchObject({ state: "unavailable", last_good_at: good.last_good_at, lines: good.lines });
  });
  it("a non-200 or a body of the wrong shape is unavailable, never a throw; unset settings are off", async () => {
    const id = await withCampaign("cmp_1");
    expect((await playStatus(db, id, env, (async () => new Response("no", { status: 500 })) as never, () => 1)).state).toBe("unavailable");
    clearPlayCache();
    expect((await playStatus(db, id, env, (async () => new Response("{}")) as never, () => 1)).state).toBe("unavailable");
    expect((await playStatus(db, id, {}, (async () => { throw new Error("must not call"); }) as never)).state).toBe("off");
  });
  it("the panel's route answers without waiting for it", async () => {
    const h = await http(); const id = await withCampaign();
    const r = await h.request(`/api/events/${id}/desk-plays`);
    expect(await r.json()).toMatchObject({ state: "off" });
    const p = await h.request(`/api/events/${id}/desk-panel`);
    expect(p.status).toBe(200);
  });
});
