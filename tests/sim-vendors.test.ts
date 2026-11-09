import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { loadWorld, SIM_RATES, simLlm, simVendors, type SimEvent } from "../src/server/sim-vendors.ts";
import { VendorError } from "../src/server/providers.ts";
import { fill } from "../src/server/prompts.ts";
import type { Settings } from "../src/shared/cost.ts";
import type { World } from "../src/shared/world.ts";

const s: Settings = JSON.parse(readFileSync("config/defaults.json", "utf8"));
let world: World;
beforeAll(() => { world = loadWorld(); });
afterEach(() => vi.restoreAllMocks());

const settle = async <T>(p: Promise<T>): Promise<T | "error"> => p.catch((e) => { if (e instanceof VendorError) return "error" as const; throw e; });
const share = (n: number, of: number) => n / of;
const near = (actual: number, stated: number, tol: number) => Math.abs(actual - stated) <= tol;

describe("simulated finders", () => {
  it("make no network call at all", async () => {
    const f = vi.fn(() => { throw new Error("network"); });
    vi.stubGlobal("fetch", f);
    const v = simVendors(world, s);
    const p = world.people.find((x) => x.attending && x.company_id)!;
    const c = world.companies.find((x) => x.id === p.company_id)!;
    await settle(v.finders[0].find({ full_name: p.full_name, company: c.name }));
    await settle(v.verifiers[0].verify(p.email));
    await settle(v.discovery.find(c.name, 3));
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  for (const [i, finder] of SIM_RATES.finder.entries()) {
    it(`finder ${i + 1} agrees with truth except at its stated rates`, async () => {
      const events: SimEvent[] = [];
      const v = simVendors(world, s, { audit: (e) => events.push(e) });
      const rows = world.people.filter((p) => p.attending && p.kind === "employee" && p.there && p.company_id);
      let errors = 0;
      for (const p of rows) {
        const c = world.companies.find((x) => x.id === p.company_id)!;
        const r = await settle(v.finders[i].find({ full_name: p.full_name, company: c.name }));
        if (r === "error") { errors++; continue; }
        // A hit is the true address. A wrong pattern is on the right domain and never the true address.
        if (r.value) {
          const klass = events[events.length - 1].klass;
          if (klass === "hit" || klass === "stale_match" || klass === "homonym") expect(world.people.some((q) => q.email === r.value)).toBe(true);
          if (klass === "hit") expect(r.value).toBe(p.email);
          if (klass === "wrong_pattern") { expect(r.value).not.toBe(p.email); expect(r.value!.endsWith(`@${c.domain}`)).toBe(true); }
        }
      }
      const done = events.filter((e) => e.op === "find");
      const n = done.length;
      const k = (c: string) => done.filter((e) => e.klass === c).length;
      expect(near(share(k("hit"), n), finder.hit, 0.04)).toBe(true);
      expect(near(share(k("wrong_pattern"), n), finder.wrong_pattern, 0.025)).toBe(true);
      expect(share(errors, rows.length)).toBeLessThan(finder.error + 0.02);
      expect(k("stale_match") + k("homonym")).toBeLessThan(n * 0.03);
    });
  }

  it("bills Apollo's match on a miss, as the adapter does", async () => {
    const v = simVendors(world, s);
    const nobody = { full_name: "Zzyzx Qwertz", company: world.companies[5].name };
    expect((await v.finders[0].find(nobody)).charged).toBe(s.finders[0].cost);
    expect(v.finders).toHaveLength(1);
    expect(v.verifiers).toHaveLength(1);
  });

  it("returns the new employer's address for a person registered under an old one", async () => {
    const v = simVendors(world, s);
    const stale = world.people.filter((p) => p.listed_company_id && p.company_id);
    expect(stale.length).toBeGreaterThan(40);
    let wrong = 0, total = 0;
    for (const p of stale) {
      const listed = world.companies.find((c) => c.id === p.listed_company_id)!;
      const r = await settle(v.finders[0].find({ full_name: p.full_name, company: listed.name }));
      if (r === "error") continue;
      total++;
      if (r.value) { expect(r.value).toBe(p.email); expect(r.value.endsWith(`@${listed.domain}`)).toBe(listed.domain === world.companies.find((c) => c.id === p.company_id)!.domain); wrong++; }
    }
    expect(near(share(wrong, total), SIM_RATES.finder[0].stale_match, 0.15)).toBe(true);
  });

  it("finds nothing for filler company names and falls back to the mock for companies it has never heard of", async () => {
    const v = simVendors(world, s);
    expect(world.junk_company_keys.length).toBeGreaterThan(10);
    const junk = world.junk_company_keys.find((k) => /^[a-z ]+$/.test(k))!;
    expect((await v.finders[0].find({ full_name: "Ana Perez", company: junk })).value).toBeNull();
    expect((await v.discovery.find(junk, 3)).people).toEqual([]);
    const mocked = await v.discovery.find("Brightwater Logistics", 3);
    expect(mocked.people.length).toBeGreaterThan(0);
  });

  it("is repeatable, and a retry after an error rolls again", async () => {
    const run = async () => {
      const v = simVendors(world, s);
      const out: unknown[] = [];
      for (const p of world.people.filter((x) => x.attending && x.company_id).slice(0, 200)) {
        const c = world.companies.find((x) => x.id === p.company_id)!;
        out.push(await settle(v.finders[0].find({ full_name: p.full_name, company: c.name })));
      }
      return JSON.stringify(out);
    };
    expect(await run()).toBe(await run());
    // The error roll depends on the call count, so the same input does not fail forever.
    const v = simVendors(world, s);
    const p = world.people.find((x) => x.attending && x.company_id)!;
    const c = world.companies.find((x) => x.id === p.company_id)!;
    const outcomes = new Set<string>();
    for (let n = 0; n < 400; n++) outcomes.add(String(await settle(v.finders[0].find({ full_name: p.full_name, company: c.name })) === "error"));
    expect(outcomes).toEqual(new Set(["true", "false"]));
  });
});

describe("simulated verifiers", () => {
  it("read real mailboxes as deliverable and invented ones as undeliverable, with stated mistakes", async () => {
    for (const [i, r] of SIM_RATES.verifier.entries()) {
      const events: SimEvent[] = [];
      const v = simVendors(world, s, { audit: (e) => events.push(e) });
      const plain = new Set(world.companies.filter((c) => !c.catch_all).map((c) => c.domain));
      const real = world.people.filter((p) => p.kind === "employee" && plain.has(p.email.split("@")[1]));
      const fake = real.map((p) => `zz.${p.id}@${p.email.split("@")[1]}`);
      const out: Record<string, string> = {};
      let errors = 0;
      for (const e of [...real.map((p) => p.email), ...fake]) {
        const x = await settle(v.verifiers[i].verify(e));
        if (x === "error") { errors++; continue; }
        out[e] = x.verdict;
      }
      const realV = real.map((p) => out[p.email]).filter(Boolean), fakeV = fake.map((e) => out[e]).filter(Boolean);
      expect(near(share(realV.filter((x) => x === "deliverable").length, realV.length), 1 - r.unknown - r.false_undeliverable, 0.02)).toBe(true);
      expect(near(share(fakeV.filter((x) => x === "deliverable").length, fakeV.length), r.false_deliverable, 0.015)).toBe(true);
      expect(fakeV.filter((x) => x === "catch_all").length).toBe(0);
      expect(share(errors, real.length * 2)).toBeLessThan(r.error + 0.01);
    }
  });

  it("reads a catch-all domain as catch-all, missing it only at the stated rate", async () => {
    const v = simVendors(world, s);
    const dom = world.companies.filter((c) => c.catch_all).map((c) => c.domain);
    expect(dom.length).toBeGreaterThan(40);
    let ca = 0, n = 0;
    for (const d of dom) for (let k = 0; k < 8; k++) { const x = await settle(v.verifiers[0].verify(`probe${k}@${d}`)); if (x === "error") continue; n++; if (x.verdict === "catch_all") ca++; }
    expect(near(share(ca, n), 1 - SIM_RATES.verifier[0].catch_all_missed, 0.04)).toBe(true);
  });

  it("rejects mistyped and placeholder mail domains, and treats a bad address as nothing to find", async () => {
    const v = simVendors(world, s);
    for (const e of ["a.b@gmial.com", "x@test.com", "info@company.com", "n@none.com", "q@asdf.com"]) {
      const r = await settle(v.verifiers[0].verify(e));
      if (r !== "error") expect(r.verdict).toBe("undeliverable");
    }
  });
});

describe("simulated discovery", () => {
  it("returns real buyers at the company, with a stated share of stale ones and misses", async () => {
    const events: SimEvent[] = [];
    const v = simVendors(world, s, { audit: (e) => events.push(e) });
    const cos = world.companies.filter((c) => !c.list_status);
    let empty = 0, calls = 0;
    for (const c of cos) {
      const r = await settle(v.discovery.find(c.name, 3));
      if (r === "error") continue;
      calls++;
      if (!r.people.length) empty++;
      for (const p of r.people) expect(world.people.some((q) => q.full_name === p.full_name)).toBe(true);
    }
    expect(near(share(empty, calls), SIM_RATES.discovery.miss, 0.05)).toBe(true);
    const slots = events.filter((e) => e.op === "search" && e.klass !== "miss");
    expect(near(share(slots.filter((e) => e.klass === "stale_employer").length, slots.length), SIM_RATES.discovery.stale_employer, 0.03)).toBe(true);
  });
});

describe("simulated LinkedIn lookup", () => {
  it("returns only the person's real profile, at its stated rate", async () => {
    const v = simVendors(world, s);
    let hit = 0, n = 0;
    for (const p of world.people.filter((x) => x.attending && x.kind === "employee" && x.company_id).slice(0, 600)) {
      const c = world.companies.find((x) => x.id === p.company_id)!;
      const r = await settle(v.linkedin.find({ full_name: p.full_name, title: p.title, company: c.name, email: null }));
      if (r === "error") continue;
      n++;
      if (r.value) { hit++; expect(r.value).toBe(p.linkedin); }
    }
    expect(near(share(hit, n), SIM_RATES.linkedin.hit, 0.05)).toBe(true);
  });
});

describe("the simulated model", () => {
  const llm = () => simLlm(world);
  it("tiers companies as the truth does, off by one at the stated rate", async () => {
    const m = llm();
    let right = 0, bad = 0;
    for (const c of world.companies) {
      const out = JSON.parse((await m.complete("company_tier", fill("company_tier", { icp: "x", input: `Company: ${c.name}` }))).text);
      if (out.tier === c.tier) right++;
      if (c.tier === 3 && out.tier === 1) bad++;
    }
    const stated = SIM_RATES.llm.company_off_by_one + SIM_RATES.llm.company_obscure;
    expect(near(share(right, world.companies.length), 1 - stated, 0.07)).toBe(true);
    expect(bad).toBe(0);
  });
  it("tiers titles from the truth table", async () => {
    const m = llm();
    const entries = Object.entries(world.titles);
    let right = 0;
    for (const [t, tier] of entries) {
      const out = JSON.parse((await m.complete("title_tier", fill("title_tier", { targets: "x", input: `Title: ${t}` }))).text);
      if (out.tier === tier) right++;
    }
    expect(near(share(right, entries.length), 1 - SIM_RATES.llm.title_off, 0.06)).toBe(true);
  });
  it("flags a person registered under an old employer", async () => {
    const m = llm();
    const stale = world.people.filter((p) => p.listed_company_id && !p.there);
    let flagged = 0;
    for (const p of stale) {
      const listed = world.companies.find((c) => c.id === p.listed_company_id)!;
      const out = JSON.parse((await m.complete("review", fill("review", { input: `Name: ${p.full_name}\nTitle: ${p.title}\nCompany: ${listed.name}\nEmail: x@y.example` }))).text);
      if (out.flags.includes("likely_left_company")) flagged++;
    }
    expect(near(share(flagged, stale.length), SIM_RATES.llm.review_recall, 0.15), `${flagged} of ${stale.length}`).toBe(true);
  });
  it("is free: no tokens and no network", async () => {
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const r = await llm().complete("company_tier", fill("company_tier", { icp: "x", input: "Company: Whatever" }));
    expect(r.input_tokens + r.output_tokens).toBe(0);
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
