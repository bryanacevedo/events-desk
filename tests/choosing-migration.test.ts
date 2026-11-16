/* The reasons are the database's rule, not a screen's (docs/CHOOSING.md section 3): NULL, empty and blank are all refused. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { freshDb } from "./helpers.ts";

let db: Db;
beforeEach(async () => {
  db = await freshDb();
  await db.query("INSERT INTO catalog_events (id, name, starts_on, ends_on, seat_price_cents) VALUES ('c1', 'Summit 2027', '2027-05-01', '2027-05-02', 1000)");
  await db.query("INSERT INTO target_accounts (id, name, domain, created_by) VALUES ('t1', 'Stripe', 'stripe.com', 'Maya Ortiz')");
  await db.query("INSERT INTO roster_pages (id, catalog_id, kind, input, body, body_hash, added_by) VALUES ('p1', 'c1', 'sponsor', 'pasted', 'Stripe', 'h1', 'Maya Ortiz')");
});

const REASONS: Array<[string, string | null]> = [["NULL", null], ["empty", ""], ["blank", "   "]];

describe("roster_matches", () => {
  const rejected = (reason: string | null, by: string | null = "Maya Ortiz", at = "now()") => db.query(`INSERT INTO roster_matches (id, page_id, account_id, matched_on, quote, status, rejected_by, rejected_reason, rejected_at) VALUES ('m1', 'p1', 't1', 'name', 'Stripe', 'rejected', $1, $2, ${at})`, [by, reason]);
  for (const [word, v] of REASONS) it(`refuses a rejection with a ${word} reason`, async () => { await expect(rejected(v)).rejects.toThrow(); });
  it("accepts a rejection with a reason, and a counted match with none", async () => {
    await rejected("Not that Stripe");
    await db.query("DELETE FROM roster_matches");
    await db.query("INSERT INTO roster_matches (id, page_id, account_id, matched_on, quote) VALUES ('m2', 'p1', 't1', 'name', 'Stripe')");
  });
  it("refuses a counted match that carries a whole rejection", async () => {
    await expect(db.query("INSERT INTO roster_matches (id, page_id, account_id, matched_on, quote, status, rejected_by, rejected_reason, rejected_at) VALUES ('m3', 'p1', 't1', 'name', 'x', 'counted', 'Maya Ortiz', 'why', now())")).rejects.toThrow();
  });
  it("refuses a rejection with no rejected_by or no rejected_at", async () => {
    await expect(rejected("why", null)).rejects.toThrow();
    await expect(rejected("why", "Maya Ortiz", "NULL")).rejects.toThrow();
  });
});

describe("series_links", () => {
  const link = (reason: string | null, alias = "a", series = "b") => db.query("INSERT INTO series_links (alias_key, series_key, reason, created_by) VALUES ($1, $2, $3, 'Maya Ortiz')", [alias, series, reason]);
  for (const [word, v] of REASONS) it(`refuses a ${word} reason`, async () => { await expect(link(v)).rejects.toThrow(); });
  it("refuses a link to itself, and takes a real one", async () => {
    await expect(link("why", "a", "a")).rejects.toThrow();
    await link("Renamed for 2027");
  });
});

describe("repeat_decisions", () => {
  const decide = (decision: string, reason: string | null) => db.query("INSERT INTO repeat_decisions (id, series_key, decision, reason, decided_by) VALUES ($1, 's', $2, $3, 'Dan Whitlock')", [crypto.randomUUID(), decision, reason]);
  for (const [word, v] of REASONS) it(`refuses a drop with a ${word} reason`, async () => { await expect(decide("drop", v)).rejects.toThrow(); });
  it("takes a drop with a reason, and a repeat with none", async () => {
    await decide("drop", "Too far from our buyers");
    await decide("repeat", null);
  });
  it("refuses a decision that is neither", async () => { await expect(decide("maybe", "x")).rejects.toThrow(); });
});

describe("pages", () => {
  it("refuses a body over 60,000 characters and the same body twice for one event", async () => {
    await expect(db.query("INSERT INTO roster_pages (id, catalog_id, kind, input, body, body_hash, added_by) VALUES ('p2', 'c1', 'sponsor', 'pasted', repeat('a', 60001), 'h2', 'x')")).rejects.toThrow();
    await expect(db.query("INSERT INTO roster_pages (id, catalog_id, kind, input, body, body_hash, added_by) VALUES ('p3', 'c1', 'sponsor', 'pasted', 'Stripe', 'h1', 'x')")).rejects.toThrow();
  });
});
