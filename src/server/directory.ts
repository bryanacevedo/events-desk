/* The directory extension and the screen recording, server side (docs/DIRECTORY.md 4 to 9 and 13). People reach the desk as reads, staged or to check, and become the event's list only when
   someone brings them in through today's intake. Nothing here sends anything: the model only reads pictures, and the words each person keeps are built here from facts the desk holds. */

import { createHash, randomBytes } from "node:crypto";
import Papa from "papaparse";
import type { Db } from "./db.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { fill, promptHash } from "./prompts.ts";
import type { Llm } from "./providers.ts";
import { ingestUpload, listUploads } from "./uploads.ts";
import { addDays } from "../shared/motion.ts";
import { cleanLinkedin, companyKey } from "../shared/ingest.ts";
import { nameKey } from "../shared/email.ts";
import { imageMime } from "../shared/scan.ts";
import { isGtm } from "../shared/roles.ts";
import { LIST_SOURCE_WORDS, type ListSource } from "../shared/plan.ts";
import {
  checkFrame, cleanProfileUrl, cleanText, dedupeKey, extensionSource, isCapturePlatform, judgeRead, MAX_FRAME_BYTES, MAX_FRAME_CALLS_PER_EVENT, MAX_FRAMES_PER_RECORDING, MAX_KEYS_PER_OWNER,
  MAX_PEOPLE_PER_MINUTE, MAX_PEOPLE_PER_SEND, MAX_READS_PER_EVENT, nameKeyOf, outreachRule, PLATFORM_LABELS, profileKey, recordingSource, STALE_FRAME_MINUTES, termsNote, type CapturePlatform,
} from "../shared/directory.ts";

type Q = Db["query"];

/** A refusal with its status. The routes answer it as written; anything else is a plain RuleError (409). */
export class DirectoryError extends RuleError {
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429;
  constructor(message: string, status: DirectoryError["status"] = 409) { super(message); this.status = status; }
}

const today = (now: Date) => now.toISOString().slice(0, 10);
const takesList = ["requested", "approved", "mapped", "quoted"];
const DELIVERED = "This outreach list is delivered. Add new registrations instead.";

/* ------------------------------------------------------------------ capture keys */

export interface CaptureKey { id: string; owner: string; scope: string }
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Makes a key and returns it once: `edk_` and 43 URL-safe characters from 32 random bytes. Only its SHA-256 is stored. At most 5 unrevoked keys an owner. */
export async function createCaptureKey(db: Db, owner: string, labelIn: unknown) {
  const label = cleanText(labelIn, 60);
  if (!label) throw new DirectoryError("Give the key a name, so you know which browser it is in.", 400);
  return db.tx(async (q) => {
    // Serialised per owner, so two requests at once cannot make a sixth.
    await q("SELECT pg_advisory_xact_lock(hashtext($1))", [`capture_keys:${owner}`]);
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM capture_keys WHERE owner = $1 AND revoked_at IS NULL", [owner]);
    if (n >= MAX_KEYS_PER_OWNER) throw new DirectoryError(`You already have ${MAX_KEYS_PER_OWNER} capture keys in use. Revoke one first.`, 409);
    const key = `edk_${randomBytes(32).toString("base64url")}`;
    const id = newId("ck");
    const [row] = await q<{ created_at: string }>("INSERT INTO capture_keys (id, owner, label, key_hash, tail, scope) VALUES ($1, $2, $3, $4, $5, 'add_people') RETURNING created_at", [id, owner, label, sha(key), key.slice(-4)]);
    return { id, label, tail: key.slice(-4), key, created_at: row.created_at };
  });
}

export async function listCaptureKeys(db: Db, owner: string) {
  return db.query<{ id: string; label: string; tail: string; created_at: string; last_used_at: string | null; revoked_at: string | null; revoked_by: string | null; state: string }>(
    `SELECT id, label, tail, created_at, last_used_at, revoked_at, revoked_by, CASE WHEN revoked_at IS NULL THEN 'in use' ELSE 'revoked' END AS state FROM capture_keys WHERE owner = $1 ORDER BY created_at DESC, id`, [owner]);
}

/** The owner or GTM Engineering revokes. Acting as is self-declared across the desk, so this is a courtesy as strong as the actor header (docs/DIRECTORY.md 13.8). */
export async function revokeCaptureKey(db: Db, actor: string, id: string) {
  const [k] = await db.query<{ owner: string; revoked_at: string | null }>("SELECT owner, revoked_at FROM capture_keys WHERE id = $1", [id]);
  if (!k) throw new DirectoryError("That key does not exist.", 404);
  if (k.owner !== actor && !isGtm(actor)) throw new DirectoryError(`Only ${k.owner} or GTM Engineering can revoke this key.`, 403);
  await db.query("UPDATE capture_keys SET revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, $2) WHERE id = $1", [id, actor]);
  return { id, revoked: true };
}

/** The Bearer key on the two capture routes. Scope is read here on every request, so a later second scope cannot be read as this one. */
export async function authCapture(db: Db, header: string | undefined): Promise<CaptureKey> {
  if (!header) throw new DirectoryError("Send the capture key as Authorization: Bearer <key>.", 401);
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m || !/^edk_[A-Za-z0-9_-]{43}$/.test(m[1])) throw new DirectoryError("That is not a capture key. Make one in the desk's settings, under Browser extension.", 401);
  const [k] = await db.query<{ id: string; owner: string; scope: string; revoked_at: string | null }>("SELECT id, owner, scope, revoked_at FROM capture_keys WHERE key_hash = $1", [sha(m[1])]);
  if (!k) throw new DirectoryError("This desk does not know that capture key. Make a new one in its settings.", 401);
  if (k.revoked_at) throw new DirectoryError("This capture key was revoked. Make a new one in the desk's settings.", 401);
  if (k.scope !== "add_people") throw new DirectoryError("This capture key cannot add people.", 401);
  await db.query("UPDATE capture_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [k.id]);
  return { id: k.id, owner: k.owner, scope: k.scope };
}

/* ------------------------------------------------------------------ the two capture routes */

/** Events that can still take a list. No money, no people. Hosted events and top-ups are left out. */
export async function captureEvents(db: Db) {
  return db.query<{ id: string; name: string; starts_on: string; venue: string; stage: string; reads: number }>(
    `SELECT e.id, e.name, e.starts_on::text AS starts_on, e.venue, e.stage, (SELECT count(*)::int FROM directory_reads r WHERE r.event_id = e.id) AS reads
     FROM events e WHERE e.stage = ANY($1::text[]) AND e.parent_event_id IS NULL AND NOT EXISTS (SELECT 1 FROM hosted_events h WHERE h.event_id = e.id)
     ORDER BY e.starts_on, e.name, e.id LIMIT 500`, [takesList]);
}

const minute = new Map<string, { n: number; at: number }>();
/** At most 600 people a minute a key. Held in this process: a second process would count its own. */
function spendRate(keyId: string, people: number, at: number) {
  const w = minute.get(keyId), cur = w && at - w.at < 60_000 ? w : { n: 0, at };
  if (cur.n + people > MAX_PEOPLE_PER_MINUTE) throw new DirectoryError(`That is more than ${MAX_PEOPLE_PER_MINUTE} people a minute. Wait a minute and carry on.`, 429);
  cur.n += people; minute.set(keyId, cur);
  if (minute.size > 2000) for (const [k, v] of minute) if (at - v.at >= 60_000) minute.delete(k);
}

function refundRate(keyId: string, people: number) { const w = minute.get(keyId); if (w) w.n = Math.max(0, w.n - people); }

async function eventFor(q: Q, eventId: unknown): Promise<{ id: string; name: string; stage: string }> {
  const [ev] = typeof eventId === "string" ? await q<{ id: string; name: string; stage: string; parent_event_id: string | null; hosted: boolean }>(
    "SELECT id, name, stage, parent_event_id, EXISTS (SELECT 1 FROM hosted_events h WHERE h.event_id = events.id) AS hosted FROM events WHERE id = $1", [eventId]) : [];
  if (!ev) throw new DirectoryError("That event is not on this desk.", 409);
  if (!takesList.includes(ev.stage) || ev.parent_event_id || ev.hosted) throw new DirectoryError("That event cannot take a list now. It has to be requested, approved, mapped or quoted.", 409);
  return ev;
}

export async function termsOf(q: Q, eventId: string) {
  const [a] = await q<{ answer: string }>(
    "SELECT a.answer FROM event_assessments e JOIN assessment_answers a ON a.assessment_id = e.id WHERE e.event_id = $1 AND a.question = 'terms' AND a.state = 'confirmed'", [eventId]);
  return termsNote(a?.answer);
}

interface ReadIn { name: string; title: string; company: string; location: string; profile_url: string | null; via: "extension" | "recording"; platform: string; recording_id: string | null; low?: { name?: boolean; company?: boolean } }

/** One read in. A second send of the same person fills only the empty fields from the new one and changes no state, so a person's decision stands. */
async function putRead(q: Q, eventId: string, r: ReadIn, ctx: { by: string; on: string; source: string; terms: string }): Promise<{ added: boolean; to_check: boolean; skipped: boolean }> {
  // Someone who opted out or was erased is never read again: by name at a company, or by profile link (what forgetPerson writes).
  if (await isSuppressedRead(q, r)) return { added: false, to_check: false, skipped: true };
  const j = judgeRead({ name: r.name, title: r.title, company: r.company }, r.low);
  const [row] = await q<{ inserted: boolean }>(
    `INSERT INTO directory_reads (id, event_id, dedupe_key, full_name, title, company, location, profile_url, via, platform, read_by, read_on, source_text, terms_note, state, check_reason, recording_id)
     VALUES ($1, $2, $3, $4, nullif($5, ''), nullif($6, ''), nullif($7, ''), $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (event_id, dedupe_key) DO UPDATE SET title = coalesce(directory_reads.title, EXCLUDED.title), company = coalesce(directory_reads.company, EXCLUDED.company),
       location = coalesce(directory_reads.location, EXCLUDED.location), profile_url = coalesce(directory_reads.profile_url, EXCLUDED.profile_url)
     RETURNING (xmax = 0) AS inserted`,
    [newId("dr"), eventId, dedupeKey({ name: r.name, company: r.company, profile_url: r.profile_url }), r.name, r.title, r.company, r.location, r.profile_url, r.via, r.platform, ctx.by, ctx.on, ctx.source, ctx.terms, j.state, j.reason, r.recording_id]);
  return { added: row.inserted, to_check: row.inserted && j.state === "to_check", skipped: false };
}

/** The profile link as an erasure records it: the same with and without www. */
export const erasedLinkKey = (url: unknown) => { const k = profileKey(url); return k ? `u:${k.replace("://www.", "://")}` : null; };

/** Does an opt-out stand against this read: the name at the company, or an erased LinkedIn profile. */
async function isSuppressedRead(q: Q, r: { name: string; company: string; profile_url: string | null }): Promise<boolean> {
  const ck = r.company ? companyKey(r.company) : "", nk = nameKey(r.name), lk = erasedLinkKey(r.profile_url);
  const rows = await q("SELECT 1 FROM suppressions WHERE kind = 'opt_out' AND ((name_key = $1 AND company_key = $2 AND $2 <> '') OR ($3::text IS NOT NULL AND name_key = $3 AND company_key = 'linkedin')) LIMIT 1", [nk, ck, lk]);
  return rows.length > 0;
}

/** POST /api/capture/people. Everything the person's browser says is a claim: the source sentence and the terms note are built here, the strings are cleaned, a profile link on another host is dropped. */
export async function captureAdd(db: Db, key: CaptureKey, body: Record<string, unknown>, now: Date) {
  if (!isCapturePlatform(body.platform)) throw new DirectoryError("That platform is not one the desk knows. Use swapcard, brella, grip, whova, cvent or other.", 400);
  const platform: CapturePlatform = body.platform;
  if (!Array.isArray(body.people) || !body.people.length) throw new DirectoryError("Send at least one person.", 400);
  if (body.people.length > MAX_PEOPLE_PER_SEND) throw new DirectoryError(`That is more than ${MAX_PEOPLE_PER_SEND} people in one send. Send them in smaller batches.`, 429);
  const on = today(now);
  const people = (body.people as unknown[]).flatMap((p) => {
    const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
    const name = cleanText(o.name);
    return name ? [{ name, title: cleanText(o.title), company: cleanText(o.company), location: cleanText(o.location), profile_url: cleanProfileUrl(o.profile_url) }] : [];
  });
  const sent = body.people.length;
  let spent = false;
  try {
    return await db.tx(async (q) => {
    // A key revoked while this send was on its way does not add anything.
    const [k] = await q<{ revoked_at: string | null }>("SELECT revoked_at FROM capture_keys WHERE id = $1 FOR SHARE", [key.id]);
    if (!k || k.revoked_at) throw new DirectoryError("That capture key has been revoked.", 401);
    const ev = await eventFor(q, body.event_id);
    // Every capture send and every frame read takes this lock before counting, so two at once cannot both pass a cap.
    await q("SELECT 1 FROM events WHERE id = $1 FOR UPDATE", [ev.id]);
    const stillOk = await eventFor(q, ev.id);
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM directory_reads WHERE event_id = $1", [ev.id]);
    const keys = [...new Set(people.map((p) => dedupeKey({ name: p.name, company: p.company, profile_url: p.profile_url })))];
    const have = keys.length ? await q<{ dedupe_key: string }>("SELECT dedupe_key FROM directory_reads WHERE event_id = $1 AND dedupe_key = ANY($2::text[])", [ev.id, keys]) : [];
    if (n + (keys.length - have.length) > MAX_READS_PER_EVENT) throw new DirectoryError(`This event already holds ${n.toLocaleString("en-US")} reads, and ${MAX_READS_PER_EVENT.toLocaleString("en-US")} is the most it takes.`, 429);
    // Spent only once the event has taken the send; given back if the rest throws.
    spendRate(key.id, sent, now.getTime()); spent = true;
    const ctx = { by: key.owner, on, source: extensionSource({ platform, eventName: stillOk.name, by: key.owner, on }), terms: await termsOf(q, ev.id) };
    let added = 0, already = 0, check = 0, suppressed = 0;
    for (const p of people) {
      const r = await putRead(q, ev.id, { ...p, via: "extension", platform, recording_id: null }, ctx);
      if (r.skipped) suppressed++;
      else if (r.added) { added++; if (r.to_check) check++; } else already++;
    }
    return { added, already_in: already, to_check: check, skipped: sent - people.length + suppressed };
    });
  } catch (e) { if (spent) refundRate(key.id, sent); throw e; }
}

/* ------------------------------------------------------------------ the panel */

export interface ReadRow { id: string; full_name: string; title: string | null; company: string | null; location: string | null; profile_url: string | null; via: string; platform: string; read_by: string; read_on: string; source_text: string; terms_note: string; state: string; check_reason: string | null }
const READ_COLS = "id, full_name, title, company, location, profile_url, via, platform, read_by, read_on::text AS read_on, source_text, terms_note, state, check_reason";

/** Why Bring in cannot run now, or null. Read from the panel without a lock and again inside the lock when it runs. */
async function listBlock(q: Q, eventId: string): Promise<string | null> {
  const [ev] = await q<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [eventId]);
  if (!ev) return "That event does not exist.";
  if (ev.stage === "delivered") return DELIVERED;
  if (ev.stage === "requested") return "This event is not approved yet, so a list cannot be brought in.";
  if (!["approved", "mapped", "quoted"].includes(ev.stage)) return "This event is already being worked on; a list can no longer be replaced.";
  const held = await q<{ list_source: ListSource }>("SELECT DISTINCT list_source FROM uploads WHERE event_id = $1", [eventId]);
  const foreign = held.filter((h) => h.list_source !== "directory_extension" && h.list_source !== "screen_recording");
  if (foreign.length) return `This event already has a list (${foreign.map((f) => LIST_SOURCE_WORDS[f.list_source].toLowerCase()).join(", ")}). Bring in only replaces a list it made itself.`;
  return null;
}

export const frameState = (f: { state: string; age_min: number }) => (f.state === "reading" && f.age_min >= STALE_FRAME_MINUTES ? "failed" : f.state);

export async function directoryPanel(db: Db, eventId: string, blocked: readonly string[], recording: { can_read: boolean; reason: string | null }) {
  const [ev] = await db.query<{ id: string; name: string; stage: string }>("SELECT id, name, stage FROM events WHERE id = $1", [eventId]);
  if (!ev) throw new DirectoryError("That event does not exist.", 404);
  const counts = Object.fromEntries((await db.query<{ state: string; n: number }>("SELECT state, count(*)::int AS n FROM directory_reads WHERE event_id = $1 GROUP BY 1", [eventId])).map((r) => [r.state, r.n]));
  const byVia = await db.query<{ via: string; platform: string; n: number }>("SELECT via, platform, count(*)::int AS n FROM directory_reads WHERE event_id = $1 GROUP BY 1, 2 ORDER BY 3 DESC, 2", [eventId]);
  const staged = await db.query<ReadRow>(`SELECT ${READ_COLS} FROM directory_reads WHERE event_id = $1 AND state = 'staged' ORDER BY created_at, full_name, id LIMIT 1000`, [eventId]);
  const toCheck = await db.query<ReadRow>(`SELECT ${READ_COLS} FROM directory_reads WHERE event_id = $1 AND state = 'to_check' ORDER BY created_at, full_name, id LIMIT 1000`, [eventId]);
  const recs = await db.query<{ id: string; app_name: string; uploaded_by: string; frames_sent: number; frames_read: number; frames_failed: number; people: number; state: string; created_at: string }>(
    "SELECT id, app_name, uploaded_by, frames_sent, frames_read, frames_failed, people, state, created_at FROM recordings WHERE event_id = $1 ORDER BY created_at DESC, id", [eventId]);
  const frames = await db.query<{ recording_id: string; n: number; state: string; found: number; age_min: number }>(
    `SELECT f.recording_id, f.n, f.state, f.found, (extract(epoch FROM (now() - f.created_at)) / 60)::float AS age_min FROM recording_frames f JOIN recordings r ON r.id = f.recording_id WHERE r.event_id = $1 ORDER BY f.recording_id, f.n`, [eventId]);
  const recordings = recs.map((r) => {
    const fs = frames.filter((f) => f.recording_id === r.id).map((f) => ({ n: f.n, state: frameState(f), found: f.found }));
    return { ...r, frames_failed: fs.filter((f) => f.state === "failed").length, frames: fs };
  });
  const [organizer] = await db.query<{ status: string }>("SELECT status FROM organizer_requests WHERE event_id = $1 ORDER BY created_at DESC, id LIMIT 1", [eventId]);
  const uploads = (await listUploads(db, eventId)).map((u) => ({ id: u.id, list_source: u.list_source, filename: u.filename, row_count: u.row_count }));
  const refusal = await listBlock(db.query, eventId);
  const ready = counts.staged ?? 0;
  return {
    event: ev,
    rule: outreachRule(blocked),
    counts: { staged: ready, to_check: counts.to_check ?? 0, brought_in: counts.brought_in ?? 0, dismissed: counts.dismissed ?? 0 },
    sources: byVia,
    staged, to_check: toCheck, recordings,
    paths: {
      extension: { reads: byVia.filter((v) => v.via === "extension").reduce((a, v) => a + v.n, 0) },
      recording: { recordings: recordings.length, can_read: recording.can_read, note: recording.reason },
      organizer: { status: organizer?.status ?? null },
      upload: { lists: uploads },
    },
    bring_in: {
      count: ready,
      refusal: refusal ?? (ready ? null : counts.to_check ? `Nothing is ready to bring in. ${counts.to_check} waiting on a check.` : "Nothing is ready to bring in."),
      will: "Brings in every staged read through the same intake as an uploaded list. Duplicates, rows with no name and shared mailboxes are dropped with a reason. A list made this way is replaced by the next bring in while nothing has been paid for.",
    },
    limits: { frames_per_recording: MAX_FRAMES_PER_RECORDING, frame_calls_per_event: MAX_FRAME_CALLS_PER_EVENT, reads_per_event: MAX_READS_PER_EVENT },
  };
}

/* ------------------------------------------------------------------ to check: keep, dismiss */

export async function keepRead(db: Db, eventId: string, readId: string, edit: Record<string, unknown>) {
  // The event's row is taken first, as bring in and the frame reads do, so a keep cannot cross a bring in.
  return db.tx(async (q) => {
  await q("SELECT 1 FROM events WHERE id = $1 FOR UPDATE", [eventId]);
  const [r] = await q<ReadRow>(`SELECT ${READ_COLS} FROM directory_reads WHERE id = $1 AND event_id = $2`, [readId, eventId]);
  if (!r) throw new DirectoryError("That read is not on this event.", 404);
  if (r.state !== "to_check") throw new DirectoryError(r.state === "staged" ? "That read is already staged." : `That read is ${r.state.replace("_", " ")}.`, 409);
  const name = "name" in edit ? cleanText(edit.name) : r.full_name;
  if (!/\p{L}/u.test(name)) throw new DirectoryError("A name needs letters.", 400);
  const title = "title" in edit ? cleanText(edit.title) : r.title ?? "", company = "company" in edit ? cleanText(edit.company) : r.company ?? "";
  // A person looked at it and kept it: it becomes staged, whatever the rule thought. The key it was first seen under stays, so a later send of the same person still lands on it.
  const [out] = await q<ReadRow>(`UPDATE directory_reads SET full_name = $3, title = nullif($4, ''), company = nullif($5, ''), state = 'staged', check_reason = NULL WHERE id = $1 AND event_id = $2 AND state = 'to_check' RETURNING ${READ_COLS}`, [readId, eventId, name, title, company]);
  if (!out) throw new DirectoryError("That read changed while you were looking at it. Reload.", 409);
  return out;
  });
}

export async function dismissRead(db: Db, eventId: string, readId: string) {
  return db.tx(async (q) => {
    await q("SELECT 1 FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    const [r] = await q<{ state: string }>("SELECT state FROM directory_reads WHERE id = $1 AND event_id = $2", [readId, eventId]);
    if (!r) throw new DirectoryError("That read is not on this event.", 404);
    if (r.state === "brought_in") throw new DirectoryError("That person is already in the list. Drop them from the list instead.", 409);
    await q("UPDATE directory_reads SET state = 'dismissed' WHERE id = $1 AND event_id = $2 AND state IN ('staged', 'to_check')", [readId, eventId]);
    return { id: readId, state: "dismissed" };
  });
}

/* ------------------------------------------------------------------ bring in */

const HEAD = ["Name", "Title", "Company", "Location", "LinkedIn", "Profile", "Directory read"];

/** Turns the staged reads (and the ones already brought in, so nobody falls out of a replacement) into the event's list through `ingestUpload`. Layer 0 does what it does for any file. */
export async function bringIn(db: Db, eventId: string, actor: string, now: Date) {
  const block = await listBlock(db.query, eventId);
  if (block) throw new DirectoryError(block, 409);
  const reads = await db.query<ReadRow & { recording_id: string | null }>(`SELECT ${READ_COLS}, recording_id FROM directory_reads WHERE event_id = $1 AND state IN ('staged', 'brought_in') ORDER BY created_at, full_name, id`, [eventId]);
  const staged = reads.filter((r) => r.state === "staged");
  if (!staged.length) {
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM directory_reads WHERE event_id = $1 AND state = 'to_check'", [eventId]);
    throw new DirectoryError(n ? `Nothing is ready to bring in. ${n} ${n === 1 ? "is" : "are"} waiting on a check.` : "Nothing is ready to bring in.", 409);
  }
  const recorded = reads.filter((r) => r.via === "recording").length;
  const kind: "directory_extension" | "screen_recording" = recorded > reads.length - recorded ? "screen_recording" : "directory_extension";
  const where = [...new Set(reads.map((r) => (r.via === "extension" ? PLATFORM_LABELS[r.platform as CapturePlatform] ?? r.platform : r.platform)))];
  const days = reads.map((r) => r.read_on).sort();
  const range = days[0] === days.at(-1) ? days[0] : `${days[0]} to ${days.at(-1)}`;
  const note = `${reads.length} people read from ${where.slice(0, 3).join(", ")}${where.length > 3 ? " and more" : ""} on ${range}`.slice(0, 200);
  const lines = reads.map((r) => {
    const li = r.profile_url ? cleanLinkedin(r.profile_url) : null;
    return [r.full_name, r.title ?? "", r.company ?? "", r.location ?? "", li ?? "", r.profile_url && !li ? r.profile_url : "", r.id];
  });
  // The normal CSV writer quotes everything that needs it. A cell that starts with = or + is a person's text, not a formula: nothing here opens in a spreadsheet before Layer 0 has read it.
  const csv = Papa.unparse([HEAD, ...lines], { newline: "\r\n" }) + "\r\n";
  const ids = reads.map((r) => r.id), stagedIds = staged.map((r) => r.id);
  const out = await ingestUpload(db, eventId, actor, `directory-reads-${today(now)}.csv`, csv, { kind, note }, {
    precondition: async (q) => {
      const again = await listBlock(q, eventId);
      if (again) throw new DirectoryError(again, 409);
      const n = (await q("SELECT id FROM directory_reads WHERE id = ANY($1::text[]) AND state = 'staged' FOR UPDATE", [stagedIds])).length;
      if (n === 0) throw new DirectoryError("Nothing is ready to bring in.", 409);
      const [{ m }] = await q<{ m: number }>("SELECT count(*)::int AS m FROM directory_reads WHERE event_id = $1 AND state IN ('staged', 'brought_in') AND NOT (id = ANY($2::text[]))", [eventId, ids]);
      if (m || n !== stagedIds.length) throw new DirectoryError("The reads changed while this was bringing them in. Look at the list and try again.", 409);
    },
    afterInsert: async (q, uploadId) => {
      // Only reads still staged (or already brought in) move: one set aside meanwhile stays as it was.
      await q("UPDATE directory_reads SET state = 'brought_in', contact_id = NULL WHERE id = ANY($1::text[]) AND state IN ('staged', 'brought_in')", [ids]);
      const via = "CASE r.via WHEN 'recording' THEN 'screen_recording' ELSE 'directory_extension' END";
      await q(`UPDATE source_rows s SET list_source = ${via} FROM directory_reads r WHERE s.upload_id = $1 AND r.event_id = $2 AND s.raw->>'Directory read' = r.id`, [uploadId, eventId]);
      await q(
        `UPDATE contacts k SET list_source = ${via}, person_location = coalesce(r.location, k.person_location), read_note = r.source_text, read_terms = r.terms_note
         FROM source_rows s JOIN directory_reads r ON s.raw->>'Directory read' = r.id WHERE s.upload_id = $1 AND s.id = k.source_row_id AND r.event_id = $2`, [uploadId, eventId]);
      await q("UPDATE directory_reads r SET contact_id = k.id FROM contacts k JOIN source_rows s ON s.id = k.source_row_id WHERE s.upload_id = $1 AND r.event_id = $2 AND s.raw->>'Directory read' = r.id", [uploadId, eventId]);
      await logActivity(q, eventId, actor, "directory_bring_in", `${actor} brought in ${ids.length} people read from a directory or a recording`);
    },
  });
  return { event: out, brought_in: ids.length, kind };
}

/* ------------------------------------------------------------------ the screen recording */

/** The demo's model cannot see, so it is refused where the person would wait on a read that can never come. */
export const recordingAbility = (llm: Llm, publicDemo = false): { can_read: boolean; reason: string | null } =>
  publicDemo ? { can_read: false, reason: "This public demo does not read recordings." }
    : llm.simulated || !llm.read ? { can_read: false, reason: "The demo cannot read a recording." } : { can_read: true, reason: null };

export async function createRecording(db: Db, llm: Llm, eventId: string, actor: string, appIn: unknown) {
  const ab = recordingAbility(llm);
  if (!ab.can_read) throw new DirectoryError(ab.reason!, 409);
  const app = cleanText(appIn, 60);
  if (!app) throw new DirectoryError("Type the app's name, from 1 to 60 characters.", 400);
  return db.tx(async (q) => {
    await eventFor(q, eventId);
    const id = newId("rec");
    await q("INSERT INTO recordings (id, event_id, app_name, uploaded_by) VALUES ($1, $2, $3, $4)", [id, eventId, app, actor]);
    return { id, event_id: eventId, app_name: app, state: "reading" };
  });
}

/** What a frame answered, with the recording's running counts and the event's reads waiting on a check, so the page need not reload its panel after every frame. */
async function frameOut(q: Q, recordingId: string, n: number, state: string, found: number, repeat = false) {
  const [r] = await q<{ frames_read: number; frames_failed: number; people: number; to_check: number }>(
    "SELECT frames_read, frames_failed, people, (SELECT count(*)::int FROM directory_reads d WHERE d.event_id = recordings.event_id AND d.state = 'to_check') AS to_check FROM recordings WHERE id = $1", [recordingId]);
  return { n, state, found, repeat, to_check: r?.to_check ?? 0, frames_read: r?.frames_read ?? 0, frames_failed: r?.frames_failed ?? 0, people: r?.people ?? 0 };
}

/** Reads one frame. The row is taken and the call counted first, in one transaction under the event's lock; the model is then called with nothing held; a thrown call marks the frame failed and is never retried. */
export async function readFrame(db: Db, llm: Llm, actor: string, recordingId: string, frameNo: number, bytes: Uint8Array, now: Date) {
  if (!Number.isInteger(frameNo) || frameNo < 0 || frameNo > 100_000) throw new DirectoryError("Say which frame this is in x-frame.", 400);
  if (bytes.length > MAX_FRAME_BYTES) throw new DirectoryError("A frame can be at most 4 MB.", 413);
  const mime = imageMime(bytes);
  if (!mime) throw new DirectoryError("A frame is a JPEG, a PNG or a WebP.", 400);
  const started = await db.tx(async (q) => {
    const [rec] = await q<{ event_id: string; uploaded_by: string; state: string; app_name: string }>("SELECT event_id, uploaded_by, state, app_name FROM recordings WHERE id = $1", [recordingId]);
    if (!rec) throw new DirectoryError("That recording does not exist.", 404);
    if (rec.uploaded_by !== actor) throw new DirectoryError(`Only ${rec.uploaded_by}, who made this recording, can send its frames.`, 403);
    await q("SELECT 1 FROM events WHERE id = $1 FOR UPDATE", [rec.event_id]);
    const [have] = await q<{ state: string; found: number }>("SELECT state, found FROM recording_frames WHERE recording_id = $1 AND n = $2", [recordingId, frameNo]);
    if (have) return { repeat: await frameOut(q, recordingId, frameNo, have.state, have.found, true) };
    if (rec.state === "done") throw new DirectoryError("This recording is finished. Make another to send more frames.", 409);
    const ev = await eventFor(q, rec.event_id);
    const [{ f }] = await q<{ f: number }>("SELECT count(*)::int AS f FROM recording_frames WHERE recording_id = $1", [recordingId]);
    if (f >= MAX_FRAMES_PER_RECORDING) throw new DirectoryError(`This recording has ${MAX_FRAMES_PER_RECORDING} frames, the most one recording takes. Finish it and make another for the rest.`, 429);
    const [{ calls }] = await q<{ calls: number }>("SELECT count(*)::int AS calls FROM llm_calls WHERE event_id = $1 AND step = 'directory_read'", [rec.event_id]);
    if (calls >= MAX_FRAME_CALLS_PER_EVENT) throw new DirectoryError(`This event has used its ${MAX_FRAME_CALLS_PER_EVENT} frame reads. Type or upload the rest.`, 429);
    const callId = newId("llm");
    await q("INSERT INTO llm_calls (id, event_id, step, prompt_hash, model, input_tokens, output_tokens, output) VALUES ($1, $2, 'directory_read', $3, $4, 0, 0, '')", [callId, rec.event_id, promptHash("directory_read", llm.model), llm.model]);
    await q("INSERT INTO recording_frames (recording_id, n, state) VALUES ($1, $2, 'reading')", [recordingId, frameNo]);
    await q("UPDATE recordings SET frames_sent = frames_sent + 1 WHERE id = $1", [recordingId]);
    return { callId, eventId: rec.event_id, eventName: ev.name, app: rec.app_name };
  });
  if ("repeat" in started) return started.repeat;
  const fail = async () => {
    await db.query("UPDATE recording_frames SET state = 'failed' WHERE recording_id = $1 AND n = $2", [recordingId, frameNo]);
    await db.query("UPDATE recordings SET frames_failed = frames_failed + 1 WHERE id = $1", [recordingId]);
    return frameOut(db.query, recordingId, frameNo, "failed", 0);
  };
  if (!llm.read) return fail();
  let reply;
  try { reply = await llm.read("directory_read", fill("directory_read", {}), { mime, base64: Buffer.from(bytes).toString("base64") }, undefined); }
  catch { return fail(); }
  // The picture is dropped here. The call row keeps the model and the counts, never the transcribed text.
  await db.query("UPDATE llm_calls SET model = $2, input_tokens = $3, output_tokens = $4 WHERE id = $1", [started.callId, reply.model ?? llm.model, reply.input_tokens, reply.output_tokens]);
  const got = checkFrame(reply.text);
  if (!got.valid) return fail();
  const on = today(now);
  return db.tx(async (q) => {
    await q("SELECT 1 FROM events WHERE id = $1 FOR UPDATE", [started.eventId]);
    // The event may have moved on while the picture was being read.
    await eventFor(q, started.eventId);
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM directory_reads WHERE event_id = $1", [started.eventId]);
    const ctx = { by: actor, on, source: recordingSource({ app: started.app, eventName: started.eventName, by: actor, on }), terms: await termsOf(q, started.eventId) };
    let room = MAX_READS_PER_EVENT - n, found = 0;
    for (const p of got.people) {
      const key = dedupeKey({ name: p.name, company: p.company });
      const [there] = await q("SELECT 1 FROM directory_reads WHERE event_id = $1 AND dedupe_key = $2", [started.eventId, key]);
      if (!there && room <= 0) continue;
      const r = await putRead(q, started.eventId, { name: p.name, title: p.title, company: p.company, location: p.location, profile_url: null, via: "recording", platform: started.app, recording_id: recordingId, low: p.low }, ctx);
      if (r.skipped) continue;
      if (r.added) room--;
      found++;
    }
    await q("UPDATE recording_frames SET state = 'read', found = $3 WHERE recording_id = $1 AND n = $2", [recordingId, frameNo, found]);
    await q("UPDATE recordings SET frames_read = frames_read + 1, people = (SELECT count(*)::int FROM directory_reads WHERE recording_id = $1) WHERE id = $1", [recordingId]);
    return frameOut(q, recordingId, frameNo, "read", found);
  });
}

/** Closes a recording and says what to redo: a frame that failed, or is still reading after ten minutes, is a stretch to record again. */
export async function finishRecording(db: Db, actor: string, recordingId: string) {
  const [rec] = await db.query<{ uploaded_by: string }>("SELECT uploaded_by FROM recordings WHERE id = $1", [recordingId]);
  if (!rec) throw new DirectoryError("That recording does not exist.", 404);
  if (rec.uploaded_by !== actor) throw new DirectoryError(`Only ${rec.uploaded_by}, who made this recording, can finish it.`, 403);
  await db.query("UPDATE recordings SET state = 'done' WHERE id = $1", [recordingId]);
  const [r] = await db.query<{ frames_sent: number; frames_read: number; people: number }>("SELECT frames_sent, frames_read, people FROM recordings WHERE id = $1", [recordingId]);
  const [{ failed }] = await db.query<{ failed: number }>(
    "SELECT count(*)::int AS failed FROM recording_frames WHERE recording_id = $1 AND (state = 'failed' OR (state = 'reading' AND created_at < now() - ($2::text || ' minutes')::interval))", [recordingId, String(STALE_FRAME_MINUTES)]);
  return {
    id: recordingId, state: "done", frames_sent: r.frames_sent, frames_read: r.frames_read, frames_failed: failed, people: r.people,
    message: failed ? `${failed} of ${r.frames_sent} frames could not be read. Record that stretch again to catch the people in it.` : `All ${r.frames_sent} frames were read. Look through the list before bringing it in: it is a draft.`,
  };
}

/* ------------------------------------------------------------------ erasure and retention */

/** Reads that are the same person, by any of the ways a read can be one. Inside forgetPerson's transaction. */
export async function eraseReads(q: Q, p: { contactIds: string[]; people: { name: string; companyKey: string }[]; profileUrls: string[] }) {
  const keys = p.people.map((x) => nameKeyOf(x.name, x.companyKey));
  // A LinkedIn link is the same with and without www.
  const both = p.profileUrls.flatMap((u) => [u, u.replace("://www.linkedin.com/", "://linkedin.com/"), u.replace("://linkedin.com/", "://www.linkedin.com/")]);
  const urlKeys = [...new Set(both.map(profileKey).filter((x): x is string => Boolean(x)).map((u) => `u:${u}`))];
  await q("DELETE FROM directory_reads WHERE contact_id = ANY($1::text[]) OR dedupe_key = ANY($2::text[]) OR dedupe_key = ANY($3::text[])", [p.contactIds, keys, urlKeys]);
  // A read keyed by name that also carries the person's link (a LinkedIn link on a read the extension keyed by profile is covered above).
  for (const u of urlKeys) await q("DELETE FROM directory_reads WHERE profile_url IS NOT NULL AND lower(rtrim(profile_url, '/')) = $1", [u.slice(2)]);
}

/** Reads never brought in go 90 days after the event's last day. Recordings keep only counts: they never held a picture. */
export async function purgeDirectoryData(db: Db, now: Date, days = 90) {
  const cutoff = addDays(today(now), -days);
  await db.query("DELETE FROM directory_reads WHERE state <> 'brought_in' AND event_id IN (SELECT id FROM events WHERE coalesce(ends_on, starts_on) < $1::date)", [cutoff]);
}
