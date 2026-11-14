/* The organizer adapter (docs/SCANNER.md 7 and 14): one interface that turns a badge id into a person, with Swapcard's Exhibitor API as the first
   implementation and a fake for tests and the demo. What Swapcard documents is quoted in the comments; what it does not say is not assumed.
   Source: https://release.swapcard.com (third-party lead capture via the Exhibitor API) and https://swapcard.dev/content-api/examples/scan-badges.
   A live call waits for a show that enables it: nothing here runs without an exhibitor key, and the tests use a recorded transport. */

export interface OrganizerRef { event_ref: string; exhibitor_ref: string }
export interface ResolvedBadge {
  kind: "found";
  /** The organizer's own id for the connection or person, when it gives one. */
  registrant_id: string | null;
  fields: { name?: string; title?: string; company?: string; email?: string; country?: string };
}
export type Resolution =
  | ResolvedBadge
  /** The organizer does not know this code. The scan fails and says so. */
  | { kind: "not_found" }
  /** The organizer says this exhibitor may not look this person up (the feature is off for them, or the person is not in the event). A retry cannot help. */
  | { kind: "refused"; reason: "feature_not_allowed" | "user_not_in_event" }
  /** No key, no network, or an answer that is not the documented shape. The scan stays waiting and is tried again. */
  | { kind: "unavailable"; why: string };

export interface OrganizerAdapter {
  id: "swapcard" | "fake";
  /** Is there what a call needs (a key for this exhibitor)? Never returns the key. */
  ready(ref: OrganizerRef): boolean;
  resolveBadge(ref: OrganizerRef, code: string): Promise<Resolution>;
}

export interface Transport { (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }): Promise<{ status: number; json(): Promise<unknown> }> }

export const SWAPCARD_URL = "https://developer.swapcard.com/exhibitor/graphql";

/** The mutation as the developer page gives it: `scanBadges(input: ScanBadgesInput!)`, an input of `eventId`, `exhibitorId` and `scanBadges: [{code, note?, rating?}]`,
    answering per badge an `errorCode` or a `connection` whose `target` holds `firstName`, `lastName`, `jobTitle`, `email`, `organization` and `address`. */
export const SWAPCARD_MUTATION = `mutation scanBadges($input: ScanBadgesInput!) {
  scanBadges(input: $input) {
    badges { errorCode connection { id target { __typename ... on EventPerson { firstName lastName jobTitle email organization address { city country place street zipCode } } } } }
    errors { inputId message code }
  }
}`;

/** Keys are per exhibitor and per show: `SWAPCARD_KEYS` is a JSON map from exhibitor ref to key. The header is sent exactly as stored; the page does not say whether Swapcard wants a Bearer prefix. */
export function swapcardKeys(env: Record<string, string | undefined> = process.env): Record<string, string> {
  try { const j = JSON.parse(env.SWAPCARD_KEYS ?? "{}"); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function swapcardAdapter(opts: { transport?: Transport; keys?: Record<string, string> } = {}): OrganizerAdapter {
  const transport: Transport = opts.transport ?? (async (url, init) => { const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }); return { status: r.status, json: () => r.json() }; });
  const keys = () => opts.keys ?? swapcardKeys();
  return {
    id: "swapcard",
    ready: (ref) => Boolean(ref.event_ref && ref.exhibitor_ref && keys()[ref.exhibitor_ref]),
    async resolveBadge(ref, code) {
      const key = keys()[ref.exhibitor_ref];
      if (!key || !ref.event_ref) return { kind: "unavailable", why: "No exhibitor key for this show is set." };
      // One badge a call: the documented rate and batch limits are not in the pages read.
      const body = JSON.stringify({ query: SWAPCARD_MUTATION, variables: { input: { eventId: ref.event_ref, exhibitorId: ref.exhibitor_ref, scanBadges: [{ code }] } } });
      let res;
      try { res = await transport(SWAPCARD_URL, { method: "POST", headers: { "content-type": "application/json", authorization: key }, body }); }
      catch { return { kind: "unavailable", why: "The organizer could not be reached." }; }
      if (res.status >= 500 || res.status === 429) return { kind: "unavailable", why: `The organizer answered ${res.status}.` };
      if (res.status === 401 || res.status === 403) return { kind: "unavailable", why: "The organizer refused the key." };
      let j: any;
      try { j = await res.json(); } catch { return { kind: "unavailable", why: "The organizer's answer was not readable." }; }
      const entry = j?.data?.scanBadges?.badges?.[0];
      if (!entry) return { kind: "unavailable", why: "The organizer's answer did not have the documented shape." };
      switch (entry.errorCode) {
        case "CODE_NOT_FOUND": return { kind: "not_found" };
        case "FEATURE_NOT_ALLOWED": return { kind: "refused", reason: "feature_not_allowed" };
        case "USER_NOT_IN_EVENT": return { kind: "refused", reason: "user_not_in_event" };
        case null: case undefined: break;
        default: return { kind: "unavailable", why: "The organizer answered an error this desk does not know." };
      }
      const t = entry.connection?.target;
      if (!t || typeof t !== "object") return { kind: "unavailable", why: "The organizer's answer had no person in it." };
      const name = [str(t.firstName), str(t.lastName)].filter(Boolean).join(" ");
      const country = str(t.address?.country);
      return { kind: "found", registrant_id: str(entry.connection?.id) ?? null, fields: { ...(name ? { name } : {}), ...(str(t.jobTitle) ? { title: str(t.jobTitle) } : {}), ...(str(t.organization) ? { company: str(t.organization) } : {}), ...(str(t.email) ? { email: str(t.email) } : {}), ...(country ? { country } : {}) } };
    },
  };
}

/** For tests and the demo: a table from code to answer. A code it does not know is not found. `down` makes every call unavailable. */
export function fakeOrganizer(table: Record<string, Resolution>, opts: { down?: boolean; calls?: string[] } = {}): OrganizerAdapter {
  return {
    id: "fake",
    ready: () => true,
    async resolveBadge(_ref, code) {
      opts.calls?.push(code);
      if (opts.down) return { kind: "unavailable", why: "The organizer could not be reached." };
      return table[code] ?? { kind: "not_found" };
    },
  };
}

export const ORGANIZER_WORDS: Record<string, string> = { swapcard: "Swapcard" };
export const refusalWords = (r: "feature_not_allowed" | "user_not_in_event") => (r === "feature_not_allowed" ? "The organizer has not turned lead lookup on for this exhibitor." : "The organizer says this person is not in the event.");
