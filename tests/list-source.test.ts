/* Where a list came from (docs/EVENT-PLAN.md 4.3): on the upload, every source row and every attendee contact. Recorded and shown; the gate does not read it. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { decideApproval } from "../src/server/approvals.ts";
import { answerCase, listCases } from "../src/server/cases.ts";
import type { Db } from "../src/server/db.ts";
import { createEvent } from "../src/server/events.ts";
import { processEvent, type Deps } from "../src/server/pipeline.ts";
import { mockLlm, mockVendors } from "../src/server/providers.ts";
import { requestOutreachCard, requestResearchCard } from "../src/server/research.ts";
import { createTopUp } from "../src/server/top-up.ts";
import { ingestUpload, listSummary } from "../src/server/uploads.ts";
import { LIST_SOURCES, LIST_SOURCE_WORDS } from "../src/shared/plan.ts";
import { finishTwoCard, freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock";
const LIST = [
  "Company,Name,Title,Email,LinkedIn,Website",
  "Larkspur Freight Software,Ada Moss,VP Sales,ada@larkspur.example,,",
  "Pinefold Payments Software,Cy Ruiz,Head of Growth,cy@pinefold.example,,",
  "Brightwater Software,Eli Stone,VP Marketing,eli@brightwater.example,,",
].join("\n") + "\n";
const LATE = LIST + "Larkspur Freight Software,New Person,Director of Sales,new@larkspur.example,,\n";
const deps = (): Deps => ({ llm: mockLlm, vendorsFor: mockVendors });

let db: Db;
beforeEach(async () => { db = await freshDb(); });

async function approvedEvent() {
  const id = (await createEvent(db, MAYA, { name: "T", starts_on: "2027-01-01", seat_count: 2, seat_price_cents: 100 })).id;
  const [a] = await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]);
  await decideApproval(db, { approvalId: a.id, actor: DAN, decision: "approve" });
  return id;
}
const sources = (id: string) => db.query<{ t: string; s: string | null; n: number }>(
  `SELECT 'upload' AS t, list_source AS s, count(*)::int AS n FROM uploads WHERE event_id = $1 GROUP BY 2
   UNION ALL SELECT 'rows', list_source, count(*)::int FROM source_rows WHERE event_id = $1 GROUP BY 2
   UNION ALL SELECT 'contacts', list_source, count(*)::int FROM contacts WHERE event_id = $1 AND source = 'attendee' GROUP BY 2 ORDER BY 1, 2`, [id]);

describe("the source on every uploaded row", () => {
  it.each(LIST_SOURCES)("an upload from %s puts it on the upload, every source row and every attendee contact", async (kind) => {
    const id = await approvedEvent();
    await ingestUpload(db, id, MAYA, "a.csv", LIST, { kind, note: kind === "other" ? "A USB stick from the booth" : "" });
    const rows = await sources(id);
    expect(rows.map((r) => r.s)).toEqual([kind, kind, kind]);
    expect(rows.find((r) => r.t === "rows")!.n).toBe(3);
    expect(rows.find((r) => r.t === "contacts")!.n).toBe(3);
    const summary = await listSummary(db, id);
    expect(summary.upload).toMatchObject({ list_source: kind, source_note: kind === "other" ? "A USB stick from the booth" : "" });
    expect(LIST_SOURCE_WORDS[kind]).toBeTruthy();
  });

  it("a list emailed by the organizer runs to delivered on today's engine with the source on every person", async () => {
    const id = await approvedEvent();
    await ingestUpload(db, id, MAYA, "a.csv", LIST, { kind: "emailed_by_organizer", note: "" });
    await finishTwoCard(db, id, deps());
    expect((await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage).toBe("delivered");
    const bad = await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND source = 'attendee' AND list_source IS DISTINCT FROM 'emailed_by_organizer'", [id]);
    expect(bad).toEqual([]);
    // Prospects found by the engine came from no list.
    expect(await db.query("SELECT 1 FROM contacts WHERE event_id = $1 AND source <> 'attendee' AND list_source IS NOT NULL", [id])).toEqual([]);
  });

  it("no source means other, and the old caller keeps working", async () => {
    const id = await approvedEvent();
    await ingestUpload(db, id, MAYA, "a.csv", LIST);
    expect((await sources(id)).map((r) => r.s)).toEqual(["other", "other", "other"]);
  });

  it("the route reads x-list-source, treats none as other, and refuses a bad value; the database refuses it too", async () => {
    const app = createApp(db, { demo: true });
    const post = (id: string, h: Record<string, string>) => app.request(`/api/events/${id}/upload`, { method: "POST", body: LIST, headers: { "x-actor": MAYA, "x-filename": "a.csv", ...h } });
    const bad = await approvedEvent();
    const r = await post(bad, { "x-list-source": "dropbox" });
    expect(r.status).toBe(400);
    expect(await db.query("SELECT 1 FROM uploads WHERE event_id = $1", [bad])).toEqual([]);
    const good = await approvedEvent();
    expect((await post(good, { "x-list-source": "sponsor_export", "x-source-note": encodeURIComponent("From the sponsor portal") })).status).toBe(200);
    expect(await listSummary(db, good)).toMatchObject({ upload: { list_source: "sponsor_export", source_note: "From the sponsor portal" } });
    const plain = await approvedEvent();
    expect((await post(plain, {})).status).toBe(200);
    expect((await listSummary(db, plain)).upload!.list_source).toBe("other");
    await expect(db.query("UPDATE uploads SET list_source = 'dropbox' WHERE event_id = $1", [good])).rejects.toThrow();
    await expect(db.query("UPDATE contacts SET list_source = 'dropbox' WHERE event_id = $1", [good])).rejects.toThrow();
  });

  it("the Plan read gives the list source in words' keys", async () => {
    const id = await approvedEvent();
    await ingestUpload(db, id, MAYA, "a.csv", LIST, { kind: "app_download", note: "" });
    const app = createApp(db, { demo: true });
    const plan = await (await app.request(`/api/events/${id}/plan`, { headers: { "x-actor": MAYA } })).json() as { list_source: { list_source: string } };
    expect(plan.list_source.list_source).toBe("app_download");
  });

  it("a top-up keeps its own source after the merge, and the parent's rows keep theirs", async () => {
    const id = await approvedEvent();
    await ingestUpload(db, id, MAYA, "a.csv", LIST, { kind: "web_app_download", note: "" });
    await finishTwoCard(db, id, deps());
    const out = await createTopUp(db, id, MAYA, "late.csv", LATE, { kind: "emailed_by_organizer", note: "" });
    expect(out.new_rows).toBe(1);
    const t = out.top_up_id!;
    await requestResearchCard(db, t, MAYA);
    const ap = async () => decideApproval(db, { approvalId: (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [t]))[0].id, actor: MAYA, decision: "approve" });
    await ap();
    await processEvent(db, t, deps());
    for (const k of await listCases(db, t)) if (!k.decision) await answerCase(db, t, k.id, DAN, k.suggested ?? (k.options[0].value as string));
    await processEvent(db, t, deps());
    await requestOutreachCard(db, t, MAYA);
    await ap();
    await processEvent(db, t, deps());
    const merged = await db.query<{ full_name: string; list_source: string }>("SELECT full_name, list_source FROM contacts WHERE event_id = $1 AND source = 'attendee' ORDER BY full_name", [id]);
    expect(merged.find((c) => c.full_name === "New Person")?.list_source).toBe("emailed_by_organizer");
    expect(merged.filter((c) => c.full_name !== "New Person").every((c) => c.list_source === "web_app_download")).toBe(true);
    const ups = await db.query<{ list_source: string }>("SELECT list_source FROM uploads WHERE event_id = $1 ORDER BY created_at, id", [id]);
    expect(ups.map((u) => u.list_source)).toEqual(["web_app_download", "emailed_by_organizer"]);
  });

  it("a top-up with no source is other", async () => {
    const id = await approvedEvent();
    await ingestUpload(db, id, MAYA, "a.csv", LIST, { kind: "web_app_download", note: "" });
    await finishTwoCard(db, id, deps());
    const out = await createTopUp(db, id, MAYA, "late.csv", LATE);
    expect((await db.query<{ list_source: string }>("SELECT list_source FROM source_rows WHERE event_id = $1", [out.top_up_id]))[0].list_source).toBe("other");
  });
});
