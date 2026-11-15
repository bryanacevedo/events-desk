/* The capture key and the two routes the extension uses (docs/DIRECTORY.md 5 and 13): who gets in, what a send does, what the server decides by itself, and the caps. */

import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { captureAdd, authCapture, createCaptureKey, listCaptureKeys, revokeCaptureKey } from "../src/server/directory.ts";
import { freshDb } from "./helpers.ts";
import { approvedEvent, as, bearer, confirmTerms, count, DAN, GTM, keyFor, LEO, MAYA, person, send } from "./directory-helpers.ts";

const WRITE = "team-write-key";
let db: Db, ev: string, app: ReturnType<typeof createApp>;
const post = (key: string, body: unknown) => send(app, "/api/capture/people", key, body);
const reads = (where = "TRUE") => db.query<any>(`SELECT * FROM directory_reads WHERE event_id = $1 AND ${where} ORDER BY created_at, id`, [ev]);

beforeAll(async () => {
  db = await freshDb();
  app = createApp(db, { demo: true, writeKey: WRITE });
  ev = await approvedEvent(db, "AWS re:Invent 2026");
});

describe("the key", () => {
  it("is made once, shown once, stored only as a hash, and listed without its text", async () => {
    const made = await (await app.request("/api/capture-keys", { method: "POST", headers: as(MAYA, { "x-write-key": WRITE }), body: JSON.stringify({ label: "Home laptop" }) })).json() as any;
    expect(made.key).toMatch(/^edk_[A-Za-z0-9_-]{43}$/);
    expect(made.tail).toBe(made.key.slice(-4));
    const [row] = await db.query<any>("SELECT * FROM capture_keys WHERE id = $1", [made.id]);
    expect(row.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(made.key);
    expect(row.scope).toBe("add_people");
    const list = await (await app.request("/api/capture-keys", { headers: as(MAYA) })).json() as any;
    expect(list.keys.some((k: any) => k.id === made.id && k.label === "Home laptop" && k.state === "in use")).toBe(true);
    expect(JSON.stringify(list)).not.toContain(made.key);
    expect((await (await app.request("/api/capture-keys", { headers: as(LEO) })).json() as any).keys.some((k: any) => k.id === made.id)).toBe(false);
  });
  it("needs a name, and the write key and acting name like any write", async () => {
    expect((await app.request("/api/capture-keys", { method: "POST", headers: as(MAYA, { "x-write-key": WRITE }), body: "{}" })).status).toBe(400);
    expect((await app.request("/api/capture-keys", { method: "POST", headers: as(MAYA), body: JSON.stringify({ label: "x" }) })).status).toBe(401);
    expect((await app.request("/api/capture-keys", { method: "POST", headers: { "x-write-key": WRITE, "content-type": "application/json" }, body: JSON.stringify({ label: "x" }) })).status).toBe(400);
  });
  it("is at most five in use for one person, and revoking one frees a place", async () => {
    const owner = "Five Keys";
    const keys = [];
    for (let i = 0; i < 5; i++) keys.push(await createCaptureKey(db, owner, `k${i}`));
    await expect(createCaptureKey(db, owner, "sixth")).rejects.toThrow(/already have 5/);
    await revokeCaptureKey(db, owner, keys[0].id);
    expect((await createCaptureKey(db, owner, "again")).key).toMatch(/^edk_/);
    expect((await listCaptureKeys(db, owner)).filter((k) => k.state === "in use")).toHaveLength(5);
  });
  it("is revoked by its owner or GTM Engineering, and by no one else", async () => {
    const k = await keyFor(db, MAYA, "to revoke");
    expect((await app.request(`/api/capture-keys/${k.id}`, { method: "DELETE", headers: as(LEO, { "x-write-key": WRITE }) })).status).toBe(403);
    expect((await app.request(`/api/capture-keys/${k.id}`, { method: "DELETE", headers: as(GTM, { "x-write-key": WRITE }) })).status).toBe(200);
    const [row] = await db.query<any>("SELECT revoked_at, revoked_by FROM capture_keys WHERE id = $1", [k.id]);
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_by).toBe(GTM);
    expect((await app.request("/api/capture-keys/nope", { method: "DELETE", headers: as(MAYA, { "x-write-key": WRITE }) })).status).toBe(404);
  });
});

describe("a send in flight", () => {
  it("is refused when its key was revoked after it was checked, and adds nothing", async () => {
    const e = await approvedEvent(db, "Revoke Mid Send");
    const k = await keyFor(db, MAYA, "mid");
    const checked = await authCapture(db, `Bearer ${k.key}`);
    await revokeCaptureKey(db, MAYA, k.id);
    await expect(captureAdd(db, checked, { event_id: e, platform: "swapcard", people: [person("Ana Lima")] }, new Date("2026-11-14T12:00:00Z"))).rejects.toThrow(/revoked/);
    expect(await count(db, "directory_reads", `event_id = '${e}'`)).toBe(0);
  });
  it("spends nothing of the minute's allowance when the event refuses the send", async () => {
    const e = await approvedEvent(db, "Minute Event");
    const k = await keyFor(db, MAYA, "minute");
    const key = await authCapture(db, `Bearer ${k.key}`);
    const now = new Date("2026-11-14T12:00:00Z");
    const many = (tag: string) => Array.from({ length: 200 }, (_, i) => person(`${tag} Person${i}`, { company: `Co ${tag} ${i}` }));
    for (let i = 0; i < 4; i++) await expect(captureAdd(db, key, { event_id: "ev_nope", platform: "swapcard", people: many(`x${i}`) }, now)).rejects.toThrow(/not on this desk/);
    expect((await captureAdd(db, key, { event_id: e, platform: "swapcard", people: many("good") }, now)).added).toBe(200);
  });
});

describe("who gets in", () => {
  it("refuses a missing, malformed, unknown, revoked and wrong-scope key, each in its own sentence", async () => {
    const good = await keyFor(db, MAYA, "good");
    const noHeader = await app.request("/api/capture/events");
    expect(noHeader.status).toBe(401);
    expect((await noHeader.json() as any).error).toMatch(/Authorization: Bearer/);
    const sentences = new Set<string>();
    const tries: [string, string][] = [["Bearer nonsense", "That is not a capture key"], [`Bearer edk_${"a".repeat(43)}`, "does not know that capture key"], [`Basic ${good.key}`, "That is not a capture key"]];
    for (const [h, want] of tries) {
      const r = await app.request("/api/capture/events", { headers: { authorization: h } });
      expect(r.status).toBe(401);
      const e = (await r.json() as any).error as string;
      expect(e).toContain(want);
      sentences.add(e);
    }
    const revoked = await keyFor(db, MAYA, "gone");
    await revokeCaptureKey(db, MAYA, revoked.id);
    const r = await app.request("/api/capture/events", { headers: bearer(revoked.key) });
    expect(r.status).toBe(401);
    expect((await r.json() as any).error).toMatch(/revoked/);
    // A future second scope must not be read as this one.
    const other = await keyFor(db, MAYA, "other scope");
    await db.exec("ALTER TABLE capture_keys DROP CONSTRAINT capture_keys_scope_check");
    await db.query("UPDATE capture_keys SET scope = 'read_people' WHERE id = $1", [other.id]);
    const w = await app.request("/api/capture/events", { headers: bearer(other.key) });
    expect(w.status).toBe(401);
    expect((await w.json() as any).error).toMatch(/cannot add people/);
    await db.query("DELETE FROM capture_keys WHERE scope <> 'add_people'");
    await db.exec("ALTER TABLE capture_keys ADD CONSTRAINT capture_keys_scope_check CHECK (scope = 'add_people')");
    expect(sentences.size).toBeGreaterThanOrEqual(2);
    expect((await app.request("/api/capture/events", { headers: bearer(good.key) })).status).toBe(200);
  });
  it("a key reaches nothing outside the two capture routes, and the write routes still ask for the write key", async () => {
    const k = await keyFor(db, MAYA, "reach");
    const h = { ...bearer(k.key), "x-actor": "Maya%20Ortiz" };
    for (const [method, path] of [["POST", `/api/events/${ev}/upload`], ["POST", "/api/capture-keys"], ["POST", "/api/suppressions"], ["POST", `/api/events/${ev}/directory/bring-in`], ["POST", "/api/capture/other"], ["DELETE", `/api/capture-keys/${k.id}`], ["PATCH", `/api/events/${ev}/settings`], ["POST", "/api/capture/events"], ["DELETE", "/api/capture/people"]] as const) {
      const r = await app.request(path, { method, headers: h, body: method === "POST" ? "{}" : undefined });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
    expect((await app.request("/api/capture/people", { method: "PUT", headers: h, body: "{}" })).status).toBe(401);
  });
  it("the actor of a capture is the key's owner, not a header", async () => {
    const k = await keyFor(db, "Priya Natarajan", "p");
    const e2 = await approvedEvent(db, "Owner Test");
    const r = await app.request("/api/capture/people", { method: "POST", headers: { ...bearer(k.key), "x-actor": "Someone%20Else" }, body: JSON.stringify({ event_id: e2, platform: "swapcard", people: [person("Ana Lima")] }) });
    expect(r.status).toBe(200);
    expect((await db.query<any>("SELECT read_by FROM directory_reads WHERE event_id = $1", [e2]))[0].read_by).toBe("Priya Natarajan");
  });
  it("last use is written at most once a minute", async () => {
    const k = await keyFor(db, MAYA, "stamp");
    const key = await authCapture(db, `Bearer ${k.key}`);
    const first = (await db.query<any>("SELECT last_used_at FROM capture_keys WHERE id = $1", [key.id]))[0].last_used_at;
    expect(first).not.toBeNull();
    await authCapture(db, `Bearer ${k.key}`);
    expect((await db.query<any>("SELECT last_used_at FROM capture_keys WHERE id = $1", [key.id]))[0].last_used_at).toBe(first);
  });
});

describe("the events to choose from", () => {
  it("lists events that can still take a list, with a count of reads, and no money and no people", async () => {
    const k = await keyFor(db, MAYA, "events");
    const mapped = await approvedEvent(db, "Mapped Event");
    await db.query("UPDATE events SET stage = 'mapped' WHERE id = $1", [mapped]);
    const late = await approvedEvent(db, "Late Event");
    await db.query("UPDATE events SET stage = 'tiering' WHERE id = $1", [late]);
    const hosted = await approvedEvent(db, "Hosted Dinner");
    await db.query("INSERT INTO hosted_events (event_id) VALUES ($1)", [hosted]);
    await post(k.key, { event_id: ev, platform: "swapcard", people: [person("Ana Lima")] });
    const out = await (await app.request("/api/capture/events", { headers: bearer(k.key) })).json() as any;
    const names = out.events.map((e: any) => e.name);
    expect(names).toContain("AWS re:Invent 2026");
    expect(names).toContain("Mapped Event");
    expect(names).not.toContain("Late Event");
    expect(names).not.toContain("Hosted Dinner");
    const mine = out.events.find((e: any) => e.id === ev);
    expect(Object.keys(mine).sort()).toEqual(["id", "name", "reads", "stage", "starts_on", "venue"]);
    expect(mine.reads).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(out)).not.toMatch(/seat_price|cents|email/);
  });
});

describe("a send", () => {
  it("adds people, counts the ones it has already, and holds the doubtful ones to check", async () => {
    const e = await approvedEvent(db, "Send Event");
    const k = await keyFor(db, MAYA, "send");
    const a = await (await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: [person("Ana Lima"), person("Madonna"), { name: "Bo Quinn" }] })).json() as any;
    expect(a).toMatchObject({ added: 3, already_in: 0, to_check: 2 });
    const b = await (await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: [person("Ana Lima"), person("Cy Ruiz")] })).json() as any;
    expect(b).toMatchObject({ added: 1, already_in: 1, to_check: 0 });
    expect(await count(db, "directory_reads", `event_id = '${e}'`)).toBe(4);
    const rows = await db.query<any>("SELECT full_name, state, check_reason FROM directory_reads WHERE event_id = $1 ORDER BY full_name", [e]);
    expect(rows.find((r) => r.full_name === "Madonna")).toMatchObject({ state: "to_check", check_reason: "Name is one word" });
    expect(rows.find((r) => r.full_name === "Bo Quinn")).toMatchObject({ state: "to_check", check_reason: "No title or company" });
  });
  it("a second send of one person fills only the empty fields and never changes state or a person's decision", async () => {
    const e = await approvedEvent(db, "Merge Event");
    const k = await keyFor(db, MAYA, "merge");
    await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: [{ name: "Ana Lima", company: "Orrery" }] });
    await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: [{ name: "Ana Lima", company: "Orrery", title: "CFO", location: "Lisbon, Portugal" }, person("Ana Lima", { title: "Not this one" })] });
    const [r] = await db.query<any>("SELECT * FROM directory_reads WHERE event_id = $1", [e]);
    expect(r).toMatchObject({ title: "CFO", location: "Lisbon, Portugal", state: "staged" });
    await db.query("UPDATE directory_reads SET state = 'dismissed' WHERE id = $1", [r.id]);
    await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: [person("Ana Lima")] });
    expect((await db.query<any>("SELECT state FROM directory_reads WHERE event_id = $1", [e]))[0].state).toBe("dismissed");
  });
  it("a read that was to check stays to check when a later send is sure of it", async () => {
    const e = await approvedEvent(db, "Promote Event");
    const k = await keyFor(db, MAYA, "promote");
    await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: [{ name: "Ana Lima" }] });
    await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: [person("Ana Lima")] });
    // The same person by name and company is another key until a company arrives: the first read stays to check.
    expect((await db.query<any>("SELECT state FROM directory_reads WHERE event_id = $1 AND company IS NULL", [e]))[0].state).toBe("to_check");
  });
  it("the source sentence and the terms note come from the server, whatever the body says", async () => {
    const e = await approvedEvent(db, "Source Event");
    await confirmTerms(db, e, "Attendee data may not be copied");
    const k = await keyFor(db, "Maya Ortiz", "source");
    await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", source_text: "read by the Pope", terms_note: "All fine", read_by: "Dan Whitlock", read_on: "1999-01-01", people: [{ ...person("Ana Lima"), source_text: "forged", read_by: "Dan Whitlock", state: "brought_in" }] });
    const [r] = await db.query<any>("SELECT *, read_on::text AS on FROM directory_reads WHERE event_id = $1", [e]);
    expect(r.source_text).toBe(`read from the Swapcard directory of Source Event by Maya Ortiz on ${new Date().toISOString().slice(0, 10)}`);
    expect(r.terms_note).toBe("Terms: Attendee data may not be copied");
    expect(r).toMatchObject({ read_by: "Maya Ortiz", state: "staged", via: "extension", platform: "swapcard" });
    const e2 = await approvedEvent(db, "No Terms Event");
    await send(app, "/api/capture/people", k.key, { event_id: e2, platform: "brella", people: [person("Cy Ruiz")] });
    expect((await db.query<any>("SELECT terms_note, source_text FROM directory_reads WHERE event_id = $1", [e2]))[0]).toMatchObject({ terms_note: "Terms not assessed", source_text: expect.stringContaining("Brella directory") });
  });
  it("trims, strips control characters, cuts to 200, and skips a person with no name", async () => {
    const e = await approvedEvent(db, "Clean Event");
    const k = await keyFor(db, MAYA, "clean");
    const r = await (await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: [{ name: "  Ana\u0000 \u0007Lima ", title: "x".repeat(400), company: "Orrery\n" }, { name: "   " }, null, "text"] })).json() as any;
    expect(r).toMatchObject({ added: 1, skipped: 3 });
    const [row] = await db.query<any>("SELECT * FROM directory_reads WHERE event_id = $1", [e]);
    expect(row.full_name).toBe("Ana Lima");
    expect(row.title).toHaveLength(200);
    expect(row.company).toBe("Orrery");
  });
  it("keeps a profile link only on a platform host, dropping the link and not the person", async () => {
    const e = await approvedEvent(db, "Link Event");
    const k = await keyFor(db, MAYA, "links");
    await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: [
      person("Ana Lima", { profile_url: "https://app.swapcard.com/event/x/person/abc?ref=1#z" }), person("Ben Ode", { profile_url: "https://evil.example/person/abc" }), person("Cy Ruiz", { profile_url: "http://app.swapcard.com/person/c" }), person("Di Park", { profile_url: "https://www.linkedin.com/in/di-park/" })] });
    const rows = await db.query<any>("SELECT full_name, profile_url, dedupe_key FROM directory_reads WHERE event_id = $1 ORDER BY full_name", [e]);
    expect(rows.map((r) => r.profile_url)).toEqual(["https://app.swapcard.com/event/x/person/abc", null, null, "https://www.linkedin.com/in/di-park"]);
    expect(rows[0].dedupe_key).toBe("u:https://app.swapcard.com/event/x/person/abc");
    expect(rows[1].dedupe_key).toMatch(/^n:/);
  });
  it("answers one plain sentence for an unknown platform, no people, an unknown event, an event that cannot take a list", async () => {
    const k = await keyFor(db, MAYA, "refusals");
    const late = await approvedEvent(db, "Too Late");
    await db.query("UPDATE events SET stage = 'delivered' WHERE id = $1", [late]);
    const cases: [unknown, number, RegExp][] = [
      [{ event_id: ev, platform: "myspace", people: [person("A B")] }, 400, /platform/],
      [{ event_id: ev, platform: "swapcard", people: [] }, 400, /at least one/],
      [{ event_id: ev, platform: "swapcard" }, 400, /at least one/],
      [{ event_id: "evt_nope", platform: "swapcard", people: [person("A B")] }, 409, /not on this desk/],
      [{ event_id: late, platform: "swapcard", people: [person("A B")] }, 409, /cannot take a list/],
    ];
    for (const [body, status, want] of cases) {
      const r = await send(app, "/api/capture/people", k.key, body);
      expect(r.status).toBe(status);
      expect((await r.json() as any).error).toMatch(want);
    }
  });
});

describe("the caps", () => {
  it("takes at most 200 people a send", async () => {
    const e = await approvedEvent(db, "Cap Send");
    const k = await keyFor(db, MAYA, "cap");
    const many = (n: number, p = "A") => Array.from({ length: n }, (_, i) => person(`${p}${String.fromCharCode(97 + (i % 26))} Person${String.fromCharCode(97 + Math.floor(i / 26))}`));
    expect((await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: many(201) })).status).toBe(429);
    expect(await count(db, "directory_reads", `event_id = '${e}'`)).toBe(0);
    expect((await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: many(200) })).status).toBe(200);
  });
  it("takes at most 3,000 reads an event, counting only the new people against the cap", async () => {
    const e = await approvedEvent(db, "Cap Event");
    const k = await keyFor(db, MAYA, "cap3000");
    await db.query(
      `INSERT INTO directory_reads (id, event_id, dedupe_key, full_name, via, platform, read_by, read_on, source_text, terms_note, state)
       SELECT 'seed' || g, $1, 'n:seed ' || g || '|', 'Seed ' || g, 'extension', 'swapcard', 'x', current_date, 's', 't', 'staged' FROM generate_series(1, 2999) g`, [e]);
    const r = await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: [person("New One"), person("New Two")] });
    expect(r.status).toBe(429);
    expect((await r.json() as any).error).toMatch(/3,000 is the most/);
    expect(await count(db, "directory_reads", `event_id = '${e}'`)).toBe(2999);
    expect((await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: [person("New One")] })).status).toBe(200);
    expect((await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: [person("New One")] })).status).toBe(200);
  });
  it("takes at most 600 people a minute a key, and counts a key's own minute only", async () => {
    const e = await approvedEvent(db, "Cap Minute");
    const k = await keyFor(db, MAYA, "rate"), other = await keyFor(db, MAYA, "rate other");
    const batch = (n: number, s: string) => Array.from({ length: n }, (_, i) => person(`${s}${String.fromCharCode(97 + (i % 26))} Surname${String.fromCharCode(97 + Math.floor(i / 26))}`));
    for (const s of ["A", "B", "C"]) expect((await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: batch(200, s) })).status).toBe(200);
    const over = await send(app, "/api/capture/people", k.key, { event_id: e, platform: "swapcard", people: batch(1, "Z") });
    expect(over.status).toBe(429);
    expect((await over.json() as any).error).toMatch(/600 people a minute/);
    expect((await send(app, "/api/capture/people", other.key, { event_id: e, platform: "swapcard", people: batch(1, "Z") })).status).toBe(200);
  });
  it("takes a body of 1 MB at most", async () => {
    const k = await keyFor(db, MAYA, "big");
    const r = await app.request("/api/capture/people", { method: "POST", headers: bearer(k.key), body: JSON.stringify({ event_id: ev, platform: "swapcard", people: [person("A B", { title: "x".repeat(1_100_000) })] }) });
    expect(r.status).toBe(413);
  });
  it("captureAdd called directly gives the same refusals", async () => {
    const k = await keyFor(db, MAYA, "direct");
    const key = await authCapture(db, `Bearer ${k.key}`);
    await expect(captureAdd(db, key, { event_id: ev, platform: "nope", people: [{ name: "A B" }] }, new Date())).rejects.toThrow(/platform/);
  });
});

describe("the public demo", () => {
  it("refuses the capture routes, the capture keys and recordings", async () => {
    const demo = createApp(db, { demo: true, publicDemo: true });
    for (const [method, path] of [["GET", "/api/capture/events"], ["POST", "/api/capture/people"], ["POST", "/api/capture-keys"], ["GET", "/api/capture-keys"], ["POST", `/api/events/${ev}/recordings`], ["POST", "/api/recordings/rec_x/frames"], ["POST", "/api/recordings/rec_x/finish"]] as const) {
      const r = await demo.request(path, { method, headers: as(MAYA, { authorization: "Bearer x" }), body: method === "POST" ? "{}" : undefined });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect((await r.json() as any).error).toMatch(/public demo/);
    }
    expect((await demo.request(`/api/events/${ev}/directory`)).status).toBe(200);
  });
});

void DAN;
