/* The directory extension and the screen recording, the parts that are only code (docs/DIRECTORY.md 3, 5, 7 and 9). Pure: the server, the extension and the tests share it. */

import { companyKey } from "./ingest.ts";
import { ascii, nameSet } from "./layer0.ts";

/* ------------------------------------------------------------------ limits */

export const MAX_PEOPLE_PER_SEND = 200;
export const MAX_READS_PER_EVENT = 3000;
export const MAX_PEOPLE_PER_MINUTE = 600;
export const MAX_KEYS_PER_OWNER = 5;
export const MAX_FRAMES_PER_RECORDING = 250;
/** Model calls on frames, an event. The spend control for the recording read: it is not on the cost card. */
export const MAX_FRAME_CALLS_PER_EVENT = 800;
export const MAX_PEOPLE_PER_FRAME = 40;
export const MAX_FRAME_BYTES = 4_000_000;
export const FIELD_MAX = 200;
export const STALE_FRAME_MINUTES = 10;

/* ------------------------------------------------------------------ platforms */

/** The platforms the extension can name. The extension has readers for some of them; the server accepts all. */
export const CAPTURE_PLATFORMS = ["swapcard", "brella", "grip", "whova", "cvent", "other"] as const;
export type CapturePlatform = (typeof CAPTURE_PLATFORMS)[number];
export const isCapturePlatform = (v: unknown): v is CapturePlatform => typeof v === "string" && (CAPTURE_PLATFORMS as readonly string[]).includes(v);
export const PLATFORM_LABELS: Record<CapturePlatform, string> = { swapcard: "Swapcard", brella: "Brella", grip: "Grip", whova: "Whova", cvent: "Cvent", other: "web" };
/** Hosts a profile link may be on: the platforms above and LinkedIn. A link anywhere else is dropped from the read, not the person. */
export const PROFILE_HOSTS = ["swapcard.com", "brella.io", "grip.events", "whova.com", "cvent.com", "cvent.me", "linkedin.com"] as const;

/* ------------------------------------------------------------------ cleaning */

/** Trimmed, control characters out, cut to 200. Empty becomes "". */
export const cleanText = (v: unknown, max = FIELD_MAX): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** A profile link kept as `https://host/path`, or null: it must be https and on a known platform host (or LinkedIn). */
export function cleanProfileUrl(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || s.length > 500) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (!PROFILE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

/** The profile URL without query or fragment, lower case, no trailing slash; null when it is not one. */
export function profileKey(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  try { const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`); return `${u.origin}${u.pathname}`.toLowerCase().replace(/\/+$/, ""); } catch { return null; }
}

/** One person is one key: the profile link when there is one, else the name and the company. */
export function dedupeKey(p: { name: string; company?: string | null; profile_url?: string | null }): string {
  const u = profileKey(p.profile_url);
  return u ? `u:${u}` : `n:${nameSet(p.name)}|${companyKey(p.company ?? "")}`;
}

/** The key a person's name and company make, which is what erasure looks for on any event. */
export const nameKeyOf = (name: string, company: string | null | undefined) => `n:${nameSet(name)}|${companyKey(company ?? "")}`;

/* ------------------------------------------------------------------ what is "to check" */

export interface ReadFields { name: string; title?: string | null; company?: string | null }
export interface Judgement { state: "staged" | "to_check"; reason: string | null }

/** A string that reads like an instruction or a link, not a person or a company. A frame that steers the model passes the transcription check, so this is the second net. */
export const looksLikeText = (s: string) => /\b(ignore|instructions?|system)\b/i.test(s) || /https?:\/\/|www\./i.test(s) || s.trim().split(/\s+/).filter(Boolean).length > 6;

/** The one rule for both paths (docs/DIRECTORY.md 7 and 13.9). The reason is stored in words. `low` is what the model said about a name or a company. */
export function judgeRead(r: ReadFields, low: { name?: boolean; company?: boolean } = {}): Judgement {
  const name = (r.name ?? "").trim(), title = (r.title ?? "").trim(), company = (r.company ?? "").trim();
  const to = (reason: string): Judgement => ({ state: "to_check", reason });
  if (looksLikeText(name) || looksLikeText(company)) return to("Looks like text, not a person");
  if (!/\p{L}/u.test(name)) return to("Name has no letters");
  if (/\d/.test(name)) return to("Name has a digit");
  if (name.length > 80) return to("Name is longer than 80 characters");
  if (name.split(/\s+/).length < 2) return to("Name is one word");
  if (!title && !company) return to("No title or company");
  if (low.name || low.company) return to("Read with low confidence");
  return { state: "staged", reason: null };
}

/* ------------------------------------------------------------------ the read of one frame */

export interface FramePerson { name: string; title: string; company: string; location: string; low: { name: boolean; company: boolean } }
const squash = (t: string) => ascii(t).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** What a frame read answered, kept to what is safe (docs/DIRECTORY.md 9): a person only when the transcription holds the name; a title, company or place not in the transcription is thrown away;
    at most 40 people; every field cut to 200. Pure. The result goes through `judgeRead`. */
export function checkFrame(text: string): { people: FramePerson[]; dropped: string[]; transcript: string; valid: boolean } {
  let j: any = null;
  try { j = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); } catch { /* an answer that is not JSON reads as nothing */ }
  const valid = Boolean(j && typeof j === "object" && Array.isArray(j.people));
  const transcript = typeof j?.text === "string" ? j.text : "";
  const hay = squash(transcript);
  const people: FramePerson[] = [], dropped: string[] = [];
  const list: unknown[] = valid ? j.people : [];
  for (const raw of list) {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
    const name = cleanText(o.name);
    if (!/\p{L}/u.test(name)) { dropped.push("a row with no name"); continue; }
    if (!hay.includes(squash(name))) { dropped.push(`${name}: not in the transcription`); continue; }
    if (people.length >= MAX_PEOPLE_PER_FRAME) { dropped.push("more than 40 people in one frame"); continue; }
    const field = (k: "title" | "company" | "location") => {
      const v = cleanText(o[k]);
      if (v && !hay.includes(squash(v))) { dropped.push(`${name}: ${k} not in the transcription`); return ""; }
      return v;
    };
    const conf = (o.confidence && typeof o.confidence === "object" ? o.confidence : {}) as Record<string, unknown>;
    people.push({ name, title: field("title"), company: field("company"), location: field("location"), low: { name: conf.name === "low", company: conf.company === "low" } });
  }
  return { people, dropped, transcript, valid };
}

/* ------------------------------------------------------------------ what each person keeps */

/** "read from the Swapcard directory of AWS re:Invent 2026 by Maya Ortiz on 2026-11-14". Built by the server; the extension sends none of it. */
export function extensionSource(p: { platform: CapturePlatform; eventName: string; by: string; on: string }): string {
  const where = p.platform === "other" ? "a web directory" : `the ${PLATFORM_LABELS[p.platform]} directory`;
  return `read from ${where} of ${p.eventName} by ${p.by} on ${p.on}`;
}
/** "read from a screen recording of Brella for AWS re:Invent 2026 by Maya Ortiz on 2026-11-14". */
export const recordingSource = (p: { app: string; eventName: string; by: string; on: string }) => `read from a screen recording of ${p.app} for ${p.eventName} by ${p.by} on ${p.on}`;
/** The event's confirmed `terms` answer from the assessment, or the plain fact that there is none. */
export const termsNote = (answer: string | null | undefined) => (answer && answer.trim() ? `Terms: ${answer.trim().slice(0, 300)}` : "Terms not assessed");

/* ------------------------------------------------------------------ the outreach rule */

export const COUNTRY_NAMES: Record<string, string> = { IT: "Italy", CH: "Switzerland", SE: "Sweden", DK: "Denmark", BE: "Belgium", AT: "Austria", NO: "Norway", DE: "Germany" };
const joinWords = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/** The one line on the Directory panel, built from the same list the gate reads (config/defaults.json email_country_rules.blocked). */
export function outreachRule(blocked: readonly string[]): string {
  const names = joinWords(blocked.map((c) => COUNTRY_NAMES[c.toUpperCase()] ?? c.toUpperCase()));
  return `People read from a directory or a recording are contacted under the same rules as anyone else, by country and never by where they were read from. `
    + (names ? `Email is not sent to people in ${names}. A person with no country on record falls back to their company's country, so a company in one of those countries is held back too. LinkedIn touches are not affected.` : "No country is blocked for email.");
}
