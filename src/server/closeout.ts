/* The end of an event's life: scorecard, debrief, learning, and the nightly integrity checks (docs/LIFECYCLE.md, sections 10 to 13). */

import type { Db } from "./db.ts";
import { crmConnected } from "./crm-checks.ts";
import { getSettings } from "./approvals.ts";
import { clocks, daysPast, SCORE_DAYS } from "./motion.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { reserve, settle, spend, spendByStep } from "./ledger.ts";
import { DESK, nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { moveMotion } from "./motion-state.ts";
import { parseJson } from "./paid.ts";
import { fill, promptHash } from "./prompts.ts";
import { debriefCard, scoreCard } from "./slack-cards.ts";
import { addDays, localDay } from "../shared/motion.ts";

export const MIN_HELD_TO_SCORE = 5;
export const MIN_OUTCOMES = 20;
const INFLUENCE_DAYS = 90;
const WINDOWS = [30, 60, 90] as const;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export interface Scorecard {
  funnel: { kept: number; enrolled: number; sent: number; replied: number; booked: number; held: number }; logged_outside: number;
  cost: { tickets_cents: number; travel_cents: number; ai_cents: number; dollars_cents: number; credits_by_step: Record<string, number> };
  cost_per_held_cents: number | null;
  influence: { available: boolean; opportunities: number; pipeline_cents: number };
  score: { held_per_thousand: number; pipeline_per_dollar: number | null } | null;
  past: { held_per_thousand: number | null; pipeline_per_dollar: number | null };
}

export async function computeScorecard(db: Db, deps: LifecycleDeps, eventId: string, windowDays: number): Promise<Scorecard> {
  const [f] = await db.query<Scorecard["funnel"] & { logged_outside: number }>("SELECT kept, enrolled, sent, replied, booked, held, logged_outside FROM event_funnel WHERE event_id = $1", [eventId]);
  const s = await getSettings(db.query, eventId);
  const [c] = await db.query<{ tickets: number; travel: number }>(
    `SELECT coalesce((SELECT sum(p.amount_cents) FROM ticket_purchases p JOIN seat_requests r ON r.id = p.seat_request_id WHERE r.event_id = $1), 0)::int AS tickets,
            coalesce((SELECT sum(travel_cents) FROM seat_requests WHERE event_id = $1 AND status <> 'declined'), 0)::int AS travel`, [eventId]);
  const ai_cents = (await spend(db, eventId)).llm * s.llm_call_cents;
  const credits_by_step: Record<string, number> = {};
  for (const r of await spendByStep(db, eventId)) if (r.unit === "credits") credits_by_step[r.step] = (credits_by_step[r.step] ?? 0) + r.n;
  const dollars_cents = c.tickets + c.travel + ai_cents;
  // Influence, never sole credit: an open or moving opportunity at an account with a held meeting credited here, within the window after it.
  let influence: Scorecard["influence"] = { available: false, opportunities: 0, pipeline_cents: 0 };
  if (crmConnected(deps.crm) && deps.crm.opportunities) {
    const met = await db.query<{ domain: string; name: string; first_held: string }>(
      `SELECT m.domain, min(co.name) AS name, min(m.scheduled_at)::text AS first_held FROM meetings m JOIN contacts k ON k.id = m.contact_id JOIN companies co ON co.id = k.company_id WHERE m.event_id = $1 AND m.status = 'held' GROUP BY m.domain`, [eventId]);
    const opps = await deps.crm.opportunities(met.map((m) => ({ ref: m.domain, domain: m.domain, name: m.name })));
    influence = { available: true, opportunities: 0, pipeline_cents: 0 };
    for (const m of met) {
      const from = Date.parse(m.first_held), to = from + INFLUENCE_DAYS * 86_400_000;
      for (const o of opps[m.domain] ?? []) {
        const within = (t: string) => { const d = Date.parse(t); return d >= from && d <= to; };
        if (within(o.created_date) || o.stage_history.some((h) => within(h.at) && !/lost/i.test(h.stage))) { influence.opportunities++; influence.pipeline_cents += o.amount_cents ?? 0; }
      }
    }
  }
  const score = f.held < MIN_HELD_TO_SCORE || dollars_cents === 0 ? null : { held_per_thousand: Math.round((f.held / (dollars_cents / 100_000)) * 100) / 100, pipeline_per_dollar: influence.available ? Math.round((influence.pipeline_cents / dollars_cents) * 100) / 100 : null };
  const past = await db.query<{ metrics: Scorecard }>("SELECT metrics FROM scorecards WHERE window_days = $1 AND event_id <> $2", [windowDays, eventId]);
  const held = past.map((p) => p.metrics.score?.held_per_thousand).filter((x): x is number => typeof x === "number");
  const pipe = past.map((p) => p.metrics.score?.pipeline_per_dollar).filter((x): x is number => typeof x === "number");
  const { logged_outside, ...funnel } = f;
  return { funnel, logged_outside, cost: { tickets_cents: c.tickets, travel_cents: c.travel, ai_cents, dollars_cents, credits_by_step }, cost_per_held_cents: f.held ? Math.round(dollars_cents / f.held) : null, influence, score, past: { held_per_thousand: median(held), pipeline_per_dollar: median(pipe) } };
}

/** First score 30 days after the event's last day, revised at 60 and 90, each version kept. */
export async function writeScorecards(db: Db, deps: LifecycleDeps) {
  const now = nowOf(deps);
  let written = 0;
  const open = await db.query<{ id: string; motion: string; country: string | null; last_day: string; name: string }>(
    `SELECT e.id, e.motion, e.country, e.name, coalesce((SELECT c.ends_on FROM catalog_events c WHERE c.id = e.catalog_id), e.starts_on)::text AS last_day FROM events e WHERE e.stage = 'delivered' AND e.parent_event_id IS NULL AND e.motion IN ('closing', 'scored')`);
  for (const e of open) {
    const past = daysPast(e, now);
    for (const w of WINDOWS) {
      if (past < w) continue;
      const [have] = await db.query("SELECT 1 FROM scorecards WHERE event_id = $1 AND window_days = $2", [e.id, w]);
      if (have) continue;
      const metrics = await computeScorecard(db, deps, e.id, w);
      await db.tx(async (q) => {
        const ins = await q("INSERT INTO scorecards (id, event_id, window_days, metrics) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (event_id, window_days) DO NOTHING RETURNING id", [newId("scr"), e.id, w, JSON.stringify(metrics)]);
        if (ins.length && w === SCORE_DAYS && e.motion === "closing") await moveMotion(q, e.id, "scored", DESK, "The 30-day scorecard is written");
      });
      written++;
      if (w === SCORE_DAYS && deps.notify) {
        const [ev] = await db.query<{ slack_thread: string | null }>("SELECT slack_thread FROM events WHERE id = $1", [e.id]);
        try { await deps.notify.thread(ev.slack_thread, scoreCard({ event: e.name, held: metrics.funnel.held, line: metrics.score ? `${metrics.score.held_per_thousand} held per $1,000` : `Fewer than ${MIN_HELD_TO_SCORE} held meetings, so counts only` })); } catch { /* the scorecard stands without the post */ }
      }
    }
  }
  void clocks;
  return { written };
}

/** Past scores, for the moment a seat request for the same conference is decided. */
export const pastScores = (db: Db, catalogId: string) => db.query<{ event_id: string; name: string; window_days: number; metrics: Scorecard }>(
  `SELECT s.event_id, e.name, s.window_days, s.metrics FROM scorecards s JOIN events e ON e.id = s.event_id WHERE e.catalog_id = $1 ORDER BY e.starts_on DESC, s.window_days DESC`, [catalogId]);

/* ---------------------------------------------------------------- debrief */

export const THEMES = ["pain", "competitor", "timing", "budget", "product_gap", "relationship", "general"] as const;

export async function sendDebriefPrompts(db: Db, deps: LifecycleDeps) {
  const now = nowOf(deps);
  const events = await db.query<{ id: string; name: string; country: string | null; last_day: string; delivered_on: string }>(
    `SELECT e.id, e.name, e.country, coalesce((SELECT c.ends_on FROM catalog_events c WHERE c.id = e.catalog_id), e.starts_on)::text AS last_day, e.stage_changed_at::date::text AS delivered_on FROM events e WHERE e.stage = 'delivered' AND e.parent_event_id IS NULL`);
  let sent = 0;
  for (const e of events) {
    const due = addDays(e.last_day > e.delivered_on ? e.last_day : e.delivered_on, 2);
    if (localDay(now, e.country) < due) continue;
    const reps = await db.query<{ rep: string; n: number }>("SELECT rep, count(*)::int AS n FROM meetings m WHERE event_id = $1 AND status = 'held' AND rep IS NOT NULL AND NOT EXISTS (SELECT 1 FROM debriefs d WHERE d.event_id = m.event_id AND d.author = m.rep) GROUP BY rep", [e.id]);
    for (const r of reps) {
      const slackId = deps.userMap?.[r.rep];
      if (!slackId || !deps.notify) continue;
      const id = newId("dbf");
      const ins = await db.query("INSERT INTO debriefs (id, event_id, author, prompted_at) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id, author) DO NOTHING RETURNING id", [id, e.id, r.rep, now.toISOString()]);
      if (!ins.length) continue;
      try { await deps.notify.dm(slackId, debriefCard({ event: e.name, meetings: r.n, debrief_id: id })); sent++; } catch (err) { console.error("debrief", (err as Error).message); }
    }
  }
  return { sent };
}

export async function answerDebrief(db: Db, debriefId: string, actor: string, body: string) {
  if (!body.trim()) throw new RuleError("Write a few lines first.");
  return db.tx(async (q) => {
    const [d] = await q<{ author: string; body: string | null }>("SELECT author, body FROM debriefs WHERE id = $1 FOR UPDATE", [debriefId]);
    if (!d) throw new RuleError("That debrief does not exist.");
    if (d.author !== actor) throw new RuleError(`This debrief is ${d.author}'s to write.`);
    // Writing more adds to it.
    const text = d.body ? `${d.body}\n\n${body.trim()}` : body.trim();
    await q("UPDATE debriefs SET body = $2, answered_at = now(), status = 'answered', extracted = false WHERE id = $1", [debriefId, text.slice(0, 20_000)]);
    return { saved: true };
  });
}

interface RawFact { account?: unknown; theme?: unknown; fact?: unknown; quote?: unknown }

/** One call on the Motion card. Every fact must quote the debrief word for word or it is thrown away. With no card the answer is kept and no model reads it. */
export async function extractDebriefs(db: Db, deps: LifecycleDeps) {
  const waiting = await db.query<{ id: string; event_id: string; body: string }>("SELECT id, event_id, body FROM debriefs WHERE status = 'answered' AND NOT extracted AND body IS NOT NULL");
  const out = { extracted: 0, discarded: 0, no_card: 0 };
  for (const d of waiting) {
    const res = await reserve(db, d.event_id, "llm", 1, "debrief_extract");
    if (!res) { out.no_card++; continue; }
    let facts: RawFact[] = [];
    try {
      const r = await deps.llm.complete("debrief_extract", fill("debrief_extract", { themes: THEMES.join(", "), notes: d.body.replaceAll("NOTES>>>", "NOTES") }));
      await settle(db, res, 1);
      await db.query("INSERT INTO llm_calls (id, event_id, step, prompt_hash, model, input_tokens, output_tokens, output) VALUES ($1, $2, 'debrief_extract', $3, $4, $5, $6, $7)", [newId("llm"), d.event_id, promptHash("debrief_extract", deps.llm.model), r.model ?? deps.llm.model, r.input_tokens, r.output_tokens, r.text.slice(0, 4000)]);
      const v = parseJson(r.text) as { facts?: unknown } | null;
      if (Array.isArray(v?.facts)) facts = v!.facts as RawFact[];
    } catch { await settle(db, res, 1); continue; }
    await db.tx(async (q) => {
      for (const f of facts) {
        const quote = typeof f.quote === "string" ? f.quote : "", fact = typeof f.fact === "string" ? f.fact.trim() : "";
        if (!quote.trim() || !fact || !d.body.includes(quote)) { out.discarded++; continue; }
        const dup = await q("SELECT 1 FROM debrief_facts WHERE debrief_id = $1 AND quote = $2", [d.id, quote]);
        if (dup.length) continue;
        await q("INSERT INTO debrief_facts (id, debrief_id, account, theme, fact, quote) VALUES ($1, $2, $3, $4, $5, $6)", [newId("fct"), d.id, typeof f.account === "string" ? f.account.slice(0, 200) : null, THEMES.includes(f.theme as never) ? f.theme : "general", fact.slice(0, 500), quote]);
        out.extracted++;
      }
      await q("UPDATE debriefs SET extracted = true WHERE id = $1", [d.id]);
    });
  }
  return out;
}

export async function reviewDebrief(db: Db, debriefId: string, actor: string, decision: "accepted" | "rejected") {
  const rows = await db.query("UPDATE debriefs SET status = $2, decided_by = $3 WHERE id = $1 AND status = 'answered' RETURNING id", [debriefId, decision, actor]);
  if (!rows.length) throw new RuleError("That debrief is not waiting for a decision.");
  return { status: decision };
}

/* --------------------------------------------------------------- learning */

export interface LearningRow { group_kind: string; group_value: string; people: number; held: number; rate: number | null; enough: boolean }

/** All of it is GROUP BY. Fewer than 20 outcomes reads "too few to say". */
export async function learningTable(db: Db) {
  const rows = await db.query<{ group_kind: string; group_value: string; people: number; held: number }>(
    `WITH o AS (
       SELECT k.id, co.tier::text AS company_tier, k.title_tier::text AS title_tier, coalesce(co.segment, 'none') AS segment, EXISTS (SELECT 1 FROM meetings m WHERE m.contact_id = k.id AND m.status = 'held') AS held
       FROM contacts k JOIN companies co ON co.id = k.company_id WHERE EXISTS (SELECT 1 FROM enrollments n WHERE n.contact_id = k.id AND n.state <> 'adding'))
     SELECT 'company_tier' AS group_kind, coalesce(company_tier, 'unknown') AS group_value, count(*)::int AS people, count(*) FILTER (WHERE held)::int AS held FROM o GROUP BY 2
     UNION ALL SELECT 'title_tier', coalesce(title_tier, 'unknown'), count(*)::int, count(*) FILTER (WHERE held)::int FROM o GROUP BY 2
     UNION ALL SELECT 'segment', segment, count(*)::int, count(*) FILTER (WHERE held)::int FROM o GROUP BY 2
     ORDER BY 1, 2`);
  return rows.map<LearningRow>((r) => ({ ...r, rate: r.people ? r.held / r.people : null, enough: r.people >= MIN_OUTCOMES }));
}

/** People the desk dropped whose company later shows a deal. */
export async function droppedWhoDealt(db: Db, deps: LifecycleDeps) {
  if (!crmConnected(deps.crm) || !deps.crm.opportunities) return [];
  const rows = await db.query<{ domain: string; name: string; dropped: number }>(
    `SELECT co.primary_domain AS domain, min(co.name) AS name, count(*)::int AS dropped FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.drop_reason IN ('low_tier', 'tiering_failed') AND co.primary_domain IS NOT NULL GROUP BY co.primary_domain`);
  const opps = await deps.crm.opportunities(rows.map((r) => ({ ref: r.domain, domain: r.domain, name: r.name })));
  return rows.filter((r) => (opps[r.domain] ?? []).length).map((r) => ({ ...r, opportunities: opps[r.domain].length }));
}

/** A suggested edit, with its evidence, for a person to accept. Nothing changes the ICP from here: an accepted one goes through the ICP confirm screen as a new version. */
export async function proposeEdits(db: Db) {
  const table = await learningTable(db);
  const overall = table.filter((t) => t.group_kind === "company_tier");
  const people = overall.reduce((n, t) => n + t.people, 0), held = overall.reduce((n, t) => n + t.held, 0);
  if (people < MIN_OUTCOMES || !held) return { proposed: 0 };
  const base = held / people;
  let proposed = 0;
  for (const t of table) {
    if (!t.enough || t.group_kind === "company_tier" && t.group_value === "1") continue;
    const verdict = t.rate! >= base * 2 ? "raise" : t.rate! === 0 && t.people >= MIN_OUTCOMES * 2 ? "lower" : null;
    if (!verdict) continue;
    const rows = await db.query("INSERT INTO learning_proposals (id, kind, subject, evidence, edit) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) ON CONFLICT (kind, subject) DO NOTHING RETURNING id",
      [newId("lrn"), t.group_kind, t.group_value, JSON.stringify({ people: t.people, held: t.held, rate: t.rate, overall_rate: base }), JSON.stringify({ verdict })]);
    proposed += rows.length;
  }
  return { proposed };
}

export async function decideProposal(db: Db, id: string, actor: string, status: "accepted" | "rejected") {
  const rows = await db.query("UPDATE learning_proposals SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'open' RETURNING id", [id, status, actor]);
  if (!rows.length) throw new RuleError("That suggestion is not open.");
  return { status };
}

/* -------------------------------------------------------------- integrity */

/** Observes, alerts and never repairs. */
export async function integrityCheck(db: Db, deps: LifecycleDeps) {
  const failures: { check: string; rows: unknown[] }[] = [];
  const check = async (name: string, sql: string) => { const rows = await db.query(sql); if (rows.length) failures.push({ check: name, rows: rows.slice(0, 50) }); };
  await check("opted_out_but_enrolled", `SELECT n.id FROM enrollments n JOIN contacts k ON k.id = n.contact_id WHERE n.state IN ('enrolled', 'adding') AND EXISTS (SELECT 1 FROM suppressions s WHERE s.kind = 'opt_out' AND s.email = lower(k.email))`);
  await check("enrolled_without_a_passed_gate", `SELECT n.id FROM enrollments n WHERE n.state = 'enrolled' AND NOT EXISTS (SELECT 1 FROM gate_log g WHERE g.contact_id = n.contact_id AND g.channel = n.channel AND g.passed)`);
  await check("paused_without_a_cause", `SELECT id FROM enrollments WHERE state = 'paused' AND cause IS NULL`);
  await check("removed_without_a_cause", `SELECT id FROM enrollments WHERE state = 'removed' AND cause IS NULL`);
  await check("reservation_settled_twice", `SELECT reservation_id FROM credit_ledger WHERE kind = 'settle' GROUP BY reservation_id HAVING count(*) > 1`);
  await check("ledger_over_cap", `SELECT k.id FROM cost_cards k WHERE k.status = 'approved' AND (SELECT coalesce(sum(CASE l.kind WHEN 'reserve' THEN l.amount WHEN 'release' THEN -l.amount ELSE 0 END), 0) FROM credit_ledger l WHERE l.card_id = k.id AND l.unit = 'credits') > k.credits_cap`);
  await check("funnel_increases_down_its_steps", `SELECT event_id FROM event_funnel WHERE enrolled > kept OR sent > enrolled OR replied > sent OR booked > replied OR held > booked`);
  await db.query("INSERT INTO integrity_runs (id, at, failures) VALUES ($1, $2, $3::jsonb)", [newId("int"), nowOf(deps).toISOString(), JSON.stringify(failures)]);
  if (failures.length) for (const e of await db.query<{ id: string }>("SELECT id FROM events WHERE motion NOT IN ('none', 'scored') LIMIT 1")) await logActivity(db.query, e.id, DESK, "integrity", `Integrity check found problems: ${failures.map((f) => f.check).join(", ")}`);
  return { failures };
}
