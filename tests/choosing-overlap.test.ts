/* Matching target accounts against a page, and the evidence that an account will be at an event (docs/CHOOSING.md section 4). */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { addPage, addSeriesLink, cleanPage, likelyThere, matchPage, normName, rejectMatch, removePage, restoreMatch, seriesKey } from "../src/server/overlap.ts";
import { freshDb } from "./helpers.ts";
import { deliveredInMotion, fakeCrm, clock, MAYA } from "./lifecycle-harness.ts";
import { as, CAMILLE } from "./plan-helpers.ts";

const acct = (id: string, name: string, domain: string | null = null) => ({ id, name, domain });
const names = (body: string, accounts: ReturnType<typeof acct>[]) => matchPage(body, accounts).map((m) => `${m.account_id}:${m.matched_on}`);

describe("normName", () => {
  it("folds case, accents, ampersands and punctuation, and drops legal suffixes from the end only", () => {
    expect(normName("Société Générale S.A.")).toBe("societe generale");
    expect(normName("Tallgrass Software, Inc.")).toBe("tallgrass software");
    expect(normName("AT&T")).toBe("at and t");
    expect(normName("Acme Holdings Group LLC")).toBe("acme");
    expect(normName("Group Acme")).toBe("group acme");
    expect(normName("Co")).toBe("co");
  });
});

describe("matchPage", () => {
  it("matches a name as a contiguous run that starts with a capital, and not inside another word", () => {
    const a = [acct("a", "Stripe Inc"), acct("b", "Northwind Software")];
    expect(names("Speakers\nJane Doe, Head of Payments, Stripe\nnorthwind software is hiring", a)).toEqual(["a:name"]);
    expect(names("Pinstripe Partners", a)).toEqual([]);
    expect(names("Northwind Softwarehouse", a)).toEqual([]);
    expect(names("Northwind  Software", a)).toEqual(["b:name"]);
  });

  it("reads accented names and ampersands", () => {
    expect(names("Représentant, Société Générale", [acct("a", "Societe Generale")])).toEqual(["a:name"]);
    expect(names("Bryan from AT&T", [acct("a", "AT&T")])).toEqual(["a:name"]);
  });

  it("matches a domain as a host, its www form or an address host, and not a subdomain", () => {
    const a = [acct("a", "Zeta Co", "zeta.com")];
    expect(names("Visit https://www.zeta.com/partners", a)).toEqual(["a:domain"]);
    expect(names("write to ana@zeta.com", a)).toEqual(["a:domain"]);
    expect(names("status.zeta.com", a)).toEqual([]);
    expect(names("zeta.community", a)).toEqual([]);
  });

  it("tries the domain first, and an ambiguous or very short name only matches on its domain", () => {
    const a = [acct("a", "Square", "squareup.com"), acct("b", "Ab"), acct("c", "Plaid", null)];
    expect(names("Square is a sponsor. Ab too. Plaid.", a)).toEqual([]);
    expect(names("See squareup.com for Square", a)).toEqual(["a:domain"]);
  });

  it("strips tags and decodes entities, and keeps the first line as the quote", () => {
    const html = "<html><style>.x{}</style><body><li><b>Jane</b> of Johnson &amp; Johnson</li><li>Johnson &amp; Johnson again</li></body></html>";
    const m = matchPage(html, [acct("a", "Johnson and Johnson")]);
    expect(m).toEqual([{ account_id: "a", matched_on: "name", quote: "Jane of Johnson & Johnson" }]);
    expect(cleanPage("<p>One</p><p>Two&nbsp;three</p>")).toBe("One\nTwo three");
  });

  it("is the same for the same page and accounts, whatever order the accounts come in", () => {
    const a = [acct("z", "Zeta"), acct("a", "Alpha"), acct("m", "Mid", "mid.com")];
    const page = "Zeta\nAlpha\nmid.com";
    expect(matchPage(page, a)).toEqual(matchPage(page, [...a].reverse()));
    expect(matchPage(page, a).map((m) => m.account_id)).toEqual(["a", "m", "z"]);
  });

  it("cuts a quote to 200 characters", () => {
    expect(matchPage(`Zeta ${"x".repeat(400)}`, [acct("a", "Zeta")])[0].quote).toHaveLength(200);
  });
});

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await db.query("INSERT INTO catalog_events (id, name, starts_on, ends_on, seat_price_cents) VALUES ('c27', 'Payments Summit 2027', '2027-05-01', '2027-05-02', 1000), ('c26', 'Payments Summit 2026', '2026-05-01', '2026-05-02', 1000), ('cx', 'Other Conf 2027', '2027-06-01', '2027-06-02', 1000)");
  await db.query("INSERT INTO target_accounts (id, name, domain, created_by) VALUES ('t1', 'Stripe', 'stripe.com', 'x'), ('t2', 'Tallgrass Software', 'tallgrasssoftware.example', 'x'), ('t3', 'Brightwater Software Inc', NULL, 'x'), ('t4', 'Nowhere Ltd', NULL, 'x')");
});

describe("pages and matches", () => {
  const page = { kind: "sponsor", input: "pasted", text: "Sponsors\nStripe\nhttps://stripe.com\nNowhere Limited\nNorthwind" };

  it("stores a page, matches it, and refuses the same page twice or a long one", async () => {
    const r = await addPage(db, MAYA, "c27", page);
    expect(r).toMatchObject({ counted: 2, rejected: 0 });
    const l = await likelyThere(db, "2026-11-24", "c27");
    expect(l.accounts.map((a) => a.name)).toEqual(["Nowhere Ltd", "Stripe"]);
    expect(l.accounts.find((a) => a.name === "Stripe")!.page).toMatchObject([{ kind: "sponsor", matched_on: "domain", quote: "https://stripe.com" }]);
    await expect(addPage(db, MAYA, "c27", page)).rejects.toThrow("already added");
    await expect(addPage(db, MAYA, "c27", { ...page, text: "x ".repeat(40000) })).rejects.toThrow("longer than");
    await expect(addPage(db, MAYA, "nope", page)).rejects.toThrow("not in the list");
    await expect(addPage(db, MAYA, "c27", { ...page, kind: "other", text: "z" })).rejects.toThrow();
  });

  it("a rejection needs a reason, drops the match from the count, and holds for the event when another page is added", async () => {
    const { id } = await addPage(db, MAYA, "c27", page);
    const [m] = await db.query<{ id: string }>("SELECT id FROM roster_matches WHERE page_id = $1 AND account_id = 't4'", [id]);
    await expect(rejectMatch(db, MAYA, m.id, "  ")).rejects.toThrow("Say why");
    await rejectMatch(db, MAYA, m.id, "A different Nowhere");
    expect((await likelyThere(db, "2026-11-24", "c27")).accounts.map((a) => a.name)).toEqual(["Stripe"]);
    const second = await addPage(db, MAYA, "c27", { kind: "speaker", input: "uploaded", filename: "speakers.html", text: "<li>Nowhere Ltd</li><li>Stripe</li>" });
    expect(second).toMatchObject({ counted: 1, rejected: 1 });
    const [again] = await db.query<{ status: string; rejected_reason: string; rejected_by: string }>("SELECT status, rejected_reason, rejected_by FROM roster_matches WHERE page_id = $1 AND account_id = 't4'", [second.id]);
    expect(again).toEqual({ status: "rejected", rejected_reason: "A different Nowhere", rejected_by: MAYA });
    // Another event is its own: the rejection does not travel.
    const other = await addPage(db, MAYA, "cx", { kind: "speaker", input: "pasted", text: "Nowhere Ltd" });
    expect(other).toMatchObject({ counted: 1, rejected: 0 });
    await restoreMatch(db, MAYA, m.id);
    expect((await likelyThere(db, "2026-11-24", "c27")).accounts.map((a) => a.name)).toEqual(["Nowhere Ltd", "Stripe"]);
    await removePage(db, MAYA, id);
    expect((await db.query("SELECT 1 FROM roster_matches WHERE page_id = $1", [id])).length).toBe(0);
    await expect(removePage(db, MAYA, id)).rejects.toThrow("does not exist");
  });
});

describe("a rejection on two pages", () => {
  it("rejects and restores the account on every page of the conference in one step", async () => {
    const a = await addPage(db, MAYA, "c27", { kind: "sponsor", input: "pasted", text: "Stripe\nNowhere Ltd" });
    const b = await addPage(db, MAYA, "c27", { kind: "speaker", input: "pasted", text: "Nowhere Ltd speaks" });
    const o = await addPage(db, MAYA, "cx", { kind: "speaker", input: "pasted", text: "Nowhere Ltd" });
    const rows = (ids: string[]) => db.query<{ status: string }>("SELECT status FROM roster_matches WHERE account_id = 't4' AND page_id = ANY($1) ORDER BY page_id", [ids]);
    const [m] = await db.query<{ id: string }>("SELECT id FROM roster_matches WHERE page_id = $1 AND account_id = 't4'", [b.id]);
    await rejectMatch(db, MAYA, m.id, "A different Nowhere");
    expect((await rows([a.id, b.id])).map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect((await rows([o.id])).map((r) => r.status)).toEqual(["counted"]);
    expect((await likelyThere(db, "2026-11-24", "c27")).accounts.map((x) => x.name)).toEqual(["Stripe"]);
    await restoreMatch(db, MAYA, m.id);
    expect((await rows([a.id, b.id])).map((r) => r.status)).toEqual(["counted", "counted"]);
  });
});

describe("series", () => {
  it("joins a renamed conference once, with a reason, and refuses chains", async () => {
    expect(await seriesKey(db, "SaaStr AI Annual 2026")).toBe("saastr-ai-annual");
    await expect(addSeriesLink(db, CAMILLE, { name: "SaaStr Annual 2027", same_as: "SaaStr AI Annual 2026", reason: " " })).rejects.toThrow("Say why");
    await addSeriesLink(db, CAMILLE, { name: "SaaStr Annual 2027", same_as: "SaaStr AI Annual 2026", reason: "Renamed for 2027" });
    expect(await seriesKey(db, "SaaStr Annual 2027")).toBe("saastr-ai-annual");
    await expect(addSeriesLink(db, CAMILLE, { name: "SaaStr Europe", same_as: "SaaStr Annual 2027", reason: "x" })).rejects.toThrow("itself linked");
    await expect(addSeriesLink(db, CAMILLE, { name: "SaaStr AI Annual 2026", same_as: "Other", reason: "x" })).rejects.toThrow("already linked");
    await expect(addSeriesLink(db, CAMILLE, { name: "A 2026", same_as: "A 2027", reason: "x" })).rejects.toThrow("already the same");
  });
});

describe("likely there from people already known", () => {
  async function harnessAt(catalogId: string) {
    const h = await deliveredInMotion(db, { crm: fakeCrm(), time: clock("2027-01-10T12:00:00Z") });
    await db.query("UPDATE events SET catalog_id = $2 WHERE id = $1", [h.id, catalogId]);
    return h;
  }

  it("the candidate's own captured people count, once per account, and a prospect never does", async () => {
    const h = await harnessAt("c27");
    let l = await likelyThere(db, "2026-11-24", "c27");
    expect(l.accounts.map((a) => [a.name, a.kinds, a.captured])).toEqual([["Brightwater Software Inc", ["captured"], { people: 1 }], ["Tallgrass Software", ["captured"], { people: 2 }]]);
    expect(l.totals).toEqual({ accounts: 2, by_kind: { page: 0, past: 0, captured: 2 } });
    await db.query("UPDATE contacts SET source = 'prospect' WHERE event_id = $1", [h.id]);
    l = await likelyThere(db, "2026-11-24", "c27");
    expect(l.totals.accounts).toBe(0);
    await db.query("UPDATE contacts SET source = 'onsite' WHERE event_id = $1 AND full_name = 'Ana Ruiz'", [h.id]);
    expect((await likelyThere(db, "2026-11-24", "c27")).accounts.map((a) => a.captured)).toEqual([{ people: 1 }]);
  });

  it("an earlier edition of the series counts as past, through a series link too, and an account counts once however many kinds name it", async () => {
    await harnessAt("c26");
    await addPage(db, MAYA, "c27", { kind: "speaker", input: "pasted", text: "Jane, Tallgrass Software" });
    const l = await likelyThere(db, "2026-11-24", "c27");
    expect(l.past_lists).toBe(1);
    const t = l.accounts.find((a) => a.name === "Tallgrass Software")!;
    expect(t.kinds).toEqual(["page", "past"]);
    expect(t.past).toEqual([{ catalog_id: "c26", name: "Payments Summit 2026" }]);
    expect(l.totals).toEqual({ accounts: 2, by_kind: { page: 1, past: 2, captured: 0 } });
    // A candidate that is not the same conference sees none of it.
    expect((await likelyThere(db, "2026-11-24", "cx")).totals.accounts).toBe(0);
    // A rename joins the series.
    await addSeriesLink(db, CAMILLE, { name: "Other Conf", same_as: "Payments Summit", reason: "Renamed" });
    expect((await likelyThere(db, "2026-11-24", "cx")).totals.by_kind.past).toBe(2);
  });

  it("is refused to a rep and open to a planner over HTTP", async () => {
    const app = createApp(db, { demo: true });
    const post = (who: string) => app.request("/api/choosing/c27/pages", { method: "POST", headers: as(who), body: JSON.stringify({ kind: "sponsor", input: "pasted", text: "Stripe" }) });
    expect((await post(MAYA)).status).toBe(403);
    expect((await post(CAMILLE)).status).toBe(201);
    const [m] = await db.query<{ id: string }>("SELECT id FROM roster_matches");
    expect((await app.request(`/api/choosing/matches/${m.id}/reject`, { method: "POST", headers: as(CAMILLE), body: JSON.stringify({}) })).status).toBe(400);
    expect((await app.request(`/api/choosing/matches/${m.id}/reject`, { method: "POST", headers: as(CAMILLE), body: JSON.stringify({ reason: "No" }) })).status).toBe(200);
    expect((await app.request(`/api/choosing/matches/${m.id}/restore`, { method: "POST", headers: as(CAMILLE) })).status).toBe(200);
    expect((await app.request("/api/choosing/matches/zzz/restore", { method: "POST", headers: as(CAMILLE) })).status).toBe(404);
    expect((await app.request("/api/choosing/series-links", { method: "POST", headers: as(CAMILLE), body: JSON.stringify({ name: "B 2027", same_as: "A 2026", reason: "Renamed" }) })).status).toBe(201);
    const list = await (await app.request("/api/target-accounts", { headers: as(CAMILLE) })).json() as { total: number; by_source: Record<string, number> };
    expect(list.total).toBe(4);
    expect((await app.request("/api/target-accounts", { headers: as(MAYA) })).status).toBe(403);
    const [p] = await db.query<{ id: string }>("SELECT id FROM roster_pages");
    expect((await app.request(`/api/choosing/pages/${p.id}`, { method: "DELETE", headers: as(MAYA) })).status).toBe(403);
    expect((await app.request(`/api/choosing/pages/${p.id}`, { method: "DELETE", headers: as(CAMILLE) })).status).toBe(200);
  });
});
