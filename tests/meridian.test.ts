import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { seed } from "../src/server/seed.ts";
import { loadWorld } from "../src/server/sim-vendors.ts";
import { buildWorkbook } from "../src/server/workbook.ts";
import { freshDb } from "./helpers.ts";

describe("Meridian Trade Expo, the large event", () => {
  let db: Db;
  let seconds = 0, cpuSeconds = 0;
  beforeAll(async () => {
    db = await freshDb();
    const t = Date.now(), cpu = process.cpuUsage();
    await seed(db, { large: "delivered" });
    seconds = (Date.now() - t) / 1000;
    const used = process.cpuUsage(cpu);
    cpuSeconds = (used.user + used.system) / 1e6;
  }, 120_000);

  it("is seeded through the real code paths to delivered, in seconds", async () => {
    expect((await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = 'evt_meridian'"))[0].stage).toBe("delivered");
    // "In seconds" is a claim about the work the seed does, not about how busy the machine is. Wall time swings with the other test files running beside this
    // one (3.5 s alone, past 15 s under load), so it only has to beat the setup timeout. CPU time moves less, but it still moves: a few seconds on a laptop, 25 to 34 s
    // on the shared GitHub runner, so the bound is 60 s, loose enough for CI and still a fail if the seed gets an order of magnitude slower.
    expect(cpuSeconds).toBeLessThan(60);
    expect(seconds).toBeLessThan(100);
    const [r] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM source_rows WHERE event_id = 'evt_meridian'");
    expect(r.n).toBeGreaterThan(1500);
    expect((await db.query("SELECT 1 FROM events WHERE stage = 'delivered'")).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the small sample events", async () => {
    const ids = (await db.query<{ id: string }>("SELECT id FROM events")).map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(["evt_harbor", "evt_lantern", "evt_cedar", "evt_north", "evt_quarry"]));
  });

  it("drops the seller's exclusion and customer, and every drop has a reason", async () => {
    const reasons = await db.query<{ drop_reason: string; n: number }>("SELECT drop_reason, count(*)::int AS n FROM contacts WHERE event_id = 'evt_meridian' AND dropped_at IS NOT NULL GROUP BY 1");
    const got = Object.fromEntries(reasons.map((r) => [r.drop_reason, r.n]));
    expect(got.excluded_company).toBeGreaterThan(0);
    expect(got.existing_customer).toBeGreaterThan(0);
    expect(got.duplicate).toBeGreaterThan(30);
    expect(got.low_tier).toBeGreaterThan(300);
  });

  it("delivers mostly true addresses; the rest come from the stated vendor errors", async () => {
    const world = loadWorld();
    const truth = new Map(world.people.map((p) => [p.email, p]));
    const rows = await db.query<{ email: string; source: string }>("SELECT email, source FROM contacts WHERE event_id = 'evt_meridian' AND dropped_at IS NULL AND priority IS NOT NULL");
    expect(rows.length).toBeGreaterThan(150);
    const real = rows.filter((r) => truth.has(r.email)).length;
    expect(real / rows.length).toBeGreaterThan(0.85);
  });

  it("builds a workbook at this size, quickly, with every tab and its lists", async () => {
    const t = Date.now();
    const bytes = await buildWorkbook(db, "evt_meridian");
    expect(Date.now() - t).toBeLessThan(5000);
    expect(bytes.length).toBeLessThan(2_000_000);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    // Reading order: the Summary, then what needs a person, then the lists.
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Review", "Attendees", "Prospects", "Companies", "Other attendees", "Meetings", "Lists"]);
    expect(wb.getWorksheet("Companies")!.rowCount).toBeGreaterThan(400);
    expect(wb.getWorksheet("Attendees")!.rowCount).toBeGreaterThan(50);
    expect(wb.getWorksheet("Lists")!.state).toBe("hidden");
  });

  it("the Summary states the event, the list and the CRM's view, and tells nobody what to do", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWorkbook(db, "evt_meridian")) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Summary")!;
    const texts: string[] = [];
    ws.eachRow((row) => row.eachCell((c) => { const v = c.value as { richText?: { text: string }[] } | null; texts.push(v && typeof v === "object" && v.richText ? v.richText.map((t) => t.text).join("") : String(c.text ?? "")); }));
    const all = texts.join("\n");
    for (const h of ["Why this event", "The list", "Where we stand", "Live from the tabs", "How the attendee list narrowed"]) expect(all).toContain(h);
    // The seat requests speak for themselves: the goal, who is going, a quote, the tickets.
    expect(all).toMatch(/New pipeline/);
    expect(all).toMatch(/Maya Ortiz \(Field marketing\)/);
    expect(all).toMatch(/"Half of the logistics buyers/);
    expect(all).toMatch(/3 seats approved at \$1,899; 1 bought/);
    expect(all).toMatch(/Tier 1 \d+ \(\d+%\)/);
    expect(all).toMatch(/Open deals/);
    // Nothing directs the reader, and nothing is in an alarm color.
    expect(all).not.toMatch(/Game plan|Clear the Review tab|Start with|Open with|work these first|First accounts to work|How to use this file/);
    for (const row of [ws.getRow(2), ws.getRow(7)]) row.eachCell((c) => { const argb = String(c.font?.color?.argb ?? ""); expect(argb, c.address).not.toMatch(/^FF(D1501C|991B1B|92400E)$/); });
  });

  it("puts the company, the CRM and the vendor's detail beside each person, and folds the detail", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWorkbook(db, "evt_meridian")) as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Prospects")!;
    const headers = (ws.getRow(3).values as unknown[]).map((v) => String(v ?? ""));
    for (const h of ["Seniority", "Function", "Email status", "Industry", "Employees", "Revenue", "Account type", "Heat", "Account owner", "Open deal", "Stage", "Last activity", "Outreach status", "Source", "Email from", "Location", "Vendor seniority", "Departments", "In role since", "Employer per vendor"]) expect(headers, h).toContain(h);
    const at = (h: string) => headers.indexOf(h);
    expect(String(ws.getCell(2, at("Priority")).value)).toBe("Person");
    expect(String(ws.getCell(2, at("Company")).value)).toBe("Company");
    expect(String(ws.getCell(2, at("Account type")).value)).toBe("CRM");
    expect(String(ws.getCell(2, at("Outreach status")).value)).toBe("Outreach");
    expect(ws.getColumn(at("Location")).hidden).toBe(true);
    expect(ws.getColumn(at("Industry")).hidden).toBeFalsy();
    // The simulated reveal filled the vendor detail for a found person; the statuses read as words, never as codes.
    let filled = 0, statuses = new Set<string>();
    ws.eachRow((row, n) => { if (n < 4) return; if (row.getCell(at("Vendor seniority")).text) filled++; statuses.add(row.getCell(at("Email status")).text); });
    expect(filled).toBeGreaterThan(10);
    expect([...statuses].every((s) => ["Verified twice", "Verified once", "Not verified", "No email"].includes(s))).toBe(true);
    expect(statuses.has("Verified twice")).toBe(true);
  });
});
