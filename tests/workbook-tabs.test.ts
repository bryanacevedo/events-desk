import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { answerCase, listCases } from "../src/server/cases.ts";
import type { Db } from "../src/server/db.ts";
import { openLaterCases } from "../src/server/later-cases.ts";
import { importReview, accountBand, buildWorkbook, wrapShortfalls } from "../src/server/workbook.ts";
import { localFitsName } from "../src/shared/email.ts";
import type { Vendors } from "../src/server/providers.ts";
import { freshDb } from "./helpers.ts";
import { found, HEAD, outreachRun, researchWith, row, type Run } from "./tier-helpers.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

const soft = { employees: 900, industry: "B2B software", business_model: "B2B", country: "Spain", description: "Builds cloud tools for business customers." };
const specs = {
  "acmecloud.example": { search: soft },
  "playbox.example": { search: { employees: 900, industry: "Games", business_model: "B2C" } },
  "midco.example": { search: { ...soft, employees: 90 } },
  "harborlogistics.example": { search: { ...soft, industry: "logistics technology" } },
};
const LIST = HEAD
  + "Acme Cloud,Ana,Ruiz,VP Sales,ana@acmecloud.example\n"
  + "Acme Cloud,Ivy,Ito,Student Intern,ivy@acmecloud.example\n"
  + "Playbox,Zed,Baker,VP Sales,zed@playbox.example\n"
  + "Mid Co,Moe,Dunn,Account Executive,moe@midco.example\n";

/** Verifiers that read every real address as deliverable and every made-up one (the probe's) as undeliverable, so who is kept does not depend on a hash. */
const sure = (v: Vendors): Vendors => ({ ...v, verifiers: v.verifiers.map((x) => ({ ...x, verify: async (e: string) => ({ verdict: e.startsWith("zz-") ? "undeliverable" as const : "deliverable" as const, charged: x.cost }) })) });
async function delivered(csv = LIST, o: Partial<Parameters<typeof researchWith>[2]> = {}): Promise<Run> {
  const r = await researchWith(db, csv, { specs, tweak: sure, ...o });
  await outreachRun(db, r);
  return r;
}
const open = async (id: string) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await buildWorkbook(db, id)) as never); return wb; };
const colOf = (ws: ExcelJS.Worksheet, header: string, headRow = 3) => { const i = (ws.getRow(headRow).values as unknown[]).findIndex((v) => v === header); if (i < 1) throw new Error(`no column ${header}`); return i; };
const plain = (v: ExcelJS.CellValue) => (v && typeof v === "object" && "text" in v ? String(v.text) : v && typeof v === "object" && "result" in v ? v.result : v);

describe("the Companies tab is a CRM or ABM view of every account", () => {
  it("carries fit, firmographics, CRM and the outreach list, in shaded bands", async () => {
    const r = await delivered();
    const ws = (await open(r.id)).getWorksheet("Companies")!;
    for (const h of ["Company", "Website", "Parent", "Status", "Tier", "Fit", "Segment", "Company type", "Why this tier", "Tiered by", "Employees", "Size band", "Industry", "Sells to", "Country", "City", "Revenue", "Founded", "Funding stage", "LinkedIn", "About it", "Facts from", "Account type", "Heat", "Account owner", "Open deal", "Stage", "Last activity", "Listed", "On the list", "Priority A", "Account band"]) expect(colOf(ws, h), h).toBeGreaterThan(0);
    // Bands: row 2 carries one filled, labelled cell per group, in more than one shade; the detail group is folded under an outline.
    const fills = new Set<string>();
    ws.getRow(2).eachCell((c) => { if (c.fill && (c.fill as ExcelJS.FillPattern).fgColor) fills.add(String((c.fill as ExcelJS.FillPattern).fgColor?.argb)); });
    expect(fills.size).toBeGreaterThanOrEqual(3);
    expect(String(ws.getCell(2, colOf(ws, "Employees")).value)).toBe("Firmographics");
    expect(ws.getColumn(colOf(ws, "Why this tier")).hidden).toBe(true);
    expect(ws.getColumn(colOf(ws, "Why this tier")).outlineLevel).toBe(1);
    expect(ws.getColumn(colOf(ws, "Employees")).hidden).toBeFalsy();
    let acme: ExcelJS.Row | undefined;
    ws.eachRow((rw, n) => { if (n > 3 && plain(rw.getCell(1).value) === "Acme Cloud") acme = rw; });
    const v = (h: string) => plain(acme!.getCell(colOf(ws, h)).value);
    expect(v("Tier")).toBe(1);
    expect(v("Fit")).toBe("Strong fit");
    expect(v("Employees")).toBe(900);
    expect(v("Size band")).toBe("200 to 999");
    expect(v("Industry")).toBe("B2B software");
    expect(v("Sells to")).toBe("Businesses (B2B)");
    expect(v("Country")).toBe("Spain");
    expect(String(v("About it"))).toMatch(/cloud tools/);
    expect(String(v("Why this tier"))).toMatch(/Employees: 900|B2B software/);
    expect(v("Tiered by")).toBe("AI");
    expect(v("Facts from")).toBe("Free search");
    expect(v("On the list")).toBeGreaterThan(0);
    expect(v("Account band")).toMatch(/Focus|Grow/);
    expect(plain(acme!.getCell(2).value)).toBe("acmecloud.example");
    // A hard-rule company says so.
    let play: ExcelJS.Row | undefined;
    ws.eachRow((rw, n) => { if (n > 3 && plain(rw.getCell(1).value) === "Playbox") play = rw; });
    expect(plain(play!.getCell(colOf(ws, "Tiered by")).value)).toBe("Rule in code");
    expect(plain(play!.getCell(colOf(ws, "Fit")).value)).toBe("Outside the ICP");
  });
  it("gives an account band by one written rule", () => {
    const c = (tier: number | null, heat: "hot" | "warm" | "cold" | null, n: number) => accountBand({ tier, heat, n } as never);
    expect([c(1, "hot", 2), c(1, "warm", 1), c(1, "cold", 1), c(2, "hot", 1), c(2, "cold", 1), c(3, "hot", 1), c(null, "hot", 1), c(1, "hot", 0)]).toEqual(["Focus", "Focus", "Grow", "Grow", "Watch", "Watch", "", ""]);
  });
  it("fits every wrapped cell on every tab, and every filter covers its data", async () => {
    const r = await delivered();
    const wb = await open(r.id);
    for (const ws of wb.worksheets) expect(wrapShortfalls(ws), ws.name).toEqual([]);
    for (const name of ["Attendees", "Prospects", "Companies", "Other attendees", "Review"]) {
      const ws = wb.getWorksheet(name)!;
      const f = ws.autoFilter as unknown as string | { from: unknown; to: unknown };
      const ref = typeof f === "string" ? f : `${(f as any).from.address ?? (f as any).from}:${(f as any).to.address ?? (f as any).to}`;
      expect(Number(ref.split(":")[1].replace(/[A-Z]/g, "")), `${name} ${ref}`).toBeGreaterThanOrEqual(Math.max(ws.actualRowCount, 4));
    }
  });
});

describe("the Other attendees tab", () => {
  it("lists people from the attendee list with a tier 3 title or at a tier 3 company, one row each, and leaves out a person who is only priority C", async () => {
    const r = await delivered();
    const ws = (await open(r.id)).getWorksheet("Other attendees")!;
    expect(ws).toBeTruthy();
    const names: string[] = [];
    ws.eachRow((rw, n) => { if (n > 3) names.push(String(plain(rw.getCell(1).value))); });
    // The intern has a tier 3 title; Zed Baker is at a tier 3 company (consumer-only). Moe Dunn is tier 2 at a tier 2 company: priority C, but not tier 3. Ana is on the outreach list.
    expect(names.sort()).toEqual(["Ivy Ito", "Zed Baker"]);
    const why = (name: string) => { let t = ""; ws.eachRow((rw, n) => { if (n > 3 && plain(rw.getCell(1).value) === name) t = String(plain(rw.getCell(colOf(ws, "Why they are here")).value)); }); return t; };
    expect(why("Ivy Ito")).toMatch(/Title tier 3/);
    expect(why("Zed Baker")).toMatch(/Company tier 3/);
    // People only: the tier 3 company itself is on the Companies tab, not here.
    expect(names).not.toContain("Playbox");
    expect(JSON.stringify(ws.getRow(3).values)).toContain("What happened");
    // Nothing was spent finding them.
    expect((await r.deps.vendorsFor ? 1 : 0)).toBe(1);
    expect((await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND full_name = 'Zed Baker' AND (email_loop::text <> '{}' OR vendor_person_id IS NOT NULL)", [r.id])).length).toBe(0);
  });
  it("appears only when the attendee list had people", async () => {
    const withPeople = await delivered();
    expect((await open(withPeople.id)).getWorksheet("Other attendees")).toBeTruthy();
    db = await freshDb();
    const names = await delivered(HEAD.replace("Company Name,First Name,Last Name,Job Title,Work Email", "Company Name") + "Acme Cloud\nPlaybox\n", { people: { "acmecloud.example": [found("p1", "Ana", "Vega", "VP Sales")] } });
    const wb = await open(names.id);
    expect(wb.getWorksheet("Other attendees")).toBeUndefined();
    expect(wb.worksheets.filter((w) => w.state !== "hidden").map((w) => w.name)).toEqual(["Summary", "Review", "Attendees", "Prospects", "Companies", "Meetings"]);
  });
});

describe("later review cases, and the Review tab by case", () => {
  const ids = async (id: string) => Object.fromEntries((await db.query<{ id: string; full_name: string }>("SELECT id, full_name FROM contacts WHERE event_id = $1 AND dropped_at IS NULL", [id])).map((c) => [c.full_name, c.id]));
  const kinds = async (id: string) => (await listCases(db, id)).filter((c) => !c.blocking && !c.decision).map((c) => c.kind);

  it("recognizes a name an address does not fit", () => {
    expect(localFitsName("jsmith@x.com", "John Smith")).toBe(true);
    expect(localFitsName("john.s@x.com", "John Smith")).toBe(true);
    expect(localFitsName("js@x.com", "John Smith")).toBe(true);
    expect(localFitsName("barbara@x.com", "John Smith")).toBe(false);
    expect(localFitsName("zoe.mueller@x.com", "Zoë Müller")).toBe(true);
  });
  it("opens each kind once at delivery and never twice", async () => {
    const r = await delivered(LIST + "Acme Cloud,Ana,Ruiz,VP Sales,ana@acmecloud.example\n");
    const c = await ids(r.id);
    await db.query("UPDATE contacts SET email = 'barbara@acmecloud.example', email_source = 'finder_one' WHERE id = $1", [c["Ana Ruiz"]]);
    await db.query("UPDATE companies SET deal_name = 'Platform pilot', deal_stage = 'Negotiation', account_owner = 'Priya Natarajan' WHERE event_id = $1 AND name = 'Acme Cloud'", [r.id]);
    await db.query("INSERT INTO review_flags (contact_id, flag, source) VALUES ($1, 'likely_left_company', 'llm')", [c["Ana Ruiz"]]);
    await db.query("UPDATE contacts SET email_loop = jsonb_set(email_loop, '{mismatch}', $2::jsonb) WHERE id = $1", [c["Ana Ruiz"], JSON.stringify([{ email: "ana@gmail.com", source: "uploaded", kind: "webmail" }, { email: "ana@othercorp.example", source: "finder_one", kind: "other_domain" }])]);
    expect(await openLaterCases(db, r.id)).toBeGreaterThanOrEqual(5);
    const k = await kinds(r.id);
    for (const kind of ["name_email_mismatch", "attendee_vendor_mismatch", "free_webmail", "late_stage_deal", "model_flag"]) expect(k, kind).toContain(kind);
    const again = await openLaterCases(db, r.id);
    expect(again).toBe(0);
    const late = (await listCases(db, r.id)).find((x) => x.kind === "late_stage_deal")!;
    expect(late.options.map((o) => o.value)).toEqual(["keep", "dismiss"]);
    expect(late.blocking).toBe(false);
    // The name and address case suggests Drop when a vendor found the address.
    expect((await listCases(db, r.id)).find((x) => x.kind === "name_email_mismatch")!.suggested).toBe("drop");
    // The API gives the screens the person with each case.
    const app = createApp(db, { demo: true });
    const body = await (await app.request(`/api/events/${r.id}/cases`)).json() as { cases: { kind: string; person: { full_name: string; priority: string } | null; company_id: string; contact_id: string | null }[] };
    expect(body.cases.find((x) => x.kind === "name_email_mismatch")!.person).toMatchObject({ full_name: "Ana Ruiz" });
  });
  it("opens same_person_two_companies for one name at two companies", async () => {
    const r = await delivered(HEAD + "Acme Cloud,Ana,Ruiz,VP Sales,ana@acmecloud.example\nHarbor Logistics,Ana,Ruiz,VP Sales,ana@harborlogistics.example\n");
    expect(await kinds(r.id)).toContain("same_person_two_companies");
  });
  it("puts one row per case on the Review tab, grouped by case, with the options each case allows, and reads the decisions back through the case", async () => {
    const r = await delivered(LIST + "Acme Cloud,Ana,Ruiz,VP Sales,ana@acmecloud.example\n");
    const c = await ids(r.id);
    await db.query("UPDATE contacts SET email = 'barbara@acmecloud.example', email_source = 'finder_one' WHERE id = $1", [c["Ana Ruiz"]]);
    await db.query("UPDATE companies SET deal_name = 'Platform pilot', deal_stage = 'Negotiation', account_owner = 'Priya Natarajan' WHERE event_id = $1 AND name = 'Acme Cloud'", [r.id]);
    await openLaterCases(db, r.id);
    const wb = await open(r.id);
    const ws = wb.getWorksheet("Review")!;
    const H = 4;
    const caseCol = colOf(ws, "Case", H), dec = colOf(ws, "Decision", H), idCol = colOf(ws, "case_id", H), contactCol = colOf(ws, "contact_id", H);
    expect(ws.getColumn(idCol).hidden).toBe(true);
    expect(ws.getColumn(contactCol).hidden).toBe(true);
    const rows: { row: number; kind: string; caseId: string }[] = [];
    ws.eachRow((rw, n) => { if (n > H) rows.push({ row: n, kind: String(plain(rw.getCell(caseCol).value)), caseId: String(plain(rw.getCell(idCol).value) ?? "") }); });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Grouped: a kind never comes back after another kind has started.
    const order = rows.map((x) => x.kind);
    expect(order).toEqual([...order].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    const lateRow = rows.find((x) => x.kind === "Late-stage deal")!, nameRow = rows.find((x) => x.kind === "Name and address differ")!;
    expect(ws.getCell(lateRow.row, dec).dataValidation?.formulae).toEqual(['"Keep,Dismiss"']);
    expect(ws.getCell(nameRow.row, dec).dataValidation?.formulae).toEqual(['"Keep,Drop,Dismiss"']);
    // Drop on the name case, Dismiss on the deal; a blank row stays open.
    ws.getCell(nameRow.row, dec).value = "Drop";
    ws.getCell(lateRow.row, dec).value = "Dismiss";
    const out = await importReview(db, r.id, "Maya Ortiz", (await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(out.answered).toBe(2);
    expect((await db.query<{ drop_reason: string }>("SELECT drop_reason FROM contacts WHERE id = $1", [c["Ana Ruiz"]]))[0].drop_reason).toBe("rejected_in_review");
    const after = await listCases(db, r.id);
    expect(after.find((x) => x.id === lateRow.caseId)).toMatchObject({ status: "answered", decision: "dismiss" });
    // Reading the same file again changes nothing.
    expect(await importReview(db, r.id, "Maya Ortiz", (await wb.xlsx.writeBuffer()) as ArrayBuffer)).toMatchObject({ answered: 0 });
  });
  it("skips a decision the case does not allow, and a case from another event", async () => {
    const r = await delivered(LIST + "Acme Cloud,Ana,Ruiz,VP Sales,ana@acmecloud.example\n");
    await db.query("UPDATE companies SET deal_name = 'Platform pilot', deal_stage = 'Negotiation', account_owner = 'Priya Natarajan' WHERE event_id = $1 AND name = 'Acme Cloud'", [r.id]);
    await openLaterCases(db, r.id);
    const late = (await listCases(db, r.id)).find((x) => x.kind === "late_stage_deal")!;
    const grid = [["case_id", "contact_id", "Case", "Decision"], [late.id, "", "Late-stage deal", "Drop"], ["case_nope", "", "x", "Keep"]];
    const { applyReviewGrid } = await import("../src/server/workbook.ts");
    expect(await applyReviewGrid(db, r.id, "Maya Ortiz", grid)).toEqual({ dropped: 0, answered: 0, skipped: 2 });
    expect((await listCases(db, r.id)).find((x) => x.id === late.id)!.status).toBe("open");
    await answerCase(db, r.id, late.id, "Maya Ortiz", "keep");
  });
});

describe("opting someone out", () => {
  it("stops the email loop with its own drop reason, takes them off a list they are on, and applies in every event", async () => {
    const app = createApp(db, { demo: true });
    const post = (b: object) => app.request("/api/suppressions", { method: "POST", body: JSON.stringify(b), headers: { "x-actor": "Maya Ortiz", "content-type": "application/json" } });
    const r = await delivered();
    expect((await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND full_name = 'Ana Ruiz' AND dropped_at IS NULL", [r.id])).length).toBe(1);
    const res = await post({ email: "ana@acmecloud.example", reason: "Asked us to stop" });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ recorded: true, removed: 1 });
    expect((await db.query<{ drop_reason: string }>("SELECT drop_reason FROM contacts WHERE event_id = $1 AND full_name = 'Ana Ruiz'", [r.id]))[0].drop_reason).toBe("opted_out");
    expect((await post({})).status).toBe(409);
    expect((await post({ email: "not an address" })).status).toBe(409);
    const list = await (await app.request("/api/suppressions")).json() as { opt_outs: { email: string; created_by: string }[] };
    expect(list.opt_outs[0]).toMatchObject({ email: "ana@acmecloud.example", created_by: "Maya Ortiz" });
    // By name at a company, for the next event: stopped before anything is revealed or paid.
    expect((await post({ name: "Cy Moss", company: "Harbor Logistics" })).status).toBe(201);
    const next = await delivered(HEAD + "Acme Cloud,Ana,Ruiz,VP Sales,ana@acmecloud.example\nHarbor Logistics,,,,\n", { people: { "harborlogistics.example": [found("p1", "Cy", "Moss", "VP Sales"), found("p2", "Bo", "Lund", "VP Sales")] }, name: "Next" });
    const got = Object.fromEntries((await db.query<{ full_name: string; drop_reason: string | null }>("SELECT full_name, drop_reason FROM contacts WHERE event_id = $1", [next.id])).map((x) => [x.full_name, x.drop_reason]));
    expect(got["Cy Moss"]).toBe("opted_out");
    expect(got["Bo Lund"]).toBeNull();
    expect(got["Ana Ruiz"]).toBe("opted_out");
  });
});
