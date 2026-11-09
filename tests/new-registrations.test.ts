/* docs/NEW-REGISTRATIONS.md, sections 2, 4 and 4a. All vendors and models are the mocks: nothing here makes a real call. */

import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.ts";
import { budgetView } from "../src/server/budget.ts";
import { answerCase, listCases, openCase } from "../src/server/cases.ts";
import type { Db } from "../src/server/db.ts";
import { decideApproval } from "../src/server/approvals.ts";
import { deleteEvent } from "../src/server/delete-event.ts";
import { moveEvent, RuleError } from "../src/server/events.ts";
import { outcomeOf } from "../src/server/inherit.ts";
import { overview } from "../src/server/overview.ts";
import { processEvent, type Deps } from "../src/server/pipeline.ts";
import { mockCrm, mockLlm, mockVendors, type Crm, type Llm } from "../src/server/providers.ts";
import { requestOutreachCard, requestResearchCard } from "../src/server/research.ts";
import { seedIcp } from "../src/server/seed.ts";
import { publishSheet, refreshSheet } from "../src/server/sheet-delivery.ts";
import type { SheetPublisher } from "../src/server/sheets.ts";
import { fuzzyListCases } from "../src/server/research.ts";
import { afterMerge, createTopUp, endTopUp, fileEmails, mergeTopUp, retryMerges } from "../src/server/top-up.ts";
import { retier, spreadFor } from "../src/server/tiering.ts";
import { listSummary } from "../src/server/uploads.ts";
import { usageView } from "../src/server/usage.ts";
import { buildWorkbook, load, withStored } from "../src/server/workbook.ts";
import { buildPacket, packetHash } from "../src/server/perspective-model.ts";
import { OLD_SHEET_ERROR } from "../src/shared/domain.ts";
import { defaultSettings, patchSettings } from "../src/server/approvals.ts";
import { deliverEvent, freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock";
const PARENT = [
  "Company,Name,Title,Email,LinkedIn,Website",
  "Larkspur Freight Software,Ada Moss,VP Sales,ada@larkspur.example,,",
  "Larkspur Freight Software,Bo Hill,Director of Sales,bo@larkspur.example,,",
  "Pinefold Payments Software,Cy Ruiz,Head of Growth,cy@pinefold.example,https://www.linkedin.com/in/cy-ruiz,",
  "Pinefold Payments Software,Di Park,Chief Revenue Officer,,,",
  "Brightwater Software,Eli Stone,VP Marketing,eli@brightwater.example,,",
].join("\n") + "\n";
const HEAD = "Company,Name,Title,Email,LinkedIn,Website\n";

let db: Db;
const deps = (extra: Partial<Deps> = {}): Deps => ({ llm: mockLlm, vendorsFor: mockVendors, ...extra });
const pending = async (id: string) => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
const approve = async (id: string, who = MAYA) => decideApproval(db, { approvalId: await pending(id), actor: who, decision: "approve" });
const parentOf = () => deliverEvent(db, PARENT);
const up = (parent: string, csv: string, who = MAYA) => createTopUp(db, parent, who, "late.csv", csv);
const hdr = (a: string) => ({ "x-actor": encodeURIComponent(a) });

/** Every row the parent owns, in full, so any change at all shows. */
async function snapshot(id: string) {
  const out: Record<string, unknown> = {};
  out.event = await db.query("SELECT * FROM events WHERE id = $1", [id]);
  for (const t of ["contacts", "companies", "source_rows", "uploads", "review_cases", "title_tiers", "cost_cards", "credit_ledger", "approvals", "event_settings", "jobs"])
    out[t] = await db.query(`SELECT * FROM ${t} WHERE event_id = $1 ORDER BY 1, 2`, [id]);
  return JSON.parse(JSON.stringify(out)) as Record<string, Record<string, unknown>[]>;
}
/** The rows that existed before are exactly as they were; rows may only have been added. */
function unchanged(before: Record<string, Record<string, unknown>[]>, after: Record<string, Record<string, unknown>[]>, ignore: Record<string, string[]> = {}) {
  for (const t of Object.keys(before)) {
    const key = t === "title_tiers" ? "title_key" : t === "event_settings" ? "event_id" : "id";
    const was = new Map(before[t].map((r) => [r[key], r]));
    for (const r of after[t]) {
      const old = was.get(r[key]);
      if (!old) continue;
      const strip = (x: Record<string, unknown>) => { const c = { ...x }; for (const f of ignore[t] ?? []) delete c[f]; return c; };
      expect(strip(r), `${t} ${String(r[key])}`).toEqual(strip(old));
    }
    expect(after[t].length, t).toBeGreaterThanOrEqual(before[t].length);
  }
}

/** Takes a top-up through Research and the cases and Outreach, stopping before the people steps run if told. */
async function runTopUp(id: string, opts: { until?: "researched" | "outreach"; d?: Deps; who?: string } = {}) {
  const d = opts.d ?? deps(), who = opts.who ?? MAYA;
  await requestResearchCard(db, id, who);
  await approve(id, who);
  await processEvent(db, id, d);
  for (const k of await listCases(db, id)) if (!k.decision) await answerCase(db, id, k.id, DAN, k.suggested ?? (k.options[0].value as string));
  await processEvent(db, id, d);
  if (opts.until === "researched") return;
  await requestOutreachCard(db, id, who);
  await approve(id, who);
  if (opts.until === "outreach") return;
  await processEvent(db, id, d);
}

const stageOf = async (id: string) => (await db.query<{ stage: string; merged_at: string | null; ended_at: string | null }>("SELECT stage, merged_at, ended_at FROM events WHERE id = $1", [id]))[0];

beforeEach(async () => { db = await freshDb(); });

/* ------------------------------------------------------------ already in */

describe("who is already in", () => {
  it("counts a file's new rows apart from what the parent has and what upload dropped", async () => {
    const p = await parentOf();
    const out = await up(p, PARENT + "Larkspur Freight Software,New Person,VP Sales,new@larkspur.example,,\n,Name Only,VP Sales,,,\n");
    expect(out).toMatchObject({ file_rows: 7, already_in: 5, new_rows: 1, dropped: 1 });
    const [u] = await db.query<{ row_count: number; file_rows: number; already_in: number }>("SELECT row_count, file_rows, already_in FROM uploads WHERE event_id = $1", [out.top_up_id]);
    expect(u).toEqual({ row_count: 1, file_rows: 7, already_in: 5 });
    expect(await db.query("SELECT 1 FROM contacts WHERE event_id = $1", [out.top_up_id])).toHaveLength(1);
  });

  const one = async (p: string, row: string) => (await up(p, HEAD + row + "\n")).new_rows;

  it("an email, any case", async () => { expect(await one(await parentOf(), "Somewhere,Other Name,VP,ADA@larkspur.example,,")).toBe(0); });
  it("the same name at the company counts when the parent has no email, whatever address the new row gives", async () => {
    expect(await one(await parentOf(), "Pinefold Payments Software,Di Park,CRO,di.new@pinefold.example,,")).toBe(0);
  });
  it("the same name at the company counts when the new row has no email", async () => {
    expect(await one(await parentOf(), "Larkspur Freight Software,Ada Moss,VP Sales,,,")).toBe(0);
  });
  it("two emails under one name are two people, as at upload", async () => {
    expect(await one(await parentOf(), "Larkspur Freight Software,Ada Moss,VP Sales,ada.moss2@larkspur.example,,")).toBe(1);
  });
  it("LinkedIn is read only for a row with no email", async () => {
    const p = await parentOf();
    expect((await up(p, HEAD + "Other Co,Someone Else,VP,different@other.example,https://www.linkedin.com/in/cy-ruiz,\n")).new_rows).toBe(1);
    await db.query("UPDATE events SET ended_at = now() WHERE parent_event_id = $1", [p]);
    expect((await up(p, HEAD + "Other Co,Someone Else,VP,,https://www.linkedin.com/in/cy-ruiz,\n")).new_rows).toBe(0);
  });
  it("the file's address counts after a vendor has overwritten the contact", async () => {
    const p = await parentOf();
    await db.query("UPDATE contacts SET email = 'vendor@larkspur.example' WHERE event_id = $1 AND full_name = 'Bo Hill'", [p]);
    expect(await one(p, "Elsewhere,Totally Different,VP,bo@larkspur.example,,")).toBe(0);
  });
  it("a vendor's address counts, and a different one on the same name and company is the same person when the file had none", async () => {
    const p = await parentOf();
    await db.query("UPDATE contacts SET email = 'found@pinefold.example' WHERE event_id = $1 AND full_name = 'Di Park'", [p]);
    expect(await one(p, "Elsewhere,Totally Different,VP,found@pinefold.example,,")).toBe(0);
    await db.query("UPDATE events SET ended_at = now() WHERE parent_event_id = $1", [p]);
    expect(await one(p, "Pinefold Payments Software,Di Park,CRO,personal@pinefold.example,,")).toBe(0);
  });
  it("a dropped person and an opted-out person stay out", async () => {
    const p = await parentOf();
    await db.query("UPDATE contacts SET drop_reason = 'rejected_in_review', dropped_at = now() WHERE event_id = $1 AND full_name = 'Ada Moss'", [p]);
    await db.query("UPDATE contacts SET drop_reason = 'opted_out', dropped_at = now() WHERE event_id = $1 AND full_name = 'Eli Stone'", [p]);
    expect((await up(p, HEAD + "Larkspur Freight Software,Ada Moss,VP Sales,ada@larkspur.example,,\nBrightwater Software,Eli Stone,VP Marketing,eli@brightwater.example,,\n")).new_rows).toBe(0);
  });
  it("a parent prospect who later registers is already in", async () => {
    const p = await parentOf();
    const [row] = await db.query<{ id: string; company_id: string }>("SELECT id, company_id FROM source_rows WHERE event_id = $1 AND kind = 'person' LIMIT 1", [p]);
    await db.query("INSERT INTO contacts (id, event_id, source_row_id, company_id, full_name, title, email, source) VALUES ('con_pr', $1, $2, $3, 'Gia Prospect', 'VP Sales', 'gia@larkspur.example', 'prospect')", [p, row.id, row.company_id]);
    const [co] = await db.query<{ name: string }>("SELECT name FROM companies WHERE id = $1", [row.company_id]);
    expect(await one(p, `${co.name},Gia Prospect,VP Sales,gia.registered@larkspur.example,,`)).toBe(0);
  });
  it("a company-only row is already in if its company matches", async () => {
    const p = await parentOf();
    expect((await up(p, "Company\nLarkspur Freight Software\nNever Seen Co\n")).new_rows).toBe(1);
  });
  it("an all-duplicate file leaves no top-up and keeps no file; a junk-only file is never new", async () => {
    const p = await parentOf();
    const out = await up(p, PARENT);
    expect(out).toMatchObject({ new_rows: 0, already_in: 5, top_up_id: null });
    expect(await db.query("SELECT 1 FROM events WHERE parent_event_id = $1", [p])).toHaveLength(0);
    expect(await db.query("SELECT 1 FROM upload_files WHERE event_id = $1", [p])).toHaveLength(1);
    const junk = await up(p, "Company,Name,Email\n,Only A Name,\nN/A,,\n");
    expect(junk).toMatchObject({ new_rows: 0, already_in: 0, top_up_id: null });
    expect(junk.dropped).toBeGreaterThan(0);
  });
  it("reads a file with different columns", async () => {
    const p = await parentOf();
    const out = await up(p, "Attendee,Organization,Role,Mail\nNew Face,Fresh Co Software,VP Sales,face@fresh.example\nAda Moss,Larkspur Freight Software,VP,ada@larkspur.example\n");
    expect(out).toMatchObject({ new_rows: 1, already_in: 1 });
  });
  it("ignores an address in a column the upload did not use, and a shared mailbox", () => {
    expect(fileEmails({ Email: "a@x.example", Notes: "ask b@x.example" }, ["Notes"], [])).toEqual(["a@x.example"]);
    expect(fileEmails({ Email: "team@x.example" }, [], ["shared_email"])).toEqual([]);
  });
});

/* ---------------------------------------------------------------- creating */

describe("creating a top-up", () => {
  it("is a hidden two-card event at mapped, with its uploader, no seats, and the parent's settings and pin", async () => {
    await seedIcp(db);
    const p = await deliverEvent(db, PARENT);
    await db.query("UPDATE events SET icp_version = 1 WHERE id = $1", [p]);
    const { top_up_id } = await up(p, HEAD + "New Co Software,Ivy New,VP Sales,ivy@newco.example,,\n", "Priya Nair");
    const [t] = await db.query<Record<string, unknown>>("SELECT stage, seat_count, requested_by, flow, parent_event_id, icp_version, catalog_id FROM events WHERE id = $1", [top_up_id]);
    expect(t).toEqual({ stage: "mapped", seat_count: 0, requested_by: "Priya Nair", flow: "two_card", parent_event_id: p, icp_version: 1, catalog_id: null });
    const [a] = await db.query<{ settings: unknown }>("SELECT settings FROM event_settings WHERE event_id = $1", [top_up_id]);
    const [b] = await db.query<{ settings: unknown }>("SELECT settings FROM event_settings WHERE event_id = $1", [p]);
    expect(a.settings).toEqual(b.settings);
  });

  it("only at delivered, and one open at a time", async () => {
    const p = await parentOf();
    await up(p, HEAD + "New Co,Ivy New,VP Sales,ivy@newco.example,,\n");
    await expect(up(p, HEAD + "New Co,Other New,VP Sales,other@newco.example,,\n")).rejects.toThrow(/already running/);
    const other = (await db.query<{ id: string }>("INSERT INTO events (id, name, starts_on, seat_count, seat_price_cents, requested_by, stage) VALUES ('evt_x', 'X', '2027-01-01', 1, 1, 'M', 'mapped') RETURNING id"))[0].id;
    await expect(up(other, HEAD + "New Co,Ivy New,VP,i@n.example,,\n")).rejects.toThrow(/delivered/);
  });

  it("a parent with no ICP gets no pin on its top-up, even after one is published", async () => {
    const p = await parentOf();
    await seedIcp(db);
    const { top_up_id } = await up(p, HEAD + "New Co Software,Ivy New,VP Sales,ivy@newco.example,,\n");
    await requestResearchCard(db, top_up_id!, MAYA);
    await approve(top_up_id!);
    expect((await db.query<{ icp_version: number | null }>("SELECT icp_version FROM events WHERE id = $1", [top_up_id]))[0].icp_version).toBeNull();
  });

  it("a merged spelling attaches to the parent company, and so does a matching domain", async () => {
    const p = await parentOf();
    const [co] = await db.query<{ id: string; primary_domain: string }>("SELECT id, primary_domain FROM companies WHERE event_id = $1 AND key LIKE 'larkspur%'", [p]);
    await db.query("UPDATE companies SET merged_names = $2::jsonb WHERE id = $1", [co.id, JSON.stringify([{ name: "Larkspur Fr8", key: "larkspur fr8", rows: 1 }])]);
    const { top_up_id } = await up(p, HEAD + `Larkspur Fr8,Ivy New,VP Sales,ivy@larkspur.example,,\nLark Holdings,Jo Next,VP Sales,jo@lark.example,,${co.primary_domain}\n`);
    const rows = await db.query<{ inherited_from: string; merged_names: { key: string }[] }>("SELECT inherited_from, merged_names FROM companies WHERE event_id = $1", [top_up_id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].inherited_from).toBe(co.id);
    expect(rows[0].merged_names.map((m) => m.key)).toContain("lark holdings");
  });
});

/* --------------------------------------------------------- what is paid for */

describe("a top-up spends only for its new rows and new companies", () => {
  const NEW = HEAD + "Larkspur Freight Software,Ivy New,VP Sales,ivy@larkspur.example,,\nFresh Payments Software,Jo Fresh,VP Sales,jo@freshpay.example,,\n";

  it("quotes, queues and charges only them, and the parent is unchanged by the run and by the merge", async () => {
    const p = await parentOf();
    const before = await snapshot(p);
    const { top_up_id: t } = await up(p, PARENT + NEW.split("\n").slice(1).join("\n"));
    await requestResearchCard(db, t!, MAYA);
    const [card] = await db.query<{ lines: Record<string, number> }>("SELECT lines FROM cost_cards WHERE event_id = $1 AND kind = 'research'", [t]);
    expect(card.lines.companies).toBe(1);
    await approve(t!);
    await processEvent(db, t!, deps());
    expect(await db.query("SELECT 1 FROM jobs WHERE event_id = $1 AND kind IN ('identity', 'company_tier') AND payload->>'company_id' IN (SELECT id FROM companies WHERE inherited_from IS NOT NULL)", [t])).toHaveLength(0);
    unchanged(before, await snapshot(p));
    for (const k of await listCases(db, t!)) if (!k.decision) await answerCase(db, t!, k.id, DAN, k.suggested ?? (k.options[0].value as string));
    await processEvent(db, t!, deps());
    await requestOutreachCard(db, t!, MAYA);
    const [out] = await db.query<{ lines: Record<string, number>; step_caps: Record<string, { llm?: number }> }>("SELECT lines, step_caps FROM cost_cards WHERE event_id = $1 AND kind = 'outreach'", [t]);
    expect(out.lines.attendees_ab).toBe(2);
    expect(out.lines.discovered_people).toBe(0);
    expect(out.step_caps.perspective.llm).toBe(0);
    await approve(t!);
    await processEvent(db, t!, deps());
    expect((await stageOf(t!)).merged_at).not.toBeNull();
    // Rows the parent had are exactly as they were; only the two new people were added.
    unchanged(before, await snapshot(p));
    const kept = await db.query<{ full_name: string }>("SELECT full_name FROM contacts WHERE event_id = $1 AND source = 'attendee'", [p]);
    expect(kept.filter((k) => ["Ivy New", "Jo Fresh"].includes(k.full_name))).toHaveLength(2);
    // Only the new people's calls hit the ledger.
    const parentSpend = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM credit_ledger WHERE event_id = $1", [p]))[0].n;
    expect(parentSpend).toBe(before.credit_ledger.length);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM credit_ledger WHERE event_id = $1", [t]))[0].n).toBeGreaterThan(0);
  });

  it("a top-up with nothing to research goes through a zero card", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, HEAD + "Larkspur Freight Software,Ivy New,VP Sales,ivy@larkspur.example,,\n");
    await requestResearchCard(db, t!, MAYA);
    const [c] = await db.query<{ credits_cap: number; llm_cap: number }>("SELECT credits_cap, llm_cap FROM cost_cards WHERE event_id = $1", [t]);
    expect(c).toEqual({ credits_cap: 0, llm_cap: 0 });
    await approve(t!);
    await processEvent(db, t!, deps());
    expect((await stageOf(t!)).stage).toBe("ready_for_review");
  });

  it("a person with no company still gets a paid reverse lookup, on the card", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, "Name,Email\nNo Company,nocompany@somewhere.example\n");
    await requestResearchCard(db, t!, MAYA);
    const [c] = await db.query<{ lines: { reverse_lookup_rows: number } }>("SELECT lines FROM cost_cards WHERE event_id = $1", [t]);
    expect(c.lines.reverse_lookup_rows).toBe(1);
  });

  it("copied title tiers mean known titles are not paid for and new ones are read", async () => {
    await seedIcp(db);
    const p = await parentOf();
    await db.query("UPDATE events SET icp_version = 1 WHERE id = $1", [p]);
    await db.query("INSERT INTO title_tiers (event_id, title_key, tier, reason, source, func, seniority, non_buyer) VALUES ($1, 'wizard of revenue', 1, 'model_parse', 'llm', 'sales', 'vp', false) ON CONFLICT DO NOTHING", [p]);
    const { top_up_id: t } = await up(p, HEAD + "Larkspur Freight Software,Ivy New,Wizard of Revenue,ivy@larkspur.example,,\nLarkspur Freight Software,Tess Newer,VP Sales,tess@larkspur.example,,\n");
    await runTopUp(t!, { until: "outreach" });
    await processEvent(db, t!, deps());
    expect(await db.query("SELECT 1 FROM credit_ledger WHERE event_id = $1 AND step IN ('title_tier', 'title_parse')", [t])).toHaveLength(0);
    expect((await db.query<{ titles_read: boolean }>("SELECT titles_read FROM events WHERE id = $1", [t]))[0].titles_read).toBe(true);
  });
});

describe("what an inherited company means", () => {
  it("usable, list, rejected, Title 3 and single-card outcomes", () => {
    const co = { tier: 1, in_research: true, list_status: null, primary_domain: "a.example" };
    expect(outcomeOf(co, [])).toEqual({ kind: "usable" });
    expect(outcomeOf({ ...co, list_status: "excluded" }, [])).toEqual({ kind: "drop", reason: "excluded_company" });
    expect(outcomeOf({ ...co, in_research: false }, ["rejected_in_review"])).toEqual({ kind: "drop", reason: "rejected_in_review" });
    expect(outcomeOf({ ...co, tier: null, in_research: false }, ["low_tier"])).toEqual({ kind: "assess" });
    expect(outcomeOf({ ...co, tier: null, in_research: true }, ["low_tier"])).toEqual({ kind: "assess" });
    expect(outcomeOf({ ...co, tier: null, in_research: false }, ["tiering_failed"])).toEqual({ kind: "drop", reason: "tiering_failed" });
    expect(outcomeOf({ ...co, primary_domain: null }, [])).toEqual({ kind: "assess" });
  });

  it("a company a person rejected drops new people there, with no spend, and the parent's row stays", async () => {
    const p = await parentOf();
    await db.query("UPDATE companies SET in_research = false WHERE event_id = $1 AND key LIKE 'larkspur%'", [p]);
    await db.query("UPDATE contacts SET drop_reason = 'rejected_in_review', dropped_at = now() WHERE event_id = $1 AND full_name IN ('Ada Moss', 'Bo Hill')", [p]);
    const before = await snapshot(p);
    const { top_up_id: t } = await up(p, HEAD + "Larkspur Freight Software,Ivy New,VP Sales,ivy@larkspur.example,,\n");
    await requestResearchCard(db, t!, MAYA);
    const [c] = await db.query<{ drop_reason: string }>("SELECT drop_reason FROM contacts WHERE event_id = $1", [t]);
    expect(c.drop_reason).toBe("rejected_in_review");
    unchanged(before, await snapshot(p));
  });

  it("a company skipped only for Title 3 attendees is assessed for the first time, and the merge gives the parent's row its first tier", async () => {
    const p = await deliverEvent(db, "Company,Name,Title,Email\nFoo Software,Zed Clerk,Receptionist,zed@foosoftware.example\nBar Software,Ann Lead,VP Sales,ann@barsoftware.example\n");
    await db.query("UPDATE companies SET tier = NULL, in_research = false WHERE event_id = $1 AND key = 'foo software'", [p]);
    await db.query("UPDATE contacts SET drop_reason = 'low_tier', dropped_at = now() WHERE event_id = $1 AND full_name = 'Zed Clerk'", [p]);
    const { top_up_id: t } = await up(p, "Company,Name,Title,Email\nFoo Software,Ivy New,VP Sales,ivy@foosoftware.example\n");
    expect((await db.query<{ inherited_from: string | null }>("SELECT inherited_from FROM companies WHERE event_id = $1", [t]))[0].inherited_from).toBeNull();
    await runTopUp(t!);
    const [co] = await db.query<{ tier: number | null; in_research: boolean }>("SELECT tier, in_research FROM companies WHERE event_id = $1 AND key = 'foo software'", [p]);
    expect(co.tier).not.toBeNull();
    expect(co.in_research).toBe(true);
    expect(await db.query("SELECT 1 FROM companies WHERE event_id = $1", [t])).toHaveLength(0);
  });

  it("a company whose confirmed domain the parent has becomes an inherited copy before anything further is paid", async () => {
    const p = await parentOf();
    const [co] = await db.query<{ id: string; primary_domain: string }>("SELECT id, primary_domain FROM companies WHERE event_id = $1 AND key LIKE 'larkspur%'", [p]);
    const { top_up_id: t } = await up(p, HEAD + "Different Trading Name,Ivy New,VP Sales,ivy@different.example,,\n");
    await requestResearchCard(db, t!, MAYA);
    await approve(t!);
    await db.query("UPDATE companies SET primary_domain = $2, identity_state = 'resolved' WHERE event_id = $1", [t, co.primary_domain]);
    await db.query("UPDATE jobs SET status = 'done' WHERE event_id = $1", [t]);
    await db.query("UPDATE events SET research_started = true, phase = 'identity' WHERE id = $1", [t]);
    await processEvent(db, t!, deps());
    const rows = await db.query<{ inherited_from: string; merged_names: { key: string }[] }>("SELECT inherited_from, merged_names FROM companies WHERE event_id = $1", [t]);
    expect(rows).toHaveLength(1);
    expect(rows[0].inherited_from).toBe(co.id);
    expect(rows[0].merged_names.map((m) => m.key)).toContain("different trading name");
    expect(await db.query("SELECT 1 FROM jobs WHERE event_id = $1 AND kind = 'company_tier'", [t])).toHaveLength(0);
  });

  it("the list gate reads the parent's status as it stands now", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, HEAD + "Larkspur Freight Software,Ivy New,VP Sales,ivy@larkspur.example,,\n");
    await db.query("UPDATE companies SET list_status = 'existing_customer' WHERE event_id = $1 AND key LIKE 'larkspur%'", [p]);
    await requestResearchCard(db, t!, MAYA);
    expect((await db.query<{ drop_reason: string }>("SELECT drop_reason FROM contacts WHERE event_id = $1", [t]))[0].drop_reason).toBe("existing_customer");
  });

  it("inherited rows are skipped by the fuzzy list check, the spread and a re-tier", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, HEAD + "Larkspur Freight Software,Ivy New,VP Sales,ivy@larkspur.example,,\n");
    const s = { ...defaultSettings(), excluded_companies: ["Larkspur Freight Softwares"] };
    expect(await fuzzyListCases(db, t!, s)).toBe(0);
    const spread = await spreadFor(db.query, t!, s);
    expect(spread.counts.total).toBe(0);
    await db.query("UPDATE events SET stage = 'ready_for_review' WHERE id = $1", [t]);
    await db.query("INSERT INTO cost_cards (id, event_id, kind, inputs, rates, lines, credits_cap, llm_cap, est_cents, status) VALUES ('card_x', $1, 'research', '{}', '{}', '{\"retier_companies\": 5}', 0, 0, 0, 'approved')", [t]);
    expect((await retier(db, t!, MAYA, { scope: "all" })).requeued).toBe(0);
  });
});

/* -------------------------------------------------------------------- ending */

describe("ending a top-up", () => {
  const NEW = HEAD + "Fresh Payments Software,Jo Fresh,VP Sales,jo@freshpay.example,,\n";
  const STAGES: [string, (t: string) => Promise<void>][] = [
    ["mapped", async () => undefined],
    ["quoted", async (t) => { await requestResearchCard(db, t, MAYA); }],
    ["researching", async (t) => { await requestResearchCard(db, t, MAYA); await approve(t); }],
    ["ready_for_review", async (t) => { await runTopUp(t, { until: "researched" }); }],
    ["finding_people", async (t) => { await runTopUp(t, { until: "outreach" }); }],
    ["paused", async (t) => { await runTopUp(t, { until: "outreach" }); await moveEvent(db, t, "paused", MAYA); }],
    ["flagging", async (t) => { await runTopUp(t, { until: "outreach" }); await moveEvent(db, t, "flagging", MAYA); }],
  ];
  it.each(STAGES)("from %s: ended, jobs cancelled, nothing runs after, parent untouched", async (name, reach) => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, NEW);
    await reach(t!);
    expect((await stageOf(t!)).stage).toBe(name);
    const before = await snapshot(p);
    const spent = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM credit_ledger WHERE event_id = $1", [t]))[0].n;
    await endTopUp(db, t!, MAYA, "Discarded");
    expect((await stageOf(t!)).ended_at).not.toBeNull();
    expect(await db.query("SELECT 1 FROM jobs WHERE event_id = $1 AND status IN ('queued', 'running')", [t])).toHaveLength(0);
    expect(await db.query("SELECT 1 FROM approvals WHERE event_id = $1 AND status = 'pending'", [t])).toHaveLength(0);
    await processEvent(db, t!, deps());
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM credit_ledger WHERE event_id = $1", [t]))[0].n).toBe(spent);
    expect((await stageOf(t!)).stage).toBe(name);
    expect(await snapshot(p)).toEqual(before);
    await expect(moveEvent(db, t!, "delivered", MAYA)).rejects.toThrow(RuleError);
  });

  it("declining the Research card ends it and leaves the parent untouched", async () => {
    const p = await parentOf();
    const before = await snapshot(p);
    const { top_up_id: t } = await up(p, NEW);
    await requestResearchCard(db, t!, MAYA);
    await decideApproval(db, { approvalId: await pending(t!), actor: MAYA, decision: "decline", reason: "Not now" });
    const s = await stageOf(t!);
    expect(s.ended_at).not.toBeNull();
    expect(s.stage).toBe("quoted");
    expect(await snapshot(p)).toEqual(before);
    // A new list can be added once this one has stopped.
    expect((await up(p, NEW)).top_up_id).not.toBeNull();
  });

  it("declining the Outreach card ends it too", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, NEW);
    await runTopUp(t!, { until: "researched" });
    await requestOutreachCard(db, t!, MAYA);
    await decideApproval(db, { approvalId: await pending(t!), actor: MAYA, decision: "decline", reason: "Too dear" });
    expect((await stageOf(t!)).ended_at).not.toBeNull();
  });

  it("the Discard and End routes, and a refusal on a real event", async () => {
    const p = await parentOf();
    const app = createApp(db, { demo: true });
    const { top_up_id: t } = await up(p, NEW);
    expect((await app.request(`/api/events/${p}/discard`, { method: "POST", headers: hdr(MAYA) })).status).toBe(409);
    expect((await app.request(`/api/events/${t}/discard`, { method: "POST", headers: hdr(MAYA) })).status).toBe(200);
    const { top_up_id: t2 } = await up(p, NEW);
    const r = await app.request(`/api/events/${t2}/cancel`, { method: "POST", headers: { ...hdr(MAYA), "content-type": "application/json" }, body: JSON.stringify({ reason: "No" }) });
    expect(r.status).toBe(200);
    expect((await stageOf(t2!)).ended_at).not.toBeNull();
    const after = await (await app.request(`/api/events/${p}`)).json() as { top_ups: { id: string; ended_at: string | null }[] };
    expect(after.top_ups.map((x) => x.id)).toEqual([t, t2]);
    expect(after.top_ups.every((x) => x.ended_at)).toBe(true);
  });

  it("a card cannot be answered, nor settings changed, on new registrations", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, NEW);
    await expect(patchSettings(db, t!, MAYA, { add_prospects: true })).rejects.toThrow(/own settings/);
    const [co] = await db.query<{ id: string }>("SELECT id FROM companies WHERE event_id = $1", [t]);
    const id = await db.tx((q) => openCase(q, { eventId: t!, kind: "unknown_tier", companyId: co.id, summary: "x", facts: [] }));
    await endTopUp(db, t!, MAYA, "Done");
    await expect(answerCase(db, t!, id!, DAN, "drop")).rejects.toThrow(/stopped/);
  });
});

/* ------------------------------------------------------------------ routes */

describe("POST /upload", () => {
  it("is refused at delivered and on a top-up", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, HEAD + "Fresh Co,Jo Fresh,VP,jo@fresh.example,,\n");
    const app = createApp(db, { demo: true });
    const post = (id: string) => app.request(`/api/events/${id}/upload`, { method: "POST", headers: { ...hdr(MAYA), "x-filename": "a.csv", "content-type": "text/csv" }, body: PARENT });
    expect((await post(p)).status).toBe(409);
    expect((await post(t!)).status).toBe(409);
    expect(await db.query("SELECT 1 FROM uploads WHERE event_id = $1", [p])).toHaveLength(1);
  });

  it("the new registrations route opens the Run step at once and says the counts", async () => {
    const p = await parentOf();
    const app = createApp(db, { demo: true });
    const r = await app.request(`/api/events/${p}/new-registrations`, { method: "POST", headers: { ...hdr(MAYA), "x-filename": "late.csv", "content-type": "text/csv" }, body: PARENT + "Fresh Co,Jo Fresh,VP,jo@fresh.example,,\n" });
    expect(r.status).toBe(201);
    const out = await r.json() as { new_rows: number; already_in: number; top_up_id: string };
    expect(out).toMatchObject({ new_rows: 1, already_in: 5 });
    expect((await stageOf(out.top_up_id)).stage).toBe("quoted");
  });

  it("a top-up cannot be deleted on its own, and a parent's delete keeps what it spent", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, HEAD + "Fresh Co,Jo Fresh,VP,jo@fresh.example,,\n");
    await expect(deleteEvent(db, "GTM Team", t!)).rejects.toThrow(/discarded/);
    await runTopUp(t!, { until: "researched" });
    await endTopUp(db, t!, MAYA, "Discarded");
    const spent = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM credit_ledger WHERE event_id = $1", [t]))[0].n;
    expect(spent).toBeGreaterThan(0);
    await deleteEvent(db, "GTM Team", p);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_kept WHERE event_id = $1", [t]))[0].n).toBe(spent);
    expect(await db.query("SELECT 1 FROM events WHERE id = $1", [t])).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------- merge */

describe("merging", () => {
  const NEW = HEAD + "Larkspur Freight Software,Ivy New,VP Sales,ivy@larkspur.example,,\nFresh Payments Software,Jo Fresh,VP Sales,jo@freshpay.example,,\n";

  it("moves the upload and file, rows, contacts, new companies and cases, and leaves no rows behind", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, NEW);
    await runTopUp(t!);
    const s = await stageOf(t!);
    expect(s.stage).toBe("delivered");
    expect(s.merged_at).not.toBeNull();
    for (const table of ["contacts", "source_rows", "companies", "uploads", "upload_files", "review_cases", "title_tiers"]) expect(await db.query(`SELECT 1 FROM ${table} WHERE event_id = $1`, [t]), table).toHaveLength(0);
    expect((await db.query("SELECT 1 FROM cost_cards WHERE event_id = $1", [t])).length).toBe(2);
    const uploads = await db.query<{ top_up_id: string | null; row_count: number }>("SELECT top_up_id, row_count FROM uploads WHERE event_id = $1 ORDER BY created_at", [p]);
    expect(uploads).toEqual([{ top_up_id: null, row_count: 5 }, { top_up_id: t, row_count: 2 }]);
    expect(await db.query("SELECT 1 FROM upload_files WHERE event_id = $1", [p])).toHaveLength(2);
    // Rows that pointed at a copy now point at the parent's company.
    const [ivy] = await db.query<{ key: string; event_id: string }>("SELECT co.key, co.event_id FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.event_id = $1 AND k.full_name = 'Ivy New'", [p]);
    expect(ivy).toEqual({ key: "larkspur freight software", event_id: p });
    expect((await db.query("SELECT 1 FROM companies WHERE event_id = $1 AND key = 'fresh payments software'", [p])).length).toBe(1);
    // Everyone merged is on the person record, counted under one event.
    const linked = await db.query<{ person_id: string | null }>("SELECT person_id FROM contacts WHERE event_id = $1 AND full_name IN ('Ivy New', 'Jo Fresh') AND email IS NOT NULL", [p]);
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.every((k) => k.person_id)).toBe(true);
  });

  it("drops a live duplicate email", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, HEAD + "Fresh Payments Software,Jo Fresh,VP Sales,jo@freshpay.example,,\n");
    await runTopUp(t!, { until: "outreach" });
    await db.query("UPDATE contacts SET email = 'jo@freshpay.example' WHERE event_id = $1 AND full_name = 'Ada Moss'", [p]);
    await processEvent(db, t!, deps());
    const [jo] = await db.query<{ drop_reason: string }>("SELECT drop_reason FROM contacts WHERE event_id = $1 AND full_name = 'Jo Fresh'", [p]);
    expect(jo.drop_reason).toBe("duplicate");
  });

  it("answered cases arrive answered, open and skipped ones move too, with company pointers remapped", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, NEW);
    await runTopUp(t!, { until: "outreach" });
    const [copy] = await db.query<{ id: string; inherited_from: string }>("SELECT id, inherited_from FROM companies WHERE event_id = $1 AND inherited_from IS NOT NULL", [t]);
    const [k] = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 LIMIT 1", [t]);
    const opened = await db.tx((q) => openCase(q, { eventId: t!, kind: "model_flag", companyId: copy.id, contactId: k.id, summary: "open one", facts: [] }));
    const settled = await db.tx((q) => openCase(q, { eventId: t!, kind: "unknown_tier", companyId: copy.id, summary: "answered one", facts: [] }));
    await db.query("UPDATE review_cases SET status = 'answered', decision = 'tier_1', decided_by = 'Dan', decided_at = now() WHERE id = $1", [settled]);
    await processEvent(db, t!, deps());
    const rows = await db.query<{ id: string; status: string; company_id: string; event_id: string }>("SELECT id, status, company_id, event_id FROM review_cases WHERE id = ANY($1::text[])", [[opened, settled]]);
    for (const r of rows) { expect(r.event_id).toBe(p); expect(r.company_id).toBe(copy.inherited_from); }
    expect(rows.find((r) => r.id === settled)!.status).toBe("answered");
    expect(rows.find((r) => r.id === opened)!.status).toBe("open");
  });

  it("moves new title tiers and new spellings, and resolves a key collision instead of aborting", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, HEAD + "Fresh Payments Software,Jo Fresh,VP Sales,jo@freshpay.example,,\nLarkspur Freight Software,Ivy New,Regional Wizard,ivy@larkspur.example,,\n");
    await db.query("INSERT INTO companies (id, event_id, key, name, tier) VALUES ('co_collide', $1, 'collide key', 'Collide', 1)", [p]);
    await db.query("INSERT INTO companies (id, event_id, key, name) VALUES ('co_mine', $1, 'collide key', 'Collide Other')", [t]);
    await db.query("INSERT INTO title_tiers (event_id, title_key, tier, reason, source) VALUES ($1, 'regional wizard', 2, 'x', 'llm')", [t]);
    await runTopUp(t!);
    expect((await stageOf(t!)).merged_at).not.toBeNull();
    expect((await db.query<{ tier: number }>("SELECT tier FROM title_tiers WHERE event_id = $1 AND title_key = 'regional wizard'", [p]))[0].tier).toBe(2);
    expect(await db.query("SELECT 1 FROM companies WHERE id = 'co_mine'")).toHaveLength(0);
  });

  it("is atomic: a failure part way leaves everything as it was, and a retry after a crash completes", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, NEW);
    await runTopUp(t!, { until: "outreach" });
    const parentBefore = await snapshot(p), topBefore = await snapshot(t!);
    // The last write of the merge fails, after every other row has moved.
    const broken: Db = { ...db, tx: (fn) => db.tx((q) => fn(async (text: string, params?: unknown[]) => { if (text.includes("SET merged_at")) throw new Error("crash"); return q(text, params); })) } as Db;
    await db.query("UPDATE jobs SET status = 'done' WHERE event_id = $1", [t]);
    await db.query("UPDATE events SET stage = 'flagging', phase = NULL WHERE id = $1", [t]);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(processEvent(broken, t!, deps())).resolves.toBe("paused");
    quiet.mockRestore();
    const s = await stageOf(t!);
    expect(s.stage).toBe("paused");
    expect(s.merged_at).toBeNull();
    expect((await snapshot(p)).contacts).toEqual(parentBefore.contacts);
    expect((await snapshot(p)).uploads).toEqual(parentBefore.uploads);
    expect((await snapshot(t!)).contacts.length).toBe(topBefore.contacts.length);
    await db.query("UPDATE events SET stage = 'flagging', paused_from = NULL WHERE id = $1", [t]);
    await processEvent(db, t!, deps());
    expect((await stageOf(t!)).merged_at).not.toBeNull();
  });

  it("is retried on boot, so a crash cannot block later top-ups", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, NEW);
    await db.query("UPDATE events SET stage = 'delivered' WHERE id = $1", [t]);
    await expect(up(p, HEAD + "Other Co,Mo Other,VP,mo@other.example,,\n")).rejects.toThrow(/already running/);
    expect((await retryMerges(db, undefined, undefined)).merged).toBe(1);
    expect((await stageOf(t!)).merged_at).not.toBeNull();
    expect((await up(p, HEAD + "Other Co,Mo Other,VP,mo@other.example,,\n")).top_up_id).not.toBeNull();
  });

  it("publishes no Sheet of its own, writes no Summary, makes no perspective call, and queues nothing for Salesforce until merged", async () => {
    const llm: Llm & { steps: string[] } = { ...mockLlm, steps: [], complete(s, p, h) { this.steps.push(s); return mockLlm.complete(s, p, h); } };
    const write = async () => undefined;
    const crm: Crm = { ...mockCrm, name: "crm_test", connected: true, async personFlags(ps) { return Object.fromEntries(ps.map((x) => [x.ref, []])); }, async accountFlags(as) { return Object.fromEntries(as.map((x) => [x.ref, { do_not_prospect: false }])); }, write };
    const p = await parentOf();
    await db.query("DELETE FROM crm_outbox");
    await publishSheet(db, p, MAYA, fakePublisher({}));
    const pub = fakePublisher({});
    const { top_up_id: t } = await up(p, NEW);
    await runTopUp(t!, { until: "outreach", d: deps({ llm, crm, sheets: pub }) });
    expect(await db.query("SELECT 1 FROM crm_outbox")).toHaveLength(0);
    await processEvent(db, t!, deps({ llm, crm, sheets: pub }));
    expect(llm.steps).not.toContain("perspective");
    expect(pub.created).toHaveLength(0);
    const [ev] = await db.query<{ perspective: unknown; sheet_id: string | null }>("SELECT perspective, sheet_id FROM events WHERE id = $1", [t]);
    expect(ev.perspective).toBeNull();
    expect(ev.sheet_id).toBeNull();
    const queued = await db.query<{ payload: { event_id: string } }>("SELECT payload FROM crm_outbox");
    for (const q of queued) expect(q.payload.event_id).toBe(p);
  });
});

/* --------------------------------------------------------------- Salesforce */

describe("a top-up gets every Salesforce check", () => {
  const clean = () => ({ ...mockCrm, name: "crm_test", connected: true }) as Crm;

  it("asks at the start and before delivery about its own people only, and at the domain gate about accounts, flagged people stop and the parent does not change", async () => {
    const asked: { at: number; refs: string[] }[] = [], accounts: string[][] = [];
    const flagged = new Set<string>();
    const crm: Crm = { ...clean(), async personFlags(ps) { asked.push({ at: Date.now(), refs: ps.map((x) => x.ref) }); return Object.fromEntries(ps.map((x) => [x.ref, x.full_name === "Ivy New" ? [{ id: "r", object: "Contact", email: x.email, email_opt_out: true, do_not_contact: false, do_not_call: false, bounced_at: null }] : flagged.has(x.ref) ? [{ id: "r2", object: "Lead", email: x.email, email_opt_out: false, do_not_contact: false, do_not_call: true, bounced_at: null }] : []])); }, async accountFlags(as) { accounts.push(as.map((x) => x.ref)); return Object.fromEntries(as.map((x) => [x.ref, { do_not_prospect: false }])); } };
    const p = await parentOf();
    const before = await snapshot(p);
    const { top_up_id: t } = await up(p, HEAD + "Larkspur Freight Software,Ivy New,VP Sales,ivy@larkspur.example,,\nLarkspur Freight Software,Tess Keep,VP Sales,tess@larkspur.example,,\n");
    const ids = (await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1", [t])).map((x) => x.id);
    await runTopUp(t!, { d: deps({ crm }) });
    expect(asked.length).toBeGreaterThanOrEqual(2);
    for (const a of asked) for (const r of a.refs) expect(ids).toContain(r);
    expect(accounts.length).toBeGreaterThan(0);
    const [ivy] = await db.query<{ drop_reason: string }>("SELECT drop_reason FROM contacts WHERE full_name = 'Ivy New'");
    expect(ivy.drop_reason).toBe("crm_unsubscribed");
    unchanged(before, await snapshot(p));
  });

  it("a Salesforce failure pauses the top-up, not the parent", async () => {
    const crm: Crm = { ...clean(), async personFlags() { throw new Error("down"); }, async accountFlags() { throw new Error("down"); } };
    const p = await parentOf();
    const { top_up_id: t } = await up(p, HEAD + "Fresh Co,Jo Fresh,VP,jo@fresh.example,,\n");
    await requestResearchCard(db, t!, MAYA);
    await approve(t!);
    await processEvent(db, t!, deps({ crm }));
    expect((await stageOf(t!)).stage).toBe("paused");
    expect((await stageOf(p)).stage).toBe("delivered");
  });

  it("an account flagged by the CRM drops the new person on the copy; the parent's company stays", async () => {
    const crm: Crm = { ...clean(), async personFlags(ps) { return Object.fromEntries(ps.map((x) => [x.ref, []])); }, async accountFlags(as) { return Object.fromEntries(as.map((x) => [x.ref, { do_not_prospect: true }])); } };
    const p = await parentOf();
    const before = await snapshot(p);
    const { top_up_id: t } = await up(p, HEAD + "Larkspur Freight Software,Ivy New,VP Sales,ivy@larkspur.example,,\n");
    await runTopUp(t!, { until: "researched", d: deps({ crm }) });
    expect((await db.query<{ drop_reason: string }>("SELECT drop_reason FROM contacts WHERE event_id = $1", [t]))[0].drop_reason).toBe("excluded_company");
    expect(await snapshot(p)).toEqual(before);
  });
});

/* ----------------------------------------------------------- reuse, counting */

describe("reuse and counts", () => {
  it("a cache hit from the parent counts once at its cost; an inherited company logs no saving; a top-up's own answers never count", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, HEAD + "Larkspur Freight Software,Ivy New,VP Sales,ivy@larkspur.example,,\nLarkspur Freight Software,Tess Keep,VP Sales,tess@larkspur.example,,\n");
    await runTopUp(t!);
    const saved = await db.query<{ step: string; target: string; n: number }>("SELECT step, target, n FROM reuse_log WHERE event_id = $1", [t]);
    expect(saved.filter((s) => ["firmographics", "company_tier", "website_read", "person_match"].includes(s.step))).toHaveLength(0);
    // Two new people at one domain the parent already probed: one saved probe, at the verifier's cost, written against the top-up.
    const probes = saved.filter((s) => s.step === "catch_all_probe");
    expect(probes).toHaveLength(1);
    expect(probes[0].n).toBe(defaultSettings().outreach.probe_cost);
    expect((await db.query("SELECT 1 FROM reuse_log WHERE event_id = $1 AND step = 'verify'", [t]))).toHaveLength(0);
  });

  it("rows received are the first file plus each top-up's new rows, in the summary and the funnel", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, PARENT + "Fresh Payments Software,Jo Fresh,VP Sales,jo@freshpay.example,,\n");
    await runTopUp(t!);
    const list = await listSummary(db, p);
    expect(list.upload?.row_count).toBe(6);
    expect(list.upload?.filename).toBe("a.csv");
    expect((await load(db, p)).funnel.uploaded).toBe(6);
  });

  it("What ran reads the parent and its top-ups, stopped ones included", async () => {
    const p = await parentOf();
    const before = (await load(db, p)).use;
    const { top_up_id: t } = await up(p, HEAD + "Fresh Payments Software,Jo Fresh,VP Sales,jo@freshpay.example,,\n");
    await runTopUp(t!, { until: "researched" });
    await endTopUp(db, t!, MAYA, "Discarded");
    const after = (await load(db, p)).use;
    const sum = (u: typeof before) => u.credits.reduce((n, c) => n + c.credits, 0) + u.ai_calls;
    expect(sum(after)).toBeGreaterThan(sum(before));
  });
});

/* -------------------------------------------------------------------- lists */

describe("no top-up in any list screen", () => {
  it("events, overview, seats, budget, catalog links and the concierge view do not show one, and Usage rolls it up", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, HEAD + "Fresh Payments Software,Jo Fresh,VP Sales,jo@freshpay.example,,\n");
    await runTopUp(t!);
    const app = createApp(db, { demo: true });
    const ids = async (path: string, key: string) => ((await (await app.request(path)).json()) as Record<string, { id: string; event_id?: string }[]>)[key];
    expect((await ids("/api/events", "events")).map((e) => e.id)).toEqual([p]);
    expect((await overview(db)).delivered.map((d) => d.id)).toEqual([p]);
    expect(JSON.stringify(await ids("/api/seat-requests", "requests"))).not.toContain(t!);
    expect(JSON.stringify(await ids("/api/catalog", "catalog"))).not.toContain(t!);
    expect(JSON.stringify(await budgetView(db, { year: 2027 }))).not.toContain(t!);
    expect((await db.query<{ id: string }>("SELECT id FROM concierge_events")).map((r) => r.id)).toEqual([p]);
    const u = await usageView(db, { simulated: true, year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
    expect(u.events.map((e) => e.event_id)).toEqual([p]);
    const ledger = await db.query<{ n: number }>("SELECT coalesce(sum(CASE kind WHEN 'reserve' THEN amount WHEN 'release' THEN -amount ELSE 0 END), 0)::int AS n FROM credit_ledger WHERE unit = 'credits'");
    const shown = Object.values(u.events[0].credits).reduce((n, c) => n + c.used, 0);
    expect(shown).toBe(ledger[0].n);
    expect(u.events[0].credits.Apollo.used).toBeGreaterThan(0);
  });

  it("a stopped top-up's spend still shows under its parent", async () => {
    const p = await parentOf();
    const { top_up_id: t } = await up(p, HEAD + "Fresh Payments Software,Jo Fresh,VP Sales,jo@freshpay.example,,\n");
    await runTopUp(t!, { until: "researched" });
    const before = await usageView(db, { simulated: true, year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
    await endTopUp(db, t!, MAYA, "Stopped");
    const after = await usageView(db, { simulated: true, year: new Date().getFullYear(), month: new Date().getMonth() + 1 });
    expect(after.events[0].ai.cents).toBe(before.events[0].ai.cents);
    expect(after.events[0].ai.cents).toBeGreaterThan(0);
  });
});

/* ----------------------------------------------------------------- the Sheet */

function fakePublisher(tabs: Record<string, string[][]>, fail: string | null = null) {
  const calls = { updated: [] as Uint8Array[], polished: 0, created: [] as Uint8Array[] };
  const pub: SheetPublisher & typeof calls = {
    ...calls, name: "fake", enabled: true,
    async create(x) { pub.created.push(x); return { id: "sheet1" }; },
    async share() { /* no network */ },
    async find() { return null; },
    async update(_id, x) { pub.updated.push(x); },
    async readReview() { if (fail === "Review") throw new Error("Review unreadable"); return tabs.Review ?? [["case_id", "contact_id", "Case", "Decision"]]; },
    async readTab(_id, title) { if (fail === title) throw new Error(`${title} unreadable`); return tabs[title] ?? []; },
    async polish() { pub.polished++; return { applied: ["look"], failed: [] }; },
  };
  return pub;
}

describe("the Sheet refresh", () => {
  async function published() {
    const p = await parentOf();
    const pub0 = fakePublisher({});
    await publishSheet(db, p, MAYA, pub0);
    await db.query("UPDATE events SET sheet_url = 'https://sheet.example/x' WHERE id = $1", [p]);
    return p;
  }
  const peopleGrid = (id: string, status: string, notes: string) => [["banner"], ["group"], ["Priority", "Outreach status", "Notes", "contact_id"], ["A", status, notes, id]];
  const meetings = [["Meetings"], ["group"], ["Contact", "Company", "Account owner", "Date", "Time", "Location", "Status", "Outcome", "Notes"], ["Ada Moss, Larkspur", "x", "y", "2027-02-03", "9:30", "Booth 4", "Booked", "Pending", "Bring the deck"]];

  it("keeps Review decisions, rep columns and Meetings, and runs the polish again", async () => {
    const p = await published();
    const [ada] = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND full_name = 'Ada Moss'", [p]);
    const [bo] = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND full_name = 'Bo Hill'", [p]);
    const pub = fakePublisher({ Review: [["case_id", "contact_id", "Decision"], ["", bo.id, "Drop"]], Attendees: peopleGrid(ada.id, "Replied", "Call back in May"), Prospects: [["x"], ["y"], ["Priority", "Outreach status", "Notes", "contact_id"]], Meetings: meetings });
    const out = await refreshSheet(db, p, MAYA, pub);
    expect(out.sheet_error).toBeNull();
    expect(pub.updated).toHaveLength(1);
    expect(pub.polished).toBe(1);
    expect((await db.query<{ drop_reason: string }>("SELECT drop_reason FROM contacts WHERE id = $1", [bo.id]))[0].drop_reason).toBe("rejected_in_review");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(pub.updated[0] as never);
    const at = wb.getWorksheet("Attendees")!;
    const head = at.getRow(3).values as string[];
    const idCol = head.indexOf("contact_id");
    let found = false;
    at.eachRow((r) => { if (r.getCell(idCol).value === ada.id) { found = true; expect(r.getCell(head.indexOf("Outreach status")).value).toBe("Replied"); expect(r.getCell(head.indexOf("Notes")).value).toBe("Call back in May"); } });
    expect(found).toBe(true);
    const m = wb.getWorksheet("Meetings")!;
    expect(m.getCell("A4").value).toBe("Ada Moss, Larkspur");
    expect(m.getCell("G4").value).toBe("Booked");
    expect(m.getCell("I4").value).toBe("Bring the deck");
    expect(m.getCell("D4").value).toEqual(new Date("2027-02-03T00:00:00Z"));
    const time = m.getCell("E4").value as Date;
    expect([time.getUTCHours(), time.getUTCMinutes()]).toEqual([9, 30]);
    expect(String((m.getCell("B4").value as { formula?: string }).formula)).toContain("INDEX");
  });

  it("a failed read leaves the Sheet alone, says so, and the download still works", async () => {
    const p = await published();
    for (const tab of ["Review", "Attendees", "Prospects", "Meetings"]) {
      const pub = fakePublisher({ Attendees: peopleGrid("x", "", ""), Prospects: peopleGrid("y", "", ""), Meetings: meetings }, tab);
      const out = await refreshSheet(db, p, MAYA, pub);
      expect(pub.updated).toHaveLength(0);
      expect(out.sheet_error).toContain("unreadable");
      expect((await db.query<{ sheet_error: string }>("SELECT sheet_error FROM events WHERE id = $1", [p]))[0].sheet_error).toContain("unreadable");
    }
    expect((await buildWorkbook(db, p)).length).toBeGreaterThan(0);
  });

  it("a Review tab it cannot read as a Review tab is a failed read, with no decision applied", async () => {
    const p = await published();
    const pub = fakePublisher({ Review: [["nope"]], Attendees: peopleGrid("x", "", ""), Prospects: peopleGrid("y", "", ""), Meetings: meetings });
    const out = await refreshSheet(db, p, MAYA, pub);
    expect(pub.updated).toHaveLength(0);
    expect(out.sheet_error).toBeTruthy();
  });

  it("an old Sheet with no contact id column is left alone until someone chooses to rebuild it", async () => {
    const p = await published();
    const old = [["t"], ["g"], ["Priority", "Outreach status", "Notes"], ["A", "Replied", "typed"]];
    const pub = fakePublisher({ Attendees: old, Prospects: old, Meetings: meetings });
    const out = await refreshSheet(db, p, MAYA, pub);
    expect(out.sheet_error).toBe(OLD_SHEET_ERROR);
    expect(pub.updated).toHaveLength(0);
    const rebuilt = await refreshSheet(db, p, MAYA, pub, { rebuild: true });
    expect(rebuilt.sheet_error).toBeNull();
    expect(pub.updated).toHaveLength(1);
  });

  it("a merge refreshes the parent's Sheet and marks it done; a failed refresh is retried at boot", async () => {
    const p = await published();
    const [ada] = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND full_name = 'Ada Moss'", [p]);
    const { top_up_id: t } = await up(p, HEAD + "Fresh Payments Software,Jo Fresh,VP Sales,jo@freshpay.example,,\n");
    const bad = fakePublisher({ Attendees: peopleGrid(ada.id, "Replied", ""), Prospects: peopleGrid(ada.id, "", ""), Meetings: meetings }, "Meetings");
    await runTopUp(t!, { d: deps({ sheets: bad }) });
    expect((await stageOf(t!)).merged_at).not.toBeNull();
    expect(bad.updated).toHaveLength(0);
    expect((await db.query<{ sheet_error: string | null }>("SELECT sheet_error FROM events WHERE id = $1", [p]))[0].sheet_error).toBeTruthy();
    const good = fakePublisher({ Attendees: peopleGrid(ada.id, "Replied", ""), Prospects: peopleGrid(ada.id, "", ""), Meetings: meetings });
    expect((await retryMerges(db, undefined, good)).refreshed).toBe(1);
    expect(good.updated).toHaveLength(1);
    expect(good.polished).toBe(1);
    expect((await db.query<{ sheet_refreshed_at: string | null }>("SELECT sheet_refreshed_at FROM events WHERE id = $1", [t]))[0].sheet_refreshed_at).not.toBeNull();
    expect((await db.query<{ sheet_error: string | null }>("SELECT sheet_error FROM events WHERE id = $1", [p]))[0].sheet_error).toBeNull();
  });

  it("the rebuilt Sheet has the new people, a No calls column filled from Salesforce, and its contact id hidden", async () => {
    const p = await published();
    const crm: Crm = { ...mockCrm, name: "crm_t", connected: true, async personFlags(ps) { return Object.fromEntries(ps.map((x) => [x.ref, x.full_name === "Jo Fresh" ? [{ id: "r", object: "Contact", email: x.email, email_opt_out: false, do_not_contact: false, do_not_call: true, bounced_at: null }] : []])); }, async accountFlags(as) { return Object.fromEntries(as.map((x) => [x.ref, { do_not_prospect: false }])); } };
    const [ada] = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND full_name = 'Ada Moss'", [p]);
    const pub = fakePublisher({ Attendees: peopleGrid(ada.id, "", ""), Prospects: peopleGrid(ada.id, "", ""), Meetings: meetings });
    const { top_up_id: t } = await up(p, HEAD + "Fresh Payments Software,Jo Fresh,VP Sales,jo@freshpay.example,,\n");
    await runTopUp(t!, { d: deps({ crm, sheets: pub }) });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(pub.updated[0] as never);
    const at = wb.getWorksheet("Attendees")!;
    const head = at.getRow(3).values as string[];
    expect(at.getColumn(head.indexOf("contact_id")).hidden).toBe(true);
    let row = 0;
    at.eachRow((r, n) => { if (r.getCell(2).value === "Jo Fresh") row = n; });
    expect(row).toBeGreaterThan(0);
    expect(at.getRow(row).getCell(head.indexOf("No calls")).value).toBe("No calls");
  });
});

describe("the parent's Summary", () => {
  it("keeps the model's block until the facts change, then goes back to the rules, and the top-up never writes one", async () => {
    const p = await parentOf();
    const d0 = await load(db, p);
    const stored = { version: 1, model: "m", made_at: "2026-11-09T00:00:00Z", packet_hash: packetHash(buildPacket(d0)), blocks: { why: { by: "model", text: "Model words.", note: null }, list: { by: "model", text: "More model words.", note: null }, stand: { by: "fallback", text: null, note: "x" } } };
    await db.query("UPDATE events SET perspective = $2::jsonb WHERE id = $1", [p, JSON.stringify(stored)]);
    expect(withStored(await load(db, p)).prose).toEqual(["why", "list"]);
    const { top_up_id: t } = await up(p, HEAD + "Fresh Payments Software,Jo Fresh,VP Sales,jo@freshpay.example,,\n");
    // A run that has not merged changes nothing the Summary states.
    await runTopUp(t!, { until: "outreach" });
    expect(withStored(await load(db, p)).prose).toEqual(["why", "list"]);
    await processEvent(db, t!, deps());
    expect(withStored(await load(db, p)).prose).toBeUndefined();
    expect((await db.query<{ perspective: unknown }>("SELECT perspective FROM events WHERE id = $1", [t]))[0].perspective).toBeNull();
    expect(await db.query("SELECT 1 FROM credit_ledger WHERE event_id = $1 AND step = 'perspective'", [t])).toHaveLength(0);
  });
});

describe("single-card parents", () => {
  it("a top-up is two-card; a known company with no domain is assessed, and the parent's own tier stands at the merge", async () => {
    const p = await deliverEvent(db, PARENT, {}, "Old flow", "single_card");
    const before = await snapshot(p);
    const { top_up_id: t } = await up(p, HEAD + "Larkspur Freight Software,Ivy New,VP Sales,ivy@larkspur.example,,\n");
    expect((await db.query<{ flow: string }>("SELECT flow FROM events WHERE id = $1", [t]))[0].flow).toBe("two_card");
    expect((await db.query<{ inherited_from: string | null }>("SELECT inherited_from FROM companies WHERE event_id = $1", [t]))[0].inherited_from).toBeNull();
    await runTopUp(t!);
    expect((await stageOf(t!)).merged_at).not.toBeNull();
    unchanged(before, await snapshot(p));
  });
});

describe("mergeTopUp guards", () => {
  it("refuses an event that is not a top-up, and does nothing the second time", async () => {
    const p = await parentOf();
    await expect(db.tx((q) => mergeTopUp(q, p, MAYA, undefined))).rejects.toThrow(RuleError);
    const { top_up_id: t } = await up(p, HEAD + "Fresh Co,Jo Fresh,VP,jo@fresh.example,,\n");
    await runTopUp(t!);
    expect((await db.tx((q) => mergeTopUp(q, t!, MAYA, undefined))).contact_ids).toEqual([]);
    await afterMerge(db, { contact_ids: [], parent_id: p }, MAYA, undefined);
  });
});
