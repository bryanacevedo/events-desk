/* The demo's scanner (docs/SCANNER.md 17): a day's scans on Money20/20 USA through the real ingest path, every state the ledger shows, and Tokyo set up with no scans. */

import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { mockLlm } from "../src/server/providers.ts";
import { M2020, seedPlan } from "../src/server/seed-plan.ts";
import { SCAN_EVENT_SETUP, seedScans } from "../src/server/seed-scans.ts";
import { seedReal } from "../src/server/seed-real.ts";
import { simDeps } from "../src/server/sim-vendors.ts";
import { listScans, readSettings } from "../src/server/scans.ts";
import { freshDb } from "./helpers.ts";
import { CAMILLE, TODAY } from "./plan-helpers.ts";

const lifecycle = { connectors: {}, llm: mockLlm, now: () => new Date("2026-11-14T12:00:00Z") } as never;
let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await seedReal(db);
  await seedPlan(db, { today: TODAY });
  await processEvent(db, M2020, simDeps());
  await seedScans(db, lifecycle);
}, 120_000);

describe("the demo's scans", () => {
  it("hold every state the ledger shows, with two reps on one person, one near match open, and the read waiting to be confirmed", async () => {
    const v = await listScans(db, CAMILLE, M2020);
    expect(v.scans).toHaveLength(12);
    expect(v.counts).toMatchObject({ placed: 8, to_confirm: 1, lookup_pending: 2, failed: 1 });
    expect(v.reviews).toHaveLength(1);
    expect(v.reviews[0]).toMatchObject({ scan_name: "Rob Kline", near_name: "Robert Kline" });
    const sanne = v.scans.filter((s) => s.name === "Sanne de Vries");
    expect(sanne).toHaveLength(2);
    expect(new Set(sanne.map((s) => s.contact_id)).size).toBe(1);
    expect(v.scans.find((s) => s.name === "Aoife Brennan")).toMatchObject({ state: "to_confirm", uncertain: ["title", "email"].sort() });
    expect(v.seconds.length).toBeGreaterThan(0);
  });
  it("a second run adds nothing, and Tokyo is set up with no scans", async () => {
    await seedScans(db, lifecycle);
    expect((await listScans(db, CAMILLE, M2020)).scans).toHaveLength(12);
    expect((await listScans(db, CAMILLE, SCAN_EVENT_SETUP)).scans).toHaveLength(0);
    expect((await readSettings(db.query, SCAN_EVENT_SETUP)).qualifiers).toHaveLength(3);
  });
  it("a rep reads their own scans and the hot ones reached the CRM outbox or the event's channel", async () => {
    expect((await listScans(db, "Maya Okafor", M2020)).scans.every((s) => s.rep === "Maya Okafor")).toBe(true);
    expect(await db.query("SELECT 1 FROM notifications WHERE event_id = $1 AND card::text LIKE '%Henrik Solberg%'", [M2020])).toHaveLength(1);
  });
});
