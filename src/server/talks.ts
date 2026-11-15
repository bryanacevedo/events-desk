/* Speaking (docs/SPEAKING.md): calls for papers, the talk and its two-person approvals. The database refuses the author approving their own words
   (talks_abstract_two_people, talks_slides_two_people); the code gives the sentence first. */

import type { Db } from "./db.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { canPlan } from "./money.ts";
import { Forbidden } from "./seats.ts";
import { dueWords } from "../shared/plan.ts";
import { fill, promptHash } from "./prompts.ts";
import { fetchPageText, type PageFetcher } from "./assessment.ts";
import type { Llm } from "./providers.ts";
import { offerKit } from "./kit-offers.ts";
import { postingCounts } from "./social-kit.ts";

export class SpeakingInvalid extends Error {}
export const CFP_READS_PER_EVENT = 5;
export const OWN_WORDS = "Nobody can approve their own words. Ask someone else.";
export const TALK_STATUS_WORDS: Record<string, string> = { drafting: "Drafting", approved_to_submit: "Approved to submit", submitted: "Submitted", accepted: "Accepted", declined: "Declined" };

const text = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim() : "");
const ymd = (v: unknown, what: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new SpeakingInvalid(`Give ${what} as a date.`);
  return v;
};
const web = (v: unknown, what: string) => {
  const s = text(v);
  if (!/^https?:\/\/\S+$/i.test(s) || s.length > 600) throw new SpeakingInvalid(`Give ${what} as a web address.`);
  return s;
};

/* ------------------------------------------------------------------ calls */

export interface CallRow { id: string; event_id: string; title: string; url: string; closes_on: string; notes: string; route: string; status: string; passed_reason: string | null; talk_id: string | null; source: string; source_url: string | null; added_by: string }
const CALL_COLS = "id, event_id, title, url, closes_on::text AS closes_on, notes, route, status, passed_reason, talk_id, source, source_url, added_by";

async function planEvent(q: Db["query"], eventId: string) {
  const [e] = await q<{ stage: string; parent_event_id: string | null }>("SELECT stage, parent_event_id FROM events WHERE id = $1 FOR UPDATE", [eventId]);
  if (!e) throw new RuleError("That event does not exist.");
  if (e.parent_event_id) throw new RuleError("New registrations have no plan of their own.");
  if (e.stage === "declined") throw new RuleError("This event was declined, so its plan is closed.");
}
const planners = (actor: string) => { if (!canPlan(actor)) throw new Forbidden("Calls and talks are kept by the field marketer, leadership and GTM Engineering."); };

export interface CallInput { title?: unknown; url?: unknown; closes_on?: unknown; notes?: unknown; route?: unknown; source?: "person" | "model"; source_url?: string | null }

export async function addCall(db: Db, actor: string, eventId: string, b: CallInput) {
  planners(actor);
  const title = text(b.title).slice(0, 160) || "Call for content";
  const url = web(b.url, "the call's link");
  const closes = ymd(b.closes_on, "the closing day");
  if (!closes) throw new SpeakingInvalid("Give the closing day.");
  const route = b.route === "paid" ? "paid" : "editorial";
  return db.tx(async (q) => {
    await planEvent(q, eventId);
    const id = newId("cfp");
    await q("INSERT INTO calls_for_papers (id, event_id, title, url, closes_on, notes, route, source, source_url, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [id, eventId, title, url, closes, text(b.notes).slice(0, 600), route, b.source === "model" ? "model" : "person", b.source === "model" && b.source_url ? web(b.source_url, "the page address") : null, actor]);
    await logActivity(q, eventId, actor, "speaking", `Added a call for papers closing ${closes}`);
    return { id };
  });
}

export async function passCall(db: Db, actor: string, callId: string, reason: string) {
  planners(actor);
  if (!text(reason)) throw new RuleError("Say why before passing on it.");
  return db.tx(async (q) => {
    const [c] = await q<{ event_id: string; status: string }>("SELECT event_id, status FROM calls_for_papers WHERE id = $1 FOR UPDATE", [callId]);
    if (!c) throw new RuleError("That call does not exist.");
    if (c.status !== "open") throw new RuleError("Only an open call can be passed on.");
    await q("UPDATE calls_for_papers SET status = 'passed', passed_reason = $2 WHERE id = $1", [callId, text(reason)]);
    await logActivity(q, c.event_id, actor, "speaking", `Passed on a call for papers: ${text(reason)}`);
    return { id: callId };
  });
}

/* ------------------------------------------------------------------ the model proposes, the person adds */

export interface Proposal { title: string; closes_on: string; link: string; quote: string }
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** What the model said, kept only where the page backs it: a real day, a quote found in the page, and a link that is the page's own address or appears in the page. */
export function checkProposals(raw: string, page: string, pageUrl: string | null): { kept: Proposal[]; dropped: number } {
  let list: unknown[] = [];
  try { const j = JSON.parse(raw); list = Array.isArray(j?.calls) ? j.calls : []; } catch { return { kept: [], dropped: 0 }; }
  const body = norm(page);
  const kept: Proposal[] = [];
  let dropped = 0;
  for (const c of list.slice(0, 20)) {
    const o = (c ?? {}) as Record<string, unknown>;
    const title = text(o.title).slice(0, 160), day = text(o.closes_on), quote = text(o.quote), link = text(o.link);
    const realDay = /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
    const quoted = quote.length >= 12 && quote.length <= 300 && body.includes(norm(quote));
    const linkOk = link === "" ? Boolean(pageUrl) : (/^https?:\/\/\S+$/i.test(link) && (link === pageUrl || page.includes(link)));
    if (!title || !realDay || !quoted || !linkOk) { dropped++; continue; }
    kept.push({ title, closes_on: day, link: link || (pageUrl as string), quote });
  }
  return { kept, dropped };
}

/** Reads one page the person gave (an address, or pasted text) and returns proposals. Nothing is stored: a proposal becomes a call only when the person adds it. Counted before the call, under a lock on the event. */
export async function proposeCalls(db: Db, llm: Llm, actor: string, eventId: string, b: { url?: unknown; text?: unknown }, opts: { fetchPage?: PageFetcher | null } = {}) {
  planners(actor);
  const url = text(b.url) || null;
  let page = text(b.text);
  if (!page) {
    if (!url) throw new SpeakingInvalid("Give the address of the page, or paste its text.");
    if (opts.fetchPage === null) throw new SpeakingInvalid("The demo cannot read web pages. Paste the text instead.");
    page = (await (opts.fetchPage ?? ((u) => fetchPageText(u, undefined, true)))(url)).slice(0, 40_000);
  }
  page = page.slice(0, 40_000);
  const prompt = fill("cfp_read", { page });
  const callId = newId("llm");
  await db.tx(async (q) => {
    await planEvent(q, eventId);
    const [{ n }] = await q<{ n: number }>("SELECT count(*)::int AS n FROM llm_calls WHERE event_id = $1 AND step = 'cfp_read'", [eventId]);
    if (n >= CFP_READS_PER_EVENT) throw new RuleError(`This event has used its ${CFP_READS_PER_EVENT} page reads. Add the call by hand.`);
    await q("INSERT INTO llm_calls (id, event_id, step, prompt_hash, model, input_tokens, output_tokens, output) VALUES ($1, $2, 'cfp_read', $3, $4, 0, 0, '')", [callId, eventId, promptHash("cfp_read", llm.model), llm.model]);
  });
  let reply;
  try { reply = await llm.complete("cfp_read", prompt); }
  catch { throw new RuleError("The read did not come back. It still counts as one of the reads for this event. Add the call by hand."); }
  await db.query("UPDATE llm_calls SET model = $2, input_tokens = $3, output_tokens = $4, output = $5 WHERE id = $1", [callId, reply.model ?? llm.model, reply.input_tokens, reply.output_tokens, reply.text.slice(0, 20000)]);
  const { kept, dropped } = checkProposals(reply.text, page, url);
  return { proposals: kept.map((p) => ({ ...p, source_url: url })), dropped };
}

/* ------------------------------------------------------------------ the talk */

export interface TalkRow {
  id: string; event_id: string; involvement_id: string; cfp_id: string | null; title: string; abstract: string; speaker: string; status: string;
  abstract_by: string | null; abstract_editors: string[]; abstract_approved_by: string | null; abstract_approved_at: string | null; slides_url: string | null; slides_by: string | null; slides_editors: string[];
  slides_approved_by: string | null; slides_approved_at: string | null; slides_sent_on: string | null; submitted_on: string | null; slide_due_on: string | null; rehearsal_on: string | null; declined_reason: string | null;
}
const TALK_COLS = `id, event_id, involvement_id, cfp_id, title, abstract, speaker, status, abstract_by, abstract_editors, abstract_approved_by, abstract_approved_at::text AS abstract_approved_at, slides_url, slides_by, slides_editors,
  slides_approved_by, slides_approved_at::text AS slides_approved_at, slides_sent_on::text AS slides_sent_on, submitted_on::text AS submitted_on, slide_due_on::text AS slide_due_on, rehearsal_on::text AS rehearsal_on, declined_reason`;

async function lockTalk(q: Db["query"], talkId: string) {
  const [t] = await q<TalkRow>(`SELECT ${TALK_COLS} FROM talks WHERE id = $1 FOR UPDATE`, [talkId]);
  if (!t) throw new RuleError("That talk does not exist.");
  return t;
}
const mayWrite = (actor: string, t: { speaker: string }) => canPlan(actor) || (Boolean(t.speaker) && t.speaker === actor);
const forbid = () => { throw new Forbidden("Only the speaker and the people who plan can change a talk."); };

/** Makes the talk row for an event: on a talk involvement that has none yet, or on a new involvement when each already has one. */
export async function createTalk(db: Db, actor: string, eventId: string, b: { cfp_id?: string | null; id?: string; involvement_id?: string } = {}) {
  planners(actor);
  return db.tx(async (q) => {
    await planEvent(q, eventId);
    let inv = b.involvement_id ?? null;
    if (inv) {
      const [i] = await q<{ kind: string; status: string }>("SELECT kind, status FROM involvements WHERE id = $1 AND event_id = $2", [inv, eventId]);
      if (!i || i.kind !== "talk" || i.status === "dropped") throw new RuleError("That is not a talk on this event.");
      if ((await q("SELECT 1 FROM talks WHERE involvement_id = $1", [inv])).length) throw new RuleError("That talk already has its words.");
    } else {
      const [free] = await q<{ id: string }>("SELECT id FROM involvements i WHERE event_id = $1 AND kind = 'talk' AND status <> 'dropped' AND NOT EXISTS (SELECT 1 FROM talks t WHERE t.involvement_id = i.id) ORDER BY created_at LIMIT 1", [eventId]);
      if (free) inv = free.id;
      else { inv = newId("inv"); await q("INSERT INTO involvements (id, event_id, kind, label, talk_title, speaker, created_by) VALUES ($1, $2, 'talk', 'Talk', '', '', $3)", [inv, eventId, actor]); }
    }
    let cfp: string | null = null;
    if (b.cfp_id) {
      const [c] = await q<{ event_id: string; talk_id: string | null; status: string }>("SELECT event_id, talk_id, status FROM calls_for_papers WHERE id = $1 FOR UPDATE", [b.cfp_id]);
      if (!c || c.event_id !== eventId) throw new RuleError("That call is not on this event.");
      if (c.talk_id) throw new RuleError("That call already has a talk.");
      cfp = b.cfp_id;
    }
    const id = b.id ?? newId("tlk");
    const [iv] = await q<{ talk_title: string | null; speaker: string | null }>("SELECT talk_title, speaker FROM involvements WHERE id = $1", [inv]);
    await q("INSERT INTO talks (id, event_id, involvement_id, cfp_id, title, speaker, abstract_by, abstract_editors, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [id, eventId, inv, cfp, iv?.talk_title ?? "", iv?.speaker ?? "", iv?.talk_title ? actor : null, iv?.talk_title ? [actor] : [], actor]);
    if (cfp) await q("UPDATE calls_for_papers SET talk_id = $2 WHERE id = $1", [cfp, id]);
    await logActivity(q, eventId, actor, "speaking", "Started a talk");
    return { id, involvement_id: inv };
  });
}

export interface TalkPatch { title?: unknown; abstract?: unknown; speaker?: unknown; slides_url?: unknown; slide_due_on?: unknown; rehearsal_on?: unknown }

export async function saveTalk(db: Db, actor: string, talkId: string, p: TalkPatch) {
  return db.tx(async (q) => {
    const t = await lockTalk(q, talkId);
    if (!mayWrite(actor, t)) forbid();
    if (t.status === "accepted" || t.status === "declined") {
      if (p.title !== undefined || p.abstract !== undefined || p.speaker !== undefined) throw new RuleError("A talk that was accepted or declined keeps its words.");
    }
    const sets: string[] = [], vals: unknown[] = [talkId];
    const put = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    const raw = (col: string) => { if (!sets.includes(col)) sets.push(col); };
    const words = (p.title !== undefined && text(p.title).slice(0, 200) !== t.title) || (p.abstract !== undefined && text(p.abstract).slice(0, 4000) !== t.abstract);
    if (words) {
      if (t.status === "submitted") throw new RuleError("A submitted abstract is a record and cannot change.");
      if (p.title !== undefined) put("title", text(p.title).slice(0, 200));
      if (p.abstract !== undefined) put("abstract", text(p.abstract).slice(0, 4000));
      put("abstract_by", actor); put("abstract_editors", [...new Set([...(t.abstract_editors ?? []), actor])]); raw("abstract_approved_by = NULL"); raw("abstract_approved_at = NULL");
      if (t.status === "approved_to_submit") raw("status = 'drafting'");
    }
    if (p.speaker !== undefined && text(p.speaker).slice(0, 80) !== t.speaker) {
      if (t.status === "submitted" || t.status === "accepted" || t.status === "declined" || t.slides_sent_on) throw new RuleError("The speaker cannot change after the talk is submitted.");
      put("speaker", text(p.speaker).slice(0, 80));
      raw("abstract_approved_by = NULL"); raw("abstract_approved_at = NULL"); raw("slides_approved_by = NULL"); raw("slides_approved_at = NULL");
      if (t.status === "approved_to_submit") raw("status = 'drafting'");
    }
    if (p.slides_url !== undefined && (text(p.slides_url) || null) !== t.slides_url) {
      if (t.slides_sent_on) throw new RuleError("The slides were sent to the organizer, so the link cannot change.");
      const u = text(p.slides_url);
      put("slides_url", u ? web(u, "the slides link") : null); put("slides_by", actor); put("slides_editors", [...new Set([...(t.slides_editors ?? []), actor])]); raw("slides_approved_by = NULL"); raw("slides_approved_at = NULL");
    }
    if (p.slide_due_on !== undefined) put("slide_due_on", ymd(p.slide_due_on, "the slide deadline"));
    if (p.rehearsal_on !== undefined) put("rehearsal_on", ymd(p.rehearsal_on, "the rehearsal day"));
    if (!sets.length) return { id: talkId, changed: false };
    put("updated_by", actor); raw("updated_at = now()");
    await q(`UPDATE talks SET ${sets.join(", ")} WHERE id = $1`, vals);
    const [n] = await q<{ title: string; speaker: string }>("SELECT title, speaker FROM talks WHERE id = $1", [talkId]);
    await q("UPDATE involvements SET talk_title = $2, speaker = $3 WHERE id = $1", [t.involvement_id, n.title, n.speaker]);
    await logActivity(q, t.event_id, actor, "speaking", words ? "Changed the talk's words; its approval starts again" : "Changed the talk");
    return { id: talkId, changed: true };
  });
}

export async function approveAbstract(db: Db, actor: string, talkId: string) {
  planners(actor);
  return db.tx(async (q) => {
    const t = await lockTalk(q, talkId);
    if (t.status !== "drafting") throw new RuleError("Only a draft can be approved.");
    if (!t.title || !t.abstract || !t.speaker) throw new RuleError("Give the talk a title, an abstract and a speaker before approving it.");
    if (!t.abstract_by || t.abstract_by === actor || t.abstract_editors.includes(actor)) throw new Forbidden(OWN_WORDS);
    await q("UPDATE talks SET abstract_approved_by = $2, abstract_approved_at = now(), status = 'approved_to_submit', updated_by = $2, updated_at = now() WHERE id = $1", [talkId, actor]);
    await logActivity(q, t.event_id, actor, "speaking", `Approved the abstract of "${t.title}"`);
    return { id: talkId };
  });
}

export async function submitTalk(db: Db, actor: string, talkId: string, today: string) {
  return db.tx(async (q) => {
    const t = await lockTalk(q, talkId);
    if (!mayWrite(actor, t)) forbid();
    if (t.status !== "approved_to_submit") throw new RuleError("Approve the abstract before it is submitted.");
    await q("UPDATE talks SET status = 'submitted', submitted_on = $2, updated_by = $3, updated_at = now() WHERE id = $1", [talkId, today, actor]);
    if (t.cfp_id) await q("UPDATE calls_for_papers SET status = 'submitted' WHERE id = $1 AND status = 'open'", [t.cfp_id]);
    await logActivity(q, t.event_id, actor, "speaking", `Submitted "${t.title}"`);
    return { id: talkId };
  });
}

export async function acceptTalk(db: Db, actor: string, talkId: string) {
  planners(actor);
  return db.tx(async (q) => {
    const t = await lockTalk(q, talkId);
    await planEvent(q, t.event_id);
    if (t.status !== "submitted") throw new RuleError("Only a submitted talk can be accepted.");
    await q("UPDATE talks SET status = 'accepted', updated_by = $2, updated_at = now() WHERE id = $1", [talkId, actor]);
    await q("UPDATE involvements SET status = 'confirmed' WHERE id = $1 AND status = 'planned'", [t.involvement_id]);
    await offerKit(q, { eventId: t.event_id, person: t.speaker, role: "speaking", reason: "talk_accepted", sourceId: talkId, actor });
    await logActivity(q, t.event_id, actor, "speaking", `"${t.title}" was accepted`);
    return { id: talkId };
  });
}

export async function declineTalk(db: Db, actor: string, talkId: string, reason: string) {
  planners(actor);
  if (!text(reason)) throw new RuleError("Say why before declining.");
  return db.tx(async (q) => {
    const t = await lockTalk(q, talkId);
    await planEvent(q, t.event_id);
    if (!["drafting", "approved_to_submit", "submitted"].includes(t.status)) throw new RuleError("That talk is already settled.");
    await q("UPDATE talks SET status = 'declined', declined_reason = $2, updated_by = $3, updated_at = now() WHERE id = $1", [talkId, text(reason), actor]);
    await logActivity(q, t.event_id, actor, "speaking", `Declined "${t.title || "the talk"}": ${text(reason)}`);
    return { id: talkId };
  });
}

export async function approveSlides(db: Db, actor: string, talkId: string) {
  planners(actor);
  return db.tx(async (q) => {
    const t = await lockTalk(q, talkId);
    await planEvent(q, t.event_id);
    if (t.status !== "accepted") throw new RuleError("Slides are approved once the talk is accepted.");
    if (!t.slides_url) throw new RuleError("Add the slides link before approving the slides.");
    if (!t.slides_by || t.slides_by === actor || t.slides_editors.includes(actor)) throw new Forbidden(OWN_WORDS);
    await q("UPDATE talks SET slides_approved_by = $2, slides_approved_at = now(), updated_by = $2, updated_at = now() WHERE id = $1", [talkId, actor]);
    await logActivity(q, t.event_id, actor, "speaking", `Approved the slides of "${t.title}"`);
    return { id: talkId };
  });
}

export async function slidesSent(db: Db, actor: string, talkId: string, today: string) {
  planners(actor);
  return db.tx(async (q) => {
    const t = await lockTalk(q, talkId);
    await planEvent(q, t.event_id);
    if (t.status !== "accepted") throw new RuleError("Slides go to the organizer once the talk is accepted.");
    if (!t.slides_approved_at) throw new RuleError("The slides need a second person's approval before they go to the organizer.");
    if (t.slides_sent_on) throw new RuleError("The slides were already sent.");
    await q("UPDATE talks SET slides_sent_on = $2, updated_by = $3, updated_at = now() WHERE id = $1", [talkId, today, actor]);
    await logActivity(q, t.event_id, actor, "speaking", `Sent the slides of "${t.title}" to the organizer`);
    return { id: talkId };
  });
}

/* ------------------------------------------------------------------ reads */

/** What the next step of a talk is, as one sentence the button carries. */
export function nextStep(t: TalkRow): string {
  if (t.status === "declined") return "";
  if (t.status === "drafting") return !t.title || !t.abstract || !t.speaker ? "Write the title, abstract and speaker" : "Needs a second person to approve the abstract";
  if (t.status === "approved_to_submit") return "Submit it";
  if (t.status === "submitted") return "Record the answer";
  if (!t.slides_url) return "Add the slides link";
  if (!t.slides_approved_at) return "Needs a second person to approve the slides";
  if (!t.slides_sent_on) return "Send the slides to the organizer";
  return "";
}

export async function speakingView(db: Db, actor: string, today: string, opts: { eventId?: string } = {}) {
  const lead = canPlan(actor);
  const ev = opts.eventId ? "AND c.event_id = $1" : "";
  const args = opts.eventId ? [opts.eventId] : [];
  const calls = await db.query<CallRow & { event_name: string }>(`SELECT ${CALL_COLS.split(", ").map((x) => "c." + x.replace(/^c\./, "")).join(", ")}, e.name AS event_name FROM calls_for_papers c JOIN events e ON e.id = c.event_id WHERE true ${ev} ORDER BY (c.status = 'open') DESC, c.closes_on, c.id`, args);
  const talks = await db.query<TalkRow & { event_name: string; scans: number; placed: number; hot: number; meetings_held: number }>(
    `SELECT ${TALK_COLS.split(/,\s+/).map((x) => (x.includes("::") ? x.replace(/^(\w+)/, "t.$1") : "t." + x)).join(", ")}, e.name AS event_name, (SELECT count(*)::int FROM scans s WHERE s.talk_id = t.id) AS scans,
            (SELECT count(*)::int FROM scans s WHERE s.talk_id = t.id AND s.state = 'placed') AS placed, (SELECT count(*)::int FROM scans s WHERE s.talk_id = t.id AND s.temperature = 'hot') AS hot,
            (SELECT count(DISTINCT m.id)::int FROM meetings m WHERE m.status = 'held' AND m.event_id = t.event_id AND m.contact_id IN (SELECT s.contact_id FROM scans s WHERE s.talk_id = t.id AND s.contact_id IS NOT NULL)) AS meetings_held
     FROM talks t JOIN events e ON e.id = t.event_id WHERE true ${ev.replace(/c\./g, "t.")} ORDER BY e.starts_on NULLS LAST, t.created_at`, args);
  const visibleTalks = lead ? talks : talks.filter((t) => t.speaker === actor);
  return {
    posting: opts.eventId && lead ? await postingCounts(db, opts.eventId) : null,
    can_write: lead,
    calls: (lead ? calls : []).map((c) => ({ ...c, closing: c.status === "open" ? dueWords(c.closes_on, today) : c.status === "submitted" ? "Submitted" : "Passed", is_closed: c.status === "open" && c.closes_on < today })),
    talks: visibleTalks.map((t) => ({ ...t, status_words: TALK_STATUS_WORDS[t.status], next: nextStep(t), slides_late: t.status === "accepted" && !t.slides_sent_on && Boolean(t.slide_due_on) && (t.slide_due_on as string) < today,
      slide_due_words: t.slide_due_on ? dueWords(t.slide_due_on, today) : null, rehearsal_words: t.rehearsal_on ? dueWords(t.rehearsal_on, today) : null, can_write: mayWrite(actor, t) })),
  };
}
