/* Lists that carry only an email or only a LinkedIn profile (docs/LIFECYCLE.md, section 3). */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { mockIdentity, mockVendors, type ReverseResult } from "../src/server/providers.ts";
import { labelFromDomain, mapColumns, normalize, parseCsv } from "../src/shared/ingest.ts";
import { deliverEvent, freshDb } from "./helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

const people = (id: string) => db.query<{ full_name: string | null; title: string | null; email: string | null; linkedin: string | null; company: string | null; drop_reason: string | null }>(
  "SELECT k.full_name, k.title, k.email, k.linkedin, co.name AS company, k.drop_reason FROM contacts k LEFT JOIN companies co ON co.id = k.company_id WHERE k.event_id = $1 ORDER BY k.id", [id]);

/** Mock vendors whose reverse lookup and finders are scripted. */
const vendors = (reverse: { byEmail?: (e: string) => ReverseResult; byLinkedin?: (u: string) => ReverseResult }, opts: { noFinders?: boolean } = {}) => ({
  vendorsFor: ((s: any) => {
    const v = mockVendors(s), id = mockIdentity(s);
    return {
      ...v,
      verifiers: v.verifiers.map((x) => ({ ...x, verify: async (e: string) => ({ verdict: e.startsWith("zz-") ? ("undeliverable" as const) : ("deliverable" as const), charged: x.cost }) })),
      ...(opts.noFinders ? { finders: [], waterfall: undefined, reveal: undefined } : {}),
      identity: { ...id, reverse: { ...id.reverse, ...(reverse.byEmail ? { byEmail: async (e: string) => reverse.byEmail!(e) } : {}), ...(reverse.byLinkedin ? { byLinkedin: async (u: string) => reverse.byLinkedin!(u) } : {}) } },
    };
  }) as typeof mockVendors,
});

describe("reading the file", () => {
  it("reads a one-column list with no header by its values", () => {
    const emails = parseCsv("ana@acme.example\nsam@beta.example\nlee@core.example\n");
    expect(emails.headers).toEqual(["email"]);
    expect(emails.rows).toHaveLength(3);
    expect(mapColumns(emails).map.email).toBe(0);
    const li = parseCsv("https://www.linkedin.com/in/ana-ruiz\nlinkedin.com/in/sam-okafor\n");
    expect(li.headers).toEqual(["linkedin"]);
    expect(mapColumns(li).map.linkedin).toBe(0);
    expect(parseCsv("Acme\nBeta Corp\n").headers).toEqual(["company"]);
  });

  it("makes a readable label from a domain", () => {
    expect(labelFromDomain("acme.com")).toBe("Acme");
    expect(labelFromDomain("acme.co.uk")).toBe("Acme");
    expect(labelFromDomain("mail.brightwater.io")).toBe("Brightwater");
  });

  it("reads a work email as a person with no company, for the lookup to place", () => {
    const p = parseCsv("Name,Email\nAna Ruiz,ana@acme.example\n");
    const out = normalize(p, mapColumns(p).map, mapColumns(p).extras);
    expect(out.companies).toEqual([]);
    expect(out.contacts[0]).toMatchObject({ company_key: null, email: "ana@acme.example" });
  });
});

describe("through the pipeline", () => {
  const known = (name: string, title: string): ReverseResult => ({ company: { name: "Acme Software", domain: "acmesoftware.example" }, person: { full_name: name, title, linkedin: "https://www.linkedin.com/in/found" }, charged: 1 });

  it("email only: the lookup fills the name and title, and the person is delivered", async () => {
    const id = await deliverEvent(db, "ana@acmesoftware.example\n", vendors({ byEmail: () => known("Ana Ruiz", "VP Sales") }));
    expect(await people(id)).toEqual([expect.objectContaining({ full_name: "Ana Ruiz", title: "VP Sales", email: "ana@acmesoftware.example", company: "Acme Software", drop_reason: null })]);
  });

  it("never overwrites what the file said", async () => {
    const id = await deliverEvent(db, "Name,Email,Title\nAna Ruiz,ana@gmail.com,Founder\n", vendors({ byEmail: () => known("Someone Else", "Intern") }));
    expect((await people(id))[0]).toMatchObject({ full_name: "Ana Ruiz", title: "Founder" });
  });

  it("LinkedIn only, with no address anywhere: stays on the list, reachable on LinkedIn", async () => {
    const id = await deliverEvent(db, "https://www.linkedin.com/in/ana-ruiz\n", vendors({ byLinkedin: () => ({ company: { name: "Acme Software", domain: "acmesoftware.example" }, person: { full_name: "Ana Ruiz", title: "VP Sales", linkedin: null }, charged: 1 }) }, { noFinders: true }));
    expect((await people(id))[0]).toMatchObject({ full_name: "Ana Ruiz", email: null, linkedin: "https://www.linkedin.com/in/ana-ruiz", drop_reason: null });
  });

  it("a person with no address, no name or no profile still drops", async () => {
    const id = await deliverEvent(db, "Company,Name\nAcme,Ana Ruiz\n", vendors({}, { noFinders: true }));
    expect((await people(id)).find((p) => p.full_name === "Ana Ruiz")).toMatchObject({ drop_reason: "no_email_found" });
  });

  it("a verified address with no name stays on the list, unnamed", async () => {
    const id = await deliverEvent(db, "ana@acmesoftware.example\n", vendors({ byEmail: () => ({ company: { name: "Acme Software", domain: "acmesoftware.example" }, person: null, charged: 1 }) }));
    expect((await people(id))[0]).toMatchObject({ full_name: null, email: "ana@acmesoftware.example", drop_reason: null });
  });

  it("a lookup that finds nothing still places a work address by its domain", async () => {
    const id = await deliverEvent(db, "ana@acmesoftware.example\n", vendors({ byEmail: () => ({ company: null, charged: 1 }) }));
    expect((await people(id))[0]).toMatchObject({ company: "Acmesoftware", drop_reason: null });
    expect((await db.query<{ name_provisional: boolean }>("SELECT name_provisional FROM companies WHERE event_id = $1", [id]))[0].name_provisional).toBe(true);
  });

  it("all webmail with nothing known drops as no company, and prices one lookup each", async () => {
    const id = await deliverEvent(db, "Name,Email\nAna Ruiz,ana@gmail.com\nSam Okafor,sam@yahoo.com\n", vendors({ byEmail: () => ({ company: null, charged: 1 }) }));
    expect((await people(id)).map((p) => p.drop_reason)).toEqual(["no_company", "no_company"]);
    const [c] = await db.query<{ lines: { reverse_lookup_rows: number } }>("SELECT lines FROM cost_cards WHERE event_id = $1 AND lines ? 'reverse_lookup_rows' LIMIT 1", [id]);
    expect(c.lines.reverse_lookup_rows).toBe(2);
  });

  it("a mixed list works, rows with full data included", async () => {
    const id = await deliverEvent(db, "Company,Name,Title,Email,LinkedIn\nTallgrass Software,Ana Ruiz,VP Sales,ana@tallgrass.example,\n,Sam Okafor,CRO,sam@acmesoftware.example,\n,,,lee@core.example,\n,,,,https://www.linkedin.com/in/pat\n", vendors({
      byEmail: () => ({ company: { name: "Core Software", domain: "core.example" }, person: { full_name: "Lee Park", title: "CEO", linkedin: null }, charged: 1 }),
      byLinkedin: () => ({ company: null, charged: 1 }),
    }));
    const got = await people(id);
    expect(got.find((p) => p.full_name === "Ana Ruiz")).toMatchObject({ company: "Tallgrass Software" });
    expect(got.find((p) => p.full_name === "Sam Okafor")).toMatchObject({ company: "Core Software" });
    expect(got.find((p) => p.full_name === "Lee Park")).toMatchObject({ company: "Core Software" });
    expect(got.find((p) => p.linkedin?.endsWith("/pat"))).toMatchObject({ drop_reason: "no_company" });
  });
});
