/* The desk's one outreach check for a hosted guest (docs/HOSTED.md 2 and 21.8): a country on the blocked list, or no country at all, is never emailed by the desk.
   The list is config/defaults.json email_country_rules.blocked; this module takes it as an argument so the client can use it too. A guest's own yes does not lift a block. */

export const COUNTRY_BLOCKED = "Not emailed in this country";
export const COUNTRY_UNKNOWN = "Their country is not known, so no email until it is";

/** The countries the desk knows (the same 25 as the outbound desk's gate). Anything else is unknown, so it is not emailed. */
const KNOWN = new Set(["US", "CA", "GB", "DE", "FR", "NL", "ES", "IE", "BR", "AU", "SG", "IT", "BE", "SE", "DK", "PL", "AT", "PT", "FI", "CH", "NO", "IN", "JP", "MX", "NZ"]);
const NAMES: Record<string, string> = {
  "united states": "US", "united states of america": "US", usa: "US", america: "US", canada: "CA", "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB", scotland: "GB", wales: "GB",
  germany: "DE", france: "FR", netherlands: "NL", "the netherlands": "NL", holland: "NL", spain: "ES", ireland: "IE", brazil: "BR", australia: "AU", singapore: "SG", italy: "IT", belgium: "BE",
  sweden: "SE", denmark: "DK", poland: "PL", austria: "AT", portugal: "PT", finland: "FI", switzerland: "CH", norway: "NO", india: "IN", japan: "JP", mexico: "MX", "new zealand": "NZ",
};

/** An ISO code in upper case, or null when the text is empty or not a country this knows. A two-letter code counts only when it is one of the known ones ("UK" is GB). */
export function normalizeCountry(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) { const c = s.toUpperCase() === "UK" ? "GB" : s.toUpperCase(); return KNOWN.has(c) ? c : null; }
  return NAMES[s.toLowerCase()] ?? null;
}

export interface MailVerdict { ok: boolean; reason: string | null; code: "ok" | "blocked" | "unknown" }

/** May the desk email someone in this country? `blocked` is the list of ISO codes. */
export function emailAllowed(country: string | null | undefined, blocked: readonly string[]): MailVerdict {
  const c = normalizeCountry(country ?? "");
  if (!c) return { ok: false, reason: COUNTRY_UNKNOWN, code: "unknown" };
  if (blocked.map((b) => b.toUpperCase()).includes(c)) return { ok: false, reason: COUNTRY_BLOCKED, code: "blocked" };
  return { ok: true, reason: null, code: "ok" };
}
