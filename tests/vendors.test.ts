import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { decideApproval } from "../src/server/approvals.ts";
import { createEvent } from "../src/server/events.ts";
import { readPools, seedSamplePools } from "../src/server/pools.ts";
import { requestResearchCard } from "../src/server/research.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { usageView } from "../src/server/usage.ts";
import { cardBreakdown, CREDIT_VENDORS, FALLBACK, vendorOf } from "../src/shared/vendors.ts";
import { deliverEvent, freshDb } from "./helpers.ts";
import type { Db } from "../src/server/db.ts";

const CSV = ["Company Name,First Name,Last Name,Job Title,Work Email", "Tallgrass Software,Ana,Ruiz,VP Sales,ana@tallgrass.example", "Dunmore Payments,Cy,Day,Director of Sales,"].join("\n");
const keys = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keys(x, out); }
  return out;
};

describe("which vendor a paid step belongs to", () => {
  it("maps live and simulated names to the same vendors", () => {
    expect(vendorOf("apollo_match")).toBe("Apollo");
    expect(vendorOf("finder_one")).toBe("Apollo");
    expect(vendorOf("reveal_sim", "reveal")).toBe("Apollo");
    expect(vendorOf("linkedin_lookup", "linkedin")).toBe("Apollo");
    expect(vendorOf("email_waterfall", "waterfall")).toBe("Apollo");
    expect(vendorOf("apollo_waterfall", "waterfall")).toBe("Apollo");
    expect(vendorOf("verifier_one")).toBe("ZeroBounce");
    // Rows from before the direct vendors were removed belong to no pool.
    for (const old of ["hunter", "finder_two", "neverbounce", "verifier_two"]) expect(vendorOf(old, "find")).toBeNull();
    expect(vendorOf("website_fetch")).toBeNull();
  });
  it("splits a card by vendor in credits, and keeps AI in dollars only", () => {
    const b = cardBreakdown({ step_caps: { firmographics: { credits: 10 }, find: { credits: 30 }, verify: { credits: 20 }, company_tier: { llm: 5 } }, llm_cap: 5 });
    expect(b.credits).toEqual([{ vendor: "Apollo", credits: 40 }, { vendor: "ZeroBounce", credits: 20 }]);
    expect(b.ai_cents).toBe(5);
    expect(JSON.stringify(b)).not.toMatch(/credit_cents|usd/);
  });
  it("falls back to the lines on an old single card", () => {
    const b = cardBreakdown({ lines: { discovery_credits: 3, finder_credits: 6, verifier_credits: 4, linkedin_credits: 1 }, llm_cap: 10 });
    expect(b.credits.map((x) => x.vendor)).toEqual(["Apollo", "ZeroBounce"]);
    expect(b.credits[0].credits).toBe(3 + 6 + 1);
  });
  it("keeps the fallback rates in step with config/defaults.json", () => {
    const d = JSON.parse(readFileSync("config/defaults.json", "utf8"));
    expect(d.finders.map((f: { cost: number }) => f.cost)).toEqual(FALLBACK.finders);
    expect(d.verifiers.map((f: { cost: number }) => f.cost)).toEqual(FALLBACK.verifiers);
    expect(d.llm_call_cents).toBe(FALLBACK.llm_call_cents);
    expect(d.credit_cents).toBeUndefined();
  });
});

describe("pools", () => {
  let db: Db;
  beforeAll(async () => { db = await freshDb(); });
  it("are unknown by default and only the demo seed fills sample values", async () => {
    expect(Object.values(await readPools(db)).every((p) => p.allotment === null)).toBe(true);
    const u = await usageView(db, { simulated: false });
    expect(u.vendors.map((v) => v.vendor)).toEqual([...CREDIT_VENDORS]);
    expect(u.vendors.every((v) => v.allotment === null)).toBe(true);
    await seedSamplePools(db);
    expect((await readPools(db)).Apollo.allotment).toBe(5000);
  });
});

describe("no vendor credit carries a dollar figure", () => {
  it("in the Usage, card, approvals and settings payloads", async () => {
    const db = await freshDb();
    await deliverEvent(db, CSV);
    const id = (await createEvent(db, "Maya Ortiz", { name: "Second", starts_on: "2027-02-01", seat_count: 1, seat_price_cents: 100 })).id;
    const [a] = await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1", [id]);
    await decideApproval(db, { approvalId: a.id, actor: "Dan Whitlock", decision: "approve" });
    await ingestUpload(db, id, "Maya Ortiz", "a.csv", CSV);
    await requestResearchCard(db, id, "Maya Ortiz");
    const app = createApp(db, { demo: true });
    const get = async (p: string) => (await app.request(p, { headers: { "x-actor": "GTM%20Team" } })).json() as Promise<any>;

    const usage = await get("/api/usage");
    expect(usage.vendors.length).toBe(2);
    expect(usage.vendors.some((v: any) => v.used > 0)).toBe(true);
    expect(keys(usage.vendors)).not.toContain("cents");
    expect(keys(usage.events.map((e: any) => e.credits))).not.toContain("cents");
    expect(keys(usage)).not.toContain("credit_cents");
    expect(usage.ai.year_cents).toBeGreaterThan(0);

    const ev = await get(`/api/events/${id}`);
    const pend = await get("/api/approvals");
    const settings = await get("/api/settings/view");
    for (const payload of [ev, pend, settings, await get("/api/settings/defaults")]) expect(keys(payload)).not.toContain("credit_cents");
    // The card's money is AI dollars only: its model-call cap times the call rate.
    expect(ev.card.est_cents).toBe(ev.card.llm_cap * 1);
    expect(ev.card.est_cents).toBe(cardBreakdown(ev.card).ai_cents);
    expect(cardBreakdown(pend.approvals[0]).credits.length).toBeGreaterThan(0);
  });
});
