/* The ICP: who the seller wants as a customer, as a structured, versioned object
   (docs/TIERING-AND-ENRICHMENT.md, "The ICP"). This file is the code half of it, with no
   database and no model:

   - the shape, and `sanitizeIcp`, which turns anything a model returned into that shape and
     nothing else (closed lists, capped lengths, unknown keys dropped), so a document can never
     smuggle a field in through the model;
   - hard rules, which run in code. A rule fires only when the field is present: a missing value
     is Unknown, never a failure;
   - tier definitions per segment, applied in code where they carry a machine condition (`when`);
   - gaps, quote checking, a plain-words rendering, a diff between two versions;
   - a trivial baseline (size band plus keywords) that the model has to beat.

   Every rule-like item carries `quote`: the passage of the uploaded document it came from, or null
   when a person typed it. The document is data: nothing in it is ever an instruction. */

export type Tier = 1 | 2 | 3;
export const STANCES = ["strong", "partial", "weak"] as const;
export type Stance = (typeof STANCES)[number];
export const SENIORITIES = ["owner", "c_level", "vp", "director", "manager", "senior", "individual"] as const;
export type Seniority = (typeof SENIORITIES)[number];

export interface Sourced { quote: string | null }

/** Fields a hard rule may read. A rule never reads anything the vendor cannot supply as a plain value. */
export const HARD_FIELDS = ["employees", "business_model", "country", "industry"] as const;
export type HardField = (typeof HARD_FIELDS)[number];
export const HARD_OPS = ["min", "max", "in", "not_in", "contains_any"] as const;
export type HardOp = (typeof HARD_OPS)[number];
export interface HardRule extends Sourced { id: string; text: string; field: HardField; op: HardOp; value: number | string[] }

export interface Segment extends Sourced { id: string; name: string; stance: Stance; keywords: string[]; definition: string }
export interface TierWhen { employees?: "in_range" | "out_of_range"; consumer_only?: boolean }
export interface TierDefinition extends Sourced { id: string; segment: string; tier: Tier; text: string; when?: TierWhen }
export interface CompanyType { id: string; name: string; keywords: string[] }
export interface Example extends Sourced { id: string; company: string; domain?: string; tier: Tier; segment?: string; why: string }
export interface Persona extends Sourced { id: string; segment: string; function: string; seniority_min: Seniority; seniority_max: Seniority; titles: string[]; priority: "primary" | "secondary" }
export interface TitleAdjustment extends Sourced { id: string; company_type: string; size_band?: string; delta: -1 | 1; text: string }
export interface FitDimension extends Sourced { id: string; name: string; strong: string; partial: string; weak: string }
export interface ListEntry extends Sourced { id: string; name: string }

export interface Icp {
  seller: string;
  owner: string;
  /** YYYY-MM-DD. */
  last_reviewed: string;
  /** The ideal customer in words. The model reads this when it judges what code cannot. */
  summary: string;
  /** The in-range employee count. Null when the document gave none (a gap). */
  size: (Sourced & { min: number; max: number }) | null;
  /** Where the seller sells. `served` null means the document did not say (a gap, unless accepted). */
  geography: (Sourced & { served: string[] | null }) | null;
  hard_rules: HardRule[];
  fit_dimensions: FitDimension[];
  segments: Segment[];
  company_types: CompanyType[];
  tier_definitions: TierDefinition[];
  examples: Example[];
  counter_examples: Example[];
  personas: Persona[];
  title_adjustments: TitleAdjustment[];
  lists: { excluded: ListEntry[]; customers: ListEntry[] };
  /** Gap kinds a person confirmed are fine as they are. */
  acknowledged: string[];
}

export const emptyIcp = (): Icp => ({
  seller: "", owner: "", last_reviewed: "", summary: "", size: null, geography: null, hard_rules: [], fit_dimensions: [], segments: [], company_types: [],
  tier_definitions: [], examples: [], counter_examples: [], personas: [], title_adjustments: [], lists: { excluded: [], customers: [] }, acknowledged: [],
});

/* ------------------------------------------------------------ sanitizing */

const MAX_ITEMS = 60;
const str = (v: unknown, max = 400) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const strList = (v: unknown, max = 40) => (Array.isArray(v) ? v.map((x) => str(x, 80)).filter(Boolean).slice(0, max) : []);
const quoteOf = (v: unknown) => { const q = str((v as { quote?: unknown } | null)?.quote, 600); return q || null; };
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "item";
const tierOf = (v: unknown): Tier | null => (v === 1 || v === 2 || v === 3 ? v : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e9 ? Math.round(v) : null);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)).slice(0, MAX_ITEMS) : []);
const ids = <T extends { id: string }>(items: T[]) => { const seen = new Set<string>(); return items.map((it) => { let id = it.id, n = 2; while (seen.has(id)) id = `${it.id}_${n++}`; seen.add(id); return { ...it, id }; }); };

/** Turns whatever a model returned into an Icp. Unknown keys, values off a closed list and over-long text are dropped, never kept. */
export function sanitizeIcp(raw: unknown): Icp {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = emptyIcp();
  out.seller = str(r.seller, 120); out.owner = str(r.owner, 120); out.last_reviewed = /^\d{4}-\d{2}-\d{2}$/.test(str(r.last_reviewed, 10)) ? str(r.last_reviewed, 10) : "";
  out.summary = str(r.summary, 1200);

  const size = r.size as Record<string, unknown> | null | undefined;
  if (size && typeof size === "object") { const min = num(size.min), max = num(size.max); if (min !== null && max !== null && min <= max) out.size = { min, max, quote: quoteOf(size) }; }
  const geo = r.geography as Record<string, unknown> | null | undefined;
  if (geo && typeof geo === "object") out.geography = { served: Array.isArray(geo.served) ? strList(geo.served) : null, quote: quoteOf(geo) };

  out.hard_rules = ids(arr(r.hard_rules).flatMap((h): HardRule[] => {
    const field = oneOf(HARD_FIELDS, h.field), op = oneOf(HARD_OPS, h.op), text = str(h.text);
    if (!field || !op || !text) return [];
    const numeric = op === "min" || op === "max";
    const value = numeric ? num(h.value) : strList(h.value);
    if (value === null || (Array.isArray(value) && !value.length)) return [];
    if (numeric !== (field === "employees")) return [];
    return [{ id: str(h.id, 40) || slug(text), text, field, op, value, quote: quoteOf(h) }];
  }));
  out.fit_dimensions = ids(arr(r.fit_dimensions).flatMap((d): FitDimension[] => {
    const name = str(d.name, 120);
    return name ? [{ id: str(d.id, 40) || slug(name), name, strong: str(d.strong), partial: str(d.partial), weak: str(d.weak), quote: quoteOf(d) }] : [];
  }));
  out.segments = ids(arr(r.segments).flatMap((s): Segment[] => {
    const name = str(s.name, 120), stance = oneOf(STANCES, s.stance);
    return name && stance ? [{ id: str(s.id, 40) || slug(name), name, stance, keywords: strList(s.keywords).map((k) => k.toLowerCase()), definition: str(s.definition), quote: quoteOf(s) }] : [];
  }));
  out.company_types = ids(arr(r.company_types).flatMap((c): CompanyType[] => {
    const name = str(c.name, 80);
    return name ? [{ id: str(c.id, 40) || slug(name), name, keywords: strList(c.keywords).map((k) => k.toLowerCase()) }] : [];
  }));
  out.tier_definitions = ids(arr(r.tier_definitions).flatMap((t): TierDefinition[] => {
    const tier = tierOf(t.tier), segment = str(t.segment, 40), text = str(t.text);
    if (!tier || !segment || !text) return [];
    const w = t.when as Record<string, unknown> | null | undefined;
    const when: TierWhen = {};
    if (w && typeof w === "object") {
      const e = oneOf(["in_range", "out_of_range"] as const, w.employees); if (e) when.employees = e;
      if (typeof w.consumer_only === "boolean") when.consumer_only = w.consumer_only;
    }
    return [{ id: str(t.id, 40) || `${segment}_t${tier}`, segment, tier, text, ...(Object.keys(when).length ? { when } : {}), quote: quoteOf(t) }];
  }));
  const example = (e: Record<string, unknown>): Example[] => {
    const company = str(e.company, 120), tier = tierOf(e.tier);
    return company && tier ? [{ id: str(e.id, 40) || slug(company), company, ...(str(e.domain, 120) ? { domain: str(e.domain, 120).toLowerCase() } : {}), tier, ...(str(e.segment, 40) ? { segment: str(e.segment, 40) } : {}), why: str(e.why), quote: quoteOf(e) }] : [];
  };
  out.examples = ids(arr(r.examples).flatMap(example));
  out.counter_examples = ids(arr(r.counter_examples).flatMap(example));
  out.personas = ids(arr(r.personas).flatMap((p): Persona[] => {
    const fn = str(p.function, 120), lo = oneOf(SENIORITIES, p.seniority_min), hi = oneOf(SENIORITIES, p.seniority_max);
    if (!fn || !lo || !hi) return [];
    return [{ id: str(p.id, 40) || slug(`${p.segment ?? "all"} ${fn}`), segment: str(p.segment, 40) || "*", function: fn, seniority_min: lo, seniority_max: hi, titles: strList(p.titles), priority: p.priority === "secondary" ? "secondary" : "primary", quote: quoteOf(p) }];
  }));
  out.title_adjustments = ids(arr(r.title_adjustments).flatMap((a): TitleAdjustment[] => {
    const ct = str(a.company_type, 60), text = str(a.text);
    return ct && text && (a.delta === 1 || a.delta === -1) ? [{ id: str(a.id, 40) || slug(`${ct} ${a.delta}`), company_type: ct, ...(str(a.size_band, 40) ? { size_band: str(a.size_band, 40) } : {}), delta: a.delta, text, quote: quoteOf(a) }] : [];
  }));
  const lists = (r.lists ?? {}) as Record<string, unknown>;
  const entry = (e: Record<string, unknown>): ListEntry[] => { const name = str(e.name, 120); return name ? [{ id: str(e.id, 40) || slug(name), name, quote: quoteOf(e) }] : []; };
  out.lists = { excluded: ids(arr(lists.excluded).flatMap(entry)), customers: ids(arr(lists.customers).flatMap(entry)) };
  out.acknowledged = strList(r.acknowledged, 20);
  return out;
}

/* ------------------------------------------------------------- the passages */

/** Whitespace and quote style do not matter when checking that a quote is really in the document. */
export const squash = (s: string) => s.toLowerCase().replace(/[‘’‛]/g, "'").replace(/[“”„]/g, '"').replace(/\s+/g, " ").trim();

export type ItemRef = { section: string; id: string; quote: string | null };
/** Every item that claims a passage, so quotes can be checked and highlighted. */
export function quotedItems(icp: Icp): ItemRef[] {
  const out: ItemRef[] = [];
  const add = (section: string, items: { id: string; quote: string | null }[]) => items.forEach((i) => out.push({ section, id: i.id, quote: i.quote }));
  if (icp.size) out.push({ section: "size", id: "size", quote: icp.size.quote });
  if (icp.geography) out.push({ section: "geography", id: "geography", quote: icp.geography.quote });
  add("hard_rules", icp.hard_rules); add("fit_dimensions", icp.fit_dimensions); add("segments", icp.segments); add("tier_definitions", icp.tier_definitions);
  add("examples", icp.examples); add("counter_examples", icp.counter_examples); add("personas", icp.personas); add("title_adjustments", icp.title_adjustments);
  add("excluded", icp.lists.excluded); add("customers", icp.lists.customers);
  return out;
}

/** A quote the document does not contain is removed from the item and returned, so the structure never claims a passage that is not there. */
export function checkQuotes(icp: Icp, documentText: string): { icp: Icp; unsupported: ItemRef[] } {
  const doc = squash(documentText);
  const unsupported: ItemRef[] = [];
  const copy = structuredClone(icp);
  const bad = (q: string | null) => q !== null && !doc.includes(squash(q));
  const fix = (section: string, item: { id: string; quote: string | null }) => { if (bad(item.quote)) { unsupported.push({ section, id: item.id, quote: item.quote }); item.quote = null; } };
  if (copy.size) fix("size", { id: "size", get quote() { return copy.size!.quote; }, set quote(v) { copy.size!.quote = v; } });
  if (copy.geography) fix("geography", { id: "geography", get quote() { return copy.geography!.quote; }, set quote(v) { copy.geography!.quote = v; } });
  const lists: [string, { id: string; quote: string | null }[]][] = [
    ["hard_rules", copy.hard_rules], ["fit_dimensions", copy.fit_dimensions], ["segments", copy.segments], ["tier_definitions", copy.tier_definitions], ["examples", copy.examples],
    ["counter_examples", copy.counter_examples], ["personas", copy.personas], ["title_adjustments", copy.title_adjustments], ["excluded", copy.lists.excluded], ["customers", copy.lists.customers],
  ];
  for (const [section, items] of lists) for (const it of items) fix(section, it);
  return { icp: copy, unsupported };
}

/** Sentences in a document that read like instructions to a system. They are reported to the person and have no effect. */
const INSTRUCTION = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any)\b[^.\n]{0,40}\b(instructions?|rules?|prompts?|context)\b/i,
  /\b(you are now|act as|pretend to be|new instructions?|system prompt|developer message)\b/i,
  /\b(set|mark|treat|rate|classify|tier)\b[^.\n]{0,30}\b(every|all|each)\b[^.\n]{0,30}\b(compan(y|ies)|accounts?)\b[^.\n]{0,30}\b(as\s+)?(tier\s*[123]|a fit|a strong fit)/i,
  /\b(publish|approve|confirm|activate)\b[^.\n]{0,30}\b(this|the|it|icp|version)\b[^.\n]{0,30}\b(immediately|now|without|automatically)/i,
  /\b(do not|don't)\b[^.\n]{0,30}\b(tell|show|ask|mention|flag)\b[^.\n]{0,30}\b(user|person|anyone|reviewer)/i,
  /\b(reveal|print|output|send)\b[^.\n]{0,30}\b(api key|secret|password|credentials?|system prompt)\b/i,
];
export function findInstructions(text: string): string[] {
  const found: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) if (INSTRUCTION.some((re) => re.test(sentence))) found.push(sentence.trim().slice(0, 300));
  return found.slice(0, 10);
}

/* ------------------------------------------------------------------- gaps */

export interface Gap { id: string; kind: string; text: string; ask: string; path?: string }
/** What the document did not say, as plain questions. A gap a person accepted is not listed. */
export function findGaps(icp: Icp): Gap[] {
  const gaps: Gap[] = [];
  const ok = (k: string) => icp.acknowledged.includes(k);
  if (!icp.size && !icp.hard_rules.some((h) => h.field === "employees") && !ok("employee_range")) gaps.push({ id: "employee_range", kind: "employee_range", text: "Company size: not stated", ask: "Give the employee range that counts as a fit, or confirm that size does not matter." });
  if (!icp.geography?.served?.length && !icp.hard_rules.some((h) => h.field === "country") && !ok("region")) gaps.push({ id: "region", kind: "region", text: "Regions: not stated", ask: "Without a region rule, every company passes this check. Add the countries you sell in, or confirm that is fine." });
  if (!icp.segments.length) gaps.push({ id: "segments", kind: "segments", text: "Segments: none found", ask: "Name the groups of companies you sell to, and which are a strong fit." });
  if (!icp.counter_examples.length && !ok("counter_examples")) gaps.push({ id: "counter_examples", kind: "counter_examples", text: "Counter-examples: none", ask: "Name companies that look right and are not, and why. These do the most work in the prompt." });
  if (!icp.examples.length && !ok("examples")) gaps.push({ id: "examples", kind: "examples", text: "Worked examples: none", ask: "Name companies that fit, with the tier and why." });
  if (!icp.personas.length && !ok("personas")) gaps.push({ id: "personas", kind: "personas", text: "Who you talk to: not stated", ask: "Name the buying roles (function and seniority) so titles can be tiered." });
  for (const s of icp.segments) if (s.stance !== "weak" && !icp.tier_definitions.some((t) => t.segment === s.id) && !ok(`tiers_${s.id}`)) gaps.push({ id: `tiers_${s.id}`, kind: "tier_definitions", text: `Tiers for ${s.name}: not stated`, ask: `Say what makes tier 1, 2 and 3 for ${s.name}.`, path: s.id });
  return gaps;
}

/* ------------------------------------------------------------- hard rules */

/** What the vendors supply, as plain values. Any field can be missing. */
export interface Firmo { employees?: number | null; business_model?: string | null; industry?: string | null; description?: string | null; country?: string | null; segment?: string | null }
const has = (v: unknown) => v !== null && v !== undefined && v !== "";

/** Which rules fail, and which could not be checked because the field is missing. A missing value is Unknown, never a failure. */
export function evalHardRules(icp: Icp, f: Firmo): { failed: HardRule[]; unknown: HardRule[] } {
  const failed: HardRule[] = [], unknown: HardRule[] = [];
  for (const r of icp.hard_rules) {
    const v = f[r.field];
    if (!has(v)) { unknown.push(r); continue; }
    const text = String(v).toLowerCase();
    const list = Array.isArray(r.value) ? r.value.map((x) => x.toLowerCase()) : [];
    // A rule states what must hold ("business model is B2B"): the company fails when it does not.
    const holds =
      r.op === "min" ? Number(v) >= (r.value as number)
      : r.op === "max" ? Number(v) <= (r.value as number)
      : r.op === "in" ? list.includes(text)
      : r.op === "not_in" ? !list.includes(text)
      : list.some((k) => text.includes(k));
    if (!holds) failed.push(r);
  }
  return { failed, unknown };
}

export const sizeBand = (n: number) => (n < 50 ? "under 50" : n < 200 ? "50 to 199" : n < 1000 ? "200 to 999" : n < 5000 ? "1000 to 4999" : "5000 and over");

/* ----------------------------------------------------------- tier by rules */

export interface RuleTier {
  tier: Tier | null;
  segment: string | null;
  via: "hard_rule" | "tier_definition" | "none";
  reason: string;
  /** The fact the tier relied on, in words. A tier citing nothing is Unknown. */
  fact: string | null;
  /** Fields that were missing and would have been needed. */
  unknown: string[];
}

const haystack = (f: Firmo) => `${f.segment ?? ""} ${f.industry ?? ""}`.toLowerCase();
/** The segment whose keyword matches the company's industry, the longest keyword winning. A description is read only when the industry says nothing. */
export function matchSegment(icp: Icp, f: Firmo): Segment | null {
  const find = (text: string) => {
    let best: { s: Segment; len: number } | null = null;
    for (const s of icp.segments) for (const k of [s.name.toLowerCase(), ...s.keywords]) if (k && text.includes(k) && (!best || k.length > best.len)) best = { s, len: k.length };
    return best?.s ?? null;
  };
  return find(haystack(f)) ?? (f.description ? find(f.description.toLowerCase()) : null);
}

const factOf = (f: Firmo) => [has(f.employees) && `${f.employees} employees`, has(f.industry) && `industry: ${f.industry}`, has(f.business_model) && `sells to: ${f.business_model}`].filter(Boolean).join("; ") || null;

/** Applies the hard rules, then the segment's tier definitions in order, then the definitions for any other company. A definition without a condition is the fallback for its segment. When a field a condition needs is missing the answer is Unknown. */
export function tierByRules(icp: Icp, f: Firmo): RuleTier {
  const fact = factOf(f);
  const { failed } = evalHardRules(icp, f);
  if (failed.length) return { tier: 3, segment: matchSegment(icp, f)?.id ?? null, via: "hard_rule", reason: "outside_icp", fact: `${failed[0].text} (${fact ?? "no data"})`, unknown: [] };
  const seg = matchSegment(icp, f);
  const range = icp.size;
  const inRange = !range || !has(f.employees) ? null : f.employees! >= range.min && f.employees! <= range.max;
  const consumer = has(f.business_model) ? String(f.business_model).toUpperCase() === "B2C" : null;
  const unknown = new Set<string>();
  const defs = [...icp.tier_definitions.filter((t) => seg && t.segment === seg.id), ...icp.tier_definitions.filter((t) => t.segment === "*")];
  for (const d of defs) {
    // A definition with no condition is the fallback for its segment: it matches whatever is left.
    let match = true;
    if (d.when?.employees) {
      if (inRange === null) { unknown.add("employees"); match = false; }
      else if ((d.when.employees === "in_range") !== inRange) match = false;
    }
    if (d.when?.consumer_only !== undefined) {
      if (consumer === null) { unknown.add("business_model"); match = false; }
      else if (d.when.consumer_only !== consumer) match = false;
    }
    // A condition that could not be checked is Unknown, never a quiet fall through to a lower tier.
    if (unknown.size) break;
    if (match) return { tier: d.tier, segment: seg?.id ?? null, via: "tier_definition", reason: d.tier === 1 ? "icp_match" : d.tier === 2 ? "partial_icp_match" : "outside_icp", fact, unknown: [] };
  }
  return { tier: null, segment: seg?.id ?? null, via: "none", reason: "insufficient_information", fact: null, unknown: [...unknown] };
}

/** The benchmark: size band plus keywords, nothing else. It ignores consumer-only and weak segments, which is what the model has to beat. */
export function baselineTier(icp: Icp, f: Firmo): Tier {
  const range = icp.size;
  const inRange = range && has(f.employees) ? f.employees! >= range.min && f.employees! <= range.max : false;
  const strongWords = icp.segments.filter((s) => s.stance === "strong").flatMap((s) => [s.name.toLowerCase(), ...s.keywords]);
  const text = haystack(f);
  const kw = strongWords.some((k) => k && text.includes(k));
  return inRange && kw ? 1 : inRange || kw ? 2 : 3;
}

/* --------------------------------------------------------------- rendering */

/** The ICP as plain lines, for the prompt and for the confirm screen. */
export function renderIcp(icp: Icp): string {
  const L: string[] = [];
  if (icp.summary) L.push(icp.summary);
  if (icp.size) L.push(`Size: ${icp.size.min} to ${icp.size.max} employees.`);
  if (icp.geography?.served?.length) L.push(`Sold in: ${icp.geography.served.join(", ")}.`);
  for (const h of icp.hard_rules) L.push(`Rule (checked in code): ${h.text}`);
  for (const s of icp.segments) L.push(`Segment ${s.name} (${s.stance} fit): ${s.definition}`);
  for (const t of icp.tier_definitions) L.push(`Tier ${t.tier} for ${t.segment === "*" ? "any other company" : t.segment}: ${t.text}`);
  for (const e of icp.examples) L.push(`Example: ${e.company} is tier ${e.tier}. ${e.why}`);
  for (const e of icp.counter_examples) L.push(`Counter-example: ${e.company} looks right and is tier ${e.tier}. ${e.why}`);
  return L.join("\n");
}

const sizeWords = (s: Icp["size"]) => (s ? `${s.min} to ${s.max} employees` : "not stated");
const hardWords = (h: HardRule) => h.text;

/* -------------------------------------------------------------------- diff */

export interface IcpChange { section: string; kind: "added" | "removed" | "changed"; key: string; before?: string; after?: string; text: string }
export interface IcpDiff { same: boolean; changes: IcpChange[] }

/** What a revised document changes against the current version, in plain words. Nothing here is applied. */
export function diffIcp(a: Icp | null, b: Icp): IcpDiff {
  const changes: IcpChange[] = [];
  const A = a ?? emptyIcp();
  const scalar = (section: string, key: string, before: string, after: string, label: string) => {
    if (before === after) return;
    changes.push({ section, kind: before ? (after ? "changed" : "removed") : "added", key, before, after, text: before && after ? `${label} changes from ${before} to ${after}.` : after ? `${label} is now ${after}.` : `${label} is no longer set.` });
  };
  scalar("summary", "summary", A.summary, b.summary, "The ideal customer in words");
  scalar("size", "size", sizeWords(A.size), sizeWords(b.size), "Company size");
  scalar("geography", "geography", (A.geography?.served ?? []).join(", "), (b.geography?.served ?? []).join(", "), "Regions");
  const items = <T extends { id: string }>(section: string, label: string, x: T[], y: T[], show: (t: T) => string) => {
    const mx = new Map(x.map((i) => [i.id, i])), my = new Map(y.map((i) => [i.id, i]));
    for (const [id, i] of my) {
      const old = mx.get(id);
      if (!old) changes.push({ section, kind: "added", key: id, after: show(i), text: `${label} added: ${show(i)}` });
      else {
        const s0 = show(old), s1 = show(i);
        const j0 = JSON.stringify({ ...old, quote: null }), j1 = JSON.stringify({ ...i, quote: null });
        if (j0 !== j1) changes.push({ section, kind: "changed", key: id, before: s0, after: s1, text: s0 !== s1 ? `${label} changed from "${s0}" to "${s1}".` : `${label} "${s1}" changed in its details.` });
      }
    }
    for (const [id, i] of mx) if (!my.has(id)) changes.push({ section, kind: "removed", key: id, before: show(i), text: `${label} removed: ${show(i)}` });
  };
  items("hard_rules", "Hard rule", A.hard_rules, b.hard_rules, hardWords);
  items("segments", "Segment", A.segments, b.segments, (s) => `${s.name} (${s.stance} fit)`);
  items("tier_definitions", "Tier definition", A.tier_definitions, b.tier_definitions, (t) => `tier ${t.tier} for ${t.segment}: ${t.text}`);
  items("examples", "Example", A.examples, b.examples, (e) => `${e.company}, tier ${e.tier}`);
  items("counter_examples", "Counter-example", A.counter_examples, b.counter_examples, (e) => `${e.company}, tier ${e.tier}`);
  items("personas", "Persona", A.personas, b.personas, (p) => `${p.function} (${p.segment})`);
  items("title_adjustments", "Title adjustment", A.title_adjustments, b.title_adjustments, (t) => t.text);
  items("excluded", "Never-contact entry", A.lists.excluded, b.lists.excluded, (l) => l.name);
  items("customers", "Customer entry", A.lists.customers, b.lists.customers, (l) => l.name);
  return { same: changes.length === 0, changes };
}

/** The headline count for the confirm screen: how many rules the document became. */
export function ruleCount(icp: Icp) {
  return (icp.size ? 1 : 0) + icp.hard_rules.length + icp.segments.length + icp.personas.length + icp.lists.excluded.length + icp.lists.customers.length + icp.tier_definitions.length;
}
