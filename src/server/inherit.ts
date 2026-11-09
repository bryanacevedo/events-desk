/* What a top-up knows about a company the parent event already has (docs/NEW-REGISTRATIONS.md, section 4a).

   A company the parent settled is copied into the top-up, marked `inherited_from`, so nothing is paid for it twice and every event-scoped query reads a row of the top-up's own.
   The parent's row is never written here. The copy carries the parent's outcome:

     usable    a tier and a domain: new people there are ranked against that tier
     drop      a list match, a company a person rejected, or no usable tier: new people there stop with the reason the parent's people got, at no cost
     assess    skipped only because its attendees were Title 3, or tiered with no domain (a single-card parent): not copied, assessed for the first time */

import type { Db } from "./db.ts";
import { newId } from "./events.ts";
import { dropAtCompany } from "./work.ts";

export type Outcome = { kind: "usable" } | { kind: "drop"; reason: string } | { kind: "assess" };
export interface ParentCompany { id: string; key: string; name: string; primary_domain: string | null; tier: number | null; in_research: boolean; list_status: string | null; merged_names: { key?: string; name?: string }[] }

const LIST_DROP: Record<string, string> = { excluded: "excluded_company", existing_customer: "existing_customer" };
/** Reasons that say something about the company, as opposed to one person at it. */
const COMPANY_REASONS = new Set(["rejected_in_review", "company_not_found", "tiering_failed"]);

export function outcomeOf(co: Pick<ParentCompany, "tier" | "in_research" | "list_status" | "primary_domain">, reasons: string[]): Outcome {
  if (co.list_status) return { kind: "drop", reason: LIST_DROP[co.list_status] ?? "excluded_company" };
  if (co.tier !== null && co.in_research) return co.primary_domain ? { kind: "usable" } : { kind: "assess" };
  const carried = reasons.find((r) => COMPANY_REASONS.has(r));
  if (co.tier !== null) return { kind: "drop", reason: carried ?? "rejected_in_review" };
  return carried ? { kind: "drop", reason: carried } : { kind: "assess" };
}

export async function parentCompanies(q: Db["query"], parentId: string) {
  const companies = await q<ParentCompany>("SELECT id, key, name, primary_domain, tier, in_research, list_status, merged_names FROM companies WHERE event_id = $1", [parentId]);
  // Most common first, so the reason carried is the one most of the parent's people got.
  const rows = await q<{ company_id: string; reason: string }>(
    `SELECT company_id, drop_reason AS reason FROM (
       SELECT company_id, drop_reason, count(*) AS n FROM contacts WHERE event_id = $1 AND company_id IS NOT NULL AND drop_reason IS NOT NULL GROUP BY 1, 2
       UNION ALL
       SELECT company_id, drop_reason, count(*) FROM source_rows WHERE event_id = $1 AND company_id IS NOT NULL AND drop_reason IS NOT NULL AND kind = 'company_only' GROUP BY 1, 2
     ) x ORDER BY n DESC, reason`, [parentId]);
  const reasons = new Map<string, string[]>();
  for (const r of rows) reasons.set(r.company_id, [...(reasons.get(r.company_id) ?? []), r.reason]);
  const outcomes = new Map(companies.map((c) => [c.id, outcomeOf(c, reasons.get(c.id) ?? [])]));
  return { companies, outcomes };
}

/** Every column of a table but the named ones, so a column added later is carried without anyone remembering to. */
export async function columnsOf(q: Db["query"], table: string, skip: string[]) {
  const rows = await q<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position", [table]);
  return rows.map((r) => r.column_name).filter((c) => !skip.includes(c)).map((c) => `"${c}"`).join(", ");
}

/** Copies one parent company into the top-up as it stands. Salesforce is asked about it again at the top-up's own domain gate, unless it is already on a list. */
export async function copyCompany(q: Db["query"], topUpId: string, parentCompanyId: string, outcome: Outcome) {
  const [have] = await q<{ id: string }>("SELECT id FROM companies WHERE event_id = $1 AND inherited_from = $2", [topUpId, parentCompanyId]);
  if (have) return have.id;
  const id = newId("co");
  const cols = await columnsOf(q, "companies", ["id", "event_id", "parent_id", "inherited_from", "inherited_drop"]);
  await q(`INSERT INTO companies (id, event_id, inherited_from, inherited_drop, ${cols}) SELECT $1, $2, id, $3, ${cols} FROM companies WHERE id = $4`, [id, topUpId, outcome.kind === "drop" ? outcome.reason : null, parentCompanyId]);
  await q("UPDATE companies SET crm_checked_at = NULL WHERE id = $1 AND list_status IS NULL", [id]);
  return id;
}

/** A spelling the parent has not seen. It is carried on the copy and reaches the parent at the merge. */
export async function addSpelling(q: Db["query"], companyId: string, spelling: { key: string; name: string }) {
  const [co] = await q<{ key: string; merged_names: { key?: string }[] }>("SELECT key, merged_names FROM companies WHERE id = $1", [companyId]);
  if (co.key === spelling.key || co.merged_names.some((m) => m.key === spelling.key)) return;
  await q("UPDATE companies SET merged_names = merged_names || $2::jsonb WHERE id = $1", [companyId, JSON.stringify([{ ...spelling, rows: 0, parent_name: null, parent_domain: null }])]);
}

/** The company match is not finished at creation. Once identity has confirmed a domain, a top-up company at a parent's domain is replaced by an inherited copy, before anything further is paid. */
export async function adoptFromParent(q: Db["query"], topUpId: string) {
  const [ev] = await q<{ parent_event_id: string | null }>("SELECT parent_event_id FROM events WHERE id = $1", [topUpId]);
  if (!ev?.parent_event_id) return 0;
  const mine = await q<{ id: string; key: string; name: string; primary_domain: string }>("SELECT id, key, name, primary_domain FROM companies WHERE event_id = $1 AND inherited_from IS NULL AND primary_domain IS NOT NULL", [topUpId]);
  if (!mine.length) return 0;
  const { companies, outcomes } = await parentCompanies(q, ev.parent_event_id);
  const byDomain = new Map(companies.filter((c) => c.primary_domain).map((c) => [c.primary_domain!, c]));
  let adopted = 0;
  for (const row of mine) {
    const p = byDomain.get(row.primary_domain);
    if (!p) continue;
    const outcome = outcomes.get(p.id)!;
    if (outcome.kind === "assess") continue;
    // The copy takes the parent's key, and this row may hold it.
    if (row.key === p.key) await q("UPDATE companies SET key = $2 WHERE id = $1", [row.id, `${row.key} (replaced ${row.id})`]);
    const copy = await copyCompany(q, topUpId, p.id, outcome);
    await q("UPDATE source_rows SET listed_name = coalesce(listed_name, $3), company_id = $2 WHERE company_id = $1", [row.id, copy, row.name]);
    await q("UPDATE contacts SET company_id = $2 WHERE company_id = $1", [row.id, copy]);
    await q("UPDATE review_cases SET company_id = $2 WHERE company_id = $1", [row.id, copy]);
    await q("UPDATE companies SET parent_id = NULL WHERE parent_id = $1", [row.id]);
    await q("DELETE FROM companies WHERE id = $1", [row.id]);
    await addSpelling(q, copy, { key: row.key, name: row.name });
    if (outcome.kind === "drop") await dropAtCompany(q, topUpId, copy, outcome.reason);
    adopted++;
  }
  return adopted;
}
