import { postgresJs } from "../src/server/db.ts";
import { readdirSync, readFileSync } from "node:fs";
import { migrate, pglite, type Db } from "../src/server/db.ts";

/** The migrated PGlite data directory that tests/pg-cleanup.ts builds once per run (a test's 5 s budget cannot also pay for a boot and 52 migrations). A file run on its own
    outside vitest's globalSetup has no path, and builds the same thing once for itself. */
let template: Promise<Blob> | undefined;
async function migratedTemplate(): Promise<Blob> {
  const file = process.env.EVENTS_DESK_PG_TEMPLATE;
  if (file) return new Blob([readFileSync(file)]);
  const db = await pglite();
  await migrate(db, readdirSync("migrations").filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(`migrations/${name}`, "utf8") })));
  const blob = await db.dump!();
  await db.close();
  return blob;
}

/** Every PGlite is a WebAssembly instance that keeps 200 to 500 MB of the process until it is closed, and 146 of the 151 test files never closed theirs (a beforeEach opens one per test).
    One file of 66 tests grew to 15 GB on the 16 GB CI runner, which then shut down (run 46017579500, 2026-11-27). tests/close-dbs.ts closes what a test opened, when the test ends. A
    database made outside a test (a beforeAll) is left to its file. */
const openInTest = new Set<Db>();
let inTest = false;
export function testStarts() { inTest = true; }
export async function testEnds() {
  inTest = false;
  const dbs = [...openInTest]; openInTest.clear();
  await Promise.all(dbs.map(async (d) => { try { await d.close(); } catch { /* closed by the test itself */ } }));
}

/** A throwaway database with every migration applied: PGlite from the template, or with TEST_ALL_ON_POSTGRES real Postgres, one schema per database. Used to find what PGlite hides. */
export async function freshDb(): Promise<Db> {
  const url = process.env.TEST_ALL_ON_POSTGRES;
  let db: Db;
  let schema = "";
  if (url) {
    schema = `t_${crypto.randomUUID().replace(/-/g, "")}`;
    const admin = await postgresJs(url, { max: 1 });
    await admin.exec(`CREATE SCHEMA ${schema}`);
    await admin.close();
    db = await postgresJs(url, { max: 3, schema });
    await migrate(db, readdirSync("migrations").filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(`migrations/${name}`, "utf8") })));
  } else db = await pglite(undefined, { loadDataDir: await (template ??= migratedTemplate()) });
  /* The Concierge role reaches public by default; a throwaway schema has to grant it. */
  if (schema) await db.exec(`GRANT USAGE ON SCHEMA ${schema} TO concierge_reader`);
  if (inTest) openInTest.add(db);
  return db;
}

import { decideApproval, requestCard } from "../src/server/approvals.ts";
import { answerCase, listCases } from "../src/server/cases.ts";
import { requestOutreachCard, requestResearchCard } from "../src/server/research.ts";
import { createEvent } from "../src/server/events.ts";
import { processEvent, type Deps } from "../src/server/pipeline.ts";
import { mockLlm, mockVendors } from "../src/server/providers.ts";
import { ingestUpload } from "../src/server/uploads.ts";

/** Everything after the upload, the way a person takes it in the two-card flow: the Research card (confirmed by the uploader), the run, the cases (the suggested answer each), the
    Outreach card (confirmed by the uploader), and the people steps, to delivered. Mocks unless told otherwise. */
export async function finishTwoCard(db: Db, id: string, deps: Partial<Deps> = {}, uploader = "Maya Okafor") {
  const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
  const d: Deps = { llm: mockLlm, vendorsFor: mockVendors, ...deps };
  await requestResearchCard(db, id, uploader);
  await decideApproval(db, { approvalId: await pending(), actor: uploader, decision: "approve" });
  await processEvent(db, id, d);
  for (const k of await listCases(db, id)) if (!k.decision) await answerCase(db, id, k.id, "Dan Whitlock", k.suggested ?? (k.options[0].value as string));
  await processEvent(db, id, d);
  await requestOutreachCard(db, id, uploader);
  await decideApproval(db, { approvalId: await pending(), actor: uploader, decision: "approve" });
  await processEvent(db, id, d);
}

/** A new event taken through approvals and the whole pipeline to delivered, on mocks unless told otherwise. Two-card by default, as new events are; `single_card` runs the older flow. */
export async function deliverEvent(db: Db, csv: string, deps: Partial<Deps> = {}, name = "T", flow: "two_card" | "single_card" = "two_card") {
  const id = (await createEvent(db, "Maya Okafor", { name, starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100, flow })).id;
  const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
  await decideApproval(db, { approvalId: await pending(), actor: "Dan Whitlock", decision: "approve" });
  await ingestUpload(db, id, "Maya Okafor", "a.csv", csv);
  if (flow === "two_card") { await finishTwoCard(db, id, deps); return id; }
  await requestCard(db, id, "Maya Okafor");
  await decideApproval(db, { approvalId: await pending(), actor: "Maya Okafor", decision: "approve" });
  await processEvent(db, id, { llm: mockLlm, vendorsFor: mockVendors, ...deps });
  return id;
}
