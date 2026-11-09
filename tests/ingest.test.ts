import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { companyKey, mapColumns, normalize, parseCsv } from "../src/shared/ingest.ts";
import type { Db } from "../src/server/db.ts";
import { freshDb } from "./helpers.ts";
import { createEvent, moveEvent, RuleError } from "../src/server/events.ts";
import { ingestUpload, listSummary } from "../src/server/uploads.ts";

const fixture = (f: string) => readFileSync(`tests/fixtures/${f}`, "utf8");
const run = (text: string) => { const p = parseCsv(text); const m = mapColumns(p); return { p, m, out: normalize(p, m.map) }; };

describe("company names", () => {
  it("treats legal suffixes and casing as one company", () => {
    expect(companyKey("ACME, Inc.")).toBe(companyKey("Acme"));
    expect(companyKey("Harrow & Vale S.A.")).toBe(companyKey("harrow vale"));
  });
  it("keeps a name that is only a legal word", () => { expect(companyKey("Limited")).toBe("limited"); });
});

describe("an export with a title line above the header", () => {
  const { m, out } = run(fixture("export-with-title-line.csv"));
  it("finds the real header and ignores columns it does not need", () => {
    expect(m.error).toBeNull();
    expect(m.ignored).toEqual(["Dietary Needs"]);
  });
  it("merges company spellings into one", () => {
    expect(out.companies.map((c) => c.key).sort()).toEqual(["brightwater logistics", "kestrel foods"]);
  });
  it("drops the later duplicate person, matched by email across casing", () => {
    expect(out.contacts.filter((c) => c.drop_reason === "duplicate").map((c) => c.row_number)).toEqual([3]);
  });
  it("keeps a person whose email is invalid, with no email", () => {
    const ana = out.contacts.find((c) => c.full_name === "Ana Beltrán")!;
    expect(ana.email).toBeNull();
    expect(ana.drop_reason).toBeNull();
  });
  it("keeps a person with an email and no company, since a row needs any one of company, email or LinkedIn", () => {
    const sam = out.contacts.find((c) => c.full_name === "Sam Okafor")!;
    expect(sam.drop_reason).toBeNull();
    expect(sam.company_key).toBeNull();
    expect(sam.email).toBe("sam@nocompany.example");
  });
  it("drops a row with nothing usable as junk_row", () => {
    const r = run("Company Name,First Name,Last Name,Work Email\n,Ann,Lee,\nAcme,Bo,Ray,bo@acme.example\n");
    expect(r.out.contacts[0].drop_reason).toBe("junk_row");
    expect(r.out.contacts[1].drop_reason).toBeNull();
  });
});

describe("a semicolon file with Last, First names", () => {
  const { m, out } = run(fixture("semicolon-last-first.csv"));
  it("finds the email column by its values, not its header", () => {
    expect(m.map.email).toBe(3);
    expect(m.map.linkedin).toBe(4);
  });
  it("flips names and dedupes by name and company when an email is missing", () => {
    expect(out.contacts[0].full_name).toBe("Inés Duarte");
    expect(out.contacts[2].drop_reason).toBe("duplicate");
  });
});

describe("a plain list of company names", () => {
  const { out } = run(fixture("company-names-only.csv"));
  it("works from a company name alone", () => {
    expect(out.contacts).toHaveLength(0);
    expect(out.sourceRows.every((r) => r.kind === "company_only")).toBe(true);
    expect(out.companies).toHaveLength(3);
  });
  it("drops a repeated company", () => {
    expect(out.sourceRows.filter((r) => r.drop_reason === "duplicate")).toHaveLength(1);
  });
});

describe("edge cases", () => {
  it("keeps the email when the same person appears without one first", () => {
    const { out } = run("Company,Name,Email\nAcme,Ann Lee,\nAcme,Ann Lee,ann@acme.example\n");
    expect(out.contacts[0]).toMatchObject({ email: "ann@acme.example", drop_reason: null });
    expect(out.contacts[1].drop_reason).toBe("duplicate");
  });
  it("keeps non-Latin company names apart", () => {
    expect(companyKey("Яндекс")).not.toBe("");
    expect(companyKey("東京物流 Inc")).not.toBe(companyKey("大阪物流 Inc"));
  });
  it("does not read a credential as a first name", () => {
    expect(run("Company,Name\nAcme,\"Ann Lee, PhD\"\n").out.contacts[0].full_name).toBe("Ann Lee");
  });
});

describe("a file the code cannot map", () => {
  it("says which column is missing", () => {
    const { m } = run("Name,Notes\nMaya,likes tea\n");
    expect(m.error).toMatch(/No company, email or LinkedIn column/);
  });
  it("accepts a file with no company column when it has an email column", () => {
    const { m, out } = run("Name,Email\nMaya Ortiz,maya@x.example\n");
    expect(m.error).toBeNull();
    expect(out.contacts[0].drop_reason).toBeNull();
    expect(out.companies).toHaveLength(0);
  });
});

describe("uploads in Postgres", () => {
  let db: Db;
  let id: string;
  beforeEach(async () => {
    db = await freshDb();
    id = (await createEvent(db, "Maya", { name: "Test", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 100 })).id;
  });

  it("stores the list, moves to mapped, and every drop has a reason", async () => {
    await moveEvent(db, id, "approved", "Dan");
    const e = await ingestUpload(db, id, "Maya", "list.csv", fixture("export-with-title-line.csv"));
    expect(e.stage).toBe("mapped");
    const s = await listSummary(db, id);
    expect(s).toMatchObject({ companies: 2, people: 4, company_only: 0 });
    expect(s.dropped).toEqual([{ reason: "duplicate", n: 1 }]);
    expect(s.quality?.rows).toBe(5);
  });
  it("refuses an upload before seats are approved and stores nothing", async () => {
    await expect(ingestUpload(db, id, "Maya", "list.csv", fixture("company-names-only.csv"))).rejects.toBeInstanceOf(RuleError);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM companies"))[0].n).toBe(0);
  });
  it("leaves the event at approved when the file cannot be mapped", async () => {
    await moveEvent(db, id, "approved", "Dan");
    await expect(ingestUpload(db, id, "Maya", "bad.csv", "Name,Notes\nA,hello\n")).rejects.toThrow(/No company, email or LinkedIn column/);
    expect((await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage).toBe("approved");
  });
  it("Postgres refuses a dropped contact with no reason", async () => {
    await moveEvent(db, id, "approved", "Dan");
    await ingestUpload(db, id, "Maya", "list.csv", fixture("export-with-title-line.csv"));
    await expect(db.query("UPDATE contacts SET dropped_at = now() WHERE dropped_at IS NULL")).rejects.toThrow(/contact_drop_has_reason/);
  });
});
