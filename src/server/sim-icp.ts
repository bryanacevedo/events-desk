/* The simulated (and mock) model's reading of an ICP document: a deterministic parser that
   returns the same JSON shape the real model is asked for, with every item quoting the exact
   sentence it came from. It makes no network call and spends nothing.

   What this is: a reader for the phrasing of samples/orrery-icp.md and documents written like
   it (headings, one claim per sentence, "Name: tier N." bullets). A real model reads any
   document; how well it does can only be measured with the real model on real documents. The
   parser knows a small table of words for the verticals it names (software, logistics
   technology, payments). That table is authored, not learned.

   It never acts on the document: it only looks for the claims it knows how to read. A sentence
   that tries to give it an order is not a claim, so it is skipped. */

import { squash } from "../shared/icp.ts";

interface Piece { text: string; section: string; bullet: boolean }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const KEYWORDS: Record<string, string[]> = {
  software: ["software", "saas", "cloud", "data platform", "security software"],
  "logistics technology": ["logistics", "freight", "fleet", "warehouse", "telematics", "supply chain"],
  payments: ["payments", "payment", "settlement", "treasury", "merchant acquiring", "invoicing"],
  agencies: ["agency", "media buying"],
  consultancies: ["consulting", "consultancy", "advisory services"],
};
const SENIORITY_ORDER = ["individual", "senior", "manager", "director", "vp", "c_level", "owner"] as const;

/** Splits a document into claims: one per bullet, one per sentence of prose, each remembering its heading. Text is cut from the original, so quotes are exact. */
function pieces(doc: string): Piece[] {
  const out: Piece[] = [];
  let section = "";
  for (const line of doc.split("\n")) {
    const h = line.match(/^#{1,3}\s+(.*)$/);
    if (h) { section = h[1].trim(); continue; }
    const t = line.trim();
    if (!t || /^\(.*\)$/.test(t)) continue;
    const b = t.match(/^[-*]\s+(.*)$/);
    if (b) { out.push({ text: b[1].trim(), section, bullet: true }); continue; }
    for (const s of t.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/)) if (s.trim()) out.push({ text: s.trim(), section, bullet: false });
  }
  return out;
}

const list = (s: string) => s.split(/,\s*|\s+and\s+/).map((x) => x.replace(/\.$/, "").trim()).filter(Boolean);
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function draftFromDocument(doc: string): Record<string, unknown> {
  const ps = pieces(doc);
  const meta = (k: string) => doc.match(new RegExp(`^${k}:\\s*(.+)$`, "mi"))?.[1].trim() ?? "";
  const out: Record<string, any> = {
    seller: meta("Seller"), owner: meta("Owner"), last_reviewed: meta("Last reviewed"), summary: "", size: null, geography: null,
    hard_rules: [], fit_dimensions: [], segments: [], company_types: [], tier_definitions: [], examples: [], counter_examples: [], personas: [], title_adjustments: [],
    lists: { excluded: [], customers: [] },
  };

  const first = ps.filter((p) => /short version|summary|overview/i.test(p.section));
  out.summary = first.map((p) => p.text).join(" ").slice(0, 600);

  for (const p of ps) {
    const t = p.text;
    const size = t.match(/(\d[\d,]*)\s+to\s+(\d[\d,]*)\s+employees/i);
    if (size && !out.size && !/^tier\s*\d/i.test(t)) out.size = { min: Number(size[1].replace(/,/g, "")), max: Number(size[2].replace(/,/g, "")), quote: t };

    const strong = t.match(/^(.*?)\s+(?:companies\s+)?are\s+our\s+(?:strongest|best)/i);
    if (strong) {
      for (const name of list(strong[1].replace(/\s+companies$/i, "")).map((n) => n.toLowerCase())) {
        const id = slug(name);
        if (!out.segments.some((s: any) => s.id === id)) out.segments.push({ id, name, stance: "strong", keywords: KEYWORDS[name] ?? [name], definition: `A ${name} company. A strong fit.`, quote: t });
      }
    }
    const weak = t.match(/^(Agencies|Consultancies)\b.*\brarely close/i);
    if (weak) {
      const name = weak[1].toLowerCase();
      out.segments.push({ id: slug(name), name, stance: "weak", keywords: KEYWORDS[name] ?? [name], definition: `${titleCase(name)} rarely close.`, quote: t });
    }
    if (/\b(only (?:sell|sells) to consumers|sell only to consumers|consumer[- ]only)\b/i.test(t) && !/^tier\s*\d/i.test(t)) {
      out.hard_rules.push({ id: "sells_to_businesses", text: "The company sells to businesses, not only to consumers", field: "business_model", op: "in", value: ["b2b", "b2b2c"], quote: t });
    }

    const tier = t.match(/^Tier\s*([123])\s*:\s*(.*)$/i);
    if (tier && p.bullet) {
      const n = Number(tier[1]);
      const strongIds = out.segments.filter((s: any) => s.stance === "strong").map((s: any) => s.id);
      const weakIds = out.segments.filter((s: any) => s.stance === "weak").map((s: any) => s.id);
      const body = tier[2];
      if (n === 1 && /strong vertical/i.test(body)) for (const id of strongIds) out.tier_definitions.push({ id: `${id}_t1`, segment: id, tier: 1, text: body, when: { employees: "in_range" }, quote: t });
      if (n === 2) {
        for (const id of strongIds) out.tier_definitions.push({ id: `${id}_t2`, segment: id, tier: 2, text: body, quote: t });
        if (/either/i.test(body)) out.tier_definitions.push({ id: "other_t2", segment: "*", tier: 2, text: body, when: { employees: "in_range" }, quote: t });
      }
      if (n === 3) {
        for (const id of weakIds) out.tier_definitions.push({ id: `${id}_t3`, segment: id, tier: 3, text: body, quote: t });
        out.tier_definitions.push({ id: "other_t3", segment: "*", tier: 3, text: body, quote: t });
      }
    }

    const buyer = t.match(/^The buyer is\b[^:]*:\s*(.*)$/i);
    if (buyer) {
      const titles = list(buyer[1]);
      out.personas.push({ id: "revenue_leadership", segment: "*", function: "Revenue leadership", seniority_min: "vp", seniority_max: "c_level", titles, priority: "primary", quote: t });
    }
    if (/^Directors and managers in sales\b/i.test(t)) out.personas.push({ id: "sales_directors", segment: "*", function: "Sales", seniority_min: "manager", seniority_max: "director", titles: ["Director of Sales", "Sales Manager"], priority: "secondary", quote: t });
    if (/^Marketing and customer success leaders\b/i.test(t)) out.personas.push({ id: "marketing_cs", segment: "*", function: "Marketing and customer success", seniority_min: "director", seniority_max: "vp", titles: ["Head of Marketing", "Head of Customer Success"], priority: "secondary", quote: t });

    if (/\bVP at a bank or an insurer carries less weight\b/i.test(t)) out.title_adjustments.push({ id: "financial_vp", company_type: "financial_institution", delta: -1, text: "A VP at a bank or an insurer ranks below a VP at a software company.", quote: t });
    if (/\bfounder at a company under 50 people\b/i.test(t)) out.title_adjustments.push({ id: "small_founder", company_type: "any", size_band: "under 50", delta: 1, text: "A founder at a company under 50 people is the buyer whatever the title says.", quote: t });

    if (/kinds of company/i.test(p.section) && !p.bullet) out.company_types = list(t).map((n) => ({ id: slug(n), name: n.toLowerCase(), keywords: [] }));

    const never = t.match(/^(.+?)\s+is\s+(?:a\s+)?(?:direct\s+)?competitor\b.*\bnever gets contacted/i);
    if (never) out.lists.excluded.push({ id: slug(never[1]), name: never[1].trim(), quote: t });
    const cust = t.match(/^(.+?)\s+is\s+already\s+a\s+customer/i);
    if (cust) out.lists.customers.push({ id: slug(cust[1]), name: cust[1].trim(), quote: t });

    const ex = t.match(/^([^:]{2,80}):\s*tier\s*([123])\.?\s*(.*)$/i);
    if (ex && p.bullet && !/^tier\s*\d/i.test(t)) {
      const item = { id: slug(ex[1]), company: ex[1].trim(), tier: Number(ex[2]), why: ex[3].trim(), quote: t };
      if (/looks right|counter|is not/i.test(p.section)) out.counter_examples.push(item);
      else if (/companies we know|examples?/i.test(p.section)) out.examples.push(item);
    }
  }

  out.fit_dimensions = [];
  if (out.size) out.fit_dimensions.push({ id: "scale", name: "Scale", strong: `${out.size.min} to ${out.size.max} employees`, partial: "Outside that range but in a strong vertical", weak: "Outside the range and not in a strong vertical", quote: out.size.quote });
  // Sections with no claims stay out. Nothing is made up to fill them.
  return out;
}

/** The text a prompt carries between the document markers, or the whole prompt when the markers are missing. */
export function documentOf(prompt: string): string {
  const a = prompt.lastIndexOf("<<<DOCUMENT\n"), b = prompt.lastIndexOf("\nDOCUMENT>>>");
  return a >= 0 && b > a ? prompt.slice(a + "<<<DOCUMENT\n".length, b) : prompt;
}

export const draftJson = (doc: string) => JSON.stringify(draftFromDocument(doc));
export { squash };
