/* The organizer adapter against what Swapcard documents (docs/SCANNER.md 7). The fixtures are the documented responses (swapcard.dev/content-api/examples/scan-badges):
   a found badge, CODE_NOT_FOUND, and the two other error codes it lists. The transport is a recording; nothing calls the network. A live call waits for a show that enables it. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fakeOrganizer, swapcardAdapter, swapcardKeys, SWAPCARD_URL, type Transport } from "../src/server/organizer-api.ts";

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/swapcard/${n}.json`, "utf8"));
const ref = { event_ref: "RXZlbnRfMjg1NzM=", exhibitor_ref: "RXhoaWJpdG9yXzU5NTIx" };
const keys = { [ref.exhibitor_ref]: "key-for-this-show" };
function recording(answer: unknown, status = 200) {
  const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
  const transport: Transport = async (url, init) => { sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { status, json: async () => answer }; };
  return { transport, sent };
}

describe("Swapcard's documented request", () => {
  it("sends scanBadges to the exhibitor endpoint with the key in Authorization, one badge, and the three ids the page names", async () => {
    const r = recording(fx("found"));
    await swapcardAdapter({ transport: r.transport, keys }).resolveBadge(ref, "123456789");
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].url).toBe(SWAPCARD_URL);
    expect(r.sent[0].headers.authorization).toBe("key-for-this-show");
    expect(r.sent[0].body.query).toMatch(/scanBadges\(input: \$input\)/);
    expect(r.sent[0].body.variables).toEqual({ input: { eventId: ref.event_ref, exhibitorId: ref.exhibitor_ref, scanBadges: [{ code: "123456789" }] } });
  });
});

describe("Swapcard's documented answers", () => {
  const ask = (name: string, status = 200) => swapcardAdapter({ transport: recording(fx(name), status).transport, keys }).resolveBadge(ref, "123456789");
  it("a matched code gives the person, with null fields left out", async () => {
    expect(await ask("found")).toEqual({ kind: "found", registrant_id: "Q29ubmVjdGlvbl8xMTYzNDE=", fields: { name: "John Doe", email: "test@gmail.com" } });
    expect(await ask("full")).toMatchObject({ kind: "found", fields: { name: "Ana Lima", title: "Head of Payments", company: "Orrery", email: "ana.lima@orrery.example", country: "Portugal" } });
  });
  it("CODE_NOT_FOUND is no match, and the other two codes are a refusal a retry cannot fix", async () => {
    expect(await ask("code_not_found")).toEqual({ kind: "not_found" });
    expect(await ask("feature_not_allowed")).toEqual({ kind: "refused", reason: "feature_not_allowed" });
    expect(await ask("user_not_in_event")).toEqual({ kind: "refused", reason: "user_not_in_event" });
  });
  it("an answer that is not the documented shape, an unknown code, a server error or no network is unavailable, never a person", async () => {
    expect((await ask("shape_wrong")).kind).toBe("unavailable");
    expect((await ask("unknown_error")).kind).toBe("unavailable");
    expect((await ask("found", 503)).kind).toBe("unavailable");
    expect((await ask("found", 401)).kind).toBe("unavailable");
    const down: Transport = async () => { throw new Error("offline"); };
    expect((await swapcardAdapter({ transport: down, keys }).resolveBadge(ref, "1")).kind).toBe("unavailable");
  });
  it("without a key for this exhibitor it is not ready, calls nothing and says so", async () => {
    const r = recording(fx("found"));
    const a = swapcardAdapter({ transport: r.transport, keys: {} });
    expect(a.ready(ref)).toBe(false);
    expect((await a.resolveBadge(ref, "1")).kind).toBe("unavailable");
    expect(r.sent).toHaveLength(0);
  });
  it("reads keys per exhibitor from the environment and ignores bad JSON", () => {
    expect(swapcardKeys({ SWAPCARD_KEYS: '{"a":"k"}' })).toEqual({ a: "k" });
    expect(swapcardKeys({ SWAPCARD_KEYS: "nope" })).toEqual({});
  });
});

describe("the fake", () => {
  it("answers from a table, and an unknown code is not found", async () => {
    const calls: string[] = [];
    const f = fakeOrganizer({ A1: { kind: "found", registrant_id: "r1", fields: { name: "Ana Lima" } } }, { calls });
    expect(await f.resolveBadge(ref, "A1")).toMatchObject({ kind: "found" });
    expect(await f.resolveBadge(ref, "ZZ")).toEqual({ kind: "not_found" });
    expect(calls).toEqual(["A1", "ZZ"]);
  });
});
