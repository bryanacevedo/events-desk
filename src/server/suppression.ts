/* Opting someone out (docs/TIERING-AND-ENRICHMENT.md, "Vendors"). An opt-out spans events: the person is never looked up or contacted again, by address or by name at a
   company. Recording one also takes the person off every outreach list they are still on, with the drop reason `opted_out` (not borrowed from a review decision),
   and the email loop stops anyone who matches before a single credit is spent. */

import type { Db } from "./db.ts";
import { addSuppression } from "./caches.ts";
import { queueOptOut } from "./crm-outbox.ts";
import { stopContacts } from "./enroll-ops.ts";
import { logActivity, RuleError } from "./events.ts";
import type { Crm } from "./providers.ts";
import { looksLikeEmail, nameKey } from "../shared/email.ts";
import { companyKey } from "../shared/ingest.ts";

export interface OptOutInput { email?: string; name?: string; company?: string; reason?: string }

export async function recordOptOut(db: Db, actor: string, b: OptOutInput, crm?: Crm | null) {
  const email = (b.email ?? "").trim().toLowerCase();
  const name = (b.name ?? "").trim(), company = (b.company ?? "").trim();
  if (email && !looksLikeEmail(email)) throw new RuleError("That is not an email address.");
  if (!email && !(name && company)) throw new RuleError("Give an email address, or a name and a company.");
  const nk = name ? nameKey(name) : null, ck = company ? companyKey(company) : null;
  // Take them off every list they are still on.
  const rows = await db.query<{ id: string; event_id: string; full_name: string | null; email: string | null; key: string; dropped_at: string | null }>(
    `SELECT k.id, k.event_id, k.full_name, k.email, co.key, k.dropped_at FROM contacts k JOIN companies co ON co.id = k.company_id
     WHERE ((k.email IS NOT NULL AND lower(k.email) = $1) OR ($2::text IS NOT NULL AND co.key = $2))`, [email || null, ck]);
  // Either one identifies the person: the same name at the same company with another address, or no address, is still them.
  const hits = rows.filter((r) => (email && r.email?.toLowerCase() === email) || (nk && ck && r.key === ck && r.full_name && nameKey(r.full_name) === nk));
  await db.tx(async (q) => {
    await addSuppression({ query: q }, { kind: "opt_out", email: email || null, name_key: nk && ck ? nk : null, company_key: nk && ck ? ck : null, reason: (b.reason ?? "").trim().slice(0, 300), created_by: actor, name: name || null, company: company || null });
    await queueOptOut(q, crm, { email: email || null, name: name || null, company: company || null });
    // Out of every sequence, at every event, whatever else is true of them. The tool is told from the row.
    await stopContacts(q, hits.map((h) => h.id), "remove", "opt_out");
    for (const h of hits) {
      // Someone already set aside for another reason is relabeled, so they come off the Other attendees tab too.
      await q("UPDATE contacts SET drop_reason = 'opted_out', dropped_at = coalesce(dropped_at, now()) WHERE id = $1", [h.id]);
      await logActivity(q, h.event_id, actor, "opt_out", `${h.full_name ?? "A person"} opted out and was taken off the outreach list`);
    }
  });
  return { recorded: true, removed: hits.filter((h) => !h.dropped_at).length, events: [...new Set(hits.map((h) => h.event_id))] };
}

/** Every opt-out, newest first. `name` and `company` are as a person typed them; rows recorded before they were kept fall back to the matching keys. */
export async function listOptOuts(db: Db) {
  return db.query<{ id: string; email: string | null; name: string | null; company: string | null; reason: string; created_by: string | null; created_at: string }>(
    "SELECT id, email, coalesce(name, name_key) AS name, coalesce(company, company_key) AS company, reason, created_by, created_at::text AS created_at FROM suppressions WHERE kind = 'opt_out' ORDER BY created_at DESC LIMIT 500");
}
