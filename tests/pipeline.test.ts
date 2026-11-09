import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { decideApproval, patchSettings, requestCard } from "../src/server/approvals.ts";
import { createEvent, moveEvent } from "../src/server/events.ts";
import { reserve, settle, spend } from "../src/server/ledger.ts";
import { processEvent, type Deps } from "../src/server/pipeline.ts";
import { mockLlm, mockVendors, VendorError, type Llm } from "../src/server/providers.ts";
import { ingestUpload, listSummary } from "../src/server/uploads.ts";
import { buildWorkbook, importReview } from "../src/server/workbook.ts";
import type { Settings } from "../src/shared/cost.ts";
import { priority, verifyOutcome } from "../src/shared/tiers.ts";
import { askConcierge, connectConcierge, NO_MONEY, USED_UP } from "../src/concierge/agent.ts";
import { seed } from "../src/server/seed.ts";
import { finishTwoCard, freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock";
const LIST = readFileSync("samples/attendees.csv", "utf8");
const mock: Deps = { llm: mockLlm, vendorsFor: mockVendors };

describe("rules", () => {
  it("combines tiers into the priority matrix", () => {
    expect(priority(1, 1)).toBe("A"); expect(priority(1, 2)).toBe("B"); expect(priority(1, 3)).toBe("C");
    expect(priority(2, 1)).toBe("B"); expect(priority(2, 2)).toBe("C"); expect(priority(3, 1)).toBe("C");
    expect(priority(1, null)).toBe("A"); expect(priority(2, null)).toBe("B"); expect(priority(3, null)).toBe("C");
  });
  it("keeps a contact only when both verifiers say deliverable", () => {
    expect(verifyOutcome("deliverable", "deliverable")).toBe("keep");
    expect(verifyOutcome("deliverable", "undeliverable")).toBe("drop");
    expect(verifyOutcome("undeliverable", "unknown")).toBe("drop");
    expect(verifyOutcome("deliverable", "catch_all")).toBe("drop");
    expect(verifyOutcome("unknown", "unknown")).toBe("drop");
  });
});

describe("the pipeline", () => {
  let db: Db, id: string;
  const n = async (sql: string) => (await db.query<{ n: number }>(sql, [id]))[0].n;
  const caps = async () => (await db.query<{ credits_cap: number; llm_cap: number }>("SELECT credits_cap, llm_cap FROM cost_cards WHERE event_id = $1 AND status = 'approved'", [id]))[0];
  const stage = async () => (await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage;
  const approveAll = async () => {
    for (const _ of [0, 1]) {
      const [a] = await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]);
      await decideApproval(db, { approvalId: a.id, actor: _ === 0 ? DAN : MAYA, decision: "approve" });
      if (_ === 0) { await ingestUpload(db, id, MAYA, "a.csv", LIST); await requestCard(db, id, MAYA); }
    }
  };
  beforeEach(async () => {
    db = await freshDb();
    id = (await createEvent(db, MAYA, { name: "T", starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100, flow: "single_card" })).id;
  });
  const orphans = () => n("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NOT NULL AND drop_reason IS NULL");

  it("runs from an approved card to delivered on mocks", async () => {
    await approveAll();
    expect(await processEvent(db, id, mock)).toBe("delivered");
    expect(await orphans()).toBe(0);
    expect(await n("SELECT count(*)::int AS n FROM jobs WHERE event_id = $1 AND status <> 'done'")).toBe(0);
  });
  it("never spends past either cap, and nothing is left reserved", async () => {
    await approveAll();
    await processEvent(db, id, mock);
    const s = await spend(db, id), c = await caps();
    expect(s.credits).toBeLessThanOrEqual(c.credits_cap);
    expect(s.llm).toBeLessThanOrEqual(c.llm_cap);
    expect(s.credits).toBeGreaterThan(0);
  });
  it("runs nothing paid before the card is approved", async () => {
    await processEvent(db, id, mock);
    expect(await n("SELECT count(*)::int AS n FROM llm_calls WHERE event_id = $1")).toBe(0);
    expect(await n("SELECT count(*)::int AS n FROM credit_ledger WHERE event_id = $1")).toBe(0);
  });
  it("never enriches a low-tier contact", async () => {
    await approveAll();
    await processEvent(db, id, mock);
    expect(await n(`SELECT count(*)::int AS n FROM enrichment_attempts a JOIN contacts c ON c.id = a.target_id WHERE a.event_id = $1 AND c.drop_reason = 'low_tier'`)).toBe(0);
  });
  it("drops the existing customer without spending on it", async () => {
    await approveAll();
    await processEvent(db, id, mock);
    expect(await n("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND drop_reason = 'existing_customer'")).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM contacts c JOIN enrichment_attempts a ON a.target_id = c.id WHERE c.event_id = $1 AND c.drop_reason = 'existing_customer'`)).toBe(0);
  });
  it("stops at the card when a vendor costs more than the card assumed", async () => {
    await approveAll();
    const pricey = (s: Settings) => { const v = mockVendors(s); v.finders = v.finders.map((f) => ({ ...f, cost: 500 })); return v; };
    expect(await processEvent(db, id, { llm: mockLlm, vendorsFor: pricey })).toBe("delivered");
    const s = await spend(db, id), c = await caps();
    expect(s.credits).toBeLessThanOrEqual(c.credits_cap);
    expect(await n("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND drop_reason = 'budget_cap'")).toBeGreaterThan(0);
  });
  it("stops spending after a vendor bills more than it quoted", async () => {
    await approveAll();
    let finderCalls = 0;
    const gouge = (s: Settings) => { const v = mockVendors(s); v.finders = v.finders.map((f) => ({ ...f, find: async () => { finderCalls++; return { value: null, charged: 100000 }; } })); return v; };
    await processEvent(db, id, { llm: mockLlm, vendorsFor: gouge });
    expect(finderCalls).toBe(1);
    expect(await n("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND drop_reason = 'budget_cap'")).toBeGreaterThan(0);
  });
  it("does not repeat a model call that failed with an unknown outcome", async () => {
    await approveAll();
    let calls = 0;
    const down: Llm = { model: "down", async complete() { calls++; throw new Error("timeout"); } };
    await processEvent(db, id, { llm: down, vendorsFor: mockVendors });
    const companies = await n("SELECT count(*)::int AS n FROM companies WHERE event_id = $1 AND list_status IS NULL");
    expect(calls).toBeGreaterThanOrEqual(companies);
    expect(await n("SELECT count(*)::int AS n FROM credit_ledger WHERE event_id = $1 AND unit = 'llm' AND kind = 'reserve'")).toBe(calls);
    const titles = await n("SELECT count(DISTINCT lower(title))::int AS n FROM contacts WHERE event_id = $1 AND title IS NOT NULL");
    expect(calls).toBeLessThanOrEqual(companies + titles);
  });
  it("pauses on a model outage instead of delivering an empty list", async () => {
    await approveAll();
    const down: Llm = { model: "down", async complete() { throw new Error("401"); } };
    expect(await processEvent(db, id, { llm: down, vendorsFor: mockVendors })).toBe("paused");
    await moveEvent(db, id, "tiering", DAN);
    expect(await processEvent(db, id, mock)).toBe("delivered");
  });
  it("does not repeat a verification with an unknown charge after a pause and resume", async () => {
    await approveAll();
    const seen: string[] = [];
    let failing = true;
    const flaky = (s: Settings) => { const v = mockVendors(s); const real = v.verifiers[0].verify; v.verifiers[0] = { ...v.verifiers[0], verify: async (e) => { seen.push(e); if (failing) throw new VendorError("unknown"); return real(e); } }; return v; };
    expect(await processEvent(db, id, { llm: mockLlm, vendorsFor: flaky })).toBe("paused");
    failing = false;
    await moveEvent(db, id, "enriching", DAN);
    await processEvent(db, id, { llm: mockLlm, vendorsFor: flaky });
    expect(new Set(seen).size).toBe(seen.length);
  });
  it("closes a job a bad vendor response crashed, so the event cannot strand", async () => {
    await approveAll();
    const broken = (s: Settings) => { const v = mockVendors(s); v.verifiers = v.verifiers.map((x) => ({ ...x, verify: async () => { throw new TypeError("bad body"); } })); return v; };
    let last = await processEvent(db, id, { llm: mockLlm, vendorsFor: broken });
    for (let i = 0; i < 20 && last === "paused"; i++) { await moveEvent(db, id, "enriching", DAN); last = await processEvent(db, id, { llm: mockLlm, vendorsFor: broken }); }
    expect(last).toBe("delivered");
    expect(await n("SELECT count(*)::int AS n FROM jobs WHERE event_id = $1 AND status <> 'done'")).toBe(0);
  });
  it("cannot reserve anything before a card is approved", async () => {
    expect(await reserve(db, id, "credits", 1, "x")).toBeNull();
    expect(await reserve(db, id, "llm", 1, "x")).toBeNull();
  });
  it("drops a contact whose found email is already on the list", async () => {
    await approveAll();
    const same = (s: Settings) => { const v = mockVendors(s); v.finders = v.finders.map((f) => ({ ...f, find: async () => ({ value: "shared@same.example", charged: f.cost }) })); return v; };
    await processEvent(db, id, { llm: mockLlm, vendorsFor: same });
    expect(await n("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND email = 'shared@same.example'")).toBeLessThanOrEqual(1);
    expect(await n("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND drop_reason = 'duplicate' AND email IS NULL")).toBeGreaterThan(0);
  });
  it("finds prospects at attending companies only when asked, and never repeats a person", async () => {
    const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
    await decideApproval(db, { approvalId: await pending(), actor: DAN, decision: "approve" });
    await ingestUpload(db, id, MAYA, "a.csv", "Company Name,Full Name,Job Title,Work Email,Industry\nBrightwater Logistics,Maya Serrano,VP Sales,maya@b.example,logistics\n");
    await patchSettings(db, id, MAYA, { add_prospects: true, contacts_per_company: 3 });
    await requestCard(db, id, MAYA);
    await decideApproval(db, { approvalId: await pending(), actor: MAYA, decision: "approve" });
    const dupes = (s: Settings) => { const v = mockVendors(s); v.discovery = { ...v.discovery, find: async () => ({ people: [{ full_name: "Maya Serrano", title: "VP Sales" }, { full_name: "New Person", title: "VP Sales" }], charged: 0 }) }; return v; };
    await processEvent(db, id, { llm: mockLlm, vendorsFor: dupes });
    const rows = await db.query<{ full_name: string; source: string }>("SELECT full_name, source FROM contacts WHERE event_id = $1 ORDER BY full_name", [id]);
    expect(rows).toEqual([{ full_name: "Maya Serrano", source: "attendee" }, { full_name: "New Person", source: "prospect" }]);
  });
  it("cannot take the last credit twice under concurrent reservations", async () => {
    await approveAll();
    await db.query("UPDATE cost_cards SET credits_cap = 1 WHERE event_id = $1", [id]);
    const got = await Promise.all([reserve(db, id, "credits", 1, "a"), reserve(db, id, "credits", 1, "b"), reserve(db, id, "credits", 1, "c")]);
    expect(got.filter(Boolean)).toHaveLength(1);
  });
  it("settling for less releases the difference", async () => {
    await approveAll();
    const r = await reserve(db, id, "credits", 5, "x");
    await settle(db, r!, 2);
    expect((await spend(db, id)).credits).toBe(2);
  });
  it("retries an invalid LLM answer once, then the item fails with a reason", async () => {
    await approveAll();
    const broken: Llm = { model: "broken", async complete() { return { text: "not json", input_tokens: 0, output_tokens: 0 }; } };
    expect(await processEvent(db, id, { llm: broken, vendorsFor: mockVendors })).toBe("delivered");
    expect(await n("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND drop_reason = 'tiering_failed'")).toBeGreaterThan(0);
    const companies = await n("SELECT count(*)::int AS n FROM companies WHERE event_id = $1 AND list_status IS NULL");
    expect(await n("SELECT count(*)::int AS n FROM llm_calls WHERE event_id = $1 AND step = 'company_tier'")).toBe(companies * 2);
  });
  it("pauses after 5 vendor errors in a row, then resumes where it paused", async () => {
    await approveAll();
    const down = (s: Settings) => { const v = mockVendors(s); v.verifiers = v.verifiers.map((x) => ({ ...x, verify: async () => { throw new VendorError("unknown"); } })); return v; };
    expect(await processEvent(db, id, { llm: mockLlm, vendorsFor: down })).toBe("paused");
    const [e] = await db.query<{ paused_from: string }>("SELECT paused_from FROM events WHERE id = $1", [id]);
    expect(e.paused_from).toBe("enriching");
    await moveEvent(db, id, "enriching", DAN);
    expect(await processEvent(db, id, mock)).toBe("delivered");
  });
  it("retries only when the vendor says it did not bill", async () => {
    await approveAll();
    let calls = 0;
    const flaky = (s: Settings) => { const v = mockVendors(s); const real = v.verifiers[0].verify; v.verifiers[0] = { ...v.verifiers[0], verify: async (e) => { if (++calls === 1) throw new VendorError(0); return real(e); } }; return v; };
    expect(await processEvent(db, id, { llm: mockLlm, vendorsFor: flaky })).toBe("delivered");
    expect(calls).toBeGreaterThan(1);
  });
  it("does not repeat a paid call whose worker died", async () => {
    await approveAll();
    let finderCalls = 0;
    const counting = (s: Settings) => { const v = mockVendors(s); v.finders = v.finders.map((f) => ({ ...f, find: async (p) => { finderCalls++; return f.find(p); } })); return v; };
    await processEvent(db, id, { llm: { ...mockLlm, complete: mockLlm.complete }, vendorsFor: (s) => mockVendors(s) }).catch(() => {});
    expect(await stage()).toBe("delivered");
    expect(finderCalls).toBe(0);
    // A lost job is handled as a miss, without calling the vendor.
    const fresh = (await createEvent(db, MAYA, { name: "U", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 1, flow: "single_card" })).id;
    const old = id; id = fresh; await approveAll(); id = old;
    await db.query("UPDATE events SET tiering_started = true, stage = 'enriching' WHERE id = $1", [fresh]);
    const [c] = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND dropped_at IS NULL LIMIT 1", [fresh]);
    await db.query(`INSERT INTO jobs (id, event_id, kind, payload, status, lease_until) VALUES ('job_lost', $1, 'find', $2::jsonb, 'running', now() - interval '1 hour')`, [fresh, JSON.stringify({ contact_id: c.id, index: 1, errored: false })]);
    await processEvent(db, fresh, { llm: mockLlm, vendorsFor: counting });
    expect(finderCalls).toBe(0);
    const [row] = await db.query<{ drop_reason: string }>("SELECT drop_reason FROM contacts WHERE id = $1", [c.id]);
    expect(row.drop_reason).toBe("vendor_error");
  });
});

describe("the workbook", () => {
  let db: Db, id: string;
  const deliver = async (csv: string) => {
    db = await freshDb();
    id = (await createEvent(db, MAYA, { name: "T", starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100 })).id;
    const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
    await decideApproval(db, { approvalId: await pending(), actor: DAN, decision: "approve" });
    await ingestUpload(db, id, MAYA, "a.csv", csv);
    // The workbook is built from the two-card flow, the one new events run.
    await finishTwoCard(db, id, mock);
  };
  const open = async () => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await buildWorkbook(db, id)) as never); return wb; };
  // People tabs: banner on rows 1 and 2, headers on row 3. Review: banner on rows 1 to 3, headers on row 4.
  const HEAD = 3, REVIEW_HEAD = 4;
  const colOf = (ws: ExcelJS.Worksheet, header: string, headRow = HEAD) => { const i = (ws.getRow(headRow).values as unknown[]).findIndex((v) => v === header); if (i < 1) throw new Error(`no column ${header}`); return i; };
  const plain = (v: ExcelJS.CellValue) => (v && typeof v === "object" && "text" in v ? String(v.text) : v && typeof v === "object" && "result" in v ? v.result : v);

  it("has the seven visible tabs in order, plus the hidden Lists tab", async () => {
    await deliver(LIST);
    const wb = await open();
    expect(wb.worksheets.filter((w) => w.state !== "hidden").map((w) => w.name)).toEqual(["Summary", "Review", "Attendees", "Prospects", "Companies", "Other attendees", "Meetings"]);
    expect(wb.getWorksheet("Lists")!.state).toBe("hidden");
    expect(wb.getWorksheet("Review")!.properties.tabColor?.argb).toBeTruthy();
  });
  it("puts priority first and both tiers on the row, and they agree", async () => {
    await deliver(LIST);
    const ws = (await open()).getWorksheet("Prospects")!;
    expect(ws.getCell(HEAD, 1).value).toBe("Priority");
    const company = colOf(ws, "Company tier"), title = colOf(ws, "Title tier");
    let rows = 0;
    ws.eachRow((row, n) => {
      if (n <= HEAD) return;
      rows++;
      expect(row.getCell(1).value).toBe(priority(row.getCell(company).value as 1 | 2 | 3, (row.getCell(title).value ?? null) as 1 | 2 | 3 | null));
    });
    expect(rows).toBeGreaterThan(0);
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 2, ySplit: HEAD });
    expect(ws.autoFilter).toBeTruthy();
  });
  it("keeps attendees and prospects on separate tabs", async () => {
    await deliver(LIST);
    const wb = await open();
    const names = (tab: string) => { const out: string[] = []; wb.getWorksheet(tab)!.eachRow((r, n) => { if (n > HEAD) out.push(String(r.getCell(2).value)); }); return out; };
    expect(names("Attendees")).toContain("Maya Serrano");
    expect(names("Prospects")).not.toContain("Maya Serrano");
    expect(names("Prospects").length).toBeGreaterThan(0);
  });
  it("is refused before delivery", async () => {
    db = await freshDb();
    id = (await createEvent(db, MAYA, { name: "T", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 1, flow: "single_card" })).id;
    await expect(buildWorkbook(db, id)).rejects.toThrow(/not delivered/);
  });
  it("imports a Drop from under the banner, matched on contact_id, and the counts follow", async () => {
    await deliver(LIST);
    await db.query(`INSERT INTO review_flags (contact_id, flag, source) SELECT id, 'name_looks_wrong', 'code' FROM contacts WHERE event_id = $1 AND dropped_at IS NULL ORDER BY id LIMIT 3 ON CONFLICT DO NOTHING`, [id]);
    const wb = await open();
    const ws = wb.getWorksheet("Review")!;
    expect(String(ws.getCell(1, 1).value)).toMatch(/^Review \(\d+ cases?\)$/);
    const idCol = colOf(ws, "contact_id", REVIEW_HEAD), decision = colOf(ws, "Decision", REVIEW_HEAD);
    expect(ws.getColumn(idCol).hidden).toBe(true);
    expect(ws.getCell(REVIEW_HEAD + 1, decision).dataValidation?.formulae).toEqual(['"Keep,Drop"']);
    // Row 5 drops, row 6 keeps, row 7 is left blank: only the first one changes anything.
    ws.getCell(REVIEW_HEAD + 1, decision).value = "Drop";
    ws.getCell(REVIEW_HEAD + 2, decision).value = "Keep";
    const dropped = String(ws.getCell(REVIEW_HEAD + 1, idCol).value);
    const before = (await listSummary(db, id)).people;
    expect(await importReview(db, id, DAN, (await wb.xlsx.writeBuffer()) as ArrayBuffer)).toEqual({ dropped: 1, answered: 0, skipped: 0 });
    const after = await listSummary(db, id);
    expect(after.people).toBe(before - 1);
    expect(after.dropped.find((d) => d.reason === "rejected_in_review")!.n).toBe(1);
    expect((await db.query<{ drop_reason: string }>("SELECT drop_reason FROM contacts WHERE id = $1", [dropped]))[0].drop_reason).toBe("rejected_in_review");
  });
  it("keeps a formula-looking name as plain text", async () => {
    await deliver('Company Name,Full Name,Job Title,Work Email\nTallgrass Software,"=HYPERLINK(""http://x.example"")",VP Sales,a@tallgrass.example\nTallgrass Software,"Real Person",VP Sales,b@tallgrass.example\nTallgrass Software,"Other Person",VP Sales,c@tallgrass.example\nTallgrass Software,"Fourth Person",VP Sales,d@tallgrass.example\n');
    const wb = await open();
    let seen = 0;
    wb.getWorksheet("Attendees")!.eachRow((row, n) => { if (n > HEAD) { seen++; expect(typeof row.getCell(2).value).toBe("string"); } });
    expect(seen).toBeGreaterThan(0);
  });
  it("keeps a real LinkedIn URL from the data, encoded, and replaces one that is not LinkedIn", async () => {
    await deliver('Company Name,Full Name,Job Title,Work Email,LinkedIn\nTallgrass Software,Real Person,VP Sales,a@tallgrass.example,linkedin.com/in/real person\nTallgrass Software,Other Person,VP Sales,b@tallgrass.example,javascript:alert(1)\n');
    const ws = (await open()).getWorksheet("Attendees")!;
    const li = colOf(ws, "LinkedIn");
    const links: Record<string, string> = {};
    ws.eachRow((row, n) => { if (n > HEAD) links[String(row.getCell(2).value)] = String((row.getCell(li).value as { hyperlink: string }).hyperlink); });
    expect(links["Real Person"]).toBe("https://www.linkedin.com/in/real%20person");
    // The bad value was dropped at ingest; the paid lookup found a real-form profile instead.
    expect(links["Other Person"]).toMatch(/^https:\/\/www\.linkedin\.com\/in\/other-person-/);
    expect(links["Other Person"]).not.toContain("javascript");
  });
  it("carries the CRM beside each person and company, and the heat is one of three words", async () => {
    await deliver(LIST);
    const wb = await open();
    const ws = wb.getWorksheet("Attendees")!;
    for (const h of ["Heat", "Account owner", "Open deal", "Outreach status", "Notes"]) expect(colOf(ws, h)).toBeGreaterThan(0);
    const co = wb.getWorksheet("Companies")!;
    const heat = colOf(co, "Heat");
    co.eachRow((row, n) => { if (n > HEAD) expect(["Hot", "Warm", "Cold", "Unknown"]).toContain(row.getCell(heat).value); });
    const rows = await db.query<{ heat: string; account_owner: string | null; deal_name: string | null }>("SELECT heat, account_owner, deal_name FROM companies WHERE event_id = $1 AND in_research AND identity_state = 'resolved' AND list_status IS NULL", [id]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(["hot", "warm", "cold"]).toContain(r.heat);
    expect(await db.query("SELECT 1 FROM credit_ledger WHERE event_id = $1 AND note LIKE 'crm%'", [id])).toHaveLength(0);
  });
  it("gives reps a status dropdown and fades a row they mark Not interested", async () => {
    await deliver(LIST);
    const ws = (await open()).getWorksheet("Attendees")!;
    const status = colOf(ws, "Outreach status");
    expect(ws.getCell(HEAD + 1, status).dataValidation?.formulae?.[0]).toContain("Not interested");
    const rules = (ws as unknown as { conditionalFormattings: ExcelJS.ConditionalFormattingOptions[] }).conditionalFormattings.flatMap((c) => c.rules.map((r) => ({ ref: c.ref, ...r })));
    expect(rules.some((r) => r.type === "expression" && String(r.formulae?.[0]).includes("Not interested") && r.ref.startsWith("A"))).toBe(true);
    expect(rules.some((r) => r.type === "expression" && r.formulae?.[0] === '$A4="A"')).toBe(true);
  });
  it("starts Meetings empty, with a contact dropdown from the list and lookups that fill company and owner", async () => {
    await deliver(LIST);
    const wb = await open();
    const ws = wb.getWorksheet("Meetings")!;
    expect(ws.getCell(HEAD + 1, 1).dataValidation?.formulae?.[0]).toMatch(/^Lists!\$A\$2/);
    expect(ws.getCell(HEAD + 1, colOf(ws, "Status")).dataValidation?.formulae?.[0]).toContain("Booked");
    const company = ws.getCell(HEAD + 1, 2).value as ExcelJS.CellFormulaValue;
    expect(company.formula).toMatch(/INDEX\(Lists!\$C\$2:\$C\$\d+,MATCH\(\$A4,Lists!\$A\$2/);
    expect(ws.getCell(HEAD + 1, 1).value ?? null).toBeNull();
    const lists = wb.getWorksheet("Lists")!;
    const labels: string[] = [];
    lists.eachRow((r, n) => { if (n > 1) labels.push(String(r.getCell(1).value)); });
    expect(labels).toContain("Maya Serrano, Brightwater Logistics, Inc.");
    expect(new Set(labels).size).toBe(labels.length);
  });
  it("keeps the Summary live with cached results that match the tabs", async () => {
    await deliver(LIST);
    const wb = await open();
    const ws = wb.getWorksheet("Summary")!;
    const formulas: { formula: string; result?: unknown }[] = [];
    ws.eachRow((row) => row.eachCell((c) => { if (c.value && typeof c.value === "object" && "formula" in c.value && typeof c.value.formula === "string") formulas.push(c.value as { formula: string; result?: unknown }); }));
    const people = formulas.find((f) => f.formula.startsWith("COUNTA(Attendees!"))!;
    expect(people.result).toBe((await listSummary(db, id)).people);
    const a = formulas.find((f) => f.formula.includes('"A"'))!;
    expect(a.result).toBe((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND priority = 'A'", [id]))[0].n);
    expect(formulas.some((f) => f.formula.includes("Meetings!"))).toBe(true);
    expect(ws.views[0].showGridLines).toBe(false);
    const title = plain(ws.getCell("A2").value);
    expect(title).toBe("T");
    let text = "";
    ws.eachRow((row) => row.eachCell((c) => { const v = c.value; text += typeof v === "string" ? v : v && typeof v === "object" && "richText" in v ? v.richText.map((t) => t.text).join("") : ""; }));
    // The Summary states the event, the list and the CRM's view; it never tells the reader what to do.
    expect(text).toMatch(/Why this event/);
    expect(text).toMatch(/Where we stand/);
    expect(text).not.toMatch(/Game plan/);
    expect(text).not.toMatch(/[–—]/);
  });
});

describe("Concierge", () => {
  let db: Db, id: string;
  beforeEach(async () => {
    db = await freshDb();
    await seed(db);
    id = "evt_quarry";
  });
  const toolText = async (name: string, args: Record<string, unknown>) => {
    const c = await connectConcierge(db);
    const r = await c.callTool({ name, arguments: args });
    return (r.content as { text: string }[]).map((x) => x.text).join("");
  };

  it("exposes only read tools", async () => {
    const c = await connectConcierge(db);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["company_counts", "drop_counts", "find_prospects", "list_events", "priority_counts"]);
  });
  it("returns counts with no money field in any tool", async () => {
    const outputs = await Promise.all([toolText("list_events", {}), toolText("priority_counts", { event_id: id }), toolText("company_counts", { event_id: id }), toolText("drop_counts", { event_id: id }), toolText("find_prospects", { event_id: id })]);
    for (const o of outputs) expect(o).not.toMatch(/"[^"]*(cost|credit|budget|price|spend|cents)[^"]*":/i);
    expect(JSON.parse(outputs[1]).length).toBeGreaterThan(0);
  });
  it("hides that the cap dropped anyone", async () => {
    await db.query("UPDATE contacts SET drop_reason = 'budget_cap', dropped_at = now() WHERE event_id = $1 AND dropped_at IS NULL AND id = (SELECT id FROM contacts WHERE event_id = $1 AND dropped_at IS NULL LIMIT 1)", [id]);
    expect(await toolText("drop_counts", { event_id: id })).not.toContain("budget_cap");
  });
  it("Postgres refuses the Concierge role on any money table", async () => {
    for (const table of ["cost_cards", "credit_ledger", "events", "llm_calls"]) {
      await expect(db.tx(async (q) => { await q("SET LOCAL ROLE concierge_reader"); return q(`SELECT * FROM ${table}`); })).rejects.toThrow(/permission denied/);
    }
  });
  it("sees nothing from an event that is not delivered", async () => {
    expect(JSON.parse(await toolText("priority_counts", { event_id: "evt_north" }))).toEqual([]);
  });
  it("answers a count question through a tool", async () => {
    expect(await askConcierge(db, await connectConcierge(db), mockLlm, id, "How many priority A contacts?")).toMatch(/contacts/);
  });
  it("replaces an answer that leaks money, even if the model tries", async () => {
    const leaky: Llm = { model: "leaky", async complete() { return { text: JSON.stringify({ answer: "We spent $4,200 on this." }), input_tokens: 0, output_tokens: 0 }; } };
    expect(await askConcierge(db, await connectConcierge(db), leaky, id, "Anything")).toBe(NO_MONEY);
  });
  it("cannot be pointed at another event by the model", async () => {
    const sneaky: Llm = { model: "sneaky", n: 0, async complete() { return { text: JSON.stringify((this as any).n++ === 0 ? { tool: "priority_counts", args: { event_id: "someone_else" } } : { answer: "done" }), input_tokens: 0, output_tokens: 0 }; } } as Llm;
    await askConcierge(db, await connectConcierge(db), sneaky, id, "Q");
    const [row] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM llm_calls WHERE event_id = $1 AND step = 'concierge'", [id]);
    expect(row.n).toBe(2);
  });
  it("says a list is not ready, and does not use a question", async () => {
    expect(await askConcierge(db, await connectConcierge(db), mockLlm, "evt_north", "How many?")).toMatch(/no delivered list/);
    expect((await db.query("SELECT 1 FROM activity_log WHERE event_id = 'evt_north' AND kind = 'concierge'")).length).toBe(0);
  });
  it("does not mistake a company name for money", async () => {
    const m: Llm = { model: "m", async complete() { return { text: JSON.stringify({ answer: "First Credit Union has 3 contacts." }), input_tokens: 0, output_tokens: 0 }; } };
    expect(await askConcierge(db, await connectConcierge(db), m, id, "Q")).toContain("First Credit Union");
  });
  it("stops at the question allowance", async () => {
    await db.query(`UPDATE event_settings SET settings = jsonb_set(settings, '{agent_question_limit}', '1') WHERE event_id = $1`, [id]);
    const c = await connectConcierge(db);
    await askConcierge(db, c, mockLlm, id, "How many A?");
    expect(await askConcierge(db, c, mockLlm, id, "How many B?")).toBe(USED_UP);
  });
});
