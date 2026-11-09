import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { freshDb } from "./helpers.ts";

const writes: [string, string][] = [
  ["POST", "/api/icp/documents"],
  ["POST", "/api/icp/compiles/x/start"],
  ["PATCH", "/api/icp/compiles/x/draft"],
  ["POST", "/api/icp/compiles/x/publish"],
  ["POST", "/api/settings/defaults"],
];
const as = (actor: string) => ({ "x-actor": encodeURIComponent(actor), "content-type": "application/json" });

describe("Settings and ICP writes are for GTM Team only", () => {
  it.each(["Maya Ortiz", "Dan Whitlock"])("refuses %s with a 403 on every write route", async (who) => {
    const app = createApp(await freshDb(), { demo: true });
    for (const [method, path] of writes) {
      const r = await app.request(path, { method, headers: as(who), body: "{}" });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect((await r.json() as { error: string }).error).toMatch(/GTM Engineering/);
    }
  });
  it("lets GTM Team through to the route itself", async () => {
    const app = createApp(await freshDb(), { demo: true });
    const r = await app.request("/api/icp/documents", { method: "POST", headers: as("GTM Team"), body: JSON.stringify({ filename: "a.md", text: "We sell to B2B software companies with 200 to 5000 employees." }) });
    expect(r.status).toBe(201);
  });
  it("still asks who you are before anything else", async () => {
    const app = createApp(await freshDb(), { demo: true });
    expect((await app.request("/api/icp/documents", { method: "POST", body: "{}" })).status).toBe(400);
  });
  it("leaves reading open and the per-event run settings to the people who run events", async () => {
    const app = createApp(await freshDb(), { demo: true });
    expect((await app.request("/api/icp")).status).toBe(200);
    const view = await (await app.request("/api/settings/view")).json() as { connections: { name: string; state: string }[] };
    expect(view.connections.map((c) => c.name)).toContain("Apollo");
    expect(JSON.stringify(view)).not.toMatch(/sk-|api[_-]?key/i);
    const r = await app.request("/api/events/nope/settings", { method: "PATCH", headers: as("Maya Ortiz"), body: "{}" });
    expect(r.status).not.toBe(403);
  });
});
