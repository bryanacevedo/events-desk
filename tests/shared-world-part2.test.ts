/* Step 6 part 2 leftovers and the world slice (docs/SHARED-WORLD.md 12.5, 12.6). */

import { describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashOf } from "../src/server/definitions.ts";
import { crmDeskCrm } from "../src/server/crm-desk.ts";
import { worldSlice } from "../src/server/world-slice.ts";
import { freshDb } from "./helpers.ts";

describe("the definition hash", () => {
  it("equals CRM Desk's own function on the same body (fixture made with crm-build origin/main src/crm/definitions.py hash_of)", () => {
    const body = { statuses: [{ key: "sent", label: "Invité", meaning: "sent", applies: ["event", "webinar"], responded: false }], z: 1, a: [3, 2] };
    expect(hashOf(body)).toBe("sha256:4a0b51223f73c7784a98f682c93b6c1847f27b1c4b657c7829095e8937f90c50");
  });
  it("a TRUNCATE of the published versions is refused, as an update and a delete are", async () => {
    const db = await freshDb();
    await db.query("INSERT INTO definition_versions (name, version, hash, body, changed_by) VALUES ('x', 1, 'sha256:' || repeat('a', 64), '{}'::jsonb, 't')");
    await expect(db.query("TRUNCATE definition_versions")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM definition_versions")).rejects.toThrow(/append-only/);
  });
});

describe("the adapter", () => {
  const fake = (calls: any[]) => (async (url: string, init: any) => { calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }); return new Response(JSON.stringify({ id: "x1" }), { status: 200 }); }) as typeof fetch;
  const rec = { id: "c1", object: "Contact" as const, email: "a@b.example", email_opt_out: false, do_not_contact: false, do_not_call: false, bounced_at: null };
  it("sends no_show as no_show, and refuses a status it has no meaning for instead of sending sent", async () => {
    const calls: any[] = [];
    const crm = crmDeskCrm("https://crm.example", "k", fake(calls));
    await crm.createCampaignMember!({ campaign: "cm1", record: rec, key: "k", status: "no_show" });
    expect(calls[0].body.status).toBe("no_show");
    await expect(crm.createCampaignMember!({ campaign: "cm1", record: rec, key: "k", status: "nonsense" })).rejects.toThrow(/No CRM Desk meaning/);
  });
  it("posts an activity with the desk's external id and a meeting's fields, patches its status, writes money only through its own call", async () => {
    const calls: any[] = [];
    const crm = crmDeskCrm("https://crm.example", "k", fake(calls));
    await crm.createActivity!({ record: rec, type: "meeting", direction: null, subject: "Meeting at X", at: "2027-01-15T15:00:00Z", key: "activity:meeting:m1", meeting: { status: "booked", at: "2027-01-15T15:00:00Z", timezone: "UTC" } });
    expect(calls[0]).toMatchObject({ method: "POST", url: "https://crm.example/api/v1/activities", body: { type: "meeting", contact: "c1", external_id: "events_desk:activity:meeting:m1", meeting_status: "booked", meeting_at: "2027-01-15T15:00:00Z", occurred_at: "2027-01-15T15:00:00Z" } });
    await crm.updateActivity!({ id: "act1", meeting_status: "held" });
    expect(calls[1]).toMatchObject({ method: "PATCH", url: "https://crm.example/api/v1/activities/act1", body: { meeting_status: "held" } });
    await expect(crm.updateCampaignMoney!({ campaign: "cmp", budget_cents: 5, actual_cost_cents: 3 })).rejects.toThrow(/money is off/);
    process.env.CRM_CAMPAIGN_MONEY = "usd";
    await crm.updateCampaignMoney!({ campaign: "cmp", budget_cents: 5, actual_cost_cents: 3 });
    delete process.env.CRM_CAMPAIGN_MONEY;
    expect(calls[2].body).toEqual({ budget_cents: 5, actual_cost_cents: 3 });
  });
});

describe("the world slice", () => {
  it("is the pinned events_desk slice: hashes match its manifest, 18 events, the seller, the clock, the roster", () => {
    const w = worldSlice();
    expect(w.pin).toMatchObject({ tag: "v1.3.0", commit: "a008e188462e0ae06255493bd5c0da077747e99d", world_version: "1.3.0" });
    expect(w.seller.name).toBe("Lumen Ledger");
    expect(w.now).toBe("2026-11-12T14:00:00+00:00");
    expect(w.events).toHaveLength(18);
    expect(w.roster.length).toBeGreaterThan(5);
    expect(w.roster.every((r) => r.events_desk_role)).toBe(true);
  });
  it("refuses a file that differs from its manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "world-"));
    for (const f of ["clock.json", "events.csv", "seller.json", "team.csv", "manifest.json", "PIN.json"]) copyFileSync(join("samples/lumen-world", f), join(dir, f));
    writeFileSync(join(dir, "events.csv"), readFileSync(join(dir, "events.csv"), "utf8") + "\n");
    expect(() => worldSlice(dir)).toThrow(/does not match its manifest/);
  });
});
