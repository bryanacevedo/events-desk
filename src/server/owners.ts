/* Owner say (docs/LIFECYCLE.md, section 4). The account's owner decides before anyone there is sequenced. Silence includes only when a message really reached them. */

import type { Db } from "./db.ts";
import { crmConnected } from "./crm-checks.ts";
import { stopDomain } from "./enroll-ops.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { DESK, nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { moveMotion } from "./motion-state.ts";
import { postToEvent } from "./operating.ts";
import { openLifecycleCase } from "./lifecycle-cases.ts";
import { ACCOUNTS_PER_CARD, ownerCard, ownerWarningCard, type OwnerAccount } from "./slack-cards.ts";
import { addHold, addTouch, releaseHold } from "./touches.ts";
import { addBusinessDays } from "../shared/motion.ts";

type Q = Db["query"];
const FAR = 400 * 86_400_000;

/** What a decision does, wherever it came from. */
export async function applyDecision(q: Q, d: { id: string; event_id: string; company_id: string; domain: string | null }, status: "include" | "mine", via: "owner" | "default" | "case" | "uploader", actor: string, now: Date) {
  await q("UPDATE owner_decisions SET status = $2, via = $3, decided_at = $4, decided_by = $5 WHERE id = $1", [d.id, status, via, now.toISOString(), actor]);
  if (!d.domain) return;
  if (status === "mine") {
    await addTouch(q, { domain: d.domain, event_id: d.event_id, kind: "owner_mine", reason: `${actor} is handling this account`, source: actor, dedup_key: `mine:${d.id}:${now.getTime()}` });
    await addHold(q, { domain: d.domain, event_id: d.event_id, cause: "mine", cause_id: d.id, expires_at: new Date(now.getTime() + FAR) });
    // Late still works: anyone already in a draft or active sequence comes out, with the cause recorded.
    await stopDomain(q, d.domain, "remove", "owner_mine", d.id, d.event_id);
  } else {
    await releaseHold(q, "mine", d.id, actor);
  }
}

/** One row per account with a CRM owner that does not have one yet. The owner is read fresh, and a late-stage case answered at delivery counts. */
export async function openOwnerDecisions(db: Db, deps: LifecycleDeps, eventId: string) {
  if (!crmConnected(deps.crm)) return { opened: 0 };
  const crm = deps.crm, now = nowOf(deps), asOf = now.toISOString().slice(0, 10);
  const accounts = await db.query<{ id: string; name: string; domain: string }>(
    `SELECT DISTINCT co.id, co.name, co.primary_domain AS domain FROM companies co JOIN contacts k ON k.company_id = co.id AND k.dropped_at IS NULL AND k.priority IS NOT NULL
     WHERE co.event_id = $1 AND co.primary_domain IS NOT NULL AND NOT EXISTS (SELECT 1 FROM owner_decisions d WHERE d.event_id = $1 AND d.company_id = co.id) ORDER BY co.id`, [eventId]);
  let opened = 0;
  for (const a of accounts) {
    const info = crm.lookupByDomain ? await crm.lookupByDomain(a.domain, a.name, asOf) : await crm.lookup(a.name, asOf);
    if (!info.owner) continue;
    await db.tx(async (q) => {
      const id = newId("own");
      const ins = await q("INSERT INTO owner_decisions (id, event_id, company_id, owner) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id, company_id) DO NOTHING RETURNING id", [id, eventId, a.id, info.owner]);
      if (!ins.length) return;
      opened++;
      const [lc] = await q<{ decision: string | null; status: string }>("SELECT decision, status FROM review_cases WHERE event_id = $1 AND company_id = $2 AND kind = 'late_stage_deal' ORDER BY created_at DESC LIMIT 1", [eventId, a.id]);
      if (!lc) return;
      // Keep means the owner's. Dismiss means include. No answer yet is the owner's too: a late-stage deal is not one to reach by default.
      const status = lc.status === "open" || lc.decision === "keep" ? "mine" : "include";
      await applyDecision(q, { id, event_id: eventId, company_id: a.id, domain: a.domain }, status, "case", DESK, now);
    });
  }
  return { opened };
}

async function handToUploader(q: Q, d: { id: string; event_id: string; company_id: string; company: string; owner: string }, why: string) {
  await q("UPDATE owner_decisions SET status = 'handed', via = 'uploader' WHERE id = $1", [d.id]);
  await openLifecycleCase(q, {
    eventId: d.event_id, kind: "owner_unreachable", companyId: d.company_id,
    summary: `${d.owner} owns ${d.company}, but ${why}. Should the team reach out there?`,
    facts: [{ company: d.company, owner: d.owner, why }], suggested: "mine", payload: { decision_id: d.id },
  });
}

const byDate = (d: Date, holidays: string[]) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(addBusinessDays(d, 2, holidays));

/** Sends one grouped card per owner. The clock starts only for a message that was delivered. An unmapped owner or a failed message goes to the uploader as a case. */
export async function sendOwnerCards(db: Db, deps: LifecycleDeps, eventId: string) {
  const now = nowOf(deps), asOf = now.toISOString().slice(0, 10);
  const open = await db.query<{ id: string; event_id: string; company_id: string; company: string; domain: string; owner: string; people: number; deal_stage: string | null; event: string }>(
    `SELECT d.id, d.event_id, d.company_id, co.name AS company, co.primary_domain AS domain, d.owner, co.deal_stage, e.name AS event,
            (SELECT count(*)::int FROM contacts k WHERE k.company_id = co.id AND k.dropped_at IS NULL AND k.priority IS NOT NULL) AS people
     FROM owner_decisions d JOIN companies co ON co.id = d.company_id JOIN events e ON e.id = d.event_id WHERE d.event_id = $1 AND d.status = 'pending' AND d.sent_at IS NULL ORDER BY d.owner, co.name`, [eventId]);
  // If the account changed hands, the new owner is the one asked.
  if (crmConnected(deps.crm)) for (const d of open) {
    const info = deps.crm.lookupByDomain ? await deps.crm.lookupByDomain(d.domain, d.company, asOf) : await deps.crm.lookup(d.company, asOf);
    if (info.owner && info.owner !== d.owner) { await db.query("UPDATE owner_decisions SET owner = $2 WHERE id = $1", [d.id, info.owner]); d.owner = info.owner; }
  }
  const groups = new Map<string, typeof open>();
  for (const d of open) groups.set(d.owner, [...(groups.get(d.owner) ?? []), d]);
  const by = byDate(now, deps.holidays ?? []);
  for (const [owner, rows] of groups) {
    const slackId = deps.userMap?.[owner];
    if (!slackId || !deps.notify) { await db.tx(async (q) => { for (const d of rows) await handToUploader(q, d, slackId ? "Slack is not connected" : "they have no Slack user here"); }); continue; }
    for (let i = 0; i < rows.length; i += ACCOUNTS_PER_CARD) {
      const page = rows.slice(i, i + ACCOUNTS_PER_CARD);
      const card = ownerCard(page[0].event, page.map<OwnerAccount>((d) => ({ decision_id: d.id, company: d.company, people: d.people, deal: d.deal_stage })), by);
      const delivered = await postToEvent(db, deps, eventId, card, [slackId]);
      await db.tx(async (q) => {
        for (const d of page) {
          if (delivered) await q("UPDATE owner_decisions SET sent_at = $2 WHERE id = $1", [d.id, now.toISOString()]);
          else await handToUploader(q, d, "the Slack message did not go through");
        }
      });
    }
  }
}

/** Warns at one business day of silence, includes at two, and moves the event on when nothing is waiting. */
export async function ownerSweep(db: Db, deps: LifecycleDeps, eventId: string) {
  const now = nowOf(deps), holidays = deps.holidays ?? [];
  const open = await db.query<{ id: string; event_id: string; company_id: string; domain: string | null; owner: string; sent_at: string; warned_at: string | null; event: string }>(
    `SELECT d.id, d.event_id, d.company_id, co.primary_domain AS domain, d.owner, d.sent_at::text AS sent_at, d.warned_at::text AS warned_at, e.name AS event FROM owner_decisions d JOIN companies co ON co.id = d.company_id JOIN events e ON e.id = d.event_id
     WHERE d.event_id = $1 AND d.status = 'pending' AND d.sent_at IS NOT NULL`, [eventId]);
  const warn = new Map<string, typeof open>();
  for (const d of open) {
    const sent = new Date(d.sent_at);
    const days = now >= addBusinessDays(sent, 2, holidays) ? 2 : now >= addBusinessDays(sent, 1, holidays) ? 1 : 0;
    if (days >= 2) await db.tx(async (q) => {
      await applyDecision(q, d, "include", "default", DESK, now);
      await addTouch(q, { domain: d.domain, event_id: d.event_id, kind: "owner_default", reason: "No answer in two business days", source: DESK, dedup_key: `own_default:${d.id}` });
    });
    else if (days === 1 && !d.warned_at) warn.set(d.owner, [...(warn.get(d.owner) ?? []), d]);
  }
  for (const [owner, rows] of warn) {
    const slackId = deps.userMap?.[owner];
    if (slackId) await postToEvent(db, deps, eventId, ownerWarningCard(rows[0].event, rows.length, "the next business day"), [slackId]);
    await db.query("UPDATE owner_decisions SET warned_at = $2 WHERE id = ANY($1::text[])", [rows.map((r) => r.id), now.toISOString()]);
  }
  await db.tx(async (q) => {
    const [e] = await q<{ motion: string }>("SELECT motion FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (e.motion !== "owners") return;
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM owner_decisions WHERE event_id = $1 AND status = 'pending'", [eventId]);
    if (n === 0) await moveMotion(q, eventId, "sequencing", DESK, "Every account owner has had their say");
  });
}

/** An owner pressing Include or Mine, late or on time. Only that owner or the person who uploaded the list. */
export async function decideOwner(db: Db, deps: LifecycleDeps, decisionId: string, actor: string, status: "include" | "mine") {
  const now = nowOf(deps);
  const out = await db.tx(async (q) => {
    const [d] = await q<{ id: string; event_id: string; company_id: string; owner: string; domain: string | null; company: string }>(
      `SELECT d.id, d.event_id, d.company_id, d.owner, co.primary_domain AS domain, co.name AS company FROM owner_decisions d JOIN companies co ON co.id = d.company_id WHERE d.id = $1 FOR UPDATE OF d`, [decisionId]);
    if (!d) throw new RuleError("That decision does not exist.");
    const [up] = await q<{ uploaded_by: string }>("SELECT uploaded_by FROM uploads WHERE event_id = $1 ORDER BY created_at DESC LIMIT 1", [d.event_id]);
    if (actor !== d.owner && actor !== up?.uploaded_by) throw new RuleError(`Only ${d.owner} or the person who uploaded the list can decide this.`);
    const [cur] = await q<{ status: string; via: string | null }>("SELECT status, via FROM owner_decisions WHERE id = $1", [decisionId]);
    if (actor !== d.owner && cur.via === "owner") throw new RuleError(`${d.owner} already decided this.`);
    await applyDecision(q, d, status, actor === d.owner ? "owner" : "uploader", actor, now);
    await logActivity(q, d.event_id, actor, "owner", `${actor} said ${status} on ${d.company}`);
    return d;
  });
  return { event_id: out.event_id, company: out.company, status };
}
