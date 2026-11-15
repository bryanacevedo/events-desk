/* What is owed to Salesforce (docs/DATA-HYGIENE.md, sections 5 and 6a). A row is queued in the same transaction as the thing that caused it, and sent by a sweep started at boot, never by a
   run, so a failed write cannot touch a delivery. Nothing is queued unless the CRM can write: `noCrm` cannot, so live mode queues nothing.

   It fills blank fields and never overwrites a Salesforce value. Email Opt Out is a checkbox, so an opt-out sets it: that is the one exception. A write goes to every record that matches, and
   the seam has no way to create one. */

import type { Db } from "./db.ts";
import { newId } from "./events.ts";
import { askPeople, crmConnected } from "./crm-checks.ts";
import { CrmAlreadyExists, type CampaignType, type Crm, type CrmPatch, type CrmRecord } from "./providers.ts";
import { LAST_DAY_SQL } from "./motion.ts";
import { moneyOf, moneyOn, syncCrm } from "./crm-sync.ts";

export const MAX_ATTEMPTS = 5;
/** A child campaign whose conference is not in the CRM yet. The row waits; it is not a failure (docs/SHARED-WORLD.md 4). */
export class ParentNotInCrm extends Error { constructor(reason = "parent not in the CRM yet") { super(reason); } }

/** The campaign type by event kind, and the conference a hosted event hangs off. A webinar is a `webinar` campaign; everything else an `event`. */
export async function campaignShape(db: Pick<Db, "query">, eventId: string): Promise<{ type: CampaignType; conference: string | null }> {
  const [h] = await db.query<{ hosted_format: string; conference_event_id: string | null }>("SELECT hosted_format, conference_event_id FROM involvements WHERE event_id = $1 AND kind = 'hosted' AND status <> 'dropped'", [eventId]);
  return { type: h?.hosted_format === "webinar" ? "webinar" : "event", conference: h?.conference_event_id ?? null };
}

/** Queues an event's campaign, once. A hosted event under a conference also queues the conference's campaign first, so the child's row never waits for a row nobody queued. */
export async function queueCampaign(q: Db["query"], eventId: string, crm: Crm | null | undefined) {
  if (!canWrite(crm) || !crm.createCampaign) return;
  const [h] = await q<{ conference_event_id: string | null }>("SELECT conference_event_id FROM involvements WHERE event_id = $1 AND kind = 'hosted' AND status <> 'dropped'", [eventId]);
  for (const id of [h?.conference_event_id, eventId]) {
    if (!id) continue;
    const [ev] = await q<{ name: string; start: string; end: string }>(`SELECT e.name, e.starts_on::text AS start, ${LAST_DAY_SQL}::text AS end FROM events e WHERE e.id = $1`, [id]);
    if (ev) await queueCreate(q, "campaign", `campaign:${id}`, null, { event_id: id, name: ev.name, start: ev.start, end: ev.end, email: null, full_name: null, company: null, domain: null });
  }
}
export const canWrite = (crm: Crm | null | undefined): crm is Crm => crmConnected(crm) && typeof crm.write === "function";

export type OutboxKind = "email" | "opt_out" | "campaign" | "campaign_member" | "task" | "lead" | "activity" | "activity_update" | "campaign_money";
export interface OutboxPayload { email: string | null; full_name: string | null; company: string | null; domain: string | null; event_id?: string }

/** Each kept person with an address checked twice. Runs inside the delivery's own transaction. */
export async function queueDeliveredEmails(q: Db["query"], eventId: string, crm: Crm | null | undefined, payloadEventId: string = eventId) {
  if (!canWrite(crm)) return;
  // The event's Campaign comes first, once, so everything later has somewhere to attach.
  if (crm.createCampaign) await queueCampaign(q, payloadEventId, crm);
  const rows = await q<{ person_id: string | null; email: string; full_name: string | null; company: string; domain: string | null }>(
    `SELECT k.person_id, lower(k.email) AS email, k.full_name, co.name AS company, co.primary_domain AS domain FROM contacts k JOIN companies co ON co.id = k.company_id
     WHERE k.event_id = $1 AND k.dropped_at IS NULL AND k.priority IS NOT NULL AND k.email IS NOT NULL AND k.verify_1 = 'deliverable' AND k.verify_2 = 'deliverable' ORDER BY k.id`, [eventId]);
  for (const r of rows) await q("INSERT INTO crm_outbox (id, person_id, kind, payload) VALUES ($1, $2, 'email', $3::jsonb)", [newId("obx"), r.person_id, JSON.stringify({ email: r.email, full_name: r.full_name, company: r.company, domain: r.domain, event_id: payloadEventId })]);
}

/** Keyed by address or by name, as the opt-out was recorded. */
export async function queueOptOut(q: Db["query"], crm: Crm | null | undefined, p: { email: string | null; name: string | null; company: string | null }) {
  if (!canWrite(crm)) return;
  await q("INSERT INTO crm_outbox (id, kind, payload) VALUES ($1, 'opt_out', $2::jsonb)", [newId("obx"), JSON.stringify({ email: p.email, full_name: p.name, company: p.company, domain: null })]);
}

/** Everyone who went into a launched sequence, as Campaign Members, once. Net-new people have no record: they become Leads only if the uploader turned that on. */
export async function queueCampaignMembers(q: Db["query"], eventId: string, crm: Crm | null | undefined) {
  if (!canWrite(crm)) return;
  const [e] = await q<{ name: string; write_leads: boolean }>("SELECT name, write_leads FROM events WHERE id = $1", [eventId]);
  const rows = await q<{ contact_id: string; person_id: string | null; email: string; full_name: string | null; company: string; domain: string | null }>(
    `SELECT DISTINCT k.id AS contact_id, k.person_id, lower(k.email) AS email, k.full_name, co.name AS company, co.primary_domain AS domain FROM enrollments n JOIN contacts k ON k.id = n.contact_id JOIN companies co ON co.id = k.company_id
     WHERE n.event_id = $1 AND n.state = 'enrolled' AND k.email IS NOT NULL`, [eventId]);
  for (const r of rows) await queueCreate(q, "campaign_member", `cm:${eventId}:${r.contact_id}`, r.person_id, { email: r.email, full_name: r.full_name, company: r.company, domain: r.domain, event_id: eventId, campaign: e.name, write_leads: e.write_leads });
}

export const queueCreate = (q: Db["query"], kind: "campaign" | "campaign_member" | "task" | "lead" | "activity" | "activity_update" | "campaign_money", key: string, personId: string | null, payload: object) =>
  q("INSERT INTO crm_outbox (id, person_id, kind, payload, desk_key) VALUES ($1, $2, $3, $4::jsonb, $5) ON CONFLICT (desk_key) DO NOTHING", [newId("obx"), personId, kind, JSON.stringify(payload), key]);

const SUPERSEDED = "superseded";
/** A later row for the same member (same event and address), queued or done. */
async function newerExists(db: Pick<Db, "query">, key: string, ref: string) {
  const [r] = await db.query("SELECT 1 FROM crm_outbox WHERE kind = 'campaign_member' AND payload->>'member_ref' = $1 AND desk_key <> $2 AND status IN ('queued', 'done') AND created_at > (SELECT created_at FROM crm_outbox WHERE desk_key = $2)", [ref, key]);
  return Boolean(r);
}

/** The writes that create something. Each is safe to repeat: see docs/LIFECYCLE.md, section 9. Returns the record id, or null when there was nobody to write to. */
async function carryOutCreate(db: Db, crm: Crm, kind: "campaign" | "campaign_member" | "task" | "lead", key: string, p: OutboxPayload & { status?: string; campaign?: string; subject?: string; body?: string; due?: string; write_leads?: boolean; name?: string; start?: string; end?: string }): Promise<string | null> {
  if (kind === "campaign") {
    if (!crm.createCampaign) return null;
    const found = await crm.findCampaignByKey?.(key);
    if (found) { await db.query("UPDATE events SET crm_campaign_id = $2 WHERE id = $1", [p.event_id, found.id]); return found.id; }
    const shape = await campaignShape(db, p.event_id!);
    let parent: string | undefined;
    if (shape.conference) {
      // A hosted side event hangs off its conference's campaign. If that is not in the CRM yet this row waits, and says so, without using an attempt.
      parent = (await db.query<{ crm_campaign_id: string | null }>("SELECT crm_campaign_id FROM events WHERE id = $1", [shape.conference]))[0]?.crm_campaign_id ?? undefined;
      if (!parent) throw new ParentNotInCrm();
    }
    const id = (await crm.createCampaign({ name: p.name!, start: p.start!, end: p.end!, type: shape.type, key, parent })).id;
    await db.query("UPDATE events SET crm_campaign_id = $2 WHERE id = $1", [p.event_id, id]);
    return id;
  }
  const records = (await askPeople(crm, [{ ref: key, email: p.email, full_name: p.full_name, company: p.company, domain: p.domain }]))[key];
  if (kind === "lead") {
    if (records.length || !p.email) return records[0]?.id ?? null;
    return crm.createLead ? (await crm.createLead({ email: p.email, full_name: p.full_name, company: p.company ?? "", domain: p.domain, key })).id : null;
  }
  if (!records.length) {
    if (kind === "campaign_member" && p.write_leads && p.email && crm.createLead) await crm.createLead({ email: p.email, full_name: p.full_name, company: p.company ?? "", domain: p.domain, key: `lead:${key}` });
    return null;
  }
  if (kind === "campaign_member") {
    if (!crm.createCampaignMember) return null;
    const [ev] = await db.query<{ crm_campaign_id: string | null }>("SELECT crm_campaign_id FROM events WHERE id = $1", [p.event_id]);
    // The event's campaign row is queued or waiting on its parent: this row waits too, without using an attempt.
    if (crm.createCampaign && !ev?.crm_campaign_id) throw new ParentNotInCrm("campaign not in the CRM yet");
    // A newer status for the same member in this sweep's order supersedes this one, so a retry of an old status never moves the CRM backward.
    if ((p as unknown as { member_ref?: string }).member_ref && await newerExists(db, key, (p as unknown as { member_ref: string }).member_ref)) return SUPERSEDED;
    const campaign = ev?.crm_campaign_id ?? p.campaign!;
    try { return (await crm.createCampaignMember({ campaign, record: records[0], key, status: p.status })).id; }
    catch (e) {
      if (!(e instanceof CrmAlreadyExists)) throw e;
      // Already a member: only the status moves.
      if (p.status) await crm.updateCampaignMemberStatus?.({ campaign, record: records[0], status: p.status });
      return records[0].id;
    }
  }
  const found = await crm.findTaskByKey?.(key);
  if (found) return found.id;
  return crm.createTask ? (await crm.createTask({ record: records[0], subject: p.subject ?? "Follow up", body: p.body ?? "", due: p.due ?? new Date().toISOString().slice(0, 10), key })).id : null;
}

/** What one record should get. Null when it has nothing blank to fill. */
export function patchFor(kind: "email" | "opt_out", record: CrmRecord, p: OutboxPayload): CrmPatch | null {
  if (kind === "opt_out") return record.email_opt_out ? null : { email_opt_out: true };
  return record.email || !p.email ? null : { email: p.email };
}

/** Sends what is queued. A row that fails is tried again by a later sweep, up to MAX_ATTEMPTS, and then stays as `failed`. Each write only fills blanks, so repeating one is harmless. */
let draining: Promise<unknown> | null = null;
/** One pass at a time in this process: the boot timer and the lifecycle step both call it, and two at once would race the supersede check. */
export async function drainOutbox(db: Db, crm: Crm | null | undefined, limit = 500): Promise<{ sent: number; failed: number; none: number }> {
  while (draining) await draining.catch(() => {});
  const run = drainOnce(db, crm, limit);
  draining = run;
  try { return await run; } finally { if (draining === run) draining = null; }
}
async function drainOnce(db: Db, crm: Crm | null | undefined, limit: number) {
  const out = { sent: 0, failed: 0, none: 0 };
  if (!canWrite(crm)) return out;
  await syncCrm(db, crm).catch((e) => console.error("crm sync", e));
  const rows = await db.query<{ id: string; kind: OutboxKind; payload: OutboxPayload; attempts: number; desk_key: string | null }>("SELECT id, kind, payload, attempts, desk_key FROM crm_outbox WHERE status = 'queued' ORDER BY (coalesce(last_error, '') LIKE '%not in the CRM yet' OR last_error = 'campaign money is off'), created_at, id LIMIT $1", [limit]);
  for (const r of rows) {
    try {
      const p = r.payload;
      // An erasure that committed after this row was queued: it is not sent.
      if (p.email && r.kind !== "opt_out" && (await db.query("SELECT 1 FROM suppressions WHERE kind = 'opt_out' AND reason = 'Erasure request' AND lower(email) = lower($1) LIMIT 1", [p.email])).length) {
        await db.query("UPDATE crm_outbox SET status = 'cancelled', last_error = 'erased' WHERE id = $1", [r.id]); continue;
      }
      if (r.kind === "activity" || r.kind === "activity_update" || r.kind === "campaign_money") {
        const id = await carryOutActivity(db, crm, r.kind, r.desk_key ?? r.id, p as ActivityPayload);
        if (id === SUPERSEDED) { await db.query("UPDATE crm_outbox SET status = 'cancelled', last_error = 'cancelled: nothing to write' WHERE id = $1", [r.id]); continue; }
        if (!id) out.none++;
        await db.query("UPDATE crm_outbox SET status = 'done', attempts = attempts + 1, last_error = NULL, done_at = now(), result_id = $2 WHERE id = $1", [r.id, id]);
        out.sent++;
        continue;
      }
      if (r.kind === "campaign" || r.kind === "campaign_member" || r.kind === "task" || r.kind === "lead") {
        const id = await carryOutCreate(db, crm, r.kind, r.desk_key ?? r.id, p);
        if (id === SUPERSEDED) { await db.query("UPDATE crm_outbox SET status = 'cancelled', last_error = 'superseded by a newer status' WHERE id = $1", [r.id]); continue; }
        if (!id) out.none++;
        await db.query("UPDATE crm_outbox SET status = 'done', attempts = attempts + 1, last_error = NULL, done_at = now(), result_id = $2 WHERE id = $1", [r.id, id]);
        out.sent++;
        continue;
      }
      // By address and by name at the account: a record with a blank email can only be found by name.
      const records = (await askPeople(crm, [{ ref: r.id, email: p.email, full_name: p.full_name, company: p.company, domain: p.domain }]))[r.id];
      for (const record of records) {
        const patch = patchFor(r.kind as "email" | "opt_out", record, p);
        if (patch) await crm.write!(record, patch);
      }
      if (!records.length) out.none++;
      await db.query("UPDATE crm_outbox SET status = 'done', attempts = attempts + 1, last_error = NULL, done_at = now() WHERE id = $1", [r.id]);
      out.sent++;
    } catch (e) {
      if (e instanceof ParentNotInCrm) { await db.query("UPDATE crm_outbox SET last_error = $2 WHERE id = $1", [r.id, e.message]); continue; }
      const tries = r.attempts + 1;
      await db.query("UPDATE crm_outbox SET attempts = $2, status = $3, last_error = $4 WHERE id = $1", [r.id, tries, tries >= MAX_ATTEMPTS ? "failed" : "queued", String((e as Error)?.message ?? e).slice(0, 300)]);
      out.failed++;
    }
  }
  return out;
}

/** A sweep that cannot fail: called from the timer in node.ts. */
export const drainQuietly = (db: Db, crm: Crm | null | undefined) => drainOutbox(db, crm).catch((e) => { console.error("crm outbox", e); return null; });

interface ActivityPayload extends OutboxPayload { type?: string; direction?: "in" | "out" | null; subject?: string; body?: string; at?: string; timezone?: string; meeting_status?: string; create_key?: string }

/** Activities, their status updates and campaign money. A row that cannot go yet waits (ParentNotInCrm: no attempt counted). */
async function carryOutActivity(db: Db, crm: Crm, kind: "activity" | "activity_update" | "campaign_money", key: string, p: ActivityPayload): Promise<string | null> {
  if (kind === "campaign_money") {
    // The gate is checked here too: a row queued while the flag was on stays queued when it is turned off.
    if (!moneyOn() || !crm.updateCampaignMoney) throw new ParentNotInCrm("campaign money is off");
    const [ev] = await db.query<{ crm_campaign_id: string | null }>("SELECT crm_campaign_id FROM events WHERE id = $1", [p.event_id]);
    if (!ev?.crm_campaign_id) throw new ParentNotInCrm("campaign not in the CRM yet");
    await crm.updateCampaignMoney({ campaign: ev.crm_campaign_id, ...(await moneyOf(db.query, p.event_id!)) });
    return ev.crm_campaign_id;
  }
  const records = (await askPeople(crm, [{ ref: key, email: p.email, full_name: p.full_name, company: p.company, domain: p.domain }]))[key];
  if (!records.length) return null;
  if (kind === "activity") {
    if (!crm.createActivity) return null;
    const meeting = p.type === "meeting" ? { status: p.meeting_status!, at: p.at!, timezone: p.timezone ?? "UTC" } : undefined;
    return (await crm.createActivity({ record: records[0], type: p.type!, direction: p.direction ?? null, subject: p.subject ?? "", body: p.body, at: p.at!, key, meeting })).id;
  }
  const [made] = await db.query<{ status: string; result_id: string | null }>("SELECT status, result_id FROM crm_outbox WHERE desk_key = $1", [p.create_key]);
  if (!made || made.status === "queued") throw new ParentNotInCrm("meeting not in the CRM yet");
  if (made.status !== "done" || !made.result_id) return null;
  await crm.updateActivity?.({ id: made.result_id, meeting_status: p.meeting_status! });
  return made.result_id;
}
