import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { freshDb } from "./helpers.ts";

describe("the default rules, read-only", () => {
  it("serves config/defaults.json as the settings every new event starts from", async () => {
    const app = createApp(await freshDb(), { demo: true });
    const r = await app.request("/api/settings/defaults");
    expect(r.status).toBe(200);
    const { settings } = await r.json() as { settings: Record<string, unknown> };
    const file = JSON.parse(readFileSync("config/defaults.json", "utf8"));
    expect(settings.icp).toBe(file.icp);
    expect(settings.approvers).toEqual(file.approvers);
    expect(settings.target_titles).toEqual(file.target_titles);
  });
  it("cannot be written", async () => {
    const app = createApp(await freshDb(), { demo: true });
    const r = await app.request("/api/settings/defaults", { method: "POST", headers: { "x-actor": "GTM Team" }, body: "{}" });
    expect(r.status).toBe(404);
  });
});
