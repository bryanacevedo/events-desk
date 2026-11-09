/* Caches that outlive one event (migration 0010). Reads honor the ageing rules from
   settings.limits; a human correction overwrites and is never aged out. The pipeline
   steps that fill them are later build-order steps: today these are the tables and the
   rules for reading them, tested on their own. */

import type { Db } from "./db.ts";
import type { Limits } from "../shared/cost.ts";

export const DEFAULT_AGES: Pick<Limits, "firmographics_cache_days" | "verification_reuse_days"> = { firmographics_cache_days: 90, verification_reuse_days: 30 };

type Age = Pick<Limits, "firmographics_cache_days" | "verification_reuse_days">;
export const MISS_DAYS = 30;

/** Firmographics for a domain, or null when absent or older than the limit. A corrected row never ages out. */
export async function getFirmographics(db: Db, domain: string, ages: Age = DEFAULT_AGES) {
  const [r] = await db.query<{ domain: string; name: string | null; firmographics: Record<string, unknown>; source: string; corrected: boolean; fetched_at: string; event_id: string | null }>(
    "SELECT domain, name, firmographics, source, corrected, fetched_at::text AS fetched_at, event_id FROM company_cache WHERE domain = $1 AND (corrected OR fetched_at > now() - ($2::text || ' days')::interval)", [domain.toLowerCase(), String(ages.firmographics_cache_days)]);
  return r ?? null;
}

/** A vendor result. It never replaces a human correction. */
export async function putFirmographics(db: Db, domain: string, name: string | null, firmographics: object, source: string, eventId: string | null = null) {
  await db.query(
    `INSERT INTO company_cache (domain, name, firmographics, source, event_id) VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (domain) DO UPDATE SET name = EXCLUDED.name, firmographics = EXCLUDED.firmographics, source = EXCLUDED.source, event_id = EXCLUDED.event_id, fetched_at = now()
     WHERE NOT company_cache.corrected`, [domain.toLowerCase(), name, JSON.stringify(firmographics), source, eventId]);
}

/** A person's correction overwrites whatever is cached, whatever its age. */
export async function correctFirmographics(db: Db, domain: string, name: string | null, firmographics: object, actor: string) {
  await db.query(
    `INSERT INTO company_cache (domain, name, firmographics, source, corrected) VALUES ($1, $2, $3::jsonb, $4, true)
     ON CONFLICT (domain) DO UPDATE SET name = EXCLUDED.name, firmographics = EXCLUDED.firmographics, source = EXCLUDED.source, corrected = true, fetched_at = now()`,
    [domain.toLowerCase(), name, JSON.stringify(firmographics), `human:${actor}`]);
  // A tier made on the old values would be reused by the next event. A correction drops it.
  await db.query("DELETE FROM tier_cache WHERE domain = $1", [domain.toLowerCase()]);
}

export async function mapNameToDomain(db: Db, nameKey: string, domain: string, source: string, corrected = false) {
  await db.query(
    `INSERT INTO name_domain_map (name_key, domain, source, corrected) VALUES ($1, $2, $3, $4)
     ON CONFLICT (name_key, domain) DO UPDATE SET source = EXCLUDED.source, corrected = name_domain_map.corrected OR EXCLUDED.corrected, created_at = now()`, [nameKey, domain.toLowerCase(), source, corrected]);
}
/** Domains a name has resolved to, fresh ones and corrected ones. More than one means the name is ambiguous. */
export async function domainsForName(db: Db, nameKey: string, ages: Age = DEFAULT_AGES) {
  const rows = await db.query<{ domain: string }>(
    "SELECT domain FROM name_domain_map WHERE name_key = $1 AND (corrected OR created_at > now() - ($2::text || ' days')::interval) ORDER BY corrected DESC, domain", [nameKey, String(ages.firmographics_cache_days)]);
  return rows.map((r) => r.domain);
}

/** A tier result is keyed by domain and ICP version, so a new ICP never reads an old tier. */
export async function putTier(db: Db, domain: string, icpVersion: string, t: { tier: number | null; segment?: string; company_type?: string; reason?: string; fact?: string }, eventId: string | null = null) {
  await db.query(
    `INSERT INTO tier_cache (domain, icp_version, tier, segment, company_type, reason, fact, event_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (domain, icp_version) DO UPDATE SET tier = EXCLUDED.tier, segment = EXCLUDED.segment, company_type = EXCLUDED.company_type, reason = EXCLUDED.reason, fact = EXCLUDED.fact, event_id = EXCLUDED.event_id, created_at = now()`,
    [domain.toLowerCase(), icpVersion, t.tier, t.segment ?? null, t.company_type ?? null, t.reason ?? null, t.fact ?? null, eventId]);
}
export async function getTier(db: Db, domain: string, icpVersion: string) {
  const [r] = await db.query<{ tier: number | null; segment: string | null; company_type: string | null; reason: string | null; fact: string | null; created_at: string; event_id: string | null }>(
    "SELECT tier, segment, company_type, reason, fact, created_at::text AS created_at, event_id FROM tier_cache WHERE domain = $1 AND icp_version = $2", [domain.toLowerCase(), icpVersion]);
  return r ?? null;
}

/** Positive and negative results are both cached by address. Older than the reuse window means verify again. */
export async function putVerification(db: Db, email: string, verdict: string, verifier: string, eventId: string | null = null) {
  await db.query(
    `INSERT INTO verification_cache (email, verdict, verifier, event_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET verdict = EXCLUDED.verdict, verifier = EXCLUDED.verifier, event_id = EXCLUDED.event_id, checked_at = now()`, [email.toLowerCase(), verdict, verifier, eventId]);
}
/** `bouncedAt`: when Salesforce says mail to this address last bounced. A stored check no newer than that is not used. */
export async function getVerification(db: Db, email: string, ages: Age = DEFAULT_AGES, bouncedAt: string | null = null) {
  const [r] = await db.query<{ verdict: string; verifier: string; checked_at: string; event_id: string | null }>(
    "SELECT verdict, verifier, checked_at::text AS checked_at, event_id FROM verification_cache WHERE email = $1 AND checked_at > now() - ($2::text || ' days')::interval AND ($3::timestamptz IS NULL OR checked_at > $3::timestamptz)", [email.toLowerCase(), String(ages.verification_reuse_days), bouncedAt]);
  return r ?? null;
}

export async function putDomainState(db: Db, domain: string, s: { catch_all: boolean | null; mail_server: boolean | null }, eventId: string | null = null) {
  await db.query(
    `INSERT INTO domain_state (domain, catch_all, mail_server, event_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (domain) DO UPDATE SET catch_all = EXCLUDED.catch_all, mail_server = EXCLUDED.mail_server, event_id = EXCLUDED.event_id, probed_at = now()`, [domain.toLowerCase(), s.catch_all, s.mail_server, eventId]);
}
export async function getDomainState(db: Db, domain: string) {
  const [r] = await db.query<{ catch_all: boolean | null; mail_server: boolean | null }>("SELECT catch_all, mail_server FROM domain_state WHERE domain = $1", [domain.toLowerCase()]);
  return r ?? null;
}

/* -------------------------------------------------------------- suppression
   Spans events (docs/TIERING-AND-ENRICHMENT.md, "Vendors"). An opt-out is never contacted again, by address or by name at a company. A wrong-person
   pair says this address is known not to belong to this name. A person's Drop in one event's review is NOT recorded here: it stays with that event. */

export interface SuppressionInput { kind: "opt_out" | "wrong_person"; email?: string | null; name_key?: string | null; company_key?: string | null; reason?: string; created_by?: string; name?: string | null; company?: string | null }
export async function addSuppression(db: Pick<Db, "query">, s: SuppressionInput) {
  if (!s.email && !(s.name_key && s.company_key)) throw new Error("A suppression needs an address, or a name and a company.");
  await db.query("INSERT INTO suppressions (id, kind, email, name_key, company_key, reason, created_by, name, company) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [`sup_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`, s.kind, s.email?.toLowerCase() ?? null, s.name_key ?? null, s.company_key ?? null, s.reason ?? "", s.created_by ?? null, s.name ?? null, s.company ?? null]);
}
/** Is this address, or this name at this company, opted out? */
export async function isOptedOut(db: Db, o: { email?: string | null; name_key?: string | null; company_key?: string | null }) {
  const rows = await db.query("SELECT 1 FROM suppressions WHERE kind = 'opt_out' AND ((email IS NOT NULL AND email = $1) OR (name_key IS NOT NULL AND name_key = $2 AND company_key = $3)) LIMIT 1", [o.email?.toLowerCase() ?? null, o.name_key ?? null, o.company_key ?? null]);
  return rows.length > 0;
}
/** Is this address known not to be this person? */
export async function isWrongPerson(db: Db, email: string, nameKeyValue: string | null) {
  const rows = await db.query("SELECT 1 FROM suppressions WHERE kind = 'wrong_person' AND email = $1 AND (name_key IS NULL OR name_key = $2) LIMIT 1", [email.toLowerCase(), nameKeyValue]);
  return rows.length > 0;
}

/** A domain's state, or null when absent or older than the reuse window. */
export async function getFreshDomainState(db: Db, domain: string, ages: Age = DEFAULT_AGES) {
  const [r] = await db.query<{ catch_all: boolean | null; mail_server: boolean | null; probed_at: string; event_id: string | null }>(
    "SELECT catch_all, mail_server, probed_at::text AS probed_at, event_id FROM domain_state WHERE domain = $1 AND probed_at > now() - ($2::text || ' days')::interval", [domain.toLowerCase(), String(ages.verification_reuse_days)]);
  return r ?? null;
}

/* ------------------------------------------------- finder and waterfall results
   What Apollo's match and its waterfall returned, read before the card is charged. A found address is reused within freshness_days, a miss within 30 days. Only answers that really came back are stored. */
export interface FinderResult { email: string | null; linkedin: string | null; apollo_verified: boolean; zerobounce_pass: boolean; credits: number; fetched_at: string; event_id: string | null; age_days: number }
type FreshAge = Pick<Limits, "freshness_days">;
export async function getFinderResult(db: Db, vendor: string, nameKey: string, companyKey: string, ages: FreshAge) {
  const [r] = await db.query<FinderResult>(
    `SELECT email, linkedin, apollo_verified, zerobounce_pass, credits, fetched_at::text AS fetched_at, event_id, extract(epoch FROM now() - fetched_at)::float / 86400 AS age_days FROM waterfall_cache
     WHERE vendor = $1 AND name_key = $2 AND company_key = $3 AND fetched_at > now() - ((CASE WHEN email IS NULL THEN $5 ELSE $4 END)::text || ' days')::interval`, [vendor, nameKey, companyKey, String(ages.freshness_days), String(MISS_DAYS)]);
  return r ?? null;
}
export async function putFinderResult(db: Db, vendor: string, nameKey: string, companyKey: string, r: { email: string | null; linkedin?: string | null; apollo_verified?: boolean; zerobounce_pass?: boolean; credits: number }, eventId: string | null = null) {
  await db.query(
    `INSERT INTO waterfall_cache (vendor, name_key, company_key, email, linkedin, apollo_verified, zerobounce_pass, credits, event_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (vendor, name_key, company_key) DO UPDATE SET email = EXCLUDED.email, linkedin = EXCLUDED.linkedin, apollo_verified = EXCLUDED.apollo_verified, zerobounce_pass = EXCLUDED.zerobounce_pass, credits = EXCLUDED.credits, event_id = EXCLUDED.event_id, fetched_at = now()`,
    [vendor, nameKey, companyKey, r.email, r.linkedin ?? null, r.apollo_verified ?? false, r.zerobounce_pass ?? false, r.credits, eventId]);
}

export async function getLinkedinResult(db: Db, nameKey: string, companyKey: string, ages: FreshAge) {
  const [r] = await db.query<{ linkedin: string | null; verified_email: string | null; fetched_at: string; event_id: string | null }>(
    `SELECT linkedin, verified_email, fetched_at::text AS fetched_at, event_id FROM linkedin_cache
     WHERE name_key = $1 AND company_key = $2 AND fetched_at > now() - ((CASE WHEN linkedin IS NULL THEN $4 ELSE $3 END)::text || ' days')::interval`, [nameKey, companyKey, String(ages.freshness_days), String(MISS_DAYS)]);
  return r ?? null;
}
export async function putLinkedinResult(db: Db, nameKey: string, companyKey: string, linkedin: string | null, verifiedEmail: string | null, eventId: string | null = null) {
  await db.query(
    `INSERT INTO linkedin_cache (name_key, company_key, linkedin, verified_email, event_id) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name_key, company_key) DO UPDATE SET linkedin = EXCLUDED.linkedin, verified_email = EXCLUDED.verified_email, event_id = EXCLUDED.event_id, fetched_at = now()`, [nameKey, companyKey, linkedin, verifiedEmail?.toLowerCase() ?? null, eventId]);
}

/** Has Apollo already reported this address as Verified, on an answer we hold and that is still fresh? Free: nothing is bought to find out. */
export async function apolloVerified(db: Db, email: string, ages: FreshAge) {
  const rows = await db.query(
    `SELECT 1 FROM reveals WHERE lower(email) = $1 AND data->>'email_verified' = 'true' AND fetched_at > now() - ($2::text || ' days')::interval
     UNION ALL SELECT 1 FROM waterfall_cache WHERE email = $1 AND apollo_verified AND fetched_at > now() - ($2::text || ' days')::interval
     UNION ALL SELECT 1 FROM linkedin_cache WHERE verified_email = $1 AND fetched_at > now() - ($2::text || ' days')::interval LIMIT 1`, [email.toLowerCase(), String(ages.freshness_days)]);
  return rows.length > 0;
}

/* ---------------------------------------------------------------- reuse_log
   One row for each paid call a stored answer replaced. "Saved" means an answer from an earlier event or run: one written by another event, or by this event before its first card was approved. An answer this run wrote itself does not count.
   The unique key means a replay counts once. Credits and model calls are kept in their own units. */
export interface ReuseEntry { target: string; step: string; vendor: string; unit: "credits" | "llm"; n: number; candidate?: string; answered_at: string; answered_by?: string | null }
export async function logReuse(q: Db["query"], eventId: string, e: ReuseEntry) {
  if (e.n <= 0) return;
  await q(
    `INSERT INTO reuse_log (id, event_id, target, step, vendor, candidate, unit, n)
     SELECT $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text, $8::int
     WHERE ($10::text IS NOT NULL AND $10::text <> $2::text) OR $9::timestamptz < (SELECT min(a.decided_at) FROM approvals a WHERE a.event_id = $2::text AND a.status = 'approved' AND a.card_id IS NOT NULL)
     ON CONFLICT (event_id, target, step, vendor, candidate) DO NOTHING`,
    [`reu_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`, eventId, e.target, e.step, e.vendor, e.candidate ?? "", e.unit, e.n, e.answered_at, e.answered_by ?? null]);
}
