/* Builds the sample workbook from the seeded, delivered large event (evt_meridian,
   Meridian Trade Expo, about 1,650 rows) on a throwaway PGlite, every vendor simulated.
   Writes samples/events-desk-sample-workbook.xlsx and, beside it, the plan for the
   Google layer (samples/events-desk-sample-plan.json) that publish-sample applies.

     node scripts/sample-workbook.ts [out.xlsx] */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { migrate, pglite } from "../src/server/db.ts";
import { seed } from "../src/server/seed.ts";
import { buildDelivery } from "../src/server/workbook.ts";

const out = process.argv[2] ?? "samples/events-desk-sample-workbook.xlsx";
const planOut = out.replace(/-workbook\.xlsx$|\.xlsx$/, "-plan.json");
const db = await pglite();
await migrate(db, readdirSync("migrations").filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(`migrations/${name}`, "utf8") })));
await seed(db, { large: "delivered" });
const t = Date.now();
const { xlsx, plan } = await buildDelivery(db, "evt_meridian");
writeFileSync(out, xlsx);
writeFileSync(planOut, JSON.stringify(plan, null, 1) + "\n");
console.log(`Built in ${Date.now() - t} ms, ${(xlsx.length / 1024).toFixed(0)} KB`);
console.log(`Wrote ${out} and ${planOut}`);
await db.close();
