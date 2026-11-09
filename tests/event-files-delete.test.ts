import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { budgetView, recordTicket } from "../src/server/budget.ts";
import type { Db } from "../src/server/db.ts";
import { createEvent, moveEvent } from "../src/server/events.ts";
import { recordOptOut } from "../src/server/suppression.ts";
import { decideSeat, parseSeatRequest, requestSeat } from "../src/server/seats.ts";
import { usageView } from "../src/server/usage.ts";
import { deliverEvent, freshDb } from "./helpers.ts";

const MAYA = "Maya Ortiz", DAN = "Dan Whitlock", GTM = "GTM Team", ANA = "Ana Duarte";
const hdr = (a: string) => ({ "x-actor": encodeURIComponent(a) });
const LIST = "Company,Name,Title,Email\nAcme,Ada Lovelace,VP Sales,ada@acme.com\nKestrel Foods,Bo Lindqvist,Head of Growth,bo@kestrel.example\n";
let db: Db;
const app = () => createApp(db, { demo: true });

async function approvedEvent(name = "T") {
  const id = (await createEvent(db, MAYA, { name, starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 100 })).id;
  await moveEvent(db, id, "approved", DAN);
  return id;
}
const upload = (id: string, body: string | Uint8Array, filename: string, who = MAYA) =>
  app().request(`/api/events/${id}/upload`, { method: "POST", headers: { ...hdr(who), "x-filename": encodeURIComponent(filename), "content-type": "text/csv" }, body: body as BodyInit });
const uploads = async (id: string) => (await (await app().request(`/api/events/${id}`)).json() as { uploads: { id: string; filename: string; has_file: boolean; uploaded_by: string }[] }).uploads;

beforeEach(async () => { db = await freshDb(); });

describe("the attendee list block", () => {
  it("keeps the original bytes and returns them exactly, with a safe filename", async () => {
    const id = await approvedEvent();
    // Not valid UTF-8 on purpose, plus accents: a re-encoded copy would differ.
    const bytes = new Uint8Array([...new TextEncoder().encode("Company,Name,Title\nCafé Uno,Ana Muñoz,CEO\n"), 0x0d, 0x0a, 0xff, 0xfe, 0x41]);
    const sent = await upload(id, bytes, '..\\evil"; x=1/../Attendees é.csv');
    expect(sent.status).toBe(200);
    const [u] = await uploads(id);
    expect(u.has_file).toBe(true);
    const r = await app().request(`/api/events/${id}/uploads/${u.id}/file`);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bytes);
    const disp = r.headers.get("content-disposition")!;
    expect(disp.startsWith("attachment; filename=\"")).toBe(true);
    expect(disp).not.toMatch(/\.\.|\/|\\\\|x=1"/);
    expect(disp).toContain("filename*=UTF-8''");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-type")).toContain("text/csv");
  });

  it("stores bytea as the exact bytes on PGlite", async () => {
    const all = new Uint8Array(256).map((_, i) => i);
    await db.query("CREATE TEMP TABLE b (x bytea)");
    await db.query("INSERT INTO b VALUES ($1)", [all]);
    const [row] = await db.query<{ x: Uint8Array }>("SELECT x FROM b");
    expect(new Uint8Array(row.x)).toEqual(all);
  });

  it("refuses an upload id from another event", async () => {
    const a = await approvedEvent("A"), b = await approvedEvent("B");
    await upload(a, LIST, "a.csv"); await upload(b, LIST, "b.csv");
    const [ua] = await uploads(a);
    expect((await app().request(`/api/events/${b}/uploads/${ua.id}/file`)).status).toBe(404);
    expect((await app().request(`/api/events/${b}/uploads/${ua.id}/rows`)).status).toBe(404);
    expect((await app().request(`/api/events/${a}/uploads/${ua.id}/file`)).status).toBe(200);
    expect((await app().request(`/api/events/${a}/uploads/nope/file`)).status).toBe(404);
  });

  it("is readable without a write key, as the workbook is", async () => {
    const id = await approvedEvent();
    await upload(id, LIST, "a.csv");
    const [u] = await uploads(id);
    const keyed = createApp(db, { demo: true, writeKey: "secret" });
    expect((await keyed.request(`/api/events/${id}/uploads/${u.id}/file`)).status).toBe(200);
  });

  it("Replace deletes the old upload row and its file, voids a pending card, and moves the uploader", async () => {
    const id = await approvedEvent();
    await upload(id, LIST, "first.csv", MAYA);
    expect((await app().request(`/api/events/${id}/quote`, { method: "POST", headers: hdr(MAYA) })).status).toBe(200);
    const [first] = await uploads(id);
    const second = await upload(id, "Company,Name,Title,Email\nZed Co,Zed Zee,CTO,z@zed.example\n", "second.csv", ANA);
    expect(second.status).toBe(200);
    const list = await uploads(id);
    expect(list.map((x) => x.filename)).toEqual(["second.csv"]);
    expect(list[0].uploaded_by).toBe(ANA);
    expect(await db.query("SELECT 1 FROM uploads WHERE id = $1", [first.id])).toHaveLength(0);
    expect(await db.query("SELECT 1 FROM upload_files WHERE upload_id = $1", [first.id])).toHaveLength(0);
    expect(await db.query("SELECT 1 FROM upload_files WHERE event_id = $1", [id])).toHaveLength(1);
    expect(await db.query("SELECT 1 FROM approvals WHERE event_id = $1 AND status = 'pending' AND kind <> 'seats'", [id])).toHaveLength(0);
    const names = await db.query<{ full_name: string }>("SELECT full_name FROM contacts WHERE event_id = $1", [id]);
    expect(names.map((n) => n.full_name)).toEqual(["Zed Zee"]);
    expect((await app().request(`/api/events/${id}/uploads/${first.id}/file`)).status).toBe(404);
  });

  it("rebuilds a CSV from the rows when no file was kept, and neutralizes formula cells", async () => {
    const id = await approvedEvent();
    await upload(id, "Company,Name,Title,Email\nAcme,Ada Lovelace,VP Sales,ada@acme.com\n", "old.csv");
    const [u] = await uploads(id);
    await db.query("DELETE FROM upload_files WHERE upload_id = $1", [u.id]);
    await db.query("UPDATE source_rows SET raw = $2::jsonb WHERE upload_id = $1 AND row_number = 1", [u.id, JSON.stringify({ Company: "=HYPERLINK(\"http://x\",\"y\")", Name: "+1 555", Title: "-2+3", Email: "@SUM(A1)", "=Header": "ok", Note: "a,b \"q\"\nline" })]);
    expect((await uploads(id))[0].has_file).toBe(false);
    expect((await app().request(`/api/events/${id}/uploads/${u.id}/file`)).status).toBe(404);
    const r = await app().request(`/api/events/${id}/uploads/${u.id}/rows`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-disposition")).toContain("old-rows.csv");
    const [head, ...rest] = (await r.text()).split("\r\n");
    const csv = rest.join("\r\n");
    expect(head.split(",")).toContain("'=Header");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+1 555");
    expect(csv).toContain("'-2+3");
    expect(csv).toContain("'@SUM(A1)");
    expect(csv).toContain('"a,b ""q""\nline"');
    // Nothing starts with a formula character once the quote is in front.
    for (const cell of [...head.split(","), "'=x"]) expect(cell.startsWith("=")).toBe(false);
  });
});

describe("deleting an event", () => {
  const del = (id: string, who: string, a = app()) => a.request(`/api/events/${id}`, { method: "DELETE", headers: hdr(who) });
  const OWNED = async () => (await db.query<{ t: string }>("SELECT table_name AS t FROM information_schema.columns WHERE column_name = 'event_id' AND table_schema = 'public'")).map((r) => r.t).filter((t) => !["ledger_kept", "ticket_spend_kept", "reuse_log", "llm_calls_kept"].includes(t));

  it("is for GTM Team and approvers only, decided on the server", async () => {
    const id = await approvedEvent();
    expect((await del(id, MAYA)).status).toBe(403);
    expect((await del(id, "Random Person")).status).toBe(403);
    expect(await db.query("SELECT 1 FROM events WHERE id = $1", [id])).toHaveLength(1);
    expect((await del(id, DAN)).status).toBe(200);
    const id2 = await approvedEvent("Two");
    expect((await del(id2, GTM)).status).toBe(200);
    expect((await del(id2, GTM)).status).toBe(404);
    expect((await createApp(db, { demo: true, writeKey: "k" }).request(`/api/events/${id}`, { method: "DELETE", headers: hdr(GTM) })).status).toBe(401);
  });

  it("is refused while a run is in progress or work is queued", async () => {
    const id = await approvedEvent();
    for (const s of ["tiering", "enriching", "flagging", "researching", "finding_people"]) {
      await db.query("UPDATE events SET stage = $2 WHERE id = $1", [id, s]);
      const r = await del(id, GTM);
      expect(r.status, s).toBe(409);
    }
    await db.query("UPDATE events SET stage = 'ready_for_review' WHERE id = $1", [id]);
    await db.query("INSERT INTO jobs (id, event_id, kind, payload, status) VALUES ('j1', $1, 'company_tier', '{}'::jsonb, 'queued')", [id]);
    expect((await del(id, GTM)).status).toBe(409);
    await db.query("UPDATE jobs SET status = 'running' WHERE id = 'j1'");
    expect((await del(id, GTM)).status).toBe(409);
    await db.query("UPDATE jobs SET status = 'done' WHERE id = 'j1'");
    expect((await del(id, GTM)).status).toBe(200);
  });

  it("removes the event's own rows and files, leaves global lists, and keeps pools and the Budget truthful", async () => {
    const keep = await deliverEvent(db, LIST, {}, "Keep Summit");
    const gone = await deliverEvent(db, LIST, {}, "Gone Summit");
    await recordOptOut(db, GTM, { email: "optout@acme.com", reason: "asked" });
    await db.query("INSERT INTO vendor_pools (vendor, allotment, period) VALUES ('Apollo', 5000, 'month')");

    // A seat with a ticket bought, on the event that will go.
    await db.query("INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, seat_price_cents) VALUES ('cat1', 'Gone Summit', '', 'Lisbon', 'Portugal', '2027-05-10', '2027-05-10', 100000)");
    const seat = await requestSeat(db, MAYA, parseSeatRequest(MAYA, { catalog_id: "cat1", team: "Sales", role: "SDR", goal: "new_pipeline", why_event: "Their buyers are the people we sell to.", why_you: "I run outreach for this region and know the accounts.", expected_meetings: 4 }));
    await decideSeat(db, { requestId: seat.id, actor: DAN, decision: "approve" });
    await recordTicket(db, DAN, seat.id, 900);
    const seatEvent = (await db.query<{ event_id: string }>("SELECT event_id FROM seat_requests WHERE id = $1", [seat.id]))[0].event_id;
    await db.query("INSERT INTO budget_quarters (year, quarter, cents) VALUES (2027, 2, 500000)");

    const now = new Date();
    const usage = () => usageView(db, { year: now.getFullYear(), month: now.getMonth() + 1, simulated: true });
    const before = await usage();
    expect(before.vendors.reduce((n, v) => n + v.used, 0) + before.ai.month_cents).toBeGreaterThan(0);
    const budgetBefore = (await budgetView(db, { year: 2027 })).totals;
    expect(budgetBefore.spent).toBe(90000);
    const ledgerBefore = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM credit_ledger WHERE event_id = $1", [gone]);
    expect(ledgerBefore[0].n).toBeGreaterThan(0);
    const globalCounts = async () => Object.fromEntries(await Promise.all(["suppressions", "icp_versions", "company_cache", "tier_cache", "title_cache", "verification_cache", "domain_state", "reveals", "reveal_queries", "name_domain_map", "vendor_pools", "catalog_events", "budget_quarters"].map(async (t) => [t, (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))[0].n])));
    const globalsBefore = await globalCounts();
    const keepRows = async () => (await db.query<{ n: number }>("SELECT (SELECT count(*) FROM contacts WHERE event_id = $1)::int + (SELECT count(*) FROM credit_ledger WHERE event_id = $1)::int AS n", [keep]))[0].n;
    const keepBefore = await keepRows();

    expect((await del(gone, GTM)).status).toBe(200);
    expect((await del(seatEvent, DAN)).status).toBe(200);

    // Every table that holds an event_id has nothing left for the deleted events, and the kept event is untouched.
    for (const t of await OWNED()) {
      const [{ n }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} WHERE event_id = ANY($1)`, [[gone, seatEvent]]);
      expect(n, t).toBe(0);
    }
    expect(await keepRows()).toBe(keepBefore);
    expect(await db.query("SELECT 1 FROM events WHERE id = $1", [keep])).toHaveLength(1);
    expect(await db.query("SELECT 1 FROM upload_files WHERE event_id = $1", [gone])).toHaveLength(0);
    expect(await globalCounts()).toEqual(globalsBefore);
    expect((await db.query("SELECT 1 FROM suppressions WHERE email = 'optout@acme.com'")).length).toBe(1);

    // Pools: the same credits and AI dollars as before.
    const after = await usage();
    expect(after.vendors.map((v) => [v.vendor, v.used, v.parts])).toEqual(before.vendors.map((v) => [v.vendor, v.used, v.parts]));
    expect(after.ai).toEqual(before.ai);
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ledger_kept"))[0].n).toBe(ledgerBefore[0].n);

    // Budget: the ticket bought stays spent; the line has no live event behind it.
    const b = await budgetView(db, { year: 2027 });
    expect(b.totals.spent).toBe(90000);
    expect(b.quarters[1]).toMatchObject({ spent: 90000 });
    expect(b.events.find((e) => e.name === "Gone Summit")).toMatchObject({ spent: 90000, gone: true });
  });

  it("keeps counting a ticket bought for an ended event, before and after it is deleted", async () => {
    await db.query("INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, seat_price_cents) VALUES ('cat2', 'Ended Summit', '', 'Lisbon', 'Portugal', '2027-05-10', '2027-05-10', 100000)");
    const seat = await requestSeat(db, MAYA, parseSeatRequest(MAYA, { catalog_id: "cat2", team: "Sales", role: "SDR", goal: "new_pipeline", why_event: "Their buyers are the people we sell to.", why_you: "I run outreach for this region and know the accounts.", expected_meetings: 4 }));
    await decideSeat(db, { requestId: seat.id, actor: DAN, decision: "approve" });
    await recordTicket(db, DAN, seat.id, 900);
    const ev = (await db.query<{ event_id: string }>("SELECT event_id FROM seat_requests WHERE id = $1", [seat.id]))[0].event_id;
    await db.query("UPDATE events SET stage = 'declined', decline_reason = 'No' WHERE id = $1", [ev]);
    expect((await budgetView(db, { year: 2027 })).totals.spent).toBe(90000);
    expect((await app().request(`/api/events/${ev}`, { method: "DELETE", headers: hdr(DAN) })).status).toBe(200);
    expect((await budgetView(db, { year: 2027 })).totals.spent).toBe(90000);
    expect((await db.query("SELECT 1 FROM ticket_spend_kept")).length).toBe(1);
  });
});
