/* The desk's one outreach check for a hosted guest (docs/HOSTED.md 2 and 21.8): a country on the blocked list, or no country at all, is never emailed by the desk.
   The list is config/defaults.json email_country_rules.blocked; this module takes it as an argument so the client can use it too. A guest's own yes does not lift a block. */

export const COUNTRY_BLOCKED = "Not emailed in this country";
export const COUNTRY_UNKNOWN = "Their country is not known, so no email until it is";

const NAMES: Record<string, string> = {
  italy: "IT", switzerland: "CH", sweden: "SE", denmark: "DK", belgium: "BE", austria: "AT", norway: "NO", germany: "DE", "united states": "US", usa: "US", "united kingdom": "GB", uk: "GB",
  france: "FR", spain: "ES", portugal: "PT", netherlands: "NL", ireland: "IE", canada: "CA", mexico: "MX", brazil: "BR", australia: "AU", singapore: "SG", japan: "JP", india: "IN", poland: "PL", finland: "FI",
  "dominican republic": "DO", argentina: "AR", colombia: "CO",
};

/** An ISO code in upper case, or null when the text is empty or not a country this knows. A two-letter code is taken as typed. */
export function normalizeCountry(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
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
