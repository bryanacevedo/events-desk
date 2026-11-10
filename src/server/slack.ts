/* The live approval surface. Every request is checked against Slack's signature
   before anything is read from it. Approvals go through decideApproval, the same
   function the demo panel calls. */

import type { EventRoom, LifecycleDeps, Notifier } from "./lifecycle-deps.ts";
import type { CardMessage } from "./slack-cards.ts";
import { answerDebrief } from "./closeout.ts";
import { bookMeeting, recordOutcome } from "./meetings.ts";
import { decideOwner } from "./owners.ts";
import { drainOps } from "./sequences.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { currentUploader, decideApproval } from "./approvals.ts";
import { cardBreakdown } from "../shared/vendors.ts";
import { decideSeat, GOALS } from "./seats.ts";
import type { Db } from "./db.ts";
import { logActivity, RuleError } from "./events.ts";
import type { Llm } from "./providers.ts";
import { askConcierge, connectConcierge } from "../concierge/agent.ts";

export interface SlackConfig {
  signingSecret: string;
  botToken: string;
  channel: string;
  /** Where problems that belong to no one event go. Defaults to `channel`. */
  opsChannel?: string;
  approvers: string[];
  /** Person name to Slack user ID. A cost card is confirmed by the person who uploaded the list, and in live mode the Slack user is the only proof of who that is. Required for LIVE_SPEND=1. */
  userMap?: Record<string, string>;
  fetch?: typeof fetch;
  now?: () => number;
  llm?: Llm;
}

const FIVE_MINUTES = 300;

export function verifySlack(secret: string, timestamp: string | undefined, signature: string | undefined, body: string, nowSeconds: number) {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > FIVE_MINUTES) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** What a card allows: each vendor's own credits, then AI in dollars. Credits never carry a dollar figure. */
function cardFacts(card: Parameters<typeof cardBreakdown>[0]) {
  const b = cardBreakdown(card);
  const credits = b.credits.map((x) => `${x.vendor} ${x.credits}`).join(", ");
  return `At most: ${credits ? `${credits} (credits); ` : ""}AI about $${(b.ai_cents / 100).toFixed(2)}`;
}
const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

async function slackCall(cfg: SlackConfig, method: string, payload: unknown) {
  const r = await (cfg.fetch ?? fetch)(`https://slack.com/api/${method}`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${cfg.botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  const j = await r.json() as { ok: boolean; error?: string };
  if (!j.ok && j.error !== "already_in_channel") console.error(`Slack ${method} failed: ${j.error}`);
  return j;
}

/** Posts a card to the channel. When Slack refuses it or cannot be reached, the event's activity says so, because a card that never arrived has no button for anyone to press. */
async function postCard(db: Db, cfg: SlackConfig, eventId: string, what: string, payload: unknown) {
  let why = "";
  try { const j = await slackCall(cfg, "chat.postMessage", payload); if (!j.ok) why = j.error ?? "unknown error"; }
  catch (e) { why = (e as Error).message; }
  if (why) await logActivity(db.query, eventId, "Events Desk", "slack", `The Slack card for ${what} did not post (${why}). Nobody can press its button. Fix Slack, then send the card again from the event.`);
}

/** The Slack user a cost card goes to: the mapped Slack ID of the person who uploaded the current list. Refuses, with the reason, when that person has no mapping. */
export async function cardRecipient(db: Db | { query: Db["query"] }, cfg: SlackConfig, eventId: string): Promise<{ name: string; slackId: string }> {
  const up = await currentUploader(db.query, eventId);
  if (!up) throw new RuleError("There is no attendee list for this event, so there is nobody to confirm a cost card.");
  const slackId = cfg.userMap?.[up.uploaded_by];
  if (!slackId) throw new RuleError(`${up.uploaded_by} uploaded the attendee list but has no Slack user in SLACK_USER_MAP, so the cost card cannot be sent to them. Add them to the map, or have someone with a Slack user upload the attendee list.`);
  return { name: up.uploaded_by, slackId };
}

/** Who a Slack click counts as. A seat request: the Slack user, checked against the approver list by decideApproval. A cost card: only the uploader's mapped Slack user, and then the uploader's name. */
export async function actorFor(db: Db, cfg: SlackConfig, approvalId: string, slackUser: string): Promise<string> {
  const [a] = await db.query<{ kind: string; event_id: string; status: string }>("SELECT kind, event_id, status FROM approvals WHERE id = $1", [approvalId]);
  // A decided approval only reports who decided it, so it needs no check on the person clicking.
  if (!a || a.kind === "seats" || a.status !== "pending") return slackUser;
  const who = await cardRecipient(db, cfg, a.event_id);
  if (who.slackId !== slackUser) throw new RuleError(`Only <@${who.slackId}> (${who.name}), who uploaded the attendee list, can confirm its cost card.`);
  return who.name;
}

/** Posts one approval to the channel with its two buttons. A cost card is addressed to the uploader. */
export async function postApproval(db: Db, cfg: SlackConfig, approvalId: string) {
  const [a] = await db.query<{ id: string; event_id: string; kind: string; requested_by: string; name: string; seat_count: number; seat_price_cents: number; credits_cap: number | null; llm_cap: number | null; step_caps: any; lines: any; rates: any }>(
    `SELECT a.id, a.event_id, a.kind, a.requested_by, e.name, e.seat_count, e.seat_price_cents, k.credits_cap, k.llm_cap, k.step_caps, k.lines, k.rates - 'credit_cents' AS rates
     FROM approvals a JOIN events e ON e.id = a.event_id LEFT JOIN cost_cards k ON k.id = a.card_id WHERE a.id = $1`, [approvalId]);
  if (!a) return;
  const facts = a.kind === "seats"
    ? `${a.seat_count} seats, ${dollars(a.seat_count * a.seat_price_cents)} budget`
    : cardFacts(a);
  const text = a.kind === "seats"
    ? `<@${a.requested_by}> asks for seats at *${esc(a.name)}*\n${facts}`
    : `<@${(await cardRecipient(db, cfg, a.event_id)).slackId}> you uploaded the attendee list for *${esc(a.name)}*. Confirm the cost card before the paid steps run.\n${facts}`;
  await postCard(db, cfg, a.event_id, a.kind === "seats" ? "a seat approval" : "a cost card", {
    channel: cfg.channel, text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", elements: [
        { type: "button", style: "primary", action_id: "approve", value: a.id, text: { type: "plain_text", text: a.kind === "seats" ? "Approve" : "Confirm" } },
        { type: "button", action_id: "decline", value: a.id, text: { type: "plain_text", text: "Decline" } },
      ] },
    ],
  });
}

/** One seat request to the channel: who, which event, the goal and why, with Approve and Decline. */
export async function postSeatRequest(db: Db, cfg: SlackConfig, requestId: string) {
  const [r] = await db.query<{ id: string; event_id: string; requester: string; name: string; team: string; role: string; goal: keyof typeof GOALS; why_event: string; why_you: string; expected_meetings: number; seat_price_cents: number }>(
    "SELECT r.id, r.event_id, r.requester, e.name, r.team, r.role, r.goal, r.why_event, r.why_you, r.expected_meetings, e.seat_price_cents FROM seat_requests r JOIN events e ON e.id = r.event_id WHERE r.id = $1", [requestId]);
  if (!r) return;
  const text = `*${esc(r.requester)}* (${esc(r.role)}, ${esc(r.team)}) asks for a seat at *${esc(r.name)}*, ${dollars(r.seat_price_cents)}\n*Goal:* ${GOALS[r.goal] ?? r.goal}, about ${r.expected_meetings} meetings\n*Why this event:* ${esc(r.why_event)}\n*Why them:* ${esc(r.why_you)}`;
  await postCard(db, cfg, r.event_id, `${r.requester}'s seat request`, {
    channel: cfg.channel, text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", elements: [
        { type: "button", style: "primary", action_id: "approve", value: r.id, text: { type: "plain_text", text: "Approve" } },
        { type: "button", action_id: "decline", value: r.id, text: { type: "plain_text", text: "Decline" } },
      ] },
    ],
  });
}

const input = (block_id: string, label: string, optional = false) => ({
  type: "input", block_id, optional, label: { type: "plain_text", text: label },
  element: { type: "plain_text_input", action_id: "value" },
});
const modal = (callback_id: string, title: string, blocks: unknown[], private_metadata = "") => ({
  type: "modal", callback_id, private_metadata, title: { type: "plain_text", text: title }, submit: { type: "plain_text", text: "Send" }, blocks,
});
type View = { callback_id: string; private_metadata: string; state: { values: Record<string, { value: { value: string | null } }> } };
const field = (v: View, id: string) => (v.state.values[id]?.value.value ?? "").trim();

const LIFECYCLE_ACTIONS = new Set(["owner_mine", "owner_include_all", "meeting_booked", "meeting_held", "meeting_no_show", "meeting_cancelled", "debrief_open"]);

/** The event channels and the ops channel. True only when Slack says the message went. */
/** A Slack channel name for an event: lowercase words joined by hyphens, under Slack's 80-character limit. */
export function eventChannelName(eventName: string, suffix = "") {
  const base = "evt-" + eventName.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (base.slice(0, 80 - suffix.length).replace(/-+$/, "") + suffix);
}

/** The cards say who they are for at the top, so the person is notified and everyone else can see who has it. */
const addressed = (m: CardMessage, mention: string[]): CardMessage => !mention.length ? m : {
  text: `${mention.map((id) => `<@${id}>`).join(" ")} ${m.text}`,
  blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: `For ${mention.map((id) => `<@${id}>`).join(", ")}` }] }, ...(m.blocks ?? [])],
};

export function slackNotifier(cfg: SlackConfig): Notifier {
  /** Opens a public channel for the event. A name already taken gets the event's id on the end, so two events never share a channel. */
  async function open(room: EventRoom) {
    for (const suffix of ["", `-${room.event_id.slice(-6).toLowerCase()}`]) {
      const j = await slackCall(cfg, "conversations.create", { name: eventChannelName(room.name, suffix), is_private: false }) as { ok: boolean; error?: string; channel?: { id: string } };
      if (j.ok && j.channel) return j.channel.id;
      if (j.error !== "name_taken") return null;
    }
    return null;
  }
  return {
    async post(room, m, mention = []) {
      const channel = room.channel ?? await open(room);
      if (!channel) return null;
      // Someone outside a channel gets no notification from a mention, so they are added first. Already there is fine.
      if (mention.length) await slackCall(cfg, "conversations.invite", { channel, users: mention.join(",") });
      const j = await slackCall(cfg, "chat.postMessage", { channel, ...addressed(m, mention) });
      return j.ok ? channel : null;
    },
    async ops(m) { return (await slackCall(cfg, "chat.postMessage", { channel: cfg.opsChannel ?? cfg.channel, text: m.text, blocks: m.blocks })).ok; },
  };
}

export function mountSlack(app: Hono<any>, db: Db, cfg: SlackConfig, kick?: (eventId: string) => void, lifecycle?: LifecycleDeps) {
  const now = () => (cfg.now ? cfg.now() : Math.floor(Date.now() / 1000));
  const signed = async (c: { req: { text(): Promise<string>; header(n: string): string | undefined } }) => {
    const body = await c.req.text();
    return verifySlack(cfg.signingSecret, c.req.header("x-slack-request-timestamp"), c.req.header("x-slack-signature"), body, now()) ? body : null;
  };
  const refuse = () => new Response("Bad signature", { status: 401 });

  app.post("/slack/commands", async (c) => {
    const body = await signed(c);
    if (body === null) return refuse();
    const form = new URLSearchParams(body);
    if (form.get("command") === "/ask-desk") {
      const llm = cfg.llm;
      if (!llm) return c.json({ response_type: "ephemeral", text: "Concierge is not connected." });
      // Concierge can return contacts, so it answers only people the desk knows.
      const known = new Set([...Object.values(cfg.userMap ?? {}), ...cfg.approvers]);
      if (!known.has(form.get("user_id") ?? "")) return c.json({ response_type: "ephemeral", text: "Concierge answers people on the desk's list. Ask GTM Engineering to add you." });
      const [eventId, ...words] = (form.get("text") ?? "").trim().split(/\s+/);
      const reply = (text: string) => (cfg.fetch ?? fetch)(form.get("response_url")!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", text }) });
      // Slack allows three seconds, so the answer follows on the response URL.
      void (async () => {
        try {
          const client = await connectConcierge(db);
          await reply(await askConcierge(db, client, llm, eventId, words.join(" ")));
          await client.close();
        } catch (e) { console.error("concierge", e); await reply("I could not answer that right now."); }
      })().catch((e) => console.error("concierge reply", e));
      return c.json({ response_type: "ephemeral", text: "Looking that up." });
    }
    // Seat requests are made in the desk, one person asking for their own seat. The old request modal asked for a count of seats, so it is retired.
    return c.json({ response_type: "ephemeral", text: "Seat requests are made in Events Desk, under Seats, one for each person." });
  });

  app.post("/slack/interactions", async (c) => {
    const body = await signed(c);
    if (body === null) return refuse();
    const p = JSON.parse(new URLSearchParams(body).get("payload") ?? "{}");
    const actor: string = p.user?.id;

    if (p.type === "block_actions") {
      const action = p.actions?.[0];
      if (lifecycle && LIFECYCLE_ACTIONS.has(action?.action_id)) {
        const named = Object.entries(cfg.userMap ?? {}).find(([, id]) => id === actor)?.[0];
        const respond = (text: string) => (cfg.fetch ?? fetch)(p.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ replace_original: false, response_type: "ephemeral", text }) });
        if (!named) { await respond("You are not on the desk's list. Ask GTM Engineering to add you."); return c.body(null, 200); }
        try {
          if (action.action_id === "debrief_open") { await slackCall(cfg, "views.open", { trigger_id: p.trigger_id, view: modal("debrief_write", "Your debrief", [input("body", "Who mattered, what they said, what you would do differently")], action.value) }); return c.body(null, 200); }
          if (action.action_id === "meeting_booked") { await slackCall(cfg, "views.open", { trigger_id: p.trigger_id, view: modal("meeting_book", "Book the meeting", [input("when", "When? For example 2027-03-02 15:00 UTC")], action.value) }); return c.body(null, 200); }
          if (action.action_id === "owner_mine") { const r = await decideOwner(db, lifecycle, action.value, named, "mine"); await respond(`${r.company} is yours. Nobody there will be sequenced.`); }
          else if (action.action_id === "owner_include_all") { for (const id of String(action.value).split(",")) await decideOwner(db, lifecycle, id, named, "include"); await respond("Included. Thanks."); }
          else { await recordOutcome(db, lifecycle, action.value, action.action_id.replace("meeting_", "") as "held" | "no_show" | "cancelled", named); await respond("Recorded."); }
          await drainOps(db, lifecycle);
        } catch (e) { if (!(e instanceof RuleError)) throw e; await respond(e.message); }
        return c.body(null, 200);
      }
      if (action?.action_id === "decline") {
        await slackCall(cfg, "views.open", { trigger_id: p.trigger_id, view: modal("decline_reason", "Decline", [input("reason", "Why are you declining?")], action.value) });
        return c.body(null, 200);
      }
      if (action?.action_id === "approve") {
        const respond = (text: string, replace: boolean) => (cfg.fetch ?? fetch)(p.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(replace ? { replace_original: true, text } : { response_type: "ephemeral", replace_original: false, text }) });
        try {
          const r = String(action.value).startsWith("sr_")
            ? await decideSeat(db, { requestId: action.value, actor, decision: "approve", userMap: cfg.userMap })
            : await decideApproval(db, { approvalId: action.value, actor: await actorFor(db, cfg, action.value, actor), decision: "approve" });
          if (!r.already_decided) kick?.(r.event_id);
          await respond(r.already_decided ? `Already ${r.status} by ${r.decided_by}.` : `Confirmed by <@${actor}>.`, true);
        } catch (e) {
          if (!(e instanceof RuleError)) throw e;
          await respond(e.message, false);
        }
      }
      return c.body(null, 200);
    }

    if (p.type === "view_submission") {
      const v: View = p.view;
      try {
        const named = Object.entries(cfg.userMap ?? {}).find(([, id]) => id === actor)?.[0];
        if (lifecycle && named && v.callback_id === "debrief_write") { await answerDebrief(db, v.private_metadata, named, field(v, "body")); return c.json({ response_action: "clear" }); }
        if (lifecycle && named && v.callback_id === "meeting_book") { await bookMeeting(db, lifecycle, { contact_id: v.private_metadata, scheduled_at: field(v, "when"), source: "reply", rep: named }, named); return c.json({ response_action: "clear" }); }
        if (v.callback_id === "decline_reason") {
          if (v.private_metadata.startsWith("sr_")) await decideSeat(db, { requestId: v.private_metadata, actor, decision: "decline", reason: field(v, "reason"), userMap: cfg.userMap });
          else await decideApproval(db, { approvalId: v.private_metadata, actor: await actorFor(db, cfg, v.private_metadata, actor), decision: "decline", reason: field(v, "reason") });
        }
      } catch (e) {
        if (!(e instanceof RuleError)) throw e;
        return c.json({ response_action: "errors", errors: { [v.callback_id === "decline_reason" ? "reason" : "name"]: e.message } });
      }
      return c.json({ response_action: "clear" });
    }
    return c.body(null, 200);
  });
}
