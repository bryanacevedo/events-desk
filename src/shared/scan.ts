/* The scanner's pure parts (docs/SCANNER.md 5, 7, 14): what a badge code says, what two people have in common, and the CSV. The phone and the server both use this file. */

export const METHODS = ["badge_code", "badge_id", "badge_photo", "card_photo", "typed"] as const;
export type Method = (typeof METHODS)[number];
export const METHOD_WORDS: Record<Method, string> = { badge_code: "Badge code", badge_id: "Badge id", badge_photo: "Badge photo", card_photo: "Business card", typed: "Typed" };
export const STATES = ["received", "resolving", "lookup_pending", "needs_fields", "to_confirm", "placed", "failed"] as const;
export type ScanState = (typeof STATES)[number];
/** What a person reads for a state: a word in ink, never a colour. */
export const STATE_WORDS: Record<ScanState, string> = { received: "Arriving", resolving: "Looking up", lookup_pending: "Waiting for lookup", needs_fields: "Not read yet", to_confirm: "To confirm", placed: "Placed", failed: "Not placed" };
export const TEMPERATURES = ["hot", "warm", "cold"] as const;

export const FIELD_NAMES = ["name", "email", "phone", "title", "company", "country", "linkedin"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];
export type Fields = Partial<Record<FieldName, string>>;

export const DEFAULT_NOTICE = "We will keep your details to follow up on our conversation. Tell us if you would rather we did not.";
export const MAX_QUALIFIERS = 3;
export interface Qualifier { id: string; label: string }

const clean = (s: string | undefined | null) => (s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();

/* ------------------------------------------------------------------ vCard and MeCard */

/** vCard 2.1, 3.0 and 4.0 lines: folded lines are joined, `\,` `\;` `\n` unescaped, parameters (TYPE=WORK) ignored. */
export function parseVCard(text: string): Fields {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out: Fields = {};
  const unescape = (v: string) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i < 1) continue;
    const key = line.slice(0, i).split(";")[0].toUpperCase().replace(/^ITEM\d+\./, "");
    const value = line.slice(i + 1);
    switch (key) {
      case "FN": if (!out.name) out.name = clean(unescape(value)); break;
      case "N": { const [last, first, , prefix] = value.split(";").map((p) => clean(unescape(p))); void prefix; if (!out.name && (first || last)) out.name = [first, last].filter(Boolean).join(" "); break; }
      case "ORG": out.company = clean(unescape(value.split(";")[0])); break;
      case "TITLE": out.title = clean(unescape(value)); break;
      case "EMAIL": if (!out.email) out.email = clean(unescape(value)); break;
      case "TEL": if (!out.phone) out.phone = clean(unescape(value)); break;
      case "URL": { const v = clean(unescape(value)); if (/linkedin\.com/i.test(v)) out.linkedin = v; break; }
      case "ADR": { const country = clean(unescape(value.split(";").at(-1) ?? "")); if (country) out.country = country; break; }
      default: break;
    }
  }
  return drop(out);
}

/** MeCard: `MECARD:N:Last,First;TEL:...;EMAIL:...;ORG:...;TITLE:...;URL:...;ADR:...;;`. `\;` `\:` `\,` are escaped. */
export function parseMeCard(text: string): Fields {
  const body = text.replace(/^MECARD:/i, "");
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && i + 1 < body.length) { cur += body[++i]; continue; }
    if (ch === ";") { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  const out: Fields = {};
  for (const p of parts) {
    const i = p.indexOf(":");
    if (i < 1) continue;
    const key = p.slice(0, i).toUpperCase(), v = clean(p.slice(i + 1));
    if (!v) continue;
    if (key === "N") { const [last, first] = v.split(","); out.name = first ? `${clean(first)} ${clean(last)}`.trim() : clean(last); }
    else if (key === "EMAIL" && !out.email) out.email = v;
    else if (key === "TEL" && !out.phone) out.phone = v;
    else if (key === "ORG") out.company = v;
    else if (key === "TITLE") out.title = v;
    else if (key === "URL" && /linkedin\.com/i.test(v)) out.linkedin = v;
    else if (key === "ADR") { const c = clean(v.split(",").at(-1)); if (c) out.country = c; }
  }
  return drop(out);
}

function drop(f: Fields): Fields {
  const o: Fields = {};
  for (const k of FIELD_NAMES) if (f[k]) o[k] = f[k]!.slice(0, 200);
  return o;
}

export type Payload =
  | { kind: "vcard" | "mecard" | "link"; fields: Fields }
  | { kind: "id"; id: string };

/** What a decoded code is. A contact link has a query that names a person; anything else short enough is an id for the organizer to resolve. */
export function classifyPayload(raw: string): Payload | null {
  const text = raw.trim().slice(0, 4000);
  if (!text) return null;
  if (/^BEGIN:VCARD/i.test(text)) { const f = parseVCard(text); return Object.keys(f).length ? { kind: "vcard", fields: f } : null; }
  if (/^MECARD:/i.test(text)) { const f = parseMeCard(text); return Object.keys(f).length ? { kind: "mecard", fields: f } : null; }
  if (/^https?:\/\//i.test(text)) {
    try {
      const u = new URL(text), q = u.searchParams, f: Fields = {};
      const pick = (...names: string[]) => names.map((n) => q.get(n)).find(Boolean) ?? undefined;
      const first = pick("first_name", "firstname", "fname"), last = pick("last_name", "lastname", "lname");
      const name = pick("name", "fullname", "full_name") ?? (first || last ? [first, last].filter(Boolean).join(" ") : undefined);
      Object.assign(f, drop({ name: name ? clean(name) : undefined, email: pick("email", "e") ? clean(pick("email", "e")) : undefined, company: pick("company", "org", "organization"), title: pick("title", "job", "jobtitle"), phone: pick("phone", "tel") }));
      if (f.name || f.email) return { kind: "link", fields: f };
      // A link with no person in it: the last path segment or the `id` parameter is the badge id.
      const id = q.get("id") ?? q.get("code") ?? u.pathname.split("/").filter(Boolean).at(-1);
      return id ? { kind: "id", id: id.slice(0, 200) } : null;
    } catch { return null; }
  }
  if (text.length > 200 || /\s{2,}|\n/.test(text)) return null;
  return { kind: "id", id: text };
}

/* ------------------------------------------------------------------ keys and near matches */

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
export const normEmail = (s: string | null | undefined) => { const e = (s ?? "").trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null; };

export interface PersonKey { id: string; name: string | null; company: string | null; email: string | null }

/** Two people the finder did not match that may still be one: the same company and the same last name with a first name that is a prefix of the other
    (Bob, Robert is not caught, a typo and a short form are), or the same name with different companies at the same email domain. Pure; the caller removes the person it just placed. */
export function nearMatches(me: PersonKey, others: PersonKey[]): { id: string; why: string }[] {
  const mine = words(me.name ?? ""), co = fold(me.company ?? "").replace(/[^a-z0-9]/g, "");
  if (mine.length < 2) return [];
  const [mFirst, mLast] = [mine[0], mine.at(-1)!];
  const out: { id: string; why: string }[] = [];
  for (const o of others) {
    if (o.id === me.id) continue;
    const t = words(o.name ?? "");
    if (t.length < 2) continue;
    const [tFirst, tLast] = [t[0], t.at(-1)!];
    const oc = fold(o.company ?? "").replace(/[^a-z0-9]/g, "");
    const sameCompany = Boolean(co) && co === oc;
    const sameLast = mLast === tLast || editDistance(mLast, tLast) === 1;
    const firstClose = mFirst !== tFirst && (mFirst.startsWith(tFirst) || tFirst.startsWith(mFirst) || editDistance(mFirst, tFirst) === 1) && Math.min(mFirst.length, tFirst.length) >= 2;
    const sameFirst = mFirst === tFirst;
    if (sameCompany && sameLast && (firstClose || (sameFirst && mLast !== tLast))) { out.push({ id: o.id, why: "Same company, a name one letter or a short form apart" }); continue; }
    const d1 = domainOf(me.email), d2 = domainOf(o.email);
    if (!sameCompany && mFirst === tFirst && mLast === tLast && d1 && d1 === d2) out.push({ id: o.id, why: "Same name and email domain, written with a different company" });
  }
  return out;
}
const domainOf = (e: string | null) => (e && e.includes("@") ? e.split("@")[1].toLowerCase() : null);
function editDistance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return 9;
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) { d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); }
  return d[m][n];
}

/* ------------------------------------------------------------------ CSV */

/** A spreadsheet runs a cell that starts with these. A phone number written with a leading plus is left alone. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[\s]*[=+\-@\t\r]/.test(s) && !/^\+[0-9 ().-]+$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");

export const CSV_HEAD = ["Scanned", "Rep", "Method", "Name", "Email", "Company", "Title", "Phone", "Country", "Interest", "Qualifiers", "Note", "Promised", "Promise owner", "Next step", "Next step on", "Marketing consent", "State", "Scan id", "From the session"];

/** The magic bytes decide the type of a photo, never the client's word. */
export function imageMime(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

/** What a scan must carry before it can become a person: an email, a LinkedIn profile, or a name and a company. */
export const placeable = (f: Fields) => Boolean(normEmail(f.email) || f.linkedin || (f.name && f.company));

export const SCAN_ID = /^[A-Za-z0-9-]{8,64}$/;
