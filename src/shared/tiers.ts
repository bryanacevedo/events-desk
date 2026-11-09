/* What the LLM may return, and how tiers combine. The LLM picks from these
   lists and nothing else; anything off the list counts as an invalid response. */

import type { Tier } from "./cost.ts";

export type Priority = "A" | "B" | "C";

const MATRIX: Record<Tier, Record<Tier | "none", Priority>> = {
  1: { 1: "A", 2: "B", 3: "C", none: "A" },
  2: { 1: "B", 2: "C", 3: "C", none: "B" },
  3: { 1: "C", 2: "C", 3: "C", none: "C" },
};
export const priority = (company: Tier, title: Tier | null): Priority => MATRIX[company][title ?? "none"];

export const REASONS = ["icp_match", "partial_icp_match", "outside_icp", "decision_maker", "influencer", "not_relevant", "insufficient_information"] as const;
export const LLM_FLAGS = ["title_company_mismatch", "likely_left_company", "name_looks_wrong"] as const;
export const FLAG_WORDS: Record<string, string> = {
  title_company_mismatch: "The title does not fit this company",
  likely_left_company: "May have left the company",
  name_looks_wrong: "The name looks wrong",
  not_reviewed: "Not reviewed",
};

export function validTier(v: unknown): { tier: Tier; reason: string } | null {
  const o = v as { tier?: unknown; reason?: unknown } | null;
  if (!o || ![1, 2, 3].includes(o.tier as number) || !REASONS.includes(o.reason as (typeof REASONS)[number])) return null;
  return { tier: o.tier as Tier, reason: o.reason as string };
}

export function validFlags(v: unknown): { flags: string[] } | null {
  const f = (v as { flags?: unknown } | null)?.flags;
  if (!Array.isArray(f) || !f.every((x) => LLM_FLAGS.includes(x))) return null;
  return { flags: [...new Set(f as string[])] };
}

export type Verdict = "deliverable" | "undeliverable" | "catch_all" | "unknown";
/** Only deliverable from both verifiers keeps a contact. An email that is not certainly valid is invalid. */
export function verifyOutcome(a: Verdict, b: Verdict): "keep" | "drop" {
  return a === "deliverable" && b === "deliverable" ? "keep" : "drop";
}

/* ------------------------------------------------------- company tier answers
   The company tier step returns tier 1, 2, 3 or Unknown, plus the segment and company type from the ICP's closed
   lists, a reason code, and the fact it relied on. A tier that cites no supplied fact becomes Unknown. */

export interface CompanyTierAnswer {
  tier: Tier | null;
  segment: string | null;
  company_type: string | null;
  reason: string;
  fact: string | null;
  /** Set when the model gave a tier but cited nothing the input supplied, so the tier was dropped. */
  downgraded: "no_fact" | null;
}
export interface CompanyTierCheck {
  /** The lines of the input a fact may be copied from. */
  citable: string[];
  /** The ICP path needs a cited fact. The single-card path does not. */
  requireFact: boolean;
  segments?: readonly string[];
  types?: readonly string[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
/** A fact counts only if it is a real piece of a supplied line, at least six characters, so "yes" or the company's own name cannot pass. */
export function citesSupplied(fact: unknown, citable: string[]): boolean {
  if (typeof fact !== "string") return false;
  const f = norm(fact);
  return f.length >= 6 && citable.some((l) => norm(l).includes(f));
}

/** Reads a company tier answer, or returns null when it cannot be read (one retry). Segment and company type must be on the ICP's lists. */
export function validCompanyTier(v: unknown, o: CompanyTierCheck): CompanyTierAnswer | null {
  const x = v as { tier?: unknown; reason?: unknown; segment?: unknown; company_type?: unknown; fact?: unknown } | null;
  if (!x || typeof x !== "object") return null;
  const unknown = x.tier === "unknown" || x.tier === "Unknown" || x.tier === null;
  if (!unknown && ![1, 2, 3].includes(x.tier as number)) return null;
  const reason = typeof x.reason === "string" && REASONS.includes(x.reason as (typeof REASONS)[number]) ? x.reason : unknown ? "insufficient_information" : null;
  if (!reason) return null;
  const closed = (val: unknown, list?: readonly string[]) => {
    if (val === undefined || val === null || val === "") return { ok: true as const, value: null };
    if (typeof val !== "string") return { ok: false as const, value: null };
    if (list && !list.includes(val)) return { ok: false as const, value: null };
    return { ok: true as const, value: val };
  };
  const seg = closed(x.segment, o.segments), typ = closed(x.company_type, o.types);
  if (!seg.ok || !typ.ok) return null;
  const fact = typeof x.fact === "string" && x.fact.trim() ? x.fact.trim().slice(0, 300) : null;
  if (unknown) return { tier: null, segment: seg.value, company_type: typ.value, reason: "insufficient_information", fact, downgraded: null };
  if (o.requireFact && !citesSupplied(fact, o.citable)) return { tier: null, segment: seg.value, company_type: typ.value, reason: "insufficient_information", fact: null, downgraded: "no_fact" };
  return { tier: x.tier as Tier, segment: seg.value, company_type: typ.value, reason: reason as string, fact, downgraded: null };
}

/** What a website read returns: a short plain description, or an empty one when the page said nothing useful. */
export function validWebsiteRead(v: unknown): { description: string } | null {
  const d = (v as { description?: unknown } | null)?.description;
  if (typeof d !== "string") return null;
  return { description: d.replace(/\s+/g, " ").trim().slice(0, 500) };
}
