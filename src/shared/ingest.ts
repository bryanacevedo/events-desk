/* Turns any messy attendee CSV into companies, source rows and contacts, in
   code. No LLM touches this, so nothing paid runs before the cost card. */

import Papa from "papaparse";
import { cleanRow, emailDomain, isFreeWebmail, isPlaceholderDomain, isWebmailTypo, nameSet, relatedNames, resemblesDomain, samePerson } from "./layer0.ts";

export const FIELDS = ["company", "full_name", "first_name", "last_name", "title", "email", "linkedin"] as const;
export type Field = (typeof FIELDS)[number];
export type ColumnMap = Partial<Record<Field, number>>;

const SYNONYMS: Record<Field, string[]> = {
  company: ["company", "companyname", "organization", "organisation", "org", "account", "accountname", "employer", "exhibitor", "sponsor", "firm", "business"],
  full_name: ["fullname", "name", "attendeename", "attendee", "contactname", "contact", "delegate", "person"],
  first_name: ["firstname", "first", "givenname", "fname"],
  last_name: ["lastname", "last", "surname", "familyname", "lname"],
  title: ["jobtitle", "title", "position", "role", "jobrole", "designation"],
  email: ["workemail", "businessemail", "email", "emailaddress", "mail"],
  linkedin: ["linkedinurl", "linkedin", "linkedinprofile", "profileurl", "profile"],
};

/** Columns Layer 0 reads without mapping them: they stay in `ignored`, so the model still sees them as context. */
const EXTRA_SYNONYMS = { website: ["website", "web", "site", "url", "companywebsite", "companyurl", "homepage", "companydomain", "domain"], badge: ["badgename", "badge", "preferredname", "nickname", "namebadge"] } as const;
export type Extras = { website?: number; badge?: number };

const header = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINKEDIN = /linkedin\.com\//i;

/** A real LinkedIn profile URL on http or https, rebuilt in one form, or null. Vendor and file values are untrusted. */
export function cleanLinkedin(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 300) return null;
  let u: URL;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  const m = u.pathname.match(/^\/in\/([^/]+)/);
  return m ? `https://www.linkedin.com/in/${m[1]}` : null;
}

export interface Parsed { headers: string[]; rows: string[][]; headless: boolean }

export function parseCsv(text: string): Parsed {
  const { data } = Papa.parse<string[]>(text.replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
  return parseTable(data.map((r) => r.map((c) => c.trim())));
}

/** Header detection shared by CSV and workbook uploads. `lines` are already trimmed text cells. */
export function parseTable(lines: string[][]): Parsed {
  if (!lines.length) return { headers: [], rows: [], headless: false };
  // Exports often put a title line or two above the real header.
  // A header names a company, an email or a LinkedIn column; a file may have no company column at all.
  const knownHeader = (r: string[]) => r.some((c) => SYNONYMS.company.includes(header(c)) || SYNONYMS.email.includes(header(c)) || SYNONYMS.linkedin.includes(header(c)));
  const at = lines.slice(0, 10).findIndex(knownHeader);
  // One column with no header we recognize is a plain list. Its values say of what: addresses, LinkedIn profiles, or companies.
  if (at < 0 && lines.every((r) => r.length === 1)) {
    const share = (shape: RegExp) => lines.filter((r) => shape.test(r[0])).length / lines.length;
    return { headers: [share(EMAIL) >= 0.6 ? "email" : share(LINKEDIN) >= 0.6 ? "linkedin" : "company"], rows: lines, headless: true };
  }
  const start = Math.max(at, 0);
  return { headers: lines[start], rows: lines.slice(start + 1), headless: false };
}

function shapeShare(rows: string[][], col: number, shape: RegExp) {
  const values = rows.map((r) => r[col] ?? "").filter(Boolean);
  return values.length ? values.filter((v) => shape.test(v)).length / values.length : 0;
}

export function mapColumns(p: Parsed): { map: ColumnMap; ignored: string[]; error: string | null; extras: Extras } {
  const map: ColumnMap = {};
  const names = p.headers.map(header);
  const used = new Set<number>();
  const rank = (f: Field, i: number) => { const r = SYNONYMS[f].indexOf(names[i]); return r < 0 ? 999 : r; };

  // Value shape first: a column full of addresses is the email column whatever it is called.
  for (const [field, shape] of [["email", EMAIL], ["linkedin", LINKEDIN]] as const) {
    const hits = names.map((_, i) => i).filter((i) => shapeShare(p.rows, i, shape) >= 0.6).sort((a, b) => rank(field, a) - rank(field, b));
    if (hits.length) { map[field] = hits[0]; used.add(hits[0]); }
  }
  for (const field of FIELDS) {
    if (map[field] !== undefined) continue;
    const hits = names.map((_, i) => i).filter((i) => !used.has(i) && rank(field, i) < 999).sort((a, b) => rank(field, a) - rank(field, b));
    if (hits.length) { map[field] = hits[0]; used.add(hits[0]); }
  }
  const ignored = p.headers.filter((_, i) => !used.has(i));
  const extras: Extras = {};
  for (const k of ["website", "badge"] as const) {
    const i = names.findIndex((n, c) => !used.has(c) && (EXTRA_SYNONYMS[k] as readonly string[]).includes(n));
    if (i >= 0) extras[k] = i;
  }
  // A row needs any one of company, email or LinkedIn, so a file with a person column and no company column is fine.
  const error = map.company === undefined && map.email === undefined && map.linkedin === undefined
    ? `No company, email or LinkedIn column found. Columns in this file: ${p.headers.join(", ") || "none"}.` : null;
  return { map, ignored, error, extras };
}

const LEGAL = new Set(["inc", "incorporated", "llc", "llp", "ltd", "limited", "corp", "corporation", "co", "gmbh", "sa", "sas", "sarl", "srl", "bv", "nv", "plc", "ag", "pty", "oy", "ab", "ltda", "spa"]);
const ascii = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** "ACME, Inc." and "Acme" share one key. A name that is only a legal word keeps it. */
export function companyKey(name: string) {
  const words = ascii(name).toLowerCase().replace(/[.']/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter((w) => w && w !== "and");
  while (words.length > 1 && LEGAL.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}


/** A readable stand-in for a company known only by a work email's domain: "acme.co.uk" reads "Acme". Replaced when a data source gives the real name. */
export function labelFromDomain(domain: string) {
  const parts = domain.toLowerCase().split(".");
  parts.pop();
  if (parts.length > 1 && ["co", "com", "org", "net", "ac", "gov", "edu"].includes(parts[parts.length - 1])) parts.pop();
  const root = parts[parts.length - 1] ?? domain;
  return root.charAt(0).toUpperCase() + root.slice(1);
}

const cleanName = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  const parts = t.match(/^([^,]+),\s*([^,]+)$/);
  if (!parts) return t;
  // "Ann Lee, PhD" is a name and a credential, not "Last, First".
  return /^(phd|ph\.d\.?|md|m\.d\.?|mba|jr\.?|sr\.?|ii|iii|iv|cpa|esq\.?)$/i.test(parts[2]) ? parts[1] : `${parts[2]} ${parts[1]}`;
};

/** Every reason an upload can drop a row. All are on the design's list (docs/TIERING-AND-ENRICHMENT.md, "All drop reasons"). */
export type DropReason = "duplicate" | "no_company" | "junk_row" | "not_a_company";

/** What the file says about a company's domain. Evidence only: nothing here is a confirmed identity. */
export interface Evidence { source: "email_domain" | "form_website"; value: string; rows: number }
export interface IngestCompany { key: string; name: string; evidence: Evidence[] }
export interface IngestSourceRow { row_number: number; raw: Record<string, string>; kind: "person" | "company_only" | "no_company"; company_key: string | null; drop_reason: DropReason | null; website: string | null; issues: string[] }
export interface IngestContact { row_number: number; company_key: string | null; full_name: string | null; title: string | null; email: string | null; linkedin: string | null; drop_reason: DropReason | null }

/** The list quality report shown on the Research card, so a poor list is visible before money is spent. */
export interface QualityReport {
  rows: number;
  /** Rows that continue: not dropped at upload. */
  usable_rows: number;
  /** Rows with nothing wrong with them. */
  clean_rows: number;
  dropped: Record<string, number>;
  /** Rows carrying each issue. A row can carry several. */
  issues: Record<string, number>;
  shared_emails: { emails: number; rows: number };
  shared_domains: { domains: string[]; rows: number };
  /** The first row numbers for each issue, so a person can look. */
  samples: Record<string, number[]>;
  verdict: "good" | "fair" | "poor";
  summary: string[];
}
export interface Ingested { companies: IngestCompany[]; sourceRows: IngestSourceRow[]; contacts: IngestContact[]; quality: QualityReport }

const ISSUE_WORDS: Record<string, string> = {
  placeholder_email: "placeholder email addresses (discarded)", shared_email: "one email shared by several people (discarded for all)",
  shared_domain: "one email domain on unrelated companies (not used to identify anyone)", company_mash: "keyboard mashing in the company field",
  name_mash: "keyboard mashing in a name field", company_filler: "filler such as N/A in the company field", title_filler: "filler in the title field",
  email_filler: "filler in the email field", website_filler: "filler or placeholder websites (ignored)", free_webmail: "personal webmail addresses",
  webmail_typo: "mistyped webmail domains", swapped_company_title: "company and title in each other's columns (moved)", swapped_names_moved: "first and last name swapped (moved)",
  name_order_suspect: "first and last name possibly swapped (left, not changed)", person_name_as_company: "the person's own name as company",
  not_a_company: "students, press and self-employed (dropped)", company_looks_like_title: "company field that reads like a job title (left)",
  fake_local_part: "stand-in mailboxes such as test@ on real domains (left for verification)", email_invalid: "values in the email column that are not addresses",
};

export function normalize(p: Parsed, map: ColumnMap, extras: Extras = {}): Ingested {
  const sourceRows: IngestSourceRow[] = [];
  const contacts: IngestContact[] = [];

  interface Work { i: number; raw: Record<string, string>; company: string; key: string; full_name: string | null; title: string | null; email: string | null; linkedin: string | null; website: string | null; issues: string[]; dropped: DropReason | null }
  const work: Work[] = [];

  /* Pass 1, one row at a time. */
  p.rows.forEach((r, i) => {
    const cell = (c: number | undefined) => (c === undefined ? "" : (r[c] ?? "").trim());
    const get = (f: Field) => cell(map[f]);
    const raw = Object.fromEntries(p.headers.map((h, c) => [h, r[c] ?? ""]));
    const c = cleanRow({ company: get("company"), first: get("first_name"), last: get("last_name"), full: get("full_name"), title: get("title"), email: get("email"), linkedin: get("linkedin"), website: cell(extras.website), badge: cell(extras.badge) });
    const joined = `${c.first} ${c.last}`.trim();
    const full_name = cleanName(c.full || joined) || null;
    const linkedin = cleanLinkedin(c.linkedin);
    const key = c.company ? companyKey(c.company) : "";
    let dropped: DropReason | null = null;
    // A row needs any one of company, email or LinkedIn. A name alone is not a row.
    if (c.not_a_company) dropped = "not_a_company";
    else if (!key && !c.email && !linkedin) dropped = "junk_row";
    work.push({ i: i + 1, raw, company: c.company, key, full_name, title: c.title || null, email: c.email, linkedin, website: c.website_domain, issues: c.issues, dropped });
  });

  /* Pass 2, across rows. Only rows still standing take part. */
  const live = work.filter((w) => !w.dropped);

  // One email on different people is a shared mailbox: discard it for all of them and let each person continue.
  const byEmail = new Map<string, Work[]>();
  for (const w of live) if (w.email) byEmail.set(w.email, [...(byEmail.get(w.email) ?? []), w]);
  let sharedEmails = 0, sharedEmailRows = 0;
  for (const [, group] of byEmail) {
    const named = group.filter((w) => w.full_name);
    const people: string[] = [];
    for (const w of named) if (!people.some((x) => samePerson(x, w.full_name!))) people.push(w.full_name!);
    if (people.length < 2) continue;
    sharedEmails++; sharedEmailRows += group.length;
    for (const w of group) { w.email = null; w.issues.push("shared_email"); }
  }

  // One domain on companies that have nothing to do with each other identifies nobody.
  const byDomain = new Map<string, Work[]>();
  for (const w of live) if (w.email) {
    const d = emailDomain(w.email);
    if (!isFreeWebmail(d) && !isWebmailTypo(d) && !isPlaceholderDomain(d)) byDomain.set(d, [...(byDomain.get(d) ?? []), w]);
  }
  const sharedDomains = new Set<string>();
  let sharedDomainRows = 0;
  for (const [d, group] of byDomain) {
    const keys = [...new Set(group.map((w) => w.key).filter(Boolean))];
    if (keys.length < 2) continue;
    // Group names that plainly name one company (casing, a typo, a legal suffix), then count the groups that do not resemble the domain.
    const comps: string[][] = [];
    for (const k of keys) { const home = comps.find((c) => c.some((x) => relatedNames(x, k))); if (home) home.push(k); else comps.push([k]); }
    const foreign = comps.filter((c) => !c.some((k) => resemblesDomain(k, d)));
    const owners = comps.length - foreign.length;
    if (foreign.length >= 3 || (foreign.length >= 2 && owners === 0)) {
      sharedDomains.add(d);
      for (const w of group) { w.issues.push("shared_domain"); sharedDomainRows++; }
    }
  }

  // Duplicates. Two people can share a name at one company, so names decide only when an email is missing on one side.
  const seenEmails = new Set<string>(), seenNames = new Set<string>(), seenLinkedin = new Set<string>();
  const seenNamesNoEmail = new Map<string, number>();
  const contactByRow = new Map<number, IngestContact>();
  const companies = new Map<string, { name: string; sites: Map<string, number>; mail: Map<string, number>; domains: Set<string> }>();
  const seenCompanyOnly = new Set<string>();

  for (const w of work) {
    const isPerson = Boolean(w.full_name || w.email || w.linkedin);
    let kind: IngestSourceRow["kind"] = isPerson ? "person" : w.key ? "company_only" : "no_company";
    let drop: DropReason | null = w.dropped;
    if (!drop && isPerson) {
      const name = w.full_name && w.key ? `${nameSet(w.full_name)}|${w.key}` : null;
      const repeat = w.email ? seenEmails.has(w.email) || (name !== null && seenNamesNoEmail.has(name))
        : w.linkedin && seenLinkedin.has(w.linkedin) ? true : name !== null && seenNames.has(name);
      if (repeat) { drop = "duplicate"; w.issues.push("duplicate"); }
      else {
        if (w.email) seenEmails.add(w.email); else if (name) seenNamesNoEmail.set(name, w.i);
        if (name) seenNames.add(name);
        if (w.linkedin) seenLinkedin.add(w.linkedin);
      }
      // The same person listed twice, once with an email: keep the email so nobody pays to find it.
      if (repeat && w.email && name && !seenEmails.has(w.email)) {
        const earlier = contactByRow.get(seenNamesNoEmail.get(name) ?? -1);
        if (earlier) { earlier.email = w.email; seenEmails.add(w.email); seenNamesNoEmail.delete(name); }
      }
    } else if (!drop && !isPerson && w.key) {
      if (seenCompanyOnly.has(w.key)) { drop = "duplicate"; w.issues.push("duplicate"); }
      seenCompanyOnly.add(w.key);
    }
    // Companies come only from rows that continue; the evidence is what those rows say about the domain.
    if (!drop && w.key) {
      const co = companies.get(w.key) ?? { name: w.company, sites: new Map(), mail: new Map(), domains: new Set() };
      companies.set(w.key, co);
      if (w.website) co.sites.set(w.website, (co.sites.get(w.website) ?? 0) + 1);
      if (w.email) {
        const d = emailDomain(w.email);
        if (!isFreeWebmail(d) && !isWebmailTypo(d) && !isPlaceholderDomain(d) && !sharedDomains.has(d)) co.mail.set(d, (co.mail.get(d) ?? 0) + 1);
      }
    }
    sourceRows.push({ row_number: w.i, raw: w.raw, kind, company_key: w.key || null, drop_reason: drop, website: w.website, issues: w.issues });
    if (isPerson) {
      const contact: IngestContact = { row_number: w.i, company_key: w.key || null, full_name: w.full_name, title: w.title, email: w.email, linkedin: w.linkedin, drop_reason: drop };
      contacts.push(contact); contactByRow.set(w.i, contact);
    }
  }

  // A company whose every row was dropped as a repeat is already registered by the first; one that appears only on dropped rows is not a company.
  const companyList: IngestCompany[] = [...companies].map(([key, co]) => ({
    key, name: co.name,
    evidence: [
      ...[...co.mail].sort((a, b) => b[1] - a[1]).map(([value, rows]) => ({ source: "email_domain" as const, value, rows })),
      ...[...co.sites].sort((a, b) => b[1] - a[1]).map(([value, rows]) => ({ source: "form_website" as const, value, rows })),
    ],
  }));

  /* The list quality report. */
  const issues: Record<string, number> = {}, samples: Record<string, number[]> = {}, dropped: Record<string, number> = {};
  let clean = 0;
  for (const r of sourceRows) {
    const tags = [...new Set(r.issues)];
    for (const t of tags) { issues[t] = (issues[t] ?? 0) + 1; (samples[t] ??= []).length < 5 && samples[t].push(r.row_number); }
    if (r.drop_reason) dropped[r.drop_reason] = (dropped[r.drop_reason] ?? 0) + 1;
    if (!tags.length && !r.drop_reason) clean++;
  }
  const rows = sourceRows.length;
  const usable = sourceRows.filter((r) => !r.drop_reason).length;
  const messy = rows ? 1 - clean / rows : 0;
  const summary = Object.keys(ISSUE_WORDS).filter((t) => issues[t]).sort((a, b) => issues[b] - issues[a]).map((t) => `${issues[t]} rows with ${ISSUE_WORDS[t]}`);
  for (const [reason, n] of Object.entries(dropped).sort((a, b) => b[1] - a[1])) summary.push(`${n} rows dropped as ${reason.replace(/_/g, " ")}`);
  const quality: QualityReport = {
    rows, usable_rows: usable, clean_rows: clean, dropped, issues,
    shared_emails: { emails: sharedEmails, rows: sharedEmailRows },
    shared_domains: { domains: [...sharedDomains].sort(), rows: sharedDomainRows },
    samples, verdict: messy < 0.2 ? "good" : messy < 0.5 ? "fair" : "poor", summary,
  };
  return { companies: companyList, sourceRows, contacts, quality };
}
