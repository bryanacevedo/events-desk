import { describe, expect, it } from "vitest";
import { gridRange, polishRequests, sheetRefs, polishWords, type SheetPlan } from "../src/server/sheets-polish.ts";

const plan: SheetPlan = {
  tabs: [
    { title: "Summary", kind: "summary", tabColor: "#15231B", headerRow: 1, firstRow: 1, lastRow: 40, columns: Array.from({ length: 12 }, (_, i) => ({ header: String(i) })), groups: [], dropdowns: [], filterViews: [], headingCells: ["A2:I3", "K9"], sparklines: [{ cell: "L9", value: "K9", max: 1650 }] },
    { title: "Review", kind: "review", tabColor: "#D1501C", headerRow: 4, firstRow: 5, lastRow: 12,
      columns: [{ header: "case_id", hidden: true }, { header: "contact_id", hidden: true }, { header: "Case" }, { header: "Name" }, { header: "Decision", edit: true }, { header: "What happens" }],
      groups: [{ label: "Case", from: 1, to: 3, folded: false }], dropdowns: [{ column: 5, from: 5, to: 8, values: ["Keep", "Drop", "Dismiss"], strict: true }, { column: 5, from: 9, to: 12, values: ["Keep", "Dismiss"], strict: true }],
      filterViews: [{ title: "Still open", column: 5, blank: true }, { title: "Late-stage deal", column: 3, equals: "Late-stage deal" }], headingCells: ["A1"], sparklines: [] },
    { title: "Attendees", kind: "table", tabColor: "#1F5D3F", headerRow: 3, firstRow: 4, lastRow: 142,
      columns: [{ header: "Priority" }, { header: "Name" }, { header: "Outreach status", edit: true }, { header: "Notes", edit: true }, { header: "Source" }, { header: "Flags" }],
      groups: [{ label: "Person", from: 1, to: 2, folded: false }, { label: "Detail", from: 5, to: 6, folded: true }], dropdowns: [{ column: 3, from: 4, to: 142, values: ["Not started", "Contacted"], strict: true }],
      filterViews: [{ title: "Priority A", column: 1, equals: "A" }], headingCells: ["A1"], sparklines: [] },
    { title: "Meetings", kind: "meetings", tabColor: null, headerRow: 3, firstRow: 4, lastRow: 63, columns: [{ header: "Contact", edit: true }, { header: "Company" }], groups: [], dropdowns: [{ column: 1, from: 4, to: 63, rangeRef: "Lists!$A$2:$A$5000", strict: false }], filterViews: [], headingCells: ["A1"], sparklines: [] },
    { title: "Lists", kind: "lists", tabColor: null, headerRow: 1, firstRow: 2, lastRow: 300, columns: [{ header: "Label" }], groups: [], dropdowns: [], filterViews: [], headingCells: [], sparklines: [] },
  ],
};
const sheets = [{ title: "Summary", sheetId: 0 }, { title: "Review", sheetId: 11 }, { title: "Attendees", sheetId: 22 }, { title: "Meetings", sheetId: 33 }, { title: "Lists", sheetId: 44 }];
const all = (name: string) => polishRequests(plan, sheets).find((b) => b.name === name)!.requests as any[];

describe("the Google layer's requests", () => {
  it("reads A1 into grid ranges", () => {
    expect(gridRange(7, "B3")).toEqual({ sheetId: 7, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 1, endColumnIndex: 2 });
    expect(gridRange(7, "A2:I3")).toEqual({ sheetId: 7, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 9 });
    expect(gridRange(7, "AA10")).toMatchObject({ startColumnIndex: 26 });
  });
  it("sets the app's fonts and tab colors, and folds the detail group as a collapsed column group", () => {
    const look = all("look");
    expect(look.find((r) => r.updateSheetProperties?.properties?.sheetId === 11).updateSheetProperties.properties.tabColorStyle.rgbColor).toEqual({ red: 0xd1 / 255, green: 0x50 / 255, blue: 0x1c / 255 });
    // Body font over the whole tab first, then the heading font on the heading cells.
    const fonts = look.filter((r) => r.repeatCell && r.repeatCell.range.sheetId === 0).map((r) => [r.repeatCell.range, r.repeatCell.cell.userEnteredFormat.textFormat.fontFamily]);
    expect(fonts[0]).toEqual([{ sheetId: 0 }, "Geist"]);
    expect(fonts.slice(1).map((f) => f[1])).toEqual(["IBM Plex Sans", "IBM Plex Sans"]);
    const group = look.find((r) => r.addDimensionGroup);
    expect(group.addDimensionGroup.range).toEqual({ sheetId: 22, dimension: "COLUMNS", startIndex: 4, endIndex: 6 });
    expect(look.find((r) => r.updateDimensionProperties)?.updateDimensionProperties).toMatchObject({ range: { sheetId: 22, startIndex: 4, endIndex: 6 }, properties: { hiddenByUser: true } });
    // Hidden tabs and tabs the Sheet does not have are left alone.
    expect(look.some((r) => JSON.stringify(r).includes('"sheetId":44'))).toBe(false);
    // When the conversion already kept the file's outline as a group, it is only collapsed, never added twice.
    const kept = polishRequests(plan, sheets.map((s) => (s.title === "Attendees" ? { ...s, groups: [[4, 6] as [number, number]] } : s))).find((b) => b.name === "look")!.requests as any[];
    expect(kept.some((r) => r.addDimensionGroup)).toBe(false);
    expect(kept.some((r) => r.updateDimensionProperties?.range?.startIndex === 4)).toBe(true);
  });
  it("puts chips on the cells a person fills in, one rule per run of options, and protects nothing", () => {
    const controls = all("controls");
    const chips = controls.filter((r) => r.setDataValidation);
    expect(chips.every((r) => r.setDataValidation.rule.showCustomUi === true)).toBe(true);
    const review = chips.filter((r) => r.setDataValidation.range.sheetId === 11).map((r) => [r.setDataValidation.range, r.setDataValidation.rule.condition.values.map((v: any) => v.userEnteredValue)]);
    expect(review).toEqual([
      [{ sheetId: 11, startColumnIndex: 4, endColumnIndex: 5, startRowIndex: 4, endRowIndex: 8 }, ["Keep", "Drop", "Dismiss"]],
      [{ sheetId: 11, startColumnIndex: 4, endColumnIndex: 5, startRowIndex: 8, endRowIndex: 12 }, ["Keep", "Dismiss"]],
    ]);
    const meetings = chips.find((r) => r.setDataValidation.range.sheetId === 33).setDataValidation.rule;
    expect(meetings.condition).toEqual({ type: "ONE_OF_RANGE", values: [{ userEnteredValue: "=Lists!$A$2:$A$5000" }] });
    expect(meetings.strict).toBe(false);
    // No protection: it puts a lock on the tab names.
    expect(controls.some((r) => r.addProtectedRange)).toBe(false);
  });
  it("saves one filter view per cut, over the header and data rows", () => {
    const views = all("views").map((r) => r.addFilterView.filter);
    expect(views.map((v) => v.title)).toEqual(["Still open", "Late-stage deal", "Priority A"]);
    expect(views[0].range).toEqual({ sheetId: 11, startColumnIndex: 0, endColumnIndex: 6, startRowIndex: 3, endRowIndex: 12 });
    expect(views[0].filterSpecs).toEqual([{ columnIndex: 4, filterCriteria: { condition: { type: "BLANK" } } }]);
    expect(views[2].filterSpecs[0].filterCriteria.condition).toEqual({ type: "TEXT_EQ", values: [{ userEnteredValue: "A" }] });
  });
  it("draws the funnel bars with SPARKLINE in the brand green, from the number beside each", () => {
    const [s] = all("summary");
    expect(s.updateCells.range).toEqual(gridRange(0, "L9"));
    expect(s.updateCells.rows[0].values[0].userEnteredValue.formulaValue).toBe('=SPARKLINE(K9,{"charttype","bar";"max",1650;"color1","#1F5D3F"})');
  });
  it("never shares, and drops nothing but the batches that are empty", () => {
    const batches = polishRequests(plan, sheets);
    expect(batches.map((b) => b.name)).toEqual(["look", "controls", "views", "summary"]);
    expect(JSON.stringify(batches)).not.toMatch(/anyone|permission/i);
    expect(polishRequests(plan, [])).toEqual([]);
  });
  it("reads the tab ids out of a spreadsheets.get answer and words a partial failure", () => {
    expect(sheetRefs({ sheets: [{ properties: { sheetId: 3, title: "Summary" }, columnGroups: [{ range: { startIndex: 24, endIndex: 35 } }, { range: {} }] }, { properties: { title: "no id" } }, {}] })).toEqual([{ title: "Summary", sheetId: 3, groups: [[24, 35]] }]);
    expect(sheetRefs(null)).toEqual([]);
    expect(polishWords({ applied: ["look"], failed: [] })).toBe("");
    expect(polishWords({ applied: ["look"], failed: [{ name: "views", error: "Google answered 400: bad" }] })).toBe("Sheet polish skipped views (Google answered 400: bad)");
  });
});
