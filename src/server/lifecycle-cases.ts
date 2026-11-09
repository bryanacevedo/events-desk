/* The questions the after-delivery work opens for a person. They hold no spend and block nothing else. Each answer only writes rows: anything owed to a tool goes out from `pending_op`. */

import type { Db } from "./db.ts";
import { newId } from "./events.ts";
import { stopContacts } from "./enroll-ops.ts";
import type { Crm } from "./providers.ts";
import { queueOptOut } from "./crm-outbox.ts";

type Q = Db["query"];

export const LIFECYCLE_KINDS = ["owner_unreachable", "reply_doubtful", "referral", "successor", "bounce_rate", "suppression_confirm", "sending_capacity"] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];
interface Option { value: string; label: string; effect: string }

const CODES: Option[] = [
  { value: "interested", label: "Interested", effect: "Stays paused for a rep." },
  { value: "meeting_request", label: "Wants a meeting", effect: "Stays paused for a rep." },
  { value: "not_now", label: "Not now", effect: "Comes out of this event's sequences." },
  { value: "not_interested", label: "Not interested", effect: "Comes out of this event's sequences." },
  { value: "out_of_office", label: "Out of office", effect: "Resumes in 7 days, if the gate passes." },
  { value: "unsubscribe", label: "Unsubscribe", effect: "Never contacted again, from any event." },
  { value: "wrong_person", label: "Wrong person", effect: "That address is never used for them again." },
  { value: "departed", label: "Left the company", effect: "Comes out, and we look for who replaced them." },
];

export const LIFECYCLE_OPTIONS: Record<LifecycleKind, () => Option[]> = {
  owner_unreachable: () => [
    { value: "include", label: "Include", effect: "The team can sequence this account." },
    { value: "mine", label: "Leave it to the owner", effect: "Nobody there is sequenced for this event." },
  ],
  reply_doubtful: () => CODES,
  referral: () => [
    { value: "added", label: "I will reach them", effect: "Recorded. The named person is not added automatically." },
    { value: "dismiss", label: "Nothing to do", effect: "Closes this." },
  ],
  successor: () => [
    { value: "added", label: "I will find them", effect: "Recorded." },
    { value: "dismiss", label: "Nothing to do", effect: "Closes this." },
  ],
  bounce_rate: () => [{ value: "seen", label: "I have looked at it", effect: "Closes this. The sequence stays paused until someone restarts it in the tool." }],
  sending_capacity: () => [{ value: "seen", label: "I have looked at it", effect: "Closes this. The sequence stays paused until there are enough healthy senders and someone restarts it." }],
  suppression_confirm: () => [
    { value: "confirm", label: "Yes, stop contacting them", effect: "Made permanent, and sent to the CRM." },
    { value: "reject", label: "No, the model misread it", effect: "Removes the block. They stay paused until someone resumes them." },
  ],
};

export interface NewLifecycleCase { eventId: string; kind: LifecycleKind; companyId?: string | null; contactId?: string | null; summary: string; facts: unknown; suggested?: string | null; payload?: Record<string, unknown> }

export async function openLifecycleCase(q: Q, c: NewLifecycleCase) {
  const id = newId("case");
  await q(`INSERT INTO review_cases (id, event_id, kind, company_id, contact_id, blocking, summary, facts, payload, suggested, options) VALUES ($1, $2, $3, $4, $5, false, $6, $7::jsonb, $8::jsonb, $9, $10::jsonb)`,
    [id, c.eventId, c.kind, c.companyId ?? null, c.contactId ?? null, c.summary, JSON.stringify(c.facts), JSON.stringify(c.payload ?? {}), c.suggested ?? null, JSON.stringify(LIFECYCLE_OPTIONS[c.kind]())]);
  return id;
}

export interface LifecycleCaseRow { id: string; event_id: string; kind: string; company_id: string | null; contact_id: string | null; payload: Record<string, unknown> }

/** Runs inside the case's own transaction. */
export async function applyLifecycleAnswer(q: Q, c: LifecycleCaseRow, answer: string, actor: string, applyReply: (q: Q, inboundId: string, code: string, actor: string, crm?: Crm | null) => Promise<void>, crm?: Crm | null) {
  if (c.kind === "owner_unreachable") {
    const { applyDecision } = await import("./owners.ts");
    const [d] = await q<{ id: string; event_id: string; company_id: string; domain: string | null }>("SELECT d.id, d.event_id, d.company_id, co.primary_domain AS domain FROM owner_decisions d JOIN companies co ON co.id = d.company_id WHERE d.id = $1", [c.payload.decision_id]);
    if (d) await applyDecision(q, d, answer as "include" | "mine", "uploader", actor, new Date());
  } else if (c.kind === "reply_doubtful") {
    await applyReply(q, String(c.payload.inbound_id), answer, actor, crm);
  } else if (c.kind === "suppression_confirm") {
    const id = String(c.payload.suppression_id);
    if (answer === "confirm") {
      const [s] = await q<{ email: string | null; name: string | null; company: string | null; kind: string }>("UPDATE suppressions SET needs_confirmation = false WHERE id = $1 RETURNING email, name, company, kind", [id]);
      if (s?.kind === "opt_out" && c.contact_id) {
        await queueOptOut(q, crm, { email: s.email, name: s.name, company: s.company });
        await stopContacts(q, [c.contact_id], "remove", "unsubscribe", id);
        await q("UPDATE contacts SET drop_reason = 'opted_out', dropped_at = coalesce(dropped_at, now()) WHERE id = $1", [c.contact_id]);
      } else if (c.contact_id) await stopContacts(q, [c.contact_id], "remove", "wrong_person", id);
    } else {
      await q("DELETE FROM suppressions WHERE id = $1", [id]);
    }
  }
}
