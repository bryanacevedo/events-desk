/* Templates are checked before anyone approves them, and every send can be previewed with a real row. */

import { createHash } from "node:crypto";

export const MERGE_FIELDS = ["first_name", "last_name", "company", "title", "event", "booth", "rep_name", "booking_link"] as const;
export interface TemplateStep { day: number; subject?: string; body: string }

const ADVISORY = /\b(free money|act now|100% free|guarantee[d]?|risk[- ]free|limited time|click here)\b/i;
const CARD_MAX = 300;

export function lintTemplate(channel: "email" | "linkedin", steps: TemplateStep[]) {
  const errors: string[] = [], warnings: string[] = [];
  if (!steps.length) errors.push("A template needs at least one step.");
  let last = -1;
  steps.forEach((s, i) => {
    const at = `Step ${i + 1}`;
    if (!s.body?.trim()) errors.push(`${at} has no text.`);
    if (typeof s.day !== "number" || s.day <= last) errors.push(`${at} has to come after the step before it.`);
    last = s.day;
    if (channel === "email" && i === 0 && !s.subject?.trim()) errors.push(`${at} needs a subject.`);
    for (const m of `${s.subject ?? ""} ${s.body ?? ""}`.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) if (!MERGE_FIELDS.includes(m[1] as never)) errors.push(`${at} uses {{${m[1]}}}, which the desk cannot fill.`);
    const open = (`${s.subject ?? ""}${s.body ?? ""}`.match(/\{\{/g) ?? []).length, close = (`${s.subject ?? ""}${s.body ?? ""}`.match(/\}\}/g) ?? []).length;
    if (open !== close) errors.push(`${at} has a broken merge field.`);
    if (channel === "linkedin" && i === 0 && (s.body?.length ?? 0) > CARD_MAX) errors.push(`${at} is a connection note, and has to be ${CARD_MAX} characters or fewer.`);
    if (ADVISORY.test(`${s.subject ?? ""} ${s.body ?? ""}`)) warnings.push(`${at} uses wording that spam filters dislike.`);
  });
  return { errors, warnings };
}

export const copyHash = (steps: TemplateStep[]) => createHash("sha256").update(JSON.stringify(steps.map((s) => [s.day, s.subject ?? "", s.body]))).digest("hex").slice(0, 16);

const HONORIFIC = /^(dr|mr|mrs|ms|mx|prof|sr|sra|ing|lic)\.?$/i;
/** "DR. ANA RUIZ PHD" is Ana Ruiz. A name in one case is put right; a mixed-case name is left as the person wrote it. */
export function cleanNames(full: string | null) {
  const words = (full ?? "").trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && HONORIFIC.test(words[0])) words.shift();
  while (words.length > 1 && /^(phd|md|mba|cpa|jr\.?|sr\.?|ii|iii)$/i.test(words[words.length - 1])) words.pop();
  const whole = words.join(" "), oneCase = whole === whole.toUpperCase() || whole === whole.toLowerCase();
  const fix = (w: string) => (oneCase ? w.toLowerCase().replace(/(^|[-'])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) : w);
  const [first, ...rest] = words.map(fix);
  return { first_name: first ?? "", last_name: rest.join(" ") };
}

export interface MergeValues { first_name: string; last_name: string; company: string; title: string | null; event: string; booth?: string | null; rep_name?: string | null; booking_link?: string | null }

/** What the person will read. A field with no value is named, so nobody launches a blank. */
export function renderStep(s: TemplateStep, v: MergeValues) {
  const missing: string[] = [];
  const fill = (t: string) => t.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_, k: string) => { const x = v[k as keyof MergeValues]; if (!x) { missing.push(k); return `[${k}]`; } return String(x); });
  return { subject: s.subject ? fill(s.subject) : null, body: fill(s.body), missing };
}
