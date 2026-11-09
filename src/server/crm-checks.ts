/* Salesforce do not contact checks (docs/DATA-HYGIENE.md, sections 3 and 6a). Salesforce is not connected: these run against whatever sits behind the `Crm` seam, which today is only the
   simulated one. A CRM that does not say `connected` runs no check at all, which is what live mode's `noCrm` says.

   A connected CRM that cannot answer stops the work. `CrmDown` is a repeatable pause: every caller is either a job handler, where the loop's catch puts the job back, or `crmGate` in
   pipeline.ts. Nothing here is written until the whole answer is in, so a check that fails has changed nothing and can simply be asked again.

     Email Opt Out          dropped, crm_unsubscribed
     Custom Do Not Contact  dropped, crm_do_not_contact
     Do Not Call            stays, contacts.no_calls
     Email bounced          the stored check on that address is ignored when it is no newer than the bounce
     Do not prospect        the company is excluded, excluded_company

   There is no override: these drops open no case and never reach Review. */

import type { Db } from "./db.ts";
import { logActivity } from "./events.ts";
import { PauseSignal } from "./paid.ts";
import { isOptedOut } from "./caches.ts";
import type { Crm, CrmAccountQuery, CrmPersonQuery, CrmRecord } from "./providers.ts";
import { dropAtCompany } from "./work.ts";
import { nameKey } from "../shared/email.ts";

const BATCH = 200;
const SYSTEM = "Events Desk";

/** The CRM could not answer. Unlike owner and deal lookups, this fails closed. */
export class CrmDown extends PauseSignal {
  constructor(name: string) { super(name, true); }
}
export const CRM_DOWN_WORDS = "The CRM did not answer";

export const crmConnected = (crm: Crm | null | undefined): crm is Crm => crm?.connected === true;

/** A person is flagged if any record that matched is flagged. */
export function flagsOf(records: CrmRecord[]) {
  const bounces: Record<string, string> = {};
  for (const r of records) {
    if (!r.bounced_at || !r.email) continue;
    const e = r.email.toLowerCase();
    if (!bounces[e] || Date.parse(r.bounced_at) > Date.parse(bounces[e])) bounces[e] = r.bounced_at;
  }
  return { unsubscribed: records.some((r) => r.email_opt_out), do_not_contact: records.some((r) => r.do_not_contact), no_calls: records.some((r) => r.do_not_call), bounces };
}
export type CrmFlags = ReturnType<typeof flagsOf>;
export const crmDropReason = (f: CrmFlags) => (f.do_not_contact ? "crm_do_not_contact" : f.unsubscribed ? "crm_unsubscribed" : null);

/** Every matching record for each person, by `ref`. A ref missing from the answer is an answer not given. */
export async function askPeople(crm: Crm, people: CrmPersonQuery[]): Promise<Record<string, CrmRecord[]>> {
  const out: Record<string, CrmRecord[]> = {};
  for (let i = 0; i < people.length; i += BATCH) {
    const batch = people.slice(i, i + BATCH);
    let got: Record<string, CrmRecord[]> | undefined;
    try { got = await crm.personFlags?.(batch); } catch { throw new CrmDown(crm.name); }
    for (const p of batch) {
      const rows = got?.[p.ref];
      if (!Array.isArray(rows)) throw new CrmDown(crm.name);
      out[p.ref] = rows;
    }
  }
  return out;
}

async function askAccounts(crm: Crm, accounts: CrmAccountQuery[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (let i = 0; i < accounts.length; i += BATCH) {
    const batch = accounts.slice(i, i + BATCH);
    let got: Record<string, { do_not_prospect: boolean }> | undefined;
    try { got = await crm.accountFlags?.(batch); } catch { throw new CrmDown(crm.name); }
    for (const a of batch) {
      if (typeof got?.[a.ref]?.do_not_prospect !== "boolean") throw new CrmDown(crm.name);
      out[a.ref] = got[a.ref].do_not_prospect;
    }
  }
  return out;
}

/** One contact's answer on the row: no_calls and bounces always, a drop when a flag says so. Never touches someone already dropped, whose reason stands. */
async function applyFlags(q: Db["query"], contactId: string, f: CrmFlags) {
  const reason = crmDropReason(f);
  if (!reason && !f.no_calls && !Object.keys(f.bounces).length) return reason;
  await q(
    `UPDATE contacts SET no_calls = no_calls OR $2, crm_bounced = crm_bounced || $3::jsonb,
       drop_reason = CASE WHEN dropped_at IS NULL THEN coalesce($4, drop_reason) ELSE drop_reason END,
       dropped_at = CASE WHEN dropped_at IS NULL AND $4::text IS NOT NULL THEN now() ELSE dropped_at END
     WHERE id = $1`, [contactId, f.no_calls, JSON.stringify(f.bounces), reason]);
  return reason;
}

interface LiveContact { id: string; email: string | null; full_name: string | null; name_hidden: boolean; company: string | null; domain: string | null }
const toQuery = (k: LiveContact): CrmPersonQuery => ({ ref: k.id, email: k.email?.toLowerCase() ?? null, full_name: k.name_hidden ? null : k.full_name, company: k.company, domain: k.domain });
/** Nothing to match on: no address, and no name at a known account. */
const askable = (p: CrmPersonQuery) => Boolean(p.email || (p.full_name && (p.company || p.domain)));

/** Every person still on the list, by address and by name at the account. */
export async function checkPeople(db: Db, crm: Crm, eventId: string) {
  const live = await db.query<LiveContact>(
    `SELECT k.id, k.email, k.full_name, k.name_hidden, co.name AS company, co.primary_domain AS domain
     FROM contacts k LEFT JOIN companies co ON co.id = k.company_id WHERE k.event_id = $1 AND k.dropped_at IS NULL ORDER BY k.id`, [eventId]);
  const asks = live.map(toQuery).filter(askable);
  const answers = await askPeople(crm, asks);
  const n = { crm_unsubscribed: 0, crm_do_not_contact: 0, no_calls: 0 };
  await db.tx(async (q) => {
    for (const p of asks) {
      const f = flagsOf(answers[p.ref]);
      const reason = await applyFlags(q, p.ref, f);
      if (reason) n[reason]++;
      else if (f.no_calls) n.no_calls++;
    }
    if (n.crm_unsubscribed || n.crm_do_not_contact || n.no_calls) await logActivity(q, eventId, SYSTEM, "crm", `CRM check: ${n.crm_unsubscribed} unsubscribed, ${n.crm_do_not_contact} do not contact, ${n.no_calls} no calls`);
  });
  return n;
}

const ACCOUNT_SCOPES = {
  /** At the domain gates: confirmed domains not asked about yet. */
  resolved: "in_research AND identity_state = 'resolved' AND primary_domain IS NOT NULL AND crm_checked_at IS NULL",
  /** The single-card flow has no domains, so the account is matched by name. */
  named: "true",
  /** Before delivery: every company somebody is still on the list at. */
  live: "EXISTS (SELECT 1 FROM contacts k WHERE k.company_id = companies.id AND k.dropped_at IS NULL)",
} as const;

export async function checkAccounts(db: Db, crm: Crm, eventId: string, scope: keyof typeof ACCOUNT_SCOPES) {
  const cos = await db.query<{ id: string; name: string; domain: string | null }>(
    `SELECT id, name, primary_domain AS domain FROM companies WHERE event_id = $1 AND list_status IS NULL AND ${ACCOUNT_SCOPES[scope]} ORDER BY id`, [eventId]);
  if (!cos.length) return 0;
  const answers = await askAccounts(crm, cos.map((c) => ({ ref: c.id, domain: c.domain, name: c.name })));
  let excluded = 0;
  await db.tx(async (q) => {
    for (const c of cos) {
      await q("UPDATE companies SET crm_checked_at = now() WHERE id = $1", [c.id]);
      if (!answers[c.id]) continue;
      await q("UPDATE companies SET list_status = 'excluded', in_research = false WHERE id = $1", [c.id]);
      await dropAtCompany(q, eventId, c.id, "excluded_company");
      excluded++;
    }
    if (excluded) await logActivity(q, eventId, SYSTEM, "crm", `CRM check: ${excluded} ${excluded === 1 ? "company" : "companies"} marked do not prospect`);
  });
  return excluded;
}

/** One person, on one address that has just been learned (or none, by name alone). The answer is written before this returns. */
export async function checkAddress(db: Db, crm: Crm, k: { id: string; full_name: string | null; company: string | null; domain: string | null }, email: string | null) {
  const p: CrmPersonQuery = { ref: k.id, email: email?.toLowerCase() ?? null, full_name: k.full_name, company: k.company, domain: k.domain };
  if (!askable(p)) return { reason: null, bounces: {} as Record<string, string> };
  const answers = await askPeople(crm, [p]);
  const f = flagsOf(answers[k.id]);
  return { reason: await db.tx((q) => applyFlags(q, k.id, f)), bounces: f.bounces };
}

/** For the future Apollo sequence step, and wired to nothing today. Reads and answers: it changes no row. Fails closed like the rest, with `CrmDown`. */
export async function preSendCheck(db: Db, contactIds: string[], crm?: Crm | null) {
  const rows = await db.query<LiveContact & { drop_reason: string | null; company_key: string | null }>(
    `SELECT k.id, k.email, k.full_name, k.name_hidden, k.drop_reason, co.name AS company, co.key AS company_key, co.primary_domain AS domain
     FROM contacts k LEFT JOIN companies co ON co.id = k.company_id WHERE k.id = ANY($1::text[]) ORDER BY k.id`, [contactIds]);
  const blocked: { id: string; reason: string }[] = [];
  const open: LiveContact[] = [];
  for (const k of rows) {
    if (k.drop_reason) { blocked.push({ id: k.id, reason: k.drop_reason }); continue; }
    if (await isOptedOut(db, { email: k.email, name_key: k.full_name && !k.name_hidden ? nameKey(k.full_name) : null, company_key: k.company_key })) { blocked.push({ id: k.id, reason: "opted_out" }); continue; }
    open.push(k);
  }
  const known = new Set(rows.map((r) => r.id));
  for (const id of contactIds) if (!known.has(id)) blocked.push({ id, reason: "not_found" });
  if (!crmConnected(crm)) return { send: open.map((k) => k.id), blocked };
  const asks = open.map(toQuery).filter(askable);
  const answers = await askPeople(crm, asks);
  const send: string[] = [];
  for (const k of open) {
    const reason = answers[k.id] ? crmDropReason(flagsOf(answers[k.id])) : null;
    if (reason) blocked.push({ id: k.id, reason }); else send.push(k.id);
  }
  return { send, blocked };
}
