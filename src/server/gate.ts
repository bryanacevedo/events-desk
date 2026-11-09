/* The gate (docs/LIFECYCLE.md, section 5). It runs at every moment someone could be contacted: at adding, at launch and at every resume. In doubt about whether someone may be contacted, it says no. */

import type { Db } from "./db.ts";
import { isOptedOut, isWrongPerson } from "./caches.ts";
import { CrmDown, crmConnected, preSendCheck } from "./crm-checks.ts";
import { newId } from "./events.ts";
import { DESK, nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { activeHolds } from "./touches.ts";
import { linkContact } from "./person-record.ts";
import { nameKey } from "../shared/email.ts";
import type { Channel } from "../shared/motion.ts";

export type Moment = "add" | "launch" | "resume";
export interface GateResult { contact_id: string; passed: boolean; reason: string | null; retry_after: Date | null }

export interface GatePerson {
  id: string; event_id: string; person_id: string | null; full_name: string | null; name_hidden: boolean; email: string | null; linkedin: string | null; drop_reason: string | null;
  verify_1: string | null; verify_2: string | null; crm_bounced: Record<string, string>; company: string; company_key: string; domain: string | null; firmo: { country?: string | null } | null; person_location: string | null;
  verified_at: string | null; verify_once: boolean; decision: string | null; decided_at: string | null; decided_via: string | null;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const VERIFY_WINDOW_DAYS = 30;
const RECENT_ACTIVITY_DAYS = 14;

/** The person's region, for the legal basis: where they are, then the company's country, else its own "unknown". */
export function regionOf(p: Pick<GatePerson, "firmo" | "person_location">) {
  const c = p.person_location?.split(",").at(-1)?.trim() || p.firmo?.country?.trim();
  return c ? c.toLowerCase() : "unknown";
}

export async function loadPeople(db: Db, eventId: string, ids: string[]) {
  return db.query<GatePerson>(
    `SELECT k.id, k.event_id, k.person_id, k.full_name, k.name_hidden, k.email, k.linkedin, k.drop_reason, k.verify_1, k.verify_2, k.crm_bounced, co.name AS company, co.key AS company_key, co.primary_domain AS domain, co.firmo, k.person_location,
            (SELECT max(v.checked_at)::text FROM verification_cache v WHERE v.email = lower(k.email)) AS verified_at, e.verify_once,
            d.status AS decision, d.decided_at::text AS decided_at, d.via AS decided_via
     FROM contacts k JOIN companies co ON co.id = k.company_id JOIN events e ON e.id = k.event_id
     LEFT JOIN owner_decisions d ON d.event_id = k.event_id AND d.company_id = k.company_id
     WHERE k.event_id = $1 AND k.id = ANY($2::text[])`, [eventId, ids]);
}

/** Checks in code that need nothing from the CRM, in the spec's order, and returns the first reason to refuse. */
async function localChecks(db: Db, p: GatePerson, channel: Channel, now: Date, bases: Set<string>): Promise<Omit<GateResult, "contact_id" | "passed"> | null> {
  const no = (reason: string, retry_after: Date | null = null) => ({ reason, retry_after });
  // 1. Not dropped, not suppressed.
  if (p.drop_reason) return no(`dropped:${p.drop_reason}`);
  const nk = p.full_name && !p.name_hidden ? nameKey(p.full_name) : null;
  if (await isOptedOut(db, { email: p.email, name_key: nk, company_key: p.company_key })) return no("opted_out");
  if (p.email && await isWrongPerson(db, p.email, nk)) return no("wrong_person");
  // 2. The owner has said, or the silence ran out. A pending or unanswered decision fails.
  if (p.decision === "pending" || p.decision === "handed") return no("owner_pending", new Date(now.getTime() + HOUR));
  if (p.decision === "mine") return no("owner_mine");
  // 3. Reachable on this channel, by an address that has stood up.
  if (channel === "email") {
    if (!p.email) return no("no_email");
    const twice = p.verify_1 === "deliverable" && p.verify_2 === "deliverable";
    if (!twice && !(p.verify_once && (p.verify_1 === "deliverable" || p.verify_2 === "deliverable"))) return no("not_verified_enough");
    if (!p.verified_at || now.getTime() - Date.parse(p.verified_at) > VERIFY_WINDOW_DAYS * DAY) return no("verification_stale");
    const bounced = p.crm_bounced?.[p.email.toLowerCase()];
    if (bounced && Date.parse(bounced) >= Date.parse(p.verified_at)) return no("crm_bounced");
  } else if (!p.linkedin) return no("no_linkedin");
  // 8, asked here because it is free. Templates need a name.
  if (!p.full_name || p.name_hidden) return no("name_unknown");
  if (!p.domain) return no("no_domain");
  // 7. A person recorded a basis for this region.
  if (!bases.has(regionOf(p))) return no("no_legal_basis");
  // 5. Not in another cadence, at any event. The other channel of the same event is the same cadence.
  const other = await db.query<{ id: string }>(
    `SELECT n.id FROM enrollments n JOIN contacts k ON k.id = n.contact_id WHERE n.state <> 'removed' AND n.event_id <> $1
       AND (n.contact_id = $2 OR ($3::text IS NOT NULL AND n.person_id = $3) OR ($4::text IS NOT NULL AND lower(k.email) = lower($4))) LIMIT 1`, [p.event_id, p.id, p.person_id, p.email]);
  if (other.length) return no("in_another_cadence", new Date(now.getTime() + DAY));
  // 6. No hold applies.
  const holds = await activeHolds(db.query, { domain: p.domain, person_id: p.person_id, event_id: p.event_id, now });
  if (holds.length) return no(`hold:${holds[0].cause}`, new Date(holds[0].expires_at));
  return null;
}

/** The CRM's own last activity on an account, against what the desk itself did there. A CRM that cannot answer fails the gate. */
async function recentActivity(db: Db, deps: LifecycleDeps, p: GatePerson, now: Date, cache: Map<string, string | null>) {
  const crm = deps.crm!;
  const d = p.domain!;
  if (!cache.has(d)) {
    try { const a = crm.lookupByDomain ? await crm.lookupByDomain(d, p.company, now.toISOString().slice(0, 10)) : await crm.lookup(p.company, now.toISOString().slice(0, 10)); cache.set(d, a.last_activity); }
    catch { throw new CrmDown(crm.name); }
  }
  const last = cache.get(d);
  if (!last || now.getTime() - Date.parse(last) > RECENT_ACTIVITY_DAYS * DAY) return null;
  // An owner who said include after that date has already seen it. A default does not count: silence is not knowledge.
  if (p.decision === "include" && p.decided_via === "owner" && p.decided_at && Date.parse(p.decided_at) >= Date.parse(last)) return null;
  const [mine] = await db.query<{ at: string }>("SELECT max(at)::text AS at FROM touches WHERE domain = $1 AND kind = 'send'", [d]);
  if (mine?.at && mine.at.slice(0, 10) >= last.slice(0, 10)) return null;
  return new Date(Date.parse(last) + RECENT_ACTIVITY_DAYS * DAY);
}

/** Runs the gate for these people on one channel and writes one row per person. Throws CrmDown when a connected CRM cannot answer, and nobody passes. */
export async function runGate(db: Db, deps: LifecycleDeps, eventId: string, contactIds: string[], channel: Channel, moment: Moment): Promise<GateResult[]> {
  const now = nowOf(deps);
  // The one switch. Nothing is added, launched or resumed while it is on.
  if ((await db.query("SELECT 1 FROM desk_controls WHERE sending_stopped_at IS NOT NULL")).length) return contactIds.map((id) => ({ contact_id: id, passed: false, reason: "desk_stopped", retry_after: new Date(now.getTime() + HOUR) }));
  const people = await loadPeople(db, eventId, contactIds);
  const bases = new Set((await db.query<{ region: string }>("SELECT region FROM legal_bases WHERE event_id = $1", [eventId])).map((r) => r.region));
  const out = new Map<string, GateResult>();
  const open: GatePerson[] = [];
  for (const p of people) {
    const r = await localChecks(db, p, channel, now, bases);
    if (r) out.set(p.id, { contact_id: p.id, passed: false, ...r });
    else open.push(p);
  }
  // 4, and the CRM's half of 6.
  if (open.length) {
    const checked = await preSendCheck(db, open.map((p) => p.id), deps.crm);
    for (const b of checked.blocked) out.set(b.id, { contact_id: b.id, passed: false, reason: b.reason, retry_after: null });
    if (crmConnected(deps.crm)) {
      const crm = deps.crm;
      const accounts = [...new Map(open.filter((p) => !out.has(p.id)).map((p) => [p.domain!, { ref: p.domain!, domain: p.domain, name: p.company }])).values()];
      if (crm.accountFlags && accounts.length) {
        let flags: Record<string, { do_not_prospect: boolean }>;
        try { flags = await crm.accountFlags(accounts); } catch { throw new CrmDown(crm.name); }
        for (const p of open) if (!out.has(p.id) && flags[p.domain!]?.do_not_prospect) out.set(p.id, { contact_id: p.id, passed: false, reason: "account_do_not_prospect", retry_after: null });
      }
      const cache = new Map<string, string | null>();
      for (const p of open) {
        if (out.has(p.id)) continue;
        const until = await recentActivity(db, deps, p, now, cache);
        if (until) out.set(p.id, { contact_id: p.id, passed: false, reason: "crm_recent_activity", retry_after: until });
      }
    }
    for (const p of open) {
      if (out.has(p.id)) continue;
      // Everyone sequenced has a person record, so a reply at any event finds every enrollment.
      if (!p.person_id) await db.tx((q) => linkContact(q, p.id, {}));
      out.set(p.id, { contact_id: p.id, passed: true, reason: null, retry_after: null });
    }
  }
  for (const id of contactIds) if (!out.has(id)) out.set(id, { contact_id: id, passed: false, reason: "not_found", retry_after: null });
  const results = contactIds.map((id) => out.get(id)!);
  await db.tx(async (q) => {
    for (const r of results) if (people.some((p) => p.id === r.contact_id))
      await q("INSERT INTO gate_log (id, event_id, contact_id, channel, moment, passed, reason, retry_after, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [newId("gat"), eventId, r.contact_id, channel, moment, r.passed, r.reason, r.retry_after?.toISOString() ?? null, now.toISOString()]);
  });
  void DESK;
  return results;
}
