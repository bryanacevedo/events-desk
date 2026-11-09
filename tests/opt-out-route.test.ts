/* The opt-out path the person panel and the Settings tray use: POST /api/suppressions with an email, or a name at a company,
   takes the person off every list they are still on under the drop reason opted_out, and GET /api/suppressions lists it with
   who recorded it, the reason and the name and company as typed. Anyone who can act can record one. */

import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { deliverEvent, freshDb } from "./helpers.ts";

const LIST = "Company,Name,Title,Email\nAcme,Ada Lovelace,VP Sales,ada@acme.com\nKestrel Foods,Bo Lindqvist,Head of Growth,bo@kestrel.example\n";
const as = (actor: string) => ({ "x-actor": encodeURIComponent(actor), "content-type": "application/json" });
let db: Db;
const app = () => createApp(db, { demo: true });

interface OptOut { id: string; email: string | null; name: string | null; company: string | null; reason: string; created_by: string | null; created_at: string }

describe("opting someone out from the app", () => {
  beforeEach(async () => { db = await freshDb(); });

  it("by email: removes them from every list with the reason opted_out, and the tray lists who recorded it", async () => {
    const a = await deliverEvent(db, LIST, {}, "One");
    const b = await deliverEvent(db, LIST, {}, "Two");
    const kept = await db.query<{ id: string; email: string }>("SELECT id, email FROM contacts WHERE dropped_at IS NULL AND email IS NOT NULL AND event_id = ANY($1) ORDER BY email", [[a, b]]);
    expect(kept.length).toBeGreaterThan(0);
    const email = kept[0].email;
    const n = kept.filter((k) => k.email === email).length;

    const r = await app().request("/api/suppressions", { method: "POST", headers: as("Maya Ortiz"), body: JSON.stringify({ email, reason: "Asked at the booth" }) });
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ recorded: true, removed: n });

    const rows = await db.query<{ drop_reason: string | null; dropped_at: string | null }>("SELECT drop_reason, dropped_at FROM contacts WHERE lower(email) = $1", [email]);
    expect(rows.length).toBe(n);
    for (const row of rows) { expect(row.drop_reason).toBe("opted_out"); expect(row.dropped_at).not.toBeNull(); }

    const list = (await (await app().request("/api/suppressions")).json()) as { opt_outs: OptOut[] };
    expect(list.opt_outs).toHaveLength(1);
    expect(list.opt_outs[0]).toMatchObject({ email, name: null, company: null, reason: "Asked at the booth", created_by: "Maya Ortiz" });
    expect(list.opt_outs[0].created_at).toBeTruthy();
  });

  it("by name at a company: keeps the words as typed and matches on the keys", async () => {
    const id = await deliverEvent(db, LIST, {}, "One");
    const r = await app().request("/api/suppressions", { method: "POST", headers: as("GTM Team"), body: JSON.stringify({ name: "Lovelace, Ada", company: "ACME Inc." }) });
    expect(r.status).toBe(201);
    const [ada] = await db.query<{ drop_reason: string | null }>("SELECT drop_reason FROM contacts WHERE event_id = $1 AND full_name = 'Ada Lovelace'", [id]);
    expect(ada.drop_reason).toBe("opted_out");
    const list = (await (await app().request("/api/suppressions")).json()) as { opt_outs: OptOut[] };
    expect(list.opt_outs[0]).toMatchObject({ email: null, name: "Lovelace, Ada", company: "ACME Inc.", reason: "", created_by: "GTM Team" });
  });

  it("refuses an address that is not one, and a name without a company", async () => {
    const bad = await app().request("/api/suppressions", { method: "POST", headers: as("Maya Ortiz"), body: JSON.stringify({ email: "not an address" }) });
    expect(bad.status).toBe(409);
    const half = await app().request("/api/suppressions", { method: "POST", headers: as("Maya Ortiz"), body: JSON.stringify({ name: "Ada Lovelace" }) });
    expect(half.status).toBe(409);
    expect(((await (await app().request("/api/suppressions")).json()) as { opt_outs: OptOut[] }).opt_outs).toHaveLength(0);
  });
});
