/* Defects two fresh-eyes reviews found on 2026-11-09. Each test states what must hold. Every vendor here is a script; nothing is called. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.ts";
import { getSettingsNow } from "../src/server/approvals.ts";
import { answerCase, openCase } from "../src/server/cases.ts";
import type { Db } from "../src/server/db.ts";
import { moveEvent, newId } from "../src/server/events.ts";
import { dbReveals, finishIdentity } from "../src/server/identity.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { mockCrm, VendorError, type Finder, type Vendors, type Waterfall } from "../src/server/providers.ts";
import { seedIcp } from "../src/server/seed.ts";
import { mockSheets } from "../src/server/sheets.ts";
import { recordOptOut } from "../src/server/suppression.ts";
import { isOptedOut } from "../src/server/caches.ts";
import { nameKey } from "../src/shared/email.ts";
import { companyKey } from "../src/shared/ingest.ts";
import type { Icp } from "../src/shared/icp.ts";
import type { Settings } from "../src/shared/cost.ts";
import { deliverEvent, freshDb } from "./helpers.ts";
import { HEAD, outreachRun, researchWith, row, type Run } from "./tier-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

const ACME = "acmecloud.example";
const soft = { employees: 900, industry: "B2B software", business_model: "B2B", country: "Spain" };
const specs = { [ACME]: { search: soft } };
const CSV = HEAD + row("Acme Cloud", ACME, "Ana Ruiz") + "Acme Cloud,Bo,Lee,VP Sales,\n";
const stage = async (id: string) => (await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage;
const person = (id: string, name: string) => db.query<{ id: string; email: string | null; drop_reason: string | null; email_loop: Record<string, unknown> }>("SELECT id, email, drop_reason, email_loop FROM contacts WHERE event_id = $1 AND full_name = $2", [id, name]).then((r) => r[0]);

/** Scripted Apollo. `starter` runs each time the waterfall is started. */
function lab(o: { match?: Record<string, string>; starter?: () => void } = {}) {
  const calls = { find: [] as string[], start: [] as string[], linkedin: [] as string[] };
  const tweak = (v: Vendors, s: Settings): Vendors => {
    const finder: Finder = { name: "apollo_match", cost: 1, async find(p) { calls.find.push(p.full_name ?? ""); const e = o.match?.[p.full_name ?? ""] ?? null; return { value: e, charged: 1, linkedin: null, apollo_verified: e !== null }; } };
    const waterfall: Waterfall = { name: s.waterfall.name, reserve: s.waterfall.reserve, async start(p) { o.starter?.(); calls.start.push(p.full_name); return { request_id: `r:${p.full_name}` }; }, async poll() { return { state: "done", result: { email: null, apollo_verified: false, zerobounce_pass: false, credits: 1 } }; } };
    return { ...v, finders: [finder], waterfall, identity: { ...v.identity!, personMatch: { ...v.identity!.personMatch, name: "apollo_person_match" } }, linkedin: { ...v.linkedin, name: "apollo_linkedin", find: async (p) => { calls.linkedin.push(p.full_name ?? ""); return v.linkedin.find(p); } } };
  };
  return { calls, tweak };
}
const delivered = async (l: ReturnType<typeof lab>) => { const r = await researchWith(db, CSV, { specs, people: {}, tweak: l.tweak }); await outreachRun(db, r); return r; };
async function deadJob(r: Run, name: string, loop: Record<string, unknown>, kind = "find") {
  const p = await person(r.id, name);
  await db.query("UPDATE contacts SET dropped_at = NULL, drop_reason = NULL, email = NULL, verify_1 = NULL, verify_2 = NULL, email_loop = $2::jsonb WHERE id = $1", [p.id, JSON.stringify(loop)]);
  await db.query("INSERT INTO jobs (id, event_id, kind, payload, status, lease_until) VALUES ('job_dead', $1, $3, $2::jsonb, 'running', now() - interval '1 minute')", [r.id, JSON.stringify({ contact_id: p.id, index: 0 }), kind]);
  await db.query("UPDATE events SET stage = 'finding_people' WHERE id = $1", [r.id]);
  return p.id;
}
const FIRST = { probed: true, supp: true, uploaded: true, cand: [] };

describe("the lists a person confirmed in the ICP are enforced", () => {
  it("a Never contact entry drops the company's people before anything is paid", async () => {
    await seedIcp(db);
    const [v] = await db.query<{ icp: Icp }>("SELECT icp FROM icp_versions ORDER BY version DESC LIMIT 1");
    v.icp.lists.excluded.push({ id: "x1", name: "Acme Cloud", quote: null } as Icp["lists"]["excluded"][number]);
    await db.query("UPDATE icp_versions SET icp = $1::jsonb", [JSON.stringify(v.icp)]);
    const r = await researchWith(db, CSV, { specs, people: {} });
    expect((await person(r.id, "Ana Ruiz")).drop_reason).toBe("excluded_company");
    expect((await getSettingsNow(db, r.id)).excluded_companies).toContain("Acme Cloud");
  });
});

describe("a company that arrives after the free name pass still meets the lists", () => {
  it("a reverse lookup that adds a listed company drops its people", async () => {
    const r = await researchWith(db, CSV, { specs, people: {} });
    const s = { ...(await getSettingsNow(db, r.id)), excluded_companies: ["Listed Co"] };
    await db.query("INSERT INTO companies (id, event_id, key, name, primary_domain, identity_state, identity_via) VALUES ('co_rev', $1, $2, 'Listed Co', 'listedco.example', 'resolved', 'reverse')", [r.id, companyKey("Listed Co")]);
    const p = await person(r.id, "Ana Ruiz");
    await db.query("UPDATE contacts SET company_id = 'co_rev', dropped_at = NULL, drop_reason = NULL WHERE id = $1", [p.id]);
    await finishIdentity(db, r.id, s, mockCrm);
    expect((await person(r.id, "Ana Ruiz")).drop_reason).toBe("excluded_company");
  });
  it("a website a person gives on a case meets the domain lists", async () => {
    const r = await researchWith(db, CSV, { specs, people: {} });
    const s = await getSettingsNow(db, r.id);
    await db.query("UPDATE event_settings SET settings = $2::jsonb WHERE event_id = $1", [r.id, JSON.stringify({ ...s, excluded_companies: ["banned.example"] })]);
    await db.query("INSERT INTO companies (id, event_id, key, name, identity_state) VALUES ('co_nf', $1, 'lost co', 'Lost Co', 'not_found')", [r.id]);
    const p = await person(r.id, "Ana Ruiz");
    await db.query("UPDATE contacts SET company_id = 'co_nf', dropped_at = NULL, drop_reason = NULL WHERE id = $1", [p.id]);
    const caseId = await db.tx((q) => openCase(q, { eventId: r.id, kind: "company_not_found", companyId: "co_nf", summary: "Which company?", facts: [] }));
    await answerCase(db, r.id, caseId!, "Maya Ortiz", "supply_domain", { domain: "banned.example" });
    expect((await person(r.id, "Ana Ruiz")).drop_reason).toBe("excluded_company");
  });
});

describe("an opt-out reaches the person everywhere", () => {
  const LIST = "Company,Name,Title,Email\nAcme,Ada Lovelace,VP Sales,ada@acme.com\n";
  it("keeps the name and company as well as the address", async () => {
    await recordOptOut(db, "Maya Ortiz", { email: "ada@acme.com", name: "Ada Lovelace", company: "Acme" });
    expect(await isOptedOut(db, { name_key: nameKey("Ada Lovelace"), company_key: companyKey("Acme") })).toBe(true);
  });
  it("starts a rebuild of the delivered Sheet, and a Sheet that cannot be matched says so", async () => {
    const id = await deliverEvent(db, LIST, {}, "One");
    const [kept] = await db.query<{ email: string }>("SELECT email FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND email IS NOT NULL LIMIT 1", [id]);
    await db.query("UPDATE events SET sheet_id = 'sheet1', sheet_url = 'https://docs.google.com/spreadsheets/d/sheet1/edit' WHERE id = $1", [id]);
    const readReview = vi.fn(async () => [["Decision"]]);
    const sheets = { ...mockSheets, enabled: true, readReview, readTab: async () => [["Name"]] };
    const app = createApp(db, { demo: true, sheets });
    const res = await app.request("/api/suppressions", { method: "POST", headers: { "x-actor": "Maya%20Ortiz", "content-type": "application/json" }, body: JSON.stringify({ email: kept.email }) });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(readReview).toHaveBeenCalled());
    await vi.waitFor(async () => expect((await db.query<{ sheet_error: string | null }>("SELECT sheet_error FROM events WHERE id = $1", [id]))[0].sheet_error).toBeTruthy());
  });
});

describe("an opt-out before the list is priced", () => {
  it("drops the person before Research can look them up", async () => {
    await recordOptOut(db, "Maya Ortiz", { name: "Bo Lee", company: "Acme Cloud" });
    const r = await researchWith(db, CSV, { specs, people: {} });
    expect((await person(r.id, "Bo Lee")).drop_reason).toBe("opted_out");
  });
  it("relabels someone already set aside, so they leave the Other attendees tab", async () => {
    const r = await researchWith(db, CSV, { specs, people: {} });
    await db.query("UPDATE contacts SET drop_reason = 'low_tier', dropped_at = now(), email = 'bo@acmecloud.example' WHERE event_id = $1 AND full_name = 'Bo Lee'", [r.id]);
    const out = await recordOptOut(db, "Maya Ortiz", { email: "bo@acmecloud.example" });
    expect(out.removed).toBe(0);
    expect(out.events).toEqual([r.id]);
    expect((await person(r.id, "Bo Lee")).drop_reason).toBe("opted_out");
  });
});

describe("a run never stops with a job marked running", () => {
  it("a failure between jobs pauses the event", async () => {
    const r = await researchWith(db, CSV, { specs, people: {} });
    await db.query("UPDATE events SET stage = 'researching', phase = 'identity' WHERE id = $1", [r.id]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await processEvent(db, r.id, { ...r.deps, vendorsFor: () => { throw new Error("boom"); } });
    errors.mockRestore();
    expect(await stage(r.id)).toBe("paused");
  });
  it("a review stage can pause and go back", async () => {
    const r = await researchWith(db, CSV, { specs, people: {} });
    expect(await stage(r.id)).toBe("ready_for_review");
    await moveEvent(db, r.id, "paused", "Events Desk");
    expect(await stage(r.id)).toBe("paused");
    await moveEvent(db, r.id, "ready_for_review", "Maya Ortiz");
    expect(await stage(r.id)).toBe("ready_for_review");
  });
  it("an outage met while closing a lost job pauses the event, and the resume carries on", async () => {
    let fail = true;
    const l = lab({ starter: () => { if (fail) throw new VendorError(0); } });
    const r = await delivered(l);
    const before = l.calls.start.length;
    await db.query("DELETE FROM waterfall_cache");
    await deadJob(r, "Bo Lee", { ...FIRST, finder: 1 }, "find");
    await processEvent(db, r.id, r.deps);
    expect(await stage(r.id)).toBe("paused");
    expect((await db.query("SELECT 1 FROM jobs WHERE event_id = $1 AND status = 'running' AND lease_until > now()", [r.id])).length).toBe(0);
    fail = false;
    await moveEvent(db, r.id, "finding_people", "Maya Ortiz");
    await processEvent(db, r.id, r.deps);
    expect(l.calls.start.length).toBe(before + 1);
    expect(await stage(r.id)).toBe("delivered");
  });
});

describe("a replay never pays again", () => {
  it("someone already kept is left alone", async () => {
    const l = lab();
    const r = await delivered(l);
    const before = { ...l.calls, find: l.calls.find.length };
    await deadJob(r, "Bo Lee", { ...FIRST, finder: 1, cand: [{ email: `bo@${ACME}`, source: "finder", state: "kept" }] });
    await processEvent(db, r.id, r.deps);
    expect(l.calls.find.length).toBe(before.find);
    expect((await person(r.id, "Bo Lee")).drop_reason).toBeNull();
  });
  it("a call left open by a stopped run is closed as a miss, never made again", async () => {
    const l = lab();
    const r = await delivered(l);
    const before = l.calls.find.length;
    await db.query("DELETE FROM waterfall_cache");
    const p = await person(r.id, "Bo Lee");
    await db.query("UPDATE contacts SET dropped_at = NULL, drop_reason = NULL, email_loop = $2::jsonb WHERE id = $1", [p.id, JSON.stringify({ ...FIRST, inflight: "find:0" })]);
    await db.query("INSERT INTO jobs (id, event_id, kind, payload) VALUES ($1, $2, 'find', $3::jsonb)", [newId("job"), r.id, JSON.stringify({ contact_id: p.id, index: 0 })]);
    await db.query("UPDATE events SET stage = 'finding_people' WHERE id = $1", [r.id]);
    await processEvent(db, r.id, r.deps);
    expect(l.calls.find.length).toBe(before);
  });
  it("two runs at once take the job once", async () => {
    const l = lab();
    const r = await delivered(l);
    const before = l.calls.find.length;
    await db.query("DELETE FROM waterfall_cache");
    const p = await person(r.id, "Bo Lee");
    await db.query("UPDATE contacts SET dropped_at = NULL, drop_reason = NULL, email_loop = $2::jsonb WHERE id = $1", [p.id, JSON.stringify(FIRST)]);
    await db.query("INSERT INTO jobs (id, event_id, kind, payload) VALUES ($1, $2, 'find', $3::jsonb)", [newId("job"), r.id, JSON.stringify({ contact_id: p.id, index: 0 })]);
    await db.query("UPDATE events SET stage = 'finding_people' WHERE id = $1", [r.id]);
    await Promise.all([processEvent(db, r.id, r.deps), processEvent(db, r.id, r.deps)]);
    expect(l.calls.find.length).toBe(before + 1);
  });
  it("nothing is paid for someone who came off the list while queued", async () => {
    const l = lab();
    const r = await delivered(l);
    const before = l.calls.linkedin.length;
    const p = await person(r.id, "Ana Ruiz");
    await db.query("UPDATE contacts SET dropped_at = now(), drop_reason = 'opted_out', linkedin = NULL WHERE id = $1", [p.id]);
    await db.query("INSERT INTO jobs (id, event_id, kind, payload) VALUES ($1, $2, 'linkedin', $3::jsonb)", [newId("job"), r.id, JSON.stringify({ contact_id: p.id })]);
    await db.query("UPDATE events SET stage = 'finding_people' WHERE id = $1", [r.id]);
    await processEvent(db, r.id, r.deps);
    expect(l.calls.linkedin.length).toBe(before);
  });
  it("the Apollo match bought in Research is not bought again in Outreach", async () => {
    const l = lab();
    const r = await researchWith(db, CSV, { specs, people: {}, tweak: l.tweak });
    await dbReveals(db, 180, r.id).put("apollo_person_match", `pm|bo lee|${companyKey("Acme Cloud")}`, { full_name: "Bo Lee", employer: "Acme Cloud", employer_domain: ACME, email: `bo@${ACME}`, email_verified: true, linkedin: null, vendor_person_id: "p9" });
    await outreachRun(db, r);
    expect(l.calls.find).not.toContain("Bo Lee");
    expect(JSON.stringify((await person(r.id, "Bo Lee")).email_loop)).toContain(`bo@${ACME}`);
  });
});

describe("live mode", () => {
  it("a person on the screen can set the budget though Slack approvers are Slack ids", async () => {
    const app = createApp(db, { demo: false, slack: { signingSecret: "s", botToken: "t", channel: "C", approvers: ["U1"] } as never });
    const res = await app.request("/api/budget/2027", { method: "PUT", headers: { "x-actor": "Dan%20Whitlock", "content-type": "application/json" }, body: JSON.stringify({ quarters: [1, 2, 3, 4] }) });
    expect(res.status).toBe(200);
  });
});
