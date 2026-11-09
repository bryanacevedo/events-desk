import { createVerify, generateKeyPairSync } from "node:crypto";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { decideApproval, requestCard } from "../src/server/approvals.ts";
import { createEvent, moveEvent, RuleError } from "../src/server/events.ts";
import { processEvent, type Deps } from "../src/server/pipeline.ts";
import { mockLlm, mockVendors } from "../src/server/providers.ts";
import { publishSheet, syncReview } from "../src/server/sheet-delivery.ts";
import { googleSheets, mockSheets, parseServiceAccount, sheetsFor, type SheetPublisher } from "../src/server/sheets.ts";
import { ingestUpload, listSummary } from "../src/server/uploads.ts";
import { cellText, sniff } from "../src/server/xlsx-read.ts";
import { applyReviewDrops, buildWorkbook } from "../src/server/workbook.ts";
import { finishTwoCard, freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock";
const bytes = async (wb: ExcelJS.Workbook) => new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);

/* ------------------------------------------------------------------ uploads */

describe("excel uploads", () => {
  let db: Db, id: string;
  beforeEach(async () => {
    db = await freshDb();
    id = (await createEvent(db, MAYA, { name: "T", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 100 })).id;
    await moveEvent(db, id, "approved", DAN);
  });
  const stage = async () => (await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage;

  it("detects the file type from its bytes, not its name", async () => {
    const wb = new ExcelJS.Workbook(); wb.addWorksheet("A").addRow(["Company"]);
    expect(sniff(await bytes(wb))).toBe("xlsx");
    expect(sniff(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toBe("xls");
    expect(sniff(new TextEncoder().encode("Company,Name\nA,B\n"))).toBe("csv");
    expect(sniff(new TextEncoder().encode("%PDF-1.7"))).toBe("other");
    expect(sniff(Uint8Array.from([65, 0, 66, 0]))).toBe("other");
  });

  it("reads a workbook with a title row, rich text, a formula result, a date and a second, smaller sheet", async () => {
    const wb = new ExcelJS.Workbook();
    const small = wb.addWorksheet("Notes"); small.addRow(["Company"]); small.addRow(["Wrong Co"]);
    const ws = wb.addWorksheet("Attendees");
    ws.addRow(["Summit attendee export"]);
    ws.addRow(["Company Name", "Full Name", "Job Title", "Work Email", "Registered"]);
    const rich = { richText: [{ text: "Tallgrass ", font: { bold: true } }, { text: "Software" }] };
    ws.addRow([rich, "Ana Beltran", "VP Sales", { text: "ana@tallgrass.example", hyperlink: "mailto:ana@tallgrass.example" }, new Date(Date.UTC(2027, 0, 5))]);
    ws.addRow(["Tallgrass Software", "Bo Lindqvist", { formula: "UPPER(\"head of growth\")", result: "HEAD OF GROWTH" }, "bo@tallgrass.example", ""]);
    ws.addRow(["Kestrel Foods", "=1+1", "CEO", "k@kestrel.example", ""]);
    // The file goes in under a .csv name; the bytes decide.
    await ingestUpload(db, id, MAYA, "list.csv", await bytes(wb));
    expect(await stage()).toBe("mapped");
    expect(await listSummary(db, id)).toMatchObject({ companies: 2, people: 3 });
    const rows = await db.query<{ full_name: string; title: string; email: string }>("SELECT full_name, title, email FROM contacts WHERE event_id = $1 ORDER BY full_name", [id]);
    expect(rows.map((r) => r.full_name)).toEqual(["=1+1", "Ana Beltran", "Bo Lindqvist"]);
    expect(rows.find((r) => r.full_name === "Ana Beltran")!.email).toBe("ana@tallgrass.example");
    expect(rows.find((r) => r.full_name === "Bo Lindqvist")!.title).toBe("HEAD OF GROWTH");
    expect((await db.query<{ name: string }>("SELECT name FROM companies WHERE event_id = $1 AND key = 'tallgrass software'", [id]))[0].name).toBe("Tallgrass Software");
    const raw = await db.query<{ raw: Record<string, string> }>("SELECT raw FROM source_rows WHERE event_id = $1 AND row_number = 1", [id]);
    expect(raw[0].raw.Registered).toBe("2027-01-05");
    expect(await db.query("SELECT 1 FROM companies WHERE name = 'Wrong Co'")).toHaveLength(0);
  });

  it("turns every cell kind into plain text and never runs a formula", () => {
    expect(cellText({ formula: "HYPERLINK(\"http://x\")" })).toBe("");
    expect(cellText({ error: "#N/A" })).toBe("");
    expect(cellText({ text: "", hyperlink: "mailto:a@b.example" })).toBe("a@b.example");
    expect(cellText(new Date(Date.UTC(2027, 0, 5, 9, 30)))).toBe("2027-01-05 09:30:00");
    expect(cellText(42.5)).toBe("42.5");
  });

  it("refuses .xls with a clear message and an unreadable file with another, and changes nothing", async () => {
    const xls = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]);
    await expect(ingestUpload(db, id, MAYA, "old.xlsx", xls)).rejects.toThrow(/save it as \.xlsx or CSV/);
    const junk = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9, 9, 9]);
    await expect(ingestUpload(db, id, MAYA, "x.xlsx", junk)).rejects.toThrow(/could not be read/);
    await expect(ingestUpload(db, id, MAYA, "x.xlsx", junk)).rejects.toBeInstanceOf(RuleError);
    expect(await stage()).toBe("approved");
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM companies"))[0].n).toBe(0);
  });

  it("changes nothing when a workbook has no company, email or LinkedIn column", async () => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("A"); ws.addRow(["Name", "Notes"]); ws.addRow(["A", "hello"]);
    await expect(ingestUpload(db, id, MAYA, "x.xlsx", await bytes(wb))).rejects.toThrow(/No company, email or LinkedIn column/);
    expect(await stage()).toBe("approved");
  });

  it("accepts raw bytes over HTTP, CSV and xlsx alike", async () => {
    const app = createApp(db, { demo: true });
    const post = (body: BodyInit, name: string) => app.request(`/api/events/${id}/upload`, { method: "POST", body, headers: { "x-actor": MAYA, "x-filename": name } });
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("A"); ws.addRow(["Company", "Name"]); ws.addRow(["Acme", "Zed Ray"]);
    const res = await post(await bytes(wb) as never, "list.xlsx");
    expect(res.status).toBe(200);
    expect((await listSummary(db, id)).people).toBe(1);
    const again = await post(new TextEncoder().encode("Company\nAcme\n"), "x.csv");
    // A new list replaces the old one while nothing is paid for, and its uploader becomes the one who confirms the cost card.
    expect(again.status).toBe(200);
    expect((await listSummary(db, id)).people).toBe(0);
  });
});

/* ------------------------------------------------------------ Google Sheets */

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ACCOUNT = { client_email: "desk@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };

/** A fake Drive and Sheets. It records every call and never touches the network. */
function fakeGoogle() {
  const calls: { url: string; method: string; body: string }[] = [];
  const files = new Map<string, Buffer>();
  const perms: { id: string; body: any }[] = [];
  let failNext: string | null = null; // "upload" | "permission" | "values" | "polish"
  let decisions: Record<string, string> = {}; // contact_id -> Decision typed into the Sheet
  const batches: { id: string; requests: any[] }[] = []; // every batchUpdate the polish sent
  const f = (async (input: any, init: any = {}) => {
    const url = String(input), method = init.method ?? "GET";
    const raw = init.body instanceof Uint8Array ? Buffer.from(init.body) : Buffer.from(String(init.body ?? ""));
    calls.push({ url, method, body: raw.length < 5000 ? raw.toString("utf8") : "<binary>" });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const a = new URLSearchParams(String(init.body)).get("assertion")!.split(".");
      expect(createVerify("RSA-SHA256").update(`${a[0]}.${a[1]}`).verify(publicKey, Buffer.from(a[2], "base64url"))).toBe(true);
      return json({ access_token: "tok", expires_in: 3600 });
    }
    expect(init.headers.authorization).toBe("Bearer tok");
    const take = (k: string) => { if (failNext === k) { failNext = null; return true; } return false; };
    if (url.includes("/upload/drive/v3/files")) {
      if (take("upload")) return json({ error: { message: "storageQuotaExceeded" } }, 403);
      const start = raw.indexOf(Buffer.from("\r\n\r\n"), raw.indexOf(Buffer.from("\r\n\r\n")) + 4) + 4;
      const id = `file${files.size + 1}`;
      files.set(id, raw.subarray(start, raw.lastIndexOf(Buffer.from("\r\n--"))));
      return json({ id });
    }
    if (url.includes("/permissions")) {
      if (take("permission")) return json({ error: { message: "domain sharing is disabled" } }, 403);
      perms.push({ id: decodeURIComponent(url.split("/files/")[1].split("/")[0]), body: JSON.parse(String(init.body)) });
      return json({ id: "perm" });
    }
    if (url.startsWith("https://sheets.googleapis.com/")) {
      const id = decodeURIComponent(url.split("/spreadsheets/")[1].split(/[/?:]/)[0]);
      if (url.includes(":batchUpdate")) {
        if (take("polish")) return json({ error: { message: "polish refused" } }, 400);
        batches.push({ id, requests: JSON.parse(String(init.body)).requests });
        return json({ spreadsheetId: id, replies: [] });
      }
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(files.get(id) as never);
      // spreadsheets.get: the converted tabs with their ids, in file order.
      if (url.includes("fields=")) return json({ sheets: wb.worksheets.map((w, i) => ({ properties: { sheetId: i * 7, title: w.name } })) });
      if (take("values")) return json({ error: { message: "nope" } }, 500);
      const values: string[][] = [];
      wb.getWorksheet("Review")!.eachRow((row, n) => { const cells: string[] = []; row.eachCell({ includeEmpty: true }, (c, col) => { cells[col - 1] = cellText(c.value); }); values[n - 1] = cells; });
      // Review columns: case_id, contact_id (both hidden), Case, Name, ... Decision is the thirteenth.
      const head = values.findIndex((r) => r?.[1] === "contact_id");
      for (let i = head + 1; i < values.length; i++) if (values[i] && decisions[values[i][1]]) values[i][12] = decisions[values[i][1]];
      return json({ values: values.map((r) => r ?? []) });
    }
    return json({ error: { message: "unexpected" } }, 404);
  }) as typeof fetch;
  return { fetch: f, calls, files, perms, batches, fail: (k: string) => { failNext = k; }, decide: (d: Record<string, string>) => { decisions = d; } };
}

const publisher = (g: ReturnType<typeof fakeGoogle>) => googleSheets({ account: ACCOUNT, folderId: "folder9", shareDomain: "Example.com", fetch: g.fetch });
const LIST = "Company Name,Full Name,Job Title,Work Email\nTallgrass Software,Real Person,VP Sales,a@tallgrass.example\nTallgrass Software,Other Person,VP Sales,b@tallgrass.example\nTallgrass Software,Third Person,VP Sales,c@tallgrass.example\nTallgrass Software,Fourth Person,VP Sales,d@tallgrass.example\n";

describe("Google Sheet delivery", () => {
  let db: Db, id: string;
  const evt = async (eid = id) => (await db.query<any>("SELECT stage, sheet_id, sheet_url, sheet_error FROM events WHERE id = $1", [eid]))[0];
  const activity = async (eid = id) => (await db.query<{ detail: string }>("SELECT detail FROM activity_log WHERE event_id = $1 AND kind = 'sheet'", [eid])).map((r) => r.detail);
  async function deliver(sheets?: SheetPublisher, name = "T") {
    const deps: Deps = { llm: mockLlm, vendorsFor: mockVendors, sheets };
    const eid = (await createEvent(db, MAYA, { name, starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100 })).id;
    const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [eid]))[0].id;
    await decideApproval(db, { approvalId: await pending(), actor: DAN, decision: "approve" });
    await ingestUpload(db, eid, MAYA, "a.csv", LIST);
    await finishTwoCard(db, eid, deps);
    return eid;
  }
  beforeEach(async () => { db = await freshDb(); });

  it("publishes once at delivery, shares with the domain as writers, and never uses anyone", async () => {
    const g = fakeGoogle();
    id = await deliver(publisher(g));
    const e = await evt();
    expect(e.stage).toBe("delivered");
    expect(e.sheet_id).toBe("file1");
    expect(e.sheet_url).toBe("https://docs.google.com/spreadsheets/d/file1/edit");
    expect(e.sheet_error).toBeNull();
    expect(g.files.size).toBe(1);
    const upload = g.calls.find((c) => c.url.includes("/upload/drive/v3/files"))!;
    expect(upload.url).toContain("supportsAllDrives=true");
    expect(upload.url).toContain("uploadType=multipart");
    expect(upload.body).toBe("<binary>");
    // The multipart metadata names the folder and asks Drive to convert.
    const head = g.calls.find((c) => c.url.includes("/upload/drive/v3/files"))!;
    expect(head).toBeTruthy();
    expect(g.perms).toHaveLength(1);
    expect(g.perms[0].body).toMatchObject({ type: "domain", role: "writer", domain: "example.com" });
    expect(JSON.stringify(g.perms)).not.toMatch(/anyone/i);
    expect(g.calls.find((c) => c.url.includes("/permissions"))!.url).toContain("supportsAllDrives=true");
    expect(await activity()).toEqual(["Published the outreach list to Google Sheets"]);
    // The Google layer ran after the upload: fonts and tab colors, chips, saved views, the Summary bars. Nothing in it shares the file.
    const sent = g.batches.flatMap((b) => b.requests);
    expect(g.batches.length).toBeGreaterThanOrEqual(3);
    expect(sent.some((r) => r.updateSheetProperties?.properties?.tabColorStyle)).toBe(true);
    expect(sent.some((r) => r.repeatCell?.cell?.userEnteredFormat?.textFormat?.fontFamily === "Geist")).toBe(true);
    expect(sent.some((r) => r.setDataValidation?.rule?.showCustomUi === true)).toBe(true);
    expect(sent.some((r) => r.addProtectedRange)).toBe(false);
    expect(sent.some((r) => r.addFilterView?.filter?.title === "Priority A")).toBe(true);
    expect(sent.some((r) => r.addDimensionGroup)).toBe(true);
    expect(sent.some((r) => String(r.updateCells?.rows?.[0]?.values?.[0]?.userEnteredValue?.formulaValue).startsWith("=SPARKLINE("))).toBe(true);
    expect(JSON.stringify(sent)).not.toMatch(/anyone/i);
  });

  it("a refused polish batch leaves the Sheet published with its link and says so in the activity", async () => {
    const g = fakeGoogle(); const pub = publisher(g);
    g.fail("polish");
    id = await deliver(pub);
    const e = await evt();
    expect(e.sheet_url).toBe("https://docs.google.com/spreadsheets/d/file1/edit");
    expect(e.sheet_error).toBeNull();
    const lines = await activity();
    expect(lines[0]).toBe("Published the outreach list to Google Sheets");
    expect(lines[1]).toMatch(/Sheet polish skipped look \(.*polish refused/);
    // The other batches still went through.
    expect(g.batches.length).toBeGreaterThanOrEqual(2);
  });

  it("sends the folder and the Sheet mime type in the upload metadata, and the real workbook bytes", async () => {
    let seen = "";
    const g = fakeGoogle();
    const spy: typeof fetch = async (u, i) => { if (String(u).includes("/upload/")) seen = Buffer.from(i!.body as Uint8Array).toString("latin1"); return g.fetch(u, i); };
    id = await deliver(googleSheets({ account: ACCOUNT, folderId: "folder9", shareDomain: "example.com", fetch: spy }));
    expect(seen).toContain('"parents":["folder9"]');
    expect(seen).toContain('"mimeType":"application/vnd.google-apps.spreadsheet"');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(g.files.get("file1") as never);
    expect(wb.getWorksheet("Review")).toBeTruthy();
  });

  it("is idempotent: publishing again, or retrying over HTTP, makes no second Sheet", async () => {
    const g = fakeGoogle(); const pub = publisher(g);
    id = await deliver(pub);
    await publishSheet(db, id, DAN, pub);
    const app = createApp(db, { demo: false, sheets: pub });
    const res = await app.request(`/api/events/${id}/sheet`, { method: "POST", headers: { "x-actor": DAN } });
    expect(res.status).toBe(200);
    expect((await res.json() as any).sheet_url).toBe("https://docs.google.com/spreadsheets/d/file1/edit");
    expect(g.files.size).toBe(1);
    expect(g.perms).toHaveLength(1);
  });

  it("a Google failure leaves the event delivered, records why, and a retry works", async () => {
    const g = fakeGoogle(); const pub = publisher(g);
    g.fail("upload");
    id = await deliver(pub);
    let e = await evt();
    expect(e.stage).toBe("delivered");
    expect(e.sheet_url).toBeNull();
    expect(e.sheet_error).toMatch(/403.*storageQuotaExceeded/);
    expect((await activity())[0]).toMatch(/download still works/);
    expect((await buildWorkbook(db, id)).length).toBeGreaterThan(1000); // the fallback file still builds
    const app = createApp(db, { demo: false, sheets: pub });
    const res = await app.request(`/api/events/${id}/sheet`, { method: "POST", headers: { "x-actor": DAN } });
    expect((await res.json() as any).sheet_error).toBeNull();
    e = await evt();
    expect(e.sheet_url).toMatch(/file1/);
    expect(e.sheet_error).toBeNull();
    expect(g.files.size).toBe(1);
  });

  it("a sharing failure keeps the file id, hides the link, and the retry only shares", async () => {
    const g = fakeGoogle(); const pub = publisher(g);
    g.fail("permission");
    id = await deliver(pub);
    let e = await evt();
    expect(e.sheet_id).toBe("file1");
    expect(e.sheet_url).toBeNull();
    expect(e.sheet_error).toMatch(/domain sharing is disabled/);
    await publishSheet(db, id, DAN, pub);
    e = await evt();
    expect(e.sheet_url).toBeTruthy();
    expect(g.files.size).toBe(1);
    expect(g.perms).toHaveLength(1);
  });

  it("returns the link and error from GET /api/events/:id, and not the id", async () => {
    const g = fakeGoogle();
    id = await deliver(publisher(g));
    const body = await (await createApp(db, { demo: false }).request(`/api/events/${id}`)).json() as any;
    expect(body.event.sheet_url).toMatch(/docs\.google\.com/);
    expect(body.event.sheet_error).toBeNull();
    expect(body.event).not.toHaveProperty("sheet_id");
  });

  it("sync applies Drops from the Sheet, ignores Keep and blanks, and ignores contacts from another event", async () => {
    const g = fakeGoogle(); const pub = publisher(g);
    id = await deliver(undefined);
    const other = await deliver(undefined, "Other");
    const mine = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND dropped_at IS NULL ORDER BY id", [id]);
    const theirs = (await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND dropped_at IS NULL LIMIT 1", [other]))[0].id;
    expect(mine.length).toBeGreaterThanOrEqual(3);
    await db.query("INSERT INTO review_flags (contact_id, flag, source) VALUES ($1, 'name_looks_wrong', 'code'), ($2, 'name_looks_wrong', 'code'), ($3, 'name_looks_wrong', 'code') ON CONFLICT DO NOTHING", [mine[0].id, mine[1].id, mine[2].id]);
    await publishSheet(db, id, DAN, pub);
    expect((await evt()).sheet_id).toBe("file1");
    g.decide({ [mine[0].id]: "Drop", [mine[1].id]: "Keep", [theirs]: "Drop", unknown_id: "Drop" });
    const app = createApp(db, { demo: false, sheets: pub });
    const res = await app.request(`/api/events/${id}/review/sync`, { method: "POST", headers: { "x-actor": DAN } });
    // A person with an open case answers through the case (Drop, or Keep); a flagged person with no case is dropped directly. Either way one person leaves.
    const out = await res.json() as { dropped: number; answered: number; skipped: number };
    expect(out.dropped + out.answered).toBeGreaterThanOrEqual(1);
    const state = async (cid: string) => (await db.query<{ drop_reason: string | null }>("SELECT drop_reason FROM contacts WHERE id = $1", [cid]))[0].drop_reason;
    expect(await state(mine[0].id)).toBe("rejected_in_review");
    expect(await state(mine[1].id)).toBeNull();
    expect(await state(mine[2].id)).toBeNull();
    expect(await state(theirs)).toBeNull();
    // Syncing twice changes nothing more.
    expect(await syncReview(db, id, DAN, pub)).toMatchObject({ dropped: 0, answered: 0 });
  });

  it("applyReviewDrops is the one rule: the screen and both imports reach the same result", async () => {
    id = await deliver(undefined);
    const [a, b] = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND dropped_at IS NULL ORDER BY id LIMIT 2", [id]);
    expect(await applyReviewDrops(db, id, DAN, [a.id, a.id, " ", "nobody"])).toEqual({ dropped: 1 });
    expect(await applyReviewDrops(db, id, DAN, [a.id, b.id])).toEqual({ dropped: 1 });
  });

  it("sync reports a Google read failure without changing anything, and refuses when there is no Sheet", async () => {
    const g = fakeGoogle(); const pub = publisher(g);
    id = await deliver(undefined);
    await expect(syncReview(db, id, DAN, pub)).rejects.toThrow(/no Google Sheet/);
    await publishSheet(db, id, DAN, pub);
    g.fail("values");
    await expect(syncReview(db, id, DAN, pub)).rejects.toThrow(/Could not read the Google Sheet/);
  });

  it("demo and spend-off modes never reach Google", async () => {
    const boom: typeof fetch = async () => { throw new Error("network used"); };
    const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(ACCOUNT), GOOGLE_DRIVE_FOLDER_ID: "f", GOOGLE_SHARE_DOMAIN: "example.com" };
    const pub = sheetsFor(false, env, boom);
    expect(pub).toBe(mockSheets);
    expect(pub.enabled).toBe(false);
    id = await deliver(pub);
    const e = await evt();
    expect(e).toMatchObject({ stage: "delivered", sheet_id: null, sheet_url: null, sheet_error: null });
    expect(await activity()).toEqual([]);
    const app = createApp(db, { demo: true });
    expect((await app.request(`/api/events/${id}/sheet`, { method: "POST", headers: { "x-actor": DAN } })).status).toBe(409);
    expect((await app.request(`/api/events/${id}/review/sync`, { method: "POST", headers: { "x-actor": DAN } })).status).toBe(409);
    // A pipeline with no publisher at all behaves the same.
    const bare = await deliver(undefined, "Bare");
    expect((await evt(bare)).sheet_id).toBeNull();
  });

  it("live mode needs sane Google settings and refuses anything but a plain domain", () => {
    const ok = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(ACCOUNT), GOOGLE_DRIVE_FOLDER_ID: "f", GOOGLE_SHARE_DOMAIN: "example.com" };
    expect(sheetsFor(true, ok).enabled).toBe(true);
    expect(() => sheetsFor(true, { ...ok, GOOGLE_SHARE_DOMAIN: "anyone" })).toThrow(/domain/);
    expect(() => sheetsFor(true, { ...ok, GOOGLE_SHARE_DOMAIN: "" })).toThrow(/needs either/);
    expect(() => sheetsFor(true, { ...ok, GOOGLE_SERVICE_ACCOUNT_JSON: "{" })).toThrow(/valid JSON/);
    expect(() => parseServiceAccount("{}")).toThrow(/client_email/);
  });
});
