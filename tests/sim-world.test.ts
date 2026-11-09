import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildWorld, serialize, TOTAL_ROWS, COMPANIES, PLACEHOLDER_DOMAINS, WEBMAIL_DOMAINS, SELLER } from "../scripts/gen-world.ts";
import { companyKey, mapColumns, normalize, parseCsv } from "../src/shared/ingest.ts";
import type { World } from "../src/shared/world.ts";

const built = buildWorld();
const { world, csv } = built;
const parsed = parseCsv(csv);
const map = mapColumns(parsed);
const col = (name: string) => parsed.headers.indexOf(name);
const cells = (name: string) => parsed.rows.map((r) => (r[col(name)] ?? "").trim());
const within = (actual: number, target: number, slack = 0.12) => Math.abs(actual - target) <= Math.max(2, target * slack);

describe("the generator", () => {
  it("is deterministic and matches the committed files", () => {
    const again = buildWorld();
    expect(serialize(again.world)).toBe(serialize(world));
    expect(again.csv).toBe(csv);
    expect(readFileSync("samples/attendees-large.csv", "utf8")).toBe(csv);
    expect(readFileSync("samples/world.json", "utf8")).toBe(serialize(world));
  });
  it("makes more than 1,500 rows from about 420 companies", () => {
    expect(parsed.rows.length).toBe(TOTAL_ROWS);
    expect(parsed.rows.length).toBeGreaterThan(1500);
    expect(world.companies).toHaveLength(COMPANIES);
    expect(world.rows).toHaveLength(parsed.rows.length);
  });
  it("looks like a registration export: a title line above the header and extra fields", () => {
    expect(csv.split("\n")[0]).toMatch(/Meridian Trade Expo/);
    expect(map.error).toBeNull();
    for (const h of ["Dietary Needs", "Ticket Type", "Country", "Website"]) expect(parsed.headers).toContain(h);
    expect(map.ignored).toEqual(expect.arrayContaining(["Dietary Needs", "Ticket Type", "Country", "Website"]));
  });
  it("has a long tail: a few big delegations and many of one or two", () => {
    const per = new Map<string, number>();
    for (const r of world.rows) if (r.person_id && r.company_id) per.set(r.company_id, (per.get(r.company_id) ?? 0) + 1);
    const sizes = [...per.values()];
    expect(sizes.filter((n) => n >= 30 && n <= 62).length).toBeGreaterThanOrEqual(5);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(62);
    expect(sizes.filter((n) => n <= 2).length / sizes.length).toBeGreaterThan(0.5);
  });
  it("uses only fictional names and .example domains", () => {
    for (const c of world.companies) {
      expect(c.domain).toMatch(/^[a-z]+\.example$/);
      expect(c.name).not.toMatch(/\d/);
    }
    const workDomains = world.people.filter((p) => p.kind === "employee").map((p) => p.email.split("@")[1]);
    expect(workDomains.every((d) => d.endsWith(".example"))).toBe(true);
    expect(world.meta.extra_domains.every((d) => d.endsWith(".example"))).toBe(true);
  });
  it("states a seller that is not in payments, and tiers by its rule", () => {
    expect(SELLER.sells).toMatch(/not a payments product/i);
    for (const c of world.companies) {
      const inRange = c.employees >= 200 && c.employees <= 5000;
      const strong = ["software", "logistics technology", "payments"].includes(c.segment);
      const weak = c.business_model === "B2C" || ["marketing agency", "management consulting"].includes(c.segment);
      expect(c.tier).toBe(weak ? 3 : strong && inRange ? 1 : inRange || strong ? 2 : 3);
    }
    const share = (t: number) => world.companies.filter((c) => c.tier === t).length / world.companies.length;
    for (const t of [1, 2, 3]) expect(share(t)).toBeGreaterThan(0.12);
  });
  it("covers several cultures, accents and non-English titles", () => {
    const names = world.people.map((p) => p.full_name).join(" ");
    expect(names).toMatch(/[éáñçüöåøłşğ]/i);
    expect(csv).toMatch(/[田林张김]/);
    expect(world.people.some((p) => /Director Comercial|Gerente|Geschäftsführer|Directeur/.test(p.title))).toBe(true);
    expect(world.people.some((p) => /Ninja|Rockstar|Everything|Wizard/.test(p.title))).toBe(true);
    expect(world.people.some((p) => p.title === "Associate" || p.title === "Partner")).toBe(true);
  });
});

describe("messiness, at the stated rates", () => {
  it("writes every stated rate into world.json and hits it", () => {
    const stated = world.meta.mess.filter((m) => m.stated_rate !== null);
    expect(stated.length).toBeGreaterThanOrEqual(15);
    for (const m of stated) {
      const base = m.of === "rows" ? world.meta.rows : world.meta.person_rows;
      expect(Math.abs(m.target - m.stated_rate! * base)).toBeLessThanOrEqual(1);
      expect(within(m.actual, m.target), `${m.tag} ${m.actual} vs ${m.target}`).toBe(true);
    }
  });
  it("tags on the rows agree with the stated counts", () => {
    for (const m of world.meta.mess) {
      const n = world.rows.filter((r) => r.mess.includes(m.tag)).length;
      if (m.tag === "subsidiary_on_parent_domain" || m.tag === "homonym") continue;
      expect(n, m.tag).toBe(m.actual);
    }
  });
  it("shows in the file itself: company-only, website, placeholders, webmail, typos", () => {
    const n = parsed.rows.length;
    const company = cells("Company Name"), first = cells("First Name"), last = cells("Last Name"), email = cells("Work Email"), site = cells("Website");
    const companyOnly = company.filter((c, i) => c && !first[i] && !last[i] && !email[i]).length;
    expect(Math.abs(companyOnly / n - 0.15)).toBeLessThan(0.01);
    const goodSite = (s: string) => /^(https?:\/\/)?(www\.)?[a-z]+\.example(\/.*)?$/.test(s);
    expect(Math.abs(site.filter((s) => !goodSite(s)).length / n - 0.25)).toBeLessThan(0.01);
    const dom = (e: string) => e.split("@")[1]?.toLowerCase() ?? "";
    const persons = n - companyOnly;
    const ph = email.filter((e) => PLACEHOLDER_DOMAINS.includes(dom(e))).length;
    const web = email.filter((e) => WEBMAIL_DOMAINS.includes(dom(e))).length;
    const typo = email.filter((e) => /gmial|gmai\.|gnail|hotmial|yahooo|outlok|gmail\.con|yahoo\.cmo/.test(dom(e))).length;
    expect(within(ph, 0.025 * persons, 0.2)).toBe(true);
    expect(within(web, 0.06 * persons + 40, 0.5), `webmail ${web}`).toBe(true);
    expect(within(typo, 0.015 * persons, 0.2)).toBe(true);
    expect(email.filter((e) => /^(n\/a|na|-|--|none|\.)$/i.test(e)).length).toBeGreaterThan(5);
  });
  it("includes keyboard mash, N/A, swapped columns and a person's own name as company", () => {
    const company = cells("Company Name");
    expect(company.filter((c) => /^(asdfgh|qwerty|xxxxx|jjjjjj|zzzz|lkjhgf|hhhh|sdfsdf|qqqq www|aaaa)$/.test(c)).length).toBeGreaterThanOrEqual(6);
    expect(company.filter((c) => /^(n\/a|na|-|--|none|\.)$/i.test(c)).length).toBeGreaterThanOrEqual(4);
    const swapped = world.rows.filter((r) => r.mess.includes("swapped_company_title")).map((r) => r.row);
    expect(swapped.length).toBeGreaterThan(8);
    for (const row of swapped.slice(0, 5)) expect(cells("Job Title")[row - 1]).toBeTruthy();
    const own = world.rows.filter((r) => r.mess.includes("person_name_as_company"));
    for (const r of own) {
      const i = r.row - 1;
      expect([`${cells("First Name")[i]} ${cells("Last Name")[i]}`, `${cells("Last Name")[i]}, ${cells("First Name")[i]}`]).toContain(cells("Company Name")[i]);
    }
  });
  it("has one email shared by a team, registered by an assistant", () => {
    const byEmail = new Map<string, Set<string>>();
    parsed.rows.forEach((r) => { const e = r[col("Work Email")]; if (e) (byEmail.get(e) ?? byEmail.set(e, new Set()).get(e)!).add(`${r[col("First Name")]} ${r[col("Last Name")]}`); });
    const shared = [...byEmail.entries()].filter(([, names]) => names.size >= 5);
    expect(shared.length).toBeGreaterThanOrEqual(2);
    expect(cells("Notes").some((n) => /assistant/.test(n))).toBe(true);
  });
  it("casing and legal-suffix variants fold to one company; typos and short forms do not", () => {
    const out = normalize(parsed, map.map);
    const byName = new Map(world.companies.map((c) => [c.id, companyKey(c.name)]));
    const variants = world.rows.filter((r) => r.mess.includes("name_variant") && r.company_id && !r.mess.includes("similar_name_collision"));
    expect(variants.length).toBeGreaterThan(200);
    const company = cells("Company Name");
    for (const r of variants) expect(companyKey(company[r.row - 1])).toBe(byName.get(r.company_id!));
    const odd = world.rows.filter((r) => r.mess.includes("name_typo_or_short") && r.company_id);
    expect(odd.filter((r) => companyKey(company[r.row - 1]) !== byName.get(r.company_id!)).length).toBeGreaterThan(odd.length * 0.9);
    // The upload therefore holds more distinct companies than the world does.
    expect(out.companies.length).toBeGreaterThan(COMPANIES);
  });
  it("holds the hard cases from the design", () => {
    const ids = world.hard_cases.map((h) => h.id);
    for (const id of ["shared_team_1", "agency_domain", "fake_address", "homonyms", "same_person_two_companies", "similar_names", "subsidiaries"]) expect(ids).toContain(id);
    for (const h of world.hard_cases) expect(h.rows.length, h.id).toBeGreaterThan(0);
    expect(world.companies.filter((c) => c.parent_id).length).toBeGreaterThanOrEqual(10);
    const dom = new Map<string, number>();
    world.companies.forEach((c) => dom.set(c.domain, (dom.get(c.domain) ?? 0) + 1));
    expect([...dom.values()].some((n) => n >= 3)).toBe(true);
    const agency = world.hard_cases.find((h) => h.id === "agency_domain")!;
    expect(new Set(agency.rows.map((r) => world.rows[r - 1].company_id)).size).toBeGreaterThanOrEqual(6);
    const pairs = world.companies.filter((a) => world.companies.some((b) => a !== b && b.name.startsWith(`${a.name} `) && b.segment !== a.segment));
    expect(pairs.length).toBeGreaterThanOrEqual(10);
    expect(world.meta.mess.find((m) => m.tag === "non_company")!.actual).toBeGreaterThan(30);
    expect(world.rows.filter((r) => r.mess.includes("duplicate")).length).toBeGreaterThan(30);
  });
});

describe("the upload through the real ingest", () => {
  it("maps columns and keeps the row count", () => {
    const out = normalize(parsed, map.map);
    expect(out.sourceRows).toHaveLength(parsed.rows.length);
    expect(out.sourceRows.filter((r) => r.kind === "company_only").length).toBeGreaterThan(200);
  });
});
export type { World };
