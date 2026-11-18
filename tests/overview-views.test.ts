import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { seed } from "../src/server/seed.ts";
import { freshDb } from "./helpers.ts";
import { DEFAULT_OVERVIEW_VIEW, overviewView, setOverviewView } from "../src/server/view-prefs.ts";

const as = (who: string, extra: RequestInit = {}) => ({ ...extra, headers: { "x-actor": encodeURIComponent(who), "content-type": "application/json" } });
const view = async (app: ReturnType<typeof createApp>, who: string) => ((await (await app.request("/api/overview", as(who))).json()) as { view: string }).view;

describe("the Overview layout is each person's own choice (decision 81)", () => {
  it("defaults to b for everyone, with no row written", async () => {
    const db = await freshDb();
    await seed(db);
    const app = createApp(db, { demo: true });
    expect(DEFAULT_OVERVIEW_VIEW).toBe("b");
    expect(await view(app, "Maya Okafor")).toBe("b");
    expect(await view(app, "GTM Team")).toBe("b");
    expect(await view(app, "")).toBe("b");
    expect((await db.query("SELECT 1 FROM person_view_prefs")).length).toBe(0);
  });

  it("keeps a pick under the person's name, leaves everyone else alone, and lets them change it", async () => {
    const db = await freshDb();
    await seed(db);
    const app = createApp(db, { demo: true });
    for (const v of ["a", "c"]) {
      const r = await app.request("/api/overview/view", as("Maya Okafor", { method: "PUT", body: JSON.stringify({ view: v }) }));
      expect(r.status).toBe(200);
      expect(await view(app, "Maya Okafor")).toBe(v);
      expect(await view(app, "Dan Whitlock")).toBe("b");
    }
    await app.request("/api/overview/view", as("Dan Whitlock", { method: "PUT", body: JSON.stringify({ view: "a" }) }));
    expect(await view(app, "Maya Okafor")).toBe("c");
    expect(await view(app, "Dan Whitlock")).toBe("a");
    expect((await db.query("SELECT 1 FROM person_view_prefs")).length).toBe(2);
  });

  it("refuses an unknown layout, a missing person, and the database refuses it too", async () => {
    const db = await freshDb();
    await seed(db);
    const app = createApp(db, { demo: true });
    for (const body of [{ view: "d" }, { view: "" }, {}, { view: 1 }]) {
      expect((await app.request("/api/overview/view", as("Maya Okafor", { method: "PUT", body: JSON.stringify(body) }))).status).toBe(400);
    }
    expect((await app.request("/api/overview/view", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "a" }) })).status).toBe(400);
    expect(await overviewView(db, "Maya Okafor")).toBe("b");
    await expect(db.query("INSERT INTO person_view_prefs (person, screen, choice) VALUES ('X', 'overview', 'z')")).rejects.toThrow();
    await expect(db.query("INSERT INTO person_view_prefs (person, screen, choice) VALUES ('X', 'budget', 'a')")).rejects.toThrow();
    await expect(setOverviewView(db, " ", "a")).rejects.toThrow();
  });

  it("carries the same rows whichever layout is picked, and a rep's read still has no money", async () => {
    const db = await freshDb();
    await seed(db);
    const app = createApp(db, { demo: true });
    const read = async (who: string) => (await (await app.request("/api/overview", as(who))).json()) as { year: { events: unknown[]; total_planned_cents?: number }; deadlines: unknown[] };
    const before = await read("Maya Okafor");
    await app.request("/api/overview/view", as("Maya Okafor", { method: "PUT", body: JSON.stringify({ view: "c" }) }));
    const after = await read("Maya Okafor");
    expect(after.year.events).toEqual(before.year.events);
    expect(after.deadlines).toEqual(before.deadlines);
    expect(JSON.stringify(after)).not.toMatch(/_cents/);
    // Leadership and GTM still read the money, whichever layout they picked.
    await app.request("/api/overview/view", as("GTM Team", { method: "PUT", body: JSON.stringify({ view: "a" }) }));
    expect(JSON.stringify(await read("GTM Team"))).toMatch(/total_planned_cents/);
  });
});
