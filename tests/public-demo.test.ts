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
});
