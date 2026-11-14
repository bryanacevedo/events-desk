/* Luma and Splash imports, and the target account list (docs/HOSTED.md 13, 14, 21.9, 21.17). */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { checkIn, closeAttendance } from "../src/server/hosted.ts";
import { importGuests, importTargetAccounts } from "../src/server/guest-import.ts";
import { suggestions } from "../src/server/hosted-view.ts";
import { freshDb } from "./helpers.ts";
import { AFTER, BEFORE, depsAt, guest, hostedDinner, ON_THE_DAY, statusOf, yes } from "./hosted-helpers.ts";
import { CAMILLE, MAYA } from "./plan-helpers.ts";

const LUMA = `name,first_name,last_name,email,approval_status,checked_in_at,ticket_name,created_at,country,company
Ana Ruiz,Ana,Ruiz,Ana@Acme.example,approved,,General,2027-05-01T10:00:00Z,US,Acme
Ben Cole,Ben,Cole,ben@beta.example,declined,,General,2027-05-02T10:00:00Z,US,Beta
Cara Fox,,,cara@gamma.example,pending,,General,2027-05-03T10:00:00Z,,
Dan Lee,,,dan@delta.example,,2027-06-10T19:00:00Z,General,2027-05-03T10:00:00Z,GB,Delta
,,,,,General,,,
Eve Ray,,,eve@eps.example,maybe,,General,,,
No Email,,,,approved,,General,,,Zeta
`;
const SPLASH = `First Name,Last Name,Email,Company,Title,Status,Attended
Ana,Ruiz,ana@acme.example,Acme,CRO,Registered,Yes
Gus,Hall,gus@eta.example,Eta,VP,Not attending,
Hal,Ives,hal@theta.example,Theta,CMO,Waitlisted,
Ida,Jones,ida@iota.example,Iota,CFO,Registered,No
`;

describe("Luma", () => {
  it("reads headers by name, maps statuses, skips what it cannot read and says why, and owns every guest to the importer", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    const r = await importGuests(db, depsAt(BEFORE), MAYA, id, "luma", LUMA);
    expect(r).toMatchObject({ rows: 7, added: 5, already_there: 0, skipped_empty: 1 });
    expect(r.skipped).toEqual([{ row: 7, why: "Unknown status: maybe" }]);
    const guests = await db.query<{ name: string; status: string; email: string | null; owner: string; source: string; country: string | null; checked_in_by: string | null }>("SELECT name, status, email, owner, source, country, checked_in_by FROM event_guests WHERE event_id = $1 ORDER BY name", [id]);
    expect(guests.map((g) => [g.name, g.status, g.email])).toEqual([
      ["Ana Ruiz", "registered", "ana@acme.example"], ["Ben Cole", "declined", "ben@beta.example"], ["Cara Fox", "waitlist", "cara@gamma.example"], ["Dan Lee", "attended", "dan@delta.example"], ["No Email", "registered", null],
    ]);
    expect(guests.every((g) => g.owner === MAYA && g.source === "luma")).toBe(true);
    expect(guests.find((g) => g.name === "Dan Lee")).toMatchObject({ checked_in_by: MAYA, country: "GB" });
    expect(guests.find((g) => g.name === "Cara Fox")!.country).toBeNull();
    expect((await db.query("SELECT detail FROM guest_log WHERE event_id = $1 AND kind = 'import'", [id]))).toHaveLength(1);
  });

  it("a second import moves a guest forward only, and counts the rest as already there", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    await importGuests(db, depsAt(BEFORE), MAYA, id, "luma", LUMA);
    const again = `name,email,approval_status,checked_in_at
Ana Ruiz,ana@acme.example,approved,2027-06-10T18:45:00Z
Ben Cole,ben@beta.example,approved,
Cara Fox,cara@gamma.example,approved,
Dan Lee,dan@delta.example,pending,
`;
    const r = await importGuests(db, depsAt(ON_THE_DAY), MAYA, id, "luma", again);
    expect(r).toMatchObject({ added: 0, already_there: 4, moved_forward: 2 });
    const st = async (e: string) => (await db.query<{ status: string }>("SELECT status FROM event_guests WHERE event_id = $1 AND email = $2", [id, e]))[0].status;
    expect(await st("ana@acme.example")).toBe("attended");
    expect(await st("ben@beta.example")).toBe("declined");
    expect(await st("cara@gamma.example")).toBe("registered");
    expect(await st("dan@delta.example")).toBe("attended");
  });

  it("a name-only duplicate counts as already there, and a webinar's attendance arrives in a second import", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { format: "webinar", capacity: 100 });
    await importGuests(db, depsAt(BEFORE), MAYA, id, "luma", "name,approval_status,company\nNo Email,approved,Zeta\nNo Email,approved,Zeta\n");
    expect((await db.query("SELECT 1 FROM event_guests WHERE event_id = $1", [id])).length).toBe(1);
    await importGuests(db, depsAt(BEFORE), MAYA, id, "luma", "name,email,approval_status\nWendy Web,w@web.example,approved\n");
    const r = await importGuests(db, depsAt(AFTER), MAYA, id, "luma", "name,email,approval_status,checked_in_at\nWendy Web,w@web.example,approved,2027-06-10T17:00:00Z\n");
    expect(r.moved_forward).toBe(1);
    expect((await db.query("SELECT status FROM event_guests WHERE email = 'w@web.example'"))[0].status).toBe("attended");
  });

  it("refuses a file that is not a Luma export, an empty file, and a bad source", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db);
    await expect(importGuests(db, depsAt(BEFORE), MAYA, id, "luma", "foo,bar\n1,2\n")).rejects.toThrow(/Luma/);
    await expect(importGuests(db, depsAt(BEFORE), MAYA, id, "luma", "")).rejects.toThrow(/empty/);
    await expect(importGuests(db, depsAt(BEFORE), MAYA, id, "eventbrite", LUMA)).rejects.toThrow(/luma or splash/);
  });
});

describe("Splash", () => {
  it("maps Registered, Not attending, Waitlisted and Attended, and a blank status is not guessed", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    const r = await importGuests(db, depsAt(BEFORE), MAYA, id, "splash", SPLASH + "Jo,Kay,jo@kappa.example,Kappa,CEO,,\nLu,Mo,lu@mu.example,Mu,COO,Dinner guest,\n");
    expect(r).toMatchObject({ added: 4 });
    expect(r.skipped).toEqual([{ row: 6, why: "No status" }, { row: 7, why: "Unknown status: dinner guest" }]);
    const st = Object.fromEntries((await db.query<{ email: string; status: string; title: string }>("SELECT email, status, title FROM event_guests WHERE event_id = $1", [id])).map((g) => [g.email, g.status]));
    expect(st).toEqual({ "ana@acme.example": "attended", "gus@eta.example": "declined", "hal@theta.example": "waitlist", "ida@iota.example": "registered" });
  });

  it("capacity is not enforced on an import, and a registered guest the import marks attended is not a no-show at closing", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 1 });
    await importGuests(db, depsAt(BEFORE), MAYA, id, "splash", "First Name,Last Name,Email,Status\nA,One,a@x.example,Registered\nB,Two,b@x.example,Registered\n");
    expect((await db.query("SELECT 1 FROM event_guests WHERE event_id = $1 AND status = 'registered'", [id])).length).toBe(2);
    const g = (await db.query<{ id: string }>("SELECT id FROM event_guests WHERE email = 'a@x.example'"))[0].id;
    await checkIn(db, depsAt(ON_THE_DAY), CAMILLE, id, g);
    await closeAttendance(db, depsAt(AFTER), CAMILLE, id);
    expect(await statusOf(db, g)).toBe("attended");
  });
});

describe("imports are uploads", () => {
  it("the public demo refuses both, and a write needs an actor and the key", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db);
    const pub = createApp(db, { demo: true, publicDemo: true, writeKey: "k" });
    const h = { "x-actor": encodeURIComponent(CAMILLE), "x-write-key": "k", "content-type": "text/csv" };
    for (const path of [`/api/events/${id}/guests/import?source=luma`, "/api/target-accounts/import"]) {
      const r = await pub.request(path, { method: "POST", headers: h, body: LUMA });
      expect(r.status, path).toBe(403);
      expect((await r.json() as any).error).toMatch(/does not take files/);
    }
    const open = createApp(db, { demo: true, writeKey: "k" });
    expect((await open.request(`/api/events/${id}/guests/import?source=luma`, { method: "POST", headers: { "content-type": "text/csv" }, body: LUMA })).status).toBe(401);
    const ok = await open.request(`/api/events/${id}/guests/import?source=luma`, { method: "POST", headers: h, body: LUMA });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).added).toBe(5);
    // The file-route size class: more than 1 MB is accepted here, not refused as "Too large".
    const big = "name,email,approval_status\n" + "x".repeat(1_200_000);
    expect((await open.request(`/api/events/${id}/guests/import?source=luma`, { method: "POST", headers: h, body: big })).status).not.toBe(413);
  });
});

describe("target accounts and suggestions", () => {
  it("imports accounts, lists those with a deal or an owner that are not on the list, and never adds a person without an owner", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    const r = await importTargetAccounts(db, CAMILLE, "name,domain,country,owner,open_deal,deal_stage\nAcme,https://www.Acme.example/x,US,Maya Ortiz,Acme renewal,Proposal\nBeta,beta.example,US,,,\nGamma,,GB,Leo Marsh,,\n,x.example,,,,\n");
    expect(r).toMatchObject({ added: 3, updated: 0 });
    expect(r.skipped).toEqual([{ row: 5, why: "No name" }]);
    expect((await db.query("SELECT domain FROM target_accounts WHERE name = 'Acme'"))[0].domain).toBe("acme.example");
    expect((await importTargetAccounts(db, CAMILLE, "name,owner\nBeta,Leo Marsh\n"))).toMatchObject({ added: 0, updated: 1 });
    const s = await suggestions(db, id);
    expect(s.accounts.map((a) => [a.name, a.owner])).toEqual([["Acme", "Maya Ortiz"], ["Beta", "Leo Marsh"], ["Gamma", "Leo Marsh"]]);
    const acme = s.accounts[0];
    const app = createApp(db, { demo: true });
    const h = { "x-actor": encodeURIComponent(CAMILLE), "content-type": "application/json" };
    const add = await app.request(`/api/events/${id}/guests`, { method: "POST", headers: h, body: JSON.stringify({ name: "Ana Ruiz", account_id: acme.id, source: "account" }) });
    expect(add.status).toBe(201);
    expect((await db.query("SELECT owner, company FROM event_guests WHERE event_id = $1", [id]))[0]).toEqual({ owner: "Maya Ortiz", company: "Acme" });
    expect((await suggestions(db, id)).accounts.map((a) => a.name)).toEqual(["Beta", "Gamma"]);
    expect((await app.request("/api/target-accounts", { method: "POST", headers: { ...h, "x-actor": encodeURIComponent("Priya Natarajan") }, body: JSON.stringify({ name: "Nope" }) })).status).toBe(403);
  });

  it("an AE nominates a guest and becomes the owner; a rep cannot name another owner", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db);
    const app = createApp(db, { demo: true });
    const as = (who: string) => ({ "x-actor": encodeURIComponent(who), "content-type": "application/json" });
    const r = await app.request(`/api/events/${id}/guests`, { method: "POST", headers: as("Priya Natarajan"), body: JSON.stringify({ name: "Ned Nom", email: "ned@nom.example", country: "US", owner: "Someone Else" }) });
    expect(r.status).toBe(403);
    const ok = await app.request(`/api/events/${id}/guests`, { method: "POST", headers: as("Priya Natarajan"), body: JSON.stringify({ name: "Ned Nom", email: "ned@nom.example", country: "US", source: "account" }) });
    expect(ok.status).toBe(201);
    expect((await db.query("SELECT owner, nominated_by, source FROM event_guests WHERE event_id = $1", [id]))[0]).toEqual({ owner: "Priya Natarajan", nominated_by: "Priya Natarajan", source: "nomination" });
    void guest; void yes;
  });
});

describe("an import row with an email matches a guest who has none", () => {
  it("fills the email in by name and company instead of duplicating", async () => {
    const db = await freshDb();
    const id = await hostedDinner(db, { capacity: 10 });
    const g = await guest(db, id, "Ana Ruiz", { email: undefined, company: "Acme" });
    const r = await importGuests(db, depsAt(BEFORE), CAMILLE, id, "luma", "name,email,approval_status,company\nAna Ruiz,ana@acme.example,approved,Acme\n");
    expect(r).toMatchObject({ added: 0, already_there: 1 });
    expect((await db.query<{ email: string }>("SELECT email FROM event_guests WHERE id = $1", [g.id]))[0].email).toBe("ana@acme.example");
    expect((await db.query("SELECT 1 FROM event_guests WHERE event_id = $1", [id])).length).toBe(1);
  });
});

describe("country names", () => {
  it("only the known codes and names count, and UK is GB", async () => {
    const { normalizeCountry } = await import("../src/shared/country-rules.ts");
    expect(["uk", "GB", "us", "Germany", "ZZ", "XX", "Atlantis", ""].map(normalizeCountry)).toEqual(["GB", "GB", "US", "DE", null, null, null, null]);
  });
});
