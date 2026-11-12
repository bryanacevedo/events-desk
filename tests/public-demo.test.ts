/* The hosted demo has no login, so whatever one visitor uploads the next could read. It takes no files. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { freshDb } from "./helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
const post = (app: ReturnType<typeof createApp>, path: string) => app.request(path, { method: "POST", headers: { "x-actor": "Maya%20Ortiz", "content-type": "text/csv", "x-filename": "a.csv" }, body: "Company,Name\nAcme,Ada\n" });

describe("the public demo", () => {
  it("refuses an attendee list and new registrations, and says why", async () => {
    const app = createApp(db, { demo: true, publicDemo: true });
    for (const path of ["/api/events/any/upload", "/api/events/any/new-registrations"]) {
      const r = await post(app, path);
      expect(r.status).toBe(403);
      expect((await r.json() as { error: string }).error).toMatch(/run it yourself/i);
    }
  });
  it("still answers reads", async () => {
    const app = createApp(db, { demo: true, publicDemo: true });
    expect((await app.request("/api/events")).status).toBe(200);
  });
  it("does not refuse uploads anywhere else", async () => {
    const r = await post(createApp(db, { demo: true }), "/api/events/any/upload");
    expect(r.status).not.toBe(403);
  });
  it("refuses a review workbook, webhooks and Slack calls", async () => {
    const app = createApp(db, { demo: true, publicDemo: true });
    expect((await post(app, "/api/events/any/review")).status).toBe(403);
    expect((await app.request("/hooks/sequencer/instantly", { method: "POST", headers: { "x-desk-secret": "fake-secret" }, body: "{}" })).status).toBe(403);
    expect((await app.request("/slack/commands", { method: "POST", body: "" })).status).toBe(403);
  });
  it("limits how many changes one address makes in a minute", async () => {
    const app = createApp(db, { demo: true, publicDemo: true });
    const hit = () => app.request("/api/events", { method: "POST", headers: { "x-actor": "Maya%20Ortiz", "x-forwarded-for": "9.9.9.9", "content-type": "application/json" }, body: "{}" });
    for (let i = 0; i < 60; i++) expect((await hit()).status).not.toBe(429);
    expect((await hit()).status).toBe(429);
  });
});

describe("every deployment", () => {
  it("refuses a body over the limit before reading it, and sends security headers", async () => {
    const app = createApp(db, { demo: true });
    const big = "x".repeat(1_100_000);
    const r = await app.request("/api/events", { method: "POST", headers: { "x-actor": "Maya%20Ortiz", "content-type": "application/json", "content-length": String(big.length) }, body: big });
    expect(r.status).toBe(413);
    const g = await app.request("/api/events");
    expect(g.headers.get("x-frame-options")).toBe("DENY");
    expect(g.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
  });
  it("gives a rep the pending decisions without seat prices or estimates", async () => {
    const app = createApp(db, { demo: true });
    const r = await (await app.request("/api/approvals", { headers: { "x-actor": "Maya%20Ortiz" } })).json() as { approvals: Record<string, unknown>[] };
    for (const a of r.approvals) { expect(a.seat_price_cents ?? null).toBeNull(); expect(a.est_cents).toBeUndefined(); }
  });
  it("gives a rep seat requests without anyone else's travel or the budget", async () => {
    const app = createApp(db, { demo: true });
    const r = await (await app.request("/api/seat-requests", { headers: { "x-actor": "Maya%20Ortiz" } })).json() as { requests: Record<string, unknown>[] };
    for (const q of r.requests) { expect(q.budget).toBeNull(); if (q.requester !== "Maya Ortiz") expect(q.travel_cents ?? null).toBeNull(); }
  });
});
