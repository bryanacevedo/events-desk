import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { seed } from "../src/server/seed.ts";
import { freshDb } from "./helpers.ts";

describe("the overview route", () => {
  it("lists delivered lists with people by priority and is read-only", async () => {
    const db = await freshDb();
    await seed(db);
    const app = createApp(db, { demo: true });
    const r = await app.request("/api/overview");
    expect(r.status).toBe(200);
    const { delivered } = await r.json() as { delivered: { id: string; a: number; b: number; c: number; sheet_url: string | null }[] };
    expect(delivered.map((d) => d.id)).toContain("evt_quarry");
    const q = delivered.find((d) => d.id === "evt_quarry")!;
    expect(q.a + q.b + q.c).toBeGreaterThan(0);
    expect(q.c).toBe(0);
    expect(await (await app.request("/api/overview", { method: "POST", headers: { "x-actor": "Maya Ortiz" }, body: "{}" })).status).toBe(404);
  });
});
