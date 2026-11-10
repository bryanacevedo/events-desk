/* Slack in the open: each event has its own channel, problems with no event go to the ops channel, nothing goes by direct message. Plus the signals that make an unattended desk visible: alerts reach a channel, a stuck pass is noticed, /api/health tells an outside check. */

import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/server/db.ts";
import { createApp } from "../src/server/app.ts";
import { client } from "../src/server/connectors/types.ts";
import { lifecycleTick, tickState } from "../src/server/lifecycle-tick.ts";
import { drainNotifications, raiseAlert } from "../src/server/operating.ts";
import { eventChannelName, slackNotifier } from "../src/server/slack.ts";
import { freshDb } from "./helpers.ts";
import { deliveredInMotion } from "./lifecycle-harness.ts";

let db: Db;
beforeEach(async () => { db = await freshDb(); });

describe("event channels", () => {
  it("names a channel the way Slack accepts", () => {
    expect(eventChannelName("Money20/20 USA 2026")).toBe("evt-money20-20-usa-2026");
    expect(eventChannelName("Café Summit", "-ab12")).toBe("evt-cafe-summit-ab12");
    expect(eventChannelName("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it("opens a public channel, takes another name when one is taken, invites who it mentions, and puts them at the top of the card", async () => {
    const calls: { method: string; body: any }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const method = url.split("/api/")[1], body = JSON.parse(String(init.body));
      calls.push({ method, body });
      if (method === "conversations.create") return Response.json(body.name.endsWith("-ab12cd") ? { ok: true, channel: { id: "C9" } } : { ok: false, error: "name_taken" });
      return Response.json({ ok: true, ts: "1.2" });
    }) as typeof fetch;
    const n = slackNotifier({ signingSecret: "s", botToken: "t", channel: "CAPPROVALS", approvers: [], fetch: f });
    const ch = await n.post({ event_id: "evt_x_ab12cd", name: "Money20/20 USA", channel: null }, { text: "Ana is interested", blocks: [] }, ["UOWNER"]);
    expect(ch).toBe("C9");
    expect(calls.filter((c) => c.method === "conversations.create").map((c) => [c.body.name, c.body.is_private])).toEqual([["evt-money20-20-usa", false], ["evt-money20-20-usa-ab12cd", false]]);
    expect(calls.find((c) => c.method === "conversations.invite")!.body).toEqual({ channel: "C9", users: "UOWNER" });
    const post = calls.find((c) => c.method === "chat.postMessage")!.body;
    expect(post.channel).toBe("C9");
    expect(post.text).toMatch(/^<@UOWNER> /);
    expect(post.blocks[0].elements[0].text).toBe("For <@UOWNER>");
    expect(calls.some((c) => c.method === "chat.postMessage" && c.body.channel.startsWith("U"))).toBe(false);
  });

  it("a hot reply goes to the event channel with the owner mentioned, once", async () => {
    const h = await deliveredInMotion(db);
    const { queueEvent } = await import("../src/server/operating.ts");
    await db.tx((q) => queueEvent(q, h.id, { text: "x", blocks: [] }, ["UOWNER", "UOWNER", null]));
    await drainNotifications(db, h.deps);
    expect(h.notify.sent).toEqual([{ to: "UOWNER", card: { text: "x", blocks: [] }, channel: `C_${h.id}` }]);
    expect((await db.query<{ slack_channel: string }>("SELECT slack_channel FROM events WHERE id = $1", [h.id]))[0].slack_channel).toBe(`C_${h.id}`);
  });
});

describe("an unattended desk is visible", () => {
  it("an alert goes to the ops channel, once a day", async () => {
    const h = await deliveredInMotion(db);
    await raiseAlert(db, h.deps, "blind:instantly", "Instantly has gone quiet.");
    await raiseAlert(db, h.deps, "blind:instantly", "Instantly has gone quiet.");
    await drainNotifications(db, h.deps);
    expect(h.notify.opsPosts.map((c) => c.text)).toEqual(["Events Desk: Instantly has gone quiet."]);
  });

  it("a Slack message that failed for good is not announced to the same broken Slack", async () => {
    const h = await deliveredInMotion(db);
    await raiseAlert(db, h.deps, "notify:ntf_1", "A Slack message could not be delivered.");
    await drainNotifications(db, h.deps);
    expect(h.notify.opsPosts).toHaveLength(0);
    expect(await db.query("SELECT 1 FROM alerts WHERE key = 'notify:ntf_1'")).toHaveLength(1);
  });

  it("a pass that hangs is reported by the next timer", async () => {
    const h = await deliveredInMotion(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Slack hangs on the first message the pass tries to send.
    await raiseAlert(db, h.deps, "blind:x", "Something to send.");
    h.notify.ops = async () => { await gate; return true; };
    const first = lifecycleTick(db, h.deps);
    await new Promise((r) => setTimeout(r, 50));
    h.time.set(new Date(h.time.now.getTime() + 16 * 60_000).toISOString());
    const opsBefore = h.notify.opsPosts.length;
    h.notify.ops = async (card) => { h.notify.opsPosts.push(card); return true; };
    await lifecycleTick(db, h.deps);
    const sentBeforeRelease = h.notify.opsPosts.length > opsBefore && /stuck|has not finished/.test(h.notify.opsPosts.at(-1)!.text);
    release();
    await first;
    expect(await db.query("SELECT 1 FROM alerts WHERE key = 'tick:stuck'")).toHaveLength(1);
    // Posted while the pass was still hung, not queued behind it.
    expect(sentBeforeRelease).toBe(true);
  });

  it("/api/health fails when the pass has stopped finishing", async () => {
    const http = createApp(db, { demo: false });
    const keep = { ...tickState };
    tickState.startedAt = new Date(Date.now() - 30 * 60_000); tickState.finishedAt = new Date(Date.now() - 25 * 60_000);
    const stale = await http.request("/api/health");
    tickState.finishedAt = new Date();
    const fine = await http.request("/api/health");
    Object.assign(tickState, keep);
    expect(stale.status).toBe(503);
    expect((await stale.json()).tick.stale).toBe(true);
    expect(fine.status).toBe(200);
  });

  it("every call to a tool carries a timeout, so one hung tool cannot hold the pass", async () => {
    let signal: AbortSignal | null | undefined;
    const call = client("t", (async (_u: string, init: RequestInit) => { signal = init.signal; return Response.json({}); }) as typeof fetch, "https://x", {});
    await call("GET", "/a");
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});
