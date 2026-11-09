/* The Google-native layer on the delivered Sheet.

   Drive converts the uploaded .xlsx, and what survives that conversion is a converted Excel file: fills,
   borders, frozen panes, plain dropdowns, filters, hidden columns. This module adds what only the Sheets
   API can set, after the upload, from a `SheetPlan` the workbook builder returns beside the bytes:

   - the fonts of the app (IBM Plex Sans for headings, Geist for everything else) and the tab colors;
   - folded column groups for the detail a reader needs less often;
   - dropdown chips on the cells a person fills in (Decision, Outreach status, Meetings), never as labels;
   - saved filter views for the cuts a reader actually makes (Priority A, hot accounts, by owner, still open);
   - SPARKLINE bars on the Summary funnel in place of the text bars the Excel file carries.

   Request building is pure (`polishRequests`) and tested with a fake fetch like the rest of sheets.ts. The
   requests are sent in named batches so one refused batch costs only its own effect. A failure here is
   reported to the caller, which logs it; delivery never depends on it, and the Excel file stands on its own.

   Checked against the Sheets API reference on 2026-11-09: batchUpdate request types, Table, FilterView,
   DimensionGroup, DataValidationRule (showCustomUi), SheetProperties. */

export interface PlanColumn { header: string; hidden?: boolean; edit?: boolean }
/** A dropdown over a run of rows in one column. `values` is a fixed list; `rangeRef` is an A1 range on another tab. */
export interface PlanDropdown { column: number; from: number; to: number; values?: string[]; rangeRef?: string; strict: boolean }
/** One saved view: rows where `column` equals `equals`, or is blank. */
export interface PlanFilterView { title: string; column: number; equals?: string; blank?: boolean }
export interface PlanGroup { label: string; from: number; to: number; folded: boolean }
export interface TabPlan {
  title: string;
  kind: "summary" | "table" | "review" | "meetings" | "lists";
  /** "#RRGGBB", or null for no color. */
  tabColor: string | null;
  /** 1-based rows. `lastRow` is the last data row (at least `firstRow`). */
  headerRow: number; firstRow: number; lastRow: number;
  columns: PlanColumn[];
  groups: PlanGroup[];
  dropdowns: PlanDropdown[];
  filterViews: PlanFilterView[];
  /** A1 ranges set in the heading font. */
  headingCells: string[];
  /** Summary only: a bar per funnel step. `max` is the top of the scale. */
  sparklines: { cell: string; value: string; max: number }[];
}
export interface SheetPlan { tabs: TabPlan[] }

/** A tab of the converted Sheet. `groups` are the column groups the conversion already made from the file's outline, as [start, end) indexes. */
export interface SheetRef { title: string; sheetId: number; groups?: [number, number][] }
export interface PolishBatch { name: string; requests: Record<string, unknown>[] }

/** Google Fonts both the Sheets editor and the API accept by family name. The app's own pair. */
export const HEADING_FONT = "IBM Plex Sans";
export const BODY_FONT = "Geist";

const hex = (h: string) => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h)!; return { red: parseInt(m[1], 16) / 255, green: parseInt(m[2], 16) / 255, blue: parseInt(m[3], 16) / 255 }; };
const color = (h: string) => ({ rgbColor: hex(h) });
export const GREEN = "#1F5D3F";

/** A1 ("B7" or "A2:I3") to a GridRange on one sheet. */
export function gridRange(sheetId: number, a1: string) {
  const cell = (ref: string) => { const m = /^([A-Z]+)(\d+)$/.exec(ref)!; let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64); return { row: Number(m[2]) - 1, col: c - 1 }; };
  const [a, b] = a1.split(":");
  const s = cell(a), e = cell(b ?? a);
  return { sheetId, startRowIndex: s.row, endRowIndex: e.row + 1, startColumnIndex: s.col, endColumnIndex: e.col + 1 };
}
const cols = (sheetId: number, from: number, to: number, fromRow?: number, toRow?: number) => ({
  sheetId, startColumnIndex: from - 1, endColumnIndex: to,
  ...(fromRow ? { startRowIndex: fromRow - 1 } : {}), ...(toRow ? { endRowIndex: toRow } : {}),
});

/** Every batchUpdate request for the plan, in named batches. Tabs the Sheet does not have are skipped, never guessed. */
export function polishRequests(plan: SheetPlan, sheets: SheetRef[]): PolishBatch[] {
  const look: Record<string, unknown>[] = [], controls: Record<string, unknown>[] = [], views: Record<string, unknown>[] = [], summary: Record<string, unknown>[] = [];
  for (const tab of plan.tabs) {
    const sheet = sheets.find((s) => s.title === tab.title);
    if (!sheet || tab.kind === "lists") continue;
    const { sheetId } = sheet;
    const width = tab.columns.length;

    // Look: tab color, the body font over the whole tab, the heading font on the title and section headings.
    if (tab.tabColor) look.push({ updateSheetProperties: { properties: { sheetId, tabColorStyle: color(tab.tabColor) }, fields: "tabColorStyle" } });
    look.push({ repeatCell: { range: { sheetId }, cell: { userEnteredFormat: { textFormat: { fontFamily: BODY_FONT } } }, fields: "userEnteredFormat.textFormat.fontFamily" } });
    for (const a1 of tab.headingCells) look.push({ repeatCell: { range: gridRange(sheetId, a1), cell: { userEnteredFormat: { textFormat: { fontFamily: HEADING_FONT } } }, fields: "userEnteredFormat.textFormat.fontFamily" } });
    // Folded groups: hidden columns under a group read as a collapsed group with its own control. The conversion keeps the file's outline on most imports,
    // so a group the Sheet already has at the same columns is not added again (adding it would nest a second, identical group).
    for (const g of tab.groups.filter((x) => x.folded)) {
      const exists = (sheet.groups ?? []).some(([s, e]) => s === g.from - 1 && e === g.to);
      if (!exists) look.push({ addDimensionGroup: { range: { sheetId, dimension: "COLUMNS", startIndex: g.from - 1, endIndex: g.to } } });
      look.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: g.from - 1, endIndex: g.to }, properties: { hiddenByUser: true }, fields: "hiddenByUser" } });
    }

    // Controls: chips on the cells a person fills in.
    for (const d of tab.dropdowns) {
      const condition = d.values ? { type: "ONE_OF_LIST", values: d.values.map((v) => ({ userEnteredValue: v })) } : { type: "ONE_OF_RANGE", values: [{ userEnteredValue: `=${d.rangeRef}` }] };
      controls.push({ setDataValidation: { range: cols(sheetId, d.column, d.column, d.from, d.to), rule: { condition, strict: d.strict, showCustomUi: true } } });
    }

    // Views: the cuts a reader makes, saved once so nobody rebuilds a filter on a phone.
    for (const v of tab.filterViews) {
      const criteria = v.blank ? { condition: { type: "BLANK" } } : { condition: { type: "TEXT_EQ", values: [{ userEnteredValue: v.equals ?? "" }] } };
      views.push({ addFilterView: { filter: { title: v.title, range: cols(sheetId, 1, width, tab.headerRow, Math.max(tab.lastRow, tab.firstRow)), filterSpecs: [{ columnIndex: v.column - 1, filterCriteria: criteria }] } } });
    }

    // Summary: a bar per funnel step, drawn by Sheets from the number beside it.
    for (const s of tab.sparklines) {
      const formula = `=SPARKLINE(${s.value},{"charttype","bar";"max",${s.max};"color1","${GREEN}"})`;
      summary.push({ updateCells: { range: gridRange(sheetId, s.cell), rows: [{ values: [{ userEnteredValue: { formulaValue: formula } }] }], fields: "userEnteredValue" } });
    }
  }
  return [{ name: "look", requests: look }, { name: "controls", requests: controls }, { name: "views", requests: views }, { name: "summary", requests: summary }].filter((b) => b.requests.length);
}

/** The fields `sheetRefs` reads from spreadsheets.get. */
export const SHEET_FIELDS = "sheets(properties(sheetId,title),columnGroups(range(startIndex,endIndex)))";

/** Reads a spreadsheets.get answer into the title to id list the builder needs, with the column groups the conversion already made. */
export function sheetRefs(body: unknown): SheetRef[] {
  const sheets = (body as { sheets?: { properties?: { sheetId?: number; title?: string }; columnGroups?: { range?: { startIndex?: number; endIndex?: number } }[] }[] })?.sheets ?? [];
  return sheets.flatMap((s) => (typeof s.properties?.sheetId === "number" && typeof s.properties.title === "string"
    ? [{ title: s.properties.title, sheetId: s.properties.sheetId, groups: (s.columnGroups ?? []).flatMap((g) => (typeof g.range?.startIndex === "number" && typeof g.range.endIndex === "number" ? [[g.range.startIndex, g.range.endIndex] as [number, number]] : [])) }]
    : []));
}

export interface PolishResult { applied: string[]; failed: { name: string; error: string }[] }
export const polishWords = (r: PolishResult) => (r.failed.length ? `Sheet polish skipped ${r.failed.map((f) => `${f.name} (${f.error})`).join("; ")}` : "");
