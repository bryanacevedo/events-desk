/* Company identity, the code half (docs/TIERING-AND-ENRICHMENT.md, "Layer 1"). No database, no vendor:
   the evidence rules and the weighing of search candidates, so they can be tested and measured on their own.

   Evidence, strongest first:
     1. a work email domain that has a mail server, is not shared, and resembles the company name (free, before the card)
     2. company search by name, weighed by name similarity, event country and how many candidates fit
     3. a person match, accepted only if the employer it returns matches the row's company
     4. a company LinkedIn URL (no upload field carries one yet, so it is not wired)
     5. the form's website field, only if it resolves and nothing stronger disagrees

   Outcomes: resolved, ambiguous (two close candidates and no way to separate them), not found. */

import { editDistance, isFreeWebmail, isPlaceholderDomain, registrable, relatedNames, resemblesDomain, similarity } from "./layer0.ts";

/** Starting values. Judgment calls with no outside evidence behind them, meant to be tuned. */
export const IDENTITY = {
  /** A candidate at or above this score has a near-exact name. */
  strong: 0.85,
  /** A candidate below this is not a candidate. */
  floor: 0.6,
  /** Another candidate within this of the best is a close rival. */
  rival_gap: 0.12,
  /** The employer a person match returns must score at least this against the row's company. */
  employer_match: 0.8,
} as const;

export interface FileEvidence { source: "email_domain" | "form_website"; value: string; rows: number }
export interface Candidate { name: string; domain: string; parent_name?: string | null; parent_domain?: string | null; country?: string | null; employees?: number | null }

/** Name score between two company keys, 0 to 1. A name that is a prefix of the other (a shortened name) scores high but below an exact one. */
export function nameScore(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const fa = a.replace(/ /g, ""), fb = b.replace(/ /g, "");
  if (fa === fb) return 0.99;
  const [short, long] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  const prefix = short.length >= 4 && long.startsWith(short) ? 0.7 + 0.3 * (short.length / long.length) : 0;
  // Names whose lengths differ this much cannot be within the floor of each other by edits, so the edit distance is not worth computing.
  if (1 - (long.length - short.length) / long.length < IDENTITY.floor) return prefix;
  return Math.max(similarity(a, b), prefix);
}

const usable = (d: string) => !!d && !isFreeWebmail(d) && !isPlaceholderDomain(d);

/** Rule 1, the part that needs no vendor: the one work email domain that resembles the name. Two resembling domains (a company and a longer-named sibling, say) are not told apart by counting rows, because the people filed under a name are as likely to come from the sibling; those go to company search. */
export function emailDomainChoice(key: string, evidence: FileEvidence[]): { domain: string; rows: number } | null {
  const ds = evidence.filter((e) => e.source === "email_domain" && usable(e.value) && resemblesDomain(key, e.value));
  return ds.length === 1 ? { domain: ds[0].value, rows: ds[0].rows } : null;
}

export interface Weighed {
  state: "resolved" | "ambiguous" | "none";
  chosen?: Candidate;
  via?: string;
  /** The close candidates, best first. */
  close: { c: Candidate; score: number }[];
  best: number;
}

/** Weighs search candidates for one name. A near-exact name with no close rival resolves; two close ones that nothing separates are ambiguous. */
export function weigh(key: string, candidates: Candidate[], opts: { country?: string | null; emailDomain?: string | null; candidateKey: (name: string) => string }): Weighed {
  const scored = candidates
    .filter((c) => usable(c.domain))
    .map((c) => ({ c, score: nameScore(key, opts.candidateKey(c.name)) }))
    .filter((x) => x.score >= IDENTITY.floor)
    .sort((a, b) => b.score - a.score || a.c.domain.localeCompare(b.c.domain));
  if (!scored.length) return { state: "none", close: [], best: 0 };
  const top = scored[0];
  // The same domain twice (a subsidiary on its parent's domain) is one answer, not a rival.
  const rivals = scored.slice(1).filter((x) => x.c.domain !== top.c.domain && x.score >= top.score - IDENTITY.rival_gap);
  const close = [top, ...rivals];
  // An exact name with no exact rival is the company, whatever else the file's addresses say: the people filed under a name are not all from it.
  if (top.score >= 1 && rivals.every((r) => r.score < 1)) return { state: "resolved", chosen: top.c, via: "search", close, best: top.score };
  // The file's own email domain agreeing with one close candidate is two independent sources.
  if (opts.emailDomain) {
    const hit = close.find((x) => x.c.domain === opts.emailDomain);
    if (hit) return { state: "resolved", chosen: hit.c, via: "search+email", close, best: hit.score };
  }
  if (!rivals.length) {
    if (top.score >= IDENTITY.strong || (top.score >= IDENTITY.floor && relatedNames(key, opts.candidateKey(top.c.name)) && editDistance(key.replace(/ /g, ""), opts.candidateKey(top.c.name).replace(/ /g, "")) <= Math.max(2, Math.floor(key.length / 4)))) return { state: "resolved", chosen: top.c, via: "search", close, best: top.score };
    return { state: "none", close, best: top.score };
  }
  // Close names: the event's country can separate them, but only when exactly one of them is there.
  if (opts.country) {
    const here = close.filter((x) => x.c.country && x.c.country.toLowerCase() === opts.country!.toLowerCase());
    if (here.length === 1) return { state: "resolved", chosen: here[0].c, via: "search+country", close, best: here[0].score };
  }
  return { state: "ambiguous", close, best: top.score };
}

/** Does the employer a person match returned belong to the company the row names? This input is known for returning the right name at the wrong company. */
export function employerMatches(rowKey: string, employerKey: string) {
  return nameScore(rowKey, employerKey) >= IDENTITY.employer_match || (relatedNames(rowKey, employerKey) && nameScore(rowKey, employerKey) >= IDENTITY.floor + 0.1);
}

/** Keeps a domain only if it is a real company domain. */
export const companyDomain = (d: string | null | undefined) => { const x = (d ?? "").toLowerCase().trim().replace(/^www\./, ""); return usable(x) && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x) ? x : null; };
export { registrable };

/** The split a vendor wants: the last word is the last name. Null when there is only one word. */
export function splitName(full: string | null): { first: string; last: string } | null {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}
