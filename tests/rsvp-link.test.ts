/* The public RSVP link (docs/HOSTED.md 6, 21.19, 21.20): unguessable, one 404 for every bad kind, a whitelist of what it says, and a limit on bad tokens per address. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { createApp } from "../src/server/app.ts";
import { removeGuest } from "../src/server/hosted.ts";
import { resetBadTokens } from "../src/server/rsvp.ts";
import { mockLlm } from "../src/server/providers.ts";
import { freshDb } from "./helpers.ts";
import { BEFORE, depsAt, guest, hostedDinner, invite, ON_THE_DAY, tokenOf } from "./hosted-helpers.ts";
import { CAMILLE } from "./plan-helpers.ts";

let db: Db, id: string, app: ReturnType<typeof createApp>, at = BEFORE;
const mk = (over: Record<string, unknown> = {}) => createApp(db, { demo: true, writeKey: "secret", lifecycle: { connectors: {}, llm: mockLlm, now: () => at } as never, ...over });
const get = (t: string, ip = "1.1.1.1") => app.request(`/api/rsvp/${t}`, { headers: { "x-forwarded-for": ip } });
const post = (t: string, body: unknown, ip = "1.1.1.1") => app.request(`/api/rsvp/${t}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });

beforeEach(async () => { db = await freshDb(); at = BEFORE; resetBadTokens(); id = await hostedDinner(db, { capacity: 2 }); app = mk(); });

describe("the token", () => {
  it("is 24 random bytes as base64url, different for every guest, and not made from anything about them", async () => {
    const a = await guest(db, id, "Ana Ruiz"), b = await guest(db, id, "Ana Ruiz", { email: "ana2@acme.example", company: "Other" });
    const ta = await tokenOf(db, a.id), tb = await tokenOf(db, b.id);
    expect(ta).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(ta).not.toBe(tb);
    expect(Buffer.from(ta, "base64url")).toHaveLength(24);
    for (const part of [a.id, id, "Ana", "ruiz", "acme"]) expect(ta.toLowerCase()).not.toContain(part.toLowerCase());
  });
});

describe("a bad link answers one 404", () => {
  it("unknown, malformed, empty-looking, over-long and removed tokens read the same", async () => {
    const g = await guest(db, id, "Ana Ruiz");
    const tok = await tokenOf(db, g.id);
    await removeGuest(db, depsAt(BEFORE), CAMILLE, id, g.id, "Not coming");
    const bodies = new Set<string>();
    for (const t of ["nope", "x".repeat(32), "a%20b", "a".repeat(500), "%00", tok]) {
      const r = await get(t);
      expect(r.status, t).toBe(404);
      bodies.add(await r.text());
    }
    expect([...bodies]).toEqual(['{"error":"This link is not valid."}']);
    expect((await post("nope", { answer: "yes" })).status).toBe(404);
  });

  it("more than 30 bad tokens a minute from one address answers 429, and another address is not blocked", async () => {
    const g = await guest(db, id, "Ana Ruiz");
    const tok = await tokenOf(db, g.id);
    for (let i = 0; i < 30; i++) expect((await get(`bad${i}`, "9.9.9.9")).status).toBe(404);
    expect((await get("bad31", "9.9.9.9")).status).toBe(404);
    expect((await get("bad32", "9.9.9.9")).status).toBe(429);
    expect((await get(tok, "9.9.9.9")).status).toBe(429);
    expect((await get(tok, "8.8.8.8")).status).toBe(200);
  });
});

describe("what the page says", () => {
  it("only the event, the day, the venue, the host, the welcome line and the guest's own first name, status and dietary note", async () => {
    const a = await guest(db, id, "Ana Ruiz", { owner: "Maya Ortiz", company: "Acme", title: "CRO" });
    await guest(db, id, "Ben Cole", { company: "Rival Corp" });
    await invite(db, id, a.id);
    const r = await get(await tokenOf(db, a.id));
    expect(r.status).toBe(200);
    const j = await r.json() as Record<string, any>;
    expect(Object.keys(j).sort()).toEqual(["can_answer", "event", "guest", "list_open", "message"]);
    expect(Object.keys(j.event).sort()).toEqual(["address", "day", "doors_at", "host_name", "name", "venue_name", "welcome"]);
    expect(Object.keys(j.guest).sort()).toEqual(["dietary", "first_name", "status"]);
    expect(j.guest).toEqual({ first_name: "Ana", status: "invited", dietary: "" });
    expect(j.event).toMatchObject({ day: "2027-06-10", doors_at: "18:30", host_name: "Camille Laurent", welcome: "A small table and good food." });
    const text = JSON.stringify(j);
    for (const leak of ["Maya Ortiz", "Ben", "Cole", "Rival", "Acme", "CRO", id, a.id, "ruiz", "cents", "$"]) expect(text, leak).not.toContain(leak);
  });

  it("answering needs no actor and no write key, records the answer with actor guest, and the first name is all it gives back", async () => {
    const a = await guest(db, id, "Ana Ruiz");
    const tok = await tokenOf(db, a.id);
    const r = await post(tok, { answer: "yes", dietary: "No shellfish" });
    expect(r.status).toBe(200);
    expect((await r.json() as any).guest).toEqual({ first_name: "Ana", status: "registered", dietary: "No shellfish" });
    expect((await db.query("SELECT actor FROM guest_log WHERE guest_id = $1 AND detail LIKE 'Said yes%'", [a.id]))).toEqual([{ actor: "guest" }]);
    // The same desk still wants a key and an actor for every other write.
    expect((await app.request(`/api/events/${id}/guests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "X" }) })).status).toBe(401);
  });

  it("a yes after the day began is refused with the date sentence and the page reads the last answer, read only", async () => {
    const a = await guest(db, id, "Ana Ruiz");
    const tok = await tokenOf(db, a.id);
    await post(tok, { answer: "yes" });
    at = ON_THE_DAY;
    app = mk();
    const r = await post(tok, { answer: "yes" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "The date has passed." });
    const view = await (await get(tok)).json() as any;
    expect(view.guest.status).toBe("registered");
    expect(view.can_answer).toBe(false);
  });

  it("a closed list refuses a new yes, accepts a no, and long text or a bad answer is a 400", async () => {
    const a = await guest(db, id, "Ana Ruiz"), b = await guest(db, id, "Ben Cole");
    await db.query("UPDATE hosted_events SET rsvp_open = false WHERE event_id = $1", [id]);
    const ta = await tokenOf(db, a.id);
    const r = await post(ta, { answer: "yes" });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "The list is full." });
    expect((await post(await tokenOf(db, b.id), { answer: "no", note: "Travelling" })).status).toBe(200);
    expect((await post(ta, { answer: "maybe" })).status).toBe(400);
    expect((await post(ta, { answer: "yes", dietary: "x".repeat(301) })).status).toBe(400);
  });
});
