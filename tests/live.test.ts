import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { decideApproval } from "../src/server/approvals.ts";
import { ingestUpload } from "../src/server/uploads.ts";
import type { Db } from "../src/server/db.ts";
import { createEvent } from "../src/server/events.ts";
import { liveVendors } from "../src/server/live-vendors.ts";
import { mockLlm, VendorError } from "../src/server/providers.ts";
import { seed } from "../src/server/seed.ts";
import { verifySlack, type SlackConfig } from "../src/server/slack.ts";
import type { Settings } from "../src/shared/cost.ts";
import { freshDb } from "./helpers.ts";

const s: Settings = JSON.parse(readFileSync("config/defaults.json", "utf8"));
const keys = { apollo: "a", zerobounce: "z" };
const respond = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const vendors = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>) => liveVendors(s, keys, { paceMs: 0, fetch: (async (u: string, i?: RequestInit) => handler(String(u), i)) as typeof fetch });
const P = { full_name: "Maya Serrano", company: "Brightwater Logistics" };

describe("Apollo", () => {
  it("treats the right name at the wrong company as a miss", async () => {
    const v = vendors(() => respond({ person: { email: "maya@other.example", organization: { name: "Other Co" } } }));
    expect((await v.finders[0].find(P)).value).toBeNull();
  });
  it("accepts a match at the same company, across legal suffixes", async () => {
    const v = vendors(() => respond({ person: { email: "MAYA@brightwater.example", organization: { name: "Brightwater Logistics, Inc." } } }));
    expect((await v.finders[0].find(P)).value).toBe("maya@brightwater.example");
  });
  it("ignores a locked placeholder email", async () => {
    const v = vendors(() => respond({ person: { email: "email_not_unlocked@domain.com", organization: { name: "Brightwater Logistics" } } }));
    expect((await v.finders[0].find(P)).value).toBeNull();
  });
  it("counts a miss as charged", async () => {
    expect((await vendors(() => respond({ person: null })).finders[0].find(P)).charged).toBe(s.finders[0].cost);
  });
  it("keeps only people really at the company", async () => {
    const v = vendors(() => respond({ people: [{ name: "A B", title: "VP Sales", organization: { name: "Brightwater Logistics" } }, { name: "C D", title: "VP Sales", organization: { name: "Elsewhere" } }] }));
    expect((await v.discovery.find("Brightwater Logistics", 3)).people.map((p) => p.full_name)).toEqual(["A B"]);
  });
  it("sends the key in the header, never the URL", async () => {
    let url = "", header = "";
    await vendors((u, i) => { url = u; header = (i!.headers as Record<string, string>)["x-api-key"]; return respond({}); }).finders[0].find(P);
    expect(url).not.toContain("api_key"); expect(header).toBe("a");
  });
});

describe("verifiers", () => {
  it.each([["valid", "deliverable"], ["invalid", "undeliverable"], ["spamtrap", "undeliverable"], ["catch-all", "catch_all"], ["unknown", "unknown"]])("ZeroBounce %s is %s", async (status, verdict) => {
    expect((await vendors(() => respond({ status })).verifiers[0].verify("a@b.example")).verdict).toBe(verdict);
  });
  it("reports a 500 as an unknown charge, so it is never retried", async () => {
    await expect(vendors(() => respond({}, 500)).verifiers[0].verify("a@b.example")).rejects.toMatchObject({ charged: "unknown" });
  });
  it("reports a rate limit as not billed, so it can retry", async () => {
    const e = await vendors(() => respond({}, 429)).verifiers[0].verify("a@b.example").catch((x) => x);
    expect(e).toBeInstanceOf(VendorError); expect(e.charged).toBe(0);
  });
  it("reports a network failure as an unknown charge", async () => {
    await expect(vendors(() => { throw new Error("down"); }).verifiers[0].verify("a@b.example")).rejects.toMatchObject({ charged: "unknown" });
  });
});

describe("Slack signature", () => {
  const sign = (body: string, ts: number) => `v0=${createHmac("sha256", "secret").update(`v0:${ts}:${body}`).digest("hex")}`;
  it("accepts a correct signature", () => { expect(verifySlack("secret", "1000", sign("x", 1000), "x", 1000)).toBe(true); });
  it("refuses a changed body", () => { expect(verifySlack("secret", "1000", sign("x", 1000), "y", 1000)).toBe(false); });
  it("refuses a replay older than five minutes", () => { expect(verifySlack("secret", "1000", sign("x", 1000), "x", 1301)).toBe(false); });
  it("refuses a missing signature", () => { expect(verifySlack("secret", undefined, undefined, "x", 1000)).toBe(false); });
});

describe("Slack routes", () => {
  let db: Db, app: ReturnType<typeof createApp>, id: string, approval: string;
  let calls: { url: string; body: any }[];
  const NOW = 2_000_000_000;
  const cfg = (): SlackConfig => ({
    signingSecret: "secret", botToken: "t", channel: "C1", approvers: ["UAPPROVER"], now: () => NOW,
    fetch: (async (u: string, i: RequestInit) => { calls.push({ url: String(u), body: JSON.parse(i.body as string) }); return respond({ ok: true }); }) as typeof fetch,
  });
  const post = (path: string, body: string, ts = NOW, bad = false) => app.request(path, { method: "POST", body, headers: {
    "x-slack-request-timestamp": String(ts), "x-slack-signature": bad ? "v0=nope" : `v0=${createHmac("sha256", "secret").update(`v0:${ts}:${body}`).digest("hex")}`,
  } });
  const interact = (payload: unknown) => post("/slack/interactions", new URLSearchParams({ payload: JSON.stringify(payload) }).toString());
  const button = (action_id: string, user: string) => interact({ type: "block_actions", user: { id: user }, trigger_id: "T", response_url: "https://hooks.example/r", actions: [{ action_id, value: approval }] });
  const stage = async () => (await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage;

  beforeEach(async () => {
    calls = [];
    db = await freshDb();
    app = createApp(db, { demo: false, slack: cfg() });
    id = (await createEvent(db, "UREQUESTER", { name: "T", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 100 }, undefined, ["UAPPROVER", "UREQUESTER"])).id;
    approval = (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1", [id]))[0].id;
  });

  it("refuses an unsigned request and changes nothing", async () => {
    const body = new URLSearchParams({ payload: "{}" }).toString();
    expect((await post("/slack/interactions", body, NOW, true)).status).toBe(401);
    expect(await stage()).toBe("requested");
  });
  it("approves from a signed click", async () => {
    await button("approve", "UAPPROVER");
    expect(await stage()).toBe("approved");
  });
  it("tells a requester they cannot approve their own request", async () => {
    await button("approve", "UREQUESTER");
    expect(await stage()).toBe("requested");
    expect(calls.at(-1)!.body.text).toMatch(/own request/);
  });
  it("opens a modal for a decline, then needs the reason", async () => {
    await button("decline", "UAPPROVER");
    expect(calls.at(-1)!.url).toContain("views.open");
    const view = (reason: string) => ({ callback_id: "decline_reason", private_metadata: approval, state: { values: { reason: { value: { value: reason } } } } });
    const blank = await (await interact({ type: "view_submission", user: { id: "UAPPROVER" }, view: view(" ") })).json() as any;
    expect(blank.response_action).toBe("errors");
    await interact({ type: "view_submission", user: { id: "UAPPROVER" }, view: view("Over budget") });
    expect(await stage()).toBe("declined");
  });
  it("points /event-request at the desk and creates nothing", async () => {
    const before = (await db.query("SELECT 1 FROM events")).length;
    const body = new URLSearchParams({ command: "/event-request", trigger_id: "t1" }).toString();
    const r = await (await post("/slack/commands", body)).json() as { text: string };
    expect(r.text).toMatch(/under Seats/);
    expect((await db.query("SELECT 1 FROM events")).length).toBe(before);
    expect(calls.some((c) => c.url.includes("views.open") && JSON.stringify(c.body).includes("event_request"))).toBe(false);
  });
  it("posts a seat request with its goal and why", async () => {
    await db.query("INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, seat_price_cents) VALUES ('c1', 'Slack Summit', '', 'Oslo', 'Norway', '2027-05-05', '2027-05-05', 100000)");
    const { requestSeat, parseSeatRequest } = await import("../src/server/seats.ts");
    const { postSeatRequest } = await import("../src/server/slack.ts");
    const made = await requestSeat(db, "UREQUESTER", parseSeatRequest("UREQUESTER", { catalog_id: "c1", team: "Sales", role: "SDR", goal: "partners", why_event: "Partners run their pipeline through this event.", why_you: "I manage the partner accounts in the region.", expected_meetings: 5 }), { approvers: ["UAPPROVER"] });
    await postSeatRequest(db, cfg(), made.id);
    const text = String(calls.at(-1)!.body.text);
    expect(text).toMatch(/Goal:\* Partners/);
    expect(text).toMatch(/Why this event:\* Partners run their pipeline/);
    expect(text).toMatch(/Why them:\* I manage the partner accounts/);
  });
  it("answers a Concierge question on the response URL", async () => {
    await seed(db);
    app = createApp(db, { demo: false, slack: { ...cfg(), llm: mockLlm } });
    const body = new URLSearchParams({ command: "/ask-desk", text: "evt_quarry How many priority A contacts?", response_url: "https://hooks.example/a", user_id: "UAPPROVER" }).toString();
    await (await post("/slack/commands", body)).json();
    for (let i = 0; i < 100 && !calls.some((x) => x.url.includes("hooks.example/a")); i++) await new Promise((r) => setTimeout(r, 20));
    expect(calls.find((x) => x.url.includes("hooks.example/a"))!.body.text).toMatch(/contacts/);
  });
  it("answers only people the desk knows", async () => {
    await seed(db);
    app = createApp(db, { demo: false, slack: { ...cfg(), llm: mockLlm } });
    const body = new URLSearchParams({ command: "/ask-desk", text: "evt_quarry Who is on the list?", response_url: "https://hooks.example/b", user_id: "USTRANGER" }).toString();
    expect((await (await post("/slack/commands", body)).json()).text).toMatch(/desk's list/);
    expect(calls.some((x) => x.url.includes("hooks.example/b"))).toBe(false);
  });
  it("has no demo approval route in live mode", async () => {
    const r = await app.request(`/api/demo/approvals/${approval}`, { method: "POST", headers: { "x-actor": "UAPPROVER" }, body: JSON.stringify({ decision: "approve" }) });
    expect(r.status).toBe(404);
    expect(await stage()).toBe("requested");
  });
});

describe("Slack cost cards go to the uploader, and only their Slack user can confirm", () => {
  let db: Db, app: ReturnType<typeof createApp>, id: string, card: string;
  let calls: { url: string; body: any }[];
  const NOW = 2_000_000_000;
  const csv = "Company Name,First Name,Last Name,Job Title,Work Email\nAcme,A,B,VP Sales,a@acme.example\n";
  const cfg = (userMap: Record<string, string>): SlackConfig => ({
    signingSecret: "secret", botToken: "t", channel: "C1", approvers: ["UAPPROVER"], userMap, now: () => NOW,
    fetch: (async (u: string, i: RequestInit) => { calls.push({ url: String(u), body: JSON.parse(i.body as string) }); return respond({ ok: true }); }) as typeof fetch,
  });
  const post = (body: string) => app.request("/slack/interactions", { method: "POST", body, headers: {
    "x-slack-request-timestamp": String(NOW), "x-slack-signature": `v0=${createHmac("sha256", "secret").update(`v0:${NOW}:${body}`).digest("hex")}`,
  } });
  const click = (action_id: string, user: string, value = card) => post(new URLSearchParams({ payload: JSON.stringify({ type: "block_actions", user: { id: user }, trigger_id: "T", response_url: "https://hooks.example/r", actions: [{ action_id, value }] }) }).toString());
  const stage = async () => (await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [id]))[0].stage;
  const setup = async (userMap: Record<string, string>) => {
    calls = [];
    db = await freshDb();
    app = createApp(db, { demo: false, slack: cfg(userMap) });
    id = (await createEvent(db, "UREQUESTER", { name: "T", starts_on: "2027-01-01", seat_count: 1, seat_price_cents: 100 }, undefined, ["UAPPROVER"])).id;
    const seats = (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1", [id]))[0].id;
    await decideApproval(db, { approvalId: seats, actor: "UAPPROVER", decision: "approve" });
    await ingestUpload(db, id, "Maya Ortiz", "a.csv", csv);
  };
  const quote = async () => {
    const r = await app.request(`/api/events/${id}/quote`, { method: "POST", headers: { "x-actor": "Maya Ortiz" } });
    if (r.status === 200) card = (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
    return r;
  };

  it("sends the card to the uploader's Slack user and lets only that user confirm it", async () => {
    await setup({ "Maya Ortiz": "UMAYA" });
    expect((await quote()).status).toBe(200);
    const msg = calls.find((c) => c.url.includes("chat.postMessage"))!.body;
    expect(msg.text).toContain("<@UMAYA>");
    expect(JSON.stringify(msg.blocks)).toContain("Confirm");
    // An approver who did not upload, and the person who requested the seats, are refused; nothing runs.
    await click("approve", "UAPPROVER");
    expect(calls.at(-1)!.body.text).toMatch(/Only <@UMAYA> \(Maya Ortiz\), who uploaded/);
    await click("approve", "UREQUESTER");
    expect(await stage()).toBe("quoted");
    // A Slack user who is not mapped to the uploader cannot decline it either.
    await click("approve", "UOTHER");
    expect(await stage()).toBe("quoted");
    await click("approve", "UMAYA");
    expect(await stage()).toBe("researching");
  });
  it("posts a waiting card again when asked, and refuses when none is waiting", async () => {
    await setup({ "Maya Ortiz": "UMAYA" });
    const resend = () => app.request(`/api/events/${id}/card/resend`, { method: "POST", headers: { "x-actor": "Maya Ortiz" } });
    expect((await resend()).status).toBe(409);
    await quote();
    const before = calls.filter((c) => c.url.includes("chat.postMessage")).length;
    expect((await resend()).status).toBe(200);
    expect(calls.filter((c) => c.url.includes("chat.postMessage")).length).toBe(before + 1);
  });
  it("refuses, with the reason, when the uploader has no Slack user in the map, before any card is made", async () => {
    await setup({ "Someone Else": "UELSE" });
    const r = await quote();
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/Maya Ortiz uploaded the attendee list but has no Slack user in SLACK_USER_MAP/);
    expect((await db.query("SELECT 1 FROM cost_cards WHERE event_id = $1", [id])).length).toBe(0);
    expect(await stage()).toBe("mapped");
  });
  it("refuses a click on a card whose uploader lost their mapping", async () => {
    await setup({ "Maya Ortiz": "UMAYA" });
    await quote();
    app = createApp(db, { demo: false, slack: cfg({}) });
    await click("approve", "UMAYA");
    expect(calls.at(-1)!.body.text).toMatch(/no Slack user in SLACK_USER_MAP/);
    expect(await stage()).toBe("quoted");
  });
  it("voids the old card when someone else uploads the list again, and sends the new card to them", async () => {
    await setup({ "Maya Ortiz": "UMAYA", "Sam Okafor": "USAM" });
    await quote();
    const old = card;
    await ingestUpload(db, id, "Sam Okafor", "b.csv", csv);
    await click("approve", "UMAYA", old);
    expect(calls.at(-1)!.body.text).toMatch(/Already declined/);
    expect(await stage()).toBe("mapped");
    await quote();
    expect(calls.filter((c) => c.url.includes("chat.postMessage")).at(-1)!.body.text).toContain("<@USAM>");
    await click("approve", "UMAYA");
    expect(await stage()).toBe("quoted");
    await click("approve", "USAM");
    expect(await stage()).toBe("researching");
  });
});
