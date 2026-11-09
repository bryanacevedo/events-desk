import { beforeEach, describe, expect, it } from "vitest";
import { correctFirmographics, domainsForName, getDomainState, getFirmographics, getTier, getVerification, mapNameToDomain, putDomainState, putFirmographics, putTier, putVerification } from "../src/server/caches.ts";
import type { Db } from "../src/server/db.ts";
import { freshDb } from "./helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });
const age = (table: string, col: string, days: number) => db.query(`UPDATE ${table} SET ${col} = now() - ($1::text || ' days')::interval`, [String(days)]);

describe("caches that outlive one event", () => {
  it("ages firmographics out after 90 days", async () => {
    await putFirmographics(db, "acme.example", "Acme", { employees: 900 }, "vendor");
    expect(await getFirmographics(db, "ACME.example")).toMatchObject({ name: "Acme", firmographics: { employees: 900 } });
    await age("company_cache", "fetched_at", 89);
    expect(await getFirmographics(db, "acme.example")).not.toBeNull();
    await age("company_cache", "fetched_at", 91);
    expect(await getFirmographics(db, "acme.example")).toBeNull();
  });
  it("lets a human correction overwrite, never age out, and never be replaced by a vendor", async () => {
    await putFirmographics(db, "acme.example", "Acme", { employees: 900 }, "vendor");
    await correctFirmographics(db, "acme.example", "Acme Corp", { employees: 1200 }, "Maya Ortiz");
    await age("company_cache", "fetched_at", 400);
    expect(await getFirmographics(db, "acme.example")).toMatchObject({ corrected: true, firmographics: { employees: 1200 }, source: "human:Maya Ortiz" });
    await putFirmographics(db, "acme.example", "Acme", { employees: 5 }, "vendor");
    expect((await getFirmographics(db, "acme.example"))!.firmographics).toEqual({ employees: 1200 });
  });
  it("maps a name to the domains it has resolved to, aged by the same rule", async () => {
    await mapNameToDomain(db, "acme", "acme.example", "search");
    await mapNameToDomain(db, "acme", "acmecorp.example", "search");
    expect(await domainsForName(db, "acme")).toEqual(["acme.example", "acmecorp.example"]);
    await age("name_domain_map", "created_at", 120);
    expect(await domainsForName(db, "acme")).toEqual([]);
    await mapNameToDomain(db, "acme", "acme.example", "human", true);
    await age("name_domain_map", "created_at", 400);
    expect(await domainsForName(db, "acme")).toEqual(["acme.example"]);
  });
  it("keys tiers on domain and ICP version, never domain alone", async () => {
    await putTier(db, "acme.example", "v1", { tier: 1, segment: "software", reason: "icp_match", fact: "900 employees" });
    expect(await getTier(db, "acme.example", "v1")).toMatchObject({ tier: 1, fact: "900 employees" });
    expect(await getTier(db, "acme.example", "v2")).toBeNull();
  });
  it("reuses a verification result for 30 days, positive or negative", async () => {
    await putVerification(db, "A@Acme.example", "undeliverable", "verifier_one");
    await putVerification(db, "b@acme.example", "deliverable", "verifier_one");
    expect(await getVerification(db, "a@acme.example")).toMatchObject({ verdict: "undeliverable" });
    await age("verification_cache", "checked_at", 29);
    expect(await getVerification(db, "b@acme.example")).not.toBeNull();
    await age("verification_cache", "checked_at", 31);
    expect(await getVerification(db, "b@acme.example")).toBeNull();
  });
  it("remembers a domain's catch-all state", async () => {
    await putDomainState(db, "Acme.example", { catch_all: true, mail_server: true });
    expect(await getDomainState(db, "acme.example")).toEqual({ catch_all: true, mail_server: true });
  });
});
