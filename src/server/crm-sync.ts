/* What the CRM should hold about an event's people, derived from state and queued once per change (docs/SHARED-WORLD.md section 12).
   A sweep, not a call at each change: a guest's status moves in a dozen places, and a sweep from state cannot miss one. `crm_sync` remembers the last value queued for each thing,
   so running it twice queues once, and a status that goes back to an earlier value is a new row (the key carries a sequence). */

import type { Db } from "./db.ts";
import { canWrite, queueCampaign, queueCreate } from "./crm-outbox.ts";
import type { Crm } from "./providers.ts";
import { plannedTotal } from "./budget-lines.ts";

/** Funnel order for one member: the highest of everything known about them wins. */
const RANK: Record<string, number> = { sent: 1, responded: 2, registered: 3, no_show: 4, attended: 5, met: 6 };
const GUEST_STATUS: Record<string, string | null> = { invited: "sent", registered: "registered", attended: "attended", no_show: "no_show", listed: null, waitlist: null, declined: null };
const WINDOW_DAYS = 180;
const MEETING_STATUS: Record<string, string> = { booked: "booked", rescheduled: "booked", held: "held", no_show: "no_show", cancelled: "cancelled" };

export const moneyOn = (env: Record<string, string | undefined> = process.env) => (env.CRM_CAMPAIGN_MONEY ?? "").toLowerCase() === "usd";

export interface SyncResult { campaigns: number; members: number; awaiting_contract: number; meetings: number; meeting_updates: number; sends: number; replies: number; debriefs: number; debrief_unplaced: number; money: number }
const zero = (): SyncResult => ({ campaigns: 0, members: 0, awaiting_contract: 0, meetings: 0, meeting_updates: 0, sends: 0, replies: 0, debriefs: 0, debrief_unplaced: 0, money: 0 });

async function synced(q: Db["query"], kind: string, ref: string) { return (await q<{ last: string; n: number }>("SELECT last, n FROM crm_sync WHERE kind = $1 AND ref = $2", [kind, ref]))[0]; }
const remember = (q: Db["query"], kind: string, ref: string, last: string) =>
  q("INSERT INTO crm_sync (kind, ref, last) VALUES ($1, $2, $3) ON CONFLICT (kind, ref) DO UPDATE SET last = EXCLUDED.last, n = crm_sync.n + 1, queued_at = now()", [kind, ref, last]);
const IN_WINDOW = `e.starts_on >= current_date - ${WINDOW_DAYS}`;

/** An address on the suppression list because of an erasure request is never written about again. */
const erasedEmails = async (q: Db["query"]) => new Set((await q<{ email: string }>("SELECT lower(email) AS email FROM suppressions WHERE kind = 'opt_out' AND reason = 'Erasure request' AND email IS NOT NULL")).map((r) => r.email));

export async function syncCrm(db: Db, crm: Crm | null | undefined, env: Record<string, string | undefined> = process.env): Promise<SyncResult> {
  const out = zero();
  if (!canWrite(crm)) return out;
  await db.tx(async (q) => {
    const erased = await erasedEmails(q);

    // 1. Members: one per event and address, the highest status known.
    type M = { event_id: string; email: string; full_name: string | null; company: string | null; domain: string | null; person_id: string | null; status: string };
    const members = new Map<string, M>();
    const put = (m: M) => { const k = `${m.event_id}:${m.email}`; const cur = members.get(k); if (!cur || RANK[m.status] > RANK[cur.status]) members.set(k, { ...m, person_id: cur?.person_id ?? m.person_id }); };
    const guests = await q<{ event_id: string; email: string; name: string; company: string | null; status: string }>(
      `SELECT g.event_id, lower(g.email) AS email, g.name, g.company, g.status FROM event_guests g JOIN events e ON e.id = g.event_id WHERE g.removed_at IS NULL AND g.email IS NOT NULL AND ${IN_WINDOW}`);
    const previous = new Set<string>();
    for (const g of guests) {
      if (erased.has(g.email)) continue;
      const s = GUEST_STATUS[g.status] ?? null;
      if (s) put({ event_id: g.event_id, email: g.email, full_name: g.name, company: g.company, domain: null, person_id: null, status: s });
      else previous.add(`${g.event_id}:${g.email}`);
    }
    const contacts = await q<{ event_id: string; email: string; full_name: string | null; company: string; domain: string | null; person_id: string | null; enrolled: boolean; replied: boolean; held: boolean }>(
      `SELECT k.event_id, lower(k.email) AS email, k.full_name, co.name AS company, co.primary_domain AS domain, k.person_id,
         EXISTS (SELECT 1 FROM enrollments n WHERE n.contact_id = k.id AND n.state <> 'adding') AS enrolled,
         EXISTS (SELECT 1 FROM inbound_messages m WHERE m.contact_id = k.id AND m.signal = 'reply') AS replied,
         EXISTS (SELECT 1 FROM meetings m WHERE m.contact_id = k.id AND m.status = 'held') AS held
       FROM contacts k LEFT JOIN companies co ON co.id = k.company_id JOIN events e ON e.id = k.event_id WHERE k.dropped_at IS NULL AND k.email IS NOT NULL AND ${IN_WINDOW}`);
    for (const c of contacts) {
      if (erased.has(c.email)) continue;
      const s = c.held ? "met" : c.replied ? "responded" : c.enrolled ? "sent" : null;
      if (s) put({ event_id: c.event_id, email: c.email, full_name: c.full_name, company: c.company, domain: c.domain, person_id: c.person_id, status: s });
    }

    // 2. Every event that has someone to write, or a plan asked for, has its campaign queued (the key makes a repeat a no-op).
    const eventIds = new Set<string>([...members.values()].map((m) => m.event_id));
    for (const r of await q<{ id: string }>("SELECT e.id FROM events e WHERE e.plan_submitted_at IS NOT NULL AND " + IN_WINDOW)) eventIds.add(r.id);
    for (const id of eventIds) {
      const [has] = await q("SELECT 1 FROM crm_outbox WHERE desk_key = $1", [`campaign:${id}`]);
      if (!has) { await queueCampaign(q, id, crm); out.campaigns++; }
    }

    const names = new Map((await q<{ id: string; name: string; write_leads: boolean }>("SELECT id, name, write_leads FROM events")).map((e) => [e.id, e]));
    for (const m of members.values()) {
      const ref = `${m.event_id}:${m.email}`, was = await synced(q, "member", ref), ev = names.get(m.event_id)!;
      if (was?.last === m.status) continue;
      const n = (was?.n ?? 0) + 1;
      await queueCreate(q, "campaign_member", `cm:${m.event_id}:${m.email}:${m.status}:${n}`, m.person_id, { email: m.email, full_name: m.full_name, company: m.company, domain: m.domain, event_id: m.event_id, campaign: ev.name, write_leads: ev.write_leads, status: m.status, member_ref: ref });
      await remember(q, "member", ref, m.status);
      out.members++;
    }
    // A guest who was sent as registered and is now waitlisted or declined stays as the CRM has them until CRM Desk carries those meanings (part 3): counted, not silent.
    for (const ref of previous) if ((await synced(q, "member", ref))) out.awaiting_contract++;

    // 3. Meetings the desk made (a meeting read back from the CRM is not written again).
    const meetings = await q<{ id: string; event_id: string; status: string; at: string; tz: string; email: string; full_name: string | null; company: string; domain: string; person_id: string | null; name: string }>(
      `SELECT m.id, m.event_id, m.status, m.scheduled_at::text AS at, m.timezone AS tz, lower(k.email) AS email, k.full_name, co.name AS company, m.domain, k.person_id, e.name
       FROM meetings m JOIN contacts k ON k.id = m.contact_id LEFT JOIN companies co ON co.id = k.company_id JOIN events e ON e.id = m.event_id
       WHERE m.external_key NOT LIKE 'cal:crm:%' AND m.status <> 'proposed' AND k.email IS NOT NULL AND ${IN_WINDOW}`);
    for (const m of meetings) {
      if (erased.has(m.email)) continue;
      const status = MEETING_STATUS[m.status], was = await synced(q, "meeting", m.id);
      const base = { email: m.email, full_name: m.full_name, company: m.company, domain: m.domain, event_id: m.event_id };
      if (!was) {
        await queueCreate(q, "activity", `activity:meeting:${m.id}`, m.person_id, { ...base, type: "meeting", direction: null, subject: `Meeting at ${m.name}`, at: new Date(m.at).toISOString(), meeting_status: status, timezone: m.tz });
        await remember(q, "meeting", m.id, status); out.meetings++;
      } else if (was.last !== status) {
        await queueCreate(q, "activity_update", `activity:meeting:${m.id}:${status}:${was.n + 1}`, m.person_id, { ...base, create_key: `activity:meeting:${m.id}`, meeting_status: status });
        await remember(q, "meeting", m.id, status); out.meeting_updates++;
      }
    }

    // 4. Sends, from touches.
    const sends = await q<{ id: string; event_id: string; channel: string | null; at: string; step: number | null; email: string; full_name: string | null; company: string; domain: string; person_id: string | null; name: string }>(
      `SELECT t.id, t.event_id, t.channel, t.at::text AS at, t.step, lower(k.email) AS email, k.full_name, co.name AS company, co.primary_domain AS domain, k.person_id, e.name
       FROM touches t JOIN contacts k ON k.id = t.contact_id LEFT JOIN companies co ON co.id = k.company_id JOIN events e ON e.id = t.event_id
       WHERE t.kind = 'send' AND k.email IS NOT NULL AND NOT EXISTS (SELECT 1 FROM suppressions u WHERE u.kind = 'opt_out' AND lower(u.email) = lower(k.email)) AND ${IN_WINDOW} AND NOT EXISTS (SELECT 1 FROM crm_sync s WHERE s.kind = 'send' AND s.ref = t.id) ORDER BY t.at LIMIT 500`);
    for (const t of sends) {
      if (!erased.has(t.email)) await queueCreate(q, "activity", `activity:send:${t.id}`, t.person_id, { email: t.email, full_name: t.full_name, company: t.company, domain: t.domain, event_id: t.event_id, type: t.channel === "linkedin" ? "linkedin" : "email", direction: "out", subject: `${t.name} outreach${t.step ? `, step ${t.step}` : ""}`, at: new Date(t.at).toISOString() });
      await remember(q, "send", t.id, "1"); out.sends++;
    }

    // 5. Replies: matched replies only; the message body is not sent.
    const replies = await q<{ id: string; event_id: string; channel: string; at: string; email: string; full_name: string | null; company: string; domain: string; person_id: string | null; name: string }>(
      `SELECT m.id, m.event_id, m.channel, m.received_at::text AS at, lower(k.email) AS email, k.full_name, co.name AS company, co.primary_domain AS domain, k.person_id, e.name
       FROM inbound_messages m JOIN contacts k ON k.id = m.contact_id LEFT JOIN companies co ON co.id = k.company_id JOIN events e ON e.id = m.event_id
       WHERE m.signal = 'reply' AND k.email IS NOT NULL AND ${IN_WINDOW} AND NOT EXISTS (SELECT 1 FROM crm_sync s WHERE s.kind = 'reply' AND s.ref = m.id) ORDER BY m.received_at LIMIT 500`);
    for (const r of replies) {
      if (!erased.has(r.email)) await queueCreate(q, "activity", `activity:reply:${r.id}`, r.person_id, { email: r.email, full_name: r.full_name, company: r.company, domain: r.domain, event_id: r.event_id, type: r.channel === "linkedin" ? "linkedin" : "email", direction: "in", subject: `Reply at ${r.name}`, at: new Date(r.at).toISOString() });
      await remember(q, "reply", r.id, "1"); out.replies++;
    }

    // 6. Accepted debrief facts: the quote, never the model's fact text; placed only when one contact at that account had a held meeting.
    const facts = await q<{ id: string; event_id: string; account: string | null; theme: string; quote: string; name: string }>(
      `SELECT f.id, d.event_id, f.account, f.theme, f.quote, e.name FROM debrief_facts f JOIN debriefs d ON d.id = f.debrief_id JOIN events e ON e.id = d.event_id
       WHERE d.status = 'accepted' AND ${IN_WINDOW} AND NOT EXISTS (SELECT 1 FROM crm_sync s WHERE s.kind = 'debrief' AND s.ref = f.id) LIMIT 500`);
    for (const f of facts) {
      const who = f.account ? await q<{ email: string; full_name: string | null; company: string; domain: string; person_id: string | null }>(
        `SELECT DISTINCT lower(k.email) AS email, k.full_name, co.name AS company, co.primary_domain AS domain, k.person_id FROM contacts k LEFT JOIN companies co ON co.id = k.company_id
         WHERE k.event_id = $1 AND k.email IS NOT NULL AND lower(co.name) = lower($2) AND EXISTS (SELECT 1 FROM meetings m WHERE m.contact_id = k.id AND m.status = 'held')`, [f.event_id, f.account]) : [];
      if (who.length === 1 && !erased.has(who[0].email)) {
        await queueCreate(q, "activity", `activity:debrief:${f.id}`, who[0].person_id, { ...who[0], event_id: f.event_id, type: "note", direction: null, subject: `Conversation at ${f.name}`, body: `${f.theme}: "${f.quote}"`, at: new Date().toISOString() });
        out.debriefs++;
      } else out.debrief_unplaced++;
      await remember(q, "debrief", f.id, who.length === 1 ? "placed" : "unplaced");
    }

    // 7. Money: built and off. Only when an install says CRM Desk hides the two fields from members (cross-repo item 7).
    if (moneyOn(env) && crm.updateCampaignMoney) {
      for (const e of await q<{ id: string }>("SELECT e.id FROM events e WHERE e.crm_campaign_id IS NOT NULL AND " + IN_WINDOW)) {
        const pair = await moneyOf(q, e.id), last = await synced(q, "money", e.id), now = `${pair.budget_cents}:${pair.actual_cost_cents}`;
        if (last?.last === now) continue;
        await queueCreate(q, "campaign_money", `money:${e.id}:${(last?.n ?? 0) + 1}`, null, { event_id: e.id, email: null });
        await remember(q, "money", e.id, now); out.money++;
      }
    }
  });
  return out;
}

/** The two numbers, whole cents, USD. Budget: the plan's lines. Actual: tickets bought plus recorded cost lines (no AI, no travel estimate). */
export async function moneyOf(q: Db["query"], eventId: string): Promise<{ budget_cents: number; actual_cost_cents: number }> {
  const [t] = await q<{ n: string }>("SELECT coalesce(sum(p.amount_cents), 0)::text AS n FROM ticket_purchases p JOIN seat_requests r ON r.id = p.seat_request_id WHERE r.event_id = $1", [eventId]);
  const [c] = await q<{ n: string }>("SELECT coalesce(sum(amount_cents), 0)::text AS n FROM event_costs WHERE event_id = $1", [eventId]);
  return { budget_cents: Number(await plannedTotal(q, eventId)), actual_cost_cents: Number(t.n) + Number(c.n) };
}

/** Rows that have waited over 24 hours on their campaign or parent: the event ids, for one alert each. */
export async function longWaiting(db: Db): Promise<{ event_id: string; n: number }[]> {
  return db.query("SELECT payload->>'event_id' AS event_id, count(*)::int AS n FROM crm_outbox WHERE status = 'queued' AND last_error LIKE '%not in the CRM yet' AND created_at < now() - interval '24 hours' GROUP BY 1");
}
