/* Which events to repeat (docs/CHOOSING.md, section 8). Counts, a comparison of groups of past events corrected for the number of comparisons, and "too few to say"
   when there are too few. The method is Account Desk's suggestions.py with the deviations the spec lists (decision 99). A model may word a pattern that passes,
   and its words are shown only if code checks them against the counts. A person records Repeat or Drop. */

import { createHash } from "node:crypto";
import type { Db } from "./db.ts";
import { newId } from "./events.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { isLead } from "./money.ts";
import { Forbidden } from "./seats.ts";
import { Invalid, seriesKeyWith, seriesLinks } from "./overlap.ts";
import { allowedFrom, numbersIn, sentencesOf, unknownName, collapse } from "./perspective-check.ts";
import { todayOf } from "./plan.ts";
import { fill } from "./prompts.ts";
import type { Llm } from "./providers.ts";
import { writtenCards } from "./ranking.ts";
import { fisherGreater } from "./stats.ts";

/** The thresholds, in one place and shown on the screen. */
export const REPEAT_RULE = {
  /** A pair is looked at when the group and the rest each hold at least this many events (a condition on the margins only). */
  min_events: 5,
  /** A pattern passes only when at least this many events in the group met their goal. */
  min_goal_met: 3,
  alpha: 0.05,
  /** At most this many wordings per reading. */
  max_wordings: 6,
  words: "A group is compared with the rest only when it holds at least 5 events and the rest hold at least 5. A pattern passes when at least 3 events in the group met their goal, the group did better than the rest, and the chance of that happening by luck is below 0.05 divided by the number of groups compared.",
} as const;

export const GROUPINGS = ["size", "involvement", "region"] as const;
export type Grouping = (typeof GROUPINGS)[number];

/* ------------------------------------------------------------------ units */

export interface Unit {
  id: string; name: string; year: number; series_key: string;
  size: string | null; region: string; involvement: string[];
  held: number; goal: number | null; cost_cents: number; held_per_thousand: number | null;
}

const EUROPE = new Set(["albania", "andorra", "austria", "belgium", "bulgaria", "croatia", "cyprus", "czechia", "czech republic", "denmark", "estonia", "finland", "france", "germany", "greece", "hungary", "iceland", "ireland", "italy", "latvia", "liechtenstein", "lithuania", "luxembourg", "malta", "monaco", "netherlands", "norway", "poland", "portugal", "romania", "serbia", "slovakia", "slovenia", "spain", "sweden", "switzerland", "united kingdom", "ukraine"]);
const EUROPE_CODES = new Set(["al", "ad", "at", "be", "bg", "hr", "cy", "cz", "dk", "ee", "fi", "fr", "de", "gr", "hu", "is", "ie", "it", "lv", "li", "lt", "lu", "mt", "mc", "nl", "no", "pl", "pt", "ro", "rs", "sk", "si", "es", "se", "ch", "gb", "uk", "ua"]);
const NORTH_AMERICA = new Set(["united states", "canada", "mexico", "usa", "us", "ca", "mx"]);
export const regionOf = (country: string | null | undefined): string => {
  const c = (country ?? "").trim().toLowerCase();
  return NORTH_AMERICA.has(c) ? "North America" : EUROPE.has(c) || EUROPE_CODES.has(c) ? "Europe" : "Other";
};
export const SIZE_WORDS: Record<string, string> = { flagship: "Flagship", regional: "Regional", small: "Small", webinar: "Webinar", dinner: "Dinner" };
export const INVOLVEMENT_WORDS: Record<string, string> = { sponsorship: "a sponsorship", talk: "a talk", side_event: "a side event of our own" };

/** Past conferences with a written scorecard, one unit each (the latest window): ended, not a top-up, not hosted. */
export async function pastUnits(db: Db, deps?: Pick<LifecycleDeps, "now">): Promise<Unit[]> {
  const today = todayOf(deps);
  const links = await seriesLinks(db);
  const cards = new Map((await writtenCards(db)).map((c) => [c.event_id, c]));
  const rows = await db.query<{ id: string; name: string; starts_on: string; goal: number | null; size: string | null; country: string | null; sponsorship: boolean; talk: boolean; side: boolean }>(
    `SELECT e.id, e.name, e.starts_on::text AS starts_on, e.goal_meetings_held AS goal, c.size, coalesce(c.country, e.country) AS country,
            EXISTS (SELECT 1 FROM involvements i WHERE i.event_id = e.id AND i.kind = 'sponsorship' AND i.status <> 'dropped') AS sponsorship,
            EXISTS (SELECT 1 FROM involvements i WHERE i.event_id = e.id AND i.kind = 'talk' AND i.status <> 'dropped') AS talk,
            EXISTS (SELECT 1 FROM involvements i WHERE i.conference_event_id = e.id AND i.kind = 'hosted' AND i.status <> 'dropped') AS side
     FROM events e LEFT JOIN catalog_events c ON c.id = e.catalog_id
     WHERE e.parent_event_id IS NULL AND coalesce(e.ends_on, e.starts_on) < $1::date
       AND NOT EXISTS (SELECT 1 FROM hosted_events h WHERE h.event_id = e.id) AND NOT EXISTS (SELECT 1 FROM involvements i WHERE i.event_id = e.id AND i.kind = 'hosted')
     ORDER BY e.starts_on, e.id`, [today]);
  const out: Unit[] = [];
  for (const r of rows) {
    const card = cards.get(r.id);
    if (!card) continue;
    out.push({
      id: r.id, name: r.name, year: Number(r.starts_on.slice(0, 4)), series_key: seriesKeyWith(links, r.name), size: r.size, region: regionOf(r.country),
      involvement: [...(r.sponsorship ? ["sponsorship"] : []), ...(r.talk ? ["talk"] : []), ...(r.side ? ["side_event"] : [])],
      held: card.metrics.held_all, goal: r.goal && r.goal > 0 ? r.goal : null, cost_cents: card.metrics.cost.dollars_cents, held_per_thousand: card.metrics.score?.held_per_thousand ?? null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ the patterns (pure) */

export interface Pattern {
  key: string; grouping: Grouping; group: string; label: string; label_out: string;
  n_in: number; k: number; m: number; total: number; n_out: number; k_out: number;
  looked_at: boolean; p: number | null; alpha_each: number | null; passes: boolean;
  status: "passes" | "no_clear_difference" | "too_few";
  counts: string;
}

const met = (u: Unit) => u.goal !== null && u.held >= u.goal;

function groupsOf(g: Grouping, u: Unit): { group: string; in: boolean }[] {
  if (g === "size") return u.size ? [{ group: u.size, in: true }] : [];
  if (g === "region") return [{ group: u.region, in: true }];
  return Object.keys(INVOLVEMENT_WORDS).map((k) => ({ group: k, in: u.involvement.includes(k) }));
}
function labelsOf(g: Grouping, group: string): { label: string; label_out: string } {
  if (g === "size") return { label: `${SIZE_WORDS[group] ?? group[0].toUpperCase() + group.slice(1)} events`, label_out: "the others" };
  if (g === "region") return { label: `Events in ${group}`, label_out: "the others" };
  return { label: `Events with ${INVOLVEMENT_WORDS[group] ?? group}`, label_out: "the others" };
}

/** The counts for every group of every grouping, the correction, and which patterns pass. Pure: the same units give the same answer in any order. */
export function analyze(units: Unit[]) {
  const scored = units.filter((u) => u.goal !== null);
  const no_goal = units.length - scored.length;
  const total = scored.length, m = scored.filter(met).length;
  const raw: Omit<Pattern, "alpha_each" | "passes" | "status" | "p">[] = [];
  for (const grouping of GROUPINGS) {
    const names = new Set<string>();
    for (const u of scored) for (const x of groupsOf(grouping, u)) names.add(x.group);
    for (const group of [...names].sort()) {
      const inn = scored.filter((u) => groupsOf(grouping, u).some((x) => x.group === group && x.in));
      const n_in = inn.length, k = inn.filter(met).length;
      // Nothing to compare against, or nobody in the group: not a pattern.
      if (n_in === 0 || n_in === total) continue;
      const n_out = total - n_in, k_out = m - k;
      const looked_at = n_in >= REPEAT_RULE.min_events && n_out >= REPEAT_RULE.min_events;
      raw.push({ key: `${grouping}:${group}`, grouping, group, ...labelsOf(grouping, group), n_in, k, m, total, n_out, k_out, looked_at, counts: `${k} of ${n_in} met their goal; ${k_out} of ${n_out} elsewhere` });
    }
  }
  raw.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // Pairs not looked at (too few to say) are not in `pairs`.
  const pairs = raw.filter((r) => r.looked_at).length;
  const alpha_each = pairs ? REPEAT_RULE.alpha / pairs : null;
  const patterns: Pattern[] = raw.map((r) => {
    const p = r.looked_at ? fisherGreater(r.k, r.n_in, r.m, r.total) : null;
    // rate_in > rate_out as integers: k / n_in > k_out / n_out.
    const better = r.k * r.n_out > r.k_out * r.n_in;
    const passes = r.looked_at && r.k >= REPEAT_RULE.min_goal_met && better && p !== null && alpha_each !== null && p < alpha_each;
    return { ...r, p, alpha_each: r.looked_at ? alpha_each : null, passes, status: passes ? "passes" : r.looked_at ? "no_clear_difference" : "too_few" };
  });
  return { total, met: m, no_goal, pairs, alpha_each, patterns };
}

/* ------------------------------------------------------------------ the series table */

export interface SeriesRow {
  series_key: string; name: string;
  editions: Array<{ id: string; name: string; year: number; held: number; goal: number | null; cost_cents: number; held_per_thousand: number | null }>;
  words: string; current: { decision: string; reason: string | null; decided_by: string; decided_at: string } | null;
}

export async function seriesTable(db: Db, units: Unit[]): Promise<SeriesRow[]> {
  const by = new Map<string, Unit[]>();
  for (const u of units) by.set(u.series_key, [...(by.get(u.series_key) ?? []), u]);
  const decisions = await db.query<{ series_key: string; decision: string; reason: string | null; decided_by: string; decided_at: string }>(
    "SELECT DISTINCT ON (series_key) series_key, decision, reason, decided_by, decided_at::text AS decided_at FROM repeat_decisions ORDER BY series_key, decided_at DESC, id DESC");
  const cur = new Map(decisions.map((d) => [d.series_key, d]));
  const keys = new Set([...by.keys(), ...cur.keys()]);
  return [...keys].sort().map((key) => {
    const eds = (by.get(key) ?? []).sort((a, b) => a.year - b.year || (a.id < b.id ? -1 : 1));
    const last = eds[eds.length - 1];
    const d = cur.get(key) ?? null;
    return {
      series_key: key, name: last ? last.name.replace(/\s*\b\d{4}\b\s*/g, " ").trim() : key,
      editions: eds.map((u) => ({ id: u.id, name: u.name, year: u.year, held: u.held, goal: u.goal, cost_cents: u.cost_cents, held_per_thousand: u.held_per_thousand })),
      words: eds.length === 1 ? "one edition so far" : `${eds.length} editions`, current: d ? { decision: d.decision, reason: d.reason, decided_by: d.decided_by, decided_at: d.decided_at } : null,
    };
  });
}

/* ------------------------------------------------------------------ the words */

/** The code-written sentence for a passing pattern. */
export const templateWords = (p: Pick<Pattern, "label" | "label_out" | "k" | "n_in" | "k_out" | "n_out">): string => `${p.label} met their goal ${p.k} of ${p.n_in} times, ${p.label_out} ${p.k_out} of ${p.n_out}.`;

/** What a model is shown and what its words are checked against: the pattern's own counts and its group names, nothing else. */
export const factsOf = (p: Pattern) => ({ group: p.label, others: p.label_out, group_events: p.n_in, group_met: p.k, other_events: p.n_out, other_met: p.k_out });

const ADVICE = /\b(should|must|ought|recommend\w*|suggest\w*|advis\w*|need to|needs to|consider|we could|you could|try to|make sure|worth)\b/i;
const MARKUP = /[*#`<>{}\[\]|\\_~^]|https?:|www\.|@/;
const DASHES = new RegExp("[\\u2012\\u2013\\u2014\\u2015]| -- ");

export type WordVerdict = { ok: true; text: string } | { ok: false; why: string };
/** The model's reply is shown only if this accepts it: JSON {"text": ...}, at most two sentences, no dash or markup, no advice, every number one of the pattern's numbers, no name outside the facts. */
export function checkWording(raw: string, p: Pattern): WordVerdict {
  const no = (why: string): WordVerdict => ({ ok: false, why });
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return no("it was not JSON"); }
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 1 || typeof (v as { text?: unknown }).text !== "string") return no("it was not exactly {\"text\": ...}");
  const text = collapse((v as { text: string }).text);
  if (!text) return no("it was empty");
  if (DASHES.test(text)) return no("it used a dash");
  if (MARKUP.test(text)) return no("it held markup");
  const sentences = sentencesOf(text);
  if (sentences.length < 1 || sentences.length > 2) return no("it was not one or two sentences");
  if (ADVICE.test(text)) return no("it gave advice");
  const facts = factsOf(p);
  const allowed = allowedFrom(facts, [], [], [p.label]);
  const stranger = unknownName(text, allowed);
  if (stranger) return no(`it named "${stranger}", which is not in the facts`);
  // "X of Y" must be one of the two pairs of counts, so right numbers in the wrong places are caught too.
  const pairs = new Set([`${p.k}/${p.n_in}`, `${p.k_out}/${p.n_out}`]);
  for (const m of text.matchAll(/(\d+)\s+(?:out\s+)?of\s+(\d+)/gi)) if (!pairs.has(`${m[1]}/${m[2]}`)) return no(`it stated ${m[1]} of ${m[2]}, which is not a pair of counts`);
  const ok = new Set(allowed.numbers.map((n) => n.value));
  let masked = text;
  for (const name of allowed.proper) masked = masked.split(name).join(" ");
  for (const f of numbersIn(masked)) if (!ok.has(f.value)) return no(`it stated ${f.raw}, which is not one of the counts`);
  return { ok: true, text };
}

/** One reading is the passing patterns' facts. A new past event changes a count and so makes a new reading. */
export const readingHash = (patterns: Pattern[]): string =>
  createHash("sha256").update(JSON.stringify(patterns.filter((p) => p.passes).map((p) => [p.key, p.n_in, p.k, p.m, p.total]))).digest("hex");

export interface Wording { pattern_key: string; text: string; by: "model" | "template"; model: string | null; status: string }

async function wordingsFor(db: Db, hash: string, patterns: Pattern[]): Promise<Record<string, Wording>> {
  const rows = await db.query<{ pattern_key: string; status: string; text: string | null; by: "model" | "template" | null; model: string | null }>("SELECT pattern_key, status, text, by, model FROM repeat_wordings WHERE reading_hash = $1", [hash]);
  const have = new Map(rows.map((r) => [r.pattern_key, r]));
  const out: Record<string, Wording> = {};
  for (const p of patterns.filter((x) => x.passes)) {
    const r = have.get(p.key);
    out[p.key] = r?.text && r.by ? { pattern_key: p.key, text: r.text, by: r.by, model: r.model, status: r.status } : { pattern_key: p.key, text: templateWords(p), by: "template", model: null, status: r?.status ?? "none" };
  }
  return out;
}

/** The whole reading for the screen. */
export async function repeatView(db: Db, deps?: Pick<LifecycleDeps, "now">) {
  const units = await pastUnits(db, deps);
  const a = analyze(units);
  const hash = readingHash(a.patterns);
  return { rule: REPEAT_RULE, units: units.length, ...a, reading_hash: hash, series: await seriesTable(db, units), wordings: await wordingsFor(db, hash, a.patterns) };
}

/** Words each passing pattern once per reading, at most six. The row is written `pending` first (unique on the reading and the pattern), so a repeat is a no-op and a failed call is never repeated.
    The simulated model is not a model: it hands back the code-written sentence, and the row says `template`. */
export async function wordPatterns(db: Db, llm: Llm, deps?: Pick<LifecycleDeps, "now">) {
  const view = await repeatView(db, deps);
  const passing = view.patterns.filter((p) => p.passes).sort((a, b) => (a.p! - b.p!) || (a.key < b.key ? -1 : 1)).slice(0, REPEAT_RULE.max_wordings);
  let made = 0, skipped = 0;
  for (const p of passing) {
    const template = templateWords(p);
    const ins = await db.query<{ id: string }>("INSERT INTO repeat_wordings (id, reading_hash, pattern_key, status) VALUES ($1, $2, $3, 'pending') ON CONFLICT (reading_hash, pattern_key) DO NOTHING RETURNING id", [newId("rwd"), view.reading_hash, p.key]);
    if (!ins.length) { skipped++; continue; }
    made++;
    let reply;
    try { reply = await llm.complete("repeat_word", fill("repeat_word", { facts: JSON.stringify(factsOf(p)) }), template); }
    catch { await db.query("UPDATE repeat_wordings SET status = 'failed', text = $2, by = 'template' WHERE id = $1", [ins[0].id, template]); continue; }
    const verdict = checkWording(reply.text, p);
    // Words are the model's only when it is a model and the check accepts them.
    const byModel = verdict.ok && !llm.simulated;
    await db.query("UPDATE repeat_wordings SET status = 'done', text = $2, by = $3, model = $4, input_tokens = $5, output_tokens = $6 WHERE id = $1",
      [ins[0].id, byModel ? (verdict as { text: string }).text : template, byModel ? "model" : "template", reply.model ?? llm.model, reply.input_tokens, reply.output_tokens]);
  }
  return { made, skipped, ...(await repeatView(db, deps)) };
}

/* ------------------------------------------------------------------ the decision */

/** Repeat or Drop for one series. Leadership and GTM only. A drop needs a reason; a repeat may have one. The row keeps the evidence as it was shown. It changes no event. */
export async function decide(db: Db, actor: string, input: { series_key?: unknown; decision?: unknown; reason?: unknown }, deps?: Pick<LifecycleDeps, "now">) {
  if (!isLead(actor)) throw new Forbidden("Repeat or Drop is recorded by leadership or GTM Engineering.");
  const key = typeof input.series_key === "string" ? input.series_key.trim() : "";
  if (!key) throw new Invalid("Say which conference.");
  if (input.decision !== "repeat" && input.decision !== "drop") throw new Invalid("Repeat or Drop.");
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  if (input.decision === "drop" && !reason) throw new Invalid("Say why to drop it.");
  const view = await repeatView(db, deps);
  const row = view.series.find((s) => s.series_key === key) ?? null;
  const evidence = { series: row ? { series_key: row.series_key, name: row.name, editions: row.editions } : { series_key: key, editions: [] }, patterns: view.patterns.filter((p) => p.passes), pairs: view.pairs, alpha_each: view.alpha_each, units: view.units, reading_hash: view.reading_hash };
  const id = newId("rdc");
  await db.query("INSERT INTO repeat_decisions (id, series_key, decision, reason, decided_by, evidence) VALUES ($1, $2, $3, $4, $5, $6::jsonb)", [id, key, input.decision, reason || null, actor, JSON.stringify(evidence)]);
  return { id, series_key: key, decision: input.decision, reason: reason || null };
}
