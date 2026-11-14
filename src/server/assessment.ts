/* The assessment and the organizer request (docs/EVENT-PLAN.md 4.4 and 8).
   A person gives the desk text, or a link to one public page. A model proposes answers with a quoted sentence; code keeps a proposal only when the quote is in the page
   the model was sent; a person confirms every answer. The request to the organizer is a fixed template the person copies and sends from their own mailbox: nothing here sends mail. */

import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Db } from "./db.ts";
import { defaultSettings } from "./approvals.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { parseJson } from "./paid.ts";
import { fill, promptHash } from "./prompts.ts";
import type { Llm } from "./providers.ts";
import { addDays } from "../shared/motion.ts";
import {
  answerError, conferenceKey, decodeEntities, normalizeText, pageSent, PAGE_MAX, QUESTION_IDS, QUESTIONS, questionOf, quoteIn, SOURCE_KINDS, validProposal,
  type DropReason, type SourceKind,
} from "../shared/assessment.ts";
import { renderOrganizerEmail, type OrganizerTemplate } from "../shared/organizer-email.ts";

export class AssessmentInvalid extends Error {}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const ymdOk = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const STEP = "assessment_propose" as const;
export const DEMO_PAGES_ONLY = "The demo reads only the sample pages.";

const callCap = () => defaultSettings().plan?.assessment_calls_per_event ?? 6;

/* ------------------------------------------------------------------ the assessment row */

interface Row { id: string; event_id: string; conference_key: string; catalog_id: string | null; status: "draft" | "confirmed"; confirmed_by: string | null; confirmed_at: string | null; copied_from_id: string | null; created_by: string }
const COLS = "id, event_id, conference_key, catalog_id, status, confirmed_by, confirmed_at::text AS confirmed_at, copied_from_id, created_by";

/** The event's assessment, made the first time it is needed. Locks the row so two writers on one event take turns. */
async function lockAssessment(q: Db["query"], eventId: string, actor: string): Promise<Row> {
  const [e] = await q<{ name: string; catalog_id: string | null; stage: string; parent_event_id: string | null }>("SELECT name, catalog_id, stage, parent_event_id FROM events WHERE id = $1", [eventId]);
  if (!e) throw new RuleError("That event does not exist.");
  if (e.parent_event_id) throw new RuleError("New registrations have no assessment of their own.");
  await q("INSERT INTO event_assessments (id, event_id, conference_key, catalog_id, created_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING", [newId("asm"), eventId, conferenceKey(e.name), e.catalog_id, actor]);
  const [a] = await q<Row>(`SELECT ${COLS} FROM event_assessments WHERE event_id = $1 FOR UPDATE`, [eventId]);
  return a;
}

/** Any change to a confirmed assessment puts it back to a draft: the next confirm is a person looking at the whole again. */
const reopen = (q: Db["query"], a: Row) => (a.status === "confirmed"
  ? q("UPDATE event_assessments SET status = 'draft', confirmed_by = NULL, confirmed_at = NULL WHERE id = $1", [a.id])
  : Promise.resolve([]));

/* ------------------------------------------------------------------ fetching a page */

/** A public address: not loopback, private, link-local, unique-local, carrier-grade NAT, multicast, documentation or reserved. IPv4-mapped IPv6 is read as the IPv4 inside it. */
export function isPublicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]);
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (isIP(ip) === 6) {
    const l = ip.toLowerCase();
    if (l === "::" || l === "::1") return false;
    if (/^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l) || l.startsWith("2001:db8")) return false;
    return true;
  }
  return false;
}

/** HTML to plain text: script and style removed, tags become spaces, entities decoded, whitespace collapsed, cut to 40,000 characters. */
export function stripTags(html: string): string {
  const t = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ").replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|td|th|section|article|header|footer|dt|dd)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, " ");
  return decodeEntities(t).replace(/[ \t\f\v ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim().slice(0, PAGE_MAX);
}

export const FETCH_TIMEOUT_MS = 5000, FETCH_MAX_BYTES = 1_000_000;
export const PASTE_INSTEAD = "The page could not be read. Paste its text instead.";

/** One public https page. The host is resolved first, every address must be public, and the connection is made to the address checked, so a host that answers differently the second time is not followed.
    No redirects are followed. Times out after 5 seconds and reads at most 1 MB. Returns plain text. */
export async function fetchPageText(rawUrl: string, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address)): Promise<string> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { throw new AssessmentInvalid("That is not a web address."); }
  if (u.protocol !== "https:") throw new AssessmentInvalid("Only https addresses can be read.");
  if (u.username || u.password) throw new AssessmentInvalid("Leave the name and password out of the address.");
  if (u.port && u.port !== "443") throw new AssessmentInvalid("Only the standard https port can be read.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  try { addrs = isIP(host) ? [host] : await resolve(host); } catch { throw new AssessmentInvalid(PASTE_INSTEAD); }
  if (!addrs.length || !addrs.every(isPublicAddress)) throw new AssessmentInvalid("Only public pages can be read. Paste the text instead.");
  const address = addrs[0];
  return new Promise<string>((resolveBody, reject) => {
    const fail = () => reject(new AssessmentInvalid(PASTE_INSTEAD));
    const req = httpsRequest({ host: address, servername: isIP(host) ? undefined : host, port: 443, path: `${u.pathname}${u.search}`, method: "GET", headers: { host: u.host, accept: "text/html,text/plain;q=0.9", "user-agent": "events-desk-assessment/1" }, timeout: FETCH_TIMEOUT_MS }, (res) => {
      const type = String(res.headers["content-type"] ?? "");
      if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300 || !/^(text\/html|text\/plain|application\/xhtml)/i.test(type)) { res.destroy(); fail(); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; chunks.push(c); if (size >= FETCH_MAX_BYTES) { res.destroy(); } });
      const done = () => resolveBody(stripTags(Buffer.concat(chunks).subarray(0, FETCH_MAX_BYTES).toString("utf8")));
      res.on("end", done); res.on("close", done); res.on("error", fail);
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => { req.destroy(); fail(); });
    req.on("error", fail);
    const wall = setTimeout(() => { req.destroy(); fail(); }, FETCH_TIMEOUT_MS + 1000);
    req.on("close", () => clearTimeout(wall));
    req.end();
  });
}

export type PageFetcher = (url: string) => Promise<string>;

/* ------------------------------------------------------------------ sources */

export interface SourceInput { input?: string; source_kind?: string; text?: string; url?: string }

/** Stores what the person gave the desk: pasted text, or one page fetched from the link they gave. The stored body is the text as read, up to 40,000 characters. */
export async function addSource(db: Db, actor: string, eventId: string, b: SourceInput, opts: { fetchPage?: PageFetcher | null } = {}) {
  const kind = (b.source_kind ?? "other") as SourceKind;
  if (!(SOURCE_KINDS as readonly string[]).includes(kind)) throw new AssessmentInvalid(`A source is one of: ${SOURCE_KINDS.join(", ")}.`);
  const input = b.input === "fetched" ? "fetched" : b.input === "pasted" || b.input === undefined ? "pasted" : null;
  if (!input) throw new AssessmentInvalid("A source is pasted text or a fetched page.");
  let body: string, url: string | null = null;
  if (input === "fetched") {
    url = text(b.url);
    if (!url) throw new AssessmentInvalid("Give the address of the page.");
    if (opts.fetchPage === null) throw new AssessmentInvalid("The demo cannot read web pages. Paste the text instead.");
    body = (await (opts.fetchPage ?? fetchPageText)(url)).slice(0, PAGE_MAX);
  } else {
    body = text(b.text).slice(0, PAGE_MAX);
    if (b.text !== undefined && text(b.text).length > PAGE_MAX) throw new AssessmentInvalid(`Paste at most ${PAGE_MAX.toLocaleString("en-US")} characters.`);
  }
  if (body.trim().length < 20) throw new AssessmentInvalid(input === "fetched" ? PASTE_INSTEAD : "Paste the text to read. It is too short.");
  return db.tx(async (q) => {
    const a = await lockAssessment(q, eventId, actor);
    const id = newId("src");
    await q("INSERT INTO assessment_sources (id, assessment_id, input, source_kind, url, body, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7)", [id, a.id, input, kind, url, body, actor]);
    await logActivity(q, eventId, actor, "assessment", `Added a source for the assessment: ${kind.replace(/_/g, " ")}`);
    return { id };
  });
}

/* ------------------------------------------------------------------ the model step */

export const PROPOSE_NOTE_DROPPED = (n: number) => (n === 1 ? "1 proposal was left out" : `${n} proposals were left out`);

/** What the model sends back, as the code reads it: an array of loosely shaped answers, or nothing. */
const proposalsOf = (reply: string): unknown[] => {
  const parsed = parseJson(reply) as { answers?: unknown } | null;
  return parsed && Array.isArray(parsed.answers) ? parsed.answers : [];
};

const questionsText = () => QUESTIONS.map((q) => `- ${q.id}: ${q.ask ?? q.label} ${q.type === "choice" ? `One of: ${q.values.join(", ")}.` : q.type === "list" ? `A comma list from: ${q.values.join(", ")}.` : `Short free text, at most ${q.max} characters.`}`).join("\n");

/** The filled prompt for a page that is already in the form it is sent (markers neutralised, cut to length). The recording script and the step itself both use it. */
export const assessmentPrompt = (sent: string) => fill(STEP, { questions: questionsText(), page: sent });

/** Runs the model on one stored source and keeps each proposal whose quoted sentence is in the page it was sent. The call is counted before it is made, under a lock on the assessment, so a call that
    throws or never answers is still a call spent. Planning has no cost card and the ledger is not touched. */
export async function proposeAnswers(db: Db, llm: Llm, eventId: string, actor: string, sourceId: string) {
  const cap = callCap();
  const started = await db.tx(async (q) => {
    const a = await lockAssessment(q, eventId, actor);
    const [src] = await q<{ id: string; body: string; source_kind: SourceKind }>("SELECT id, body, source_kind FROM assessment_sources WHERE id = $1 AND assessment_id = $2", [sourceId, a.id]);
    if (!src) throw new RuleError("That source is not on this event's assessment.");
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM llm_calls WHERE event_id = $1 AND step = $2", [eventId, STEP]);
    if (n >= cap) throw new RuleError(`This event has used its ${cap} reads. Answer the rest by hand.`);
    const sent = pageSent(src.body);
    const prompt = assessmentPrompt(sent);
    const callId = newId("llm");
    await q("INSERT INTO llm_calls (id, event_id, step, prompt_hash, model, input_tokens, output_tokens, output) VALUES ($1, $2, $3, $4, $5, 0, 0, '')", [callId, eventId, STEP, promptHash(STEP, llm.model), llm.model]);
    return { assessment: a, source: src, sent, prompt, callId };
  });
  let reply;
  try { reply = await llm.complete(STEP, started.prompt); }
  catch { throw new RuleError("The read did not come back. It still counts as one of the reads for this event. You can answer by hand."); }
  await db.query("UPDATE llm_calls SET model = $2, input_tokens = $3, output_tokens = $4, output = $5 WHERE id = $1", [started.callId, reply.model ?? llm.model, reply.input_tokens, reply.output_tokens, reply.text]);

  const proposals = proposalsOf(reply.text);
  const dropped: Record<DropReason | "confirmed" | "repeat", number> = { shape: 0, question: 0, answer: 0, quote_short: 0, quote_long: 0, quote_missing: 0, confirmed: 0, repeat: 0 };
  const kept = await db.tx(async (q) => {
    const a = await lockAssessment(q, eventId, actor);
    const have = new Map((await q<{ question: string; state: string }>("SELECT question, state FROM assessment_answers WHERE assessment_id = $1", [a.id])).map((r) => [r.question, r.state]));
    const seen = new Set<string>();
    let n = 0;
    for (const p of proposals) {
      const v = validProposal(p, started.sent);
      if (!v.ok) { dropped[v.why]++; continue; }
      if (have.get(v.value.question) === "confirmed") { dropped.confirmed++; continue; }
      if (seen.has(v.value.question)) { dropped.repeat++; continue; }
      seen.add(v.value.question);
      await q("DELETE FROM assessment_answers WHERE assessment_id = $1 AND question = $2 AND state = 'proposed'", [a.id, v.value.question]);
      await q("INSERT INTO assessment_answers (id, assessment_id, question, answer, detail, source_kind, source_id, quote, proposed_by, state) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'model', 'proposed')",
        [newId("ans"), a.id, v.value.question, v.value.answer, v.value.detail, started.source.source_kind, started.source.id, v.value.quote]);
      n++;
    }
    if (n) { await reopen(q, a); await logActivity(q, eventId, actor, "assessment", `The model proposed ${n} ${n === 1 ? "answer" : "answers"} from a ${started.source.source_kind.replace(/_/g, " ")}`); }
    return n;
  });
  const total = Object.values(dropped).reduce((x, y) => x + y, 0);
  const note = llm.simulated && !kept && !proposals.length ? DEMO_PAGES_ONLY : null;
  return { kept, dropped: total, dropped_by: dropped, note, calls_left: Math.max(0, cap - (await callsUsed(db, eventId))) };
}

const callsUsed = async (db: Db, eventId: string) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM llm_calls WHERE event_id = $1 AND step = $2", [eventId, STEP]))[0].n;

/* ------------------------------------------------------------------ answers */

export interface AnswerInput { answer?: string; detail?: string; quote?: string; source_id?: string | null; source_kind?: string; confirm?: boolean }

interface AnswerRow { id: string; question: string; answer: string; detail: string; source_kind: string; source_id: string | null; quote: string; proposed_by: string; state: "proposed" | "confirmed" }
const ANS = "id, question, answer, detail, source_kind, source_id, quote, proposed_by, state";

/** Confirms, edits or answers by hand. A model's answer keeps its quote; a new quote is checked against the same source the way the model's was. Answering by hand confirms the answer as that person's own, unless `confirm` is false. */
export async function setAnswer(db: Db, actor: string, eventId: string, question: string, b: AnswerInput) {
  if (!questionOf(question)) throw new AssessmentInvalid("That is not one of the assessment's questions.");
  return db.tx(async (q) => {
    const a = await lockAssessment(q, eventId, actor);
    const [old] = await q<AnswerRow>(`SELECT ${ANS} FROM assessment_answers WHERE assessment_id = $1 AND question = $2 FOR UPDATE`, [a.id, question]);
    const answer = b.answer === undefined ? old?.answer : text(b.answer);
    if (answer === undefined) throw new AssessmentInvalid("Give an answer.");
    const bad = answerError(question, answer, old?.proposed_by === "model" && b.answer === undefined ? "model" : "person");
    if (bad) throw new AssessmentInvalid(bad);
    const detail = b.detail === undefined ? old?.detail ?? "" : text(b.detail).slice(0, 300);
    let sourceId = b.source_id === undefined ? old?.source_id ?? null : b.source_id;
    let sourceKind = old?.source_kind ?? "first_hand";
    let quote = old?.quote ?? "";
    if (b.source_id !== undefined && sourceId) {
      const [s] = await q<{ source_kind: string }>("SELECT source_kind FROM assessment_sources WHERE id = $1 AND assessment_id = $2", [sourceId, a.id]);
      if (!s) throw new AssessmentInvalid("That source is not on this assessment.");
      sourceKind = s.source_kind;
    }
    if (b.source_kind !== undefined) {
      if (![...SOURCE_KINDS, "first_hand"].includes(b.source_kind as never)) throw new AssessmentInvalid("Say where the answer came from.");
      sourceKind = b.source_kind;
    }
    if (b.quote !== undefined) {
      const wanted = text(b.quote);
      if (!wanted) { if (old?.proposed_by === "model") throw new AssessmentInvalid("A proposed answer keeps its quote."); quote = ""; }
      else {
        if (!sourceId) throw new AssessmentInvalid("Say which source the sentence is from.");
        const [s] = await q<{ body: string }>("SELECT body FROM assessment_sources WHERE id = $1 AND assessment_id = $2", [sourceId, a.id]);
        const found = s ? quoteIn(pageSent(s.body), wanted) : null;
        if (!found) throw new AssessmentInvalid("That sentence is not in the source. Copy it word for word.");
        quote = found;
      }
    }
    if (old?.proposed_by === "model" && !quote.trim()) throw new AssessmentInvalid("A proposed answer keeps its quote.");
    const proposedBy = old?.proposed_by ?? actor;
    // A hand answer is the person's own and stands confirmed. A proposal waits for someone to confirm it, in this call or a later one.
    const confirm = b.confirm ?? (!old || old.proposed_by === actor);
    if (old) {
      await q(`UPDATE assessment_answers SET answer = $2, detail = $3, source_kind = $4, source_id = $5, quote = $6, state = $7, confirmed_by = $8, confirmed_at = CASE WHEN $7 = 'confirmed' THEN now() ELSE NULL END WHERE id = $1`,
        [old.id, answer, detail, sourceKind, sourceId, quote, confirm ? "confirmed" : "proposed", confirm ? actor : null]);
    } else {
      await q(`INSERT INTO assessment_answers (id, assessment_id, question, answer, detail, source_kind, source_id, quote, proposed_by, state, confirmed_by, confirmed_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $10 = 'confirmed' THEN now() ELSE NULL END)`,
        [newId("ans"), a.id, question, answer, detail, sourceKind, sourceId, quote, proposedBy, confirm ? "confirmed" : "proposed", confirm ? actor : null]);
    }
    await reopen(q, a);
    await logActivity(q, eventId, actor, "assessment", `${confirm ? "Confirmed" : "Changed"} the answer to "${questionOf(question)!.label}"`);
    return { question, state: confirm ? "confirmed" : "proposed" };
  });
}

/** A proposal is rejected by deleting it. A confirmed answer is edited, never rejected. */
export async function rejectAnswer(db: Db, actor: string, eventId: string, question: string) {
  if (!questionOf(question)) throw new AssessmentInvalid("That is not one of the assessment's questions.");
  return db.tx(async (q) => {
    const a = await lockAssessment(q, eventId, actor);
    const [old] = await q<{ id: string; state: string }>("SELECT id, state FROM assessment_answers WHERE assessment_id = $1 AND question = $2 FOR UPDATE", [a.id, question]);
    if (!old) throw new RuleError("There is no answer to reject.");
    if (old.state === "confirmed") throw new RuleError("That answer is confirmed. Edit it instead.");
    await q("DELETE FROM assessment_answers WHERE id = $1", [old.id]);
    await logActivity(q, eventId, actor, "assessment", `Rejected a proposed answer to "${questionOf(question)!.label}"`);
    return { question, rejected: true };
  });
}

/** All seven answered and confirmed, then the assessment is confirmed. */
export async function confirmAssessment(db: Db, actor: string, eventId: string) {
  return db.tx(async (q) => {
    const a = await lockAssessment(q, eventId, actor);
    const rows = await q<{ question: string; state: string }>("SELECT question, state FROM assessment_answers WHERE assessment_id = $1", [a.id]);
    const open = QUESTION_IDS.filter((id) => rows.find((r) => r.question === id)?.state !== "confirmed");
    if (open.length) {
      const proposed = rows.filter((r) => r.state === "proposed").length;
      throw new RuleError(proposed ? `${proposed} ${proposed === 1 ? "answer is" : "answers are"} still proposed. Confirm or reject ${proposed === 1 ? "it" : "each"} first.` : `${open.length} of ${QUESTION_IDS.length} questions still need an answer.`);
    }
    if (a.status === "confirmed") return { already: true };
    await q("UPDATE event_assessments SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1", [a.id, actor]);
    await logActivity(q, eventId, actor, "assessment", "Confirmed the assessment");
    return { already: false };
  });
}

/** Last year's answers, copied as proposals: the newest confirmed assessment with the same conference on another event (or the same catalog entry). Every one is confirmed again, because terms change. */
export async function reuseLastYear(db: Db, actor: string, eventId: string) {
  return db.tx(async (q) => {
    const a = await lockAssessment(q, eventId, actor);
    const [prev] = await q<{ id: string; event_name: string }>(
      `SELECT x.id, e.name AS event_name FROM event_assessments x JOIN events e ON e.id = x.event_id
       WHERE x.status = 'confirmed' AND x.event_id <> $1 AND (x.conference_key = $2 OR ($3::text IS NOT NULL AND x.catalog_id = $3)) ORDER BY x.confirmed_at DESC, x.id LIMIT 1`, [eventId, a.conference_key, a.catalog_id]);
    if (!prev) throw new RuleError("There is no confirmed assessment from an earlier year to copy.");
    const have = new Set((await q<{ question: string }>("SELECT question FROM assessment_answers WHERE assessment_id = $1", [a.id])).map((r) => r.question));
    const old = await q<{ question: string; answer: string; detail: string; quote: string }>("SELECT question, answer, detail, quote FROM assessment_answers WHERE assessment_id = $1 ORDER BY question", [prev.id]);
    let n = 0;
    for (const r of old) {
      if (have.has(r.question)) continue;
      await q("INSERT INTO assessment_answers (id, assessment_id, question, answer, detail, source_kind, source_id, quote, proposed_by, state) VALUES ($1, $2, $3, $4, $5, 'last_year', NULL, $6, 'reuse', 'proposed')", [newId("ans"), a.id, r.question, r.answer, r.detail, r.quote]);
      n++;
    }
    if (n) { await q("UPDATE event_assessments SET copied_from_id = $2 WHERE id = $1", [a.id, prev.id]); await reopen(q, a); }
    await logActivity(q, eventId, actor, "assessment", `Copied ${n} ${n === 1 ? "answer" : "answers"} from ${prev.event_name} as proposals`);
    return { copied: n, from: prev.event_name };
  });
}

/* ------------------------------------------------------------------ the read */

export interface OrganizerRequestRow { id: string; template: OrganizerTemplate; subject: string; body: string; organizer_name: string; status: string; copied_by: string | null; copied_at: string | null; sent_on: string | null; expected_on: string | null; follow_up_on: string | null; created_by: string }
const REQ = "id, template, subject, body, organizer_name, status, copied_by, copied_at::text AS copied_at, sent_on::text AS sent_on, expected_on::text AS expected_on, follow_up_on::text AS follow_up_on, created_by";

/** The newest request on the event, open or closed: the screen shows the one the person is working on, else the last one. */
export async function currentRequest(db: Pick<Db, "query">, eventId: string): Promise<OrganizerRequestRow | null> {
  const [r] = await db.query<OrganizerRequestRow>(`SELECT ${REQ} FROM organizer_requests WHERE event_id = $1 ORDER BY (status IN ('drafted', 'copied', 'sent', 'will_share')) DESC, created_at DESC, id DESC LIMIT 1`, [eventId]);
  return r ?? null;
}

const REQUEST_OPEN = ["drafted", "copied", "sent", "will_share"];

/** Everything the assessment panel and the organizer request show. No money is in it, so a rep reads all of it. */
export async function assessmentView(db: Db, eventId: string) {
  const [a] = await db.query<Row>(`SELECT ${COLS} FROM event_assessments WHERE event_id = $1`, [eventId]);
  const [ev] = await db.query<{ name: string; catalog_id: string | null }>("SELECT name, catalog_id FROM events WHERE id = $1", [eventId]);
  if (!ev) throw new RuleError("That event does not exist.");
  const answers = a ? await db.query<AnswerRow & { confirmed_by: string | null; confirmed_at: string | null }>(`SELECT ${ANS}, confirmed_by, confirmed_at::text AS confirmed_at FROM assessment_answers WHERE assessment_id = $1`, [a.id]) : [];
  const sources = a ? await db.query<{ id: string; input: string; source_kind: string; url: string | null; chars: number; added_by: string; created_at: string }>(
    "SELECT id, input, source_kind, url, length(body) AS chars, added_by, created_at::text AS created_at FROM assessment_sources WHERE assessment_id = $1 ORDER BY created_at, id", [a.id]) : [];
  const key = conferenceKey(ev.name);
  const [prev] = await db.query<{ event_name: string }>(
    `SELECT e.name AS event_name FROM event_assessments x JOIN events e ON e.id = x.event_id WHERE x.status = 'confirmed' AND x.event_id <> $1 AND (x.conference_key = $2 OR ($3::text IS NOT NULL AND x.catalog_id = $3)) ORDER BY x.confirmed_at DESC LIMIT 1`, [eventId, key, ev.catalog_id]);
  const request = await currentRequest(db, eventId);
  const finds_networking = answers.some((r) => r.question === "directory_present" && r.answer === "yes" && r.state === "confirmed");
  const byQuestion = new Map(answers.map((r) => [r.question, r]));
  const used = await callsUsed(db, eventId);
  const confirmed = answers.filter((r) => r.state === "confirmed").length;
  return {
    assessment: a ? { id: a.id, status: a.status, confirmed_by: a.confirmed_by, confirmed_at: a.confirmed_at, conference_key: a.conference_key, copied_from_id: a.copied_from_id } : null,
    questions: QUESTIONS.map((q) => ({ id: q.id, label: q.label, type: q.type, values: q.values, words: q.words, max: q.max, answer: byQuestion.get(q.id) ?? null })),
    sources,
    progress: { confirmed, total: QUESTION_IDS.length, proposed: answers.filter((r) => r.state === "proposed").length },
    reads_left: Math.max(0, callCap() - used), reads_cap: callCap(),
    finds_networking,
    last_year: prev ? { event_name: prev.event_name } : null,
    organizer_request: request,
    request_offered: finds_networking || Boolean(request),
    request_open: Boolean(request && REQUEST_OPEN.includes(request.status)),
  };
}

/* ------------------------------------------------------------------ the organizer request */

const REQUEST_STATUSES = ["drafted", "copied", "sent", "will_share", "will_not_share", "received"] as const;
type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** What the team holds, in words, for the email: the passes on the plan, else the approved seats. */
async function ticketWords(q: Db["query"], eventId: string): Promise<string> {
  const [p] = await q<{ n: number | null }>("SELECT sum(pass_count)::int AS n FROM involvements WHERE event_id = $1 AND kind = 'passes' AND status <> 'dropped'", [eventId]);
  const [s] = await q<{ n: number }>("SELECT count(*)::int AS n FROM seat_requests WHERE event_id = $1 AND status = 'approved'", [eventId]);
  const n = p?.n ?? (s.n || null);
  return n ? `${n} conference ${n === 1 ? "pass" : "passes"}` : "conference passes";
}
async function companyName(q: Db["query"]): Promise<string> {
  const [r] = await q<{ seller: string | null }>("SELECT icp->>'seller' AS seller FROM icp_versions ORDER BY version DESC LIMIT 1");
  return r?.seller?.trim() || "our team";
}

/** Drafts the email from the fixed template and stores it as it was rendered. Offered once the assessment finds networking (directory_present = yes, confirmed), and a planner can draft one by hand before that.
    A follow-up replaces the open request's text in place, quoting the date the first email went, and waits to be copied and sent again. */
export async function draftOrganizerRequest(db: Db, actor: string, eventId: string, b: { template?: string; organizer_name?: string }, opts: { planner: boolean; id?: string }) {
  const template = (b.template ?? "ask_for_list") as OrganizerTemplate;
  if (template !== "ask_for_list" && template !== "follow_up") throw new AssessmentInvalid("The request is the ask or the follow-up.");
  return db.tx(async (q) => {
    const a = await lockAssessment(q, eventId, actor);
    const [ev] = await q<{ name: string; stage: string }>("SELECT name, stage FROM events WHERE id = $1", [eventId]);
    if (ev.stage === "declined") throw new RuleError("This event was declined.");
    const [net] = await q("SELECT 1 FROM assessment_answers WHERE assessment_id = $1 AND question = 'directory_present' AND answer = 'yes' AND state = 'confirmed'", [a.id]);
    const [open] = await q<OrganizerRequestRow>(`SELECT ${REQ} FROM organizer_requests WHERE event_id = $1 AND status IN ('drafted', 'copied', 'sent', 'will_share') FOR UPDATE`, [eventId]);
    const organizer = b.organizer_name !== undefined ? text(b.organizer_name).slice(0, 120) : open?.organizer_name ?? "";
    const input = { event: ev.name, organizer, sender: actor, company: await companyName(q), ticket: await ticketWords(q, eventId) };
    if (template === "follow_up") {
      if (!open || !open.sent_on) throw new RuleError("A follow-up needs a request that has been sent.");
      const mail = renderOrganizerEmail("follow_up", { ...input, first_sent_on: open.sent_on });
      await q("UPDATE organizer_requests SET template = 'follow_up', subject = $2, body = $3, organizer_name = $4, status = 'drafted', copied_by = NULL, copied_at = NULL, follow_up_on = NULL WHERE id = $1", [open.id, mail.subject, mail.body, organizer]);
      await logActivity(q, eventId, actor, "organizer", "Drafted the follow-up to the organizer");
      return { id: open.id };
    }
    if (open) throw new RuleError("There is already a request open for this event.");
    if (!net && !opts.planner) throw new RuleError("Finish the assessment first. The request is offered once it finds an attendee directory.");
    const mail = renderOrganizerEmail("ask_for_list", input);
    const id = opts.id ?? newId("org");
    await q("INSERT INTO organizer_requests (id, event_id, template, subject, body, organizer_name, created_by) VALUES ($1, $2, 'ask_for_list', $3, $4, $5, $6)", [id, eventId, mail.subject, mail.body, organizer, actor]);
    await logActivity(q, eventId, actor, "organizer", "Drafted the request to the organizer for the attendee list");
    return { id };
  });
}

/** Records who pressed Copy. The email is copied on the person's side; the desk keeps who and when. */
export async function markRequestCopied(db: Db, actor: string, eventId: string, rid: string) {
  return db.tx(async (q) => {
    const [r] = await q<{ status: string }>("SELECT status FROM organizer_requests WHERE id = $1 AND event_id = $2 FOR UPDATE", [rid, eventId]);
    if (!r) throw new RuleError("That request is not on this event.");
    await q("UPDATE organizer_requests SET copied_by = $2, copied_at = now(), status = CASE WHEN status = 'drafted' THEN 'copied' ELSE status END WHERE id = $1", [rid, actor]);
    await logActivity(q, eventId, actor, "organizer", "Copied the request to the organizer");
    return { id: rid };
  });
}

/** The follow-up date is made here, never typed: the day after the expected date when there is one, otherwise a week after it was sent. */
export const followUpOn = (sent_on: string | null, expected_on: string | null) => (expected_on ? addDays(expected_on, 1) : sent_on ? addDays(sent_on, 7) : null);

export interface RequestPatch { sent_on?: string | null; expected_on?: string | null; status?: string; organizer_name?: string }

/** The person says when they sent it, what the organizer answered and when the list comes. Dates are checked; the follow-up date is computed. */
export async function patchOrganizerRequest(db: Db, actor: string, eventId: string, rid: string, b: RequestPatch) {
  return db.tx(async (q) => {
    const [r] = await q<{ status: RequestStatus; sent_on: string | null; expected_on: string | null }>("SELECT status, sent_on::text AS sent_on, expected_on::text AS expected_on FROM organizer_requests WHERE id = $1 AND event_id = $2 FOR UPDATE", [rid, eventId]);
    if (!r) throw new RuleError("That request is not on this event.");
    if (r.status === "received") throw new RuleError("The list has arrived, so this request is closed.");
    const day = (v: unknown, what: string) => { if (v === null || v === "") return null; if (!ymdOk(v)) throw new AssessmentInvalid(`Give ${what} as a date.`); return v; };
    const sent_on = b.sent_on === undefined ? r.sent_on : day(b.sent_on, "the day it was sent");
    const expected_on = b.expected_on === undefined ? r.expected_on : day(b.expected_on, "the day the list is expected");
    let status: RequestStatus = r.status;
    if (b.status !== undefined) {
      if (!(REQUEST_STATUSES as readonly string[]).includes(b.status) || b.status === "drafted") throw new AssessmentInvalid("The status is one of: copied, sent, will_share, will_not_share, received.");
      status = b.status as RequestStatus;
    }
    if (["sent", "will_share", "will_not_share"].includes(status) && !sent_on) throw new AssessmentInvalid("Say the day you sent it.");
    if (status === "will_share" && !expected_on) throw new AssessmentInvalid("Say the day the organizer expects to share it.");
    // Saying when it was sent moves a drafted or copied request to sent.
    if (b.sent_on && b.status === undefined && (status === "drafted" || status === "copied")) status = "sent";
    const closed = status === "will_not_share" || status === "received";
    const follow = closed ? null : followUpOn(sent_on, expected_on);
    await q("UPDATE organizer_requests SET status = $2, sent_on = $3, expected_on = $4, follow_up_on = $5, organizer_name = coalesce($6, organizer_name) WHERE id = $1", [rid, status, sent_on, expected_on, follow, b.organizer_name === undefined ? null : text(b.organizer_name).slice(0, 120)]);
    await logActivity(q, eventId, actor, "organizer", `Organizer request: ${status.replace(/_/g, " ")}${expected_on ? `, list expected ${expected_on}` : ""}`);
    return { id: rid, status, sent_on, expected_on, follow_up_on: follow };
  });
}

/** A list arrived emailed by the organizer: the open request is received. Called from the upload's own transaction, so the two cannot disagree. */
export async function closeOrganizerRequest(q: Db["query"], eventId: string, actor: string) {
  const done = await q<{ id: string }>("UPDATE organizer_requests SET status = 'received', follow_up_on = NULL WHERE event_id = $1 AND status IN ('drafted', 'copied', 'sent', 'will_share') RETURNING id", [eventId]);
  if (done.length) await logActivity(q, eventId, actor, "organizer", "The attendee list arrived from the organizer, so the request is received");
  return done.length;
}

export { normalizeText };
