import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { decideApproval, requestCard } from "../src/server/approvals.ts";
import type { Db } from "../src/server/db.ts";
import { createEvent } from "../src/server/events.ts";
import { liveVendors } from "../src/server/live-vendors.ts";
import { processEvent } from "../src/server/pipeline.ts";
import { mockLlm, mockVendors, VendorError } from "../src/server/providers.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import { buildWorkbook } from "../src/server/workbook.ts";
import { cleanLinkedin } from "../src/shared/ingest.ts";
import type { Settings } from "../src/shared/cost.ts";
import { freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock";
const LIST = "Company Name,Full Name,Job Title,Work Email\nTallgrass Software,Real Person,VP Sales,a@tallgrass.example\nTallgrass Software,Other Person,VP Sales,b@tallgrass.example\nTallgrass Software,Third Person,VP Sales,c@tallgrass.example\n";

describe("cleanLinkedin", () => {
  it("keeps only LinkedIn profile URLs on http or https, in one form", () => {
    expect(cleanLinkedin("https://uk.linkedin.com/in/ana-b-12/?utm=x#y")).toBe("https://www.linkedin.com/in/ana-b-12");
    expect(cleanLinkedin("http://linkedin.com/in/ana")).toBe("https://www.linkedin.com/in/ana");
    expect(cleanLinkedin("linkedin.com/in/real person")).toBe("https://www.linkedin.com/in/real%20person");
    for (const bad of ["javascript:alert(1)", "https://evil.com/linkedin.com/in/x", "https://linkedin.com.evil.com/in/x", "https://www.linkedin.com/company/acme",
      "https://www.linkedin.com/search/results/people/?keywords=x", "ftp://linkedin.com/in/x", "", null, undefined, 42, "data:text/html,linkedin.com/in/x"]) expect(cleanLinkedin(bad)).toBeNull();
  });
});

describe("the LinkedIn lookup in the pipeline", () => {
  let db: Db, id: string;
  const run = async (vendorsFor: (s: Settings) => ReturnType<typeof mockVendors>, list = LIST) => {
    id = (await createEvent(db, MAYA, { name: "T", starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100, flow: "single_card" })).id;
    const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
    await decideApproval(db, { approvalId: await pending(), actor: DAN, decision: "approve" });
    await ingestUpload(db, id, MAYA, "a.csv", list);
    await requestCard(db, id, MAYA);
    await decideApproval(db, { approvalId: await pending(), actor: MAYA, decision: "approve" });
    return processEvent(db, id, { llm: mockLlm, vendorsFor });
  };
  const quiet = (s: Settings) => { const v = mockVendors(s); v.finders = v.finders.map((f) => ({ ...f, find: async () => ({ value: null, charged: f.cost }) })); return v; };
  const kept = () => db.query<{ linkedin: string | null }>("SELECT linkedin FROM contacts WHERE event_id = $1 AND dropped_at IS NULL", [id]);
  const notes = async (like: string) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM credit_ledger WHERE event_id = $1 AND kind = 'reserve' AND note = $2", [id, like]))[0].n;
  beforeEach(async () => { db = await freshDb(); });

  it("looks up a profile for attendees who arrived with an email, once each, through the ledger", async () => {
    expect(await run(mockVendors)).toBe("delivered");
    const people = await kept();
    expect(people.length).toBe(3);
    for (const p of people) expect(p.linkedin).toMatch(/^https:\/\/www\.linkedin\.com\/in\//);
    expect(await notes("linkedin_lookup")).toBe(3);
    const attempts = await db.query<{ result: string }>("SELECT result FROM enrichment_attempts WHERE event_id = $1 AND step = 'linkedin'", [id]);
    expect(attempts.length).toBe(3);
  });

  it("does not look up a contact who already has a profile, and never spends past the credits cap", async () => {
    await run(mockVendors, "Company Name,Full Name,Job Title,Work Email,LinkedIn\nTallgrass Software,Real Person,VP Sales,a@tallgrass.example,https://www.linkedin.com/in/real-person\n");
    expect(await notes("linkedin_lookup")).toBe(0);
    const [cap] = await db.query<{ credits_cap: number }>("SELECT credits_cap FROM cost_cards WHERE event_id = $1", [id]);
    const spent = (await db.query<{ n: number }>("SELECT coalesce(sum(CASE kind WHEN 'reserve' THEN amount WHEN 'release' THEN -amount ELSE 0 END),0)::int AS n FROM credit_ledger WHERE event_id = $1 AND unit = 'credits'", [id]))[0].n;
    expect(spent).toBeLessThanOrEqual(cap.credits_cap);
  });

  it("an empty lookup never drops the contact, and the workbook says Not found with no search link", async () => {
    const empty = (s: Settings) => { const v = quiet(s); v.linkedin = { ...v.linkedin, find: async () => ({ value: null, charged: v.linkedin.cost }) }; return v; };
    await run(empty);
    expect((await kept()).length).toBe(3);
    expect((await kept()).every((p) => p.linkedin === null)).toBe(true);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await buildWorkbook(db, id)) as never);
    const ws = wb.getWorksheet("Attendees")!;
    const li = (ws.getRow(3).values as unknown[]).indexOf("LinkedIn");
    let seen = 0;
    ws.eachRow((row, n) => { if (n > 3) { seen++; expect(row.getCell(li).value).toBe("Not found"); } });
    expect(seen).toBe(3);
    const raw = JSON.stringify(wb.worksheets.map((w) => { const o: unknown[] = []; w.eachRow((r) => o.push(r.values)); return o; }));
    expect(raw).not.toContain("linkedin.com/search");
  });

  it("a failed lookup with an unknown charge is billed, not repeated, and does not drop anyone", async () => {
    let calls = 0;
    const boom = (s: Settings) => { const v = quiet(s); v.linkedin = { ...v.linkedin, find: async () => { calls++; throw new VendorError("unknown"); } }; return v; };
    expect(await run(boom)).toBe("delivered");
    expect(calls).toBe(3);
    expect((await kept()).length).toBe(3);
  });

  it("the lookup is a line on the card and part of the credits cap", async () => {
    await run(mockVendors);
    const [card] = await db.query<{ lines: Record<string, number>; credits_cap: number }>("SELECT lines, credits_cap FROM cost_cards WHERE event_id = $1", [id]);
    expect(card.lines.linkedin_credits).toBe(card.lines.contacts);
    expect(card.credits_cap).toBe(card.lines.discovery_credits + card.lines.finder_credits + card.lines.verifier_credits + card.lines.linkedin_credits);
  });
});

describe("live LinkedIn parsing", () => {
  const s = JSON.parse(JSON.stringify({ ...require_defaults() })) as Settings;
  const keys = { apollo: "a", zerobounce: "z" };
  const v = (body: unknown) => liveVendors(s, keys, { paceMs: 0, fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch });
  const P = { full_name: "Maya Ortiz", company: "Brightwater Logistics", title: "VP", email: null };
  it("Apollo match returns only clean profile URLs, and the lookup checks the company", async () => {
    const person = (url: string, org = "Brightwater Logistics") => ({ person: { email: "m@b.example", linkedin_url: url, organization: { name: org } } });
    expect((await v(person("http://linkedin.com/in/maya?x=1")).finders[0].find(P)).linkedin).toBe("https://www.linkedin.com/in/maya");
    expect((await v(person("javascript:alert(1)")).finders[0].find(P)).linkedin).toBeNull();
    expect((await v(person("https://linkedin.com/in/maya", "Someone Else")).finders[0].find(P)).linkedin).toBeNull();
    expect(await v(person("https://www.linkedin.com/in/maya")).linkedin.find(P)).toMatchObject({ value: "https://www.linkedin.com/in/maya", charged: s.linkedin.cost });
    expect((await v(person("https://www.linkedin.com/in/maya", "Other Co")).linkedin.find(P)).value).toBeNull();
  });
});

import { readFileSync } from "node:fs";
function require_defaults() { return JSON.parse(readFileSync("config/defaults.json", "utf8")); }
