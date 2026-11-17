/* Sim mode (decision 102): off by default, on only when SIM_DB_GUARD=1 and SIM_MODE=1 are both set, never beside spending or sending. */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { mayRunPipeline, resolveMode } from "../src/server/modes.ts";
import { buildSim, demoLifecycle } from "../src/server/sim-mode.ts";
import { freshDb } from "./helpers.ts";

const URL_ = "postgres://u:p@127.0.0.1:54329/sim_test";
const both = { DATABASE_URL: URL_, SIM_DB_GUARD: "1", SIM_MODE: "1" };

describe("sim mode", () => {
  it("is off by default: a real database refuses mock vendors", () => {
    const m = resolveMode([], { DATABASE_URL: URL_ });
    expect(m.sim).toBeUndefined();
    expect(mayRunPipeline(m)).toBe(false);
  });
  it("SIM_DB_GUARD alone changes nothing about running", () => {
    const m = resolveMode([], { DATABASE_URL: URL_, SIM_DB_GUARD: "1" });
    expect(m.sim).toBeUndefined();
    expect(mayRunPipeline(m)).toBe(false);
  });
  it("SIM_MODE alone refuses, and says why", () => {
    expect(() => resolveMode([], { DATABASE_URL: URL_, SIM_MODE: "1" })).toThrow(/SIM_MODE=1 needs SIM_DB_GUARD=1/);
  });
  it("only the exact value 1 counts for either switch", () => {
    expect(() => resolveMode([], { DATABASE_URL: URL_, SIM_DB_GUARD: "true", SIM_MODE: "1" })).toThrow(/SIM_DB_GUARD=1/);
    expect(resolveMode([], { DATABASE_URL: URL_, SIM_DB_GUARD: "1", SIM_MODE: "true" }).sim).toBeUndefined();
  });
  it("both set turns it on and lets the lifecycle run", () => {
    const m = resolveMode([], both);
    expect(m).toMatchObject({ sim: true, liveSpend: false, demo: false, databaseUrl: URL_ });
    expect(mayRunPipeline(m)).toBe(true);
  });
  it("refuses beside LIVE_SPEND or LIVE_SEND, and without a database", () => {
    expect(() => resolveMode([], { ...both, LIVE_SPEND: "1" })).toThrow(/must never spend/);
    expect(() => resolveMode([], { ...both, LIVE_SEND: "1" })).toThrow(/must never send/);
    expect(() => resolveMode([], { SIM_DB_GUARD: "1", SIM_MODE: "1" })).toThrow(/needs DATABASE_URL/);
    expect(() => resolveMode([], { ...both, TRANSACTIONAL_URL: "https://mail.example", TRANSACTIONAL_KEY: "k" })).toThrow(/TRANSACTIONAL_URL or TRANSACTIONAL_KEY/);
    expect(() => resolveMode([], { ...both, TRANSACTIONAL_KEY: "k" })).toThrow(/TRANSACTIONAL_URL or TRANSACTIONAL_KEY/);
  });
  it("--demo still wins over everything", () => {
    expect(resolveMode(["--demo"], { ...both, LIVE_SPEND: "1" })).toEqual({ demo: true, liveSpend: false });
  });
  it("builds the lifecycle over simulated vendors, so its routes exist", async () => {
    const db = await freshDb();
    const { deps, setup } = await buildSim(db);
    const lifecycle = demoLifecycle(db, deps, setup);
    expect(Object.keys(lifecycle.connectors).sort()).toEqual(["heyreach", "instantly"]);
    expect(lifecycle.connectors.instantly.simulated).toBe(true);
    const app = createApp(db, { demo: false, lifecycle, demoTools: setup.tools });
    const get = (p: string) => app.request(p, { headers: { "x-actor": encodeURIComponent("Dan Whitlock") } });
    const without = createApp(db, { demo: false });
    expect((await get("/api/events/evt_none/sequences")).headers.get("content-type")).toContain("json");
    expect((await without.request("/api/events/evt_none/sequences", { headers: { "x-actor": "Dan" } })).headers.get("content-type") ?? "").not.toContain("json");
  });
});
