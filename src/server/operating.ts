/* What keeps the after-delivery work honest while it runs: messages that cannot be lost, one place for alerts, proof each tool was heard from, a response clock on replies, and people met in person. */

import { eventZone } from "./meetings.ts";
import { DAY, LIVE_THREAD_HOLD_DAYS } from "../shared/policy.ts";
import type { Db } from "./db.ts";
import { welcomeRoom } from "./event-room.ts";
import { stopContacts } from "./enroll-ops.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { DESK, nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { pauseSequenceById, drainOps } from "./sequences.ts";
import { addHold, addTouch } from "./touches.ts";
import { alertCard, hotCaptureCard, overdueCard, type CardMessage } from "./slack-cards.ts";
import { canWrite, queueCreate } from "./crm-outbox.ts";
import { addDays, businessDaysAfter } from "../shared/motion.ts";
import { cleanLinkedin, companyKey, labelFromDomain } from "../shared/ingest.ts";
import { emailDomain, isFreeWebmail } from "../shared/layer0.ts";
import { nameKey } from "../shared/email.ts";

type Q = Db["query"];
const MAX_TRIES = 5;

/* ---------------------------------------------------------- notifications */

/** A card for the event's channel, @-mentioning the people it is for. Written in the caller's transaction and sent from the queue, so a Slack outage loses nothing. */
export const queueEvent = (q: Q, eventId: string, card: CardMessage, mention: (string | null | undefined)[] = []) =>
  q("INSERT INTO notifications (id, event_id, target, card, mention) VALUES ($1, $2, 'event', $3::jsonb, $4::text[])", [newId("ntf"), eventId, JSON.stringify(card), [...new Set(mention.filter((m): m is string => Boolean(m)))]]);
/** A card for the ops channel. */
export const queueOps = (q: Q, card: CardMessage) => q("INSERT INTO notifications (id, event_id, target, card) VALUES ($1, NULL, 'ops', $2::jsonb)", [newId("ntf"), JSON.stringify(card)]);

/** Posts to the event's channel now, and remembers the channel the first time. For callers that must know it arrived (an owner card that did not becomes the uploader's to decide). */
export async function postToEvent(db: Db, deps: LifecycleDeps, eventId: string, card: CardMessage, mention: (string | null | undefined)[] = []) {
  if (!deps.notify) return false;
  const [e] = await db.query<{ name: string; slack_channel: string | null; archived: boolean }>("SELECT name, slack_channel, slack_archived_at IS NOT NULL AS archived FROM events WHERE id = $1", [eventId]);
  if (!e) return false;
  // A room closed 90 days after the event: anything late goes to the ops channel, named, rather than reopening it.
  if (e.archived) { try { return await deps.notify.ops({ ...card, text: `${e.name}: ${card.text}` }); } catch { return false; } }
  let channel: string | null = null;
  try { channel = await deps.notify.post({ event_id: eventId, name: e.name, channel: e.slack_channel }, card, [...new Set(mention.filter((m): m is string => Boolean(m)))]); } catch { channel = null; }
  if (channel && !e.slack_channel) {
    const opened = await db.query("UPDATE events SET slack_channel = $2 WHERE id = $1 AND slack_channel IS NULL RETURNING id", [eventId, channel]);
    if (opened.length) await welcomeRoom(db.query, eventId, channel, deps.notify, deps.userMap, deps.appUrl);
  }
  return channel !== null;
}

/** Sends what is queued. One that keeps failing raises an alert instead of disappearing. */
export async function drainNotifications(db: Db, deps: LifecycleDeps) {
  if (!deps.notify) return { sent: 0 };
  const rows = await db.query<{ id: string; event_id: string | null; target: string; mention: string[]; card: CardMessage; attempts: number }>(
    "SELECT id, event_id, target, mention, card, attempts FROM notifications WHERE status = 'queued' ORDER BY created_at, id LIMIT 200");
  let sent = 0;
  for (const n of rows) {
    let ok = false;
    try {
      ok = n.target === "ops" ? await deps.notify.ops(n.card) : await postToEvent(db, deps, n.event_id!, n.card, n.mention);
    } catch { ok = false; }
    if (ok) { await db.query("UPDATE notifications SET status = 'sent', attempts = attempts + 1, sent_at = now() WHERE id = $1", [n.id]); sent++; continue; }
    const tries = n.attempts + 1;
    await db.query("UPDATE notifications SET attempts = $2, status = $3 WHERE id = $1", [n.id, tries, tries >= MAX_TRIES ? "failed" : "queued"]);
    if (tries >= MAX_TRIES) await raiseAlert(db, deps, `notify:${n.id}`, `A Slack message could not be delivered after ${MAX_TRIES} tries: ${n.card.text}`);
  }
  return { sent };
}

/* ----------------------------------------------------------------- alerts */

/** One alert per problem per day, kept where anyone can see it. Slack is told when it can be. */
export async function raiseAlert(db: Db, deps: LifecycleDeps, key: string, text: string, opts: { direct?: boolean } = {}) {
  const day = nowOf(deps).toISOString().slice(0, 10);
  const rows = await db.query("INSERT INTO alerts (id, key, day, text) VALUES ($1, $2, $3, $4) ON CONFLICT (key, day) DO NOTHING RETURNING id", [newId("alr"), key, day, text.slice(0, 500)]);
  if (!rows.length) return false;
  console.error(JSON.stringify({ event: "alert", key, text: text.slice(0, 500) }));
  // It goes to the ops channel. Not a failed Slack message itself: that would queue another message to the same broken Slack. Those show on /api/health.
  if (key.startsWith("notify:")) return true;
  // A stuck pass cannot send what it queues, so that alert goes straight to Slack, and to the queue only if Slack does not take it.
  if (opts.direct && deps.notify) { let sent = false; try { sent = await deps.notify.ops(alertCard({ text })); } catch { sent = false; } if (sent) return true; }
  await queueOps(db.query, alertCard({ text }));
  return true;
}

/* -------------------------------------------------------- hearing from tools */

export const BLIND_MINUTES = 60;

export async function recordRun(db: Db, connector: string, ok: boolean, events: number, error?: string, at: Date = new Date()) {
  if (ok) await db.query("INSERT INTO connector_runs (connector, last_ok_at, last_events) VALUES ($1, $3, $2) ON CONFLICT (connector) DO UPDATE SET last_ok_at = $3, last_events = $2", [connector, events, at.toISOString()]);
  else await db.query("INSERT INTO connector_runs (connector, last_error, last_error_at) VALUES ($1, $2, $3) ON CONFLICT (connector) DO UPDATE SET last_error = $2, last_error_at = $3", [connector, (error ?? "failed").slice(0, 300), at.toISOString()]);
}

/** A live sequence the desk has not heard about for an hour pauses. If we cannot see the replies, we cannot stop for them. */
export async function blindSweep(db: Db, deps: LifecycleDeps, lastOk: (connector: string) => Promise<Date | null>) {
  const now = nowOf(deps);
  let paused = 0;
  for (const c of Object.values(deps.connectors)) {
    if (c.capabilities.events === "webhook") continue;
    const live = await db.query<{ id: string; name: string }>("SELECT id, name FROM sequences WHERE connector = $1 AND state = 'active'", [c.name]);
    if (!live.length) continue;
    const ok = await lastOk(c.name);
    if (ok && now.getTime() - ok.getTime() < BLIND_MINUTES * 60_000) continue;
    for (const s of live) { await pauseSequenceById(db, deps, s.id, `The desk has not heard from ${c.name} for over ${BLIND_MINUTES} minutes, so it cannot see replies.`); paused++; }
    await raiseAlert(db, deps, `blind:${c.name}`, `${c.name} has gone quiet. ${live.length} live ${live.length === 1 ? "sequence was" : "sequences were"} paused until it answers.`);
  }
  return { paused };
}

/* -------------------------------------------------------- the response clock */

/** The next business day, end of day. A reply that wants a rep should not wait longer. */
export function respondBy(at: Date, holidays: string[] = []) {
  let d = at.toISOString().slice(0, 10);
  do { d = addDays(d, 1); } while (businessDaysAfter(addDays(d, -1), d, holidays) === 0);
  return new Date(`${d}T23:59:00Z`);
}

export async function markHandled(db: Db, inboundId: string, actor: string) {
  const rows = await db.query("UPDATE inbound_messages SET handled_at = now(), handled_by = $2 WHERE id = $1 AND handled_at IS NULL RETURNING id", [inboundId, actor]);
  if (!rows.length) throw new RuleError("That reply is already handled.");
  return { handled: true };
}

/** A hot reply nobody picked up goes to the person who uploaded the list. Once. */
export async function escalateWaiting(db: Db, deps: LifecycleDeps) {
  const now = nowOf(deps);
  const late = await db.query<{ id: string; event_id: string; full_name: string | null; company: string; uploader: string | null }>(
    `SELECT m.id, m.event_id, k.full_name, co.name AS company, (SELECT u.uploaded_by FROM uploads u WHERE u.event_id = m.event_id ORDER BY u.created_at DESC LIMIT 1) AS uploader
     FROM inbound_messages m JOIN contacts k ON k.id = m.contact_id JOIN companies co ON co.id = k.company_id WHERE m.respond_by < $1::timestamptz AND m.handled_at IS NULL AND m.escalated_at IS NULL`, [now.toISOString()]);
  for (const m of late) await db.tx(async (q) => {
    await q("UPDATE inbound_messages SET escalated_at = $2 WHERE id = $1", [m.id, now.toISOString()]);
    await queueEvent(q, m.event_id, overdueCard({ person: m.full_name ?? "Someone", company: m.company }), [m.uploader ? deps.userMap?.[m.uploader] : null]);
    await logActivity(q, m.event_id, DESK, "reply", `Nobody picked up the reply from ${m.full_name ?? "someone"} at ${m.company}`);
  });
  return { escalated: late.length };
}

/* ------------------------------------------------------------------ on site */

export interface Capture { full_name?: string; email?: string; linkedin?: string; company?: string; title?: string; note?: string; temperature?: "hot" | "warm" | "cold"; met?: boolean; source?: "quick_add" | "badge_scan" }

/** Someone met at the booth or scanned at the door, on a list or not. They stop getting automated outreach within the same write: a rep has them now. */
export async function captureOnsite(db: Db, deps: LifecycleDeps, eventId: string, rep: string, c: Capture) {
  const email = c.email?.trim().toLowerCase() || null, linkedin = cleanLinkedin(c.linkedin), name = c.full_name?.trim() || null;
  if (!email && !linkedin && !(name && c.company?.trim())) throw new RuleError("Give an email, a LinkedIn profile, or a name and a company.");
  const now = nowOf(deps);
  const out = await db.tx(async (q) => {
    const [ev] = await q("SELECT 1 FROM events WHERE id = $1", [eventId]);
    if (!ev) throw new RuleError("That event does not exist.");
    const [found] = await q<{ id: string; person_id: string | null; domain: string | null }>(
      `SELECT k.id, k.person_id, co.primary_domain AS domain FROM contacts k JOIN companies co ON co.id = k.company_id
       WHERE k.event_id = $1 AND (($2::text IS NOT NULL AND lower(k.email) = $2) OR ($3::text IS NOT NULL AND k.linkedin = $3) OR ($4::text IS NOT NULL AND $5::text IS NOT NULL AND lower(k.full_name) = lower($4) AND co.key = $5)) LIMIT 1`,
      [eventId, email, linkedin, name, c.company ? companyKey(c.company) : null]);
    let contact = found;
    if (!contact) {
      const d = email ? emailDomain(email) : null, domain = d && !isFreeWebmail(d) ? d : null;
      const company = c.company?.trim() || (domain ? labelFromDomain(domain) : "Unknown company"), key = companyKey(company);
      let [co] = await q<{ id: string; primary_domain: string | null }>("SELECT id, primary_domain FROM companies WHERE event_id = $1 AND (key = $2 OR ($3::text IS NOT NULL AND primary_domain = $3)) LIMIT 1", [eventId, key, domain]);
      if (!co) { [co] = await q<{ id: string; primary_domain: string | null }>("INSERT INTO companies (id, event_id, key, name, primary_domain, identity_state, identity_via, name_provisional) VALUES ($1, $2, $3, $4, $5, $6, 'onsite', $7) RETURNING id, primary_domain", [newId("co"), eventId, key, company, domain, domain ? "resolved" : "unresolved", !c.company?.trim()]); }
      const id = newId("con");
      // Every person traces to a row. A walk-up's row is the capture itself, on the event's latest list.
      const [up] = await q<{ id: string; next: number }>("SELECT u.id, coalesce((SELECT max(r.row_number) FROM source_rows r WHERE r.upload_id = u.id), 0) + 1 AS next FROM uploads u WHERE u.event_id = $1 ORDER BY u.created_at DESC, u.id DESC LIMIT 1", [eventId]);
      if (!up) throw new RuleError("This event has no attendee list yet.");
      const rowId = newId("row");
      await q("INSERT INTO source_rows (id, event_id, upload_id, row_number, raw, kind, company_id, issues) VALUES ($1, $2, $3, $4, $5::jsonb, 'person', $6, '[]'::jsonb)", [rowId, eventId, up.id, up.next, JSON.stringify({ captured_on_site: true, name, email, company }), co.id]);
      await q("INSERT INTO contacts (id, event_id, source_row_id, company_id, full_name, title, email, linkedin, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'onsite')", [id, eventId, rowId, co.id, name, c.title?.trim() || null, email, linkedin]);
      contact = { id, person_id: null, domain: co.primary_domain };
    }
    const capId = newId("cap");
    await q("INSERT INTO onsite_captures (id, event_id, contact_id, full_name, email, linkedin, company, title, note, temperature, rep, source, captured_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
      [capId, eventId, contact.id, name, email, linkedin, c.company ?? null, c.title ?? null, (c.note ?? "").slice(0, 4000), c.temperature ?? "warm", rep, c.source ?? "quick_add", now.toISOString()]);
    // A badge scan is not a conversation: it changes the follow-up, it does not hand the person to a rep. A hot one is a conversation worth having today.
    const hot = c.temperature === "hot";
    const scanOnly = c.source === "badge_scan" && !c.met && !hot;
    if (scanOnly) await q("UPDATE contacts SET followup_tier = 'scanned' WHERE id = $1", [contact.id]);
    else await stopContacts(q, [contact.id], "pause", "met_onsite", capId);
    if (contact.domain && scanOnly) await addTouch(q, { domain: contact.domain, person_id: contact.person_id, contact_id: contact.id, event_id: eventId, kind: "badge_scan", source: rep, dedup_key: `onsite:${capId}` });
    if (contact.domain && !scanOnly) {
      await addHold(q, { domain: contact.domain, person_id: contact.person_id, cause: "live_thread", cause_id: contact.id, expires_at: new Date(now.getTime() + LIVE_THREAD_HOLD_DAYS * DAY) });
      await addTouch(q, { domain: contact.domain, person_id: contact.person_id, contact_id: contact.id, event_id: eventId, kind: "met_onsite", reason: c.note ?? "", source: rep, dedup_key: `onsite:${capId}` });
      if (c.met) await q("INSERT INTO meetings (id, event_id, contact_id, domain, external_key, status, scheduled_at, source, rep, outcome_at, timezone) VALUES ($1, $2, $3, $4, $5, 'held', $6, 'onsite', $7, $6, $8)", [newId("mtg"), eventId, contact.id, contact.domain, `onsite:${capId}`, now.toISOString(), rep, await eventZone(q, eventId)]);
    }
    await logActivity(q, eventId, rep, "onsite", `${rep} met ${name ?? email ?? "someone"}${c.company ? ` from ${c.company}` : ""}`);
    // Hot goes to the rep who had the conversation, the same day: a task in the CRM and a card in the event's channel. The person never goes into a sequence.
    if (hot) {
      const [known] = await q<{ full_name: string | null }>("SELECT full_name FROM contacts WHERE id = $1", [contact.id]);
      const who = name ?? known?.full_name ?? email ?? "Someone";
      if (canWrite(deps.crm) && email) await queueCreate(q, "task", `hot:${capId}`, contact.person_id, { email, full_name: name, company: c.company ?? null, domain: contact.domain, event_id: eventId, subject: `Hot from the booth: ${who}`, body: c.note ?? "", due: now.toISOString().slice(0, 10), owner: rep });
      await queueEvent(q, eventId, hotCaptureCard({ person: who, company: c.company ?? null, note: c.note ?? "" }), [deps.userMap?.[rep]]);
    }
    return { capture_id: capId, contact_id: contact.id, on_list: Boolean(found) };
  });
  await drainOps(db, deps, eventId);
  return out;
}

/* ---------------------------------------------------------- right to erasure */

/** Removes what the desk holds about a person and keeps only the block, so they are never contacted again. Legal risk: high; counsel confirms the process. */
export async function forgetPerson(db: Db, deps: LifecycleDeps, email: string, actor: string) {
  const e = email.trim().toLowerCase();
  const out = await db.tx(async (q) => {
    // Every record of the person: by address, by the shared person record, and by LinkedIn profile.
    const rows = await q<{ id: string; full_name: string | null; key: string | null; linkedin: string | null }>(
      `SELECT k.id, k.full_name, co.key, k.linkedin FROM contacts k LEFT JOIN companies co ON co.id = k.company_id
       WHERE lower(k.email) = $1 OR k.person_id IN (SELECT person_id FROM contacts WHERE lower(email) = $1 AND person_id IS NOT NULL)
          OR (k.linkedin IS NOT NULL AND k.linkedin IN (SELECT linkedin FROM contacts WHERE lower(email) = $1 AND linkedin IS NOT NULL))`, [e]);
    const ids = rows.map((r) => r.id);
    // The name at the company is blocked too, so a later list with no address still finds them.
    for (const r of rows) if (r.full_name && r.key) await q("INSERT INTO suppressions (id, kind, name_key, company_key, reason, created_by) VALUES ($1, 'opt_out', $2, $3, 'Erasure request', $4)", [newId("sup"), nameKey(r.full_name), r.key, actor]);
    await stopContacts(q, ids, "remove", "erasure");
    await q("UPDATE inbound_messages SET body = NULL WHERE contact_id = ANY($1::text[])", [ids]);
    await q("UPDATE contacts SET full_name = NULL, title = NULL, linkedin = NULL, email = NULL, person_location = NULL, drop_reason = 'opted_out', dropped_at = coalesce(dropped_at, now()), person_id = NULL WHERE id = ANY($1::text[])", [ids]);
    await q("DELETE FROM person_emails WHERE email = $1", [e]);
    await q("DELETE FROM people WHERE email = $1", [e]);
    await q("DELETE FROM onsite_captures WHERE lower(email) = $1 OR contact_id = ANY($2::text[])", [e, ids]);
    // Copies elsewhere: notes on their history, CRM writes not yet sent, and Slack cards still waiting to go.
    await q("UPDATE touches SET reason = '' WHERE contact_id = ANY($1::text[])", [ids]);
    await q("UPDATE crm_outbox SET status = 'cancelled' WHERE status = 'queued' AND lower(payload->>'email') = $1", [e]);
    await q("UPDATE notifications SET card = '{}'::jsonb, status = CASE WHEN status = 'queued' THEN 'failed' ELSE status END WHERE event_id IN (SELECT event_id FROM contacts WHERE id = ANY($1::text[])) AND card::text ILIKE '%' || $2 || '%'", [ids, (await q<{ full_name: string | null }>("SELECT full_name FROM contacts WHERE id = ANY($1::text[]) AND full_name IS NOT NULL LIMIT 1", [ids]))[0]?.full_name ?? e]);
    await q("INSERT INTO suppressions (id, kind, email, reason, created_by) VALUES ($1, 'opt_out', $2, 'Erasure request', $3)", [newId("sup"), e, actor]);
    return { contacts: ids.length };
  });
  await drainOps(db, deps);
  return out;
}

/** Reply text is not kept forever: replies after 180 days, and the copies inside sent Slack cards after 7. */
export async function purgeOldBodies(db: Db, deps: LifecycleDeps, days = 180) {
  const now = nowOf(deps).toISOString();
  await db.query("UPDATE inbound_messages SET body = NULL WHERE body IS NOT NULL AND received_at < $1::timestamptz - ($2::text || ' days')::interval", [now, String(days)]);
  await db.query("UPDATE notifications SET card = '{}'::jsonb WHERE status <> 'queued' AND card <> '{}'::jsonb AND created_at < $1::timestamptz - interval '7 days'", [now]);
}
