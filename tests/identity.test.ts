import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { decideApproval } from "../src/server/approvals.ts";
import { answerCase, listCases } from "../src/server/cases.ts";
import type { Db } from "../src/server/db.ts";
import { createEvent, moveEvent } from "../src/server/events.ts";
import { apolloIdentity } from "../src/server/live-vendors.ts";
import { exampleDns, memoryReveals, resolveCompany, type ResolveEnv } from "../src/server/identity.ts";
import { processEvent, type Deps } from "../src/server/pipeline.ts";
import { mockCrm, mockLlm, mockVendors, VendorError, type CompanyCandidate, type Crm, type Identity, type Vendors } from "../src/server/providers.ts";
import { requestOutreachCard, requestResearchCard } from "../src/server/research.ts";
import { spendByStep } from "../src/server/ledger.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { fakeClock, UNLIMITED, VendorDown, VendorHealth } from "../src/server/vendor-health.ts";
import { companyKey } from "../src/shared/ingest.ts";
import { employerMatches, emailDomainChoice, nameScore, weigh } from "../src/shared/identity.ts";
import type { Settings } from "../src/shared/cost.ts";
import { freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock";
const s: Settings = JSON.parse(readFileSync("config/defaults.json", "utf8"));

/* A scripted identity vendor: a table of companies it knows, counters for what was asked. */
function scripted(known: CompanyCandidate[], opts: { people?: Record<string, { employer: string; domain: string }>; down?: { on: boolean }; throttle?: { on: boolean } } = {}) {
  const calls = { search: 0, probe: 0, person: 0, reverse: 0 };
  const id: Identity = {
    companySearch: {
      name: "search_x", probe: { query: "Known Probe", domain: "probe.example" },
      async search(q) {
        if (opts.down?.on) throw new VendorError(0);
        if (q === "Known Probe") { calls.probe++; return { candidates: opts.throttle?.on ? [] : [{ name: "Known Probe", domain: "probe.example" }], charged: 0 }; }
        calls.search++;
        if (opts.throttle?.on) return { candidates: [], charged: 0 };
        const k = companyKey(q);
        return { candidates: known.filter((c) => nameScore(k, companyKey(c.name)) >= 0.6), charged: 0 };
      },
    },
    personMatch: {
      name: "pm_x", cost: 1,
      async match(p) {
        calls.person++;
        const hit = opts.people?.[p.full_name];
        return { person: hit ? { vendor_person_id: `id_${p.full_name}`, full_name: p.full_name, email: "x@y.example", linkedin: null, employer: hit.employer, employer_domain: hit.domain } : null, charged: 1 };
      },
    },
    reverse: { name: "rev_x", cost: 1, async byEmail() { calls.reverse++; return { company: null, charged: 1 }; }, async byLinkedin() { calls.reverse++; return { company: null, charged: 1 }; } },
    dns: exampleDns,
  };
  return { id, calls };
}
const health = (clock = fakeClock()) => new VendorHealth({ clock, config: UNLIMITED });
const env = (id: Identity, extra: Partial<ResolveEnv> = {}): ResolveEnv => ({ health: health(), identity: id, country: null, ...extra });
const input = (name: string, evidence: { source: "email_domain" | "form_website"; value: string; rows: number }[] = [], people: string[] = []) => ({ key: companyKey(name), name, evidence, people: people.map((full_name) => ({ full_name })) });
const C = (name: string, domain: string, more: Partial<CompanyCandidate> = {}): CompanyCandidate => ({ name, domain, ...more });

describe("the evidence rules, in code", () => {
  it("takes a work email domain only when exactly one resembles the name", () => {
    expect(emailDomainChoice("flintbay works", [{ source: "email_domain", value: "flintbay.example", rows: 3 }])).toEqual({ domain: "flintbay.example", rows: 3 });
    expect(emailDomainChoice("flintbay works", [{ source: "email_domain", value: "gmail.com", rows: 5 }])).toBeNull();
    expect(emailDomainChoice("flintbay works", [{ source: "email_domain", value: "test.com", rows: 5 }])).toBeNull();
    // A company and a longer-named sibling both resemble the name, so counting rows cannot tell them apart.
    expect(emailDomainChoice("pebblemarsh fleet", [{ source: "email_domain", value: "pebblemarsh.example", rows: 2 }, { source: "email_domain", value: "pebblemarshfleetengineering.example", rows: 9 }])).toBeNull();
    expect(emailDomainChoice("northwind", [{ source: "email_domain", value: "unrelated.example", rows: 4 }])).toBeNull();
  });
  it("scores a shortened name below an exact one, and an unrelated one low", () => {
    expect(nameScore("lumdu", "lumdu")).toBe(1);
    expect(nameScore("lumd", "lumdu")).toBeGreaterThanOrEqual(0.8);
    expect(nameScore("velfen cloud", "velfen cloud telecom")).toBeLessThan(1);
    expect(nameScore("acme", "zebra holdings")).toBeLessThan(0.6);
  });
  it("accepts a person-match employer only when it matches the row's company", () => {
    expect(employerMatches("brightwater logistics", "brightwater logistics")).toBe(true);
    expect(employerMatches("brightwater logistics", "other co")).toBe(false);
  });
  it("weighs: exact wins, a close rival makes it ambiguous, the country or the file's address can separate", () => {
    const k = companyKey;
    const two = [C("Velfen Cloud", "velfen.example", { country: "Spain" }), C("Velfen Cloud Telecom", "velfencloudtelecom.example", { country: "Brazil" })];
    expect(weigh("velfen cloud", two, { candidateKey: k })).toMatchObject({ state: "resolved", via: "search" });
    // A typo that sits between two names the same distance away: ambiguous.
    const near = [C("Northwind Software", "northwindsoftware.example", { country: "Spain" }), C("Northwind Softwares", "northwindsoftwares.example", { country: "France" })];
    expect(weigh("northwind softwar", near, { candidateKey: k }).state).toBe("ambiguous");
    expect(weigh("northwind softwar", near, { candidateKey: k, country: "France" })).toMatchObject({ state: "resolved", via: "search+country", chosen: { domain: "northwindsoftwares.example" } });
    expect(weigh("northwind softwar", near, { candidateKey: k, emailDomain: "northwindsoftware.example" })).toMatchObject({ state: "resolved", via: "search+email" });
    // Both in the event's country: the country cannot separate them.
    expect(weigh("northwind softwar", near.map((c) => ({ ...c, country: "Spain" })), { candidateKey: k, country: "Spain" }).state).toBe("ambiguous");
    // The same domain twice (a subsidiary on its parent's domain) is one answer.
    expect(weigh("beldu", [C("Beldu", "beldu.example"), C("Beldu Assurance", "beldu.example", { parent_name: "Beldu", parent_domain: "beldu.example" })], { candidateKey: k }).state).toBe("resolved");
    expect(weigh("zzz", [C("Totally Different", "td.example")], { candidateKey: k }).state).toBe("none");
  });
});

describe("resolving one company", () => {
  it("uses free evidence first and asks no vendor", async () => {
    const v = scripted([]);
    const r = await resolveCompany(env(v.id), input("Tallgrass Software", [{ source: "email_domain", value: "tallgrass.example", rows: 2 }]));
    expect(r).toMatchObject({ state: "resolved", domain: "tallgrass.example", via: "email_domain", person_match: "none" });
    expect(v.calls).toEqual({ search: 0, probe: 0, person: 0, reverse: 0 });
  });
  it("searches by name, and keeps the parent", async () => {
    const v = scripted([C("Thorn Freight", "thorcalo.example", { parent_name: "Thorn & Calon Data", parent_domain: "thorcalo.example" })]);
    const r = await resolveCompany(env(v.id), input("Thorn Freight"));
    expect(r).toMatchObject({ state: "resolved", domain: "thorcalo.example", via: "search", parent_name: "Thorn & Calon Data" });
  });
  it("uses the website only if it resolves and nothing stronger disagrees", async () => {
    const v = scripted([C("Ardent Works", "ardentworks.example")]);
    // Nothing found by name: the website, which has a mail server, is used.
    expect(await resolveCompany(env(v.id), input("Quillon Holdings", [{ source: "form_website", value: "quillon.example", rows: 1 }]))).toMatchObject({ state: "resolved", via: "form_website", domain: "quillon.example" });
    // A strong search answer that names a different site beats the website.
    expect(await resolveCompany(env(v.id), input("Ardent Works", [{ source: "form_website", value: "someoneelse.example", rows: 1 }]))).toMatchObject({ domain: "ardentworks.example", via: "search" });
    // A website with no mail server does not resolve.
    expect((await resolveCompany(env(v.id), input("Quillon Holdings", [{ source: "form_website", value: "quillon.com", rows: 1 }]))).state).toBe("not_found");
  });
  it("makes one person match only when free evidence failed, and accepts it only at the same company", async () => {
    const v = scripted([], { people: { "Ana Ruiz": { employer: "Dunmore Payments", domain: "dunmore.example" }, "Bo Lee": { employer: "Some Other Co", domain: "other.example" } } });
    const pays: number[] = [];
    const pay: ResolveEnv["pay"] = async (run) => { pays.push(1); const o = await run(); return { kind: "ok", value: o.value }; };
    const ok = await resolveCompany(env(v.id, { pay }), input("Dunmore Payments", [], ["Ana Ruiz", "Cy Day"]));
    expect(ok).toMatchObject({ state: "resolved", via: "person_match", domain: "dunmore.example", person_match: "paid" });
    expect(pays).toHaveLength(1);
    // The right name at the wrong company is not accepted.
    const wrong = await resolveCompany(env(v.id, { pay }), input("Dunmore Payments", [], ["Bo Lee"]));
    expect(wrong).toMatchObject({ state: "not_found", person_match: "paid" });
    // Nobody with a full name: nothing to match.
    expect(await resolveCompany(env(v.id, { pay }), input("Harbor Logistics", [], ["Madonna"]))).toMatchObject({ state: "not_found", person_match: "none" });
  });
  it("never pays twice for the same question, a miss included", async () => {
    const v = scripted([], { people: { "Ana Ruiz": { employer: "Dunmore Payments", domain: "dunmore.example" } } });
    const reveals = memoryReveals();
    const e = env(v.id, { reveals });
    await resolveCompany(e, input("Dunmore Payments", [], ["Ana Ruiz"]));
    const again = await resolveCompany(env(v.id, { reveals }), input("Dunmore Payments", [], ["Ana Ruiz"]));
    expect(again).toMatchObject({ state: "resolved", person_match: "reused" });
    await resolveCompany(e, input("Nobody Inc", [], ["Zed Zed"]));
    await resolveCompany(e, input("Nobody Inc", [], ["Zed Zed"]));
    expect(v.calls.person).toBe(2);
  });
  it("is ambiguous when two close names cannot be separated, and not found when nothing fits", async () => {
    const v = scripted([C("Northwind Software", "nws.example"), C("Northwind Softwares", "nwss.example")]);
    const a = await resolveCompany(env(v.id), input("Northwind Softwar"));
    expect(a.state).toBe("ambiguous");
    expect(a.candidates!.map((c) => c.domain).sort()).toEqual(["nws.example", "nwss.example"]);
    expect((await resolveCompany(env(v.id), input("Qwxyz Corp"))).state).toBe("not_found");
  });
});

describe("the vendor guard", () => {
  it("opens the breaker after a run of failures, stays open for the cool-down, then lets one trial through", async () => {
    const clock = fakeClock();
    const h = new VendorHealth({ clock, config: { ...UNLIMITED, failure_threshold: 3, cooldown_ms: 10_000, retries: 0 } });
    const g = h.guard("v");
    for (let i = 0; i < 3; i++) await expect(g.call(async () => { throw new VendorError(0); })).rejects.toBeInstanceOf(VendorDown);
    expect(g.state).toBe("open");
    await expect(g.call(async () => "x")).rejects.toMatchObject({ reason: "breaker_open" });
    clock.advance(10_001);
    expect(await g.call(async () => "back")).toBe("back");
    expect(g.state).toBe("closed");
    // A failing trial closes the door again at once.
    for (let i = 0; i < 3; i++) await g.call(async () => { throw new VendorError(0); }).catch(() => {});
    clock.advance(10_001);
    await g.call(async () => { throw new VendorError(0); }).catch(() => {});
    expect(g.state).toBe("open");
  });
  it("paces calls to the rate limit", async () => {
    const clock = fakeClock();
    const g = new VendorHealth({ clock, config: { ...UNLIMITED, per_second: 2, burst: 2, backoff_ms: 0 } }).guard("v", { per_second: 2, burst: 2 });
    const t0 = clock.now();
    for (let i = 0; i < 6; i++) await g.call(async () => i);
    // Two in the burst, then four more at two a second.
    expect(clock.now() - t0).toBeGreaterThanOrEqual(2000);
    expect(clock.now() - t0).toBeLessThan(2600);
  });
  it("does not retry a paid call: the ledger decides what an unknown failure cost", async () => {
    const g = health().guard("v");
    let n = 0;
    await expect(g.call(async () => { n++; throw new VendorError("unknown"); }, { paid: true })).rejects.toBeInstanceOf(VendorError);
    expect(n).toBe(1);
  });
  it("an empty answer is final only after the known-good lookup passes; a failing probe means the vendor is throttling, never 'not found'", async () => {
    const throttle = { on: false };
    const v = scripted([C("Real Co", "real.example")], { throttle });
    const clock = fakeClock();
    const h = health(clock);
    const e = { health: h, identity: v.id, country: null };
    // Healthy: nothing found is a real answer, and it cost one probe.
    expect((await resolveCompany(e, input("Qwxyz Corp"))).state).toBe("not_found");
    expect(v.calls.probe).toBe(1);
    // Throttled: the vendor answers everything with an empty success. The company is real, and must not be reported missing.
    throttle.on = true;
    await expect(resolveCompany(e, input("Real Co"))).rejects.toMatchObject({ reason: "throttled" });
    expect(h.guard("search_x").stats.throttle_events).toBe(1);
    // Still backing off: no call goes out.
    const before = v.calls.search;
    await expect(resolveCompany(e, input("Real Co"))).rejects.toBeInstanceOf(VendorDown);
    expect(v.calls.search).toBe(before);
    // The throttle lifts and the back-off passes: the same company resolves.
    throttle.on = false;
    clock.advance(10_000);
    expect(await resolveCompany(e, input("Real Co"))).toMatchObject({ state: "resolved", domain: "real.example" });
  });
  it("a vendor that is down is VendorDown, not 'not found'", async () => {
    const down = { on: true };
    const v = scripted([C("Real Co", "real.example")], { down });
    await expect(resolveCompany(env(v.id), input("Real Co"))).rejects.toBeInstanceOf(VendorDown);
  });
});

/* ------------------------------------------------------------- in the pipeline */

let db: Db, id: string;
const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
const approve = async () => {
  const [a] = await db.query<{ id: string; kind: string }>("SELECT id, kind FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]);
  // Seats: Dan. A cost card: Maya, who uploaded the list.
  return decideApproval(db, { approvalId: a.id, actor: a.kind === "seats" ? DAN : MAYA, decision: "approve" });
};
async function researchEvent(csv: string, patch?: Record<string, unknown>) {
  id = (await createEvent(db, MAYA, { name: "Identity", starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100, country: "Spain", flow: "two_card" })).id;
  await approve();
  await ingestUpload(db, id, MAYA, "a.csv", csv);
  if (patch) await db.query("UPDATE event_settings SET settings = settings || $2::jsonb WHERE event_id = $1", [id, JSON.stringify(patch)]);
  await requestResearchCard(db, id, MAYA);
  await approve();
}
const withIdentity = (identity: Identity, crm?: Crm): Deps => ({ llm: mockLlm, vendorsFor: (st) => ({ ...mockVendors(st), identity }), ...(crm ? { crm } : {}) });
const stage = async () => (await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage;
const companies = () => db.query<{ name: string; primary_domain: string | null; identity_state: string; tier: number | null; list_status: string | null; merged_names: { name: string }[] }>("SELECT name, primary_domain, identity_state, tier, list_status, merged_names FROM companies WHERE event_id = $1 ORDER BY name", [id]);
const HEAD = "Company Name,First Name,Last Name,Job Title,Work Email\n";

beforeEach(async () => { db = await freshDb(); });

describe("stage 4 in the pipeline", () => {
  it("merges spellings that resolve to one domain into one company, moves their people, and keeps the other spellings", async () => {
    const v = scripted([C("Cobbleford Financial", "cobbleford.example"), C("Pinewood Labs", "pinewood.example")]);
    await researchEvent(HEAD + [
      "Cobbleford Financial,Ana,Ruiz,VP Sales,ana@cobbleford.example", "Cobblfeord Financial,Bo,Lee,Director of Sales,",
      "Cobbleford,Cy,Day,Sales Manager,", "Cobbleford Financial,Ana,Ruiz,VP Sales,", "Pinewood Labs,Di,Fay,VP Sales,",
    ].join("\n"));
    await processEvent(db, id, withIdentity(v.id));
    expect(await stage()).toBe("ready_for_review");
    const cos = await companies();
    expect(cos.map((c) => c.name)).toEqual(["Cobbleford Financial", "Pinewood Labs"]);
    expect(cos[0].merged_names.map((m) => m.name).sort()).toEqual(["Cobbleford", "Cobblfeord Financial"]);
    const people = await db.query<{ full_name: string; company: string; drop_reason: string | null }>("SELECT c.full_name, co.name AS company, c.drop_reason FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.event_id = $1 AND c.dropped_at IS NULL ORDER BY c.full_name", [id]);
    expect(people.filter((p) => p.company === "Cobbleford Financial").map((p) => p.full_name)).toEqual(["Ana Ruiz", "Bo Lee", "Cy Day"]);
    // Every row filed under a merged spelling remembers where it was filed.
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM source_rows WHERE event_id = $1 AND listed_name IS NOT NULL", [id]))[0].n).toBe(2);
    // The merged company was tiered once, after the merge.
    expect(cos.every((c) => c.tier !== null)).toBe(true);
    expect((await spendByStep(db, id)).find((x) => x.step === "company_tier")!.n).toBe(2);
  });

  it("drops a person who is on the list twice once the two spellings become one company", async () => {
    const v = scripted([C("Cobbleford Financial", "cobbleford.example")]);
    await researchEvent(HEAD + "Cobbleford Financial,Ana,Ruiz,VP Sales,ana@cobbleford.example\nCobblfeord Financial,Ana,Ruiz,VP Sales,\nCobblfeord Financial,Bo,Lee,VP Sales,bo@cobbleford.example");
    await processEvent(db, id, withIdentity(v.id));
    const live = await db.query<{ full_name: string }>("SELECT full_name FROM contacts WHERE event_id = $1 AND dropped_at IS NULL ORDER BY full_name", [id]);
    expect(live.map((p) => p.full_name)).toEqual(["Ana Ruiz", "Bo Lee"]);
    expect((await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND drop_reason = 'duplicate'", [id])).length).toBe(1);
  });

  it("opens an ambiguous_identity case that holds spend; a pick finishes the research", async () => {
    const v = scripted([C("Northwind Software", "nws.example"), C("Northwind Softwares", "nwss.example")]);
    await researchEvent(HEAD + "Northwind Softwar,Ana,Ruiz,VP Sales,\nTallgrass Software,Bo,Lee,VP Sales,bo@tallgrass.example");
    await processEvent(db, id, withIdentity(v.id));
    const [k] = await listCases(db, id);
    expect(k).toMatchObject({ kind: "ambiguous_identity", blocking: true, decision: null });
    expect(k.options.map((o) => (o as { value: string }).value)).toEqual(["pick:nws.example", "pick:nwss.example", "drop"]);
    await expect(requestOutreachCard(db, id, MAYA)).rejects.toThrow(/case is still open/);
    expect((await companies()).find((c) => c.name === "Northwind Softwar")!.tier).toBeNull();
    await answerCase(db, id, k.id, DAN, "pick:nwss.example");
    await processEvent(db, id, withIdentity(v.id));
    const co = (await companies()).find((c) => c.name === "Northwind Softwar")!;
    expect(co).toMatchObject({ primary_domain: "nwss.example", identity_state: "resolved" });
    expect(co.tier).not.toBeNull();
    await requestOutreachCard(db, id, MAYA);
  });

  it("opens company_not_found, and 'I know the website' finishes it; skipping drops it", async () => {
    const v = scripted([]);
    await researchEvent(HEAD + "Qwxyz Corp,Ana,Ruiz,VP Sales,\nTallgrass Software,Bo,Lee,VP Sales,bo@tallgrass.example\nVoid Works,Cy,Day,VP Sales,");
    await processEvent(db, id, withIdentity(v.id));
    const cases = await listCases(db, id);
    expect(cases.map((c) => c.kind)).toEqual(["company_not_found", "company_not_found"]);
    expect(cases[0].suggested).toBe("drop");
    const of = (name: string) => cases.find((c) => c.company === name)!;
    await answerCase(db, id, of("Qwxyz Corp").id, DAN, "supply_domain", { domain: "https://www.qwxyz.example/about" });
    await expect(answerCase(db, id, of("Void Works").id, DAN, "supply_domain", { domain: "gmail.com" })).rejects.toThrow(/own website/);
    await processEvent(db, id, withIdentity(v.id));
    expect((await companies()).find((c) => c.name === "Qwxyz Corp")).toMatchObject({ primary_domain: "qwxyz.example", identity_state: "resolved" });
  });

  it("a company-search outage waits and pauses the event; nothing becomes company_not_found; it resumes cleanly", async () => {
    const down = { on: true };
    const v = scripted([C("Dunmore Payments", "dunmore.example"), C("Quillmere Systems", "quillmere.example")], { down });
    await researchEvent(HEAD + "Dunmore Payments,Cy,Day,VP Sales,\nQuillmere Systems,Di,Fay,VP Sales,");
    const clock = fakeClock();
    const deps: Deps = { ...withIdentity(v.id), health: new VendorHealth({ clock, config: { ...UNLIMITED, failure_threshold: 3, cooldown_ms: 60_000, retries: 1 } }) };
    expect(await processEvent(db, id, deps)).toBe("paused");
    expect(await stage()).toBe("paused");
    expect(await listCases(db, id)).toEqual([]);
    expect((await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND drop_reason = 'company_not_found'", [id])).length).toBe(0);
    expect((await companies()).map((c) => c.identity_state)).toEqual(["unresolved", "unresolved"]);
    // The job is still on the queue, not closed as a miss.
    expect((await db.query("SELECT 1 FROM jobs WHERE event_id = $1 AND kind = 'identity' AND status = 'queued'", [id])).length).toBeGreaterThanOrEqual(1);
    expect((await db.query<{ detail: string }>("SELECT detail FROM activity_log WHERE event_id = $1 AND kind = 'stage' ORDER BY created_at DESC LIMIT 1", [id]))[0].detail).toMatch(/keeps failing/);
    // The vendor comes back; a person resumes.
    down.on = false;
    clock.advance(61_000);
    await moveEvent(db, id, "researching", MAYA, { detail: "Resumed" });
    await processEvent(db, id, deps);
    expect(await stage()).toBe("ready_for_review");
    expect((await companies()).map((c) => [c.name, c.identity_state])).toEqual([["Dunmore Payments", "resolved"], ["Quillmere Systems", "resolved"]]);
  });

  it("silent throttling pauses the event instead of reporting nobody found", async () => {
    const throttle = { on: true };
    const v = scripted([C("Dunmore Payments", "dunmore.example")], { throttle });
    await researchEvent(HEAD + "Dunmore Payments,Cy,Day,VP Sales,");
    const clock = fakeClock();
    const deps: Deps = { ...withIdentity(v.id), health: new VendorHealth({ clock, config: UNLIMITED }) };
    // The throttle lasts longer than the job will wait, so the event pauses.
    const stillOn = setInterval(() => {}, 1000); clearInterval(stillOn);
    expect(await processEvent(db, id, deps)).toBe("paused");
    expect(await listCases(db, id)).toEqual([]);
    expect((await companies())[0].identity_state).toBe("unresolved");
    throttle.on = false;
    clock.advance(400_000);
    await moveEvent(db, id, "researching", MAYA, { detail: "Resumed" });
    await processEvent(db, id, deps);
    expect((await companies())[0]).toMatchObject({ identity_state: "resolved", primary_domain: "dunmore.example" });
  });

  it("stores a person match as a reveal and never pays for it twice, across events", async () => {
    const v = scripted([], { people: { "Cy Day": { employer: "Dunmore Payments", domain: "dunmore.example" } } });
    await researchEvent(HEAD + "Dunmore Payments,Cy,Day,VP Sales,");
    await processEvent(db, id, withIdentity(v.id));
    expect(v.calls.person).toBe(1);
    expect((await spendByStep(db, id)).find((x) => x.step === "person_match")!.n).toBe(1);
    const [rev] = await db.query<{ vendor: string; vendor_person_id: string; email: string }>("SELECT vendor, vendor_person_id, email FROM reveals");
    expect(rev).toMatchObject({ vendor: "pm_x", vendor_person_id: "id_Cy Day" });
    // A second event with the same person asking the same question: answered from the store, for nothing.
    const first = id;
    await researchEvent(HEAD + "Dunmore Payments,Cy,Day,VP Sales,");
    await processEvent(db, id, withIdentity(v.id));
    expect(v.calls.person).toBe(1);
    expect((await spendByStep(db, id)).find((x) => x.step === "person_match")).toBeUndefined();
    expect((await companies())[0]).toMatchObject({ primary_domain: "dunmore.example", identity_state: "resolved" });
    expect(first).not.toBe(id);
  });

  it("holds the person match to the Research card's own cap, and says so in the case", async () => {
    const v = scripted([], { people: { "Cy Day": { employer: "Dunmore Payments", domain: "dunmore.example" } } });
    await researchEvent(HEAD + "Dunmore Payments,Cy,Day,VP Sales,\nEmberly Co,Di,Fay,VP Sales,");
    // The card priced one person match for two companies? It priced both. Take the cap down to nothing and the match is refused.
    await db.query("UPDATE cost_cards SET step_caps = jsonb_set(step_caps, '{person_match,credits}', '0') WHERE event_id = $1 AND kind = 'research'", [id]);
    await processEvent(db, id, withIdentity(v.id));
    expect(v.calls.person).toBe(0);
    const cases = await listCases(db, id);
    expect(cases.map((c) => c.kind)).toEqual(["company_not_found", "company_not_found"]);
    expect(JSON.stringify(cases[0].facts)).toMatch(/limit/);
  });

  it("runs a reverse lookup for a person with only an address, and drops one it cannot place", async () => {
    const v = scripted([]);
    v.id.reverse.byEmail = async (e) => ({ company: e.endsWith("@acme.example") ? C("Acme Rockets", "acme.example") : null, charged: 1 });
    await researchEvent("Company Name,Full Name,Work Email,LinkedIn URL\nTallgrass Software,Ana Ruiz,ana@tallgrass.example,\n,Sam Okafor,sam@acme.example,\n,Lee Park,lee@nowhere.example,\n,Pat Quinn,,https://www.linkedin.com/in/pat-quinn-1\n,Nobody,,\n");
    await processEvent(db, id, withIdentity(v.id));
    const drops = Object.fromEntries((await db.query<{ drop_reason: string; n: number }>("SELECT drop_reason, count(*)::int AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NOT NULL GROUP BY 1", [id])).map((r) => [r.drop_reason, r.n]));
    // Lee (not found) and Pat (LinkedIn the vendor cannot place) drop as no_company. "Nobody" had nothing at upload.
    // Lee's lookup found nothing, but a work address still says where Lee works. Pat has no address to fall back on.
    expect(drops).toEqual({ junk_row: 1, no_company: 1 });
    const sam = await db.query<{ company: string; domain: string }>("SELECT co.name AS company, co.primary_domain AS domain FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.full_name = 'Sam Okafor'");
    expect(sam[0]).toEqual({ company: "Acme Rockets", domain: "acme.example" });
    expect((await spendByStep(db, id)).find((x) => x.step === "reverse_lookup")!.n).toBe(3);
  });

  it("drops a spelling that resolves to a listed company's domain, and never lets a fuzzy match act alone", async () => {
    const v = scripted([C("Rivalcrest", "rivalcrest.example"), C("Pinewood Labs", "pinewood.example")]);
    // "Rivalcrest" (a shortened name) is a different string from the listed "Rivalcrest Systems"; the address domain ties them.
    await researchEvent(HEAD + "Rivalcrest Systems,Ed,Gray,VP Sales,ed@rivalcrest.example\nRivalcrest,Fi,Hart,VP Sales,\nPinewood Labs,Di,Fay,VP Sales,");
    await processEvent(db, id, withIdentity(v.id));
    const cos = await companies();
    expect(cos.map((c) => [c.name, c.list_status])).toEqual([["Pinewood Labs", null], ["Rivalcrest Systems", "excluded"]]);
    const dropped = await db.query<{ full_name: string; drop_reason: string }>("SELECT full_name, drop_reason FROM contacts WHERE event_id = $1 AND dropped_at IS NOT NULL ORDER BY full_name", [id]);
    expect(dropped).toEqual([{ full_name: "Ed Gray", drop_reason: "excluded_company" }, { full_name: "Fi Hart", drop_reason: "excluded_company" }]);
  });

  it("raises a subsidiary_inheritance case when a subsidiary's parent is a listed customer", async () => {
    const v = scripted([C("Pinefold Fleet", "pinefoldfleet.example", { parent_name: "Pinefold", parent_domain: "pinefold.example" })]);
    await researchEvent(HEAD + "Pinefold,Ed,Gray,VP Sales,ed@pinefold.example\nPinefold Fleet,Fi,Hart,VP Sales,", { existing_customers: ["Pinefold"] });
    await processEvent(db, id, withIdentity(v.id));
    const [k] = await listCases(db, id);
    expect(k).toMatchObject({ kind: "subsidiary_inheritance", blocking: true, suggested: "inherit" });
    expect(k.summary).toMatch(/subsidiary of Pinefold/);
    expect((await companies()).map((c) => c.name)).toContain("Pinefold Fleet");
    await answerCase(db, id, k.id, DAN, "independent");
    await processEvent(db, id, withIdentity(v.id));
    expect((await companies()).find((c) => c.name === "Pinefold Fleet")!.tier).not.toBeNull();
  });

  it("reads the CRM by domain, stores the account type, and asks when the CRM says customer and the list does not", async () => {
    const v = scripted([C("Dunmore Payments", "dunmore.example"), C("Quillmere Systems", "quillmere.example")]);
    const asked: string[] = [];
    const crm: Crm = {
      name: "crm_x", lookup: (c, d) => mockCrm.lookup(c, d),
      async lookupByDomain(domain, company, asOf) { asked.push(domain); return { ...(await mockCrm.lookup(company, asOf)), account_type: domain === "dunmore.example" ? "customer" : "prospect" }; },
    };
    await researchEvent(HEAD + "Dunmore Payments,Cy,Day,VP Sales,\nQuillmere Systems,Di,Fay,VP Sales,");
    await processEvent(db, id, withIdentity(v.id, crm));
    expect(asked.sort()).toEqual(["dunmore.example", "quillmere.example"]);
    const types = await db.query<{ name: string; account_type: string }>("SELECT name, account_type FROM companies WHERE event_id = $1 ORDER BY name", [id]);
    expect(types).toEqual([{ name: "Dunmore Payments", account_type: "customer" }, { name: "Quillmere Systems", account_type: "prospect" }]);
    const [k] = await listCases(db, id);
    expect(k).toMatchObject({ kind: "crm_customer_mismatch", suggested: "is_customer" });
    await answerCase(db, id, k.id, DAN, "is_customer");
    expect((await companies()).find((c) => c.name === "Dunmore Payments")!.list_status).toBe("existing_customer");
  });

  it("keeps tiering and everything after working on the merged companies, to delivery", async () => {
    const v = scripted([C("Cobbleford Financial", "cobbleford.example")]);
    await researchEvent(HEAD + "Cobbleford Financial,Ana,Ruiz,VP Sales,ana@cobbleford.example\nCobblfeord Financial,Bo,Lee,VP Sales,bo@cobbleford.example");
    const deps = withIdentity(v.id);
    await processEvent(db, id, deps);
    await requestOutreachCard(db, id, MAYA);
    await approve();
    expect(await processEvent(db, id, deps)).toBe("delivered");
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND priority IS NOT NULL", [id]))[0].n).toBeGreaterThan(0);
  });
});

describe("the Apollo identity adapters (faked responses; never run against the real service)", () => {
  const calls: { path: string; body: any }[] = [];
  const apollo = (reply: (path: string, body: any) => any) => async (path: string, body: unknown) => { calls.push({ path, body: body as any }); return reply(path, body); };
  it("reads organizations, people and reverse lookups defensively", async () => {
    const id = apolloIdentity(s, apollo((path) => path === "mixed_companies/search"
      ? { organizations: [{ name: "Brightwater Logistics", primary_domain: "brightwater.io", estimated_num_employees: 900, country: "Spain" }, { name: "No Domain Co" }, { name: "Site Only", website_url: "https://www.siteonly.com/about" }] }
      : { person: { id: "p1", name: "Maya Serrano", email: "Maya@Brightwater.io", linkedin_url: "http://www.linkedin.com/in/maya-serrano", title: "VP Sales", organization: { name: "Brightwater Logistics", primary_domain: "brightwater.io" } } }));
    const found = await id.companySearch.search("Brightwater", { country: "Spain" });
    expect(found.charged).toBe(0);
    expect(found.candidates.map((c) => [c.name, c.domain])).toEqual([["Brightwater Logistics", "brightwater.io"], ["Site Only", "siteonly.com"]]);
    expect(calls[0]).toMatchObject({ path: "mixed_companies/search", body: { q_organization_name: "Brightwater", per_page: 5 } });
    const pm = await id.personMatch.match({ first: "Maya", last: "Serrano", full_name: "Maya Serrano", company: "Brightwater" });
    expect(pm.charged).toBe(s.research.person_match_cost);
    expect(pm.person).toMatchObject({ vendor_person_id: "p1", email: "maya@brightwater.io", employer: "Brightwater Logistics", employer_domain: "brightwater.io" });
    expect(calls[1].body).toMatchObject({ first_name: "Maya", last_name: "Serrano", organization_name: "Brightwater" });
    expect((await id.reverse.byEmail("maya@brightwater.io")).company).toMatchObject({ domain: "brightwater.io" });
    expect(calls[2].body).toEqual({ email: "maya@brightwater.io" });
    expect((await id.reverse.byLinkedin("https://www.linkedin.com/in/maya-serrano")).charged).toBe(s.research.reverse_lookup_cost);
  });
  it("treats a locked email as no email and an empty person as a charged miss", async () => {
    const id = apolloIdentity(s, apollo(() => ({ person: { id: "p2", name: "X Y", email: "email_not_unlocked@domain.com", organization: { name: "Z", primary_domain: "z.io" } } })));
    expect((await id.personMatch.match({ first: "X", last: "Y", full_name: "X Y", company: "Z" })).person!.email).toBeNull();
    const none = apolloIdentity(s, apollo(() => ({ person: null })));
    expect(await none.personMatch.match({ first: "X", last: "Y", full_name: "X Y", company: "Z" })).toEqual({ person: null, charged: s.research.person_match_cost });
    expect(none.companySearch.probe).toEqual({ query: "Apollo.io", domain: "apollo.io" });
  });
});
