/* The ICP in the database, and the six steps that make one
   (docs/TIERING-AND-ENRICHMENT.md, "Where an ICP comes from"):

     1. upload or paste a document           saveDocument   (data; nothing in it is ever an instruction)
     2. compile, after the cost is shown     startCompile   (one model call, capped at the estimate)
     3. gaps                                  getCompile     (what the document never says, and quotes it does not contain)
     4. confirm                               editDraft, confirmCompile
     5. test bench                            setBench, runBench, benchToExample
     6. publish as a version, with a diff     publishCompile

   One seller per install, so there is one line of versions. A published version is immutable. An event
   pins the current version when its Research card is approved (`pinIcp`). Nothing here spends against an
   event's ledger: the cost of compiling is its own estimate, shown first and held as a cap. */

import { createHash } from "node:crypto";
import Papa from "papaparse";
import type { Db } from "./db.ts";
import { newId, RuleError } from "./events.ts";
import { fill } from "./prompts.ts";
import type { Llm } from "./providers.ts";
import { validTier } from "../shared/tiers.ts";
import {
  baselineTier, checkQuotes, diffIcp, findGaps, findInstructions, renderIcp, sanitizeIcp, squash, tierByRules, SENIORITIES,
  type Firmo, type Gap, type Icp, type IcpDiff, type ItemRef, type Tier,
} from "../shared/icp.ts";

const MAX_DOC = 200_000;
const MIN_ACCURACY = 0.8;
const BENCH_LLM_CAP = 40;

/* -------------------------------------------------------------- documents */

/** A document can close the data block early only if it contains the marker, so the marker is broken. */
const neutralize = (text: string) => text.replaceAll("DOCUMENT>>>", "DOCUMENT> >>").replaceAll("<<<DOCUMENT", "<< <DOCUMENT");

export interface CompileEstimate {
  /** The most model calls the compile may use: one, and one retry if the answer cannot be read. */
  calls: number;
  expected_calls: number;
  tokens_in: number;
  tokens_out: number;
  cents: number;
  basis: string;
}

export function estimateCompile(text: string, llmCallCents: number): CompileEstimate {
  const promptChars = fill("icp_compile", { document: text }).length;
  return {
    calls: 2, expected_calls: 1, tokens_in: Math.ceil(promptChars / 4), tokens_out: Math.min(6000, 700 + Math.ceil(text.length / 5)),
    cents: 2 * llmCallCents, basis: "At most two AI calls (one retry if the answer cannot be read), at the configured price per call.",
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Step 1. Stores the text and opens a compile at `estimated`. Nothing is sent to a model. */
export async function saveDocument(db: Db, actor: string, filename: string, text: string, llmCallCents: number) {
  const clean = text.replace(/\r\n/g, "\n").replace(/\u0000/g, "");
  if (!clean.trim()) throw new RuleError("That document is empty.");
  if (clean.length > MAX_DOC) throw new RuleError(`That document is longer than ${MAX_DOC.toLocaleString("en-US")} characters.`);
  return db.tx(async (q) => {
    const documentId = newId("icpdoc"), compileId = newId("icpc");
    const [base] = await q<{ v: number | null }>("SELECT max(version)::int AS v FROM icp_versions");
    await q("INSERT INTO icp_documents (id, filename, text, sha256, uploaded_by) VALUES ($1, $2, $3, $4, $5)", [documentId, filename.slice(0, 200) || "pasted text", clean, sha(clean), actor]);
    const estimate = estimateCompile(clean, llmCallCents);
    await q("INSERT INTO icp_compiles (id, document_id, base_version, estimate, llm_cap, created_by) VALUES ($1, $2, $3, $4::jsonb, $5, $6)", [compileId, documentId, base.v, JSON.stringify(estimate), estimate.calls, actor]);
    return { compile_id: compileId, document_id: documentId, estimate };
  });
}

/* ---------------------------------------------------------------- compile */

interface CompileRow {
  id: string; document_id: string; status: string; base_version: number | null; estimate: CompileEstimate; llm_cap: number; llm_calls: number;
  draft: Icp | null; unsupported: ItemRef[]; bench: BenchState | null; version: number | null; error: string | null;
  confirmed_by: string | null; created_by: string; started_by: string | null;
}
const CCOLS = "id, document_id, status, base_version, estimate, llm_cap, llm_calls, draft, unsupported, bench, version, error, confirmed_by, created_by, started_by";

async function loadCompile(q: Db["query"], id: string, lock = false) {
  const [c] = await q<CompileRow>(`SELECT ${CCOLS} FROM icp_compiles WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!c) throw new RuleError("That compile does not exist.");
  return c;
}
const documentText = async (q: Db["query"], id: string) => (await q<{ text: string }>("SELECT text FROM icp_documents WHERE id = $1", [id]))[0].text;

function parseJson(text: string): unknown {
  try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; }
}

/** Step 2. A person has seen the estimate and sends back its price. The model reads the document and returns a draft; the draft is
    reduced to the schema, every quote is checked against the document, and nothing is applied. */
export async function startCompile(db: Db, compileId: string, actor: string, llm: Llm, acceptedCents: number) {
  const c = await db.tx(async (q) => {
    const row = await loadCompile(q, compileId, true);
    if (row.status !== "estimated" && row.status !== "failed") throw new RuleError("This compile has already started.");
    if (acceptedCents !== row.estimate.cents) throw new RuleError("Say you have seen the cost: send the estimate shown for this document.");
    return row;
  });
  const doc = await documentText(db.query, c.document_id);
  const prompt = fill("icp_compile", { document: neutralize(doc) });
  let used = c.llm_calls, raw: unknown = null, error = "";
  while (used < c.llm_cap && raw === null) {
    // The call is counted before it is made: an unknown outcome is a call spent.
    used++;
    await db.query("UPDATE icp_compiles SET llm_calls = $2, status = 'estimated', started_by = $3, updated_at = now() WHERE id = $1", [compileId, used, actor]);
    try { raw = parseJson((await llm.complete("icp_compile", prompt)).text); } catch (e) { error = e instanceof Error ? e.message : "The model could not be reached."; break; }
    if (raw === null || typeof raw !== "object") { raw = null; error = "The model's answer could not be read as a draft."; }
  }
  if (raw === null) {
    await db.query("UPDATE icp_compiles SET status = 'failed', error = $2, updated_at = now() WHERE id = $1", [compileId, `${error} ${used} of ${c.llm_cap} AI calls were used.`.trim()]);
    return getCompile(db, compileId);
  }
  const { icp, unsupported } = checkQuotes(sanitizeIcp(raw), doc);
  await db.query("UPDATE icp_compiles SET status = 'drafted', draft = $2::jsonb, unsupported = $3::jsonb, error = NULL, updated_at = now() WHERE id = $1", [compileId, JSON.stringify(icp), JSON.stringify(unsupported)]);
  return getCompile(db, compileId);
}

/* ------------------------------------------------------------------- view */

export interface RuleLine { key: string; section: string; id: string; group: "rules" | "people" | "lists" | "examples"; what: string; quote: string | null; unsupported: boolean; note?: string }

const segName = (icp: Icp, id: string) => (id === "*" ? "any other company" : icp.segments.find((s) => s.id === id)?.name ?? id);

/** The structure as plain lines, one per rule, in the order the confirm screen shows them. */
export function ruleLines(icp: Icp, unsupported: ItemRef[]): RuleLine[] {
  const bad = new Set(unsupported.map((u) => `${u.section}:${u.id}`));
  const L: RuleLine[] = [];
  const add = (section: string, id: string, group: RuleLine["group"], what: string, quote: string | null, note?: string) => L.push({ key: `${section}:${id}`, section, id, group, what, quote, unsupported: bad.has(`${section}:${id}`), ...(note ? { note } : {}) });
  if (icp.size) add("size", "size", "rules", `Company size: ${icp.size.min.toLocaleString("en-US")} to ${icp.size.max.toLocaleString("en-US")} employees`, icp.size.quote);
  if (icp.geography?.served?.length) add("geography", "geography", "rules", `Regions: ${icp.geography.served.join(", ")}`, icp.geography.quote);
  for (const h of icp.hard_rules) add("hard_rules", h.id, "rules", `Hard rule: ${h.text}`, h.quote, "Checked in code. A missing value is Unknown, never a failure.");
  for (const s of icp.segments) add("segments", s.id, "rules", `${s.stance === "strong" ? "Strong fit" : s.stance === "weak" ? "Weak fit" : "Partial fit"}: ${s.name}`, s.quote, s.keywords.length ? `Matched by the words: ${s.keywords.join(", ")}` : undefined);
  for (const t of icp.tier_definitions) add("tier_definitions", t.id, "rules", `Tier ${t.tier} for ${segName(icp, t.segment)}: ${t.text}`, t.quote, t.when ? `Applied in code: ${[t.when.employees === "in_range" ? "employees in range" : t.when.employees === "out_of_range" ? "employees out of range" : "", t.when.consumer_only === true ? "consumer-only" : t.when.consumer_only === false ? "not consumer-only" : ""].filter(Boolean).join(", ")}` : "No condition: this is the fallback for that group.");
  for (const p of icp.personas) add("personas", p.id, "people", `${p.priority === "primary" ? "Buyer" : "Also involved"}: ${p.function}${p.titles.length ? ` (${p.titles.join(", ")})` : ""}`, p.quote);
  for (const a of icp.title_adjustments) add("title_adjustments", a.id, "people", a.text, a.quote);
  for (const e of icp.lists.excluded) add("excluded", e.id, "lists", `Never contact: ${e.name}`, e.quote);
  for (const e of icp.lists.customers) add("customers", e.id, "lists", `Existing customer: ${e.name}`, e.quote);
  for (const e of icp.examples) add("examples", e.id, "examples", `Fits: ${e.company}, tier ${e.tier}. ${e.why}`, e.quote);
  for (const e of icp.counter_examples) add("counter_examples", e.id, "examples", `Looks right, is not: ${e.company}, tier ${e.tier}. ${e.why}`, e.quote);
  return L;
}

/** Where each quote sits in the document, so the screen can mark it. Whitespace may differ, so the search is by words. */
export function spansOf(doc: string, lines: RuleLine[]) {
  const spans: { start: number; end: number; key: string; n: number }[] = [];
  lines.forEach((l, i) => {
    if (!l.quote) return;
    const words = l.quote.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const m = new RegExp(words.join("\\s+"), "i").exec(doc);
    if (m) spans.push({ start: m.index, end: m.index + m[0].length, key: l.key, n: i + 1 });
  });
  // Overlaps would nest marks. The earlier line keeps the text.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: typeof spans = [];
  for (const s of spans) if (!out.length || s.start >= out[out.length - 1].end) out.push(s);
  return out;
}

const unsupportedLabel = (icp: Icp, u: ItemRef) => ruleLines(icp, []).find((l) => l.key === `${u.section}:${u.id}`)?.what ?? `${u.section} ${u.id}`;

export interface BenchItem { name: string; domain?: string; employees?: number | null; industry?: string | null; business_model?: string | null; description?: string | null; country?: string | null; expected: Tier; kind: "won" | "lost" | "bad_fit"; note?: string }
export interface BenchResult { name: string; kind: BenchItem["kind"]; expected: Tier; got: Tier | null; via: string; reason: string; fact: string | null; baseline: Tier; correct: boolean; baseline_correct: boolean }
export interface BenchState {
  set: BenchItem[];
  run: null | {
    at: string; by: string; draft_hash: string; results: BenchResult[]; accuracy: number; baseline_accuracy: number; unknown: number;
    /** An expected tier 3 that the ICP called tier 1: the costly kind of error. */
    tier3_as_tier1: number; model_calls: number;
  };
}
const draftHash = (icp: Icp) => sha(JSON.stringify(icp)).slice(0, 16);

export async function getCompile(db: Db, id: string) {
  const c = await loadCompile(db.query, id);
  const [d] = await db.query<{ filename: string; text: string; uploaded_by: string; created_at: string; sha256: string }>("SELECT filename, text, uploaded_by, created_at, sha256 FROM icp_documents WHERE id = $1", [c.document_id]);
  const [base] = c.base_version ? await db.query<{ icp: Icp }>("SELECT icp FROM icp_versions WHERE version = $1", [c.base_version]) : [];
  const draft = c.draft;
  const unsupported = c.unsupported ?? [];
  const gaps: Gap[] = draft ? [
    ...findGaps(draft),
    ...unsupported.map((u) => ({ id: `unsupported:${u.section}:${u.id}`, kind: "unsupported", text: `No passage supports: ${unsupportedLabel(draft, u)}`, ask: "Your document does not contain the passage the model quoted for this. Keep it as your own rule, or remove it." })),
  ] : [];
  const lines = draft ? ruleLines(draft, unsupported) : [];
  const diff: IcpDiff | null = draft ? diffIcp(base?.icp ?? null, draft) : null;
  const bench = c.bench ?? { set: [], run: null };
  const fresh = Boolean(draft && bench.run && bench.run.draft_hash === draftHash(draft));
  return {
    id: c.id, status: c.status, filename: d.filename, document: d.text, uploaded_by: d.uploaded_by, created_at: d.created_at, sha256: d.sha256,
    estimate: c.estimate, llm_cap: c.llm_cap, llm_calls: c.llm_calls, base_version: c.base_version, version: c.version, error: c.error, started_by: c.started_by, confirmed_by: c.confirmed_by,
    draft, gaps, lines, spans: draft ? spansOf(d.text, lines) : [], diff,
    // Sentences in the document that read like orders. They were read as text and had no effect.
    notices: findInstructions(d.text),
    bench: { set: bench.set, run: bench.run, fresh, min_accuracy: MIN_ACCURACY, estimate: { companies: bench.set.length, model_calls_at_most: draft ? Math.min(BENCH_LLM_CAP, bench.set.filter((b) => tierByRules(draft, b).tier === null).length) : 0 } },
  };
}

/* ------------------------------------------------------------------ edits */

export type Edit =
  | { op: "answer_gap"; gap: string; answer: Record<string, unknown> }
  | { op: "update"; section: string; id: string; fields: Record<string, unknown> }
  | { op: "remove"; section: string; id: string }
  | { op: "resolve_unsupported"; section: string; id: string; action: "keep" | "remove" };

const ARRAYS = ["hard_rules", "fit_dimensions", "segments", "company_types", "tier_definitions", "examples", "counter_examples", "personas", "title_adjustments"] as const;
const itemsOf = (icp: Icp, section: string): { id: string }[] | null =>
  (ARRAYS as readonly string[]).includes(section) ? ((icp as unknown as Record<string, { id: string }[]>)[section]) : section === "excluded" ? icp.lists.excluded : section === "customers" ? icp.lists.customers : null;

const asTier = (v: unknown): Tier => { if (v === 1 || v === 2 || v === 3) return v; throw new RuleError("A tier is 1, 2 or 3."); };
const people = (items: unknown) => (Array.isArray(items) ? items : []) as Record<string, unknown>[];

function applyEdit(icp: Icp, e: Edit): Icp {
  const next = structuredClone(icp);
  if (e.op === "answer_gap") {
    const a = e.answer;
    const accept = (k: string) => { if (!next.acknowledged.includes(k)) next.acknowledged.push(k); };
    const g = e.gap;
    if (g === "employee_range") {
      if (a.accept === true) accept("employee_range");
      else { const min = Number(a.min), max = Number(a.max); if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) throw new RuleError("Give a smallest and largest number of employees."); next.size = { min: Math.round(min), max: Math.round(max), quote: null }; }
    } else if (g === "region") {
      if (a.accept === true) accept("region");
      else { const served = (Array.isArray(a.served) ? a.served : String(a.served ?? "").split(/,|\n/)).map((x) => String(x).trim()).filter(Boolean); if (!served.length) throw new RuleError("Name at least one country, or confirm that no region rule is fine."); next.geography = { served, quote: null }; }
    } else if (g === "counter_examples" || g === "examples") {
      if (a.accept === true) accept(g);
      else {
        const rows = people(a.items);
        if (!rows.length) throw new RuleError("Name at least one company, or confirm that none is fine.");
        for (const r of rows) {
          const company = String(r.company ?? "").trim();
          if (!company) throw new RuleError("Each example needs a company.");
          (next[g] as unknown[]).push({ id: company.toLowerCase().replace(/[^a-z0-9]+/g, "_"), company, tier: asTier(Number(r.tier)), why: String(r.why ?? ""), quote: null });
        }
      }
    } else if (g === "personas") {
      if (a.accept === true) accept("personas");
      else {
        const rows = people(a.items);
        if (!rows.length) throw new RuleError("Name at least one buying role, or confirm that none is fine.");
        for (const r of rows) next.personas.push({ id: String(r.function ?? "role").toLowerCase().replace(/[^a-z0-9]+/g, "_"), segment: "*", function: String(r.function ?? ""), seniority_min: (SENIORITIES.includes(r.seniority_min as never) ? r.seniority_min : "manager") as never, seniority_max: (SENIORITIES.includes(r.seniority_max as never) ? r.seniority_max : "vp") as never, titles: String(r.titles ?? "").split(",").map((t) => t.trim()).filter(Boolean), priority: r.priority === "secondary" ? "secondary" : "primary", quote: null });
      }
    } else if (g.startsWith("tiers_")) {
      const seg = g.slice(6);
      if (a.accept === true) accept(g);
      else {
        const defs = people(a.defs);
        if (!defs.length) throw new RuleError("Say what makes each tier, or confirm that is fine.");
        for (const d of defs) next.tier_definitions.push({ id: `${seg}_t${d.tier}`, segment: seg, tier: asTier(Number(d.tier)), text: String(d.text ?? ""), quote: null, ...(d.employees === "in_range" || d.employees === "out_of_range" ? { when: { employees: d.employees } } : {}) });
      }
    } else if (g === "segments") {
      const rows = people(a.items);
      if (!rows.length) throw new RuleError("Name at least one group of companies.");
      for (const r of rows) next.segments.push({ id: String(r.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_"), name: String(r.name ?? ""), stance: r.stance === "weak" ? "weak" : r.stance === "partial" ? "partial" : "strong", keywords: String(r.keywords ?? r.name ?? "").split(",").map((k) => k.trim().toLowerCase()).filter(Boolean), definition: String(r.definition ?? ""), quote: null });
    } else throw new RuleError("That is not a gap in this draft.");
  } else if (e.op === "update") {
    if (e.section === "size") { const min = Number(e.fields.min), max = Number(e.fields.max); if (!(max >= min && min >= 0)) throw new RuleError("Give a smallest and largest number of employees."); next.size = { min: Math.round(min), max: Math.round(max), quote: null }; }
    else if (e.section === "geography") next.geography = { served: (Array.isArray(e.fields.served) ? e.fields.served : []).map(String), quote: null };
    else if (e.section === "summary") next.summary = String(e.fields.summary ?? "");
    else {
      const items = itemsOf(next, e.section);
      const item = items?.find((i) => i.id === e.id) as Record<string, unknown> | undefined;
      if (!item) throw new RuleError("That rule is not in the draft.");
      // A rule edited by a person no longer quotes the document.
      Object.assign(item, e.fields, { quote: null });
    }
  } else if (e.op === "remove") {
    const items = itemsOf(next, e.section);
    if (e.section === "size") next.size = null;
    else if (e.section === "geography") next.geography = null;
    else if (!items || !items.some((i) => i.id === e.id)) throw new RuleError("That rule is not in the draft.");
    else items.splice(items.findIndex((i) => i.id === e.id), 1);
  }
  return next;
}

/** Edits the working draft. Anything entered by a person quotes nothing. The result goes back through the schema, so a bad edit is refused, not stored. */
export async function editDraft(db: Db, compileId: string, actor: string, edit: Edit) {
  await db.tx(async (q) => {
    const c = await loadCompile(q, compileId, true);
    if (!c.draft || (c.status !== "drafted" && c.status !== "confirmed")) throw new RuleError("There is no draft to edit yet.");
    let unsupported = c.unsupported ?? [];
    let next: Icp;
    if (edit.op === "resolve_unsupported") {
      if (!unsupported.some((u) => u.section === edit.section && u.id === edit.id)) throw new RuleError("That item is not waiting on a decision.");
      unsupported = unsupported.filter((u) => !(u.section === edit.section && u.id === edit.id));
      next = edit.action === "remove" ? applyEdit(c.draft, { op: "remove", section: edit.section, id: edit.id }) : c.draft;
    } else {
      next = applyEdit(c.draft, edit);
      if (edit.op === "remove") unsupported = unsupported.filter((u) => !(u.section === edit.section && u.id === edit.id));
    }
    const clean = sanitizeIcp(next);
    clean.acknowledged = next.acknowledged.filter((k) => typeof k === "string");
    // An edit sends a confirmed draft back to drafted, except the examples a person adds from the test bench, which keep the confirmation.
    await q("UPDATE icp_compiles SET draft = $2::jsonb, unsupported = $3::jsonb, status = 'drafted', confirmed_by = NULL, confirmed_at = NULL, updated_at = now() WHERE id = $1", [compileId, JSON.stringify(clean), JSON.stringify(unsupported)]);
  });
  return getCompile(db, compileId);
}

/** Step 4. A person approves the draft. It must have no open gap and no item without a passage behind it. */
export async function confirmCompile(db: Db, compileId: string, actor: string) {
  await db.tx(async (q) => {
    const c = await loadCompile(q, compileId, true);
    if (c.status !== "drafted" || !c.draft) throw new RuleError("Only a draft can be confirmed.");
    const open = findGaps(c.draft);
    if (open.length) throw new RuleError(`${open.length} ${open.length === 1 ? "thing is" : "things are"} still open: ${open.map((g) => g.text).join("; ")}.`);
    if ((c.unsupported ?? []).length) throw new RuleError("Some items have no passage behind them. Keep them as your own rules or remove them first.");
    await q("UPDATE icp_compiles SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(), updated_at = now() WHERE id = $1", [compileId, actor]);
  });
  return getCompile(db, compileId);
}

/* ------------------------------------------------------------- test bench */

const num = (v: unknown) => { const n = Number(String(v ?? "").replace(/[,\s]/g, "")); return String(v ?? "").trim() !== "" && Number.isFinite(n) ? Math.round(n) : null; };
const KINDS = ["won", "lost", "bad_fit"] as const;

/** Companies the team already knows the answer to: JSON, or CSV with the columns name, employees, industry, business_model, expected_tier, kind, description, country, domain, note. */
export function parseBench(input: unknown): BenchItem[] {
  let rows: Record<string, unknown>[];
  if (Array.isArray(input)) rows = input as Record<string, unknown>[];
  else if (typeof input === "string") {
    const t = input.trim();
    if (t.startsWith("[")) { try { rows = JSON.parse(t); } catch { throw new RuleError("That list could not be read."); } }
    else rows = Papa.parse<Record<string, unknown>>(t, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_") }).data;
  } else throw new RuleError("Send the companies as a list or as CSV text.");
  const out: BenchItem[] = [];
  for (const r of rows.slice(0, 200)) {
    const name = String(r.name ?? r.company ?? "").trim();
    const expected = num(r.expected ?? r.expected_tier ?? r.tier);
    if (!name) continue;
    if (expected !== 1 && expected !== 2 && expected !== 3) throw new RuleError(`"${name}" needs an expected tier of 1, 2 or 3.`);
    const kind = KINDS.includes(String(r.kind) as never) ? (String(r.kind) as BenchItem["kind"]) : expected === 3 ? "bad_fit" : expected === 1 ? "won" : "lost";
    out.push({ name, ...(r.domain ? { domain: String(r.domain) } : {}), employees: num(r.employees), industry: r.industry ? String(r.industry) : null, business_model: r.business_model ? String(r.business_model) : null, description: r.description ? String(r.description).slice(0, 600) : null, country: r.country ? String(r.country) : null, expected, kind, ...(r.note ? { note: String(r.note).slice(0, 300) } : {}) });
  }
  if (!out.length) throw new RuleError("That list has no companies.");
  return out;
}

export async function setBench(db: Db, compileId: string, input: unknown) {
  const set = parseBench(input);
  await db.tx(async (q) => {
    const c = await loadCompile(q, compileId, true);
    if (c.status !== "confirmed") throw new RuleError("Confirm the draft before testing it.");
    await q("UPDATE icp_compiles SET bench = $2::jsonb, updated_at = now() WHERE id = $1", [compileId, JSON.stringify({ set, run: null } satisfies BenchState)]);
  });
  return getCompile(db, compileId);
}

/** Step 5. Tiers the companies with known answers: hard rules and tier definitions in code, the model only for a company the rules cannot decide.
    The model's tier is accepted only if it is valid and the ICP can name it; the baseline (size band plus keywords) is scored beside it. */
export async function runBench(db: Db, compileId: string, actor: string, llm: Llm) {
  const c = await loadCompile(db.query, compileId);
  if (c.status !== "confirmed" || !c.draft) throw new RuleError("Confirm the draft before testing it.");
  const set = c.bench?.set ?? [];
  if (!set.length) throw new RuleError("Add the companies you already know the answer to first.");
  const icp = c.draft;
  let calls = 0;
  const results: BenchResult[] = [];
  for (const b of set) {
    const f: Firmo = { employees: b.employees, industry: b.industry, business_model: b.business_model, description: b.description, country: b.country };
    const r = tierByRules(icp, f);
    let got = r.tier, via: string = r.via, reason = r.reason, fact = r.fact;
    if (got === null && calls < BENCH_LLM_CAP && r.unknown.length === 0) {
      calls++;
      try {
        const out = await llm.complete("company_tier", fill("company_tier", { icp: renderIcp(icp), input: [`Company: ${b.name}`, f.industry && `industry: ${f.industry}`, f.employees != null && `employees: ${f.employees}`, f.business_model && `sells to: ${f.business_model}`, f.description && `description: ${f.description}`].filter(Boolean).join("\n") }));
        const v = validTier(parseJson(out.text));
        // A model tier needs a fact to stand on. Without any supplied fact it stays Unknown.
        if (v && (r.fact || f.industry || f.employees != null)) { got = v.tier; via = "model"; reason = v.reason; fact = [f.industry, f.employees != null ? `${f.employees} employees` : ""].filter(Boolean).join("; "); }
      } catch { /* an unreachable model leaves the tier Unknown */ }
    }
    const baseline = baselineTier(icp, f);
    results.push({ name: b.name, kind: b.kind, expected: b.expected, got, via, reason, fact, baseline, correct: got === b.expected, baseline_correct: baseline === b.expected });
  }
  const n = results.length;
  const run = {
    at: new Date().toISOString(), by: actor, draft_hash: draftHash(icp), results,
    accuracy: results.filter((r) => r.correct).length / n, baseline_accuracy: results.filter((r) => r.baseline_correct).length / n,
    unknown: results.filter((r) => r.got === null).length, tier3_as_tier1: results.filter((r) => r.expected === 3 && r.got === 1).length, model_calls: calls,
  };
  await db.query("UPDATE icp_compiles SET bench = $2::jsonb, updated_at = now() WHERE id = $1", [compileId, JSON.stringify({ set, run })]);
  return getCompile(db, compileId);
}

/** A wrong answer, corrected: the company becomes a worked example (or a counter-example when it looked right and is not). The confirmation stands; the test must be run again. */
export async function benchToExample(db: Db, compileId: string, actor: string, name: string, why: string) {
  await db.tx(async (q) => {
    const c = await loadCompile(q, compileId, true);
    if (c.status !== "confirmed" || !c.draft) throw new RuleError("Confirm the draft before testing it.");
    const b = (c.bench?.set ?? []).find((x) => x.name === name);
    if (!b) throw new RuleError("That company is not in the test set.");
    const icp = structuredClone(c.draft);
    const id = b.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const section = b.expected === 3 ? "counter_examples" : "examples";
    if ([...icp.examples, ...icp.counter_examples].some((e) => e.id === id)) throw new RuleError("That company is already an example.");
    icp[section].push({ id, company: b.name, ...(b.domain ? { domain: b.domain } : {}), tier: b.expected, why: why.trim() || b.note || `Known answer from the test set (${b.kind.replace("_", " ")}).`, quote: null });
    await q("UPDATE icp_compiles SET draft = $2::jsonb, updated_at = now() WHERE id = $1", [compileId, JSON.stringify(sanitizeIcp(icp))]);
  });
  return getCompile(db, compileId);
}

/* ---------------------------------------------------------------- publish */

export async function currentVersion(q: Db["query"]) {
  const [v] = await q<{ version: number; icp: Icp; published_by: string; published_at: string; note: string | null; bench_accuracy: number | null; document_id: string | null }>(
    "SELECT version, icp, published_by, published_at, note, bench_accuracy::float AS bench_accuracy, document_id FROM icp_versions ORDER BY version DESC LIMIT 1");
  return v ?? null;
}

/** Step 6. Publishes the confirmed, tested draft as the next version. The test must have run on exactly this draft. */
export async function publishCompile(db: Db, compileId: string, actor: string, opts: { note?: string; accept_low?: boolean } = {}) {
  const out = await db.tx(async (q) => {
    const c = await loadCompile(q, compileId, true);
    if (c.status !== "confirmed" || !c.draft) throw new RuleError("Confirm the draft before publishing it.");
    const run = c.bench?.run;
    if (!run) throw new RuleError("Test the draft on companies you already know first.");
    if (run.draft_hash !== draftHash(c.draft)) throw new RuleError("The draft changed since it was tested. Run the test again.");
    if (run.accuracy < MIN_ACCURACY && !opts.accept_low) throw new RuleError(`The draft got ${Math.round(run.accuracy * 100)}% of the known companies right, below ${Math.round(MIN_ACCURACY * 100)}%. Correct the wrong ones, or publish anyway and say so.`);
    const cur = await currentVersion(q);
    if ((cur?.version ?? null) !== c.base_version) throw new RuleError("Another version was published since this document was uploaded. Upload the document again so the changes are read against the current version.");
    const version = (cur?.version ?? 0) + 1;
    const icp = { ...c.draft, last_reviewed: c.draft.last_reviewed || new Date().toISOString().slice(0, 10) };
    await q("INSERT INTO icp_versions (version, icp, document_id, compile_id, published_by, note, bench_accuracy) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7)", [version, JSON.stringify(icp), c.document_id, compileId, actor, opts.note?.trim() || null, run.accuracy]);
    await q("UPDATE icp_compiles SET status = 'published', version = $2, updated_at = now() WHERE id = $1", [compileId, version]);
    return version;
  });
  return { version: out, compile: await getCompile(db, compileId) };
}

/** Goes back from a confirmed draft to editing it. */
export async function reopenCompile(db: Db, compileId: string) {
  await db.tx(async (q) => {
    const c = await loadCompile(q, compileId, true);
    if (c.status !== "confirmed") throw new RuleError("Only a confirmed draft can be reopened.");
    await q("UPDATE icp_compiles SET status = 'drafted', confirmed_by = NULL, confirmed_at = NULL, updated_at = now() WHERE id = $1", [compileId]);
  });
  return getCompile(db, compileId);
}

export async function cancelCompile(db: Db, compileId: string) {
  await db.tx(async (q) => {
    const c = await loadCompile(q, compileId, true);
    if (c.status === "published") throw new RuleError("A published version cannot be cancelled.");
    await q("UPDATE icp_compiles SET status = 'cancelled', updated_at = now() WHERE id = $1", [compileId]);
  });
}

/** What the ICP screen reads: the current version, the history, and any compile in progress. */
export async function icpOverview(db: Db) {
  const cur = await currentVersion(db.query);
  const versions = await db.query<{ version: number; published_by: string; published_at: string; note: string | null; bench_accuracy: number | null }>(
    "SELECT version, published_by, published_at, note, bench_accuracy::float AS bench_accuracy FROM icp_versions ORDER BY version DESC");
  const open = await db.query<{ id: string; status: string; filename: string; created_by: string; created_at: string }>(
    `SELECT c.id, c.status, d.filename, c.created_by, c.created_at FROM icp_compiles c JOIN icp_documents d ON d.id = c.document_id
     WHERE c.status IN ('estimated', 'drafted', 'confirmed', 'failed') ORDER BY c.created_at DESC`);
  const doc = cur?.document_id ? (await db.query<{ filename: string; uploaded_by: string; created_at: string }>("SELECT filename, uploaded_by, created_at FROM icp_documents WHERE id = $1", [cur.document_id]))[0] ?? null : null;
  return { current: cur ? { ...cur, document: doc, lines: ruleLines(cur.icp, []) } : null, versions, open };
}

/** Called when an event's Research card is approved: the event keeps the version that was current at that moment. */
export async function pinIcp(q: Db["query"], eventId: string) {
  const [v] = await q<{ version: number }>("SELECT max(version)::int AS version FROM icp_versions");
  if (!v?.version) return null;
  await q("UPDATE events SET icp_version = $2, icp_pinned_at = now() WHERE id = $1 AND icp_version IS NULL AND parent_event_id IS NULL", [eventId, v.version]);
  return v.version;
}

export { squash };
