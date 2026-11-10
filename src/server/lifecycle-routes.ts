/* The routes for everything after delivery. Each one is a thin call into the same functions the timer and Slack use, so the rules cannot differ between them. Webhooks live outside /api: a tool has no display name, and each one proves itself to its connector. */

import type { Hono } from "hono";
import type { Db } from "./db.ts";
import { cleanNames, renderStep, type TemplateStep } from "../shared/template-check.ts";
import { recordEventCost, answerDebrief, learningTable, reviewDebrief, decideProposal } from "./closeout.ts";
import { RuleError } from "./events.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { bookMeeting, confirmRelease, ingestCalendar, recordOutcome, type CalendarEvent } from "./meetings.ts";
import { requestMotionCard } from "./motion.ts";
import { decideOwner } from "./owners.ts";
import { ingestEvents, processInbound } from "./replies.ts";
import { approveTemplate, attachCampaign, confirmLaunchChecklist, createDrafts, recordLegalBasis, restartSending, resumePerson, setTools, stopAllSending } from "./sequences.ts";
import { regionOf, loadPeople } from "./gate.ts";
import { recordConsent, recordPlacement, setDomainStatus } from "./sending.ts";
import { captureOnsite, forgetPerson, markHandled } from "./operating.ts";
import { isGtm } from "../shared/roles.ts";
import { MOTION_LABEL } from "../shared/motion.ts";

type App = Hono<{ Variables: { actor: string } }>;

export async function motionOverview(db: Db, deps: LifecycleDeps, id: string) {
  const [e] = await db.query<{ motion: keyof typeof MOTION_LABEL; tools: Record<string, string>; stage: string; verify_once: boolean; write_leads: boolean; outreach_started_by: string | null }>("SELECT motion, tools, stage, verify_once, write_leads, outreach_started_by FROM events WHERE id = $1", [id]);
  if (!e) return null;
  const [captures, unplaced, sequences, funnel, owners, replies, meetings, scorecards, debriefs, card, bases, cases] = await Promise.all([
    db.query("SELECT id, full_name, email, company, title, note, temperature, rep, source, captured_at::text AS captured_at FROM onsite_captures WHERE event_id = $1 ORDER BY captured_at DESC LIMIT 100", [id]),
    db.query("SELECT id, connector, channel, body, received_at::text AS received_at FROM inbound_messages WHERE status = 'unmatched' ORDER BY received_at DESC LIMIT 20"),
    db.query(`SELECT s.id, s.name, s.channel, s.priority, s.connector, s.state, s.launched_at::text AS launched_at, s.pause_reason, s.senders_needed, s.peak_daily, s.sender_status, s.sender_excluded,
                (SELECT count(*)::int FROM enrollments n WHERE n.sequence_id = s.id AND n.state = 'enrolled') AS enrolled,
                (SELECT count(*)::int FROM enrollments n WHERE n.sequence_id = s.id AND n.state = 'paused') AS paused,
                (SELECT count(*)::int FROM enrollments n WHERE n.sequence_id = s.id AND n.state = 'removed') AS removed,
                coalesce((SELECT json_agg(json_build_object('address', x.address, 'role', x.role, 'daily_share', x.daily_share, 'health', x.health_at_pick) ORDER BY x.role, x.address) FROM sequence_senders x WHERE x.sequence_id = s.id AND x.dropped_at IS NULL), '[]') AS senders
              FROM sequences s WHERE s.event_id = $1 ORDER BY s.channel, s.priority`, [id]),
    db.query("SELECT * FROM event_funnel WHERE event_id = $1", [id]),
    db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM owner_decisions WHERE event_id = $1 GROUP BY status", [id]),
    db.query(`SELECT m.id, m.channel, m.signal, m.code, m.doubtful, m.status, m.received_at::text AS received_at, m.body, k.id AS contact_id, k.full_name, co.name AS company FROM inbound_messages m LEFT JOIN contacts k ON k.id = m.contact_id LEFT JOIN companies co ON co.id = k.company_id WHERE m.event_id = $1 ORDER BY m.received_at DESC LIMIT 50`, [id]),
    db.query(`SELECT m.id, m.status, m.scheduled_at::text AS scheduled_at, m.timezone, m.rep, m.source, m.enrolled, k.full_name, co.name AS company FROM meetings m LEFT JOIN contacts k ON k.id = m.contact_id LEFT JOIN companies co ON co.id = k.company_id WHERE m.event_id = $1 ORDER BY m.scheduled_at`, [id]),
    db.query("SELECT window_days, metrics, created_at::text AS created_at FROM scorecards WHERE event_id = $1 ORDER BY window_days", [id]),
    db.query(`SELECT d.id, d.author, d.status, d.body, d.answered_at::text AS answered_at, coalesce((SELECT json_agg(json_build_object('theme', f.theme, 'fact', f.fact, 'quote', f.quote, 'account', f.account)) FROM debrief_facts f WHERE f.debrief_id = d.id), '[]') AS facts FROM debriefs d WHERE d.event_id = $1`, [id]),
    db.query("SELECT k.id, k.status, k.lines, k.llm_cap, k.credits_cap, k.est_cents, k.inputs FROM cost_cards k WHERE k.event_id = $1 AND k.kind = 'motion' ORDER BY k.created_at DESC LIMIT 1", [id]),
    db.query<{ region: string; basis: string; recorded_by: string }>("SELECT region, basis, recorded_by FROM legal_bases WHERE event_id = $1", [id]),
    db.query<{ n: number }>("SELECT count(*)::int AS n FROM review_cases WHERE event_id = $1 AND status = 'open' AND NOT blocking", [id]),
  ]);
  const kept = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND priority IS NOT NULL", [id]);
  const people = kept.length ? await loadPeople(db, id, kept.map((k) => k.id)) : [];
  const counts = new Map<string, number>();
  for (const p of people) counts.set(regionOf(p), (counts.get(regionOf(p)) ?? 0) + 1);
  return {
    motion: e.motion, label: MOTION_LABEL[e.motion], stage: e.stage, tools: e.tools, verify_once: e.verify_once, write_leads: e.write_leads, started_by: e.outreach_started_by,
    connectors: Object.values(deps.connectors).map((c) => ({ name: c.name, channels: c.channels, simulated: Boolean(c.simulated), capabilities: c.capabilities })),
    poll_minutes: deps.pollMinutes ?? 5, crm_connected: Boolean(deps.crm?.connected),
    captures, unplaced, card: card[0] ?? null, sequences, funnel: funnel[0] ?? null, owners, replies, meetings, scorecards, debriefs, open_cases: cases[0].n,
    regions: [...counts].sort((a, b) => b[1] - a[1]).map(([region, people]) => ({ region, people, basis: bases.find((b) => b.region === region)?.basis ?? null, recorded_by: bases.find((b) => b.region === region)?.recorded_by ?? null })),
  };
}

export function mountLifecycle(app: App, db: Db, deps: LifecycleDeps, opts: { bad: (msg: string, status?: 400 | 401 | 403 | 404 | 409) => Response; publicDemo?: boolean }) {
  const { bad } = opts;
  const guarded = (run: (c: any) => Promise<unknown>) => async (c: any) => {
    try { return c.json((await run(c)) ?? { ok: true }); }
    catch (e) { if (e instanceof RuleError) return bad(e.message, 409); throw e; }
  };
  const body = async (c: any) => (await c.req.json().catch(() => ({}))) as Record<string, any>;

  app.get("/api/events/:id/motion", async (c) => { const o = await motionOverview(db, deps, c.req.param("id")); return o ? c.json(o) : bad("That event does not exist.", 404); });
  app.post("/api/events/:id/motion/start", guarded(async (c) => { const b = await body(c); return requestMotionCard(db, deps, c.req.param("id"), c.get("actor"), { purpose: b.purpose, verify_once: b.verify_once, write_leads: b.write_leads }); }));
  app.post("/api/events/:id/motion/tools", guarded(async (c) => setTools(db, c.req.param("id"), c.get("actor"), (await body(c)).tools ?? {}, deps)));
  app.post("/api/events/:id/motion/legal-basis", guarded(async (c) => { const b = await body(c); return recordLegalBasis(db, c.req.param("id"), c.get("actor"), String(b.region ?? ""), String(b.basis ?? "")); }));
  app.post("/api/events/:id/motion/sequences", guarded(async (c) => createDrafts(db, deps, c.req.param("id"), c.get("actor"))));
  app.post("/api/motion/sequences/:sid/campaign", guarded(async (c) => attachCampaign(db, deps, c.req.param("sid"), String((await body(c)).external_id ?? ""), c.get("actor"))));
  app.post("/api/motion/sequences/:sid/checklist", guarded(async (c) => confirmLaunchChecklist(db, c.req.param("sid"), c.get("actor"))));
  app.post("/api/events/:id/motion/capture", guarded(async (c) => { const b = await body(c); return captureOnsite(db, deps, c.req.param("id"), c.get("actor"), b); }));
  app.post("/api/motion/replies/:rid/handled", guarded(async (c) => markHandled(db, c.req.param("rid"), c.get("actor"))));
  app.post("/api/motion/forget", guarded(async (c) => { if (!isGtm(c.get("actor"))) throw new RuleError("Erasure requests are GTM Engineering's to carry out."); return forgetPerson(db, deps, String((await body(c)).email ?? ""), c.get("actor")); }));
  app.post("/api/motion/consent", guarded(async (c) => { const b = await body(c); return recordConsent(db, String(b.connector), String(b.sender_id), String(b.rep), c.get("actor")); }));
  app.post("/api/motion/domains", guarded(async (c) => { if (!isGtm(c.get("actor"))) throw new RuleError("Sending domains are GTM Engineering's to mark."); const b = await body(c); return setDomainStatus(db, String(b.domain), String(b.status), String(b.reason ?? ""), c.get("actor")); }));
  app.post("/api/motion/sequences/:sid/placement-override", guarded(async (c) => { if (!isGtm(c.get("actor"))) throw new RuleError("Only GTM Engineering can send without a placement test."); await db.query("UPDATE sequences SET placement_override_by = $2 WHERE id = $1", [c.req.param("sid"), c.get("actor")]); }));
  app.get("/api/motion/alerts", async (c) => c.json({ alerts: await db.query("SELECT key, day::text AS day, text, created_at::text AS created_at FROM alerts ORDER BY created_at DESC LIMIT 50"), controls: (await db.query("SELECT sending_stopped_at::text AS stopped_at, stopped_by, reason FROM desk_controls"))[0] }));
  app.post("/api/events/:id/motion/costs", guarded(async (c) => { const b = await body(c); return recordEventCost(db, c.req.param("id"), c.get("actor"), String(b.category), Number(b.amount_cents), String(b.note ?? "")); }));
  app.get("/api/motion/sequences/:sid/preview", async (c) => {
    const [s] = await db.query<{ event_id: string; name: string; steps: TemplateStep[]; event: string }>("SELECT q.event_id, q.name, t.steps, e.name AS event FROM sequences q JOIN sequence_templates t ON t.id = q.template_id JOIN events e ON e.id = q.event_id WHERE q.id = $1", [c.req.param("sid")]);
    if (!s) return bad("That sequence does not exist.", 404);
    const rows = await db.query<{ full_name: string | null; title: string | null; company: string }>("SELECT k.full_name, k.title, co.name AS company FROM enrollments n JOIN contacts k ON k.id = n.contact_id JOIN companies co ON co.id = k.company_id WHERE n.sequence_id = $1 AND n.state <> 'removed' ORDER BY n.id LIMIT 3", [c.req.param("sid")]);
    return c.json({ name: s.name, previews: rows.map((r) => ({ person: r.full_name, steps: s.steps.map((st) => renderStep(st, { ...cleanNames(r.full_name), company: r.company, title: r.title, event: s.event })) })) });
  });
  app.post("/api/motion/stop", guarded(async (c) => stopAllSending(db, deps, c.get("actor"), String((await body(c)).reason ?? "No reason given"))));
  app.post("/api/motion/restart", guarded(async (c) => restartSending(db, c.get("actor"))));
  app.post("/api/events/:id/motion/contacts/:cid/resume", guarded(async (c) => resumePerson(db, deps, c.req.param("id"), c.req.param("cid"), c.get("actor"))));
  app.post("/api/events/:id/motion/meetings", guarded(async (c) => { const b = await body(c); return bookMeeting(db, deps, { contact_id: String(b.contact_id ?? ""), scheduled_at: String(b.scheduled_at ?? ""), timezone: b.timezone, source: "manual", rep: b.rep ?? c.get("actor") }, c.get("actor")); }));
  app.post("/api/motion/meetings/:mid/outcome", guarded(async (c) => recordOutcome(db, deps, c.req.param("mid"), (await body(c)).status, c.get("actor"))));
  app.post("/api/motion/meetings/:mid/release", guarded(async (c) => confirmRelease(db, deps, c.req.param("mid"), c.get("actor"))));
  app.post("/api/motion/owners/:did", guarded(async (c) => decideOwner(db, deps, c.req.param("did"), c.get("actor"), (await body(c)).status)));
  app.post("/api/motion/debriefs/:did/answer", guarded(async (c) => answerDebrief(db, c.req.param("did"), c.get("actor"), String((await body(c)).body ?? ""))));
  app.post("/api/motion/debriefs/:did/review", guarded(async (c) => reviewDebrief(db, c.req.param("did"), c.get("actor"), (await body(c)).status)));

  app.get("/api/motion/templates", async (c) => c.json({ templates: await db.query("SELECT id, name, version, channel, phase, steps, external_id, approved_by, approved_at::text AS approved_at FROM sequence_templates WHERE retired_at IS NULL ORDER BY channel, phase") }));
  app.post("/api/motion/templates", guarded(async (c) => { if (!isGtm(c.get("actor"))) throw new RuleError("Templates are GTM Engineering's to approve."); const b = await body(c); return approveTemplate(db, c.get("actor"), { name: String(b.name ?? ""), channel: b.channel, phase: b.phase, steps: Array.isArray(b.steps) ? b.steps : [], external_id: b.external_id ?? null }); }));
  app.post("/api/motion/placement", guarded(async (c) => { if (!isGtm(c.get("actor"))) throw new RuleError("Placement results are GTM Engineering's to record."); const b = await body(c); return recordPlacement(db, { domain: String(b.domain ?? ""), inbox_rate: Number(b.inbox_rate), tool: String(b.tool ?? "manual"), tested_at: String(b.tested_at ?? new Date().toISOString()) }); }));
  app.get("/api/motion/learning", async (c) => c.json({ table: await learningTable(db), proposals: await db.query("SELECT id, kind, subject, evidence, edit, status FROM learning_proposals ORDER BY created_at DESC") }));
  app.post("/api/motion/learning/:pid", guarded(async (c) => { if (!isGtm(c.get("actor"))) throw new RuleError("Suggestions to the ICP are GTM Engineering's to decide."); return decideProposal(db, c.req.param("pid"), c.get("actor"), (await body(c)).status); }));

  /* A tool's webhook. The connector proves the call came from the tool. The answer goes back at once and the work follows, so a slow pass never makes the tool give up on the hook. */
  app.post("/hooks/sequencer/:name", async (c) => {
    const conn = deps.connectors[c.req.param("name")];
    if (!conn) return c.text("Unknown tool", 404);
    const parsed = await c.req.json().catch(() => null);
    const events = conn.verifyWebhook({ headers: Object.fromEntries(c.req.raw.headers), query: c.req.query() as Record<string, string>, body: parsed });
    if (events === null) return c.text("Not from this tool", 401);
    void (async () => { await ingestEvents(db, deps, conn, events); await processInbound(db, deps); })().catch((e) => console.error("sequencer hook", e));
    return c.json({ received: events.length });
  });

  /* The booking system's webhook, behind a shared secret. Absent, the route answers 404. */
  app.post("/hooks/calendar", async (c) => {
    const secret = process.env.CALENDAR_WEBHOOK_SECRET;
    if (!secret) return c.text("Not set up", 404);
    if (c.req.header("x-desk-secret") !== secret) return c.text("Bad secret", 401);
    const b = await c.req.json().catch(() => null) as { events?: CalendarEvent[] } | null;
    return c.json(await ingestCalendar(db, deps, b?.events ?? []));
  });
}
