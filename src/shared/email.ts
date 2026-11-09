/* Email, the code half (docs/TIERING-AND-ENRICHMENT.md, "Layer 5"): which addresses are never worth a verifier credit, the patterns people's
   addresses follow, and the keys suppression uses. Pure: no database, no vendor. */

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/ø/g, "o").replace(/ł/g, "l").toLowerCase();

/** Role mailboxes reach a team or a shared inbox, not one person. */
const ROLE = new Set(["info", "sales", "admin", "support", "contact", "hello", "office", "team", "help", "billing", "marketing", "hr", "jobs", "careers", "press", "media", "noreply", "no-reply", "donotreply", "postmaster", "webmaster", "abuse", "security", "accounts", "enquiries", "inquiries", "mail", "events", "reception"]);
const DISPOSABLE = new Set(["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com", "throwaway.email", "maildrop.cc", "dispostable.com"]);

export const emailDomain = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase().trim();
export const emailLocal = (email: string) => email.slice(0, email.lastIndexOf("@")).toLowerCase().trim();
export const isRoleAddress = (email: string) => ROLE.has(emailLocal(email).replace(/[._+].*$/, "")) || ROLE.has(emailLocal(email));
export const isDisposable = (email: string) => DISPOSABLE.has(emailDomain(email));
export const looksLikeEmail = (s: string) => /^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(s.trim());

/** The key suppression uses for a person's name and for a company: lowercase, accents folded, letters and digits only, words sorted so their order does not matter. */
export const nameKey = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean).sort().join(" ");

export const PATTERNS = ["first.last", "flast", "first", "firstl", "first_last", "last.first"] as const;
export type Pattern = (typeof PATTERNS)[number];
const letters = (s: string) => fold(s).replace(/[^a-z]/g, "");

export function applyPattern(p: Pattern, first: string, last: string): string {
  const f = letters(first), l = letters(last);
  switch (p) {
    case "flast": return f[0] + l;
    case "first": return f;
    case "firstl": return f + l[0];
    case "first_last": return `${f}_${l}`;
    case "last.first": return `${l}.${f}`;
    default: return `${f}.${l}`;
  }
}
/** The pattern a verified address follows for a known name, or null. */
export function patternOf(email: string, first: string, last: string): Pattern | null {
  if (!letters(first) || !letters(last)) return null;
  return PATTERNS.find((p) => applyPattern(p, first, last) === emailLocal(email)) ?? null;
}
/** The pattern most verified addresses at a domain follow, when at least two agree. */
export function dominantPattern(known: { email: string; first: string; last: string }[]): Pattern | null {
  const n = new Map<Pattern, number>();
  for (const k of known) { const p = patternOf(k.email, k.first, k.last); if (p) n.set(p, (n.get(p) ?? 0) + 1); }
  const best = [...n].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 2 ? best[0] : null;
}

/** The first and last name of a full name, when there are at least two words. */
export function firstLast(full: string | null | undefined): { first: string; last: string } | null {
  const w = (full ?? "").trim().split(/\s+/).filter(Boolean);
  return w.length >= 2 ? { first: w[0], last: w[w.length - 1] } : null;
}

/** Does the local part of an address fit the name it is filed under? A name token of three letters or more inside it, or the two initials, fits. A verified address
    proves a mailbox exists, not that it belongs to this person, so one that does not fit becomes a review case. */
export function localFitsName(email: string, fullName: string | null | undefined): boolean {
  const local = fold(emailLocal(email)).replace(/[^a-z]/g, "");
  const tokens = fold(fullName ?? "").split(/[^a-z]+/).filter(Boolean);
  if (!local || !tokens.length) return true;
  if (tokens.some((t) => t.length >= 3 && local.includes(t))) return true;
  const initials = tokens.map((t) => t[0]).join("");
  return local === initials || (tokens.length >= 2 && (local === tokens[0][0] + tokens[tokens.length - 1] || local === tokens[0] + tokens[tokens.length - 1][0]));
}
