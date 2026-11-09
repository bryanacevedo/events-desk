/* Company tiering, the parts that need no database and no model (docs/TIERING-AND-ENRICHMENT.md, "Layer 2" and "Layer 3"):

   - the supplied facts: the lines the model may cite, built from vendor firmographics, the attendee file's own notes and what
     one read of the website said;
   - which firmographic fields the pinned ICP actually needs, so a paid enrich is bought only for fields that are missing;
   - the spread check that warns before Approval 2;
   - the second-look trigger. It never uses a stated confidence. */

import { sizeBand, type Firmo, type Icp } from "./icp.ts";
import type { Limits } from "./cost.ts";

export const FIRMO_FIELDS = ["employees", "industry", "business_model", "country", "description"] as const;
export type FirmoField = (typeof FIRMO_FIELDS)[number];
/** Facts a vendor returns on the same free organization search that no tier rule reads. They are kept for the delivered list and never bought on their own. */
export const FIRMO_DETAIL = ["revenue", "founded", "city", "linkedin", "funding_stage"] as const;
/** Vendor values as stored. Fields are missing (null or absent) more often than not on a real vendor. */
export type FirmoRecord = {
  employees?: number | null; industry?: string | null; business_model?: string | null; country?: string | null; description?: string | null;
  /** Annual revenue in USD, as the vendor states it. Company data, not spend: it is never summed with anything. */
  revenue?: number | null; founded?: number | null; city?: string | null; linkedin?: string | null; funding_stage?: string | null;
};

const has = (v: unknown) => v !== null && v !== undefined && v !== "";

/** Vendors spell business model many ways. The hard rules compare against B2B, B2C and B2B2C. */
export function normalizeBusinessModel(v: unknown): "B2B" | "B2C" | "B2B2C" | null {
  if (typeof v !== "string") return null;
  const t = v.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (t === "b2b" || t === "business" || t === "businesses" || t === "businesstobusiness") return "B2B";
  if (t === "b2c" || t === "consumer" || t === "consumers" || t === "businesstoconsumer") return "B2C";
  if (t === "b2b2c" || t === "both" || t === "businessandconsumers") return "B2B2C";
  return null;
}

/** Keeps only known fields, with sane values. Anything else a vendor sent is dropped, so a field cannot be smuggled in. */
export function cleanFirmo(raw: unknown): FirmoRecord {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: FirmoRecord = {};
  if (typeof r.employees === "number" && Number.isFinite(r.employees) && r.employees >= 0 && r.employees < 5_000_000) out.employees = Math.round(r.employees);
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : null);
  const industry = text(r.industry, 120), country = text(r.country, 80), description = text(r.description, 600);
  if (industry) out.industry = industry;
  if (country) out.country = country;
  if (description) out.description = description;
  const bm = normalizeBusinessModel(r.business_model);
  if (bm) out.business_model = bm;
  if (typeof r.revenue === "number" && Number.isFinite(r.revenue) && r.revenue >= 0 && r.revenue < 1e13) out.revenue = Math.round(r.revenue);
  if (typeof r.founded === "number" && Number.isInteger(r.founded) && r.founded >= 1600 && r.founded <= 2100) out.founded = r.founded;
  const city = text(r.city, 80), funding = text(r.funding_stage, 60);
  if (city) out.city = city;
  if (funding) out.funding_stage = funding;
  // Only a LinkedIn company page, over https, is kept; anything else a vendor puts in that field is dropped.
  const li = typeof r.linkedin === "string" ? r.linkedin.trim().toLowerCase() : "";
  if (/^https:\/\/(www\.)?linkedin\.com\/company\/[a-z0-9._-]+\/?$/.test(li)) out.linkedin = li.replace(/\/$/, "");
  return out;
}

/** Fills only what is missing. A later source never overwrites an earlier one. */
export function mergeFirmo(base: FirmoRecord, add: FirmoRecord): FirmoRecord {
  const out: FirmoRecord = { ...base };
  for (const f of [...FIRMO_FIELDS, ...FIRMO_DETAIL]) if (!has(out[f]) && has(add[f])) (out as Record<string, unknown>)[f] = add[f];
  return out;
}

/** The fields the pinned ICP reads: those its hard rules test, the employee count when it states a size or a tier condition, the business model when a condition needs it, and industry or description so the model has something to judge. */
export function neededFields(icp: Icp): FirmoField[] {
  const need = new Set<FirmoField>();
  for (const h of icp.hard_rules) need.add(h.field);
  if (icp.size || icp.tier_definitions.some((t) => t.when?.employees)) need.add("employees");
  if (icp.tier_definitions.some((t) => t.when?.consumer_only !== undefined)) need.add("business_model");
  need.add("industry");
  return [...need];
}

/** Which of those are still missing. Industry counts as present when a description is. */
export function missingNeeded(icp: Icp, f: FirmoRecord): FirmoField[] {
  return neededFields(icp).filter((k) => (k === "industry" ? !has(f.industry) && !has(f.description) : !has(f[k])));
}

/* ------------------------------------------------------------ the facts */

const BM_WORDS: Record<string, string> = { B2B: "businesses (B2B)", B2C: "consumers only (B2C)", B2B2C: "businesses and consumers (B2B2C)" };

/** The lines a model may copy a fact from. The company's own name and website are context, never evidence of fit. */
export interface Facts { text: string; citable: string[] }
export function buildFacts(o: { name: string; domain: string | null; firmo: FirmoRecord | null; website_note?: string | null; file_notes?: string[] }): Facts {
  const f = o.firmo ?? {};
  const citable: string[] = [];
  if (has(f.employees)) citable.push(`Employees: ${f.employees}`);
  if (has(f.industry)) citable.push(`Industry: ${f.industry}`);
  if (has(f.business_model)) citable.push(`Sells to: ${BM_WORDS[f.business_model!] ?? f.business_model}`);
  if (has(f.country)) citable.push(`Country: ${f.country}`);
  if (has(f.description)) citable.push(`Description: ${f.description}`);
  if (o.website_note) citable.push(`From its own website: ${o.website_note}`);
  for (const n of o.file_notes ?? []) citable.push(`From the attendee file (unverified): ${n}`);
  const head = [`Company: ${o.name}`, ...(o.domain ? [`Website: ${o.domain}`] : [])];
  return { citable, text: [...head, ...citable].join("\n") };
}

/** The firmographics as the ICP rules read them. */
export const firmoForRules = (f: FirmoRecord | null): Firmo => ({ employees: f?.employees ?? null, business_model: f?.business_model ?? null, industry: f?.industry ?? null, description: f?.description ?? null, country: f?.country ?? null });

/* ---------------------------------------------------------- second look */

/** A second model looks at every tier 1, because that is where the money goes, and at any tier more than one level away from the baseline. Stated confidence plays no part. */
export function needsSecondLook(tier: 1 | 2 | 3, baseline: 1 | 2 | 3): boolean {
  return tier === 1 || Math.abs(tier - baseline) > 1;
}

/* --------------------------------------------------------- spread check */

export interface SpreadCounts { total: number; tier1: number; tier2: number; tier3: number; unknown: number }
export interface SpreadExample { company: string; detail: string }
export interface SpreadWarning { kind: "tier1_share" | "mostly_unknown" | "no_tier1" | "small_list"; text: string; examples: SpreadExample[] }
export interface Spread { counts: SpreadCounts; warnings: SpreadWarning[]; limits: { tier1_share: number; small_list: number } }

const pct = (n: number, of: number) => `${Math.round((100 * n) / Math.max(of, 1))}%`;

/** Before Approval 2, code flags a spread that looks wrong: too much in tier 1, over half Unknown, nothing in tier 1, or a list too short for shares to mean much. It warns and shows examples; it blocks nothing. */
export function spreadCheck(counts: SpreadCounts, ex: { tier1: SpreadExample[]; unknown: SpreadExample[]; tier2: SpreadExample[] }, limits: Pick<Limits, "tier1_share_warning" | "small_list_companies">): Spread {
  const warnings: SpreadWarning[] = [];
  const { total, tier1, unknown } = counts;
  if (total > 0 && tier1 / total > limits.tier1_share_warning) warnings.push({ kind: "tier1_share", text: `${tier1} of ${total} companies (${pct(tier1, total)}) are tier 1, above the ${pct(limits.tier1_share_warning * 100, 100)} warning level. Check that the ICP is not too loose.`, examples: ex.tier1.slice(0, 5) });
  if (total > 0 && unknown / total > 0.5) warnings.push({ kind: "mostly_unknown", text: `${unknown} of ${total} companies (${pct(unknown, total)}) are Unknown. The vendor may have too little on this list; answer the cases, or skip them for no spend.`, examples: ex.unknown.slice(0, 5) });
  if (total > 0 && tier1 === 0) warnings.push({ kind: "no_tier1", text: "No company is tier 1. Either the attendee list does not fit this seller, or the ICP is too strict.", examples: ex.tier2.slice(0, 5) });
  if (total < limits.small_list_companies) warnings.push({ kind: "small_list", text: `Only ${total} companies: with fewer than ${limits.small_list_companies}, the shares above mean little.`, examples: [] });
  return { counts, warnings, limits: { tier1_share: limits.tier1_share_warning, small_list: limits.small_list_companies } };
}

export { sizeBand };
