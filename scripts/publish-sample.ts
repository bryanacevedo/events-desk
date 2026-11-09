/* Publishes samples/events-desk-sample-workbook.xlsx as a Google Sheet.

     make publish-sample                      private to you, plus GOOGLE_SHARE_EMAILS as editors
     make publish-sample ARGS=--public-view   also view-only for anyone with the link (the sample is fictional)

   Uses the same Google variables as live delivery. Run again to refresh the same Sheet; the link does not change. */

import { googleSheetsClient, googleOptionsFromEnv } from "../src/server/sheets.ts";
import { publishSample } from "../src/server/publish-sample.ts";

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--public-view");
if (unknown.length) { console.error(`Unknown argument: ${unknown[0]}. The only option is --public-view.`); process.exit(1); }

let client;
try { client = googleSheetsClient(googleOptionsFromEnv(process.env as Record<string, string>)); }
catch (e) { console.error((e as Error).message); process.exit(1); }

try {
  const r = await publishSample(client, { publicView: args.includes("--public-view") });
  console.log(`${r.created ? "Created" : "Updated"} the sample Sheet (${r.view}):\n${r.url}`);
  console.log(r.note || `Google layer applied: ${r.polish.applied.join(", ")}`);
} catch (e) { console.error(`Could not publish the sample: ${(e as Error).message}`); process.exit(1); }
