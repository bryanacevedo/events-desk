/* What keeps the after-delivery work honest while it runs: messages that cannot be lost, one place for alerts, proof each tool was heard from, a response clock on replies, and people met in person. */

import type { Db } from "./db.ts";
import { stopContacts } from "./enroll-ops.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { DESK, nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { pauseSequenceById, drainOps } from "./sequences.ts";
import { addHold, addTouch } from "./touches.ts";
import type { CardMessage } from "./slack-cards.ts";
import { addDays, businessDaysAfter } from "../shared/motion.ts";
import { cleanLinkedin, companyKey, labelFromDomain } from "../shared/ingest.ts";
import { emailDomain, isFreeWebmail } from "../shared/layer0.ts";

type Q = Db["query"];
const MAX_TRIES = 5;

/* ---------------------------------------------------------- notifications */

export const queueDm = (q: Q, eventId: string | null, slackId: string, card: CardMessage) => q("INSERT INTO notifications (id, event_id, target, slack_id, card) VALUES ($1, $2, 'dm', $3, $4::jsonb)", [newId("ntf"), eventId, slackId, JSON.stringify(card)]);
export const queueThread = (q: Q, eventId: string, card: CardMessage) => q("INSERT INTO notifications (id, event_id, target, card) VALUES ($1, $2, 'thread', $3::jsonb)", [newId("ntf"), eventId, JSON.stringify(card)]);

/** Sends what is queued. One that keeps failing raises an alert instead of disappearing. */
export async function drainNotifications(db: Db, deps: LifecycleDeps) {
  if (!deps.notify) return { sent: 0 };
  const rows = await db.query<{ id: string; event_id: string | null; target: string; slack_id: string | null; card: CardMessage; attempts: number; thread: string | null }>(
    "SELECT n.id, n.event_id, n.target, n.slack_id, n.card, n.attempts, e.slack_thread AS thread FROM notifications n LEFT JOIN events e ON e.id = n.event_id WHERE n.status = 'queued' ORDER BY n.created_at, n.id LIMIT 200");
  let sent = 0;
  for (const n of rows) {
    let ok = false;
    try {
      if (n.target === "dm") ok = await deps.notify.dm(n.slack_id!, n.card);
      else {
        const [fresh] = await db.query<{ slack_thread: string | null }>("SELECT slack_thread FROM events WHERE id = $1", [n.event_id]);
        const t = await deps.notify.thread(fresh?.slack_thread ?? n.thread, n.card);
        ok = t !== null;
        if (t && !fresh?.slack_thread) await db.query("UPDATE events SET slack_thread = $2 WHERE id = $1 AND slack_thread IS NULL", [n.event_id, t]);
      }
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
export async function raiseAlert(db: Db, deps: LifecycleDeps, key: string, text: string) {
  const day = nowOf(deps).toISOString().slice(0, 10);
  const rows = await db.query("INSERT INTO alerts (id, key, day, text) VALUES ($1, $2, $3, $4) ON CONFLICT (key, day) DO NOTHING RETURNING id", [newId("alr"), key, day, text.slice(0, 500)]);
  if (rows.length) console.error("ALERT", key, text);
  return rows.length > 0;
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
  const { overdueCard } = await import("./slack-cards.ts");
  for (const m of late) await db.tx(async (q) => {
    await q("UPDATE inbound_messages SET escalated_at = $2 WHERE id = $1", [m.id, now.toISOString()]);
    const slackId = m.uploader ? deps.userMap?.[m.uploader] : undefined;
    const card = overdueCard({ person: m.full_name ?? "Someone", company: m.company });
    if (slackId) await queueDm(q, m.event_id, slackId, card); else await queueThread(q, m.event_id, card);
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
    // A badge scan is not a conversation: it changes the follow-up, it does not hand the person to a rep.
    const scanOnly = c.source === "badge_scan" && !c.met;
    if (scanOnly) await q("UPDATE contacts SET followup_tier = 'scanned' WHERE id = $1", [contact.id]);
    else await stopContacts(q, [contact.id], "pause", "met_onsite", capId);
    if (contact.domain && scanOnly) await addTouch(q, { domain: contact.domain, person_id: contact.person_id, contact_id: contact.id, event_id: eventId, kind: "badge_scan", source: rep, dedup_key: `onsite:${capId}` });
    if (contact.domain && !scanOnly) {
      await addHold(q, { domain: contact.domain, person_id: contact.person_id, cause: "live_thread", cause_id: contact.id, expires_at: new Date(now.getTime() + 14 * 86_400_000) });
      await addTouch(q, { domain: contact.domain, person_id: contact.person_id, contact_id: contact.id, event_id: eventId, kind: "met_onsite", reason: c.note ?? "", source: rep, dedup_key: `onsite:${capId}` });
      if (c.met) await q("INSERT INTO meetings (id, event_id, contact_id, domain, external_key, status, scheduled_at, source, rep, outcome_at) VALUES ($1, $2, $3, $4, $5, 'held', $6, 'onsite', $7, $6)", [newId("mtg"), eventId, contact.id, contact.domain, `onsite:${capId}`, now.toISOString(), rep]);
    }
    await logActivity(q, eventId, rep, "onsite", `${rep} met ${name ?? email ?? "someone"}${c.company ? ` from ${c.company}` : ""}`);
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
    const rows = await q<{ id: string }>("SELECT id FROM contacts WHERE lower(email) = $1", [e]);
    const ids = rows.map((r) => r.id);
    await stopContacts(q, ids, "remove", "erasure");
    await q("UPDATE inbound_messages SET body = NULL WHERE contact_id = ANY($1::text[])", [ids]);
    await q("UPDATE contacts SET full_name = NULL, title = NULL, linkedin = NULL, email = NULL, person_location = NULL, drop_reason = 'opted_out', dropped_at = coalesce(dropped_at, now()), person_id = NULL WHERE id = ANY($1::text[])", [ids]);
    await q("DELETE FROM person_emails WHERE email = $1", [e]);
    await q("DELETE FROM people WHERE email = $1", [e]);
    await q("DELETE FROM onsite_captures WHERE lower(email) = $1", [e]);
    await q("INSERT INTO suppressions (id, kind, email, reason, created_by) VALUES ($1, 'opt_out', $2, 'Erasure request', $3)", [newId("sup"), e, actor]);
    return { contacts: ids.length };
  });
  await drainOps(db, deps);
  return out;
}

/** Reply text is not kept forever. */
export const purgeOldBodies = (db: Db, deps: LifecycleDeps, days = 180) => db.query("UPDATE inbound_messages SET body = NULL WHERE body IS NOT NULL AND received_at < $1::timestamptz - ($2::text || ' days')::interval", [nowOf(deps).toISOString(), String(days)]);
