import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { seed } from "../src/server/seed.ts";
import { buildWorkbook, wrapShortfalls } from "../src/server/workbook.ts";
import { freshDb } from "./helpers.ts";

describe("nothing is cut off in the delivered workbook", () => {
  it("fits every wrapped cell on the Summary, and every column fits its header", async () => {
    const db = await freshDb();
    await seed(db, { large: "delivered" });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWorkbook(db, "evt_meridian")) as never);
    // Every tab, the new ones included: a wrapped cell whose row is too short for it is cut off in Excel and in Sheets.
    for (const ws of wb.worksheets) expect(wrapShortfalls(ws), ws.name).toEqual([]);
    for (const [tab, headerRow] of [["Attendees", 3], ["Prospects", 3], ["Companies", 3], ["Other attendees", 3], ["Review", 4], ["Meetings", 3]] as const) {
      const ws = wb.getWorksheet(tab)!;
      ws.getRow(headerRow).eachCell((cell, c) => {
        if (ws.getColumn(c).hidden) return;
        expect(ws.getColumn(c).width, `${tab}: ${cell.text}`).toBeGreaterThanOrEqual(String(cell.text).length * 1.25);
      });
    }
  }, 60_000);
});
