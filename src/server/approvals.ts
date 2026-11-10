/* The only code that can approve anything. Slack's signed route and the demo
   panel both call decideApproval, so the rules cannot differ between them. */

import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { endTopUpWithin, EVENT_COLS, logActivity, moveWithin, newId, RuleError } from "./events.ts";
import { undoFreePass } from "./research.ts";
import { pinIcp } from "./icp.ts";
import { applyMotionCard } from "./motion.ts";
import type { EventRow } from "../shared/domain.ts";
import type { Icp } from "../shared/icp.ts";
import { quote, titleRule, validateSettingsPatch, type CardInputs, type Settings } from "../shared/cost.ts";

export const defaultSettings = (): Settings => JSON.parse(readFileSync(new URL("../../config/defaults.json", import.meta.url), "utf8"));

export async function getSettings(q: Db["query"], eventId: string): Promise<Settings> {
  const [row] = await q<{ settings: Settings }>("SELECT settings FROM event_settings WHERE event_id = $1", [eventId]);
  if (!row) throw new RuleError("This event has no settings.");
  // Events made before a setting existed take its default.
  const s: Settings = { ...defaultSettings(), ...row.settings };
  // The Never contact and Existing customer lists a person confirmed in the ICP apply alongside the ones in settings: the event's pinned version once it has one, the current version until then.
  const [v] = await q<{ icp: Icp }>("SELECT icp FROM icp_versions WHERE version = coalesce((SELECT icp_version FROM events WHERE id = $1), (SELECT max(version) FROM icp_versions))", [eventId]);
  if (!v?.icp?.lists) return s;
  return {
    ...s,
    excluded_companies: [...new Set([...s.excluded_companies, ...v.icp.lists.excluded.map((e) => e.name)])],
    existing_customers: [...new Set([...s.existing_customers, ...v.icp.lists.customers.map((e) => e.name)])],
  };
}

export const getSettingsNow = (db: Db, eventId: string) => getSettings(db.query, eventId);

export async function patchSettings(db: Db, eventId: string, actor: string, patch: Record<string, unknown>) {
  const err = validateSettingsPatch(patch);
  if (err) throw new RuleError(err);
  return db.tx(async (q) => {
    const [e] = await q<{ stage: string; parent_event_id: string | null }>("SELECT stage, parent_event_id FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (!e) throw new RuleError("That event does not exist.");
    if (e.parent_event_id) throw new RuleError("New registrations use the event's own settings.");
    // The desk prices the card on its own, so a setting can still change while the card waits: the card is set aside, the free
    // work it did is put back, and it is priced again with the new settings. Once a card is confirmed, the settings are fixed.
    if (e.stage === "quoted") {
      const [pending] = await q<{ id: string; kind: string; card_id: string | null }>("SELECT id, kind, card_id FROM approvals WHERE event_id = $1 AND status = 'pending' AND kind IN ('card', 'research') LIMIT 1", [eventId]);
      if (pending) {
        await q("UPDATE approvals SET status = 'declined', decided_by = $2, decided_at = now(), reason = 'Priced again: settings changed' WHERE id = $1", [pending.id, actor]);
        if (pending.card_id) await q("UPDATE cost_cards SET status = 'declined' WHERE id = $1", [pending.card_id]);
        if (pending.kind === "research") await undoFreePass(q, eventId);
        await moveWithin(q, eventId, "mapped", actor, { detail: "Settings changed; the card is priced again" });
        e.stage = "mapped";
      }
    }
    if (!["requested", "approved", "mapped"].includes(e.stage)) throw new RuleError("Settings are fixed once a cost card is confirmed.");
    const current = await getSettings(q, eventId);
    const s = { ...current, ...(patch.contacts_per_company !== undefined ? { contacts_per_company: patch.contacts_per_company as number } : {}), ...(patch.add_prospects !== undefined ? { add_prospects: patch.add_prospects as boolean } : {}) };
    await q("UPDATE event_settings SET settings = $2::jsonb WHERE event_id = $1", [eventId, JSON.stringify(s)]);
    await logActivity(q, eventId, actor, "settings", `Set ${s.contacts_per_company} contacts per company, prospects ${s.add_prospects ? "on" : "off"}`);
    return s;
  });
}

export async function cardInputs(q: Db["query"], eventId: string, s: Settings): Promise<CardInputs> {
  const [c] = await q<Omit<CardInputs, "titles_with_no_rule">>(
    `SELECT (SELECT count(*)::int FROM contacts WHERE event_id = $1 AND dropped_at IS NULL) AS person_rows,
            (SELECT count(*)::int FROM source_rows WHERE event_id = $1 AND kind = 'company_only' AND dropped_at IS NULL) AS company_only_rows,
            (SELECT count(*)::int FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND company_id IS NOT NULL AND email IS NULL) AS people_without_email,
            (SELECT count(*)::int FROM companies WHERE event_id = $1) AS unique_companies,
            (SELECT count(DISTINCT company_id)::int FROM contacts WHERE event_id = $1 AND dropped_at IS NULL) AS companies_with_people`,
    [eventId],
  );
  const titles = await q<{ title: string }>("SELECT DISTINCT lower(title) AS title FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND title IS NOT NULL", [eventId]);
  return { ...c, titles_with_no_rule: titles.filter((t) => titleRule(t.title, s.title_keywords) === null).length };
}

/** Builds the card from the mapped list and asks for approval. No paid call has run yet. */
export async function requestCard(db: Db, eventId: string, actor: string) {
  return db.tx(async (q) => {
    const [flow] = await q<{ flow: string }>("SELECT flow FROM events WHERE id = $1", [eventId]);
    if (flow?.flow === "two_card") throw new RuleError("This event uses a Research card and an Outreach card, not the single cost card.");
    const event = await moveWithin(q, eventId, "quoted", actor, { detail: "Requested the cost card" });
    const s = await getSettings(q, eventId);
    const inputs = await cardInputs(q, eventId, s);
    const c = quote(inputs, s);
    const id = newId("card");
    await q(
      `INSERT INTO cost_cards (id, event_id, inputs, rates, lines, credits_cap, llm_cap, est_cents) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8)`,
      [id, eventId, JSON.stringify(inputs), JSON.stringify({ finders: s.finders, verifiers: s.verifiers, linkedin: s.linkedin, discovery_cost: s.discovery_cost, llm_call_cents: s.llm_call_cents }), JSON.stringify(c.lines), c.credits_cap, c.llm_cap, c.est_cents],
    );
    await q("INSERT INTO approvals (id, event_id, kind, card_id, requested_by) VALUES ($1, $2, 'card', $3, $4)", [newId("apr"), eventId, id, event.requested_by]);
    await q("UPDATE approvals SET also_requested_by = $2 WHERE card_id = $1", [id, actor]);
    return event;
  });
}

/** The person who uploaded the current list: the latest upload on the event. New registrations merged into it do not count, so the first list keeps its owner; a top-up has its own. They, and nobody else, confirm its cost cards (decided 2026-11-08, docs/DECISIONS.md).
    Whoever uploads a new list becomes the one who confirms, and a card quoted for an earlier list is void. */
export async function currentUploader(q: Db["query"], eventId: string) {
  const [u] = await q<{ uploaded_by: string; created_at: Date }>("SELECT uploaded_by, created_at FROM uploads WHERE event_id = $1 AND (top_up_id IS NULL OR top_up_id = event_id) ORDER BY created_at DESC, id DESC LIMIT 1", [eventId]);
  return u ?? null;
}

export interface Decision { approvalId: string; actor: string; decision: "approve" | "decline"; reason?: string }
export interface DecisionResult { status: "approved" | "declined"; decided_by: string; already_decided: boolean; event_id: string }

export async function decideApproval(db: Db, d: Decision): Promise<DecisionResult> {
  return db.tx(async (q) => {
    const [a] = await q<{ id: string; event_id: string; kind: string; card_id: string | null; status: string; requested_by: string; also_requested_by: string | null; decided_by: string | null }>(
      "SELECT id, event_id, kind, card_id, status, requested_by, also_requested_by, decided_by FROM approvals WHERE id = $1 FOR UPDATE", [d.approvalId],
    );
    if (!a) throw new RuleError("That approval does not exist.");
    // A second click changes nothing and reports who decided first.
    if (a.status !== "pending") return { status: a.status as DecisionResult["status"], decided_by: a.decided_by!, already_decided: true, event_id: a.event_id };

    if (a.kind === "seats") {
      // Seat requests are a spending decision for leadership: the event's approvers, and never the person who asked.
      const settings = await getSettings(q, a.event_id);
      if (!settings.approvers.includes(d.actor)) throw new RuleError(`${d.actor} is not one of this event's approvers.`);
      if (d.decision === "approve" && (d.actor === a.requested_by || d.actor === a.also_requested_by)) throw new RuleError("Nobody can approve their own request.");
    } else {
      // A cost card is a check by the person who uploaded the list that they mean to run the paid steps. Only that person confirms it.
      const up = await currentUploader(q, a.event_id);
      if (!up) throw new RuleError("There is no attendee list for this card, so nobody can confirm it.");
      if (d.actor !== up.uploaded_by) throw new RuleError(`Only ${up.uploaded_by}, who uploaded the attendee list, can confirm its cost card.`);
      const [card] = await q<{ created_at: Date }>("SELECT created_at FROM cost_cards WHERE id = $1", [a.card_id]);
      if (card && card.created_at < up.created_at) throw new RuleError("This card was quoted for an earlier upload. Ask for a new one.");
    }
    if (d.decision === "decline" && !d.reason?.trim()) throw new RuleError("Say why before declining.");

    const status = d.decision === "approve" ? "approved" : "declined";
    await q("UPDATE approvals SET status = $2, decided_by = $3, decided_at = now(), reason = $4 WHERE id = $1", [a.id, status, d.actor, d.reason?.trim() || null]);

    // Declining a card on a top-up ends it, whichever card it was. It never goes back a stage, and its parent is not touched.
    if (a.kind !== "seats" && status === "declined") {
      const [ev] = await q<{ parent_event_id: string | null }>("SELECT parent_event_id FROM events WHERE id = $1", [a.event_id]);
      if (ev?.parent_event_id) {
        await q("UPDATE cost_cards SET status = 'declined' WHERE id = $1", [a.card_id]);
        await endTopUpWithin(q, a.event_id, d.actor, d.reason!.trim());
        return { status, decided_by: d.actor, already_decided: false, event_id: a.event_id };
      }
    }

    if (a.kind === "seats") {
      if (status === "approved") await moveWithin(q, a.event_id, "approved", d.actor, { detail: "Approved the seats" });
      else await moveWithin(q, a.event_id, "declined", d.actor, { reason: d.reason, detail: `Declined the seats: ${d.reason!.trim()}` });
    } else if (a.kind === "research") {
      await q("UPDATE cost_cards SET status = $2 WHERE id = $1", [a.card_id, status]);
      if (status === "approved") {
        // The event keeps the ICP version that is current now. A newer version never touches an event already running.
        const v = await pinIcp(q, a.event_id);
        await moveWithin(q, a.event_id, "researching", d.actor, { detail: v ? `Approved the Research card, using ICP version ${v}` : "Approved the Research card" });
      }
      else {
        // The lists and settings are editable again, so the free work is put back and redone at the next request.
        await undoFreePass(q, a.event_id);
        await moveWithin(q, a.event_id, "mapped", d.actor, { detail: `Declined the Research card: ${d.reason!.trim()}` });
      }
    } else if (a.kind === "motion") {
      await applyMotionCard(q, a.card_id!, a.event_id, d.actor, status, d.reason);
    } else if (a.kind === "outreach") {
      await q("UPDATE cost_cards SET status = $2 WHERE id = $1", [a.card_id, status]);
      // A declined Outreach card returns to the review step. The research stays paid for.
      if (status === "approved") await moveWithin(q, a.event_id, "finding_people", d.actor, { detail: "Approved the Outreach card" });
      else await logActivity(q, a.event_id, d.actor, "approval", `Declined the Outreach card: ${d.reason!.trim()}`);
    } else {
      await q("UPDATE cost_cards SET status = $2 WHERE id = $1", [a.card_id, status]);
      if (status === "approved") await moveWithin(q, a.event_id, "tiering", d.actor, { detail: "Approved the cost card" });
      else await moveWithin(q, a.event_id, "mapped", d.actor, { detail: `Declined the cost card: ${d.reason!.trim()}` });
    }
    return { status, decided_by: d.actor, already_decided: false, event_id: a.event_id };
  });
}

/** Ends an event before any paid work starts. */
export async function cancelEvent(db: Db, eventId: string, actor: string, reason: string) {
  return db.tx(async (q) => {
    const [t] = await q<{ parent_event_id: string | null }>("SELECT parent_event_id FROM events WHERE id = $1", [eventId]);
    if (t?.parent_event_id) { if (!reason.trim()) throw new RuleError("Say why before declining."); await endTopUpWithin(q, eventId, actor, reason.trim()); return (await q<EventRow>(`SELECT ${EVENT_COLS} FROM events WHERE id = $1`, [eventId]))[0]; }
    const event = await moveWithin(q, eventId, "declined", actor, { reason, detail: `Ended the event: ${reason.trim()}` });
    await q("UPDATE approvals SET status = 'declined', decided_by = $2, decided_at = now(), reason = $3 WHERE event_id = $1 AND status = 'pending'", [eventId, actor, reason.trim()]);
    await q("UPDATE cost_cards SET status = 'declined' WHERE event_id = $1 AND status = 'pending'", [eventId]);
    await q("UPDATE seat_requests SET status = 'declined', decided_by = $2, decided_at = now(), decline_reason = $3 WHERE event_id = $1 AND status = 'pending'", [eventId, actor, reason.trim()]);
    return event;
  });
}
