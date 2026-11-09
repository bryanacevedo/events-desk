import { readdirSync, readFileSync } from "node:fs";
import { migrate, pglite, type Db } from "../src/server/db.ts";

/** A throwaway real Postgres with every migration applied. */
export async function freshDb(): Promise<Db> {
  const db = await pglite();
  await migrate(db, readdirSync("migrations").filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(`migrations/${name}`, "utf8") })));
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
export async function finishTwoCard(db: Db, id: string, deps: Partial<Deps> = {}, uploader = "Maya Ortiz") {
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
  const id = (await createEvent(db, "Maya Ortiz", { name, starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100, flow })).id;
  const pending = async () => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
  await decideApproval(db, { approvalId: await pending(), actor: "Dan Whitlock", decision: "approve" });
  await ingestUpload(db, id, "Maya Ortiz", "a.csv", csv);
  if (flow === "two_card") { await finishTwoCard(db, id, deps); return id; }
  await requestCard(db, id, "Maya Ortiz");
  await decideApproval(db, { approvalId: await pending(), actor: "Maya Ortiz", decision: "approve" });
  await processEvent(db, id, { llm: mockLlm, vendorsFor: mockVendors, ...deps });
  return id;
}
