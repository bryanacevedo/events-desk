/* The delivered list, built by code. One model writes one thing into it: the perspective at the top of the Summary
   (src/server/perspective-run.ts), and only text that code has checked word by word and number by number. Every other cell is
   composed from stored fields. Where the model's text is missing or fails a check, `perspective(d)` below writes that block.

   Each tab is laid out around what its reader does there:
   - Summary:    someone opening the file cold reads what this event is, what the attendee list is against the ICP,
                 and where the accounts stand in the CRM. It states; it never directs. Outbound after review runs
                 through sequences, so nobody is pointed anywhere from this tab.
   - Review:     a reviewer clears the cases that need a person, grouped by case, with the options that case allows; blank means Keep.
   - Attendees,
     Prospects:  a rep reads one person with their company, the vendor's detail and the CRM relationship beside them,
                 and tracks their own outreach in the two columns they fill in.
   - Companies:  a marketing lead's account view: fit, firmographics, CRM and where the account stands on the outreach list.
   - Other attendees: people from the attendee list at a tier 3 company or with a tier 3 title, one row each. Only when the attendee list had people.
   - Meetings:   anyone at the event logs a meeting; the Summary counts it live.
   - Lists:      hidden; feeds the Meetings dropdown and its lookups.

   Columns sit in labelled groups, and the detail a reader needs less often is in a folded group, so the first screen stays readable.
   Everything from the CSV is written as text, never as a formula. Every hyperlink built from data goes through `safeUrl` or `encodeURIComponent`.
   The .xlsx stands on its own in Excel. The Google-native layer (fonts, chips, filter views, groups) is added after upload by
   sheets-polish.ts from the `SheetPlan` that `buildDelivery` returns beside the bytes. */

import { stopContacts } from "./enroll-ops.ts";
import ExcelJS from "exceljs";
import { getSettingsNow } from "./approvals.ts";
import type { Db } from "./db.ts";
import { logActivity, RuleError } from "./events.ts";
import { spend } from "./ledger.ts";
import { eventUse } from "./usage.ts";
import type { Heat } from "./providers.ts";
import { listSummary } from "./uploads.ts";
import { cellText } from "./xlsx-read.ts";
import { cleanLinkedin } from "../shared/ingest.ts";
import { FLAG_WORDS } from "../shared/tiers.ts";
import { answerCase, type CaseOption } from "./cases.ts";
import { sizeBand } from "../shared/icp.ts";
import type { FirmoRecord } from "../shared/tiering.ts";
import { vendorWords } from "../shared/vendors.ts";
import { GOALS } from "./seats.ts";
import { buildPacket, packetHash, PART_TITLES, storedOf } from "./perspective-model.ts";
import { PARTS, type Part } from "./perspective-check.ts";
import type { PlanDropdown, PlanFilterView, PlanGroup, SheetPlan, TabPlan } from "./sheets-polish.ts";

/* ------------------------------------------------------------------ palette */

// The app's family. Words are ink or mute, always; color lives on fills, bands and marks.
const INK = "FF15231B", MUTE = "FF5E6A62", LINE = "FFE3E8E4", GREEN = "FF1F5D3F", SAND = "FFE9DFCB", ORANGE = "FFD1501C", WHITE = "FFFFFFFF";
// Washes: the brand colors at about fifteen percent on white, for a cell that carries a state word.
const GREEN_WASH = "FFDDE7E2", ORANGE_WASH = "FFF8E5DD", GROUND = "FFF5F6F5";
const hexOf = (argb: string) => `#${argb.slice(2)}`;

const FONT = "Arial";
const font = (o: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ name: FONT, size: 10, color: { argb: INK }, ...o });
const solid = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
// Conditional-format fills are "differential" styles, where Excel reads the background color.
const cfFill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", bgColor: { argb } });
const hair: Partial<ExcelJS.Borders> = { bottom: { style: "thin", color: { argb: LINE } } };

/** The band a column group is drawn in. Green and orange carry white text; sand and line carry ink. */
type Band = "green" | "sand" | "line" | "orange";
const BAND: Record<Band, { fill: string; ink: string }> = { green: { fill: GREEN, ink: WHITE }, sand: { fill: SAND, ink: INK }, line: { fill: LINE, ink: INK }, orange: { fill: ORANGE, ink: WHITE } };

/* ------------------------------------------------------------------ helpers */

const text = (v: unknown) => (v == null ? "" : String(v));
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const num = (n: number) => n.toLocaleString("en-US");
const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "0%");
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const joinAnd = (xs: string[]) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const listWords = (xs: string[], max = 3) => xs.length <= max ? joinAnd(xs) : `${xs.slice(0, max).join(", ")} and ${xs.length - max} more`;
const longDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const words = (s: string | null | undefined) => (s ? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "");
const col = (n: number) => { let s = ""; for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s; return s; };

/** A URL from the data, or null. Anything that is not http(s) stays plain text. */
export function safeUrl(raw: string | null | undefined): string | null {
  const s = text(raw).trim();
  if (!s) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try { const u = new URL(withScheme); return u.protocol === "https:" || u.protocol === "http:" ? u.href : null; } catch { return null; }
}
const searchUrl = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
const sheetRef = (tab: string, cell: string) => `#'${tab.replace(/'/g, "''")}'!${cell}`;

function setLink(cell: ExcelJS.Cell, label: string, url: string, tooltip?: string) {
  cell.value = { text: label, hyperlink: url, tooltip };
  cell.font = font({ color: { argb: GREEN }, underline: true });
}
function setFormula(cell: ExcelJS.Cell, formula: string, result: number | string) {
  cell.value = { formula, result } as ExcelJS.CellFormulaValue;
}
/** One validation for a whole range. Per-cell validations get merged by ExcelJS into overlapping ranges, which Excel repairs away. */
function addValidation(ws: ExcelJS.Worksheet, range: string, dv: ExcelJS.DataValidation) {
  (ws as unknown as { dataValidations: { add(address: string, v: ExcelJS.DataValidation): void } }).dataValidations.add(range, dv);
}

/** Room for a bold header and the filter button that Sheets and Excel draw over it. */
const headerFit = (c: { header: string; width: number; hidden?: boolean }) => (c.hidden ? c.width : Math.max(c.width, Math.ceil(c.header.length * 1.25) + 5));
/** Characters of 10-point text per column width unit (a unit is the width of one digit). Arial and Geist average narrower than a digit; this stays under that so nothing is cut. */
const CHARS_PER_UNIT = 0.95;

/** Height for wrapped text. Merged cells never auto-fit, so this wraps by word, the way the sheet will, and leaves a margin. */
function wrapHeight(text: string, charsPerLine: number, lineHeight: number, padding: number) {
  let lines = 0;
  for (const para of text.split("\n")) {
    let used = 0;
    let count = 1;
    for (const word of para.split(/\s+/)) {
      if (used && used + 1 + word.length > charsPerLine) { count++; used = word.length; }
      else used += (used ? 1 : 0) + word.length;
    }
    lines += count;
  }
  return padding + lineHeight * lines;
}

/** Every wrapping text cell whose row is too short for it. Merged cells never auto-fit, so the Summary is sized from this, and a test holds it to zero. */
export function wrapShortfalls(ws: ExcelJS.Worksheet) {
  const out: { row: number; col: number; needs: number; has: number }[] = [];
  ws.eachRow({ includeEmpty: true }, (row, r) => {
    for (let c = 1; c <= ws.columnCount; c++) {
      const cell = row.getCell(c);
      if (cell.isMerged && cell.master !== cell) continue;
      if (!cell.alignment?.wrapText || typeof cell.value === "number" || cell.value == null || (cell.value as { formula?: string }).formula) continue;
      if (cell.isMerged && ws.getRow(r + 1).getCell(c).master === cell) continue;
      let width = ws.getColumn(c).width ?? 9;
      for (let n = c + 1; n <= ws.columnCount && row.getCell(n).master === cell; n++) width += ws.getColumn(n).width ?? 9;
      const size = cell.font?.size ?? 10;
      const bold = cell.font?.bold ? 0.92 : 1;
      const needs = wrapHeight(String(cell.text), Math.max(1, Math.floor(width * CHARS_PER_UNIT * (10 / size) * bold)), Math.ceil(size * 1.5), 8);
      const has = row.height ?? 15;
      if (has < needs) out.push({ row: r, col: c, needs, has });
    }
  });
  const tallest = new Map<number, (typeof out)[number]>();
  for (const f of out) if ((tallest.get(f.row)?.needs ?? 0) < f.needs) tallest.set(f.row, f);
  return [...tallest.values()];
}

/** Widens each column that does not wrap to its longest value, within reason. */
function fitColumnsToData(ws: ExcelJS.Worksheet, columns: ColumnSpec[], first: number, last: number) {
  columns.forEach((c, i) => {
    if (c.hidden || c.wrap) return;
    let longest = 0;
    for (let r = first; r <= last; r++) longest = Math.max(longest, String(ws.getRow(r).getCell(i + 1).text ?? "").length);
    ws.getColumn(i + 1).width = Math.max(headerFit(c), Math.min(Math.ceil(longest * 1.08) + 3, 60));
  });
}

/** `group` names the band the column sits in; `edit` marks a column a person fills in; `mute` is secondary data drawn in mute. */
interface ColumnSpec { header: string; width: number; align?: "left" | "right" | "center"; wrap?: boolean; numFmt?: string; hidden?: boolean; group: string; edit?: boolean; mute?: boolean }
interface GroupSpec { label: string; band: Band; fold?: boolean }

const groupSpans = (columns: ColumnSpec[], groups: GroupSpec[]): PlanGroup[] =>
  groups.map((g) => { const idx = columns.map((c, i) => (c.group === g.label ? i + 1 : 0)).filter(Boolean); return { label: g.label, from: idx[0], to: idx[idx.length - 1], folded: !!g.fold }; }).filter((g) => g.from);

/** A tab: title row, a row of group bands, a header row, filters, frozen name columns. Columns of a folded group are hidden under an outline, so Excel shows them behind a control. */
function table(wb: ExcelJS.Workbook, name: string, title: string, columns: ColumnSpec[], groups: GroupSpec[], opts: { freezeCols?: number; tab?: string; headerRow?: number } = {}) {
  const H = opts.headerRow ?? 3;
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", xSplit: opts.freezeCols ?? 0, ySplit: H, showGridLines: false }] });
  if (opts.tab) ws.properties.tabColor = { argb: opts.tab };
  const folded = new Set(groups.filter((g) => g.fold).map((g) => g.label));
  ws.columns = columns.map((c) => ({ width: headerFit(c), hidden: c.hidden || folded.has(c.group), ...(folded.has(c.group) ? { outlineLevel: 1 } : {}) }));
  if (folded.size) ws.properties.outlineLevelCol = 1;
  const last = col(columns.length);
  ws.mergeCells(`A1:${last}1`);
  ws.getCell("A1").value = title;
  ws.getCell("A1").font = font({ size: 14, bold: true });
  ws.getCell("A1").alignment = { vertical: "bottom" };
  ws.getRow(1).height = 28;
  // Group bands: one merged, filled cell per group, right above its columns.
  const bandRow = H - 1;
  for (const g of groupSpans(columns, groups)) {
    const spec = groups.find((x) => x.label === g.label)!;
    if (g.to > g.from) ws.mergeCells(`${col(g.from)}${bandRow}:${col(g.to)}${bandRow}`);
    const cell = ws.getCell(`${col(g.from)}${bandRow}`);
    cell.value = g.label;
    cell.fill = solid(BAND[spec.band].fill);
    cell.font = font({ size: 9, bold: true, color: { argb: BAND[spec.band].ink } });
    cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  }
  ws.getRow(bandRow).height = 18;
  const head = ws.getRow(H);
  columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = font({ bold: true });
    cell.border = { bottom: { style: "medium", color: { argb: INK } } };
    cell.alignment = { vertical: "middle", horizontal: c.align ?? "left", indent: c.align ? 0 : 1 };
  });
  head.height = 24;
  ws.autoFilter = { from: `A${H}`, to: `${last}${H}` };
  ws.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `${H}:${H}`, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  return ws;
}

function writeRow(ws: ExcelJS.Worksheet, r: number, columns: ColumnSpec[], values: (string | number | null)[], height?: number) {
  const row = ws.getRow(r);
  // Rows people type into keep the default height, so a long note still auto-fits.
  if (height) row.height = height;
  columns.forEach((c, i) => {
    const cell = row.getCell(i + 1);
    const v = values[i];
    // A blank stays a true blank, never "": COUNTA on the Summary and Review counts "" as filled.
    cell.value = v == null || v === "" ? null : typeof v === "number" ? v : text(v);
    cell.font = font(c.mute ? { color: { argb: MUTE } } : {});
    cell.border = hair;
    cell.alignment = { vertical: "middle", horizontal: c.align ?? "left", wrapText: c.wrap ?? false, indent: c.align ? 0 : 1 };
    if (c.numFmt) cell.numFmt = c.numFmt;
  });
  return row;
}

/** Equal-value chip: a word with a fill behind it, or drawn in mute. */
const chip = (ref: string, word: string, priority: number, style: Partial<ExcelJS.Style>): ExcelJS.ConditionalFormattingOptions => {
  // An expression rule, anchored on the first cell of the range: Google Sheets does not match text reliably on cellIs.
  const first = ref.split(":")[0];
  return { ref, rules: [{ type: "expression", formulae: [`${first.replace(/^([A-Z]+)(\d+)$/, "$$$1$2")}="${word.replace(/"/g, '""')}"`], priority, style }] };
};
// A conditional format's font names no family: Excel keeps the cell's, and in Sheets a named family here would override the one the Google layer sets.
const cfFont = (o: Partial<ExcelJS.Font> = {}): Partial<ExcelJS.Font> => ({ color: { argb: INK }, ...o });
const washChip = (wash: string): Partial<ExcelJS.Style> => ({ font: cfFont({ bold: true }), fill: cfFill(wash) });
const strongChip = (): Partial<ExcelJS.Style> => ({ font: cfFont({ bold: true, color: { argb: WHITE } }), fill: cfFill(GREEN) });
const boldChip = (): Partial<ExcelJS.Style> => ({ font: cfFont({ bold: true }) });
const muteChip = (): Partial<ExcelJS.Style> => ({ font: cfFont({ color: { argb: MUTE } }) });
/** A row that no longer needs the eye: mute text on a faint ground. */
const recede = (ref: string, formula: string, priority: number): ExcelJS.ConditionalFormattingOptions =>
  ({ ref, rules: [{ type: "expression", formulae: [formula], priority, style: { font: cfFont({ color: { argb: MUTE } }), fill: cfFill(GROUND) } }] });

const HEAT_WORD: Record<string, string> = { hot: "Hot", warm: "Warm", cold: "Cold" };
const heatWord = (h: string | null) => HEAT_WORD[h ?? ""] ?? "Unknown";
const heatRank = (h: string | null) => ({ hot: 0, warm: 1, cold: 2 } as Record<string, number>)[h ?? ""] ?? 3;
const heatChips = (ref: string, from: number) => [
  chip(ref, "Hot", from, strongChip()),
  chip(ref, "Warm", from + 1, washChip(SAND)),
  chip(ref, "Cold", from + 2, muteChip()),
  chip(ref, "Unknown", from + 3, muteChip()),
];
const FIT_WORDS: Record<number, string> = { 1: "Strong fit", 2: "Partial fit", 3: "Outside the ICP" };
const BM_WORDS: Record<string, string> = { B2B: "Businesses (B2B)", B2C: "Consumers only (B2C)", B2B2C: "Businesses and consumers" };
const ACCOUNT_TYPE: Record<string, string> = { customer: "Customer", prospect: "Prospect", partner: "Partner", competitor: "Competitor", none: "None" };
const accountTypeWord = (t: string | null) => (t ? ACCOUNT_TYPE[t] ?? words(t) : "");
/** Revenue reads as $758M, $63.3M or $840K; Excel and Sheets both take a three-part conditional format. */
const MONEY_SHORT = '[>=10000000]"$"#,##0,,"M";[>=1000000]"$"#,##0.0,,"M";"$"#,##0,"K"';

/* ------------------------------------------------------------------- data */

interface Person {
  id: string; source: "attendee" | "prospect"; priority: "A" | "B"; company_tier: number | null; title_tier: number | null;
  full_name: string | null; title: string | null; title_function: string | null; title_seniority: string | null;
  company_id: string; company: string; email: string | null; email_source: string | null; verify_1: string | null; verify_2: string | null; linkedin: string | null; no_calls: boolean;
  employer: string | null; found_at: string | null; person_location: string | null; vendor_seniority: string | null; departments: string | null; role_since: string | null;
  tier: number | null; segment: string | null; firmo: FirmoRecord | null; primary_domain: string | null; parent_name: string | null;
  account_owner: string | null; account_type: string | null; deal_name: string | null; deal_stage: string | null; last_activity: string | null; heat: Heat | null; flags: string[];
  tab?: string; row?: number;
}
interface Company {
  id: string; name: string; tier: number | null; list_status: string | null; heat: Heat | null; account_owner: string | null;
  deal_name: string | null; deal_stage: string | null; last_activity: string | null; n: number; n_a: number; listed: number; row?: number;
  primary_domain: string | null; parent_name: string | null; segment: string | null; company_type: string | null; tier_fact: string | null; tier_via: string | null;
  firmo: FirmoRecord | null; firmo_source: string | null; account_type: string | null; website_note: string | null;
}
interface Other { id: string; full_name: string | null; title: string | null; email: string | null; company: string; company_tier: number | null; title_tier: number | null; drop_reason: string | null; tier_fact: string | null; func: string | null; seniority: string | null }
/** One row of the Review tab: an open case, or a flagged person no case covers yet. */
interface ReviewRow { case_id: string | null; contact_id: string | null; kind: string; name: string | null; title: string | null; company: string; priority: string | null; email: string | null; linkedin: string | null; found: string; suggested: string; options: string[] }
interface Seat { requester: string; team: string; role: string; goal: string; why_event: string; known_accounts: string | null; expected_meetings: number; status: string }
interface ProgramEvent { id: string; name: string; tier1: number; tiered: number }

const ENRICH_DROPS = ["no_people_found", "no_contacts_found", "no_email_found", "not_deliverable", "vendor_error", "budget_cap"];
const DROP_WORDS: Record<string, string> = {
  duplicate: "listed twice", no_company: "no company on the row", excluded_company: "on your exclusion list", existing_customer: "already a customer",
  low_tier: "priority C, outside the target", tiering_failed: "could not be tiered", no_people_found: "nobody found at the company", no_contacts_found: "nobody found at the company",
  no_email_found: "no email found", not_deliverable: "email bounced in verification", vendor_error: "a data source failed",
  budget_cap: "stopped by the cost card cap", rejected_in_review: "dropped by a reviewer", opted_out: "opted out", crm_unsubscribed: "unsubscribed in Salesforce", crm_do_not_contact: "do not contact in Salesforce",
  junk_row: "nothing usable in the row", not_a_company: "not a company", company_not_found: "company not found", email_unconfirmed: "email could not be confirmed",
  catch_all_unconfirmed: "company accepts every address, so nobody could be confirmed", employment_unconfirmed: "employer could not be confirmed",
};
const dropWords = (reasons: { reason: string; n: number }[], pick: string[]) => {
  const parts = reasons.filter((d) => pick.includes(d.reason) && d.n > 0).sort((a, b) => b.n - a.n).map((d) => `${d.n} ${DROP_WORDS[d.reason] ?? d.reason}`);
  return parts.length ? parts.join(", ") : "nothing dropped";
};

const assertDelivered = async (db: Db, id: string) => {
  const [e] = await db.query<{ name: string; venue: string; starts_on: string; stage: string; delivered_on: string; seat_count: number; seat_price_cents: number; perspective: unknown }>(
    "SELECT name, venue, starts_on::text AS starts_on, stage, stage_changed_at::date::text AS delivered_on, seat_count, seat_price_cents, perspective FROM events WHERE id = $1", [id]);
  if (!e) throw new RuleError("That event does not exist.");
  if (e.stage !== "delivered") throw new RuleError("The outreach list is not delivered yet.");
  return e;
};

export async function load(db: Db, id: string) {
  const e = await assertDelivered(db, id);
  const [list, used, cards, settings, use] = await Promise.all([
    listSummary(db, id), spend(db, id),
    db.query<{ credits_cap: number; llm_cap: number }>("SELECT credits_cap, llm_cap FROM cost_cards WHERE event_id = $1 AND status = 'approved' ORDER BY created_at DESC LIMIT 1", [id]),
    getSettingsNow(db, id), eventUse(db, id),
  ]);
  const people = await db.query<Person>(
    `SELECT c.id, c.source, c.priority, co.tier AS company_tier, c.title_tier, c.full_name, c.title,
            coalesce(c.title_function, t.func) AS title_function, coalesce(c.title_seniority, t.seniority) AS title_seniority, co.id AS company_id, co.name AS company,
            c.email, c.email_source, c.verify_1, c.verify_2, c.linkedin, c.no_calls, c.employer, c.found_at::text AS found_at, c.person_location, c.vendor_seniority, c.departments, c.role_since,
            co.tier, co.segment, co.firmo, co.primary_domain, co.parent_name,
            co.account_owner, co.account_type, co.deal_name, co.deal_stage, co.last_activity::text AS last_activity, co.heat,
            coalesce((SELECT array_agg(f.flag ORDER BY f.flag) FROM review_flags f WHERE f.contact_id = c.id), '{}') AS flags
     FROM contacts c JOIN companies co ON co.id = c.company_id LEFT JOIN title_tiers t ON t.event_id = c.event_id AND t.title_key = lower(c.title)
     WHERE c.event_id = $1 AND c.dropped_at IS NULL
     ORDER BY c.priority, CASE co.heat WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 ELSE 2 END, co.tier NULLS LAST, co.name, c.full_name`, [id]);
  const companies = await db.query<Company>(
    `SELECT co.id, co.name, co.tier, co.list_status, co.heat, co.account_owner, co.deal_name, co.deal_stage, co.last_activity::text AS last_activity,
            count(c.id) FILTER (WHERE c.dropped_at IS NULL AND c.priority IS NOT NULL)::int AS n,
            count(c.id) FILTER (WHERE c.dropped_at IS NULL AND c.priority = 'A')::int AS n_a,
            count(c.id) FILTER (WHERE c.source = 'attendee')::int AS listed,
            co.primary_domain, co.parent_name, co.segment, co.company_type, co.tier_fact, co.tier_via, co.firmo, co.firmo_source, co.account_type, co.website_note
     FROM companies co LEFT JOIN contacts c ON c.company_id = co.id WHERE co.event_id = $1 GROUP BY co.id`, [id]);
  // Attendees from the attendee list at a tier 3 company or with a tier 3 title. Tier 3, not priority C: a priority C person can be tier 2 and tier 2.
  const [{ attendee_people }] = await db.query<{ attendee_people: number }>("SELECT count(*)::int AS attendee_people FROM contacts WHERE event_id = $1 AND source = 'attendee'", [id]);
  const others = await db.query<Other>(
    `SELECT k.id, k.full_name, k.title, k.email, co.name AS company, co.tier AS company_tier, coalesce(k.title_tier, t.tier) AS title_tier, k.drop_reason, co.tier_fact, t.func, t.seniority
     FROM contacts k JOIN companies co ON co.id = k.company_id LEFT JOIN title_tiers t ON t.event_id = k.event_id AND t.title_key = lower(k.title)
     WHERE k.event_id = $1 AND k.source = 'attendee' AND (co.tier = 3 OR coalesce(k.title_tier, t.tier) = 3) AND coalesce(k.drop_reason, '') NOT IN ('duplicate', 'junk_row', 'not_a_company', 'no_company', 'opted_out')
     ORDER BY co.tier DESC NULLS LAST, co.name, k.full_name`, [id]);
  const review = await reviewRows(db, id);
  // The funnel, as direct counts. Before discovery one source row is one unit; after it, one contact is.
  const [funnel] = await db.query<{ uploaded: number; cleaned: number; listed: number; tiered: number; enriched: number; checked: number }>(
    `SELECT (SELECT coalesce(sum(row_count), 0)::int FROM uploads WHERE event_id = $1) AS uploaded,
            (SELECT count(*)::int FROM source_rows WHERE event_id = $1 AND (drop_reason IS NULL OR drop_reason NOT IN ('duplicate', 'no_company'))) AS cleaned,
            (SELECT count(*)::int FROM source_rows r WHERE r.event_id = $1 AND (r.drop_reason IS NULL OR r.drop_reason NOT IN ('duplicate', 'no_company'))
               AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.source_row_id = r.id AND c.source = 'attendee' AND c.drop_reason IN ('excluded_company', 'existing_customer'))
               AND coalesce(r.drop_reason, '') NOT IN ('excluded_company', 'existing_customer')) AS listed,
            (SELECT count(*)::int FROM source_rows r WHERE r.event_id = $1 AND (r.drop_reason IS NULL OR r.drop_reason NOT IN ('duplicate', 'no_company', 'excluded_company', 'existing_customer', 'low_tier', 'tiering_failed'))
               AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.source_row_id = r.id AND c.source = 'attendee' AND c.drop_reason IN ('excluded_company', 'existing_customer', 'low_tier', 'tiering_failed'))) AS tiered,
            (SELECT count(*)::int FROM contacts WHERE event_id = $1 AND (drop_reason IS NULL OR drop_reason = ANY($2::text[]) OR drop_reason = 'rejected_in_review')) AS enriched,
            (SELECT count(*)::int FROM contacts WHERE event_id = $1 AND (drop_reason IS NULL OR drop_reason = 'rejected_in_review')) AS checked`,
    [id, ENRICH_DROPS]);
  // What the Summary's perspective reads: who asked for seats and why, what the tickets cost, and the other delivered lists in the program.
  const seats = await db.query<Seat>("SELECT requester, team, role, goal, why_event, known_accounts, expected_meetings, status FROM seat_requests WHERE event_id = $1 AND status IN ('approved', 'pending') ORDER BY status, created_at", [id]);
  const [tickets] = await db.query<{ n: number; cents: number }>("SELECT count(*)::int AS n, coalesce(sum(amount_cents), 0)::int AS cents FROM ticket_purchases WHERE event_id = $1", [id]);
  const program = await db.query<ProgramEvent>(
    `SELECT e.id, e.name, count(co.id) FILTER (WHERE co.tier = 1)::int AS tier1, count(co.id) FILTER (WHERE co.tier IS NOT NULL)::int AS tiered
     FROM events e JOIN companies co ON co.event_id = e.id WHERE e.stage = 'delivered' AND e.id <> $1 AND e.parent_event_id IS NULL GROUP BY e.id, e.name HAVING count(co.id) FILTER (WHERE co.tier IS NOT NULL) > 0`, [id]);
  return { e, list, used, use, cap: cards[0] ?? { credits_cap: 0, llm_cap: 0 }, settings, people, companies, funnel, attendee_people, others, review, seats, tickets, program };
}
export type Data = Awaited<ReturnType<typeof load>>;

/* ------------------------------------------------------------- people tabs */

const PEOPLE_GROUPS: GroupSpec[] = [{ label: "Person", band: "green" }, { label: "Company", band: "sand" }, { label: "CRM", band: "line" }, { label: "Outreach", band: "orange" }, { label: "Detail", band: "line", fold: true }];
const PEOPLE_COLS: ColumnSpec[] = [
  { header: "Priority", width: 9, align: "center", group: "Person" }, { header: "Name", width: 24, group: "Person" }, { header: "Title", width: 30, group: "Person" },
  { header: "Seniority", width: 12, group: "Person", mute: true }, { header: "Function", width: 14, group: "Person", mute: true },
  { header: "Email", width: 32, group: "Person" }, { header: "Email status", width: 14, group: "Person", mute: true }, { header: "LinkedIn", width: 40, group: "Person" }, { header: "No calls", width: 9, align: "center", group: "Person" },
  { header: "Company", width: 26, group: "Company" }, { header: "Tier", width: 6, align: "center", group: "Company" }, { header: "Fit", width: 14, group: "Company" },
  { header: "Industry", width: 22, group: "Company" }, { header: "Employees", width: 11, align: "right", numFmt: "#,##0", group: "Company" }, { header: "Country", width: 14, group: "Company" },
  { header: "Revenue", width: 10, align: "right", numFmt: MONEY_SHORT, group: "Company" }, { header: "Website", width: 24, group: "Company" },
  { header: "Account type", width: 13, group: "CRM" }, { header: "Heat", width: 9, align: "center", group: "CRM" }, { header: "Account owner", width: 18, group: "CRM" },
  { header: "Open deal", width: 28, group: "CRM" }, { header: "Stage", width: 13, group: "CRM" }, { header: "Last activity", width: 13, align: "center", numFmt: "d mmm yyyy", group: "CRM" },
  // The folded detail sits before the columns a rep fills in, so its control is in the middle of the sheet, never off the right edge.
  { header: "Source", width: 20, group: "Detail", mute: true }, { header: "Email from", width: 14, group: "Detail", mute: true }, { header: "Record refreshed", width: 14, align: "center", numFmt: "d mmm yyyy", group: "Detail", mute: true },
  { header: "Location", width: 18, group: "Detail", mute: true }, { header: "Vendor seniority", width: 14, group: "Detail", mute: true }, { header: "Departments", width: 18, group: "Detail", mute: true },
  { header: "In role since", width: 12, align: "center", group: "Detail", mute: true }, { header: "Employer per vendor", width: 22, group: "Detail", mute: true },
  { header: "Company tier", width: 12, align: "center", group: "Detail", mute: true }, { header: "Title tier", width: 10, align: "center", group: "Detail", mute: true }, { header: "Flags", width: 40, group: "Detail", mute: true },
  { header: "Outreach status", width: 16, align: "center", group: "Outreach", edit: true }, { header: "Notes", width: 40, wrap: true, group: "Outreach", edit: true },
  // Hidden, last. A refresh reads what a rep typed against this id, so a sort or a filter on the Sheet cannot put it on the wrong person.
  { header: "contact_id", width: 2, hidden: true, group: "Outreach" },
];
const pIdx = (h: string) => PEOPLE_COLS.findIndex((c) => c.header === h) + 1;
const pCol = (h: string) => col(pIdx(h));
const STATUSES = ["Not started", "Contacted", "Replied", "Meeting set", "Not interested", "Bounced"];
const FIRST_ROW = 4;

export const emailStatus = (p: Pick<Person, "email" | "verify_1" | "verify_2">) =>
  !p.email ? "No email" : p.verify_1 === "deliverable" && p.verify_2 === "deliverable" ? "Verified twice" : p.verify_1 === "deliverable" || p.verify_2 === "deliverable" ? "Verified once" : "Not verified";
const emailFrom = (src: string | null) => (!src ? "" : src === "uploaded" || src === "attendee_list" ? "Attendee list" : src === "pattern" ? "Address pattern" : vendorWords(src));
const dealWords = (name: string | null) => name ?? "";
const dateCell = (ymd: string | null) => (ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? new Date(`${ymd}T00:00:00Z`) : null);

/** Filter views for a people tab: the cuts a rep makes. Owners come from the data, most accounts first, at most eight. */
function peopleViews(people: Person[]): PlanFilterView[] {
  const views: PlanFilterView[] = [{ title: "Priority A", column: pIdx("Priority"), equals: "A" }, { title: "Not started", column: pIdx("Outreach status"), blank: true }];
  if (people.some((p) => p.heat === "hot")) views.push({ title: "Hot accounts", column: pIdx("Heat"), equals: "Hot" });
  if (people.some((p) => p.account_type === "customer")) views.push({ title: "Customers", column: pIdx("Account type"), equals: "Customer" });
  const owners = [...people.reduce((m, p) => (p.account_owner ? m.set(p.account_owner, (m.get(p.account_owner) ?? 0) + 1) : m), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [o] of owners.slice(0, 8)) views.push({ title: `Owner: ${o}`, column: pIdx("Account owner"), equals: o });
  return views;
}

function peopleTab(wb: ExcelJS.Workbook, name: string, people: Person[], title: string, carried?: Carried): TabPlan {
  const ws = table(wb, name, title, PEOPLE_COLS, PEOPLE_GROUPS, { freezeCols: 2, tab: GREEN });
  people.forEach((p, i) => {
    const r = FIRST_ROW + i;
    p.tab = name; p.row = r;
    const f = p.firmo ?? {};
    const values: (string | number | null)[] = [
      p.priority, p.full_name ?? "Name unknown", p.title, words(p.title_seniority), words(p.title_function), p.email, emailStatus(p), "", p.no_calls ? "No calls" : "",
      p.company, p.tier, p.tier ? FIT_WORDS[p.tier] : "", f.industry ?? "", f.employees ?? null, f.country ?? "", f.revenue ?? null, "",
      accountTypeWord(p.account_type), heatWord(p.heat), p.account_owner ?? "", dealWords(p.deal_name), p.deal_stage ?? "", null,
      p.source === "attendee" ? "Attendee list" : "Found at the company", emailFrom(p.email_source), null, p.person_location ?? "", words(p.vendor_seniority), p.departments ?? "", p.role_since ?? "", p.employer ?? "",
      p.company_tier, p.title_tier, p.flags.map((x) => FLAG_WORDS[x] ?? x).join(". "),
      carried?.people.get(p.id)?.status ?? "", carried?.people.get(p.id)?.notes ?? "", p.id,
    ];
    const row = writeRow(ws, r, PEOPLE_COLS, values);
    row.getCell(2).font = font({ bold: true });
    const url = cleanLinkedin(p.linkedin);
    const li = row.getCell(pIdx("LinkedIn"));
    if (url) setLink(li, url.replace(/^https?:\/\/(www\.)?/, ""), url);
    else { li.value = "Not found"; li.font = font({ color: { argb: MUTE } }); }
    const site = safeUrl(p.primary_domain);
    if (site && p.primary_domain) setLink(row.getCell(pIdx("Website")), p.primary_domain, site);
    const la = dateCell(p.last_activity); if (la) row.getCell(pIdx("Last activity")).value = la;
    const fa = dateCell(p.found_at); if (fa) row.getCell(pIdx("Record refreshed")).value = fa;
  });
  const last = FIRST_ROW + Math.max(people.length, 1) - 1;
  fitColumnsToData(ws, PEOPLE_COLS, FIRST_ROW, last);
  ws.autoFilter = { from: "A3", to: `${col(PEOPLE_COLS.length)}${last}` };
  const span = (h: string) => `${pCol(h)}${FIRST_ROW}:${pCol(h)}${last}`;
  const status = pCol("Outreach status");
  // One validation per range, not per cell: ExcelJS merges per-cell ones into overlapping ranges.
  addValidation(ws, span("Outreach status"), { type: "list", allowBlank: true, formulae: [`"${STATUSES.join(",")}"`], showErrorMessage: true, errorTitle: "Outreach status", error: `Choose one: ${STATUSES.join(", ")}.` });
  ws.addConditionalFormatting(chip(span("Priority"), "A", 1, washChip(GREEN_WASH)));
  for (const cf of heatChips(span("Heat"), 2)) ws.addConditionalFormatting(cf);
  ws.addConditionalFormatting(chip(span("Fit"), "Strong fit", 6, washChip(GREEN_WASH)));
  ws.addConditionalFormatting(chip(span("Fit"), "Outside the ICP", 7, muteChip()));
  ws.addConditionalFormatting(chip(span("Account type"), "Customer", 8, washChip(SAND)));
  ws.addConditionalFormatting(chip(span("Email status"), "Verified twice", 9, { font: cfFont() }));
  ws.addConditionalFormatting(chip(span("Outreach status"), "Meeting set", 10, washChip(GREEN_WASH)));
  ws.addConditionalFormatting(chip(span("Outreach status"), "Replied", 11, boldChip()));
  // A person who said no, or whose email bounced, recedes so the eye skips them.
  ws.addConditionalFormatting(recede(`A${FIRST_ROW}:${col(PEOPLE_COLS.length)}${last}`, `OR($${status}${FIRST_ROW}="Not interested",$${status}${FIRST_ROW}="Bounced")`, 12));
  return {
    title: name, kind: "table", tabColor: hexOf(GREEN), headerRow: 3, firstRow: FIRST_ROW, lastRow: last,
    columns: PEOPLE_COLS.map((c) => ({ header: c.header, hidden: c.hidden, edit: c.edit })), groups: groupSpans(PEOPLE_COLS, PEOPLE_GROUPS),
    dropdowns: [{ column: pIdx("Outreach status"), from: FIRST_ROW, to: last, values: STATUSES, strict: true }],
    filterViews: peopleViews(people), headingCells: ["A1"], sparklines: [],
  };
}

/* --------------------------------------------------------------- companies */

const COMPANY_GROUPS: GroupSpec[] = [
  { label: "Account", band: "green" }, { label: "Fit", band: "sand" }, { label: "Firmographics", band: "line" }, { label: "CRM", band: "sand" }, { label: "Outreach list", band: "green" }, { label: "Detail", band: "line", fold: true },
];
const COMPANY_COLS: ColumnSpec[] = [
  { header: "Company", width: 28, group: "Account" }, { header: "Website", width: 26, group: "Account" }, { header: "Parent", width: 22, group: "Account" }, { header: "Status", width: 18, group: "Account" },
  { header: "Tier", width: 6, align: "center", group: "Fit" }, { header: "Fit", width: 14, group: "Fit" }, { header: "Segment", width: 18, group: "Fit" }, { header: "Company type", width: 22, group: "Fit" },
  { header: "Employees", width: 11, align: "right", numFmt: "#,##0", group: "Firmographics" }, { header: "Size band", width: 13, group: "Firmographics" }, { header: "Industry", width: 24, group: "Firmographics" },
  { header: "Sells to", width: 20, group: "Firmographics" }, { header: "Country", width: 14, group: "Firmographics" }, { header: "City", width: 14, group: "Firmographics" },
  { header: "Revenue", width: 10, align: "right", numFmt: MONEY_SHORT, group: "Firmographics" }, { header: "Founded", width: 9, align: "center", group: "Firmographics" },
  { header: "Funding stage", width: 14, group: "Firmographics" }, { header: "LinkedIn", width: 30, group: "Firmographics" },
  { header: "Account type", width: 13, group: "CRM" }, { header: "Heat", width: 9, align: "center", group: "CRM" }, { header: "Account owner", width: 18, group: "CRM" },
  { header: "Open deal", width: 28, group: "CRM" }, { header: "Stage", width: 13, group: "CRM" }, { header: "Last activity", width: 13, align: "center", numFmt: "d mmm yyyy", group: "CRM" },
  // Folded columns do not wrap: a hidden cell cannot size its row, and the full text is a click away once the group is open. The group sits before the last band so its control stays on screen.
  { header: "Why this tier", width: 60, group: "Detail", mute: true }, { header: "Tiered by", width: 16, group: "Detail", mute: true },
  { header: "About it", width: 60, group: "Detail", mute: true }, { header: "Facts from", width: 16, group: "Detail", mute: true },
  { header: "Listed", width: 8, align: "center", group: "Outreach list" }, { header: "On the list", width: 11, align: "center", group: "Outreach list" }, { header: "Priority A", width: 10, align: "center", group: "Outreach list" }, { header: "Account band", width: 13, align: "center", group: "Outreach list" },
];
const cIdx = (h: string) => COMPANY_COLS.findIndex((c) => c.header === h) + 1;
const cCol = (h: string) => col(cIdx(h));
const companyStatus = (c: Company) =>
  c.list_status === "existing_customer" ? "Existing customer" : c.list_status === "excluded" ? "Excluded" : c.n > 0 ? "On the outreach list" : c.tier === 3 ? "Low tier" : "Nobody kept";
const STATUS_ORDER: Record<string, number> = { "On the outreach list": 0, "Nobody kept": 1, "Existing customer": 2, "Low tier": 3, Excluded: 4 };
const TIERED_BY: Record<string, string> = { hard_rule: "Rule in code", model: "AI", human: "A person", cache: "An earlier event" };
const FACTS_FROM: Record<string, string> = { search: "Free search", "search+enrich": "Search and enrich", cache: "Cache", human: "A person", none: "None" };

/** Where a company sits for outreach, by a written rule: Focus is a tier 1 company that is hot or warm in the CRM; Grow is any other tier 1, or a tier 2 that is hot or warm;
    Watch is the rest. Only a company with people on the outreach list gets a band. */
export function accountBand(c: Pick<Company, "tier" | "heat" | "n">): string {
  if (c.n <= 0 || c.tier === null) return "";
  const warm = c.heat === "hot" || c.heat === "warm";
  if (c.tier === 1 && warm) return "Focus";
  if (c.tier === 1 || (c.tier === 2 && warm)) return "Grow";
  return "Watch";
}

/** Row height for a row whose wrapped cells hold long text, sized with the same rule `wrapShortfalls` checks, plus a margin. */
function wrapRowHeight(columns: ColumnSpec[], values: (string | number | null)[]) {
  let h = 20;
  columns.forEach((c, i) => { if (c.wrap && values[i]) h = Math.max(h, wrapHeight(String(values[i]), Math.max(1, Math.floor(c.width * CHARS_PER_UNIT)), 15, 8) + 2); });
  return h;
}

function companiesTab(wb: ExcelJS.Workbook, companies: Company[]): TabPlan {
  // Tier, then heat, then people kept. Excluded and untiered companies have no tier and fall to the end.
  const sorted = [...companies].sort((a, b) =>
    (a.tier ?? 9) - (b.tier ?? 9) || heatRank(a.heat) - heatRank(b.heat) || STATUS_ORDER[companyStatus(a)] - STATUS_ORDER[companyStatus(b)] || b.n - a.n || a.name.localeCompare(b.name));
  const ws = table(wb, "Companies", `Companies (${num(companies.length)})`, COMPANY_COLS, COMPANY_GROUPS, { freezeCols: 1, tab: GREEN });
  sorted.forEach((c, i) => {
    const r = FIRST_ROW + i;
    c.row = r;
    const f = c.firmo ?? {};
    const values: (string | number | null)[] = [
      c.name, c.primary_domain, c.parent_name, companyStatus(c),
      c.tier, c.tier ? FIT_WORDS[c.tier] : "", words(c.segment), words(c.company_type),
      f.employees ?? null, f.employees != null ? sizeBand(f.employees) : "", f.industry ?? "", f.business_model ? BM_WORDS[f.business_model] ?? f.business_model : "", f.country ?? "", f.city ?? "",
      f.revenue ?? null, f.founded ?? null, f.funding_stage ?? "", "",
      accountTypeWord(c.account_type), heatWord(c.heat), c.account_owner ?? "", dealWords(c.deal_name), c.deal_stage ?? "", null,
      c.tier_fact, c.tier_via ? TIERED_BY[c.tier_via] ?? c.tier_via : "",
      f.description ?? c.website_note ?? "", c.firmo_source ? FACTS_FROM[c.firmo_source] ?? c.firmo_source : "",
      c.listed, c.n, c.n_a, accountBand(c),
    ];
    const row = writeRow(ws, r, COMPANY_COLS, values, wrapRowHeight(COMPANY_COLS, values));
    row.getCell(1).font = font({ bold: true });
    const url = safeUrl(c.primary_domain);
    if (url && c.primary_domain) setLink(row.getCell(2), c.primary_domain, url);
    if (f.linkedin) setLink(row.getCell(cIdx("LinkedIn")), f.linkedin.replace(/^https:\/\/(www\.)?/, ""), f.linkedin);
    const la = dateCell(c.last_activity); if (la) row.getCell(cIdx("Last activity")).value = la;
  });
  const last = FIRST_ROW + Math.max(sorted.length, 1) - 1;
  fitColumnsToData(ws, COMPANY_COLS, FIRST_ROW, last);
  ws.autoFilter = { from: "A3", to: `${col(COMPANY_COLS.length)}${last}` };
  const span = (h: string) => `${cCol(h)}${FIRST_ROW}:${cCol(h)}${last}`;
  for (const cf of heatChips(span("Heat"), 1)) ws.addConditionalFormatting(cf);
  ws.addConditionalFormatting({ ref: span("On the list"), rules: [{ type: "dataBar", priority: 5, cfvo: [{ type: "num", value: 0 }, { type: "max" }], color: { argb: SAND }, gradient: false, showValue: true } as ExcelJS.ConditionalFormattingRule] });
  ws.addConditionalFormatting(chip(span("Account type"), "Customer", 6, washChip(SAND)));
  ws.addConditionalFormatting(chip(span("Fit"), "Strong fit", 7, washChip(GREEN_WASH)));
  ws.addConditionalFormatting(chip(span("Fit"), "Outside the ICP", 8, muteChip()));
  ws.addConditionalFormatting(chip(span("Account band"), "Focus", 10, washChip(GREEN_WASH)));
  ws.addConditionalFormatting(chip(span("Account band"), "Grow", 11, boldChip()));
  ws.addConditionalFormatting(chip(span("Account band"), "Watch", 12, muteChip()));
  const status = cCol("Status");
  ws.addConditionalFormatting(recede(`A${FIRST_ROW}:${col(COMPANY_COLS.length)}${last}`, `OR($${status}${FIRST_ROW}="Excluded",$${status}${FIRST_ROW}="Low tier",$${status}${FIRST_ROW}="Nobody kept")`, 13));
  const views: PlanFilterView[] = [{ title: "On the outreach list", column: cIdx("Status"), equals: "On the outreach list" }, { title: "Tier 1", column: cIdx("Tier"), equals: "1" }];
  if (sorted.some((c) => accountBand(c) === "Focus")) views.push({ title: "Focus accounts", column: cIdx("Account band"), equals: "Focus" });
  if (sorted.some((c) => c.list_status === "existing_customer")) views.push({ title: "Existing customers", column: cIdx("Status"), equals: "Existing customer" });
  return {
    title: "Companies", kind: "table", tabColor: hexOf(GREEN), headerRow: 3, firstRow: FIRST_ROW, lastRow: last,
    columns: COMPANY_COLS.map((c) => ({ header: c.header, hidden: c.hidden })), groups: groupSpans(COMPANY_COLS, COMPANY_GROUPS), dropdowns: [], filterViews: views, headingCells: ["A1"], sparklines: [],
  };
}

/* ---------------------------------------------------------- other attendees */

const OTHER_GROUPS: GroupSpec[] = [{ label: "Person", band: "green" }, { label: "Why", band: "sand" }, { label: "Outcome", band: "line" }];
const OTHER_COLS: ColumnSpec[] = [
  { header: "Name", width: 24, group: "Person" }, { header: "Title", width: 30, group: "Person" }, { header: "Company", width: 28, group: "Person" },
  { header: "Company tier", width: 12, align: "center", group: "Why", mute: true }, { header: "Title tier", width: 10, align: "center", group: "Why", mute: true }, { header: "Why they are here", width: 72, wrap: true, group: "Why" },
  { header: "Email on the attendee list", width: 34, group: "Outcome" }, { header: "What happened", width: 30, group: "Outcome" },
];

/** Everyone from the attendee list at a tier 3 company or with a tier 3 title, one row each. People only: tier 3 companies are on the Companies tab. No paid enrichment ran for them. */
function othersTab(wb: ExcelJS.Workbook, others: Other[]): TabPlan {
  const ws = table(wb, "Other attendees", `Other attendees (${num(others.length)})`, OTHER_COLS, OTHER_GROUPS, { freezeCols: 1 });
  others.forEach((o, i) => {
    const why = [
      o.title_tier === 3 ? `Title tier 3${o.title ? `: ${o.title}` : ""}${o.func ? ` (${o.func.replace(/_/g, " ")}${o.seniority ? `, ${o.seniority.replace(/_/g, " ")}` : ""})` : ""}.` : "",
      o.company_tier === 3 ? `Company tier 3${o.tier_fact ? `: ${o.tier_fact}` : ""}.` : "",
    ].filter(Boolean).join(" ");
    const values: (string | number | null)[] = [o.full_name, o.title, o.company, o.company_tier, o.title_tier, why, o.email, o.drop_reason ? DROP_WORDS[o.drop_reason] ?? o.drop_reason : "On the outreach list"];
    const row = writeRow(ws, FIRST_ROW + i, OTHER_COLS, values, wrapRowHeight(OTHER_COLS, values));
    row.getCell(1).font = font({ bold: true });
  });
  const last = FIRST_ROW + Math.max(others.length, 1) - 1;
  fitColumnsToData(ws, OTHER_COLS, FIRST_ROW, last);
  ws.autoFilter = { from: "A3", to: `${col(OTHER_COLS.length)}${last}` };
  return { title: "Other attendees", kind: "table", tabColor: null, headerRow: 3, firstRow: FIRST_ROW, lastRow: last, columns: OTHER_COLS.map((c) => ({ header: c.header })), groups: groupSpans(OTHER_COLS, OTHER_GROUPS), dropdowns: [], filterViews: [], headingCells: ["A1"], sparklines: [] };
}

/* ------------------------------------------------------------------ review */

const CASE_WORDS: Record<string, string> = {
  attendee_vendor_mismatch: "Registered elsewhere", name_email_mismatch: "Name and address differ", free_webmail: "Personal address",
  same_person_two_companies: "Two companies", late_stage_deal: "Late-stage deal", model_flag: "Doubt about the person",
};
const CASE_ORDER = ["name_email_mismatch", "attendee_vendor_mismatch", "model_flag", "same_person_two_companies", "free_webmail", "late_stage_deal"];
const wordOf = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Open cases that need a person, plus any flagged person no case covers yet (a flag added after delivery). Each row carries the options its case allows. */
async function reviewRows(db: Db, id: string): Promise<ReviewRow[]> {
  const cases = await db.query<{ id: string; kind: string; summary: string; suggested: string | null; options: CaseOption[]; contact_id: string | null; company: string | null;
    full_name: string | null; title: string | null; email: string | null; priority: string | null; linkedin: string | null; dropped: boolean | null }>(
    `SELECT r.id, r.kind, r.summary, r.suggested, r.options, r.contact_id, co.name AS company, k.full_name, k.title, k.email, k.priority, k.linkedin, (k.dropped_at IS NOT NULL) AS dropped
     FROM review_cases r LEFT JOIN companies co ON co.id = r.company_id LEFT JOIN contacts k ON k.id = r.contact_id
     WHERE r.event_id = $1 AND r.status = 'open' AND NOT r.blocking`, [id]);
  const rows: ReviewRow[] = cases.filter((c) => !c.dropped).map((c) => ({
    case_id: c.id, contact_id: c.contact_id, kind: c.kind, name: c.full_name, title: c.title, company: c.company ?? "", priority: c.priority, email: c.email, linkedin: c.linkedin,
    found: c.summary, suggested: wordOf(c.suggested ?? c.options[0]?.value ?? "keep"), options: c.options.map((o) => wordOf(o.value)),
  }));
  const covered = new Set(cases.filter((c) => c.kind === "model_flag").map((c) => c.contact_id));
  const flagged = await db.query<{ id: string; full_name: string | null; title: string | null; email: string; priority: string; linkedin: string | null; company: string; flags: string[] }>(
    `SELECT k.id, k.full_name, k.title, k.email, k.priority, k.linkedin, co.name AS company, array_agg(f.flag ORDER BY f.flag) AS flags
     FROM review_flags f JOIN contacts k ON k.id = f.contact_id JOIN companies co ON co.id = k.company_id WHERE k.event_id = $1 AND k.dropped_at IS NULL GROUP BY k.id, co.name`, [id]);
  for (const p of flagged) {
    if (covered.has(p.id)) continue;
    const word = suggest(p.flags);
    rows.push({ case_id: null, contact_id: p.id, kind: "model_flag", name: p.full_name, title: p.title, company: p.company, priority: p.priority, email: p.email, linkedin: p.linkedin,
      found: p.flags.map((f) => FLAG_WORDS[f] ?? f).join(". ") + ".", suggested: word, options: ["Keep", "Drop"] });
  }
  return rows.sort((a, b) => CASE_ORDER.indexOf(a.kind) - CASE_ORDER.indexOf(b.kind) || text(a.priority).localeCompare(text(b.priority)) || a.company.localeCompare(b.company) || text(a.name).localeCompare(text(b.name)));
}

// Column positions are read back by `decisionsFromGrid` through the header words contact_id and Decision, so adding a column never breaks the import. The ids stay hidden.
const REVIEW_GROUPS: GroupSpec[] = [{ label: "Case", band: "green" }, { label: "Person", band: "sand" }, { label: "What we found", band: "line" }, { label: "Decision", band: "orange" }];
const REVIEW_COLS: ColumnSpec[] = [
  { header: "case_id", width: 2, hidden: true, group: "Case" }, { header: "contact_id", width: 2, hidden: true, group: "Case" }, { header: "Case", width: 24, group: "Case" },
  { header: "Name", width: 24, group: "Person" }, { header: "Title", width: 28, group: "Person" }, { header: "Company", width: 24, group: "Person" },
  { header: "Priority", width: 9, align: "center", group: "Person" }, { header: "Email", width: 30, group: "Person" },
  { header: "What we found", width: 46, wrap: true, group: "What we found" }, { header: "LinkedIn", width: 36, group: "What we found" }, { header: "Web search", width: 11, group: "What we found" }, { header: "Suggested", width: 11, align: "center", group: "What we found", mute: true },
  { header: "Decision", width: 11, align: "center", group: "Decision", edit: true }, { header: "What happens", width: 36, group: "Decision", mute: true },
];
const REVIEW_FIRST = 5;
/** Suggested by rule, never by a model: a flag about the person says Drop; a flag about the email says Keep and try another channel. */
const suggest = (flags: string[]) => flags.some((f) => ["title_company_mismatch", "likely_left_company", "name_looks_wrong"].includes(f)) ? "Drop" : "Keep";

function reviewTab(wb: ExcelJS.Workbook, rows: ReviewRow[]): { ws: ExcelJS.Worksheet; plan: TabPlan } {
  const n = rows.length, lastRow = REVIEW_FIRST + Math.max(n, 1) - 1;
  const ws = table(wb, "Review", n ? `Review (${plural(n, "case")})` : "Review", REVIEW_COLS, REVIEW_GROUPS, { freezeCols: 4, tab: ORANGE, headerRow: 4 });
  const last = col(REVIEW_COLS.length);
  const caseCol = "C", decCol = col(REVIEW_COLS.findIndex((c) => c.header === "Decision") + 1);
  const decisions = `$${decCol}$${REVIEW_FIRST}:$${decCol}$${lastRow}`;
  // Row 2 stays live: decided out of cases, from the Decision column. A blank means Keep.
  ws.mergeCells(`C2:${last}2`);
  setFormula(ws.getCell("C2"), n ? `COUNTA(${decisions})&" of ${n} decided. "&IF(COUNTA(${decisions})=${n},"Done.",${n}-COUNTA(${decisions})&" open. A blank means Keep.")` : `"Nothing to decide."`, n ? `0 of ${n} decided. ${n} open. A blank means Keep.` : "Nothing to decide.");
  ws.getCell("C2").font = font({ size: 11, bold: true });
  ws.getCell("C2").alignment = { vertical: "middle" };
  ws.getRow(2).height = 22;
  rows.forEach((p, i) => {
    const r = REVIEW_FIRST + i;
    const values = [p.case_id, p.contact_id, CASE_WORDS[p.kind] ?? p.kind, p.name, p.title, p.company, p.priority, p.email, p.found, "", "", p.suggested, "", ""];
    const row = writeRow(ws, r, REVIEW_COLS, values, Math.max(30, wrapRowHeight(REVIEW_COLS, values)));
    row.getCell(4).font = font({ bold: true });
    // A new case starts with a heavier line, so the groups read as groups.
    if (i === 0 || rows[i - 1].kind !== p.kind) for (let c = 3; c <= REVIEW_COLS.length; c++) row.getCell(c).border = { top: { style: "thin", color: { argb: INK } }, bottom: { style: "thin", color: { argb: LINE } } };
    const q = `${p.name ?? ""} ${p.company}`.trim();
    const url = cleanLinkedin(p.linkedin);
    if (p.contact_id) {
      if (url) setLink(row.getCell(10), url.replace(/^https?:\/\/(www\.)?/, ""), url, "Their profile");
      else { row.getCell(10).value = "Not found"; row.getCell(10).font = font({ color: { argb: MUTE } }); }
      setLink(row.getCell(11), "Web", searchUrl(q), "Search the web for this name and company");
    }
    const keepWord = p.kind === "late_stage_deal" ? "Stays; the account owner hears first" : "Stays on the outreach list";
    // Blank until a decision is picked, so the column reads only where something changed.
    setFormula(row.getCell(14), `IF($${decCol}${r}="Drop","Leaves the outreach list, marked rejected in review",IF($${decCol}${r}="Dismiss","Stays; the case is closed",IF($${decCol}${r}="Keep","${keepWord}","")))`, "");
    row.getCell(14).font = font({ color: { argb: MUTE } });
  });
  fitColumnsToData(ws, REVIEW_COLS, REVIEW_FIRST, lastRow);
  ws.autoFilter = { from: "C4", to: `${last}${lastRow}` };
  const span = (c: string) => `${c}${REVIEW_FIRST}:${c}${lastRow}`;
  // One validation per contiguous run of rows that share the same options: ExcelJS merges per-cell ones into overlapping ranges, which Excel repairs away.
  const dropdowns: PlanDropdown[] = [];
  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i < rows.length && rows[i].options.join(",") === rows[start].options.join(",")) continue;
    const opts = rows[start].options;
    addValidation(ws, `${decCol}${REVIEW_FIRST + start}:${decCol}${REVIEW_FIRST + i - 1}`, { type: "list", allowBlank: true, formulae: [`"${opts.join(",")}"`], showErrorMessage: true, errorTitle: "Decision", error: `Choose ${opts.join(" or ")}, or leave it blank to keep.` });
    dropdowns.push({ column: REVIEW_COLS.length - 1, from: REVIEW_FIRST + start, to: REVIEW_FIRST + i - 1, values: opts, strict: true });
    start = i;
  }
  ws.addConditionalFormatting(chip(span(decCol), "Keep", 1, washChip(GREEN_WASH)));
  ws.addConditionalFormatting(chip(span(decCol), "Drop", 2, washChip(ORANGE_WASH)));
  ws.addConditionalFormatting(chip(span(decCol), "Dismiss", 3, washChip(LINE)));
  ws.addConditionalFormatting(chip(span("G"), "A", 4, washChip(GREEN_WASH)));
  // A decided row recedes, so what is left to do stands out. The Decision cell itself keeps its chip (higher priority).
  ws.addConditionalFormatting(recede(`${caseCol}${REVIEW_FIRST}:${last}${lastRow}`, `$${decCol}${REVIEW_FIRST}<>""`, 5));
  const kinds = [...new Set(rows.map((r) => CASE_WORDS[r.kind] ?? r.kind))];
  const views: PlanFilterView[] = n ? [{ title: "Still open", column: REVIEW_COLS.length - 1, blank: true }, ...kinds.map((k) => ({ title: k, column: 3, equals: k }))] : [];
  return { ws, plan: { title: "Review", kind: "review", tabColor: hexOf(ORANGE), headerRow: 4, firstRow: REVIEW_FIRST, lastRow, columns: REVIEW_COLS.map((c) => ({ header: c.header, hidden: c.hidden, edit: c.edit })), groups: groupSpans(REVIEW_COLS, REVIEW_GROUPS), dropdowns, filterViews: views, headingCells: ["A1", "C2"], sparklines: [] } };
}

/* --------------------------------------------------------------- meetings */

const MEETING_GROUPS: GroupSpec[] = [{ label: "Who", band: "green" }, { label: "When", band: "sand" }, { label: "Outcome", band: "orange" }];
const MEETING_COLS: ColumnSpec[] = [
  { header: "Contact", width: 34, group: "Who", edit: true }, { header: "Company", width: 24, group: "Who", mute: true }, { header: "Account owner", width: 18, group: "Who", mute: true },
  { header: "Date", width: 12, align: "center", numFmt: "yyyy-mm-dd", group: "When", edit: true }, { header: "Time", width: 8, align: "center", numFmt: "h:mm", group: "When", edit: true }, { header: "Location", width: 20, group: "When", edit: true },
  { header: "Status", width: 11, align: "center", group: "Outcome", edit: true }, { header: "Outcome", width: 16, group: "Outcome", edit: true }, { header: "Notes", width: 44, wrap: true, group: "Outcome", edit: true },
];
const MEETING_STATUSES = ["Proposed", "Booked", "Held", "No-show", "Cancelled"];
const MEETING_OUTCOMES = ["Next meeting", "Intro to owner", "Send material", "Not a fit", "Pending"];
const MEETING_BASE = 60;
const LISTS_MAX = 5000;

function listsTab(wb: ExcelJS.Workbook, people: Person[]) {
  // Hidden. Column A is the dropdown label, unique per person; C and D feed the Meetings lookups.
  const ws = wb.addWorksheet("Lists");
  ws.state = "hidden";
  ws.columns = [{ width: 50 }, { width: 24 }, { width: 26 }, { width: 18 }, { width: 20 }];
  ws.addRow(["Label", "Name", "Company", "Account owner", "contact_id"]);
  const seen = new Map<string, number>();
  const sorted = [...people].sort((a, b) => text(a.full_name).localeCompare(text(b.full_name)) || a.company.localeCompare(b.company));
  for (const p of sorted) {
    const base = `${p.full_name ?? "Unnamed"}, ${p.company}`;
    const k = (seen.get(base) ?? 0) + 1; seen.set(base, k);
    ws.addRow([k === 1 ? base : `${base} (${k})`, text(p.full_name), p.company, p.account_owner ?? "", p.id]);
  }
  return ws;
}

/** The cells of a kept Meetings row, by column. Company and Account owner are left to their lookups; a date and a time go back as a date and a time. */
function meetingValue(i: number, v: string): ExcelJS.CellValue {
  if (i === 3 && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`);
  const t = i === 4 ? /^(\d{1,2}):(\d{2})/.exec(v) : null;
  return t ? (Number(t[1]) * 60 + Number(t[2])) / 1440 : v;
}

function meetingsTab(wb: ExcelJS.Workbook, carried?: Carried): TabPlan {
  const kept = carried?.meetings ?? [];
  const MEETING_ROWS = Math.max(MEETING_BASE, kept.length + 10);
  const ws = table(wb, "Meetings", "Meetings", MEETING_COLS, MEETING_GROUPS, { freezeCols: 1, tab: SAND });
  const lookup = (c: "C" | "D", r: number) => `IF($A${r}="","",IFERROR(INDEX(Lists!$${c}$2:$${c}$${LISTS_MAX},MATCH($A${r},Lists!$A$2:$A$${LISTS_MAX},0)),""))`;
  for (let i = 0; i < MEETING_ROWS; i++) {
    const r = FIRST_ROW + i;
    const row = writeRow(ws, r, MEETING_COLS, ["", "", "", "", "", "", "", "", ""], 20);
    setFormula(row.getCell(2), lookup("C", r), "");
    setFormula(row.getCell(3), lookup("D", r), "");
    if (kept[i]) MEETING_COLS.forEach((c, k) => { if (c.edit && kept[i][k]) row.getCell(k + 1).value = meetingValue(k, kept[i][k]); });
  }
  const last = FIRST_ROW + MEETING_ROWS - 1;
  ws.autoFilter = { from: "A3", to: `${col(MEETING_COLS.length)}${last}` };
  addValidation(ws, `A${FIRST_ROW}:A${last}`, { type: "list", allowBlank: true, formulae: [`Lists!$A$2:$A$${LISTS_MAX}`], showErrorMessage: false, showInputMessage: true, promptTitle: "Who did you meet?", prompt: "Pick from the list. Company and owner fill in." });
  addValidation(ws, `G${FIRST_ROW}:G${last}`, { type: "list", allowBlank: true, formulae: [`"${MEETING_STATUSES.join(",")}"`], showErrorMessage: true, errorTitle: "Status", error: `Choose one: ${MEETING_STATUSES.join(", ")}.` });
  addValidation(ws, `H${FIRST_ROW}:H${last}`, { type: "list", allowBlank: true, formulae: [`"${MEETING_OUTCOMES.join(",")}"`], showErrorMessage: true, errorTitle: "Outcome", error: `Choose one: ${MEETING_OUTCOMES.join(", ")}.` });
  ws.addConditionalFormatting(chip(`G${FIRST_ROW}:G${last}`, "Held", 1, washChip(GREEN_WASH)));
  ws.addConditionalFormatting(chip(`G${FIRST_ROW}:G${last}`, "Booked", 2, boldChip()));
  ws.addConditionalFormatting(chip(`G${FIRST_ROW}:G${last}`, "No-show", 3, washChip(ORANGE_WASH)));
  ws.addConditionalFormatting(recede(`A${FIRST_ROW}:I${last}`, `$G${FIRST_ROW}="Cancelled"`, 4));
  return {
    title: "Meetings", kind: "meetings", tabColor: hexOf(SAND), headerRow: 3, firstRow: FIRST_ROW, lastRow: last,
    columns: MEETING_COLS.map((c) => ({ header: c.header, edit: c.edit })), groups: groupSpans(MEETING_COLS, MEETING_GROUPS),
    dropdowns: [
      { column: 1, from: FIRST_ROW, to: last, rangeRef: `Lists!$A$2:$A$${LISTS_MAX}`, strict: false },
      { column: 7, from: FIRST_ROW, to: last, values: MEETING_STATUSES, strict: true }, { column: 8, from: FIRST_ROW, to: last, values: MEETING_OUTCOMES, strict: true },
    ],
    filterViews: [], headingCells: ["A1"], sparklines: [],
  };
}

/* ------------------------------------------------------------- perspective */

/** One line of the Summary's perspective: a short label and the fact. */
export type Line = [label: string, text: string];
export interface Perspective {
  why: Line[]; list: Line[]; stand: Line[];
  /** Blocks whose single line is the model's checked prose, drawn across the full width with no label. */
  prose?: Part[];
  /** The model that wrote the prose blocks. */
  model?: string;
}

const share = (n: number, of: number) => `${num(n)} (${pct(n, of)})`;
const topShares = (xs: (string | null | undefined)[], max = 3) => {
  const m = new Map<string, number>();
  let known = 0;
  for (const x of xs) if (x) { m.set(x, (m.get(x) ?? 0) + 1); known++; }
  return { known, top: [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([k, n]) => `${k} ${pct(n, known)}`) };
};
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** The perspective block at the top of the Summary, composed from stored fields by rules. It states what is on file and never advises.
    It is the text used for any block the model did not write, or wrote and failed a check. */
export function perspective(d: Data): Perspective {
  const why: Line[] = [], list: Line[] = [], stand: Line[] = [];
  const approved = d.seats.filter((s) => s.status === "approved"), waiting = d.seats.filter((s) => s.status === "pending");

  // Why this event: what the people who asked for seats wrote, and what the seats cost.
  if (!d.seats.length) why.push(["Seat requests", "None on file for this event."]);
  else {
    const goals = new Map<string, number>();
    for (const s of d.seats) { const g = GOALS[s.goal as keyof typeof GOALS] ?? words(s.goal); goals.set(g, (goals.get(g) ?? 0) + 1); }
    why.push(["Goal", [...goals.entries()].sort((a, b) => b[1] - a[1]).map(([g, n]) => (d.seats.length > 1 ? `${g} (${n})` : g)).join(", ")]);
    why.push(["Going", `${approved.map((s) => `${s.requester} (${s.team})`).join("; ")}${waiting.length ? `; ${plural(waiting.length, "request")} waiting` : ""}` || `${plural(waiting.length, "request")} waiting`]);
    for (const [i, s] of [...approved, ...waiting].slice(0, 2).entries()) why.push([i === 0 ? "In their words" : "", `"${s.why_event.trim().replace(/"/g, "'")}" ${s.requester}, ${s.role}`]);
    const known = [...new Set(d.seats.flatMap((s) => (s.known_accounts ?? "").split(/[,;]/).map((x) => x.trim()).filter(Boolean)))];
    if (known.length) why.push(["Known accounts", listWords(known, 6)]);
    const meetings = d.seats.reduce((n, s) => n + (s.expected_meetings || 0), 0);
    if (meetings) why.push(["Meetings expected", `${num(meetings)} across ${plural(d.seats.length, "request")}`]);
    const seatLine = approved.length ? `${plural(approved.length, "seat")} approved at ${usd(d.e.seat_price_cents)}` : "No seat approved yet";
    why.push(["Tickets", d.tickets.n ? `${seatLine}; ${d.tickets.n} bought, ${usd(d.tickets.cents)} recorded` : seatLine]);
  }

  // The list: what the attendee list is against the ICP.
  const companies = d.companies, tiered = companies.filter((c) => c.tier !== null);
  const t = (n: number) => companies.filter((c) => c.tier === n).length;
  list.push(["Attendee list", `${plural(d.funnel.uploaded, "row")}: ${plural(companies.length, "company", "companies")}, ${plural(d.attendee_people, "person", "people")}`]);
  list.push(["Fit", tiered.length ? `Tier 1 ${share(t(1), tiered.length)}, tier 2 ${share(t(2), tiered.length)}, tier 3 ${share(t(3), tiered.length)} of ${num(tiered.length)} tiered${companies.length - tiered.length ? `; ${num(companies.length - tiered.length)} untiered` : ""}` : "Nothing tiered."]);
  const industry = topShares(companies.map((c) => c.firmo?.industry));
  if (industry.known) list.push(["Industry", `${industry.top.join(", ")} (of ${num(industry.known)} with a known industry)`]);
  const region = topShares(companies.map((c) => c.firmo?.country));
  if (region.known) list.push(["Region", `${region.top.join(", ")} (of ${num(region.known)} with a known country)`]);
  if (d.program.length && tiered.length) {
    const here = Math.round((t(1) / tiered.length) * 100), others = d.program.map((p) => Math.round((p.tier1 / p.tiered) * 100));
    const against = d.program.length === 1 ? `${d.program[0].name}, the one other delivered list, is at ${others[0]}%` : `the median across ${plural(d.program.length, "other delivered list")} is ${Math.round(median(others))}% (${Math.min(...others)}% to ${Math.max(...others)}%)`;
    list.push(["Across events", `Tier 1 is ${here}% of tiered companies here; ${against}.`]);
  }
  const a = d.people.filter((p) => p.priority === "A").length, att = d.people.filter((p) => p.source === "attendee").length, onList = companies.filter((c) => c.n > 0);
  list.push(["Outreach list", `${plural(d.people.length, "person", "people")} at ${plural(onList.length, "company", "companies")}: ${num(a)} priority A, ${num(d.people.length - a)} priority B; ${num(att)} from the attendee list, ${num(d.people.length - att)} found at attending companies.`]);

  // Where we stand: the CRM's view of these accounts. Nothing is said when no CRM answered.
  const crm = companies.some((c) => c.heat !== null || c.account_owner || c.account_type);
  if (!crm) stand.push(["CRM", "Not connected. Owner, deals, heat and account type are blank on every tab."]);
  else {
    const customers = companies.filter((c) => c.list_status === "existing_customer" || c.account_type === "customer"), still = customers.filter((c) => c.n > 0);
    stand.push(["Customers", customers.length ? `${plural(customers.length, "company", "companies")} on the attendee list ${customers.length === 1 ? "is" : "are"} a customer${still.length ? `; ${num(still.length)} still on the outreach list` : "; none on the outreach list"}.` : "None on the attendee list."]);
    const deals = onList.filter((c) => c.deal_name), stages = topShares(deals.map((c) => c.deal_stage), 4);
    stand.push(["Open deals", deals.length ? `${plural(deals.length, "account")} on the outreach list ${deals.length === 1 ? "has" : "have"} one${stages.known ? `: ${stages.top.join(", ")}` : ""}.` : "None among the accounts on the outreach list."]);
    const hot = onList.filter((c) => c.heat === "hot").length, warm = onList.filter((c) => c.heat === "warm").length;
    stand.push(["Heat", `${num(hot)} hot, ${num(warm)} warm, ${num(onList.length - hot - warm)} cold or unknown, of ${plural(onList.length, "account")} on the outreach list.`]);
    const owners = topShares(onList.map((c) => c.account_owner), 4);
    if (owners.known) stand.push(["Owners", `${plural(owners.known, "account")} ${owners.known === 1 ? "has" : "have"} an owner: ${owners.top.join(", ")}.`]);
    const fresh = onList.filter((c) => !c.account_owner && !c.deal_name && c.account_type !== "customer" && c.account_type !== "partner");
    stand.push(["Net new", `${share(fresh.length, onList.length)} of the accounts on the outreach list have no owner, deal or type in the CRM.`]);
  }
  return { why, list, stand };
}

/** `perspective(d)` with the model's blocks swapped in where the event holds text that passed every check AND was written from the facts that are still on file.
    A fact that changed since (a review drop, a ticket bought, another list delivered) means the figures in the text are no longer checked, so the rules write it. */
export function withStored(d: Data): Perspective {
  const base = perspective(d);
  const stored = storedOf(d.e.perspective);
  if (!stored || stored.packet_hash !== packetHash(buildPacket(d))) return base;
  const out: Perspective = { ...base, prose: [], model: stored.model };
  for (const p of PARTS) {
    const b = stored.blocks[p];
    if (b.by === "model" && b.text) { out[p] = [["", b.text]]; out.prose!.push(p); }
  }
  return out.prose!.length ? out : base;
}

/* ----------------------------------------------------------------- summary */

function summaryTab(ws: ExcelJS.Worksheet, d: Data, flagged: number, view: Perspective): TabPlan {
  ws.views = [{ showGridLines: false }];
  ws.properties.tabColor = { argb: INK };
  // A 12-column grid of equal columns. Blocks are merged ranges on it; every block runs the full width so the eye only moves down.
  const COLS = 12, W = 9.5;
  ws.columns = Array.from({ length: COLS }, () => ({ width: W }));
  const headingCells: string[] = [];
  const put = (ref: string, value: ExcelJS.CellValue, f: Partial<ExcelJS.Font>, align: Partial<ExcelJS.Alignment> = {}) => {
    if (ref.includes(":")) ws.mergeCells(ref);
    const cell = ws.getCell(ref.split(":")[0]);
    cell.value = value; cell.font = font(f); cell.alignment = { vertical: "middle", wrapText: true, ...align };
    return cell;
  };
  const rule = (r: number, from = 1, to = COLS, argb = LINE) => { for (let c = from; c <= to; c++) ws.getCell(r, c).border = { bottom: { style: "thin", color: { argb } } }; };
  const heading = (r: number, label: string) => { const ref = `A${r}:${col(COLS)}${r}`; put(ref, label, { size: 11, bold: true }, { vertical: "bottom" }); ws.getRow(r).height = 26; rule(r, 1, COLS, INK); headingCells.push(ref); };
  /** Height for a wrapping line over `units` column units, with the same rule `wrapShortfalls` checks. */
  const fit = (body: string, units: number, size = 10) => wrapHeight(body, Math.max(1, Math.floor(units * CHARS_PER_UNIT * (10 / size))), Math.ceil(size * 1.5), 8);
  const gap = (r: number, h = 10) => { ws.getRow(r).height = h; };
  const [y, m, dd] = d.e.starts_on.split("-").map(Number);
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const days = Math.max(0, Math.round((Date.UTC(y, m - 1, dd) - today.getTime()) / 86400000));
  const people = d.people;
  const aCount = people.filter((p) => p.priority === "A").length;
  const crm = d.companies.some((c) => c.heat !== null || c.account_owner || c.account_type);

  // The one dominant element: the event and the time left.
  ws.getRow(1).height = 10;
  put("A2:I3", d.e.name, { size: 24, bold: true }, { vertical: "bottom" });
  headingCells.push("A2:I3", "J2:L3");
  ws.getRow(2).height = 22; ws.getRow(3).height = 22;
  put("A4:I4", `${d.e.venue ? `${d.e.venue}. ` : ""}Doors open ${longDate(d.e.starts_on)}. Outreach list delivered ${longDate(d.e.delivered_on)}.`, { color: { argb: MUTE } }, { vertical: "top" });
  ws.getRow(4).height = 20;
  const daysCell = put("J2:L3", null, { size: 24, bold: true }, { horizontal: "right", vertical: "bottom" });
  setFormula(daysCell, `MAX(0,DATE(${y},${m},${dd})-TODAY())`, days);
  daysCell.numFmt = "0";
  put("J4:L4", "days until the doors open", { color: { argb: MUTE } }, { horizontal: "right", vertical: "top" });
  ws.getRow(5).height = 14;
  rule(5);
  let r = 6;

  // Perspective: three short blocks of label and fact. Composed in code from stored fields; it never advises.
  const block = (title: string, lines: Line[], prose = false) => {
    heading(r, title); r++;
    // The model's prose is one paragraph across the full width. Written as text: a value that begins with = is a string here, never a formula.
    if (prose) {
      const body = lines[0][1];
      put(`A${r}:L${r}`, body, {}, { vertical: "top" });
      ws.getRow(r).height = Math.max(20, fit(body, W * 12));
      r++;
      gap(r); r++;
      return;
    }
    for (const [label, body] of lines) {
      put(`A${r}:B${r}`, label, { bold: true, color: { argb: MUTE } }, { vertical: "top" });
      put(`C${r}:L${r}`, body, {}, { vertical: "top" });
      ws.getRow(r).height = Math.max(20, fit(body, W * 10));
      r++;
    }
    gap(r); r++;
  };
  block("Why this event", view.why, view.prose?.includes("why"));
  block("The list", view.list, view.prose?.includes("list"));
  block("Where we stand", view.stand, view.prose?.includes("stand"));
  if (view.prose?.length) {
    // Said once, plainly: which blocks a model wrote, and that code checked them.
    const names = view.prose.map((p) => PART_TITLES[p]);
    const rest = PARTS.filter((p) => !view.prose!.includes(p)).map((p) => PART_TITLES[p]);
    const note = `${listWords(names, 3)} ${names.length === 1 ? "was" : "were"} written by ${view.model}. Every number, name and quotation in ${names.length === 1 ? "it" : "them"} was checked by code against the figures and seat requests on file.${rest.length ? ` ${listWords(rest, 3)} ${rest.length === 1 ? "is" : "are"} composed by rules from the same figures.` : ""}`;
    put(`A${r}:L${r}`, note, { size: 9, color: { argb: MUTE } }, { vertical: "top" });
    ws.getRow(r).height = Math.max(20, fit(note, W * 12, 9));
    r++;
    gap(r); r++;
  }

  // The numbers that change as people work, live from the tabs. Few, in a column, not a tile grid.
  heading(r, "Live from the tabs"); r++;
  const live: [string, string, string, number][] = [
    ["People on the outreach list", "attendees and prospects, priority A and B", `COUNTA(Attendees!$B$${FIRST_ROW}:$B$${LISTS_MAX})+COUNTA(Prospects!$B$${FIRST_ROW}:$B$${LISTS_MAX})`, people.length],
    ["Priority A", "", `COUNTIF(Attendees!$A$${FIRST_ROW}:$A$${LISTS_MAX},"A")+COUNTIF(Prospects!$A$${FIRST_ROW}:$A$${LISTS_MAX},"A")`, aCount],
    ["Emails verified twice", "two checks agreed", `COUNTIF(Attendees!$${pCol("Email status")}$${FIRST_ROW}:$${pCol("Email status")}$${LISTS_MAX},"Verified twice")+COUNTIF(Prospects!$${pCol("Email status")}$${FIRST_ROW}:$${pCol("Email status")}$${LISTS_MAX},"Verified twice")`, people.filter((p) => emailStatus(p) === "Verified twice").length],
    ["Companies on the outreach list", "", `COUNTIF(Companies!$${cCol("Status")}$${FIRST_ROW}:$${cCol("Status")}$${LISTS_MAX},"On the outreach list")`, d.companies.filter((c) => c.n > 0).length],
    ...(crm ? [["Hot accounts", "open deal with activity in the last 30 days", `COUNTIF(Companies!$${cCol("Heat")}$${FIRST_ROW}:$${cCol("Heat")}$${LISTS_MAX},"Hot")`, d.companies.filter((c) => c.heat === "hot").length] as [string, string, string, number]] : []),
    ["Open on the Review tab", "a blank Decision means Keep", `COUNTA(Review!$C$${REVIEW_FIRST}:$C$${LISTS_MAX})-COUNTA(Review!$M$${REVIEW_FIRST}:$M$${LISTS_MAX})`, flagged],
    ["Meetings booked or held", "from the Meetings tab", `COUNTIF(Meetings!$G$${FIRST_ROW}:$G$${LISTS_MAX},"Booked")+COUNTIF(Meetings!$G$${FIRST_ROW}:$G$${LISTS_MAX},"Held")`, 0],
  ];
  for (const [label, sub, formula, result] of live) {
    ws.getRow(r).height = 26;
    const n = put(`A${r}:B${r}`, null, { size: 18, bold: true }, { horizontal: "left" });
    setFormula(n, formula, result);
    n.numFmt = "0";
    headingCells.push(`A${r}`);
    put(`C${r}:L${r}`, sub ? { richText: [{ font: font({ bold: true }), text: label }, { font: font({ color: { argb: MUTE } }), text: `  ${sub}` }] } : label, { bold: true });
    r++;
  }
  gap(r); r++;

  // How the list narrowed, step by step, with why in plain words. The bar is text in Excel; the Google layer redraws it with SPARKLINE.
  const f = d.funnel, drops = d.list.dropped;
  const funnel: [string, number, string][] = [
    ["Rows on the attendee list", f.uploaded, ""],
    ["After cleaning and your lists", f.listed, dropWords(drops, ["duplicate", "no_company", "excluded_company", "existing_customer"])],
    ["After tiering", f.tiered, dropWords(drops, ["low_tier", "tiering_failed"])],
    ["People found and checked", f.checked, `${num(f.enriched)} looked up; ${dropWords(drops, ENRICH_DROPS)}`],
    ["On the outreach list", people.length, dropWords(drops, ["rejected_in_review"])],
  ];
  heading(r, "How the attendee list narrowed"); r++;
  const top = Math.max(1, ...funnel.map((x) => x[1]));
  const sparklines: TabPlan["sparklines"] = [];
  for (const [i, [label, n, why]] of funnel.entries()) {
    put(`A${r}:C${r}`, label, { bold: true }, { vertical: "top" });
    put(`D${r}:I${r}`, why, { size: 9, color: { argb: MUTE } }, { vertical: "top" });
    const numCell = put(`J${r}`, n, { size: 14, bold: true }, { horizontal: "right", vertical: "top" });
    numCell.numFmt = "#,##0";
    headingCells.push(`J${r}`);
    const bar = put(`K${r}:L${r}`, "█".repeat(Math.max(1, Math.round((n / top) * 16))), { size: 11, color: { argb: i === funnel.length - 1 ? GREEN : LINE } }, { vertical: "top", horizontal: "left" });
    bar.alignment = { vertical: "top", horizontal: "left", wrapText: false };
    sparklines.push({ cell: `K${r}`, value: `J${r}`, max: top });
    ws.getRow(r).height = Math.max(22, fit(why, W * 6, 9));
    r++;
  }
  gap(r); r++;

  // The accounts with the most people on the list, each linked to its row. A ranking of the data, not an order of work.
  const onList = d.companies.filter((c) => c.n > 0).sort((a, b) => b.n - a.n || (a.tier ?? 9) - (b.tier ?? 9) || heatRank(a.heat) - heatRank(b.heat) || a.name.localeCompare(b.name));
  if (onList.length) {
    heading(r, "Accounts with the most people on the outreach list"); r++;
    const headRow = ws.getRow(r);
    const headers: [string, string, string][] = [["A", "C", "Company"], ["D", "D", "Tier"], ["E", "E", "Heat"], ["F", "G", "Account type"], ["H", "I", "Open deal"], ["J", "K", "Account owner"], ["L", "L", "People"]];
    for (const [from, to, label] of headers) put(`${from}${r}:${to}${r}`, label, { size: 9, bold: true, color: { argb: MUTE } }, { horizontal: ["D", "E", "L"].includes(from) ? "center" : "left", vertical: "bottom" });
    headRow.height = 18; rule(r);
    r++;
    for (const c of onList.slice(0, 8)) {
      const name = put(`A${r}:C${r}`, null, {});
      setLink(name, c.name, sheetRef("Companies", `A${c.row}`), "Open on the Companies tab");
      name.font = font({ bold: true, color: { argb: GREEN }, underline: true });
      put(`D${r}`, c.tier ?? "", { color: { argb: MUTE } }, { horizontal: "center" });
      const heat = put(`E${r}`, heatWord(c.heat), c.heat === "hot" ? { bold: true, color: { argb: WHITE } } : c.heat === "warm" ? { bold: true } : { color: { argb: MUTE } }, { horizontal: "center" });
      if (c.heat === "hot") heat.fill = solid(GREEN);
      if (c.heat === "warm") heat.fill = solid(SAND);
      put(`F${r}:G${r}`, accountTypeWord(c.account_type), { color: { argb: c.account_type && c.account_type !== "none" ? INK : MUTE } });
      put(`H${r}:I${r}`, dealWords(c.deal_name) || (crm ? "None" : ""), { color: { argb: c.deal_name ? INK : MUTE } });
      put(`J${r}:K${r}`, c.account_owner ?? (crm ? "Unassigned" : ""), { color: { argb: c.account_owner ? INK : MUTE } });
      put(`L${r}`, c.n, {}, { horizontal: "center" });
      ws.getRow(r).height = 20; rule(r);
      r++;
    }
    gap(r); r++;
  }

  // What ran, in each vendor's own credits and AI on its own, never added together and never in dollars for credits.
  heading(r, "What ran"); r++;
  const spendRows: [string, string][] = [...d.use.credits.map((x): [string, string] => [x.vendor, `${num(x.credits)} credits`]), ["AI", plural(d.use.ai_calls, "model call")]];
  for (const [label, line] of spendRows) {
    put(`A${r}:B${r}`, label, { bold: true }, { vertical: "top" });
    put(`C${r}:L${r}`, line, {}, { vertical: "top" });
    ws.getRow(r).height = 20;
    r++;
  }
  gap(r); r++;

  // The tabs, with what each holds.
  heading(r, "Tabs"); r++;
  const tabs: [string, string][] = [
    ["Review", flagged ? `${plural(flagged, "case")} open. Keep, Drop or Dismiss, by case. Events Desk reads the decisions from here.` : "Nothing open. Events Desk reads decisions from here."],
    ["Attendees", "people from the attendee list, priority A and B, with company, CRM and vendor detail. Outreach status and Notes are yours."],
    ["Prospects", "buyer titles at attending companies who were not on the attendee list. Same columns."],
    ["Companies", "every account: fit, firmographics, CRM and where it stands on the outreach list."],
    ...(d.attendee_people > 0 ? [["Other attendees", "people from the attendee list at a tier 3 company or with a tier 3 title."] as [string, string]] : []),
    ["Meetings", "a log of conversations at the event; the count above reads from it."],
  ];
  for (const [tab, line] of tabs) {
    setLink(put(`A${r}:B${r}`, null, {}, { vertical: "top" }), tab, sheetRef(tab, "A1"));
    ws.getCell(`A${r}`).font = font({ bold: true, color: { argb: GREEN }, underline: true });
    put(`C${r}:L${r}`, line, {}, { vertical: "top" });
    ws.getRow(r).height = Math.max(20, fit(line, W * 10));
    r++;
  }
  ws.pageSetup = { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 1, margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  for (const f of wrapShortfalls(ws)) ws.getRow(f.row).height = f.needs;
  return { title: "Summary", kind: "summary", tabColor: hexOf(INK), headerRow: 1, firstRow: 1, lastRow: r, columns: Array.from({ length: COLS }, (_, i) => ({ header: col(i + 1) })), groups: [], dropdowns: [], filterViews: [], headingCells, sparklines };
}

/* ------------------------------------------------------------------- build */

export interface Delivery { xlsx: Buffer; plan: SheetPlan }

/** What people typed on a published Sheet, read back before a refresh replaces it. */
export interface Carried { people: Map<string, { status: string; notes: string }>; meetings: string[][] }

/** Reads the three tabs into what the rebuilt workbook writes back. Null when a tab has no contact id column: such a Sheet cannot be matched to anyone. */
export function carryFromTabs(attendees: string[][], prospects: string[][], meetings: string[][]): Carried | null {
  const low = (row: string[]) => row.map((v) => String(v ?? "").trim().toLowerCase());
  const people = new Map<string, { status: string; notes: string }>();
  for (const grid of [attendees, prospects]) {
    const head = grid.findIndex((row) => low(row).includes("contact_id"));
    if (head < 0) return null;
    const cells = low(grid[head]);
    const id = cells.indexOf("contact_id"), status = cells.indexOf("outreach status"), notes = cells.indexOf("notes");
    if (status < 0 || notes < 0) return null;
    for (const row of grid.slice(head + 1)) {
      const key = String(row[id] ?? "").trim();
      if (key && (row[status] || row[notes])) people.set(key, { status: String(row[status] ?? ""), notes: String(row[notes] ?? "") });
    }
  }
  // Meetings have no id: the whole row is kept, in the columns the tab was built with.
  const head = meetings.findIndex((row) => { const c = low(row); return c[0] === "contact" && c.includes("status"); });
  if (head < 0) return null;
  const header = low(meetings[head]);
  const at = MEETING_COLS.map((c) => header.indexOf(c.header.toLowerCase()));
  const kept = meetings.slice(head + 1).filter((row) => MEETING_COLS.some((c, k) => c.edit && at[k] >= 0 && String(row[at[k]] ?? "").trim()))
    .map((row) => at.map((i) => (i >= 0 ? String(row[i] ?? "") : "")));
  return { people, meetings: kept };
}

/** The workbook and the plan for the Google layer. Tabs in reading order: Summary, Review, then the lists. */
export async function buildDelivery(db: Db, id: string, compose: (d: Data) => Perspective = withStored, carried?: Carried): Promise<Delivery> {
  const d = await load(db, id);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Events Desk";
  wb.created = new Date();
  // The Summary sheet is added first so it opens first, and filled last, once every row it links to is known.
  const summary = wb.addWorksheet("Summary");
  const attendees = d.people.filter((p) => p.source === "attendee"), prospects = d.people.filter((p) => p.source === "prospect");
  const flaggedCount = d.review.length;
  const tabs: TabPlan[] = [];
  tabs.push(reviewTab(wb, d.review).plan);
  tabs.push(peopleTab(wb, "Attendees", attendees, `Attendees (${num(attendees.length)})`, carried));
  tabs.push(peopleTab(wb, "Prospects", prospects, `Prospects (${num(prospects.length)})`, carried));
  tabs.push(companiesTab(wb, d.companies));
  // Only when the attendee list had people. A list of company names alone has nobody to show here.
  if (d.attendee_people > 0) tabs.push(othersTab(wb, d.others));
  tabs.push(meetingsTab(wb, carried));
  listsTab(wb, d.people);
  tabs.unshift(summaryTab(summary, d, flaggedCount, compose(d)));
  wb.views = [{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 0, visibility: "visible" }];
  return { xlsx: Buffer.from(await wb.xlsx.writeBuffer()), plan: { tabs } };
}

export async function buildWorkbook(db: Db, id: string) {
  return (await buildDelivery(db, id)).xlsx;
}

/* ------------------------------------------------------------------ import */

/** Finds the header row by its contact_id and Decision cells, so a banner above it is fine,
    and returns the ids marked Drop. Works on text from an .xlsx or from the Sheets API alike. */
export function dropIdsFromGrid(grid: string[][]): string[] {
  const norm = (v: unknown) => String(v ?? "").trim();
  let head = -1, idCol = -1, decisionCol = -1;
  for (let r = 0; r < grid.length && head < 0; r++) {
    const cells = grid[r].map((v) => norm(v).toLowerCase());
    const i = cells.indexOf("contact_id"), d = cells.indexOf("decision");
    if (i >= 0 && d >= 0) { head = r; idCol = i; decisionCol = d; }
  }
  if (head < 0) throw new RuleError("The Review tab is missing contact_id or Decision.");
  const drops: string[] = [];
  for (const row of grid.slice(head + 1)) {
    if (norm(row[decisionCol]).toLowerCase() === "drop" && norm(row[idCol])) drops.push(norm(row[idCol]));
  }
  return drops;
}

export interface ReviewDecision { case_id: string | null; contact_id: string | null; decision: string }

/** Every filled Decision in the Review tab, with the case it belongs to (a hidden column) and the person (another). A blank means Keep and is not returned.
    Works on text from an .xlsx or from the Sheets API alike. */
export function decisionsFromGrid(grid: string[][]): ReviewDecision[] {
  const norm = (v: unknown) => String(v ?? "").trim();
  let head = -1, caseCol = -1, idCol = -1, decisionCol = -1;
  for (let r = 0; r < grid.length && head < 0; r++) {
    const cells = grid[r].map((v) => norm(v).toLowerCase());
    const i = cells.indexOf("contact_id"), d = cells.indexOf("decision");
    if (i >= 0 && d >= 0) { head = r; idCol = i; decisionCol = d; caseCol = cells.indexOf("case_id"); }
  }
  if (head < 0) throw new RuleError("The Review tab is missing contact_id or Decision.");
  const out: ReviewDecision[] = [];
  for (const row of grid.slice(head + 1)) {
    const decision = norm(row[decisionCol]).toLowerCase();
    if (!decision) continue;
    out.push({ case_id: caseCol >= 0 ? norm(row[caseCol]) || null : null, contact_id: norm(row[idCol]) || null, decision });
  }
  return out;
}

/** Applies the Review tab. A row with a case id answers that case through the same function the Cases screen uses (Keep, Drop or Dismiss, only what the case allows);
    a row with no case id is a flagged person no case covers, and its Drop goes through `applyReviewDrops`. A blank row, or a Keep on such a person, changes nothing.
    An id from another event, an unknown id, a decision the case does not allow, or a case already answered is skipped and counted, not applied. */
export async function applyReviewGrid(db: Db, id: string, actor: string, grid: string[][]) {
  await assertDelivered(db, id);
  const decisions = decisionsFromGrid(grid);
  let answered = 0, skipped = 0;
  const loose: string[] = [];
  for (const d of decisions) {
    if (d.case_id) {
      try { const r = await answerCase(db, id, d.case_id, actor, d.decision); if (r.already_decided) skipped++; else answered++; }
      catch (e) { if (e instanceof RuleError) skipped++; else throw e; }
    } else if (d.decision === "drop" && d.contact_id) loose.push(d.contact_id);
  }
  const { dropped } = await applyReviewDrops(db, id, actor, loose);
  // A person dropped by a case answer is counted by the case; the figure below is people dropped by decisions without a case.
  return { dropped, answered, skipped };
}

/** The only code that applies a review Drop in bulk. Matches on contact_id and only for
    contacts of this event; an id from another event, or one that is unknown, changes nothing.
    The screen's single-person route and both imports (file and Google Sheet) call this. */
export async function applyReviewDrops(db: Db, id: string, actor: string, contactIds: string[]) {
  await assertDelivered(db, id);
  const unique = [...new Set(contactIds.map((c) => c.trim()).filter(Boolean))];
  return db.tx(async (q) => {
    let dropped = 0;
    for (const contactId of unique) dropped += await dropInReview(q, id, contactId);
    await logActivity(q, id, actor, "review", `Imported review decisions, dropped ${dropped}`);
    return { dropped };
  });
}

/** Applies the Decision column of an uploaded workbook. */
export async function importReview(db: Db, id: string, actor: string, file: ArrayBuffer) {
  await assertDelivered(db, id);
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(file as never); } catch { throw new RuleError("That is not a workbook."); }
  const ws = wb.getWorksheet("Review");
  if (!ws) throw new RuleError("That workbook has no Review tab.");
  const grid: string[][] = [];
  ws.eachRow((row, n) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cellText(cell.value).trim(); });
    grid[n - 1] = cells;
  });
  for (let i = 0; i < grid.length; i++) grid[i] ??= [];
  return applyReviewGrid(db, id, actor, grid);
}

/** The one rule for a review drop: a kept contact on this event becomes `rejected_in_review`. Returns how many rows changed (0 or 1). */
const dropInReview = async (q: Db["query"], eventId: string, contactId: string) =>
  (await q("UPDATE contacts SET drop_reason = 'rejected_in_review', dropped_at = now() WHERE id = $1 AND event_id = $2 AND dropped_at IS NULL RETURNING id", [contactId, eventId])).length;

/** One person's review decision from the screen. Same gate and same rule as importing the Review tab; Keep clears the flags so nothing asks again. */
export async function reviewContact(db: Db, id: string, actor: string, contactId: string, decision: "keep" | "drop") {
  await assertDelivered(db, id);
  return db.tx(async (q) => {
    const [c] = await q<{ full_name: string | null; dropped_at: string | null }>("SELECT full_name, dropped_at FROM contacts WHERE id = $1 AND event_id = $2", [contactId, id]);
    if (!c) throw new RuleError("That person is not on this outreach list.");
    const who = c.full_name ?? "that person";
    if (decision === "drop") {
      const dropped = await dropInReview(q, id, contactId);
      if (dropped) await stopContacts(q, [contactId], "remove", "dropped_in_review");
      if (dropped) await logActivity(q, id, actor, "review", `Dropped ${who} in review`);
      return { dropped, kept: 0 };
    }
    if (c.dropped_at) throw new RuleError(`${who} was already dropped.`);
    await q("DELETE FROM review_flags WHERE contact_id = $1", [contactId]);
    await logActivity(q, id, actor, "review", `Kept ${who} in review`);
    return { dropped: 0, kept: 1 };
  });
}
