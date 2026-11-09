/* Layer 0 measured against the simulated world (samples/attendees-large.csv, samples/world.json).

   The world knows the truth for every row, so this reports, per kind of mess, how many rows Layer 0
   caught, and how many real values it wrongly destroyed. The false-kill count uses an oracle that does
   not read the world's mess tags: it asks whether the raw value was in fact the true one (the person's real
   address, the company's real name, a real company domain). Both are enforced as floors and ceilings, so a
   change to Layer 0 that loses a catch or destroys something real fails here.

   The numbers are only as good as the world: its mess rates are chosen, not measured on a real list. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { companyKey, mapColumns, normalize, parseCsv, type IngestSourceRow } from "../src/shared/ingest.ts";
import { DROP_REASONS } from "../src/shared/domain.ts";
import { ascii, nameSet } from "../src/shared/layer0.ts";
import type { World } from "../src/shared/world.ts";

const world = JSON.parse(readFileSync("samples/world.json", "utf8")) as World;
const parsed = parseCsv(readFileSync("samples/attendees-large.csv", "utf8"));
const mapped = mapColumns(parsed);
const out = normalize(parsed, mapped.map, mapped.extras);
const H = Object.fromEntries(parsed.headers.map((h, i) => [h, i]));
const raw = (row: number, col: string) => (parsed.rows[row - 1][H[col]] ?? "").trim();
const rows = new Map<number, IngestSourceRow>(out.sourceRows.map((r) => [r.row_number, r]));
const issues = (n: number) => rows.get(n)!.issues;
const people = new Map(world.people.map((p) => [p.id, p]));
const companies = new Map(world.companies.map((c) => [c.id, c]));
const withTag = (tag: string) => world.rows.filter((r) => r.mess.includes(tag)).map((r) => r.row);
const realDomains = new Set([...world.companies.map((c) => c.domain), ...world.meta.extra_domains]);
const trueKeys = (companyId: string | null) => {
  const c = companyId ? companies.get(companyId) : null;
  return new Set(c ? [c.name, ...c.aliases].map(companyKey) : []);
};
const host = (u: string) => u.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");

describe("Layer 0 against the world", () => {
  it("reads the same 1,650 rows as the world", () => {
    expect(out.sourceRows).toHaveLength(world.meta.rows);
  });

  /* ------------------------------------------------------------------ catch */
  // [mess tag in the world, issue tags that count as a catch, minimum share caught]
  const CATCH: [string, string[], number][] = [
    ["placeholder_email_domain", ["placeholder_email"], 1],
    ["shared_team_email", ["shared_email"], 1],
    ["agency_domain", ["shared_domain"], 1],
    ["keyboard_mash", ["company_mash", "name_mash"], 1],
    ["na_or_dash", ["company_filler", "title_filler", "email_filler", "name_filler"], 1],
    ["swapped_company_title", ["swapped_company_title"], 1],
    ["swapped_first_last", ["swapped_names_moved"], 0.9],
    ["person_name_as_company", ["person_name_as_company"], 1],
    ["website_filler", ["website_filler"], 1],
    ["free_webmail", ["free_webmail"], 1],
    ["email_typo", ["webmail_typo"], 1],
  ];
  const caught: Record<string, { caught: number; of: number }> = {};
  for (const [tag, counts, floor] of CATCH) {
    it(`catches ${tag} at ${floor * 100}% or better`, () => {
      const rs = withTag(tag);
      const n = rs.filter((r) => counts.some((c) => issues(r).includes(c))).length;
      caught[tag] = { caught: n, of: rs.length };
      expect(n / rs.length).toBeGreaterThanOrEqual(floor);
    });
  }

  it("drops students, press and the self-employed as not_a_company", () => {
    const rs = withTag("non_company");
    const n = rs.filter((r) => rows.get(r)!.drop_reason === "not_a_company").length;
    caught.non_company = { caught: n, of: rs.length };
    expect(n / rs.length).toBeGreaterThanOrEqual(0.95);
  });

  it("dedupes every repeat of one person at one listed company, and none across two listed companies", () => {
    // Grouped by what the row says, not by the truth: the same person under two company names is a case for a person after delivery.
    const groups = new Map<string, number[]>();
    for (const r of world.rows) if (r.person_id) { const k = `${r.person_id}|${companyKey(raw(r.row, "Company Name"))}`; groups.set(k, [...(groups.get(k) ?? []), r.row]); }
    let should = 0, got = 0;
    for (const ns of groups.values()) { should += ns.length - 1; got += ns.filter((n) => rows.get(n)!.drop_reason === "duplicate").length; }
    caught.duplicate = { caught: got, of: should };
    expect(got).toBe(should);
    // Two rows of one person under two different company names: neither is dropped as a duplicate.
    const byPerson = new Map<string, Set<string>>();
    for (const [k] of groups) { const [p, c] = k.split("|"); byPerson.set(p, (byPerson.get(p) ?? new Set()).add(c)); }
    const cross = world.rows.filter((r) => r.person_id && byPerson.get(r.person_id)!.size > 1 && groups.get(`${r.person_id}|${companyKey(raw(r.row, "Company Name"))}`)!.length === 1);
    expect(cross.length).toBeGreaterThanOrEqual(16);
    for (const r of cross) expect(rows.get(r.row)!.drop_reason).toBeNull();
  });

  it("never treats two different people with one name as duplicates", () => {
    for (const r of withTag("homonym")) expect(rows.get(r)!.drop_reason).toBeNull();
  });

  it("leaves a fake mailbox on a real domain for full verification, and says so", () => {
    const rs = withTag("fake_address_real_domain");
    // By design Layer 0 does not trust or discard these: they are flagged only, and the email loop verifies them.
    expect(rs.every((r) => rows.get(r)!.drop_reason === null)).toBe(true);
    const flagged = rs.filter((r) => issues(r).includes("fake_local_part")).length;
    caught.fake_address_real_domain = { caught: flagged, of: rs.length };
    expect(flagged / rs.length).toBeGreaterThanOrEqual(0.75);
  });

  it("flags a possible first and last name swap it cannot settle, and moves none without proof", () => {
    const moved = out.sourceRows.filter((r) => r.issues.includes("swapped_names_moved")).length;
    expect(moved).toBe(withTag("swapped_first_last").length);
  });

  /* ------------------------------------------------------------- false kills */
  const FALSE: Record<string, number[]> = {};
  const note = (kind: string, row: number) => (FALSE[kind] ??= []).push(row);

  it("measures what Layer 0 wrongly destroys, by an oracle that ignores the mess tags", () => {
    for (const wr of world.rows) {
      const n = wr.row, r = rows.get(n)!;
      const person = wr.person_id ? people.get(wr.person_id) : null;
      const keys = trueKeys(wr.company_id);
      const rawCompanyIsTrue = keys.has(companyKey(raw(n, "Company Name")));
      const rawEmailIsTrue = Boolean(person && raw(n, "Work Email").toLowerCase() === person.email.toLowerCase());
      const tags = new Set(r.issues);

      if (r.drop_reason === "junk_row" && person?.kind === "employee" && (rawCompanyIsTrue || rawEmailIsTrue || raw(n, "LinkedIn URL"))) note("row dropped as junk with a true value in it", n);
      if (r.drop_reason === "not_a_company" && person?.kind === "employee") note("employee dropped as not_a_company", n);
      if (tags.has("company_mash") || tags.has("company_filler") || tags.has("person_name_as_company") || tags.has("not_a_company")) { if (rawCompanyIsTrue && person?.kind === "employee") note("true company name blanked", n); }
      if (tags.has("swapped_company_title") && rawCompanyIsTrue) note("true company name moved to the title", n);
      if (tags.has("name_mash") && person && (raw(n, "First Name") === person.first || raw(n, "Last Name") === person.last)) note("true name blanked", n);
      if (tags.has("swapped_names_moved") && person && raw(n, "First Name") === person.first) note("correct name order swapped", n);
      if ((tags.has("placeholder_email") || tags.has("shared_email") || tags.has("email_filler")) && rawEmailIsTrue) note("true email discarded", n);
      if (tags.has("website_filler") && realDomains.has(host(raw(n, "Website")))) note("real website ignored", n);
    }
    // A repeat dropped as a duplicate must repeat a row that stands.
    const standing = new Set<string>(), standingCo = new Set<string>();
    for (const wr of world.rows) {
      const r = rows.get(wr.row)!;
      if (r.drop_reason === "duplicate") { if (wr.person_id ? !standing.has(`${wr.person_id}|${wr.company_id}`) : !standingCo.has(wr.company_id!)) note("duplicate that repeats nothing", wr.row); }
      else if (wr.person_id) standing.add(`${wr.person_id}|${wr.company_id}`); else standingCo.add(wr.company_id!);
    }
    // A domain flagged as shared must not be a real company's own domain.
    for (const d of out.quality.shared_domains.domains) if (world.companies.some((c) => c.domain === d)) note(`real company domain flagged shared: ${d}`, 0);
    // A domain that carries a company's own people must still be offered as evidence for that company.
    const realEvidence = out.companies.filter((c) => c.evidence.some((e) => e.source === "email_domain")).length;
    expect(realEvidence).toBeGreaterThan(200);

    const total = Object.values(FALSE).reduce((a, v) => a + v.length, 0);
    expect(FALSE, JSON.stringify(FALSE)).toEqual({});
    expect(total).toBe(0);
  });

  it("gives every drop a reason from the design's list", () => {
    const allowed = new Set<string>(DROP_REASONS);
    for (const r of out.sourceRows) if (r.drop_reason) expect(allowed.has(r.drop_reason), `${r.drop_reason} on row ${r.row_number}`).toBe(true);
    for (const c of out.contacts) if (c.drop_reason) expect(allowed.has(c.drop_reason)).toBe(true);
    expect(Object.keys(out.quality.dropped).sort()).toEqual(expect.arrayContaining(["duplicate", "junk_row", "not_a_company"]));
  });

  it("writes the quality report", () => {
    const q = out.quality;
    expect(q.rows).toBe(1650);
    expect(q.usable_rows + Object.values(q.dropped).reduce((a, b) => a + b, 0)).toBe(q.rows);
    expect(q.shared_emails).toEqual({ emails: 2, rows: 15 });
    expect(q.shared_domains.domains).toContain("pavilionevents.example");
    expect(q.summary.length).toBeGreaterThan(5);
    expect(["good", "fair", "poor"]).toContain(q.verdict);
  });

  it("reports the numbers", () => {
    // Printed so the figures can be copied into the status notes.
    const table = Object.fromEntries(Object.entries(caught).map(([k, v]) => [k, `${v.caught} of ${v.of}`]));
    console.log("LAYER 0 CAUGHT", JSON.stringify(table, null, 1));
    console.log("LAYER 0 FALSE KILLS", JSON.stringify(FALSE), "quality", JSON.stringify({ dropped: out.quality.dropped, usable: out.quality.usable_rows, clean: out.quality.clean_rows, verdict: out.quality.verdict }));
    void ascii; void nameSet;
    expect(Object.keys(caught).length).toBeGreaterThan(10);
  });
});
