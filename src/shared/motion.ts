/* What happens to an event after its list is delivered (docs/LIFECYCLE.md, sections 1 and 2). Pure rules, shared by the server and the screens. */

export const MOTIONS = ["none", "owners", "sequencing", "in_market", "closing", "scored"] as const;
export type Motion = (typeof MOTIONS)[number];

const ALLOWED: Record<Motion, Motion[]> = {
  none: ["owners", "sequencing", "closing"],
  owners: ["sequencing", "closing"],
  sequencing: ["in_market", "closing"],
  in_market: ["closing"],
  closing: ["scored"],
  scored: [],
};
export const motionError = (from: Motion, to: Motion) => (ALLOWED[from].includes(to) ? null : `An event at ${from} cannot move to ${to}.`);

export const MOTION_LABEL: Record<Motion, string> = { none: "Delivered", owners: "Account owners deciding", sequencing: "Sequences being set up", in_market: "In market", closing: "Closing out", scored: "Scored" };

/** The channels a person can be reached on, and what each needs. */
export const CHANNELS = ["email", "linkedin"] as const;
export type Channel = (typeof CHANNELS)[number];

/* ---------------------------------------------------------------- clocks */

const ZONES: Record<string, string> = {
  "united states": "America/New_York", usa: "America/New_York", us: "America/New_York", canada: "America/Toronto", mexico: "America/Mexico_City", brazil: "America/Sao_Paulo", argentina: "America/Argentina/Buenos_Aires",
  colombia: "America/Bogota", chile: "America/Santiago", "dominican republic": "America/Santo_Domingo", "united kingdom": "Europe/London", uk: "Europe/London", ireland: "Europe/Dublin", spain: "Europe/Madrid", portugal: "Europe/Lisbon",
  france: "Europe/Paris", germany: "Europe/Berlin", netherlands: "Europe/Amsterdam", italy: "Europe/Rome", singapore: "Asia/Singapore", japan: "Asia/Tokyo", india: "Asia/Kolkata", "united arab emirates": "Asia/Dubai", uae: "Asia/Dubai", australia: "Australia/Sydney",
};
export const zoneOf = (country: string | null | undefined) => ZONES[(country ?? "").trim().toLowerCase()] ?? null;
/* Countries that span zones: the city decides. Checked against the venue before the country. */
const CITY_ZONES: [RegExp, string][] = [
  [/las vegas|los angeles|san francisco|san diego|san jose|seattle|portland|palm desert|palm springs|anaheim/i, "America/Los_Angeles"],
  [/denver|salt lake/i, "America/Denver"], [/phoenix|scottsdale/i, "America/Phoenix"],
  [/chicago|austin|dallas|houston|nashville|minneapolis|new orleans/i, "America/Chicago"],
  [/vancouver/i, "America/Vancouver"], [/calgary/i, "America/Edmonton"], [/perth/i, "Australia/Perth"], [/brisbane/i, "Australia/Brisbane"],
];
/** The zone an event happens in: its city where the country spans several zones, else its country. */
export const zoneAt = (venue: string | null | undefined, country: string | null | undefined) => CITY_ZONES.find(([re]) => re.test(venue ?? ""))?.[1] ?? zoneOf(country);

/** The calendar day at `at` in the zone, YYYY-MM-DD. Unknown countries read UTC, and the screen says so. */
export function localDay(at: Date, country: string | null | undefined) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zoneOf(country) ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
const utc = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / 86_400_000);
export const addDays = (ymd: string, n: number) => new Date(utc(ymd) + n * 86_400_000).toISOString().slice(0, 10);

/** Sequences are split by the recipient's part of the world, so nobody gets a 3 a.m. email. */
export type ZoneGroup = "americas" | "emea" | "apac" | "event";
export const GROUP_ZONE: Record<Exclude<ZoneGroup, "event">, string> = { americas: "America/New_York", emea: "Europe/Madrid", apac: "Asia/Singapore" };
export function zoneGroupOf(place: string | null | undefined): ZoneGroup {
  const z = zoneOf(place?.split(",").at(-1)?.trim() ?? null);
  if (!z) return "event";
  return z.startsWith("America/") ? "americas" : z.startsWith("Europe/") || z.startsWith("Africa/") ? "emea" : "apac";
}

/** The moment `n` business days after `from`, skipping weekends and holidays, at the same time of day. */
export function addBusinessDays(from: Date, n: number, holidays: string[] = []) {
  let t = from.getTime(), left = n;
  while (left > 0) {
    t += 86_400_000;
    const d = new Date(t), wd = d.getUTCDay(), ymd = d.toISOString().slice(0, 10);
    if (wd !== 0 && wd !== 6 && !holidays.includes(ymd)) left--;
  }
  return new Date(t);
}

/** Full business days after `from`, up to and including `to`. Weekends do not count, and neither do the desk's configured holidays. */
export function businessDaysAfter(from: string, to: string, holidays: string[] = []) {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
    const wd = new Date(utc(d)).getUTCDay();
    if (wd !== 0 && wd !== 6 && !holidays.includes(d)) n++;
  }
  return n;
}

/* ---------------------------------------------------------- the Motion card */

export interface MotionRates { replies_per_person: number; debrief_calls_per_meeting: number; meetings_per_company: number; successor_credits: number; contact_create_credits: number }
export const DEFAULT_MOTION_RATES: MotionRates = { replies_per_person: 2, debrief_calls_per_meeting: 1, meetings_per_company: 1, successor_credits: 1, contact_create_credits: 0 };

export const MOTION_STEPS = ["reply_classify", "debrief_extract", "successor_find", "contact_create"] as const;

/** Worst case first: everyone replies the most we will read, every company has a meeting, every company needs a successor found. */
export function quoteMotion(i: { people: number; companies: number }, r: MotionRates, llmCallCents: number) {
  const reply_llm = i.people * r.replies_per_person;
  const debrief_llm = i.companies * r.meetings_per_company * r.debrief_calls_per_meeting;
  const successor_credits = i.companies * r.successor_credits;
  const contact_credits = i.people * r.contact_create_credits;
  const llm_cap = reply_llm + debrief_llm, credits_cap = successor_credits + contact_credits;
  return {
    lines: { people: i.people, companies: i.companies, reply_llm, debrief_llm, successor_credits, contact_credits },
    llm_cap, credits_cap, est_cents: llm_cap * llmCallCents,
    step_caps: { reply_classify: { llm: reply_llm }, debrief_extract: { llm: debrief_llm }, successor_find: { credits: successor_credits }, contact_create: { credits: contact_credits } },
  };
}

/* --------------------------------------------------------------- replies */

export const REPLY_CODES = ["interested", "meeting_request", "referral", "not_now", "not_interested", "out_of_office", "unsubscribe", "bounced", "wrong_person", "departed", "other"] as const;
export type ReplyCode = (typeof REPLY_CODES)[number];

/** Reply rates leave these out: they are not someone answering the outreach. */
export const CARVE_OUT_CODES: ReplyCode[] = ["out_of_office", "bounced", "unsubscribe", "wrong_person", "departed"];

const UNSUB = /\b(unsubscribe|remove me|take me off|stop (emailing|contacting|messaging) me|opt[ -]?out|do not (email|contact) me|don'?t (email|contact) me|no more emails|darme de baja|d[aá]nme de baja|no me (escribas|contactes|env[ií]es)|dejen de (escribirme|contactarme)|b[oó]rrame|abmelden|austragen|nicht mehr kontaktieren|keine (e-?mails|mails) mehr|d[eé]sabonner|d[eé]sinscrire|ne me contactez plus|descadastrar|n[aã]o me (envie|contate))\b/i;
/** Code runs first. A match here acts whatever a model later says. */
export const matchesUnsubscribe = (body: string | null | undefined) => UNSUB.test(body ?? "");

/** The return date in an out-of-office, when it plainly states one. Otherwise null, and the caller waits 7 days. */
export function returnDate(body: string | null | undefined, now: Date): string | null {
  const m = (body ?? "").match(/\b(?:back|return(?:ing)?)\b[^.\n]{0,40}?\b(\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2})\b/i);
  if (!m) return null;
  if (/^\d{4}/.test(m[1])) return Number.isNaN(Date.parse(m[1])) ? null : m[1];
  const t = Date.parse(`${m[1].replace(".", "")}, ${now.getUTCFullYear()} 00:00:00 UTC`);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  if (d < now) d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}
