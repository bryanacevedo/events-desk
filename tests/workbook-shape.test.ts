import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildWorkbook } from "../src/server/workbook.ts";
import { deliverEvent, freshDb } from "./helpers.ts";

const cellRange = (ref: string) => { const m = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/)!; return { first: Number(m[2]), last: Number(m[4]) }; };

describe("workbook shape for Google Sheets", () => {
  it("has no text-matching cellIs rule, and every filter covers its data", async () => {
    const db = await freshDb();
    const id = await deliverEvent(db, readFileSync("samples/attendees.csv", "utf8"));
    await db.query("INSERT INTO review_flags (contact_id, flag, source) SELECT id, 'name_looks_wrong', 'code' FROM contacts WHERE event_id = $1 AND dropped_at IS NULL LIMIT 3 ON CONFLICT DO NOTHING", [id]).catch(() => {});
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load((await buildWorkbook(db, id)) as never);
    let rules = 0;
    for (const ws of wb.worksheets) {
      for (const cf of (ws as unknown as { conditionalFormattings: ExcelJS.ConditionalFormattingOptions[] }).conditionalFormattings) {
        for (const r of cf.rules) { rules++; expect(r.type, `${ws.name} ${cf.ref}`).not.toBe("cellIs"); }
      }
      if (["Attendees", "Prospects", "Companies", "Other attendees", "Meetings", "Review"].includes(ws.name)) {
        const f = ws.autoFilter as unknown as string | { from: unknown; to: unknown } | undefined;
        expect(f, ws.name).toBeTruthy();
        const ref = typeof f === "string" ? f : `${(f as any).from.address ?? (f as any).from}:${(f as any).to.address ?? (f as any).to}`;
        const { last } = cellRange(ref.includes(":") ? ref : "A1:A1");
        // Meetings keeps 60 ready rows; the others end at their last data row.
        expect(last, `${ws.name} filter ${ref}`).toBeGreaterThanOrEqual(ws.name === "Meetings" ? 63 : Math.max(ws.actualRowCount, 4));
      }
    }
    expect(rules).toBeGreaterThan(5);
  });
});
