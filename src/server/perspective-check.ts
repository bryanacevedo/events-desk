/* The check on the model's perspective, in code. The model writes; this decides whether a block may be printed.

   A block is accepted only if every test below passes. One failure rejects that block and the code-written text is used for it.
   The checks are deliberately strict: a false rejection costs nothing (the code-written text is always correct), a false acceptance prints a claim nobody verified.

   Numbers      every number in the text (digits, decimals, percentages, money, spelled-out words) is a number from the fact packet, or one of the
                narrow derivations below. 1,650 and 1650 are the same number; 18% matches a stored 18 or a stored 0.18.
   Quotes       every passage in double quotes is word for word inside a seat request the model was shown.
   Names        every capitalized name is in the packet.
   Advice       no imperative, no advice or recommendation wording, no second person.
   Form         valid JSON with exactly the three parts, no em or en dash, no markup, two or three short sentences per part.

   Allowed derivations (the only ones): for two numbers of the same kind that sit in the same group of the packet (for example the tier counts, or the
   industry shares), their sum and their absolute difference; and 100 minus any percentage. Nothing is rounded, scaled or inferred. */

export const PARTS = ["why", "list", "stand"] as const;
export type Part = (typeof PARTS)[number];

export type NumKind = "count" | "pct" | "usd";
export interface NumEntry { value: number; kind: NumKind; group: string }

/** What the model was shown, reduced to what the check needs. */
export interface Allowed {
  numbers: NumEntry[];
  /** Every string the model was shown, lower case, one per line. A capitalized name in the text must be a substring of this. */
  corpus: string;
  /** Strings that are names (event, companies, people, teams), longest first. Masked before the number check, so "Money20/20" is not read as numbers. */
  proper: string[];
  /** The seat request texts, whitespace collapsed. A quoted passage must be inside one. */
  quotes: string[];
}

const EPS = 1e-6;
const same = (a: number, b: number) => Math.abs(a - b) < EPS;
export const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Numbers of a fact packet: every number leaf, kind from the key (`_pct` percent, `_usd` dollars, else a count), group from the path without array positions. */
export function numbersOf(facts: unknown, path = ""): NumEntry[] {
  if (typeof facts === "number" && Number.isFinite(facts)) {
    const key = path.split(".").pop() ?? "";
    return [{ value: facts, kind: key.endsWith("_pct") ? "pct" : key.endsWith("_usd") ? "usd" : "count", group: path.split(".").slice(0, -1).join(".") }];
  }
  if (Array.isArray(facts)) return facts.flatMap((x) => numbersOf(x, path));
  if (facts && typeof facts === "object") return Object.entries(facts).flatMap(([k, v]) => numbersOf(v, path ? `${path}.${k}` : k));
  return [];
}
export function stringsOf(facts: unknown): string[] {
  if (typeof facts === "string") return [facts];
  if (Array.isArray(facts)) return facts.flatMap(stringsOf);
  if (facts && typeof facts === "object") return Object.values(facts).flatMap(stringsOf);
  return [];
}

export function allowedFrom(facts: unknown, seatTexts: string[], extraText: string[], proper: string[]): Allowed {
  const quotes = seatTexts.map(collapse);
  return {
    numbers: numbersOf(facts),
    corpus: [...stringsOf(facts), ...extraText, ...quotes].map((s) => s.toLowerCase()).join("\n"),
    proper: [...new Set(proper.map(collapse).filter(Boolean))].sort((a, b) => b.length - a.length),
    quotes,
  };
}

/* ------------------------------------------------------------------ numbers */

const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };
const NUMBER_WORDS = new Set([...Object.keys(UNITS), ...Object.keys(TENS), ...Object.keys(SCALES)]);
/** Words that state a quantity without a figure the check could match. Rejected outright. */
const VAGUE_QUANTITY = /\b(half|halves|thirds?|quarters?|twice|thrice|doubl(?:e|es|ed|ing)|tripl(?:e|es|ed|ing)|dozens?|couple|hundreds|thousands|millions|second|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i;

export interface Found { value: number; kind: NumKind | "plain"; raw: string }

/** Every number in `text`, as the reader would take it. Tier labels ("tier 2", "tier two") and the letters-and-digits terms B2B and B2C are not quantities. */
export function numbersIn(text: string): Found[] {
  const out: Found[] = [];
  let t = text.replace(/\bB2B2C\b|\bB2B\b|\bB2C\b|\bB2G\b/gi, " ").replace(/\btier\s+[1-3]\b/gi, " ");
  t = t.replace(/\btier\s+(one|two|three)\b/gi, " ");
  const digits = /(\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:\s?(%|percent\b|per cent\b|(?:percentage\s+)?points?\b))?(?:\s?(thousand|million|billion|[kmb])\b)?(?:st|nd|rd|th)?/gi;
  let m: RegExpExecArray | null;
  while ((m = digits.exec(t))) {
    let v = Number((m[2] + (m[3] ?? "")).replace(/,/g, ""));
    const mult = (m[5] ?? "").toLowerCase();
    if (mult) v *= mult === "k" || mult === "thousand" ? 1e3 : mult === "m" || mult === "million" ? 1e6 : 1e9;
    out.push({ value: v, kind: m[4] ? "pct" : m[1] ? "usd" : "plain", raw: m[0].trim() });
  }
  // Spelled-out numbers: runs of number words ("twenty-one", "one hundred and five", "a thousand"), then an optional "percent".
  const lowered = t.toLowerCase().replace(/\bno one\b|\bone another\b|\bno-one\b/g, " ");
  const words = [...lowered.matchAll(/[a-z]+/g)].map((x) => ({ w: x[0], end: (x.index ?? 0) + x[0].length }));
  for (let i = 0; i < words.length; i++) {
    if (!NUMBER_WORDS.has(words[i].w)) continue;
    let j = i, total = 0, current = 0, any = false;
    for (; j < words.length; j++) {
      const w = words[j].w;
      if (w === "and" && j > i && j + 1 < words.length && NUMBER_WORDS.has(words[j + 1].w) && current >= 100) continue;
      if (!NUMBER_WORDS.has(w)) break;
      // Words only join when the gap between them is a space or a hyphen.
      if (j > i && /[^\s-]/.test(lowered.slice(words[j - 1].end, words[j].end - w.length))) break;
      any = true;
      if (w in UNITS) current += UNITS[w];
      else if (w in TENS) current += TENS[w];
      else if (w === "hundred") current = (current || 1) * 100;
      else { total += (current || 1) * SCALES[w]; current = 0; }
    }
    if (!any) continue;
    const next = lowered.slice(words[j - 1].end).trimStart();
    out.push({ value: total + current, kind: /^(percent\b|per cent\b|(?:percentage\s+)?points?\b)/.test(next) ? "pct" : "plain", raw: words.slice(i, j).map((x) => x.w).join(" ") });
    i = j - 1;
  }
  return out;
}

/** True when `v` is one of the packet numbers or a narrow derivation of them (see the header). */
export function numberAllowed(f: Found, numbers: NumEntry[]): boolean {
  const pool: NumEntry[] = [...numbers];
  const byGroup = new Map<string, NumEntry[]>();
  for (const n of numbers) byGroup.set(`${n.group}|${n.kind}`, [...(byGroup.get(`${n.group}|${n.kind}`) ?? []), n]);
  for (const group of byGroup.values()) {
    for (let a = 0; a < group.length; a++) for (let b = a + 1; b < group.length; b++) {
      pool.push({ ...group[a], value: group[a].value + group[b].value }, { ...group[a], value: Math.abs(group[a].value - group[b].value) });
    }
  }
  for (const n of numbers) if (n.kind === "pct" && n.value <= 100) pool.push({ ...n, value: 100 - n.value });
  switch (f.kind) {
    // 18% is a stored 18 percent, or a stored fraction 0.18.
    case "pct": return pool.some((n) => (n.kind === "pct" && same(n.value, f.value)) || (n.kind === "count" && same(n.value, f.value / 100)));
    case "usd": return pool.some((n) => n.kind === "usd" && same(n.value, f.value));
    // A bare whole number must be a count. A bare decimal below one may be a stored percentage written as a fraction (0.18 for 18%).
    default: return pool.some((n) => (n.kind === "count" && same(n.value, f.value)) || (n.kind === "pct" && f.value > 0 && f.value < 1 && same(n.value, f.value * 100)));
  }
}

/* ------------------------------------------------------------------- names */

/** Capitalized words that are not names: sentence openers, terms of the list and the CRM. Lower case. */
const NOT_A_NAME = new Set(`a about above across after again all along already also although among an and another any are around as at back because been before behind being below between both but by can could despite did do does down during each either else even every few first for from given had has have here how however if in into is it its just last least less like made many may meanwhile more most much neither no none nor not of on once one only or other others our out over own per same several since so some still such than that the their them then there these they this those though through to too two under until up upon used was were what when where whether which while who whose why will with within without would yet
nothing nobody everything something anything everyone someone nowhere those these half twice roughly nearly almost about around overall altogether otherwise instead further furthermore moreover therefore thus hence additionally finally together separately currently recently previously newly mostly largely partly mainly only today tomorrow yesterday owner owners
tier tiers crm icp sheet summary list lists industry industries priority customer customers prospect prospects partner partners b2b b2c outreach attendee attendees event events seat seats request requests ticket tickets goal goals account accounts deal deals stage stages heat hot warm cold net new open`.split(/\s+/));
for (const w of NUMBER_WORDS) NOT_A_NAME.add(w);

const isGeneric = (tok: string) => { const l = tok.toLowerCase(); return NOT_A_NAME.has(l) || l.split("-").every((p) => NOT_A_NAME.has(p)); };

const TOKEN = /[A-Z][A-Za-z0-9&'’.\-/]*/;

/** Runs of capitalized words in `text`, each with whether it opens a sentence. Quoted passages are already masked. */
function capitalizedRuns(text: string): { run: string[]; opens: boolean }[] {
  const out: { run: string[]; opens: boolean }[] = [];
  for (const sentence of text.split(/(?<=[.!?:;])\s+/)) {
    const tokens = sentence.split(/\s+/).filter(Boolean);
    let run: string[] = [], start = -1;
    const flush = () => { if (run.length) out.push({ run, opens: start === 0 }); run = []; start = -1; };
    tokens.forEach((raw, i) => {
      const tok = raw.replace(/^[("'“‘]+|[)"'”’,.;:!?]+$/g, "").replace(/['’]s$/, "");
      if (tok && new RegExp(`^${TOKEN.source}$`).test(tok)) { if (!run.length) start = i; run.push(tok); } else flush();
      if (/[,;:)]$/.test(raw)) flush();
    });
    flush();
  }
  return out;
}

function unknownName(text: string, a: Allowed): string | null {
  for (const { run, opens } of capitalizedRuns(text)) {
    let toks = run.slice();
    if (opens) while (toks.length && isGeneric(toks[0])) toks.shift();
    // Generic words at the edges of a run are not part of a name ("Tier 1 and Acme" has the name Acme).
    while (toks.length && isGeneric(toks[0])) toks.shift();
    while (toks.length && isGeneric(toks[toks.length - 1])) toks.pop();
    if (!toks.length) continue;
    const name = toks.join(" ");
    if (!a.corpus.includes(name.toLowerCase())) return name;
  }
  return null;
}

/* ---------------------------------------------------------------- advice */

const IMPERATIVE_OPENERS = new Set(`add align approach ask assign avoid begin book bring build call capture check choose compare confirm connect consider contact convert create decide do don't dont double email engage ensure explore find focus follow get give go identify include invite keep let look make move note nurture offer plan please prepare prioritise prioritize pursue qualify reach remember review route schedule see send set sort start stop take target test think track treat try use verify wait watch win work`.split(/\s+/));
const ADVICE: [RegExp, string][] = [
  [/\b(should|shouldn't|must|mustn't|ought)\b/i, "a should or must"],
  [/\b(need|needs|needed|has|have|had) to\b/i, "a need to"],
  [/\b(recommend\w*|suggest\w*|advis(?:e|es|ed|ing)|urge[sd]?|encourag\w*)\b/i, "a recommendation"],
  [/\bconsider\b|\bprioriti[sz]e\b|\bmake sure\b|\bbe sure\b|\bfollow up\b|\breach out\b|\bdon't forget\b|\blet's\b|\blets\b|\btry to\b/i, "an instruction"],
  [/\bworth (?:\w+ing|a |an |the |it)\b|\bbest to\b|\bbetter to\b|\bwise to\b|\bsmart to\b|\bgood idea\b|\bit would be (?:wise|best|better|smart|good)\b/i, "advice on what is worthwhile"],
  [/\b(?:opportunity|chance|time) to\b|\bnext steps?\b|\baction items?\b|\bto do\b/i, "a next step"],
  [/\b(?:you|your|yours|you're|you'll|you'd|yourself)\b/i, "the reader addressed directly"],
  [/\bplease\b/i, "a request"],
];

/* ---------------------------------------------------------------- the check */

export type Verdict = { ok: true; text: string } | { ok: false; why: string };
const no = (why: string): Verdict => ({ ok: false, why });

/** The em dash, en dash, horizontal bar and figure dash, and the double hyphen used in their place. */
const DASHES = new RegExp("[\\u2012\\u2013\\u2014\\u2015]| -- ");
const MARKUP = /[*#`<>{}\[\]|\\_~^]|https?:|www\.|@|\p{Extended_Pictographic}/u;
const MAX_SENTENCE = 240, MAX_PART = 600;

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028\\u2029\\ufeff]");
const QUOTE_MARK = /["“”]/;

/** Quoted passages of `text`, or null when the marks do not pair up. */
function quotedPassages(text: string): string[] | null {
  const marks = [...text.matchAll(/["“”]/g)];
  if (marks.length % 2) return null;
  const out: string[] = [];
  for (let i = 0; i < marks.length; i += 2) out.push(text.slice((marks[i].index ?? 0) + 1, marks[i + 1].index));
  return out;
}

/** Sentences of `text`, after quoted passages and the usual abbreviations are set aside so their full stops do not count. */
export function sentencesOf(text: string): string[] {
  const t = text.replace(/\b(?:U\.S|U\.K|Inc|Ltd|Corp|Co|vs|e\.g|i\.e|etc|No|St)\./g, (m) => m.replace(/\./g, "\u0000")).replace(/(\d)\.(\d)/g, "$1\u0000$2");
  return t.split(/(?<=[.!?])\s+/).map((s) => s.replace(/\u0000/g, ".").trim()).filter(Boolean);
}

/** The whole check for one part. `text` is the model's string for that part. */
export function checkPart(raw: unknown, a: Allowed): Verdict {
  if (typeof raw !== "string") return no("it was not text");
  const text = collapse(raw);
  if (!text) return no("it was empty");
  if (CONTROL.test(raw.replace(/[\n\r\t]/g, " "))) return no("it held control characters");
  if (/^[=+\-@]/.test(text)) return no("it began like a spreadsheet formula");
  if (DASHES.test(text)) return no("it used a dash as punctuation");
  if (MARKUP.test(text)) return no("it held markup, a link or a symbol");

  // Quotes: each passage must be word for word inside a seat request the model saw. Then they are set aside, so the rest is judged on the model's own words.
  const passages = quotedPassages(text);
  if (!passages) return no("its quotation marks did not pair up");
  for (const p of passages) {
    const q = collapse(p);
    if (q.length < 3 || !a.quotes.some((s) => s.includes(q))) return no(`it quoted words that no seat request contains ("${q.slice(0, 40)}")`);
  }
  // A passage that ends in a full stop keeps it, so the sentence it closes still counts.
  const bare = text.replace(/(["“])([^"“”]*)(["”])/g, (_m, _open: string, inner: string) => `‹quote›${/[.!?]\s*$/.test(inner) ? inner.trim().slice(-1) : ""}`);
  if (QUOTE_MARK.test(bare)) return no("its quotation marks did not pair up");

  const sentences = sentencesOf(bare);
  if (sentences.length < 2 || sentences.length > 3) return no(`it had ${sentences.length} sentence${sentences.length === 1 ? "" : "s"}, not two or three`);
  if (text.length > MAX_PART || sentences.some((s) => s.length > MAX_SENTENCE)) return no("it was too long");

  for (const [re, what] of ADVICE) if (re.test(bare)) return no(`it contained ${what}`);
  for (const s of sentences) {
    const first = s.replace(/^[^A-Za-z]+/, "").split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g, "") ?? "";
    if (IMPERATIVE_OPENERS.has(first)) return no(`it opened a sentence with an instruction ("${first}")`);
  }

  // Names, then numbers, on the text with names set aside only for the number check.
  if (VAGUE_QUANTITY.test(bare)) return no("it stated a quantity without a figure (half, twice, a dozen and the like)");
  const stranger = unknownName(bare, a);
  if (stranger) return no(`it named "${stranger}", which is not in the facts`);
  let numeric = bare;
  for (const name of a.proper) numeric = numeric.split(name).join(" ");
  for (const f of numbersIn(numeric)) if (!numberAllowed(f, a.numbers)) return no(`it stated ${f.raw}, which is not a figure in the facts`);
  return { ok: true, text };
}

/** The model's reply as three strings, or null when it is not exactly {why, list, stand}. */
export function shapeOf(v: unknown): Record<Part, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== PARTS.length || !PARTS.every((p) => keys.includes(p))) return null;
  return v as Record<Part, unknown>;
}
