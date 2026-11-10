/* The review cases that need a person but hold nothing (docs/TIERING-AND-ENRICHMENT.md, "Review cases", after delivery). They are opened once, when the outreach
   list is delivered, and answered from the Review tab or the Cases screen. Answering one never changes what was paid for.

     attendee_vendor_mismatch   a registered attendee whose address, or whose vendor-found address, sits at another company than the one the vendor puts them at
     name_email_mismatch        a verified address whose local part does not fit the person's name: a mailbox exists, but it may not be theirs
     free_webmail               the attendee registered with a personal address; we reached them at a work address
     same_person_two_companies  one name on the outreach list at two companies
     late_stage_deal            a company with a late-stage deal and an owner: the owner should know before anyone is contacted
     model_flag                 the model doubted the title, the tenure or the name

   Every producer is code; a model only supplies the flags that model_flag turns into a case. Opening is idempotent: a case already open for the same person and kind is not opened twice. */

import { DEFAULT_LATE_STAGES } from "../shared/policy.ts";
import type { Db } from "./db.ts";
import { getSettings } from "./approvals.ts";
import { openCase, type CaseOption } from "./cases.ts";
import type { Loop } from "./email.ts";
import { FLAG_WORDS } from "../shared/tiers.ts";
import { localFitsName, nameKey } from "../shared/email.ts";

export { DEFAULT_LATE_STAGES };
/** A fixed rule, never a model: a doubt about the person says Drop; a doubt about the address says Keep and try another channel. */
export const suggestForFlags = (flags: string[]) => (flags.some((f) => ["title_company_mismatch", "likely_left_company", "name_looks_wrong"].includes(f)) ? "drop" : "keep");

export async function openLaterCases(db: Db, eventId: string) {
  const live = await db.query<{ id: string; full_name: string | null; title: string | null; email: string | null; source: string; company_id: string; company: string; domain: string | null; email_source: string | null; email_loop: Loop; priority: string }>(
    `SELECT k.id, k.full_name, k.title, k.email, k.source, k.company_id, co.name AS company, co.primary_domain AS domain, k.email_source, k.email_loop, k.priority
     FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.event_id = $1 AND k.dropped_at IS NULL AND k.priority IS NOT NULL ORDER BY co.name, k.full_name`, [eventId]);
  let opened = 0;
  const open = async (c: Parameters<typeof openCase>[1]) => { if (await db.tx((q) => openCase(q, c))) opened++; };

  for (const p of live) {
    const who = p.full_name ?? "A person";
    // A mailbox that exists is not proof it is theirs. The attendee's own address is trusted more than one a vendor found.
    if (p.email && p.full_name && !localFitsName(p.email, p.full_name)) {
      const own = p.email_source === "uploaded";
      await open({ eventId, kind: "name_email_mismatch", companyId: p.company_id, contactId: p.id,
        summary: `${who}'s address ${p.email} does not look like their name.`, facts: [{ person: who, company: p.company, address: p.email, address_from: own ? "the attendee list" : p.email_source ?? "a vendor" }],
        suggested: own ? "keep" : "drop" });
    }
    const mismatch = p.email_loop.mismatch ?? [];
    const other = mismatch.filter((m) => m.kind === "other_domain");
    if (p.source === "attendee" && other.length) {
      const m = other[0];
      await open({ eventId, kind: "attendee_vendor_mismatch", companyId: p.company_id, contactId: p.id,
        summary: `${who} registered at ${p.company}, but ${m.source === "uploaded" ? "their own address" : "an address a vendor found"} is at another company (${m.email.split("@")[1]}).`,
        facts: [{ person: who, registered_company: p.company, registered_website: p.domain ?? "not known" }, { other_address: m.email, from: m.source === "uploaded" ? "the attendee list" : m.source }], suggested: "keep" });
    }
    const hook = mismatch.find((m) => m.kind === "webmail");
    if (p.source === "attendee" && hook) {
      await open({ eventId, kind: "free_webmail", companyId: p.company_id, contactId: p.id,
        summary: `${who} registered with a personal address (${hook.email}); we reached them at a work address.`,
        facts: [{ person: who, company: p.company, registered_with: hook.email, reached_at: p.email ?? "no address" }], suggested: "dismiss" });
    }
  }

  // The same name at two companies.
  const byName = new Map<string, typeof live>();
  for (const p of live) if (p.full_name) { const k = nameKey(p.full_name); byName.set(k, [...(byName.get(k) ?? []), p]); }
  for (const group of byName.values()) {
    const companies = new Set(group.map((g) => g.company_id));
    if (companies.size < 2) continue;
    const [first, ...rest] = group;
    for (const p of rest) {
      if (p.company_id === first.company_id) continue;
      await open({ eventId, kind: "same_person_two_companies", companyId: p.company_id, contactId: p.id,
        summary: `${p.full_name} is on the outreach list at ${first.company} and at ${p.company}.`,
        facts: [{ at: first.company, title: first.title ?? "no title", email: first.email ?? "none" }, { at: p.company, title: p.title ?? "no title", email: p.email ?? "none" }], suggested: "keep" });
    }
  }

  // A late-stage deal with an owner: the owner should hear before outreach starts. One case per company.
  const deals = await db.query<{ id: string; name: string; deal_name: string; deal_stage: string; account_owner: string; n: number }>(
    `SELECT co.id, co.name, co.deal_name, co.deal_stage, co.account_owner, count(k.id)::int AS n FROM companies co JOIN contacts k ON k.company_id = co.id AND k.dropped_at IS NULL AND k.priority IS NOT NULL
     WHERE co.event_id = $1 AND co.inherited_from IS NULL AND co.deal_name IS NOT NULL AND co.account_owner IS NOT NULL AND lower(co.deal_stage) = ANY($2::text[]) GROUP BY co.id`, [eventId, ((await getSettings(db.query, eventId)) as unknown as { late_stages?: string[] }).late_stages ?? DEFAULT_LATE_STAGES]);
  for (const d of deals) {
    await open({ eventId, kind: "late_stage_deal", companyId: d.id,
      summary: `${d.name} has a ${d.deal_stage.toLowerCase()} deal owned by ${d.account_owner}. ${d.n} ${d.n === 1 ? "person is" : "people are"} on the outreach list there.`,
      facts: [{ company: d.name, deal: d.deal_name, stage: d.deal_stage, owner: d.account_owner, people_on_the_outreach_list: d.n }], suggested: "keep" });
  }

  // The model's doubts about a person.
  const flags = await db.query<{ contact_id: string; flags: string[]; company_id: string; full_name: string | null; company: string }>(
    `SELECT f.contact_id, array_agg(f.flag ORDER BY f.flag) AS flags, k.company_id, k.full_name, co.name AS company FROM review_flags f JOIN contacts k ON k.id = f.contact_id JOIN companies co ON co.id = k.company_id
     WHERE k.event_id = $1 AND k.dropped_at IS NULL AND f.source = 'llm' GROUP BY f.contact_id, k.company_id, k.full_name, co.name`, [eventId]);
  for (const f of flags) {
    await open({ eventId, kind: "model_flag", companyId: f.company_id, contactId: f.contact_id,
      summary: `${f.full_name ?? "A person"} at ${f.company}: ${f.flags.map((x) => (FLAG_WORDS[x] ?? x).toLowerCase()).join("; ")}.`,
      facts: [{ person: f.full_name ?? "unknown", company: f.company, flagged: f.flags.map((x) => FLAG_WORDS[x] ?? x) }], suggested: suggestForFlags(f.flags) });
  }
  return opened;
}

export type { CaseOption };
