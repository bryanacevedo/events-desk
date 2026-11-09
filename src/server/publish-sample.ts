/* Publishes the fictional sample workbook as a Google Sheet, for showing the product.

   This is the only code allowed to make a Sheet view-only for anyone with the link,
   and it can only ever be given the sample file: the path is fixed here, no caller
   passes bytes. Real event data goes through publishSheet, which has no such option.

   The sample's plan for the Google layer (sheets-polish.ts) is written beside the .xlsx by
   scripts/sample-workbook.ts; the same polish runs here as after a real delivery. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sheetUrl, type GoogleSheets } from "./sheets.ts";
import { polishWords, type SheetPlan } from "./sheets-polish.ts";

export const SAMPLE_TITLE = "Events Desk sample (fictional data)";
const SAMPLE_PATH = fileURLToPath(new URL("../../samples/events-desk-sample-workbook.xlsx", import.meta.url));
export const SAMPLE_PLAN_PATH = fileURLToPath(new URL("../../samples/events-desk-sample-plan.json", import.meta.url));

/** Creates the Sheet, or replaces the contents of the one made earlier so the link stays the same. */
export async function publishSample(g: GoogleSheets, opts: { publicView?: boolean } = {}) {
  const xlsx = new Uint8Array(readFileSync(SAMPLE_PATH));
  const plan = JSON.parse(readFileSync(SAMPLE_PLAN_PATH, "utf8")) as SheetPlan;
  const existing = await g.publisher.find(SAMPLE_TITLE);
  let id: string;
  if (existing) { id = existing.id; await g.publisher.update(id, xlsx); }
  else id = (await g.publisher.create(xlsx, SAMPLE_TITLE)).id;
  await g.publisher.share(id);
  if (opts.publicView) await g.publicView(id);
  const polish = await g.publisher.polish(id, plan);
  return { id, url: sheetUrl(id), created: !existing, view: opts.publicView ? "anyone with the link can view" : "private", polish, note: polishWords(polish) };
}
