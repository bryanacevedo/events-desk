/* Replies (docs/LIFECYCLE.md, section 7). Stop first, think second: everything inbound pauses that person's whole cadence in the transaction that records it, before anything reads it. Reply text is untrusted and can only choose a code. */

import { DAY, LIVE_THREAD_HOLD_DAYS } from "../shared/policy.ts";
import type { Db } from "./db.ts";
import type { Connector, ToolEvent } from "./connectors/types.ts";
import { addSuppression, putVerification } from "./caches.ts";
import { canWrite, queueCreate, queueOptOut } from "./crm-outbox.ts";
import { stopContacts, stopDomain, stopInEvent } from "./enroll-ops.ts";
import { queueEvent, respondBy } from "./operating.ts";
import { logActivity, newId } from "./events.ts";
import { DESK, nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { openLifecycleCase } from "./lifecycle-cases.ts";
import { paidCall, parseJson } from "./paid.ts";
import { fill } from "./prompts.ts";
import type { Crm } from "./providers.ts";
import { doubtCard, replyCard } from "./slack-cards.ts";
import { addHold, addTouch, creditedEvent } from "./touches.ts";
import { drainOps } from "./sequences.ts";
import { nameKey } from "../shared/email.ts";
import { matchesUnsubscribe, REPLY_CODES, returnDate, type ReplyCode } from "../shared/motion.ts";
import { cleanReply } from "../shared/reply-clean.ts";

type Q = Db["query"];
/** Reply text is kept only as long as a person needs to read it. */
const BODY_MAX = 20_000;

async function findContact(db: Pick<Db, "query">, connector: string, e: ToolEvent) {
  const email = e.email?.toLowerCase() ?? null;
  const [hit] = await db.query<{ contact_id: string; event_id: string; person_id: string | null; domain: string }>(
    `SELECT n.contact_id, n.event_id, n.person_id, n.domain FROM enrollments n JOIN contacts k ON k.id = n.contact_id JOIN sequences s ON s.id = n.sequence_id
     WHERE s.connector = $1 AND ((($2::text IS NOT NULL AND lower(k.email) = $2) OR ($3::text IS NOT NULL AND k.linkedin = $3)) OR ($4::text IS NOT NULL AND n.external_contact_id = $4))
     ORDER BY (s.external_id = $5) DESC NULLS LAST, n.added_at DESC, n.id LIMIT 1`, [connector, email, e.linkedin, e.external_contact_id, e.sequence_external_id]);
  return hit ?? null;
}

/** Records what the tools report. Safe to call any number of times, in any order, from a webhook and a poll at once. */
export async function ingestEvents(db: Db, deps: LifecycleDeps, connector: Connector, events: ToolEvent[], opts: { drain?: boolean } = {}) {
  const out = { new: 0, duplicates: 0, unmatched: 0 };
  for (const e of events) {
    const c = await findContact(db, connector.name, e);
    if (e.signal === "send") {
      if (c) await db.tx((q) => addTouch(q, { domain: c.domain, person_id: c.person_id, contact_id: c.contact_id, event_id: c.event_id, kind: "send", channel: e.channel, at: e.at, source: connector.name, sender: e.sender ?? null, step: e.step ?? null, dedup_key: `${connector.name}:${e.provider_message_id}` }));
      continue;
    }
    await db.tx(async (q) => {
      const eventId = c ? (await creditedEvent(q, { contact_id: c.contact_id, person_id: c.person_id, domain: c.domain })) ?? c.event_id : null;
      const id = newId("inb");
      const ins = await q(`INSERT INTO inbound_messages (id, connector, provider_message_id, event_id, contact_id, channel, signal, body, received_at, status, thread_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (connector, provider_message_id) DO NOTHING RETURNING id`,
        [id, connector.name, e.provider_message_id, eventId, c?.contact_id ?? null, e.channel, e.signal, e.body ? e.body.slice(0, BODY_MAX) : null, e.at, c ? "received" : "unmatched", e.thread_url ?? null]);
      if (!ins.length) { out.duplicates++; return; }
      out.new++;
      if (!c) {
        out.unmatched++;
        await q("INSERT INTO alerts (id, key, day, text) VALUES ($1, $2, $3, $4) ON CONFLICT (key, day) DO NOTHING", [newId("alr"), `unmatched:${connector.name}`, nowOf(deps).toISOString().slice(0, 10), `${connector.name} sent a reply the desk could not match to anyone. See Replies we could not place.`]);
        // Someone who asked to be left alone is left alone, even if we cannot say which list they came from.
        if ((e.signal === "unsubscribe" || matchesUnsubscribe(cleanReply(e.body))) && e.email) await addSuppression({ query: q }, { kind: "opt_out", email: e.email, reason: `Unsubscribed in ${connector.name}`, created_by: DESK });
        return;
      }
      await stopContacts(q, [c.contact_id], "pause", "inbound", id);
      await addTouch(q, { domain: c.domain, person_id: c.person_id, contact_id: c.contact_id, event_id: eventId, kind: e.signal, channel: e.channel, at: e.at, source: connector.name, dedup_key: `${connector.name}:${e.provider_message_id}` });
    });
  }
  if (opts.drain !== false) await drainOps(db, deps);
  return out;
}

interface Msg { id: string; event_id: string; contact_id: string; channel: string; signal: string; body: string | null; connector: string }
interface Who { full_name: string | null; email: string | null; company: string; company_key: string; company_id: string; person_id: string | null; domain: string; event: string }

const who = async (q: Q, m: Pick<Msg, "contact_id" | "event_id">) => (await q<Who>(
  `SELECT k.full_name, k.email, co.name AS company, co.key AS company_key, co.id AS company_id, k.person_id, co.primary_domain AS domain, e.name AS event
   FROM contacts k JOIN companies co ON co.id = k.company_id JOIN events e ON e.id = $2 WHERE k.id = $1`, [m.contact_id, m.event_id]))[0];

/** Someone at this company is talking to us: nobody else there keeps getting the sequence while they do. */
async function holdAccount(q: Q, m: Msg, p: Who, now: Date) {
  await addHold(q, { domain: p.domain, cause: "live_thread", cause_id: m.contact_id, expires_at: new Date(now.getTime() + LIVE_THREAD_HOLD_DAYS * DAY) });
  await q("UPDATE enrollments SET cause = 'waiting_for_rep' WHERE contact_id = $1 AND state = 'paused'", [m.contact_id]);
  await stopDomain(q, p.domain, "pause", "colleague_replied", m.id);
}

/** A positive reply creates its CRM trail, whatever the event's Lead setting: the campaign member, a task for the rep, and a Lead if there is no record. */
async function positiveTrail(q: Q, m: Msg, p: Who, code: string, ctx: { crm?: Crm | null; now: Date }) {
  if (!canWrite(ctx.crm) || !p.email) return;
  const base = { email: p.email.toLowerCase(), full_name: p.full_name, company: p.company, domain: p.domain, event_id: m.event_id };
  await queueCreate(q, "lead", `lead:${p.email.toLowerCase()}`, p.person_id, base);
  await queueCreate(q, "campaign_member", `cm:${m.event_id}:${m.contact_id}`, p.person_id, { ...base, campaign: p.event, status: "Responded" });
  await queueCreate(q, "task", `task:${m.id}`, p.person_id, { ...base, subject: `${p.full_name ?? "Someone"} at ${p.company} replied (${code.replace(/_/g, " ")})`, body: m.body ?? "", due: ctx.now.toISOString().slice(0, 10) });
}

/** What each code does, in code. `modelOnly` means nothing but a model's reading supports it, so a suppression is marked for a person to confirm. */
async function applyCode(q: Q, m: Msg, p: Who, code: ReplyCode, ctx: { modelOnly: boolean; actor: string; now: Date; crm?: Crm | null }) {
  const nk = p.full_name ? nameKey(p.full_name) : null;
  const suppress = async (kind: "opt_out" | "wrong_person") => {
    const before = await q<{ id: string }>("SELECT id FROM suppressions WHERE kind = $1 AND email = $2 LIMIT 1", [kind, p.email?.toLowerCase() ?? ""]);
    if (!before.length) await addSuppression({ query: q }, { kind, email: p.email, name_key: nk, company_key: nk ? p.company_key : null, reason: `Reply read as ${code}`, created_by: ctx.actor, name: p.full_name, company: p.company });
    if (ctx.modelOnly) {
      const [s] = await q<{ id: string }>("UPDATE suppressions SET needs_confirmation = true WHERE id = (SELECT id FROM suppressions WHERE kind = $1 AND (email = $2 OR (email IS NULL AND name_key = $3)) ORDER BY created_at DESC LIMIT 1) RETURNING id", [kind, p.email?.toLowerCase() ?? "", nk]);
      await openLifecycleCase(q, { eventId: m.event_id, kind: "suppression_confirm", contactId: m.contact_id, companyId: p.company_id, summary: `A model read ${p.full_name ?? "this person"}'s reply as ${code.replace(/_/g, " ")}. Is that right?`, facts: [{ reply: m.body ?? "(no text)" }], suggested: "confirm", payload: { suppression_id: s?.id, inbound_id: m.id } });
      await q("UPDATE inbound_messages SET needs_confirmation = true WHERE id = $1", [m.id]);
    }
  };
  switch (code) {
    case "unsubscribe":
      await suppress("opt_out");
      if (!ctx.modelOnly) {
        await queueOptOut(q, ctx.crm, { email: p.email, name: p.full_name, company: p.company });
        await stopContacts(q, [m.contact_id], "remove", "unsubscribe", m.id);
        await q("UPDATE contacts SET drop_reason = 'opted_out', dropped_at = coalesce(dropped_at, now()) WHERE id = $1", [m.contact_id]);
      }
      break;
    case "bounced":
      if (p.email) await putVerification({ query: q } as Db, p.email, "undeliverable", m.connector, m.event_id);
      await q("UPDATE contacts SET verify_1 = 'undeliverable' WHERE id = $1", [m.contact_id]);
      await stopContacts(q, [m.contact_id], "remove", "bounced", m.id);
      break;
    case "wrong_person":
      await suppress("wrong_person");
      if (!ctx.modelOnly) await stopContacts(q, [m.contact_id], "remove", "wrong_person", m.id);
      break;
    case "departed":
      await stopContacts(q, [m.contact_id], "remove", "departed", m.id);
      await openLifecycleCase(q, { eventId: m.event_id, kind: "successor", contactId: m.contact_id, companyId: p.company_id, summary: `${p.full_name ?? "Someone"} has left ${p.company}. Who took over?`, facts: [{ reply: m.body ?? "(no text)" }], suggested: "added" });
      break;
    case "out_of_office": {
      const back = returnDate(m.body, ctx.now);
      const at = back ? new Date(`${back}T09:00:00Z`) : new Date(ctx.now.getTime() + 7 * DAY);
      await q("UPDATE enrollments SET cause = 'out_of_office', resume_at = $3 WHERE contact_id = $1 AND state = 'paused' AND cause = 'inbound' AND cause_id = $2", [m.contact_id, m.id, at.toISOString()]);
      break;
    }
    case "referral":
      await openLifecycleCase(q, { eventId: m.event_id, kind: "referral", contactId: m.contact_id, companyId: p.company_id, summary: `${p.full_name ?? "Someone"} at ${p.company} pointed us to someone else.`, facts: [{ reply: m.body ?? "(no text)" }], suggested: "added" });
      await holdAccount(q, m, p, ctx.now);
      break;
    case "interested":
    case "meeting_request":
      await holdAccount(q, m, p, ctx.now);
      await positiveTrail(q, m, p, code, ctx);
      break;
    case "not_now":
    case "not_interested":
      await stopInEvent(q, m.contact_id, m.event_id, code, m.id);
      if (code === "not_now" && canWrite(ctx.crm) && p.email) await queueCreate(q, "task", `recontact:${m.id}`, p.person_id, { email: p.email.toLowerCase(), full_name: p.full_name, company: p.company, domain: p.domain, event_id: m.event_id, subject: `Check back with ${p.full_name ?? "this contact"} at ${p.company}`, body: m.body ?? "", due: new Date(ctx.now.getTime() + 90 * DAY).toISOString().slice(0, 10) });
      break;
    default:
      break;
  }
  await addTouch(q, { domain: p.domain, person_id: p.person_id, contact_id: m.contact_id, event_id: m.event_id, kind: `reply_${code}`, channel: m.channel, source: ctx.actor, dedup_key: `code:${m.id}:${code}` });
}

async function openDoubt(q: Q, m: Msg, p: Who, why: string) {
  await q("UPDATE inbound_messages SET doubtful = true WHERE id = $1", [m.id]);
  await openLifecycleCase(q, { eventId: m.event_id, kind: "reply_doubtful", contactId: m.contact_id, companyId: p.company_id, summary: `A reply from ${p.full_name ?? "someone"} at ${p.company} needs a person to read it (${why}).`, facts: [{ reply: m.body ?? "(this tool sends no reply text)" }], suggested: null, payload: { inbound_id: m.id } });
}

/** A person's answer to a doubtful reply. Runs in the case's transaction. */
export async function applyReplyAnswer(q: Q, inboundId: string, code: string, actor: string, crm?: Crm | null) {
  const [m] = await q<Msg>("SELECT id, event_id, contact_id, channel, signal, body, connector FROM inbound_messages WHERE id = $1", [inboundId]);
  if (!m?.contact_id) return;
  const p = await who(q, m);
  await applyCode(q, m, p, code as ReplyCode, { modelOnly: false, actor, now: new Date(), crm });
  await q("UPDATE inbound_messages SET code = $2, decided_by = $3, decided_at = now(), doubtful = false WHERE id = $1", [inboundId, code, actor]);
}

/** One paid call on the Motion card. Null when the card has run out or the answer cannot be used. */
async function classify(db: Db, deps: LifecycleDeps, eventId: string, body: string): Promise<{ code: ReplyCode | null; refused: boolean; referred?: string | null; same_person?: boolean }> {
  const prompt = fill("reply_classify", { codes: REPLY_CODES.join(", "), reply: body.slice(0, 4000).replaceAll("REPLY>>>", "REPLY") });
  const out = await paidCall(db, eventId, deps.llm, "reply_classify", prompt);
  if (out.kind === "refused") return { code: null, refused: true };
  if (out.kind === "failed") return { code: null, refused: false };
  const v = parseJson(out.text) as { code?: unknown; referred?: unknown; same_person?: unknown } | null;
  // A name counts only if it is in the reply word for word.
  const referred = typeof v?.referred === "string" && v.referred.trim() && body.includes(v.referred.trim()) ? v.referred.trim().slice(0, 120) : null;
  return { code: REPLY_CODES.includes(v?.code as ReplyCode) ? (v!.code as ReplyCode) : null, refused: false, referred, same_person: v?.same_person !== false };
}

/** Works through what has arrived. A crash replays: consequences and the "done" mark are one transaction. */
export async function processInbound(db: Db, deps: LifecycleDeps, limit = 200) {
  const now = nowOf(deps);
  const claimed = await db.tx((q) => q<Msg>(
    `UPDATE inbound_messages SET lease_until = $1::timestamptz + interval '5 minutes' WHERE id IN (SELECT id FROM inbound_messages WHERE status = 'received' AND (lease_until IS NULL OR lease_until < $1::timestamptz) ORDER BY received_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING id, event_id, contact_id, channel, signal, body, connector`, [now.toISOString(), limit]));
  const out = { processed: 0, doubtful: 0 };
  for (const m of claimed) {
    // Code runs first. These never wait for a model and never depend on one.
    const provider = m.signal === "bounce" ? "bounced" : m.signal === "unsubscribe" ? "unsubscribe" : null;
    // Only what the person typed is read: a footer or a quoted thread must never decide anything.
    const typed = cleanReply(m.body);
    const reading = { ...m, body: typed };
    const keyword = !provider && matchesUnsubscribe(typed);
    await db.query("UPDATE inbound_messages SET lease_until = $2::timestamptz + interval '5 minutes' WHERE id = $1", [m.id, new Date().toISOString()]);
    let code: ReplyCode | null = provider ?? (keyword ? "unsubscribe" : null);
    let modelCode: ReplyCode | null = null, doubt: string | null = null, referredName: string | null = null;
    if (!provider) {
      if (!typed) doubt = m.body?.trim() ? "nothing is left once the quoted text is removed" : "this tool sends no reply text";
      else {
        const c = await classify(db, deps, m.event_id, typed);
        modelCode = c.code; referredName = c.referred ?? null;
        if (c.same_person === false && !keyword) doubt = "it may have been written by someone else";
        if (keyword) { if (c.code && c.code !== "unsubscribe") doubt = "the words say unsubscribe and the model read it otherwise"; }
        else if (c.refused) doubt = "the Motion card ran out";
        else if (!c.code) doubt = "the model's answer could not be used";
        else if (c.code === "other") doubt = "it fits no category";
        else if (!doubt) code = c.code;
      }
    }
    const p = await who(db.query, m);
    await db.tx(async (q) => {
      const [cur] = await q<{ status: string }>("SELECT status FROM inbound_messages WHERE id = $1 FOR UPDATE", [m.id]);
      if (cur.status !== "received") return;
      // A name pointed to with any other answer still reaches a person.
      if (referredName && code !== "referral") await openLifecycleCase(q, { eventId: m.event_id, kind: "referral", contactId: m.contact_id, companyId: p.company_id, summary: `${p.full_name ?? "Someone"} at ${p.company} pointed us to ${referredName}.`, facts: [{ reply: typed, named: referredName }], suggested: "added", payload: { named: referredName } });
      if (code) await applyCode(q, reading, p, code, { modelOnly: !provider && !keyword, actor: DESK, now, crm: deps.crm });
      if (doubt) { await openDoubt(q, m, p, doubt); out.doubtful++; await logActivity(q, m.event_id, DESK, "reply", `A reply needs a person: ${doubt}`); }
      await q("UPDATE inbound_messages SET status = 'done', code = $2, model_code = $3, code_matched = $4, lease_until = NULL WHERE id = $1", [m.id, code, modelCode, Boolean(provider || keyword)]);
      await announce(q, deps, m, p, code, doubt, now);
    });
    out.processed++;
  }
  if (claimed.length) await drainOps(db, deps);
  return out;
}

/** Written in the same transaction as the decision, then sent from a queue, so a Slack outage loses nothing. A hot reply goes to the event's channel with the account's owner @-mentioned, on a clock. */
async function announce(q: Q, deps: LifecycleDeps, m: Msg, p: Who, code: ReplyCode | null, doubt: string | null, now: Date) {
  const name = p.full_name ?? "Someone", body = cleanReply(m.body) || m.body;
  const hot = !doubt && code && ["interested", "meeting_request", "referral"].includes(code);
  if (doubt) await queueEvent(q, m.event_id, doubtCard({ person: name, company: p.company, body }));
  if (!hot) return;
  const card = replyCard({ event: p.event, person: name, company: p.company, code: code!, body, contact_id: m.contact_id, channel: m.channel });
  const [o] = await q<{ owner: string | null }>("SELECT coalesce((SELECT d.owner FROM owner_decisions d WHERE d.event_id = $1 AND d.company_id = $2), (SELECT account_owner FROM companies WHERE id = $2)) AS owner", [m.event_id, p.company_id]);
  const slackId = o?.owner ? deps.userMap?.[o.owner] : undefined;
  await q("UPDATE inbound_messages SET owner = $2, respond_by = $3 WHERE id = $1", [m.id, o?.owner ?? null, respondBy(now, deps.holidays).toISOString()]);
  await queueEvent(q, m.event_id, card, [slackId]);
}
