import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { demoIcp } from "../src/evals/company-tier.ts";
import type { Db } from "../src/server/db.ts";
import { apolloPeopleSearch } from "../src/server/live-vendors.ts";
import { spendByStep } from "../src/server/ledger.ts";
import { adjustTier, FUNCTIONS, matchPersona, normalizeTitle, parseTitle, personaTier, rankPeople, validTitleParse, type Candidate } from "../src/shared/titles.ts";
import { freshDb } from "./helpers.ts";
import { company, companyRows, found, HEAD, llmCalls, outreachRun, researchWith, row, scriptedLlm } from "./tier-helpers.ts";

const icp = demoIcp();
let db: Db;
beforeEach(async () => { db = await freshDb(); });

describe("title parsing, rules first", () => {
  const p = (t: string) => { const x = parseTitle(t); return `${x.function}/${x.seniority}${x.non_buyer ? "/nb" : ""}${x.placed ? "" : "/unplaced"}`; };
  it("reads English titles, abbreviations and ranks", () => {
    expect(p("VP of Sales")).toBe("sales/vp");
    expect(p("Sr. Director, Business Development")).toBe("sales/director");
    expect(p("Head of Revenue Operations")).toBe("revenue_operations/vp");
    expect(p("Chief Marketing Officer")).toBe("marketing/c_level");
    expect(p("CRO")).toBe("sales/c_level");
    expect(p("Founder & CEO")).toBe("executive/owner");
    expect(p("Senior Account Executive")).toBe("sales/senior");
    expect(p("Customer Success Manager")).toBe("customer_success/manager");
    expect(p("Software Engineer")).toBe("engineering/individual");
  });
  it("reads Spanish, Portuguese, French and German", () => {
    expect(p("Gerente de Ventas")).toBe("sales/manager");
    expect(p("Directora Comercial")).toBe("sales/director");
    expect(p("Director General")).toBe("executive/c_level");
    expect(p("Responsable de Alianzas")).toBe("partnerships/manager");
    expect(p("Gerente de Éxito del Cliente")).toBe("customer_success/manager");
    expect(p("Diretor Comercial")).toBe("sales/director");
    expect(p("Directeur des Ventes")).toBe("sales/director");
    expect(p("Geschäftsführer")).toBe("executive/c_level");
  });
  it("strips region tails and brackets, and spots interns, students and assistants", () => {
    expect(normalizeTitle("VP, Sales - EMEA")).toBe("vice president sales");
    expect(p("Chief Revenue Officer (CRO)")).toBe("sales/c_level");
    expect(p("Assistant to the VP of Sales")).toBe("admin/individual/nb");
    expect(p("Practicante de Ventas")).toBe("sales/individual/nb");
    expect(p("Student")).toBe("other/individual/nb");
    expect(parseTitle("Former VP Sales").former).toBe(true);
  });
  it("leaves what it cannot place for the model: bare ranks, and chief officers of something unlisted", () => {
    for (const t of ["Manager", "Director", "Specialist", "Chief Happiness Officer", "Chief Vibes Officer", "Global Head of Strategic Synergies"]) expect(parseTitle(t).placed, t).toBe(false);
    expect(parseTitle("").placed).toBe(false);
  });
  it("accepts only closed lists from the model", () => {
    expect(validTitleParse({ function: "sales", seniority: "vp", non_buyer: false })).toEqual({ function: "sales", seniority: "vp", non_buyer: false });
    expect(validTitleParse({ function: "wizard", seniority: "vp" })).toBeNull();
    expect(validTitleParse({ function: "sales", seniority: "boss" })).toBeNull();
    expect(validTitleParse("sales")).toBeNull();
    expect(FUNCTIONS).toContain("other");
  });
});

describe("persona tiers and adjustments from the pinned ICP", () => {
  const tier = (t: string) => personaTier(parseTitle(t), icp.personas);
  it("tiers 1 for revenue leadership and top executives, 2 for sales managers and go-to-market, 3 for the rest", () => {
    expect([tier("VP Sales"), tier("Chief Executive Officer"), tier("Founder"), tier("Chief Financial Officer")]).toEqual([1, 1, 1, 1]);
    expect([tier("Sales Manager"), tier("Director of Marketing"), tier("Account Executive"), tier("Customer Success Manager"), tier("VP Marketing")]).toEqual([2, 2, 2, 2, 2]);
    expect([tier("Software Engineer"), tier("VP Engineering"), tier("Accountant"), tier("Marketing Intern"), tier("Executive Assistant")]).toEqual([3, 3, 3, 3, 3]);
    expect(tier("Chief Happiness Officer")).toBeNull();
  });
  it("does not make a buyer of rank alone: a chief officer only the model could read needs a persona for the function it was read as", () => {
    const read = (fn: string, sen: "c_level" | "owner" = "c_level") => personaTier({ function: fn as never, seniority: sen, non_buyer: false, former: false, placed: true }, icp.personas);
    // The real model read "Chief Vibes Officer" as hr, c_level. It used to be tier 1.
    expect(read("hr")).toBe(3);
    expect(read("other")).toBe(3);
    // A function the personas cover, and the whole company, still rank 1; an owner is an owner whatever the function.
    expect(read("sales")).toBe(1);
    expect(read("executive")).toBe(1);
    expect(read("other", "owner")).toBe(1);
    // A go-to-market function outside the personas is still at least 2.
    expect(read("partnerships")).toBe(2);
    // A chief officer the rules read keeps the hand-labeled rank 1.
    expect([tier("Chief Technology Officer"), tier("Chief Operating Officer")]).toEqual([1, 1]);
  });
  it("keeps a function that sat in a region tail, and does not read a vice president as the whole company", () => {
    expect(parseTitle("Vice President, Worldwide Marketing")).toMatchObject({ function: "marketing", seniority: "vp", placed: true });
    expect(parseTitle("VP Sales, EMEA")).toMatchObject({ function: "sales", seniority: "vp" });
    // A bare vice president or director has no function: the model reads it. It was "executive" because "president" is inside "vice president".
    expect(parseTitle("Vice President").placed).toBe(false);
    expect(parseTitle("Vicepresidente").placed).toBe(false);
    expect(parseTitle("Chief Executive Officer")).toMatchObject({ function: "executive", seniority: "c_level" });
    expect(parseTitle("Presidente")).toMatchObject({ function: "executive", seniority: "c_level" });
  });
  it("reads the feminine forms of the ranks it already reads in the masculine", () => {
    expect(parseTitle("Vicepresidenta de Marketing")).toMatchObject({ function: "marketing", seniority: "vp" });
    expect(parseTitle("Presidenta")).toMatchObject({ function: "executive", seniority: "c_level" });
    expect(parseTitle("Dueña")).toMatchObject({ seniority: "owner" });
  });
  it("matches a persona only inside its seniority range", () => {
    expect(matchPersona(parseTitle("VP Sales"), icp.personas).priority).toBe("primary");
    expect(matchPersona(parseTitle("Sales Manager"), icp.personas).priority).toBe("secondary");
    expect(matchPersona(parseTitle("Account Executive"), icp.personas).priority).toBeNull();
  });
  it("applies the ICP's adjustments by company type and size: a VP at a bank ranks lower, a founder of a tiny company ranks higher", () => {
    const vp = parseTitle("VP Marketing"), founder = parseTitle("Founder");
    expect(adjustTier(2, vp, icp, { company_type: "financial_institution", employees: 4000 })).toBe(3);
    expect(adjustTier(2, vp, icp, { company_type: "software_vendor", employees: 4000 })).toBe(2);
    expect(adjustTier(2, founder, icp, { company_type: "software_vendor", employees: 30 })).toBe(1);
    expect(adjustTier(2, founder, icp, { company_type: "software_vendor", employees: 300 })).toBe(2);
    // The ends are clamped.
    expect(adjustTier(3, vp, icp, { company_type: "financial_institution", employees: 1 })).toBe(3);
  });
});

describe("ranking", () => {
  const c = (id: string, o: Partial<Candidate> = {}): Candidate => ({ id, tier: 2, function: "sales", persona_priority: null, updated_at: "2026-10-01", has_email: true, country: "Spain", ...o });
  const opt = { country: "Spain", today: "2026-11-08", freshness_days: 180 };
  it("puts a primary persona before a secondary one, and a better tier before a worse", () => {
    const r = rankPeople([c("b", { persona_priority: "secondary" }), c("a", { persona_priority: "primary", tier: 1 }), c("x")], 3, opt);
    expect(r.map((x) => x.id)).toEqual(["a", "b", "x"]);
  });
  it("ranks an old record lower, but does not treat its date as proof of anything else", () => {
    const r = rankPeople([c("old", { updated_at: "2025-01-01", function: "sales" }), c("new", { function: "sales" })], 2, opt);
    expect(r.map((x) => x.id)).toEqual(["new", "old"]);
  });
  it("prefers the event's region, and a vendor-reported email", () => {
    expect(rankPeople([c("far", { country: "France" }), c("near")], 2, opt)[0].id).toBe("near");
    expect(rankPeople([c("none", { has_email: false }), c("yes")], 2, opt)[0].id).toBe("yes");
  });
  it("takes variety across functions before a second person from one function, within the quota", () => {
    const r = rankPeople([c("s1", { tier: 1, persona_priority: "primary" }), c("s2", { tier: 1, persona_priority: "primary" }), c("m1", { function: "marketing" }), c("p1", { function: "partnerships" })], 3, opt);
    expect(r.map((x) => x.id).sort()).toEqual(["m1", "p1", "s1"]);
  });
  it("is repeatable and never returns more than the quota", () => {
    const many = Array.from({ length: 12 }, (_, i) => c(`p${i}`));
    expect(rankPeople(many, 3, opt)).toEqual(rankPeople([...many].reverse(), 3, opt));
    expect(rankPeople(many, 3, opt)).toHaveLength(3);
  });
});

const HARBOR = "harborlogistics.example", ACME_D = "acmecloud.example";
const soft = { employees: 900, industry: "B2B software", business_model: "B2B", country: "Spain" };
const CSV = HEAD + row("Acme Cloud", ACME_D, "Ana Ruiz") + "Harbor Logistics,,,,\n";
const specs = { [ACME_D]: { search: soft }, [HARBOR]: { search: { ...soft, industry: "logistics technology" } } };

async function harbor(people: ReturnType<typeof found>[], more: Partial<Parameters<typeof researchWith>[2]> = {}) {
  const r = await researchWith(db, CSV, { specs, people: { [HARBOR]: people }, ...more });
  await outreachRun(db, r);
  return r;
}
const prospects = (id: string) => db.query<{ full_name: string; title: string; priority: string; title_tier: number; vendor_person_id: string; drop_reason: string | null }>("SELECT full_name, title, priority, title_tier, vendor_person_id, drop_reason FROM contacts WHERE event_id = $1 AND source = 'prospect' ORDER BY full_name", [id]);

describe("the free people search in the Outreach flow", () => {
  const six = () => [
    found("p1", "Ana", "Vega", "VP Sales"), found("p2", "Bo", "Lund", "Director of Sales"), found("p3", "Cy", "Moss", "Software Engineer"), found("p4", "Di", "Ford", "Marketing Intern"),
    found("p5", "Ed", "Park", "Head of Marketing"), found("p6", "Fay", "Ito", "Account Executive"), found("p7", "Gil", "Roe", "Chief Executive Officer"), found("p8", "Hal", "Cox", "Customer Success Manager"),
  ];
  it("stops C before anything is stored, keeps tier 1 up to the quota of 5, and spends no credit on the search", async () => {
    const r = await harbor(six());
    const got = await prospects(r.id);
    expect(got.length).toBeLessThanOrEqual(5);
    expect(got.length).toBeGreaterThan(0);
    // The engineer and the intern are priority C at a tier 1 company: never stored, so never paid for.
    expect(got.map((g) => g.title)).not.toContain("Software Engineer");
    expect(got.map((g) => g.title)).not.toContain("Marketing Intern");
    expect(got.every((g) => g.priority === "A" || g.priority === "B")).toBe(true);
    // The VP of Sales and the CEO are A at a tier 1 company.
    expect(got.filter((g) => g.priority === "A").map((g) => g.title).sort()).toEqual(expect.arrayContaining(["Chief Executive Officer", "VP Sales"]));
    const spent = await spendByStep(db, r.id);
    expect(spent.find((s) => s.step === "discovery")).toBeUndefined();
    // The search asked the pinned ICP's persona titles, in the event's country, for up to four times the quota.
    expect(r.searches[0]).toMatchObject({ domain: HARBOR, country: "Spain", limit: 20 });
    expect(r.searches[0].titles).toEqual(expect.arrayContaining(["VP Sales"]));
  });
  it("uses a tier 2 company's quota of 3", async () => {
    const r = await researchWith(db, CSV, { specs: { ...specs, [HARBOR]: { search: { employees: 90, industry: "logistics technology", business_model: "B2B" } } }, people: { [HARBOR]: six() } });
    expect((await company(db, r.id, "Harbor Logistics")).tier).toBe(2);
    await outreachRun(db, r);
    expect((await prospects(r.id)).length).toBeLessThanOrEqual(3);
  });
  it("ranks a person with a hidden last name like anyone else, and reveals them (paid) only after ranking", async () => {
    const r = await harbor([found("h1", "Ana", null, "VP Sales"), found("h2", "Bo", "Lund", "Director of Sales")]);
    const got = await db.query<{ vendor_person_id: string; full_name: string; name_hidden: boolean; employer: string | null }>("SELECT vendor_person_id, full_name, name_hidden, employer FROM contacts WHERE event_id = $1 AND source = 'prospect' ORDER BY vendor_person_id", [r.id]);
    expect(got.map((g) => g.vendor_person_id)).toEqual(["h1", "h2"]);
    // The reveal gave the hidden person a last name and an employer; the visible one was revealed too (it is the first lookup of every discovered person).
    expect(got[0].name_hidden).toBe(false);
    expect(got[0].full_name.split(" ").length).toBe(2);
    expect(got[0].employer).toBe("Harbor Logistics");
    const [a] = await db.query<{ result: string }>("SELECT result FROM enrichment_attempts WHERE event_id = $1 AND step = 'people_search'", [r.id]);
    expect(a.result).toMatch(/1 with a hidden last name/);
    expect((await spendByStep(db, r.id)).find((s) => s.step === "reveal")!.n).toBe(2);
  });
  it("dedupes by the vendor's person id and by a visible name already on the list, before anything is stored", async () => {
    const csv = HEAD + row("Acme Cloud", ACME_D, "Ana Ruiz") + row("Harbor Logistics", HARBOR, "Ana Vega");
    const r = await researchWith(db, csv + "Harbor Logistics,,,,\n", { specs, people: { [HARBOR]: [found("p1", "Ana", "Vega", "VP Sales"), found("p2", "Bo", "Lund", "VP Sales"), found("p2", "Bo", "Lund", "VP Sales")] } });
    await outreachRun(db, r);
    expect((await prospects(r.id)).map((g) => g.full_name)).toEqual(["Bo Lund"]);
  });
  it("never cuts attendees by the quota", async () => {
    const attendees = ["Ana", "Bo", "Cy", "Di", "Ed", "Fay", "Gil", "Hal"].map((n) => row("Harbor Logistics", HARBOR, `${n} Vega`)).join("");
    const r = await researchWith(db, HEAD + attendees + row("Acme Cloud", ACME_D), { specs, people: { [HARBOR]: six() } });
    await outreachRun(db, r);
    const live = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND source = 'attendee' AND company_id = (SELECT id FROM companies WHERE event_id = $1 AND name = 'Harbor Logistics') AND drop_reason IS DISTINCT FROM 'low_tier'", [r.id]);
    expect(live[0].n).toBe(8);
    expect((await prospects(r.id)).length).toBeLessThanOrEqual(5);
  });
  it("reads a title the rules cannot place with the model once, caches it, and counts it against the Outreach card", async () => {
    const llm = scriptedLlm((step, input) => (step === "title_parse" ? { function: "executive", seniority: "c_level", non_buyer: false } : { tier: "unknown", segment: null, company_type: null, reason: "insufficient_information", fact: null }));
    const csv = HEAD + row("Acme Cloud", ACME_D);
    const first = await researchWith(db, csv + "Harbor Logistics,,,,\n", { specs, people: { [HARBOR]: [found("p1", "Ana", "Vega", "Chief Vibes Officer")] }, llm: Object.assign(Object.create(null), { model: "m", n: llm.n, complete: async (step: string, prompt: string) => (step === "company_tier" || step === "second_look" ? (await import("./tier-helpers.ts")).reader().complete(step as never, prompt) : llm.complete(step as never, prompt)) }) });
    await outreachRun(db, first);
    expect((await llmCalls(db, first.id)).title_parse).toBe(1);
    expect((await prospects(first.id))[0]).toMatchObject({ title: "Chief Vibes Officer", priority: "A" });
    const caps = (await db.query<{ step_caps: Record<string, { llm?: number }> }>("SELECT step_caps FROM cost_cards WHERE event_id = $1 AND kind = 'outreach'", [first.id]))[0].step_caps;
    expect((await spendByStep(db, first.id)).find((s) => s.step === "title_parse")!.n).toBeLessThanOrEqual(caps.title_parse.llm!);
    // Another event with the same ICP version reads it from the cache.
    const second = await researchWith(db, csv + "Harbor Logistics,,,,\n", { specs, people: { [HARBOR]: [found("p9", "Bo", "Lund", "Chief Vibes Officer")] }, name: "Second", llm: first.deps.llm });
    await outreachRun(db, second);
    expect((await llmCalls(db, second.id)).title_parse).toBeUndefined();
  });
  it("leaves a title unplaced, and stores nobody, when the card has no model calls left for it", async () => {
    const r = await researchWith(db, CSV, { specs, people: { [HARBOR]: [found("p1", "Ana", "Vega", "Chief Vibes Officer")] } });
    const { requestOutreachCard } = await import("../src/server/research.ts");
    await requestOutreachCard(db, r.id, "Maya Ortiz");
    await db.query("UPDATE cost_cards SET step_caps = jsonb_set(step_caps, '{title_parse,llm}', '0') WHERE event_id = $1 AND kind = 'outreach'", [r.id]);
    const a = (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [r.id]))[0].id;
    const { decideApproval } = await import("../src/server/approvals.ts");
    await decideApproval(db, { approvalId: a, actor: "Maya Ortiz", decision: "approve" });
    const { processEvent } = await import("../src/server/pipeline.ts");
    await processEvent(db, r.id, r.deps);
    expect(await prospects(r.id)).toEqual([]);
    expect((await db.query<{ drop_reason: string }>("SELECT drop_reason FROM source_rows WHERE event_id = $1 AND kind = 'company_only'", [r.id]))[0].drop_reason).toBe("no_people_found");
  });
  it("drops a company-only row as no_people_found when nobody comes back", async () => {
    const r = await harbor([]);
    expect((await db.query<{ drop_reason: string }>("SELECT drop_reason FROM source_rows WHERE event_id = $1 AND kind = 'company_only'", [r.id]))[0].drop_reason).toBe("no_people_found");
    expect((await db.query("SELECT 1 FROM source_rows WHERE drop_reason = 'no_contacts_found'")).length).toBe(0);
  });
  it("renames no_contacts_found in every stored row, and shared labels still know the old name", async () => {
    const r = await harbor([]);
    await db.query("UPDATE source_rows SET drop_reason = 'no_contacts_found' WHERE event_id = $1 AND dropped_at IS NOT NULL", [r.id]);
    for (const stmt of readFileSync("migrations/0013_people.sql", "utf8").split("\n").filter((l) => l.startsWith("UPDATE"))) await db.query(stmt.replace(/;$/, ""));
    expect((await db.query("SELECT 1 FROM source_rows WHERE drop_reason = 'no_contacts_found'")).length).toBe(0);
    expect((await db.query("SELECT 1 FROM source_rows WHERE drop_reason = 'no_people_found'")).length).toBeGreaterThan(0);
    const { dropLabel } = await import("../src/shared/domain.ts");
    expect(dropLabel("no_contacts_found")).not.toBe("");
    expect(dropLabel("no_people_found")).toBe("No people found");
  });
  it("replaces the keyword table's guess for attendees: a VP of Engineering is not a tier 1 buyer", async () => {
    const csv = HEAD + "Acme Cloud,Ann,Eng,VP Engineering,ann@acmecloud.example\nAcme Cloud,Bea,Sal,VP Sales,bea@acmecloud.example\n";
    const r = await researchWith(db, csv, { specs });
    await outreachRun(db, r);
    const pr = Object.fromEntries((await db.query<{ full_name: string; priority: string | null; drop_reason: string | null }>("SELECT full_name, priority, drop_reason FROM contacts WHERE event_id = $1 AND source = 'attendee'", [r.id])).map((x) => [x.full_name, x]));
    expect(pr["Ann Eng"].drop_reason).toBe("low_tier");
    expect(pr["Bea Sal"].priority).toBe("A");
  });
  it("never turns a company whose tier is Unknown into a priority: its people stop with a reason, and it is not searched", async () => {
    const r = await researchWith(db, CSV, { specs, people: { [HARBOR]: [found("p1", "Ana", "Vega", "VP Sales")] } });
    await db.query("UPDATE companies SET tier = NULL WHERE event_id = $1", [r.id]);
    await outreachRun(db, r);
    const rows = await db.query<{ priority: string | null; drop_reason: string | null }>("SELECT priority, drop_reason FROM contacts WHERE event_id = $1", [r.id]);
    expect(rows.every((x) => x.priority === null && x.drop_reason === "tiering_failed")).toBe(true);
    expect(r.searches).toEqual([]);
    expect((await prospects(r.id))).toEqual([]);
    expect((await companyRows(db, r.id)).every((c) => c.tier === null)).toBe(true);
  });
  it("without a pinned ICP keeps the keyword table for titles, and still searches for free", async () => {
    const r = await researchWith(db, CSV, { specs, icp: false, people: { [HARBOR]: [found("p1", "Ana", "Vega", "VP Sales"), found("p2", "Cy", "Moss", "Intern")] } });
    await outreachRun(db, r);
    const got = await prospects(r.id);
    expect(got.map((g) => g.title)).toEqual(["VP Sales"]);
    expect((await spendByStep(db, r.id)).find((s) => s.step === "discovery")).toBeUndefined();
  });
});

describe("the Apollo people search, on faked responses", () => {
  it("calls the free search once, hides what is obfuscated, and makes no reveal call", async () => {
    const seen: { path: string; payload: any }[] = [];
    const ps = apolloPeopleSearch(async (path, payload) => {
      seen.push({ path, payload });
      return { people: [
        { id: "a1", first_name: "Ana", last_name_obfuscated: "Ru***z", title: "VP Sales", last_refreshed_at: "2026-10-01T00:00:00.000+00:00", has_email: true },
        { id: "a2", first_name: "Bo", last_name: "Lund", title: "Director of Sales", has_email: false },
        { id: "a3", first_name: "NoTitle" }, { first_name: "NoId", title: "x" },
      ] };
    });
    const r = await ps.search({ domain: "acme.com", company: "Acme", titles: ["VP Sales"], country: "Spain", limit: 10 });
    expect(seen.map((s) => s.path)).toEqual(["mixed_people/api_search"]);
    expect(seen[0].payload).toMatchObject({ q_organization_domains_list: ["acme.com"], person_titles: ["VP Sales"], per_page: 10 });
    expect(r.charged).toBe(0);
    expect(r.people.map((p) => [p.vendor_person_id, p.last_name, p.updated_at, p.has_email])).toEqual([["a1", null, "2026-10-01", true], ["a2", "Lund", null, false], ["a3", null, null, null]]);
  });
});
