/* Reads an uploaded file into the same `Parsed` shape as a CSV, so column mapping
   and normalizing never know which format came in. The file type comes from its
   first bytes, never from its name. Cell values are only ever read as data: a
   formula is never evaluated, only its stored result is read, and every value
   becomes plain text. */

import ExcelJS from "exceljs";
import { parseCsv, parseTable, type Parsed } from "../shared/ingest.ts";
import { RuleError } from "./events.ts";

export type FileKind = "xlsx" | "xls" | "csv" | "other";

const MAX_SHEET_ROWS = 200_000;
const MAX_SHEET_COLS = 500;

export function sniff(b: Uint8Array): FileKind {
  const at = (i: number) => b[i];
  if (b.length >= 4 && at(0) === 0x50 && at(1) === 0x4b && (at(2) === 0x03 || at(2) === 0x05) && (at(3) === 0x04 || at(3) === 0x06)) return "xlsx";
  if (b.length >= 8 && [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((x, i) => at(i) === x)) return "xls";
  if (b.length >= 4 && at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46) return "other"; // %PDF
  if (b.subarray(0, 4096).includes(0)) return "other"; // text never holds a NUL byte
  return "csv";
}

/** One cell as plain text. Anything unknown becomes an empty string. */
export function cellText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const iso = v.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
  }
  if (typeof v !== "object") return "";
  const o = v as Record<string, unknown>;
  if (Array.isArray(o.richText)) return o.richText.map((r) => cellText((r as { text?: unknown })?.text)).join("");
  // A formula keeps only the result Excel stored with it. It is never run.
  if ("formula" in o || "sharedFormula" in o || "result" in o) return cellText(o.result);
  if ("error" in o) return "";
  const link = typeof o.hyperlink === "string" ? o.hyperlink.replace(/^mailto:/i, "") : "";
  if ("text" in o) return cellText(o.text) || link;
  return link;
}

/** Every non-empty row of a sheet as trimmed text, with trailing empty cells cut, like a CSV. */
function sheetLines(ws: ExcelJS.Worksheet): string[][] {
  if (ws.rowCount > MAX_SHEET_ROWS) throw new RuleError(`The sheet "${ws.name}" has more than ${MAX_SHEET_ROWS.toLocaleString("en-US")} rows.`);
  if (ws.columnCount > MAX_SHEET_COLS) throw new RuleError(`The sheet "${ws.name}" has more than ${MAX_SHEET_COLS} columns.`);
  const lines: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cellText(cell.value).trim(); });
    for (let i = 0; i < cells.length; i++) cells[i] ??= "";
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (cells.length) lines.push(cells);
  });
  return lines;
}

export async function parseWorkbook(bytes: Uint8Array): Promise<Parsed> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(bytes as never); }
  catch { throw new RuleError("That .xlsx file could not be read. Open it in Excel or Sheets, save it again as .xlsx or CSV, and upload that."); }
  // The sheet with the most data rows wins; a tie goes to the first tab.
  let best: string[][] = [];
  for (const ws of wb.worksheets) {
    const lines = sheetLines(ws);
    if (lines.length > best.length) best = lines;
  }
  return parseTable(best);
}

/** CSV text, an .xlsx workbook, or a clear refusal. */
export async function parseUpload(input: string | Uint8Array | ArrayBuffer): Promise<Parsed> {
  if (typeof input === "string") return parseCsv(input);
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  switch (sniff(bytes)) {
    case "xlsx": return parseWorkbook(bytes);
    case "xls": throw new RuleError("That is an old .xls workbook, which this desk does not read. Open it and save it as .xlsx or CSV, then upload that.");
    case "other": throw new RuleError("That file is not a CSV or an .xlsx workbook.");
    default: return parseCsv(new TextDecoder("utf-8").decode(bytes));
  }
}
