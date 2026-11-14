/* The scanner's server side (docs/SCANNER.md 7 and 14). A scan arrives with the phone's own id, so a retry is the same scan. Three steps, each its own transaction and each safe to
   run again: the row is stored, the person is resolved (the organizer's API or a photo read, outside any transaction), and the person is placed through today's capture path. */

import type { Db } from "./db.ts";
import { eventZone } from "./meetings.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { captureOnsite } from "./operating.ts";
import { canPlan } from "./money.ts";
import { refusalWords, type OrganizerAdapter } from "./organizer-api.ts";
import type { Llm } from "./providers.ts";
import { fill, promptHash } from "./prompts.ts";
import { companyKey } from "../shared/ingest.ts";
import { addDays } from "../shared/motion.ts";
import {
  classifyPayload, csvRow, CSV_HEAD, DEFAULT_NOTICE, FIELD_NAMES, imageMime, MAX_QUALIFIERS, METHOD_WORDS, METHODS, nearMatches, normEmail, placeable, SCAN_ID, STATE_WORDS, TEMPERATURES,
  type FieldName, type Fields, type Method, type Qualifier, type ScanState,
} from "../shared/scan.ts";

type Q = Db["query"];
/** A reader call costs money. This many a day-and-event is the cap, named when it is hit; it is not on the event's cost card (docs/SCANNER.md 7). */
export const READS_PER_EVENT = 300;
export class ScanInvalid extends RuleError {}
/** The id exists and belongs to someone else. */
export class ScanForeign extends RuleError {}
export class ScanForbidden extends RuleError {}

export interface ScanInput {
  id: string; method: Method; raw_payload?: string; fields?: Record<string, unknown>; registrant_id?: string; temperature?: string; qualifiers?: Record<string, unknown>; note?: string; promise?: string; promise_owner?: string | null;
  next_step?: string; next_step_on?: string | null; marketing_consent?: boolean; notice_version?: number; scanned_at?: string; seconds?: number | null; met?: boolean; device?: string; photo_kind?: "badge" | "card";
}
export interface ScanRow {
  id: string; event_id: string; rep: string; method: Method; raw_payload: string; fields: Fields; uncertain: FieldName[]; registrant_id: string | null; temperature: "hot" | "warm" | "cold"; qualifiers: Record<string, string>; note: string; promise: string;
  promise_owner: string | null; next_step: string; next_step_on: string | null; marketing_consent: boolean; consent_notice_version: number | null; consent_wording: string; consent_at: string | null; scanned_at: string; received_at: string; seconds: number | null;
  met: boolean; state: ScanState; state_detail: string; contact_id: string | null; capture_id: string | null; near_contact_id: string | null; review: "open" | "same" | "different" | null; confirmed_by: string | null; confirmed_at: string | null; device: string;
}
const SCAN_COLS = `id, event_id, rep, method, raw_payload, fields, uncertain, registrant_id, temperature, qualifiers, note, promise, promise_owner, next_step, next_step_on::text AS next_step_on, marketing_consent, consent_notice_version, consent_wording, consent_at::text AS consent_at, scanned_at::text AS scanned_at, received_at::text AS received_at, seconds, met, state, state_detail, contact_id, capture_id, near_contact_id, review, confirmed_by, confirmed_at::text AS confirmed_at, device`;

const s = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max) : "");
export const planner = (actor: string) => canPlan(actor);

/* ------------------------------------------------------------------ settings */

export interface ScannerSettings { qualifiers: Qualifier[]; notice_text: string; notice_version: number; organizer: "swapcard" | null; organizer_event_ref: string; organizer_exhibitor_ref: string; set_up: boolean }

export async function readSettings(q: Q, eventId: string): Promise<ScannerSettings> {
  const [r] = await q<{ qualifiers: Qualifier[]; notice_text: string; notice_version: number; organizer: "swapcard" | null; organizer_event_ref: string; organizer_exhibitor_ref: string }>("SELECT qualifiers, notice_text, notice_version, organizer, organizer_event_ref, organizer_exhibitor_ref FROM scanner_settings WHERE event_id = $1", [eventId]);
  return r ? { ...r, notice_text: r.notice_text || DEFAULT_NOTICE, set_up: true } : { qualifiers: [], notice_text: DEFAULT_NOTICE, notice_version: 1, organizer: null, organizer_event_ref: "", organizer_exhibitor_ref: "", set_up: false };
}

export interface SettingsInput { qualifiers?: unknown; notice_text?: unknown; organizer?: unknown; organizer_event_ref?: unknown; organizer_exhibitor_ref?: unknown }

export async function putSettings(db: Db, actor: string, eventId: string, b: SettingsInput) {
  if (!planner(actor)) throw new ScanForbidden("The field marketer, a planner or leadership sets up the scanner.");
  return db.tx(async (q) => {
    const [ev] = await q("SELECT 1 FROM events WHERE id = $1", [eventId]);
    if (!ev) throw new RuleError("That event does not exist.");
    const cur = await readSettings(q, eventId);
    let qualifiers = cur.qualifiers;
    if (b.qualifiers !== undefined) {
      if (!Array.isArray(b.qualifiers) || b.qualifiers.length > MAX_QUALIFIERS) throw new ScanInvalid(`Give at most ${MAX_QUALIFIERS} qualifiers.`);
      qualifiers = b.qualifiers.map((x, i) => ({ id: `q${i + 1}`, label: s((x as { label?: unknown })?.label, 80) })).filter((x) => x.label);
    }
    let text = cur.notice_text, version = cur.notice_version;
    // Before setup, scans carry version 1, the default wording. Setting up keeps that version in the history, and a different wording is version 2.
    if (!cur.set_up) await q("INSERT INTO scanner_notices (event_id, version, text, set_by) VALUES ($1, 1, $2, 'Events Desk') ON CONFLICT DO NOTHING", [eventId, DEFAULT_NOTICE]);
    if (b.notice_text !== undefined) {
      text = s(b.notice_text, 400) || DEFAULT_NOTICE;
      if (text !== cur.notice_text) version = cur.notice_version + 1;
    }
    const organizer = b.organizer === undefined ? cur.organizer : b.organizer === null || b.organizer === "" ? null : b.organizer === "swapcard" ? "swapcard" : (() => { throw new ScanInvalid("The organizer lookup is none or Swapcard."); })();
    const ev_ref = b.organizer_event_ref === undefined ? cur.organizer_event_ref : s(b.organizer_event_ref, 200);
    const ex_ref = b.organizer_exhibitor_ref === undefined ? cur.organizer_exhibitor_ref : s(b.organizer_exhibitor_ref, 200);
    await q(`INSERT INTO scanner_settings (event_id, qualifiers, notice_text, notice_version, organizer, organizer_event_ref, organizer_exhibitor_ref, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, now())
             ON CONFLICT (event_id) DO UPDATE SET qualifiers = $2::jsonb, notice_text = $3, notice_version = $4, organizer = $5, organizer_event_ref = $6, organizer_exhibitor_ref = $7, updated_by = $8, updated_at = now()`,
      [eventId, JSON.stringify(qualifiers), text, version, organizer, ev_ref, ex_ref, actor]);
    await q("INSERT INTO scanner_notices (event_id, version, text, set_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", [eventId, version, text, actor]);
    await logActivity(q, eventId, actor, "scanner", cur.set_up ? "Changed the scanner's setup" : "Set up scanning");
    return readSettings(q, eventId);
  });
}

/* ------------------------------------------------------------------ ingest */

const ymd = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);

function cleanFields(raw: unknown): Fields {
  const o: Fields = {};
  if (raw && typeof raw === "object") for (const k of FIELD_NAMES) { const v = s((raw as Record<string, unknown>)[k], 200); if (v) o[k] = v; }
  if (o.email) { const e = normEmail(o.email); if (e) o.email = e; else delete o.email; }
  return o;
}

export interface IngestDeps { organizer?: OrganizerAdapter | null; llm?: Llm }

/** What the phone is told about a scan it sent. */
export interface ScanResult { id: string; state: ScanState; state_detail: string; person: { id: string; name: string | null; company: string | null } | null; repeat: boolean; review: "open" | "same" | "different" | null }

export async function ingestScan(db: Db, deps: LifecycleDeps, eventId: string, rep: string, input: ScanInput, ext: IngestDeps = {}): Promise<ScanResult> {
  if (!rep) throw new ScanInvalid("Say who you are before scanning.");
  if (!input || typeof input.id !== "string" || !SCAN_ID.test(input.id)) throw new ScanInvalid("A scan needs an id of 8 to 64 letters, digits or dashes.");
  if (!METHODS.includes(input.method)) throw new ScanInvalid("That is not a scanning method.");
  const temperature = input.temperature === undefined ? "warm" : String(input.temperature);
  if (!(TEMPERATURES as readonly string[]).includes(temperature)) throw new ScanInvalid("Interest is hot, warm or cold.");
  const nextOn = input.next_step_on == null || input.next_step_on === "" ? null : ymd(input.next_step_on);
  if (input.next_step_on && !nextOn) throw new ScanInvalid("The next step's date is a day, like 2026-11-20.");
  const now = nowOf(deps);
  const sent = input.scanned_at ? new Date(input.scanned_at) : null;
  const scannedAt = sent && !Number.isNaN(+sent) && +sent <= +now + 86_400_000 ? sent : now;
  let method = input.method;
  let fields = cleanFields(input.fields);
  let registrant = s(input.registrant_id, 200) || null;
  const raw = s(input.raw_payload, 4000);
  // The server reads the code again, so a phone that sent the wrong class cannot put a made-up person in. A code that carries a person fills the fields the phone left empty.
  if (method === "badge_code" || method === "badge_id") {
    const c = raw ? classifyPayload(raw) : null;
    if (c && c.kind !== "id") { method = "badge_code"; fields = { ...c.fields, ...fields }; }
    else if (c?.kind === "id") { method = "badge_id"; registrant = registrant ?? c.id; }
    else if (!Object.keys(fields).length) throw new ScanInvalid("That code did not read as a person or a badge id.");
  }
  if (method === "badge_id" && !raw) throw new ScanInvalid("A badge id needs the code.");

  const state = await db.tx(async (q) => {
    const [ev] = await q("SELECT 1 FROM events WHERE id = $1", [eventId]);
    if (!ev) throw new RuleError("That event does not exist.");
    const st = await readSettings(q, eventId);
    const version = Number.isInteger(input.notice_version) ? Number(input.notice_version) : st.notice_version;
    const [said] = await q<{ text: string }>("SELECT text FROM scanner_notices WHERE event_id = $1 AND version = $2", [eventId, version]);
    const wording = said?.text ?? (version === st.notice_version ? st.notice_text : "");
    const ids = new Set(st.qualifiers.map((x) => x.id));
    const answers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.qualifiers ?? {})) if (ids.has(k) && (v === "yes" || v === "no")) answers[k] = v;
    const consent = input.marketing_consent === true;
    const ins = await q<{ id: string }>(
      `INSERT INTO scans (id, event_id, rep, method, raw_payload, fields, registrant_id, temperature, qualifiers, note, promise, promise_owner, next_step, next_step_on, marketing_consent, consent_notice_version, consent_wording, consent_at, scanned_at, received_at, seconds, met, device, state, state_detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, 'received', '') ON CONFLICT (id) DO NOTHING RETURNING id`,
      [input.id, eventId, rep, method, raw, JSON.stringify(fields), registrant, temperature, JSON.stringify(answers), s(input.note, 4000), s(input.promise, 1000), input.promise_owner ? s(input.promise_owner, 60) : null, s(input.next_step, 300), nextOn,
        consent, version, wording, consent ? scannedAt.toISOString() : null, scannedAt.toISOString(), now.toISOString(), Number.isInteger(input.seconds) && input.seconds! >= 0 && input.seconds! <= 3600 ? input.seconds : null, input.met === true, s(input.device, 80)]);
    if (ins.length) {
      await logActivity(q, eventId, rep, "scan", `${rep} scanned someone (${METHOD_WORDS[method].toLowerCase()})`);
      return "new";
    }
    const [row] = await q<{ rep: string; state: ScanState; event_id: string }>("SELECT rep, state, event_id FROM scans WHERE id = $1", [input.id]);
    if (!row || row.rep !== rep || row.event_id !== eventId) throw new ScanForeign("That scan id belongs to someone else.");
    return row.state;
  });
  if (state === "new" || state === "received" || state === "lookup_pending") await advance(db, deps, input.id, ext);
  return resultOf(db, input.id, state !== "new");
}

async function resultOf(db: Db, scanId: string, repeat: boolean): Promise<ScanResult> {
  const [r] = await db.query<{ id: string; state: ScanState; state_detail: string; review: ScanResult["review"]; cid: string | null; name: string | null; company: string | null }>(
    "SELECT s.id, s.state, s.state_detail, s.review, k.id AS cid, k.full_name AS name, co.name AS company FROM scans s LEFT JOIN contacts k ON k.id = s.contact_id LEFT JOIN companies co ON co.id = k.company_id WHERE s.id = $1", [scanId]);
  return { id: r.id, state: r.state, state_detail: r.state_detail, repeat, review: r.review, person: r.cid ? { id: r.cid, name: r.name, company: r.company } : null };
}

const loadScan = async (q: Q, id: string): Promise<ScanRow | undefined> => (await q<ScanRow>(`SELECT ${SCAN_COLS} FROM scans WHERE id = $1`, [id]))[0];

/** Runs what a scan in `received` or `lookup_pending` has not yet done. Safe to call again: a claimed row is skipped, a placed row is left alone. */
export async function advance(db: Db, deps: LifecycleDeps, scanId: string, ext: IngestDeps = {}) {
  const claimed = await db.query<{ id: string }>("UPDATE scans SET state = 'resolving', claimed_at = $2 WHERE id = $1 AND state IN ('received', 'lookup_pending') RETURNING id", [scanId, nowOf(deps).toISOString()]);
  if (!claimed.length) return;
  const scan = (await loadScan(db.query, scanId))!;
  try {
    if (scan.method === "badge_id") {
      const st = await readSettings(db.query, scan.event_id);
      const ref = { event_ref: st.organizer_event_ref, exhibitor_ref: st.organizer_exhibitor_ref };
      const a = ext.organizer && (ext.organizer.id === "fake" || ext.organizer.id === st.organizer) ? ext.organizer : null;
      if (!a || !a.ready(ref)) return void (await setState(db, scanId, "lookup_pending", "No organizer lookup is set for this show. The badge id is kept."));
      const r = await a.resolveBadge(ref, scan.raw_payload);
      if (r.kind === "unavailable") return void (await setState(db, scanId, "lookup_pending", r.why));
      if (r.kind === "not_found") return void (await setState(db, scanId, "failed", "The organizer does not know this badge. Photograph it or type the person."));
      if (r.kind === "refused") return void (await setState(db, scanId, "failed", `${refusalWords(r.reason)} Photograph the badge or type the person.`));
      await db.query("UPDATE scans SET fields = $2::jsonb, registrant_id = coalesce($3, registrant_id) WHERE id = $1", [scanId, JSON.stringify({ ...r.fields, ...scan.fields }), scan.raw_payload.slice(0, 200)]);
    }
    if (scan.method === "typed" && scan.fields.email && (!scan.fields.name || !scan.fields.company)) {
      const [k] = await db.query<{ full_name: string | null; company: string; title: string | null }>("SELECT k.full_name, co.name AS company, k.title FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.event_id = $1 AND lower(k.email) = $2 LIMIT 1", [scan.event_id, scan.fields.email]);
      if (k) await db.query("UPDATE scans SET fields = $2::jsonb WHERE id = $1", [scanId, JSON.stringify({ ...(k.full_name ? { name: k.full_name } : {}), company: k.company, ...(k.title ? { title: k.title } : {}), ...scan.fields })]);
    }
    const fresh = (await loadScan(db.query, scanId))!;
    if (placeable(fresh.fields)) await placeScan(db, deps, scanId);
    else await setState(db, scanId, "needs_fields", fresh.method === "badge_photo" || fresh.method === "card_photo" ? "Not read yet." : "Give an email, a LinkedIn profile, or a name and a company.");
  } catch (e) {
    // A thrown error never leaves a scan claimed forever: it goes back to the state a retry can pick up, and says why.
    await setState(db, scanId, scan.method === "badge_id" ? "lookup_pending" : "received", e instanceof RuleError ? e.message : "The desk could not place this scan yet. It will try again.");
    if (!(e instanceof RuleError)) throw e;
  }
}

const setState = (db: Db, id: string, state: ScanState, detail: string) => db.query("UPDATE scans SET state = $2, state_detail = $3 WHERE id = $1 AND state <> 'placed'", [id, state, detail]);

/** The first scan on an event with no list gives it one called Scanner, so the person traces to a row as every person does. */
async function ensureScanList(db: Db, eventId: string, rep: string) {
  // One statement, so two first scans arriving together cannot make two lists.
  await db.query("INSERT INTO uploads (id, event_id, filename, mapping, row_count, uploaded_by) SELECT $1, $2, 'Scanner', '{}'::jsonb, 0, $3 WHERE NOT EXISTS (SELECT 1 FROM uploads WHERE event_id = $2)", [newId("up"), eventId, rep]);
}

/** Places the person: today's capture path, with the scan's own id so a repeat changes nothing. */
export async function placeScan(db: Db, deps: LifecycleDeps, scanId: string) {
  const scan = (await loadScan(db.query, scanId))!;
  if (scan.contact_id) return;
  await ensureScanList(db, scan.event_id, scan.rep);
  const f = scan.fields;
  const photo = scan.method === "badge_photo" || scan.method === "card_photo";
  const badge = scan.method === "badge_code" || scan.method === "badge_id" || scan.method === "badge_photo";
  const out = await captureOnsite(db, deps, scan.event_id, scan.rep, {
    full_name: f.name, email: f.email, linkedin: f.linkedin, company: f.company, title: f.title, note: scan.note, temperature: scan.temperature, met: scan.met, source: badge ? "badge_scan" : "quick_add",
    registrant_id: scan.registrant_id ?? undefined, country: f.country, phone: f.phone, scan_id: scan.id,
    promise: scan.promise ? { text: scan.promise, owner: scan.promise_owner ?? scan.rep, next_step: scan.next_step, next_step_on: scan.next_step_on } : undefined,
    marketing_consent: scan.marketing_consent ? { yes: true, note: `Scanner, notice version ${scan.consent_notice_version ?? "?"}, ${scan.consent_at ?? ""}` } : undefined,
  });
  if (photo) await db.query("UPDATE scans SET state = 'to_confirm', state_detail = 'Read from a photo. Check it.' WHERE id = $1 AND state = 'placed'", [scanId]);
  await flagNear(db, scanId, out.contact_id);
}

/** A person nearly the same as this one that the finder did not match opens a review. The scan stays placed. */
async function flagNear(db: Db, scanId: string, contactId: string) {
  const [me] = await db.query<{ id: string; name: string | null; email: string | null; company: string | null; company_id: string | null }>("SELECT k.id, k.full_name AS name, k.email, co.name AS company, k.company_id FROM contacts k LEFT JOIN companies co ON co.id = k.company_id WHERE k.id = $1", [contactId]);
  if (!me?.name) return;
  const dom = me.email?.split("@")[1] ?? null;
  const others = await db.query<{ id: string; name: string | null; email: string | null; company: string | null }>(
    `SELECT k.id, k.full_name AS name, k.email, co.name AS company FROM contacts k LEFT JOIN companies co ON co.id = k.company_id
     WHERE k.event_id = (SELECT event_id FROM contacts WHERE id = $1) AND k.id <> $1 AND coalesce(k.drop_reason, '') <> 'duplicate' AND (k.company_id = $2 OR ($3::text IS NOT NULL AND lower(k.email) LIKE '%@' || $3)) LIMIT 400`, [contactId, me.company_id, dom]);
  const hits = nearMatches({ id: me.id, name: me.name, company: me.company, email: me.email }, others);
  if (!hits.length) return;
  await db.query("UPDATE scans SET near_contact_id = $2, review = 'open' WHERE id = $1 AND review IS NULL", [scanId, hits[0].id]);
}

/* ------------------------------------------------------------------ resolving what waits */

/** Tries every badge id still waiting on this event, one at a time; a row claimed by another call is skipped. Returns how many were tried. */
export async function resolvePending(db: Db, deps: LifecycleDeps, eventId: string, ext: IngestDeps = {}) {
  // A row claimed and then abandoned (the process stopped) goes back to waiting after five minutes.
  await db.query("UPDATE scans SET state = 'lookup_pending' WHERE event_id = $1 AND state = 'resolving' AND coalesce(claimed_at, received_at) < $2::timestamptz - interval '5 minutes'", [eventId, nowOf(deps).toISOString()]);
  const rows = await db.query<{ id: string }>("SELECT id FROM scans WHERE event_id = $1 AND state IN ('lookup_pending', 'received') ORDER BY scanned_at LIMIT 100", [eventId]);
  for (const r of rows) await advance(db, deps, r.id, ext);
  return { tried: rows.length };
}

/* ------------------------------------------------------------------ photos */

const MAX_CHUNK = 512 * 1024;

async function ownScan(q: Q, scanId: string, actor: string, forUpdate = false) {
  const [s0] = await q<{ id: string; rep: string; event_id: string; method: Method }>(`SELECT id, rep, event_id, method FROM scans WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [scanId]);
  if (!s0) throw new RuleError("That scan does not exist.");
  if (s0.rep !== actor && !planner(actor)) throw new ScanForbidden("Only the rep who scanned, a planner or leadership does that.");
  return s0;
}

/** One chunk of a photo. The chunk must start where the server's copy ends; if it does not, nothing is written and the answer says how many bytes the server holds, so the phone resumes from there. */
export async function putPhotoChunk(db: Db, actor: string, scanId: string, p: { offset: number; total: number; kind: "badge" | "card" }, bytes: Uint8Array) {
  if (bytes.length === 0 || bytes.length > MAX_CHUNK) throw new ScanInvalid("A photo goes up in pieces of at most 512 KB.");
  if (!Number.isInteger(p.offset) || p.offset < 0 || !Number.isInteger(p.total) || p.total < 1 || p.total > 8 * 1024 * 1024) throw new ScanInvalid("A photo is at most 8 MB.");
  return db.tx(async (q) => {
    await ownScan(q, scanId, actor, true);
    let [ph] = await q<{ received_bytes: number; total_bytes: number }>("SELECT received_bytes, total_bytes FROM scan_photos WHERE scan_id = $1 FOR UPDATE", [scanId]);
    if (!ph) {
      if (p.offset !== 0) return { received: 0, total: p.total, complete: false };
      const mime = imageMime(bytes);
      if (!mime) throw new ScanInvalid("A photo is a JPEG, a PNG or a WebP.");
      await q("INSERT INTO scan_photos (scan_id, kind, mime, total_bytes) VALUES ($1, $2, $3, $4)", [scanId, p.kind === "card" ? "card" : "badge", mime, p.total]);
      ph = { received_bytes: 0, total_bytes: p.total };
    }
    if (p.offset !== ph.received_bytes || p.offset + bytes.length > ph.total_bytes) return { received: ph.received_bytes, total: ph.total_bytes, complete: ph.received_bytes === ph.total_bytes };
    await q("UPDATE scan_photos SET data = data || $2::bytea, received_bytes = received_bytes + $3 WHERE scan_id = $1", [scanId, Buffer.from(bytes), bytes.length]);
    const received = ph.received_bytes + bytes.length;
    return { received, total: ph.total_bytes, complete: received === ph.total_bytes };
  });
}

export async function photoStatus(db: Db, actor: string, scanId: string) {
  await ownScan(db.query, scanId, actor);
  const [ph] = await db.query<{ received_bytes: number; total_bytes: number; read_state: string }>("SELECT received_bytes, total_bytes, read_state FROM scan_photos WHERE scan_id = $1", [scanId]);
  return ph ? { received: ph.received_bytes, total: ph.total_bytes, complete: ph.received_bytes === ph.total_bytes, read_state: ph.read_state } : { received: 0, total: 0, complete: false, read_state: "none" };
}

export async function photoImage(db: Db, actor: string, scanId: string) {
  await ownScan(db.query, scanId, actor);
  const [ph] = await db.query<{ mime: string; data: Uint8Array; received_bytes: number; total_bytes: number }>("SELECT mime, data, received_bytes, total_bytes FROM scan_photos WHERE scan_id = $1", [scanId]);
  if (!ph || ph.received_bytes !== ph.total_bytes) throw new RuleError("That photo is not complete.");
  return { mime: ph.mime, bytes: ph.data };
}

/* ------------------------------------------------------------------ the read */

const SHAPES: Record<FieldName, (v: string) => boolean> = {
  name: (v) => /\p{L}/u.test(v) && v.length <= 120, email: (v) => Boolean(normEmail(v)), phone: (v) => (v.match(/\d/g) ?? []).length >= 6 && v.length <= 40,
  title: (v) => v.length <= 120, company: (v) => v.length <= 120, country: (v) => v.length <= 80, linkedin: (v) => /linkedin\.com\/(in|pub)\//i.test(v),
};
const squash = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}@.+]/gu, "");

/** What a read answered, kept to what is safe: a field that is not shaped like its kind, or whose value is not in the text the reader says it transcribed, is thrown away.
    A field marked low, or with no mark, is flagged. Pure. */
export function checkRead(text: string): { fields: Fields; uncertain: FieldName[]; dropped: string[]; transcript: string } {
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* an answer that is not JSON reads as nothing */ }
  const transcript = typeof j?.text === "string" ? j.text : "";
  const fields: Fields = {}, uncertain: FieldName[] = [], dropped: string[] = [];
  for (const k of FIELD_NAMES) {
    const v = typeof j?.fields?.[k] === "string" ? j.fields[k].trim() : "";
    if (!v) continue;
    if (!SHAPES[k](v)) { dropped.push(`${k}: not shaped like one`); continue; }
    if (transcript && !squash(transcript).includes(squash(v))) { dropped.push(`${k}: not in the transcription`); continue; }
    fields[k] = k === "email" ? normEmail(v)! : v.slice(0, 200);
    // With no transcription to check a value against, every value is unverified and is marked "check".
    if (!transcript || j?.confidence?.[k] !== "high") uncertain.push(k);
  }
  return { fields, uncertain, dropped, transcript };
}

/** Reads the photo of a scan with the model: counted before the call, under a lock on the event, and never repeated on an unknown outcome. */
export async function readPhoto(db: Db, deps: LifecycleDeps, llm: Llm, actor: string, scanId: string) {
  if (!llm.read) throw new RuleError("This desk's model cannot read a photo. Type the person.");
  const started = await db.tx(async (q) => {
    const sc = await ownScan(q, scanId, actor, true);
    await q("SELECT 1 FROM events WHERE id = $1 FOR UPDATE", [sc.event_id]);
    const [ph] = await q<{ mime: string; data: Uint8Array; received_bytes: number; total_bytes: number; read_state: string; kind: string }>("SELECT mime, data, received_bytes, total_bytes, read_state, kind FROM scan_photos WHERE scan_id = $1 FOR UPDATE", [scanId]);
    if (!ph || ph.received_bytes !== ph.total_bytes) throw new RuleError("The photo has not arrived in full yet.");
    if (ph.read_state !== "none") return { skip: ph.read_state, callId: null, mime: "image/jpeg" as const, data: new Uint8Array(), eventId: "", kind: "" };
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM llm_calls WHERE event_id = $1 AND step = 'scan_read'", [sc.event_id]);
    if (n >= READS_PER_EVENT) throw new RuleError(`This event has used its ${READS_PER_EVENT} photo reads. Type the rest.`);
    const callId = newId("llm");
    await q("INSERT INTO llm_calls (id, event_id, step, prompt_hash, model, input_tokens, output_tokens, output) VALUES ($1, $2, 'scan_read', $3, $4, 0, 0, '')", [callId, sc.event_id, promptHash("scan_read", llm.model), llm.model]);
    await q("UPDATE scan_photos SET read_state = 'pending' WHERE scan_id = $1", [scanId]);
    return { skip: null as string | null, callId, mime: ph.mime as "image/jpeg" | "image/png" | "image/webp", data: ph.data, eventId: sc.event_id, kind: ph.kind };
  });
  if (started.skip || !started.callId) return { state: started.skip ?? "none" };
  let reply;
  try { reply = await llm.read("scan_read", fill("scan_read", {}), { mime: started.mime, base64: Buffer.from(started.data).toString("base64") }, undefined); }
  catch {
    await db.query("UPDATE scan_photos SET read_state = 'failed' WHERE scan_id = $1", [scanId]);
    await setState(db, scanId, "needs_fields", "The photo could not be read. Type the person.");
    return { state: "failed" };
  }
  // The text the reader transcribed is a person's card; the call row keeps only the counts.
  await db.query("UPDATE llm_calls SET model = $2, input_tokens = $3, output_tokens = $4 WHERE id = $1", [started.callId, reply.model ?? llm.model, reply.input_tokens, reply.output_tokens]);
  const got = checkRead(reply.text);
  const scan = (await loadScan(db.query, scanId))!;
  // What the rep already typed stands; the read fills the rest.
  const fields = { ...got.fields, ...scan.fields };
  const uncertain = got.uncertain.filter((k) => !scan.fields[k]);
  await db.query("UPDATE scans SET fields = $2::jsonb, uncertain = $3::jsonb WHERE id = $1", [scanId, JSON.stringify(fields), JSON.stringify(uncertain)]);
  await db.query("UPDATE scan_photos SET read_state = 'read' WHERE scan_id = $1", [scanId]);
  if (placeable(fields)) { await db.query("UPDATE scans SET state = 'received' WHERE id = $1 AND state IN ('needs_fields', 'lookup_pending')", [scanId]); await advance(db, deps, scanId); }
  else await setState(db, scanId, "needs_fields", "Could not read enough to place this person. Type it.");
  return { state: "read", dropped: got.dropped.length };
}

/* ------------------------------------------------------------------ confirming, reviewing */

export async function confirmScan(db: Db, deps: LifecycleDeps, actor: string, scanId: string, edit: Record<string, unknown>) {
  const sc = await db.tx((q) => ownScan(q, scanId, actor, true));
  const patch = cleanFields(edit);
  for (const k of Object.keys(edit ?? {})) if ((FIELD_NAMES as readonly string[]).includes(k) && typeof (edit as Record<string, unknown>)[k] === "string" && (edit as Record<string, string>)[k].trim() && !(patch as Record<string, string>)[k]) throw new ScanInvalid(`${k} is not shaped like one.`);
  const cur = (await loadScan(db.query, scanId))!;
  const fields = { ...cur.fields, ...patch };
  await db.tx(async (q) => {
    await q("UPDATE scans SET fields = $2::jsonb, uncertain = '[]'::jsonb, confirmed_by = $3, confirmed_at = $4 WHERE id = $1", [scanId, JSON.stringify(fields), actor, nowOf(deps).toISOString()]);
    if (cur.contact_id) {
      const [mine] = await q<{ email: string | null; company_id: string | null }>("SELECT email, company_id FROM contacts WHERE id = $1", [cur.contact_id]);
      if (patch.email && patch.email !== mine?.email) {
        const [other] = await q<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND lower(email) = $2 AND id <> $3 AND coalesce(drop_reason, '') <> 'duplicate' LIMIT 1", [cur.event_id, patch.email, cur.contact_id]);
        // A corrected address that is already someone else's is a possible duplicate for a person to decide, never a silent merge.
        if (other) await q("UPDATE scans SET near_contact_id = $2, review = 'open' WHERE id = $1 AND review IS DISTINCT FROM 'same'", [scanId, other.id]);
        else await q("UPDATE contacts SET email = $2 WHERE id = $1", [cur.contact_id, patch.email]);
      }
      // A person who came from a list keeps what the list said; the scan's own correction stays on the scan.
      const [own] = await q<{ source: string }>("SELECT source FROM contacts WHERE id = $1", [cur.contact_id]);
      if (own?.source === "onsite") {
        if (patch.name) await q("UPDATE contacts SET full_name = $2 WHERE id = $1", [cur.contact_id, patch.name]);
        if (patch.title) await q("UPDATE contacts SET title = $2 WHERE id = $1", [cur.contact_id, patch.title]);
        if (patch.linkedin) await q("UPDATE contacts SET linkedin = $2 WHERE id = $1", [cur.contact_id, patch.linkedin]);
        if (patch.country) await q("UPDATE contacts SET person_location = $2 WHERE id = $1", [cur.contact_id, patch.country]);
      }
      // A company the scan made alone is renamed with the correction; one other people share is left to its own page.
      if (patch.company && mine?.company_id) {
        const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM contacts WHERE company_id = $1", [mine.company_id]);
        if (n === 1) await q("UPDATE companies SET name = $2, key = $3, name_provisional = false WHERE id = $1", [mine.company_id, patch.company, companyKey(patch.company)]);
      }
      await q("UPDATE scans SET state = 'placed', state_detail = '' WHERE id = $1 AND state IN ('to_confirm', 'needs_fields')", [scanId]);
    }
  });
  if (!cur.contact_id && placeable(fields)) { await db.query("UPDATE scans SET state = 'received' WHERE id = $1 AND state = 'needs_fields'", [scanId]); await advance(db, deps, scanId); }
  void sc;
  return (await resultOf(db, scanId, true));
}

export async function resolveReview(db: Db, actor: string, scanId: string, decision: "same" | "different") {
  if (decision !== "same" && decision !== "different") throw new ScanInvalid("Say same person or different people.");
  return db.tx(async (q) => {
    if (!planner(actor)) throw new ScanForbidden("The field marketer, a planner or leadership decides near matches.");
    const sc = await ownScan(q, scanId, actor, true);
    const [r] = await q<{ review: string | null; contact_id: string | null; near_contact_id: string | null; event_id: string }>("SELECT review, contact_id, near_contact_id, event_id FROM scans WHERE id = $1", [scanId]);
    if (r.review !== "open") throw new RuleError("That review was already answered.");
    if (decision === "different") { await q("UPDATE scans SET review = 'different', reviewed_by = $2 WHERE id = $1", [scanId, actor]); await logActivity(q, sc.event_id, actor, "scan", `${actor} said two scans are different people`); return { review: "different" }; }
    if (!r.contact_id || !r.near_contact_id || r.contact_id === r.near_contact_id) throw new RuleError("These two are not both placed yet.");
    const [mine] = await q<{ source: string; consent: boolean; note: string | null; tier: string | null }>("SELECT source, marketing_consent AS consent, consent_note AS note, followup_tier AS tier FROM contacts WHERE id = $1 FOR UPDATE", [r.contact_id]);
    if (mine.source !== "onsite") throw new RuleError("That person came from a list, so they are not merged away. Decide it on the person's page.");
    const [enr] = await q("SELECT 1 FROM enrollments WHERE contact_id = $1 AND state IN ('adding', 'enrolled') LIMIT 1", [r.contact_id]);
    const [reply] = await q("SELECT 1 FROM inbound_messages WHERE contact_id = $1 LIMIT 1", [r.contact_id]);
    if (enr || reply) throw new RuleError("That person is in a sequence or has replied, so they are not merged. Decide it on the person's page.");
    for (const t of ["onsite_captures", "touches", "meetings", "inbound_messages"]) await q(`UPDATE ${t} SET contact_id = $2 WHERE contact_id = $1`, [r.contact_id, r.near_contact_id]);
    await q("UPDATE scans SET contact_id = $2 WHERE contact_id = $1", [r.contact_id, r.near_contact_id]);
    await q("UPDATE scans SET near_contact_id = $2 WHERE near_contact_id = $1 AND id <> $3", [r.contact_id, r.near_contact_id, scanId]);
    await q("UPDATE contacts SET followup_tier = coalesce(followup_tier, $2), marketing_consent = marketing_consent OR $3, consent_note = coalesce($4, consent_note) WHERE id = $1", [r.near_contact_id, mine.tier, mine.consent, mine.consent ? mine.note : null]);
    await q("UPDATE contacts SET drop_reason = 'duplicate', dropped_at = now() WHERE id = $1", [r.contact_id]);
    await q("UPDATE scans SET review = 'same', reviewed_by = $2 WHERE id = $1", [scanId, actor]);
    await logActivity(q, sc.event_id, actor, "scan", `${actor} merged two scans into one person`);
    return { review: "same" };
  });
}

/* ------------------------------------------------------------------ reading */

export interface ScanView extends ScanRow { name: string | null; company: string | null; qualifier_labels: { label: string; answer: string }[]; has_photo: boolean }

/** A rep reads their own scans; a planner reads every one. */
export async function listScans(db: Db, actor: string, eventId: string, opts: { limit?: number } = {}) {
  const all = planner(actor);
  const st = await readSettings(db.query, eventId);
  const rows = await db.query<ScanRow & { name: string | null; company: string | null; has_photo: boolean }>(
    `SELECT ${SCAN_COLS.split(", ").map((c) => (c.includes(" AS ") ? `s.${c}` : `s.${c}`)).join(", ")}, k.full_name AS name, co.name AS company, EXISTS (SELECT 1 FROM scan_photos p WHERE p.scan_id = s.id) AS has_photo
     FROM scans s LEFT JOIN contacts k ON k.id = s.contact_id LEFT JOIN companies co ON co.id = k.company_id WHERE s.event_id = $1 ${all ? "" : "AND s.rep = $3"} ORDER BY s.scanned_at DESC LIMIT $2`,
    all ? [eventId, opts.limit ?? 500] : [eventId, opts.limit ?? 500, actor]);
  const scans: ScanView[] = rows.map((r) => ({ ...r, qualifier_labels: st.qualifiers.filter((x) => r.qualifiers[x.id]).map((x) => ({ label: x.label, answer: r.qualifiers[x.id] })) }));
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
  const reviews = all ? await db.query<{ scan_id: string; rep: string; scan_name: string | null; scan_company: string | null; near_id: string; near_name: string | null; near_company: string | null; near_rep: string | null; why: string }>(
    `SELECT s.id AS scan_id, s.rep, k.full_name AS scan_name, co.name AS scan_company, n.id AS near_id, n.full_name AS near_name, nco.name AS near_company,
            (SELECT c.rep FROM onsite_captures c WHERE c.contact_id = n.id ORDER BY c.captured_at LIMIT 1) AS near_rep, '' AS why
     FROM scans s JOIN contacts k ON k.id = s.contact_id LEFT JOIN companies co ON co.id = k.company_id JOIN contacts n ON n.id = s.near_contact_id LEFT JOIN companies nco ON nco.id = n.company_id
     WHERE s.event_id = $1 AND s.review = 'open' ORDER BY s.scanned_at`, [eventId]) : [];
  const withWhy = reviews.map((r) => ({ ...r, why: nearMatches({ id: "a", name: r.scan_name, company: r.scan_company, email: null }, [{ id: r.near_id, name: r.near_name, company: r.near_company, email: null }])[0]?.why ?? "Alike enough to ask" }));
  const secs = new Map<string, number[]>();
  for (const r of rows) if (r.seconds !== null) secs.set(r.rep, [...(secs.get(r.rep) ?? []), r.seconds]);
  const seconds = [...secs.entries()].map(([rep, v]) => { const a = [...v].sort((x, y) => x - y); return { rep, n: a.length, median: a.length % 2 ? a[(a.length - 1) / 2] : Math.round((a[a.length / 2 - 1] + a[a.length / 2]) / 2) }; });
  const [{ n: reads }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM llm_calls WHERE event_id = $1 AND step = 'scan_read'", [eventId]);
  return { scans, counts, reviews: withWhy, seconds, ...(all ? { reads: { used: reads, cap: READS_PER_EVENT } } : {}), settings: st, all };
}

/** What the phone caches to work offline, and a rep's own totals. */
export async function scannerConfig(db: Db, actor: string, eventId: string, organizerReady: (org: string | null, ref: { event_ref: string; exhibitor_ref: string }) => boolean) {
  const [ev] = await db.query<{ id: string; name: string; starts_on: string; ends_on: string | null; venue: string | null }>("SELECT id, name, starts_on::text AS starts_on, ends_on::text AS ends_on, venue FROM events WHERE id = $1", [eventId]);
  if (!ev) throw new RuleError("That event does not exist.");
  const st = await readSettings(db.query, eventId);
  const zone = await eventZone(db.query, eventId);
  const [mine] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM scans WHERE event_id = $1 AND rep = $2", [eventId, actor]);
  const ref = { event_ref: st.organizer_event_ref, exhibitor_ref: st.organizer_exhibitor_ref };
  return {
    event: { id: ev.id, name: ev.name, starts_on: ev.starts_on, ends_on: ev.ends_on ?? ev.starts_on, zone },
    qualifiers: st.qualifiers, notice: { text: st.notice_text, version: st.notice_version }, organizer: st.organizer, organizer_ready: organizerReady(st.organizer, ref), set_up: st.set_up,
    promise_owners: (await db.query<{ person: string }>("SELECT DISTINCT person FROM event_people WHERE event_id = $1 ORDER BY person", [eventId]).catch(() => [])).map((r) => r.person),
    mine: mine.n, can_setup: planner(actor), setup_refs: planner(actor) ? ref : undefined,
  };
}

/** The scans as a file. A rep gets their own. */
export async function scansCsv(db: Db, actor: string, eventId: string) {
  const { scans } = await listScans(db, actor, eventId, { limit: 5000 });
  const lines = [csvRow(CSV_HEAD)];
  for (const r of [...scans].reverse()) {
    lines.push(csvRow([r.scanned_at, r.rep, METHOD_WORDS[r.method], r.fields.name ?? r.name ?? "", r.fields.email ?? "", r.fields.company ?? r.company ?? "", r.fields.title ?? "", r.fields.phone ?? "", r.fields.country ?? "", r.temperature,
      r.qualifier_labels.map((x) => `${x.label}: ${x.answer}`).join("; "), r.note, r.promise, r.promise_owner ?? "", r.next_step, r.next_step_on ?? "", r.marketing_consent ? "Yes" : "No", STATE_WORDS[r.state], r.id]));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Photos and raw payloads are not kept for ever: 90 days after the event's last day. The scan's fields stay with the person. */
export async function purgeScanData(db: Db, deps: LifecycleDeps, days = 90) {
  const cutoff = addDays(nowOf(deps).toISOString().slice(0, 10), -days);
  await db.query("DELETE FROM scan_photos WHERE scan_id IN (SELECT s.id FROM scans s JOIN events e ON e.id = s.event_id WHERE coalesce(e.ends_on, e.starts_on) < $1::date)", [cutoff]);
  await db.query("UPDATE scans SET raw_payload = '' WHERE raw_payload <> '' AND event_id IN (SELECT id FROM events WHERE coalesce(ends_on, starts_on) < $1::date)", [cutoff]);
}
