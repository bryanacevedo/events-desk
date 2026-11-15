/* What the CRM should hold about an event's people, derived from state and queued once per change (docs/SHARED-WORLD.md section 12).
   A sweep, not a call at each change: a guest's status moves in a dozen places, and a sweep from state cannot miss one. `crm_sync` remembers the last value queued for each thing,
   so running it twice queues once, and a status that goes back to an earlier value is a new row (the key carries a sequence). */

import type { Db } from "./db.ts";
import { canWrite, queueCampaign, queueCreate } from "./crm-outbox.ts";
import type { Crm } from "./providers.ts";
import { plannedTotal } from "./budget-lines.ts";
import { LAST_DAY_SQL } from "./motion.ts";
import { defaultSettings } from "./approvals.ts";
import { normalizeCountry } from "../shared/country-rules.ts";

/** Funnel order for one member: the highest of everything known about them wins. A decline is a person's answer, so it beats a send or a reply but never an attendance (docs/SHARED-WORLD.md 13.4). */
export const RANK: Record<string, number> = { targeted: 0, sent: 10, responded: 20, waitlist: 30, declined: 35, registered: 40, no_show: 50, attended: 60, met: 70 };
/** The three meanings CRM Desk carries since 6ab3e22. Written only once the CRM's own feature list names them. */
export const NEW_MEANINGS: readonly string[] = ["targeted", "waitlist", "declined"];
/** A person is announced as a target only this many days before the event starts, and not after it ends (13.9 item 11). */
export const TARGET_LEAD_DAYS = 45;
/** At most this many targeted members per event are written to the CRM; the rest are counted. */
export const TARGET_CAP = 500;
const GUEST_STATUS: Record<string, string | null> = { invited: "sent", registered: "registered", attended: "attended", no_show: "no_show", listed: "targeted", waitlist: "waitlist", declined: "declined" };
const WINDOW_DAYS = 180;
const MEETING_STATUS: Record<string, string> = { booked: "booked", rescheduled: "booked", held: "held", no_show: "no_show", cancelled: "cancelled" };

export const moneyOn = (env: Record<string, string | undefined> = process.env) => (env.CRM_CAMPAIGN_MONEY ?? "").toLowerCase() === "usd";

export interface SyncResult { campaigns: number; members: number; awaiting_contract: number; targeted_barred: number; targeted_over_cap: number; released: number; meetings: number; meeting_updates: number; sends: number; replies: number; debriefs: number; debrief_unplaced: number; money: number }
const zero = (): SyncResult => ({ campaigns: 0, members: 0, awaiting_contract: 0, targeted_barred: 0, targeted_over_cap: 0, released: 0, meetings: 0, meeting_updates: 0, sends: 0, replies: 0, debriefs: 0, debrief_unplaced: 0, money: 0 });

async function synced(q: Db["query"], kind: string, ref: string) { return (await q<{ last: string; n: number }>("SELECT last, n FROM crm_sync WHERE kind = $1 AND ref = $2", [kind, ref]))[0]; }
const remember = (q: Db["query"], kind: string, ref: string, last: string) =>
  q("INSERT INTO crm_sync (kind, ref, last) VALUES ($1, $2, $3) ON CONFLICT (kind, ref) DO UPDATE SET last = EXCLUDED.last, n = crm_sync.n + 1, queued_at = now()", [kind, ref, last]);
const IN_WINDOW = `e.starts_on >= current_date - ${WINDOW_DAYS}`;

/** An address on the suppression list because of an erasure request is never written about again. */
const erasedEmails = async (q: Db["query"]) => new Set((await q<{ email: string }>("SELECT lower(email) AS email FROM suppressions WHERE kind = 'opt_out' AND reason = 'Erasure request' AND email IS NOT NULL")).map((r) => r.email));

/** The meanings the CRM says it carries (its own feature list, cached by the adapter). A CRM that cannot say, or does not publish one, releases none of the three. */
export async function releasedMeanings(crm: Crm): Promise<Set<string> | null> {
  if (!crm.features) return new Set();
  try { const f = await crm.features(); return f ? new Set(f.campaign_member_meanings) : null; } catch { return null; }
}

export async function syncCrm(db: Db, crm: Crm | null | undefined, env: Record<string, string | undefined> = process.env): Promise<SyncResult> {
  const out = zero();
  if (!canWrite(crm)) return out;
  const features = await releasedMeanings(crm);                       // null: unreadable, nothing is released and nothing is set back to queued by a change
  const released = features ?? new Set<string>();
  await db.tx(async (q) => {
    const erased = await erasedEmails(q);
    const barredEmails = new Set((await q<{ email: string }>("SELECT lower(email) AS email FROM suppressions WHERE kind = 'opt_out' AND email IS NOT NULL")).map((r) => r.email));
    const blockedCountries = new Set((defaultSettings().email_country_rules?.blocked ?? []).map((c) => c.toUpperCase()));
    const barredCountry = (...places: (string | null | undefined)[]) => places.some((p) => { const c = normalizeCountry(p?.split(",").at(-1)?.trim() ?? ""); return Boolean(c && blockedCountries.has(c)); });

    // 0. Held rows: cancelled when erased or superseded; set back to queued when the CRM's list of meanings changed, and once a day.
    await q("UPDATE crm_outbox SET status = 'cancelled', last_error = 'erased' WHERE status IN ('queued', 'held') AND lower(payload->>'email') IN (SELECT lower(email) FROM suppressions WHERE kind = 'opt_out' AND reason = 'Erasure request' AND email IS NOT NULL)");
    await q(`UPDATE crm_outbox o SET status = 'cancelled', last_error = 'superseded' WHERE o.status = 'held' AND o.kind = 'campaign_member'
             AND EXISTS (SELECT 1 FROM crm_outbox n WHERE n.kind = 'campaign_member' AND n.payload->>'member_ref' = o.payload->>'member_ref' AND n.id <> o.id AND n.status IN ('queued', 'held', 'done') AND (n.created_at, n.id) > (o.created_at, o.id))`);
    const list = features ? [...features].sort().join(",") : null, was = await synced(q, "features", "meanings");
    const [{ today }] = await q<{ today: string }>("SELECT current_date::text AS today");
    const day = await synced(q, "features", "released_on");
    if ((list !== null && list !== was?.last) || day?.last !== today) {
      const r = await q<{ id: string }>("UPDATE crm_outbox SET status = 'queued', last_error = NULL WHERE status = 'held' RETURNING id");
      out.released = r.length;
      if (list !== null && list !== was?.last) await remember(q, "features", "meanings", list);
      await remember(q, "features", "released_on", today);
    }

    // 1. Members: one per event and address, the highest status known.
    type M = { event_id: string; email: string; full_name: string | null; company: string | null; domain: string | null; person_id: string | null; statuses: Set<string> };
    const members = new Map<string, M>();
    const put = (m: Omit<M, "statuses"> & { status: string }) => {
      const k = `${m.event_id}:${m.email}`, cur = members.get(k);
      if (cur) { cur.statuses.add(m.status); cur.person_id ??= m.person_id; } else members.set(k, { ...m, statuses: new Set([m.status]) });
    };
    const LEAD = `(current_date >= e.starts_on - ${TARGET_LEAD_DAYS} AND current_date <= ${LAST_DAY_SQL})`;
    const guests = await q<{ event_id: string; email: string; name: string; company: string | null; status: string; country: string | null; lead: boolean }>(
      `SELECT g.event_id, lower(g.email) AS email, g.name, g.company, g.status, g.country, ${LEAD} AS lead FROM event_guests g JOIN events e ON e.id = g.event_id WHERE g.removed_at IS NULL AND g.email IS NOT NULL AND ${IN_WINDOW}`);
    for (const g of guests) {
      if (erased.has(g.email)) continue;
      const s = GUEST_STATUS[g.status] ?? null;
      if (s === "targeted") {
        if (!g.lead) continue;                                          // announced only inside the lead window
        if (barredEmails.has(g.email) || barredCountry(g.country)) { out.targeted_barred++; continue; }
      }
      if (s) put({ event_id: g.event_id, email: g.email, full_name: g.name, company: g.company, domain: null, person_id: null, status: s });
    }
    const contacts = await q<{ event_id: string; email: string; full_name: string | null; company: string; domain: string | null; person_id: string | null; enrolled: boolean; replied: boolean; held: boolean; any_meeting: boolean; target: boolean; priority: string | null; tier: number | null; lead: boolean; person_location: string | null; firmo_country: string | null }>(
      `SELECT k.event_id, lower(k.email) AS email, k.full_name, co.name AS company, co.primary_domain AS domain, k.person_id, k.priority, co.tier, k.person_location, co.firmo->>'country' AS firmo_country,
         (k.priority IN ('A', 'B') OR co.tier IN (1, 2)) AS target, ${LEAD} AS lead,
         EXISTS (SELECT 1 FROM enrollments n WHERE n.contact_id = k.id AND n.state <> 'adding') AS enrolled,
         EXISTS (SELECT 1 FROM inbound_messages m WHERE m.contact_id = k.id AND m.signal = 'reply') AS replied,
         EXISTS (SELECT 1 FROM meetings m WHERE m.contact_id = k.id AND m.status = 'held') AS held,
         EXISTS (SELECT 1 FROM meetings m WHERE m.contact_id = k.id) AS any_meeting
       FROM contacts k LEFT JOIN companies co ON co.id = k.company_id JOIN events e ON e.id = k.event_id WHERE k.dropped_at IS NULL AND k.email IS NOT NULL AND ${IN_WINDOW}
       ORDER BY k.event_id, (k.priority = 'A') DESC, (k.priority = 'B') DESC, co.tier NULLS LAST, k.id`);
    const cands: { key: string; row: (typeof contacts)[number] }[] = [];
    const barredKeys = new Set<string>();
    for (const c of contacts) {
      if (erased.has(c.email)) continue;
      const s = c.held ? "met" : c.replied ? "responded" : c.enrolled ? "sent" : null;
      if (s) { put({ event_id: c.event_id, email: c.email, full_name: c.full_name, company: c.company, domain: c.domain, person_id: c.person_id, status: s }); continue; }
      if (!(c.target && c.lead && !c.any_meeting)) continue;
      const key = `${c.event_id}:${c.email}`;
      if (barredEmails.has(c.email) || barredCountry(c.person_location, c.firmo_country)) { barredKeys.add(key); continue; }
      cands.push({ key, row: c });
    }
    // The cap and the counts are per event and address, after every row of one address is seen (rows arrive in priority order).
    const taken = new Map<string, Set<string>>(), over = new Set<string>();
    for (const { key, row: c } of cands) {
      const set = taken.get(c.event_id) ?? new Set<string>();
      if (!set.has(key) && set.size >= TARGET_CAP) { over.add(key); continue; }
      set.add(key); taken.set(c.event_id, set);
      put({ event_id: c.event_id, email: c.email, full_name: c.full_name, company: c.company, domain: c.domain, person_id: c.person_id, status: "targeted" });
    }
    out.targeted_over_cap += [...over].filter((k) => !taken.get(k.split(":")[0])?.has(k)).length;
    out.targeted_barred += [...barredKeys].filter((k) => !members.has(k) || ![...members.get(k)!.statuses].includes("targeted")).length;

    // What each member is, given what the CRM carries: the highest of what is known, or (when that is a meaning the CRM does not carry yet) the highest it does carry, never lower than what was sent.
    const wanted: { m: M; status: string; ref: string; was?: { last: string; n: number } }[] = [];
    for (const m of members.values()) {
      const ref = `${m.event_id}:${m.email}`, was = await synced(q, "member", ref);
      const ranked = [...m.statuses].sort((a, b) => RANK[b] - RANK[a]);
      let status = ranked[0];
      if (NEW_MEANINGS.includes(status) && !released.has(status)) {
        out.awaiting_contract++;
        status = ranked.find((x) => !NEW_MEANINGS.includes(x) || released.has(x)) ?? "";
        if (!status || (was && RANK[status] < RANK[was.last])) continue;
      }
      wanted.push({ m, status, ref, was });
    }

    // 2. Every event that has a member to write (one the CRM carries), or a plan asked for, has its campaign queued (the key makes a repeat a no-op).
    const eventIds = new Set<string>(wanted.map((w) => w.m.event_id));
    for (const r of await q<{ id: string }>("SELECT e.id FROM events e WHERE e.plan_submitted_at IS NOT NULL AND " + IN_WINDOW)) eventIds.add(r.id);
    for (const id of eventIds) {
      const [has] = await q("SELECT 1 FROM crm_outbox WHERE desk_key = $1", [`campaign:${id}`]);
      if (!has) { await queueCampaign(q, id, crm); out.campaigns++; }
    }

    const names = new Map((await q<{ id: string; name: string; write_leads: boolean }>("SELECT id, name, write_leads FROM events")).map((e) => [e.id, e]));
    for (const { m, status, ref, was } of wanted) {
      const ev = names.get(m.event_id)!;
      if (was?.last === status) continue;
      const n = (was?.n ?? 0) + 1;
      await queueCreate(q, "campaign_member", `cm:${m.event_id}:${m.email}:${status}:${n}`, m.person_id, { email: m.email, full_name: m.full_name, company: m.company, domain: m.domain, event_id: m.event_id, campaign: ev.name, write_leads: ev.write_leads, status, member_ref: ref });
      await remember(q, "member", ref, status);
      out.members++;
    }
    for (const k of ["awaiting_contract", "targeted_barred", "targeted_over_cap"] as const) await remember(q, "count", k, String(out[k]));

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
