/* Review cases: a data conflict only a person can settle, with a suggested answer and
   the allowed answers (docs/TIERING-AND-ENRICHMENT.md, "Review cases"). Answers are
   applied by one function per kind.

   Blocking cases hold spend. While one is open, no Outreach card can be quoted, so a
   late answer can never exceed an approved card. After delivery, the other kinds need a
   person but block nothing. Each decision is stored with who made it and why, as labeled data. */

import { getSettings } from "./approvals.ts";
import { listDomains } from "./research.ts";
import type { Db } from "./db.ts";
import { dropAtCompany } from "./work.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { adoptFromParent } from "./inherit.ts";
import { mergeAfterAnswer } from "./identity.ts";
import { isFreeWebmail, isPlaceholderDomain } from "../shared/layer0.ts";
import { applyLifecycleAnswer, LIFECYCLE_KINDS, type LifecycleKind } from "./lifecycle-cases.ts";
import { applyReplyAnswer } from "./replies.ts";
import type { Crm } from "./providers.ts";

export const BLOCKING_KINDS = ["ambiguous_identity", "company_not_found", "unknown_tier", "second_look_disagreement", "fuzzy_list_match", "crm_customer_mismatch", "subsidiary_inheritance"] as const;
export const LATER_KINDS = ["attendee_vendor_mismatch", "name_email_mismatch", "free_webmail", "same_person_two_companies", "late_stage_deal", "model_flag"] as const;
export type CaseKind = (typeof BLOCKING_KINDS)[number] | (typeof LATER_KINDS)[number];
const isLifecycle = (k: string): k is LifecycleKind => (LIFECYCLE_KINDS as readonly string[]).includes(k);
export const isBlocking = (k: string) => (BLOCKING_KINDS as readonly string[]).includes(k);

export interface CaseOption { value: string; label: string; effect: string }
export interface NewCase {
  eventId: string; kind: CaseKind; companyId?: string | null; contactId?: string | null;
  summary: string; facts: unknown; suggested?: string | null; payload?: Record<string, unknown>;
  /** Only for kinds whose answers depend on the data, such as picking one of two domains. */
  options?: CaseOption[];
}

const tierOptions = (): CaseOption[] => [
  { value: "tier_1", label: "Tier 1", effect: "Sets the company to tier 1." },
  { value: "tier_2", label: "Tier 2", effect: "Sets the company to tier 2." },
  { value: "tier_3", label: "Tier 3", effect: "Sets the company to tier 3. Nobody there is looked up." },
  { value: "drop", label: "Drop the company", effect: "Nobody at this company is looked up or paid for." },
];
const STATIC: Record<CaseKind, () => CaseOption[]> = {
  ambiguous_identity: () => [{ value: "drop", label: "Neither, drop it", effect: "Nobody at this company is looked up or paid for." }],
  company_not_found: () => [
    { value: "supply_domain", label: "I know the website", effect: "Uses the website you give as the company's identity and finishes its research." },
    { value: "drop", label: "Drop the company", effect: "Nobody at this company is looked up or paid for." },
  ],
  unknown_tier: tierOptions,
  second_look_disagreement: () => [{ value: "keep", label: "Keep the first tier", effect: "The tier stays as the first pass set it." }, ...tierOptions()],
  fuzzy_list_match: () => [
    { value: "same_company", label: "Same company", effect: "Treated as the listed company: dropped, and nothing is spent on it." },
    { value: "different_company", label: "A different company", effect: "Stays in the research and is tiered like any other." },
  ],
  crm_customer_mismatch: () => [
    { value: "is_customer", label: "A customer", effect: "Dropped as an existing customer. Nothing is spent on it." },
    { value: "not_customer", label: "Not a customer", effect: "Stays in the research." },
  ],
  subsidiary_inheritance: () => [
    { value: "inherit", label: "Same status as the parent", effect: "Takes the parent's customer or exclusion status and is dropped." },
    { value: "independent", label: "Treat it on its own", effect: "Stays in the research." },
  ],
  attendee_vendor_mismatch: () => laterOptions(), name_email_mismatch: () => laterOptions(), free_webmail: () => laterOptions(),
  same_person_two_companies: () => laterOptions(), late_stage_deal: () => [
    { value: "keep", label: "Keep, tell the owner", effect: "The people stay on the outreach list and the account owner is the one to talk to first." },
    { value: "dismiss", label: "Dismiss", effect: "Nothing changes; the case is closed." },
  ], model_flag: () => laterOptions(),
};
const laterOptions = (): CaseOption[] => [
  { value: "keep", label: "Keep", effect: "The person stays on the outreach list." },
  { value: "drop", label: "Drop", effect: "The person is dropped from the outreach list as rejected in review." },
  { value: "dismiss", label: "Dismiss", effect: "Nothing changes; the case is closed." },
];

/** When a person skips what remains, the company is dropped with this reason: no spend for those companies. */
const SKIP_REASON: Partial<Record<CaseKind, string>> = {
  ambiguous_identity: "company_not_found", company_not_found: "company_not_found", unknown_tier: "tiering_failed", second_look_disagreement: "rejected_in_review",
  fuzzy_list_match: "rejected_in_review", crm_customer_mismatch: "rejected_in_review", subsidiary_inheritance: "rejected_in_review",
};

export async function openCase(q: Db["query"], c: NewCase) {
  const options = c.options ?? STATIC[c.kind]();
  // One open case per company and kind: running a step twice never doubles the questions.
  if (c.companyId || c.contactId) {
    const dup = await q("SELECT 1 FROM review_cases WHERE event_id = $1 AND company_id IS NOT DISTINCT FROM $2 AND contact_id IS NOT DISTINCT FROM $3 AND kind = $4 AND status = 'open'", [c.eventId, c.companyId ?? null, c.contactId ?? null, c.kind]);
    if (dup.length) return null;
  }
  const id = newId("case");
  await q(
    `INSERT INTO review_cases (id, event_id, kind, company_id, contact_id, blocking, summary, facts, payload, suggested, options)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb)`,
    [id, c.eventId, c.kind, c.companyId ?? null, c.contactId ?? null, isBlocking(c.kind), c.summary, JSON.stringify(c.facts), JSON.stringify(c.payload ?? {}), c.suggested ?? null, JSON.stringify(options)]);
  return id;
}

interface CaseRow {
  id: string; event_id: string; kind: CaseKind | LifecycleKind; company_id: string | null; contact_id: string | null; blocking: boolean; summary: string; facts: unknown;
  payload: Record<string, unknown>; suggested: string | null; options: CaseOption[]; status: string; decision: string | null; decision_data: unknown; decided_by: string | null;
}
const COLS = "id, event_id, kind, company_id, contact_id, blocking, summary, facts, payload, suggested, options, status, decision, decision_data, decided_by";

/** What the Cases screen reads: `decision` is null while a case is open. */
export async function listCases(db: Db, eventId: string) {
  const rows = await db.query<CaseRow & { company: string | null; person: { id: string; full_name: string | null; title: string | null; email: string | null; priority: string | null; source: string; dropped: boolean } | null; created_at: string }>(
    `SELECT ${COLS.split(", ").map((c) => `r.${c}`).join(", ")}, co.name AS company, r.created_at::text AS created_at,
            CASE WHEN k.id IS NULL THEN NULL ELSE jsonb_build_object('id', k.id, 'full_name', k.full_name, 'title', k.title, 'email', k.email, 'priority', k.priority, 'source', k.source, 'dropped', k.dropped_at IS NOT NULL) END AS person
     FROM review_cases r LEFT JOIN companies co ON co.id = r.company_id LEFT JOIN contacts k ON k.id = r.contact_id
     WHERE r.event_id = $1 ORDER BY r.status <> 'open', r.created_at, r.id`, [eventId]);
  return rows.map((r) => ({
    id: r.id, kind: r.kind, blocking: r.blocking, summary: r.summary, facts: r.facts, suggested: r.suggested, options: r.options, status: r.status,
    decision: r.status === "open" ? null : r.decision, decided_by: r.decided_by, company: r.company, company_id: r.company_id, contact_id: r.contact_id, person: r.person, created_at: r.created_at,
  }));
}

export async function openBlockingCount(q: Db["query"], eventId: string) {
  const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM review_cases WHERE event_id = $1 AND blocking AND status = 'open'", [eventId]);
  return n;
}

/** A company that is staying and has no tier yet goes back on the queue. The Research card already covers it. */
async function settleCompany(q: Db["query"], eventId: string, companyId: string) {
  const [co] = await q<{ tier: number | null; in_research: boolean }>("SELECT tier, in_research FROM companies WHERE id = $1", [companyId]);
  if (!co || co.tier !== null || !co.in_research) return;
  // While identity is still running, finishing it queues every settled company at once, merged.
  const [ev] = await q<{ phase: string | null }>("SELECT phase FROM events WHERE id = $1", [eventId]);
  if (ev?.phase === "identity") return;
  const live = await q("SELECT 1 FROM contacts WHERE company_id = $1 AND dropped_at IS NULL UNION ALL SELECT 1 FROM source_rows WHERE company_id = $1 AND kind = 'company_only' AND dropped_at IS NULL LIMIT 1", [companyId]);
  if (!live.length) return;
  const queued = await q("SELECT 1 FROM jobs WHERE event_id = $1 AND kind = 'company_tier' AND payload->>'company_id' = $2 AND status IN ('queued', 'running')", [eventId, companyId]);
  if (queued.length) return;
  await q("INSERT INTO jobs (id, event_id, kind, payload) VALUES ($1, $2, 'company_tier', $3::jsonb)", [newId("job"), eventId, JSON.stringify({ company_id: companyId })]);
}

async function dropCompany(q: Db["query"], eventId: string, companyId: string, reason: string, listStatus?: string) {
  await q("UPDATE companies SET in_research = false, list_status = coalesce($2, list_status) WHERE id = $1", [companyId, listStatus ?? null]);
  await dropAtCompany(q, eventId, companyId, reason);
}
const LIST_REASON: Record<string, string> = { excluded: "excluded_company", existing_customer: "existing_customer" };

function validDomain(raw: unknown): string {
  const d = String(raw ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) || isFreeWebmail(d) || isPlaceholderDomain(d)) throw new RuleError("Give the company's own website, such as acme.example.");
  return d;
}
async function resolveTo(q: Db["query"], c: CaseRow, domain: string, actor: string) {
  const evidence = JSON.stringify([{ source: "human", value: domain, by: actor }]);
  await q("UPDATE companies SET primary_domain = $2, identity_state = 'resolved', identity_via = 'human', identity_evidence = identity_evidence || $3::jsonb WHERE id = $1", [c.company_id, domain, evidence]);
  // On a top-up, a domain the parent already has makes this the parent's company: nothing more is paid for it. The row goes, and the steps below find nothing to do.
  await adoptFromParent(q, c.event_id);
  // A domain a person gives can be one the event already has: the two companies become one.
  const keep = await mergeAfterAnswer(q, c.event_id, c.company_id!);
  // The list check by domain has already run for everything a vendor resolved. A website a person gives meets the same lists.
  const s = await getSettings(q, c.event_id);
  const hit = listDomains(s.excluded_companies).includes(domain) ? "excluded" : listDomains(s.existing_customers).includes(domain) ? "existing_customer" : null;
  if (hit) return dropCompany(q, c.event_id, keep, LIST_REASON[hit], hit);
  await settleCompany(q, c.event_id, keep);
}

type Apply = (q: Db["query"], c: CaseRow, answer: string, data: Record<string, unknown>, actor: string) => Promise<void>;
const listDrop: Apply = async (q, c, answer) => {
  const status = String(c.payload.status ?? "");
  if (answer === "same_company" || answer === "is_customer" || answer === "inherit") {
    const st = answer === "is_customer" ? "existing_customer" : status;
    if (!LIST_REASON[st]) throw new RuleError("This case does not say which list it matched.");
    await dropCompany(q, c.event_id, c.company_id!, LIST_REASON[st], st);
  } else await settleCompany(q, c.event_id, c.company_id!);
};
const setTier: Apply = async (q, c, answer) => {
  if (answer === "keep") return;
  if (answer === "drop") return dropCompany(q, c.event_id, c.company_id!, "rejected_in_review");
  const tier = Number(answer.slice(5));
  await q("UPDATE companies SET tier = $2, tier_reason = 'human_review', tier_via = 'human', tier_icp_version = (SELECT icp_version FROM events WHERE id = $3) WHERE id = $1", [c.company_id, tier, c.event_id]);
  // A person's tier is the answer for this company under this ICP version, in this event and the next.
  await q(
    `INSERT INTO tier_cache (domain, icp_version, tier, reason) SELECT co.primary_domain, e.icp_version::text, $2, 'human_review' FROM companies co JOIN events e ON e.id = co.event_id
     WHERE co.id = $1 AND co.primary_domain IS NOT NULL AND e.icp_version IS NOT NULL
     ON CONFLICT (domain, icp_version) DO UPDATE SET tier = EXCLUDED.tier, reason = EXCLUDED.reason, fact = NULL, segment = NULL, company_type = NULL, created_at = now()`, [c.company_id, tier]);
};
const laterApply: Apply = async (q, c, answer) => {
  if (answer === "drop" && c.contact_id) await q("UPDATE contacts SET drop_reason = 'rejected_in_review', dropped_at = now() WHERE id = $1 AND dropped_at IS NULL", [c.contact_id]);
  // A person kept after a model flag is not asked about again.
  if (answer === "keep" && c.kind === "model_flag" && c.contact_id) await q("DELETE FROM review_flags WHERE contact_id = $1", [c.contact_id]);
};

/** One function per kind. */
const APPLY: Record<CaseKind, Apply> = {
  ambiguous_identity: async (q, c, answer, _d, actor) => {
    if (answer === "drop") return dropCompany(q, c.event_id, c.company_id!, "rejected_in_review");
    await resolveTo(q, c, validDomain(answer.slice(5)), actor);
  },
  company_not_found: async (q, c, answer, data, actor) => {
    if (answer === "drop") return dropCompany(q, c.event_id, c.company_id!, "company_not_found");
    await resolveTo(q, c, validDomain(data.domain), actor);
  },
  unknown_tier: setTier,
  second_look_disagreement: setTier,
  fuzzy_list_match: listDrop,
  crm_customer_mismatch: listDrop,
  subsidiary_inheritance: listDrop,
  attendee_vendor_mismatch: laterApply, name_email_mismatch: laterApply, free_webmail: laterApply,
  same_person_two_companies: laterApply, late_stage_deal: laterApply, model_flag: laterApply,
};

export interface AnswerResult { id: string; status: "answered" | "skipped"; decision: string; already_decided: boolean }

/** Answers one case. A second answer changes nothing and says what the first was. */
export async function answerCase(db: Db, eventId: string, caseId: string, actor: string, decision: string, data: Record<string, unknown> = {}, crm?: Crm | null): Promise<AnswerResult> {
  return db.tx(async (q) => {
    const [c] = await q<CaseRow>(`SELECT ${COLS} FROM review_cases WHERE id = $1 AND event_id = $2 FOR UPDATE`, [caseId, eventId]);
    if (!c) throw new RuleError("That case does not exist on this event.");
    if (c.status !== "open") return { id: c.id, status: c.status as AnswerResult["status"], decision: c.decision ?? c.status, already_decided: true };
    const [e] = await q<{ stage: string; ended_at: string | null }>("SELECT stage, ended_at FROM events WHERE id = $1", [eventId]);
    if (e.ended_at) throw new RuleError("These new registrations were stopped.");
    if (c.blocking && !["researching", "ready_for_review"].includes(e.stage)) throw new RuleError("Spending has already started, so this case can no longer change what is paid for.");
    if (!c.options.some((o) => o.value === decision) && !(c.kind === "ambiguous_identity" && decision.startsWith("pick:"))) throw new RuleError(`"${decision}" is not an answer to this case.`);
    if (isLifecycle(c.kind)) await applyLifecycleAnswer(q, c, decision, actor, applyReplyAnswer, crm);
    else await APPLY[c.kind](q, c, decision, data, actor);
    await q("UPDATE review_cases SET status = 'answered', decision = $2, decision_data = $3::jsonb, decided_by = $4, decided_at = now() WHERE id = $1", [c.id, decision, JSON.stringify(data), actor]);
    await logActivity(q, eventId, actor, "case", `Settled: ${c.summary} (${decision})`);
    return { id: c.id, status: "answered", decision, already_decided: false };
  });
}

/** Skips every open blocking case. Those companies get no spend. Returns how many were skipped. */
export async function skipOpenCases(db: Db, eventId: string, actor: string) {
  return db.tx(async (q) => {
    const [e] = await q<{ stage: string }>("SELECT stage FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (!e) throw new RuleError("That event does not exist.");
    if (!["researching", "ready_for_review"].includes(e.stage)) throw new RuleError("Spending has already started, so there is nothing left to skip.");
    const open = await q<CaseRow>(`SELECT ${COLS} FROM review_cases WHERE event_id = $1 AND blocking AND status = 'open' FOR UPDATE`, [eventId]);
    for (const c of open) {
      const reason = isLifecycle(c.kind) ? undefined : SKIP_REASON[c.kind];
      if (reason && c.company_id) await dropCompany(q, eventId, c.company_id, reason);
      await q("UPDATE review_cases SET status = 'skipped', decision = 'skipped', decided_by = $2, decided_at = now() WHERE id = $1", [c.id, actor]);
    }
    if (open.length) await logActivity(q, eventId, actor, "case", `Skipped ${open.length} open case${open.length === 1 ? "" : "s"}; no spend for those companies`);
    return open.length;
  });
}
