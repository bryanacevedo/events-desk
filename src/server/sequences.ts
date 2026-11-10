/* Sequences on any tool (docs/LIFECYCLE.md, section 5). The desk owns the rules and a Connector is a plug. Every call to a tool is driven from a row written first, so a crash at any step replays to the same result. */

import { BOUNCE_MIN_SENDS, BOUNCE_PAUSE_RATE, DEFAULT_LATE_STAGES, MINUTE, REGATE_AFTER_MINUTES } from "../shared/policy.ts";
import { createHash } from "node:crypto";
import type { Db } from "./db.ts";
import { CrmDown, askPeople, crmConnected, preSendCheck } from "./crm-checks.ts";
import type { AddContact, Connector, SequenceState } from "./connectors/types.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { openLifecycleCase } from "./lifecycle-cases.ts";
import { OWED_REMOVE_SQL, RETURNABLE_CAUSES, sendingStopped, stopContacts, stopDomain } from "./enroll-ops.ts";
import { runGate } from "./gate.ts";
import { DESK, nowOf, type LifecycleDeps } from "./lifecycle-deps.ts";
import { moveMotion } from "./motion-state.ts";
import { LAST_DAY_SQL } from "./motion.ts";
import { openOwnerDecisions } from "./owners.ts";
import { addTouch } from "./touches.ts";
import { cleanNames, lintTemplate, type TemplateStep } from "../shared/template-check.ts";
import { applySendSettings, launchAllowed, planSenders, settingsConfirmed } from "./sending.ts";
import { isGtm } from "../shared/roles.ts";
import { addDays, localDay, zoneGroupOf, type Channel, type ZoneGroup } from "../shared/motion.ts";
import { eventDays, eventWindow, POST_START_LATEST_DAYS, POST_TEMPLATE_MAX_DAYS, POST_WAVE_END_DAYS, postGroups, SEQUENCED_GROUPS } from "./post-event.ts";

const ACCOUNT_DAILY = 2;
/** A share of accounts nobody contacts, always the same ones, so the scorecard has something to compare against. */
export const heldOut = (domain: string, percent: number) => percent > 0 && parseInt(createHash("sha256").update(domain).digest("hex").slice(0, 8), 16) % 100 < percent;
/** Stricter on cold outreach. Counsel confirms before anyone records a basis. Legal risk: high. */
export const STRICT_REGIONS = ["germany", "canada"];

interface SeqRow { id: string; event_id: string; connector: string; channel: Channel; priority: string; phase: "pre" | "post"; zone_group: ZoneGroup; template_id: string; external_id: string | null; name: string; state: SequenceState; launched_at: string | null; pause_owed: boolean; settings_ok: boolean | null; checklist_at: string | null }
interface Person { followup_tier?: string | null; location: string | null; country: string | null; id: string; priority: string; full_name: string | null; title: string | null; email: string | null; linkedin: string | null; company: string; domain: string; verify_1: string | null; person_id: string | null }

const toolFor = (deps: LifecycleDeps, name: string): Connector => {
  const c = deps.connectors[name];
  if (!c) throw new RuleError(`The ${name} connector is not set up here.`);
  return c;
};

/** Which tool runs each channel on this event. */
export async function setTools(db: Db, eventId: string, actor: string, tools: Partial<Record<Channel, string>>, deps: LifecycleDeps) {
  for (const [channel, name] of Object.entries(tools)) {
    if (!name) continue;
    const c = toolFor(deps, name);
    if (!c.channels.includes(channel as Channel)) throw new RuleError(`${name} does not run ${channel}.`);
    if (!c.capabilities.reportsStops) throw new RuleError(`${name} does not tell the desk about replies or opt-outs, so nobody could be stopped when they answer. It cannot be used for sending.`);
  }
  await db.tx(async (q) => {
    await q("UPDATE events SET tools = $2::jsonb WHERE id = $1", [eventId, JSON.stringify(tools)]);
    await logActivity(q, eventId, actor, "motion", `Connected ${Object.entries(tools).map(([c, t]) => `${t} for ${c}`).join(" and ")}`);
  });
}

export async function recordLegalBasis(db: Db, eventId: string, actor: string, region: string, basis: string) {
  if (!basis.trim()) throw new RuleError("Say what the basis is.");
  if (STRICT_REGIONS.includes(region.trim().toLowerCase()) && !isGtm(actor)) throw new RuleError(`${region} has stricter rules on cold outreach. GTM Engineering records this one, after counsel has confirmed it.`);
  await db.tx(async (q) => {
    await q("INSERT INTO legal_bases (event_id, region, basis, recorded_by) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id, region) DO UPDATE SET basis = EXCLUDED.basis, recorded_by = EXCLUDED.recorded_by, recorded_at = now()", [eventId, region.trim().toLowerCase(), basis.trim().slice(0, 500), actor]);
    await logActivity(q, eventId, actor, "legal_basis", `Recorded the basis for contacting people in ${region}`);
  });
}

export async function approveTemplate(db: Db, actor: string, t: { name: string; channel: Channel; phase: "pre" | "post"; steps: TemplateStep[]; external_id?: string | null; audience?: string }) {
  const lint = lintTemplate(t.channel, t.steps as TemplateStep[]);
  if (lint.errors.length) throw new RuleError(lint.errors.join(" "));
  // The follow-up has to finish while the event is still fresh, and before its sequences end.
  if (t.phase === "post" && t.steps.length && t.steps[t.steps.length - 1].day - t.steps[0].day > POST_TEMPLATE_MAX_DAYS)
    throw new RuleError(`A post-event template's last step comes at most ${POST_TEMPLATE_MAX_DAYS} days after its first.`);
  return db.tx(async (q) => {
    const [{ v }] = await q<{ v: number }>("SELECT coalesce(max(version), 0)::int AS v FROM sequence_templates WHERE name = $1", [t.name]);
    const audience = t.audience ?? "all";
    await q("UPDATE sequence_templates SET retired_at = now() WHERE channel = $1 AND phase = $2 AND audience = $3 AND retired_at IS NULL", [t.channel, t.phase, audience]);
    const id = newId("tpl");
    await q("INSERT INTO sequence_templates (id, name, version, channel, phase, steps, external_id, approved_by, audience) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)", [id, t.name, v + 1, t.channel, t.phase, JSON.stringify(t.steps), t.external_id ?? null, actor, audience]);
    return { id, version: v + 1 };
  });
}

async function ensureSequence(db: Db, deps: LifecycleDeps, eventId: string, eventName: string, channel: Channel, priority: string, phase: "pre" | "post", zone: ZoneGroup, tool: string): Promise<SeqRow> {
  const c = toolFor(deps, tool);
  const [existing] = await db.query<SeqRow>("SELECT * FROM sequences WHERE event_id = $1 AND channel = $2 AND priority = $3 AND phase = $4 AND zone_group = $5", [eventId, channel, priority, phase, zone]);
  let row = existing;
  if (!row) {
    // A template written for this audience wins over the general one.
    const [tpl] = await db.query<{ id: string; external_id: string | null; name: string }>("SELECT id, external_id, name FROM sequence_templates WHERE channel = $1 AND phase = $2 AND retired_at IS NULL AND audience IN ($3, 'all') ORDER BY (audience = $3) DESC, approved_at DESC LIMIT 1", [channel, phase, priority]);
    if (!tpl) throw new RuleError(`Approve a ${phase === "pre" ? "pre-event" : "post-event"} ${channel} template in Settings first.`);
    const id = newId("seq");
    [row] = await db.query<SeqRow>("INSERT INTO sequences (id, event_id, connector, channel, priority, phase, zone_group, template_id, name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (event_id, channel, priority, phase, zone_group) DO UPDATE SET name = sequences.name RETURNING *",
      [id, eventId, tool, channel, priority, phase, zone, tpl.id, `${eventName} ${priority.replace(/_/g, " ")} ${channel} ${phase === "pre" ? "pre-event" : "post-event"}${zone === "event" ? "" : ` ${zone}`} ${id.slice(-6)}`]);
  }
  // A tool that cannot make campaigns waits for a person to give this sequence one of its own.
  if (!row.external_id && c.capabilities.createsSequences) {
    // The name carries our id, so a crash after the tool made it finds the same one.
    const [tpl] = await db.query<{ external_id: string | null }>("SELECT external_id FROM sequence_templates WHERE id = $1", [row.template_id]);
    const seen = (await c.listTemplates()).find((t) => t.name === row.name);
    const ext = seen?.id ?? await c.createSequence(row.name, tpl.external_id ?? "", []);
    [row] = await db.query<SeqRow>("UPDATE sequences SET external_id = $2 WHERE id = $1 RETURNING *", [row.id, ext]);
  }
  return row;
}

/** One button: makes the draft sequences per priority and channel and adds everyone not yet added who passes the gate. Pressing again adds only new people, after owner say for any new account. */
export async function createDrafts(db: Db, deps: LifecycleDeps, eventId: string, actor: string) {
  const [e] = await db.query<{ motion: string; name: string; starts_on: string; country: string | null; tools: Partial<Record<Channel, string>>; holdout_percent: number }>("SELECT motion, name, starts_on::text AS starts_on, country, tools, holdout_percent FROM events WHERE id = $1", [eventId]);
  if (!e) throw new RuleError("That event does not exist.");
  if (!["sequencing", "in_market"].includes(e.motion)) throw new RuleError("Sequences are set up once the account owners have had their say.");
  const channels = (Object.keys(e.tools) as Channel[]).filter((c) => e.tools[c]);
  if (!channels.length) throw new RuleError("Connect a sequencer for this event first.");
  if (crmConnected(deps.crm)) await openOwnerDecisions(db, deps, eventId);
  // Before the event, its pre-event copy. While it is on, nothing new starts. After it, the post-event wave, until the window closes.
  const days = await eventDays(db.query, eventId);
  const window = eventWindow(localDay(nowOf(deps), e.country), days.first_day, days.last_day);
  if (window === "during") throw new RuleError(`${e.name} is on. The follow-up starts the day after its last day, ${days.last_day}.`);
  if (window === "closed") throw new RuleError(`The follow-up for ${e.name} could start until ${addDays(days.last_day, POST_START_LATEST_DAYS)}. That window has closed.`);
  const phase = window === "before" ? "pre" : "post";
  const groups = phase === "post" ? await postGroups(db.query, eventId) : null;
  const people = (await db.query<Person>(
    `SELECT k.id, k.priority, k.full_name, k.title, k.email, k.linkedin, co.name AS company, co.primary_domain AS domain, k.verify_1, k.person_id, k.person_location AS location, co.firmo->>'country' AS country, k.followup_tier
     FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.event_id = $1 AND k.dropped_at IS NULL AND (k.priority IS NOT NULL OR ($2 AND k.followup_tier = 'scanned')) AND co.primary_domain IS NOT NULL ORDER BY k.id`, [eventId, phase === "post"]))
    // After the event, what happened there decides the sequence: each person goes by their group, and the groups a rep has are not sequenced.
    .flatMap((p) => { if (!groups) return [p]; const g = groups.get(p.id); return g && SEQUENCED_GROUPS.includes(g) ? [{ ...p, priority: g }] : []; });
  const summary = { added: 0, refused: {} as Record<string, number> };
  for (const channel of channels) {
    const tool = e.tools[channel]!;
    const reachable = people.filter((p) => (channel === "email" ? p.email && p.verify_1 : p.linkedin));
    const zoneOfPerson = (p: Person) => zoneGroupOf(p.location) === "event" ? zoneGroupOf(p.country) : zoneGroupOf(p.location);
    for (const [priority, zone] of [...new Set(reachable.map((p) => `${p.priority}|${zoneOfPerson(p)}`))].sort().map((k) => k.split("|") as [string, ZoneGroup])) {
      // Already in, or taken out for a reason that holds (a no, an opt-out, a bounce, a gate refusal): either way, not added again by this press.
      const inIt = new Set((await db.query<{ contact_id: string }>("SELECT contact_id FROM enrollments WHERE contact_id = ANY($1::text[]) AND event_id = $2 AND channel = $3 AND (state <> 'removed' OR NOT (coalesce(cause, '') = ANY($4::text[])))", [reachable.map((p) => p.id), eventId, channel, RETURNABLE_CAUSES])).map((r) => r.contact_id));
      const fresh = reachable.filter((p) => p.priority === priority && zoneOfPerson(p) === zone && !inIt.has(p.id) && !heldOut(p.domain, e.holdout_percent));
      const results = await runGate(db, deps, eventId, fresh.map((p) => p.id), channel, "add");
      for (const r of results) if (!r.passed) summary.refused[r.reason!] = (summary.refused[r.reason!] ?? 0) + 1;
      // A sequence nobody can go into is not made.
      if (!results.some((r) => r.passed)) continue;
      const seq = await ensureSequence(db, deps, eventId, e.name, channel, priority, phase, zone, tool);
      const perDomain = new Map<string, number>();
      await db.tx(async (q) => {
        for (const r of results) {
          const p = fresh.find((x) => x.id === r.contact_id)!;
          if (r.passed) {
            // Two people a day at any one company, so a whole account is not hit at once.
            const nth = perDomain.get(p.domain) ?? 0; perDomain.set(p.domain, nth + 1);
            const later = Math.floor(nth / ACCOUNT_DAILY) ? new Date(nowOf(deps).getTime() + Math.floor(nth / ACCOUNT_DAILY) * 86_400_000).toISOString() : null;
            const [{ person_id }] = await q<{ person_id: string | null }>("SELECT person_id FROM contacts WHERE id = $1", [p.id]);
            await q(`INSERT INTO enrollments (id, event_id, contact_id, person_id, domain, sequence_id, channel, state, pending_op, retry_after) VALUES ($1, $2, $3, $4, $5, $6, $7, 'adding', 'add', $8)
                     ON CONFLICT (sequence_id, contact_id) DO UPDATE SET state = 'adding', pending_op = 'add', cause = NULL, cause_id = NULL, retry_after = EXCLUDED.retry_after, changed_at = now()`,
              [newId("enr"), eventId, p.id, person_id, p.domain, seq.id, channel, later]);
            summary.added++;
          }
        }
        await logActivity(q, eventId, actor, "sequence", `Set up ${seq.name}: ${results.filter((r) => r.passed).length} added, ${results.filter((r) => !r.passed).length} held back`);
      });
    }
  }
  if (phase === "post") await db.query("UPDATE events SET post_started_at = coalesce(post_started_at, $2), post_started_by = coalesce(post_started_by, $3) WHERE id = $1", [eventId, nowOf(deps).toISOString(), actor]);
  await drainOps(db, deps, eventId);
  // Who is in each sequence is settled now, so its size, and the senders it needs, are too.
  for (const s of await db.query<{ id: string }>("SELECT id FROM sequences WHERE event_id = $1 AND state <> 'archived'", [eventId])) { await planSenders(db, deps, s.id, actor); await applySendSettings(db, deps, s.id); }
  return summary;
}

const namesOf = cleanNames;

/** Carries out what the rows say is owed to the tools. A tool that fails leaves the row owed, and a later sweep finishes it. */
export async function drainOps(db: Db, deps: LifecycleDeps, eventId: string | null = null) {
  const now = nowOf(deps);
  const rows = await db.query<{ id: string; event_id: string; contact_id: string; sequence_id: string; channel: Channel; external_contact_id: string | null; pending_op: "add" | "pause" | "resume" | "remove"; state: string; connector: string; ext: string | null; seq_state: SequenceState; released_by: string | null; in_tool: number; added_at: string }>(
    `SELECT n.id, n.event_id, n.contact_id, n.sequence_id, n.channel, n.external_contact_id, n.pending_op, n.state, n.added_at::text AS added_at, s.connector, s.external_id AS ext, s.state AS seq_state, s.released_by,
            (SELECT count(*)::int FROM enrollments x WHERE x.sequence_id = s.id AND x.external_contact_id IS NOT NULL) AS in_tool
     FROM enrollments n JOIN sequences s ON s.id = n.sequence_id WHERE n.pending_op IS NOT NULL AND ($1::text IS NULL OR n.event_id = $1) AND (n.retry_after IS NULL OR n.retry_after <= $2::timestamptz)
     ORDER BY CASE n.pending_op WHEN 'remove' THEN 0 WHEN 'pause' THEN 1 ELSE 2 END, n.id`, [eventId, now.toISOString()]);
  const out = { done: 0, failed: 0 };
  const adds = new Map<string, typeof rows>();
  const stopped = await sendingStopped(db.query);
  for (const r of rows) {
    const c = deps.connectors[r.connector];
    if (!c) { out.failed++; continue; }
    // No campaign yet: the tool waits for a person to name one.
    if (!r.ext) continue;
    if ((r.pending_op === "remove" || r.pending_op === "pause") && !r.external_contact_id) {
      // An add whose answer was lost: the tool may hold the person. Adding is safe to repeat and gives back their id, so they can be taken out.
      try {
        const [p] = await db.query<Person>("SELECT k.id, k.priority, k.full_name, k.title, k.email, k.linkedin, co.name AS company, co.primary_domain AS domain, k.verify_1, k.person_id FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.id = $1", [r.contact_id]);
        const base = { ref: p.id, email: p.email, linkedin: p.linkedin, ...namesOf(p.full_name), company: p.company, title: p.title, crm_id: null };
        const [found] = await c.addContacts(r.ext, [{ ...base, external_id: await c.ensureContact(base) }]);
        if (found?.external_id) { await c.removeContact(r.ext, found.external_id); await db.query("UPDATE enrollments SET pending_op = NULL, external_contact_id = $2 WHERE id = $1 AND pending_op = $3", [r.id, found.external_id, r.pending_op]); out.done++; }
      } catch (e) { out.failed++; console.error("sequence op", r.pending_op, r.id, (e as Error).message); }
      continue;
    }
    // The one switch: stops still go out, adds and resumes wait.
    if (stopped && (r.pending_op === "add" || r.pending_op === "resume")) continue;
    if (r.pending_op === "resume" && c.capabilities.pause === "remove-only" && r.external_contact_id) {
      // Adding someone back to a tool that cannot hold them would restart them at step 1. Once anything has gone out, they stop for good.
      // Not every tool reports its sends, so being in a launched campaign counts as sent.
      const [sent] = await db.query("SELECT 1 FROM touches WHERE contact_id = $1 AND event_id = $2 AND kind = 'send' AND channel = $3 UNION ALL SELECT 1 FROM sequences WHERE id = $4 AND launched_at IS NOT NULL LIMIT 1", [r.contact_id, r.event_id, r.channel, r.sequence_id]);
      if (sent) { await db.query("UPDATE enrollments SET state = 'removed', pending_op = NULL, cause = 'cannot_resume_mid_sequence', changed_at = now() WHERE id = $1", [r.id]); continue; }
    }
    if (r.pending_op === "add" || (r.pending_op === "resume" && (c.capabilities.pause === "remove-only" || !r.external_contact_id))) { adds.set(r.sequence_id, [...(adds.get(r.sequence_id) ?? []), r]); continue; }
    try {
      if (r.pending_op === "remove" || (r.pending_op === "pause" && !c.pauseContact)) await c.removeContact(r.ext!, r.external_contact_id!);
      else if (r.pending_op === "pause") await c.pauseContact!(r.ext!, r.external_contact_id!);
      else await c.resumeContact!(r.ext!, r.external_contact_id!);
      // A later stop may have changed what is owed while the call ran: only the op that was carried out is cleared.
      await db.tx(async (q) => {
        const nextState = r.pending_op === "resume" ? "enrolled" : null;
        await q("UPDATE enrollments SET pending_op = NULL, state = coalesce($3, state), changed_at = now() WHERE id = $1 AND pending_op = $2", [r.id, r.pending_op, nextState]);
        if (r.pending_op === "pause" && c.capabilities.pause === "remove-only") await addTouch(q, { domain: null, contact_id: r.contact_id, event_id: r.event_id, kind: "removed_to_pause", channel: r.channel, reason: `${c.name} cannot pause one person, so they were taken out and will be added back`, source: DESK, dedup_key: `rtp:${r.id}:${now.getTime()}` });
      });
      out.done++;
    } catch (e) { out.failed++; console.error("sequence op", r.pending_op, r.id, (e as Error).message); }
  }
  for (const [sequenceId, all] of adds) {
    const c = deps.connectors[all[0].connector];
    const ext = all[0].ext!;
    if (!c.capabilities.addsWhileDraft && all[0].seq_state !== "active") continue;
    // A real tool's first send is small and watched. The rest wait until a person has looked and released them.
    const room = !c.simulated && deps.firstCohort && !all[0].released_by ? Math.max(0, deps.firstCohort - all[0].in_tool) : all.length;
    let group = all.slice(0, room);
    if (!group.length) continue;
    // Anyone who waited (the two-a-day spread, a first-cohort release) is checked again: things change while people wait.
    const stale = group.filter((g) => g.pending_op === "add" && now.getTime() - Date.parse(g.added_at) > REGATE_AFTER_MINUTES * MINUTE);
    if (stale.length) {
      let res;
      try { res = await runGate(db, deps, stale[0].event_id, stale.map((g) => g.contact_id), stale[0].channel, "add"); }
      catch (e) { if (e instanceof CrmDown) continue; throw e; }
      const failed = new Set(res.filter((x) => !x.passed).map((x) => x.contact_id));
      for (const x of res.filter((x) => !x.passed)) await db.query(`UPDATE enrollments SET state = 'removed', pending_op = ${OWED_REMOVE_SQL}, cause = $2, changed_at = now() WHERE id = $1`, [stale.find((g) => g.contact_id === x.contact_id)!.id, `gate:${x.reason}`]);
      group = group.filter((g) => !failed.has(g.contact_id));
      if (!group.length) continue;
    }
    try {
      const people = await db.query<Person & { contact_id: string }>("SELECT k.id, k.priority, k.full_name, k.title, k.email, k.linkedin, co.name AS company, co.primary_domain AS domain, k.verify_1, k.person_id FROM contacts k JOIN companies co ON co.id = k.company_id WHERE k.id = ANY($1::text[])", [group.map((g) => g.contact_id)]);
      const crmIds = new Map<string, string>();
      if (c.capabilities.needsCrmRecord && crmConnected(deps.crm)) {
        const got = await askPeople(deps.crm, people.map((p) => ({ ref: p.id, email: p.email, full_name: p.full_name, company: p.company, domain: p.domain })));
        for (const [ref, recs] of Object.entries(got)) if (recs[0]) crmIds.set(ref, recs[0].id);
      }
      const toSend: AddContact[] = [];
      for (const p of people) {
        const base = { ref: p.id, email: p.email, linkedin: p.linkedin, ...namesOf(p.full_name), company: p.company, title: p.title, crm_id: crmIds.get(p.id) ?? null };
        if (c.capabilities.needsCrmRecord && !base.crm_id) {
          await db.query("UPDATE enrollments SET state = 'removed', pending_op = NULL, cause = 'no_crm_record', changed_at = now() WHERE sequence_id = $1 AND contact_id = $2", [sequenceId, p.id]);
          continue;
        }
        toSend.push({ ...base, external_id: await c.ensureContact(base) });
      }
      if (!toSend.length) continue;
      // Written before the call: if the answer is lost, a later stop still reaches the tool.
      await db.query("UPDATE enrollments SET add_attempted = true WHERE id = ANY($1::text[])", [group.filter((g) => toSend.some((t) => t.ref === g.contact_id)).map((g) => g.id)]);
      const results = await c.addContacts(ext, toSend);
      await db.tx(async (q) => {
        for (const r of results) {
          const row = group.find((g) => g.contact_id === r.ref)!;
          if (r.ok) {
            // A stop that landed while the add was in flight is still owed: the person is in the tool now.
            await q(`UPDATE enrollments SET state = CASE WHEN pending_op IN ('add', 'resume') THEN 'enrolled' ELSE state END,
                       pending_op = CASE WHEN pending_op IN ('add', 'resume') THEN NULL WHEN pending_op IS NULL AND state = 'removed' THEN 'remove' WHEN pending_op IS NULL AND state = 'paused' THEN 'pause' ELSE pending_op END,
                       external_contact_id = $2, retry_after = NULL, changed_at = now() WHERE id = $1`, [row.id, r.external_id]);
            const p = people.find((x) => x.id === r.ref)!;
            await addTouch(q, { domain: p.domain, person_id: p.person_id, contact_id: p.id, event_id: row.event_id, kind: "sequence_add", channel: row.channel, source: DESK, dedup_key: `add:${row.id}:${row.pending_op === "add" ? "first" : now.getTime()}` });
          } else await q("UPDATE enrollments SET cause = $2, retry_after = $3 WHERE id = $1", [row.id, r.reason ?? "tool_refused", new Date(now.getTime() + (r.retry_after_minutes ?? 60) * 60_000).toISOString()]);
        }
      });
      out.done += results.filter((r) => r.ok).length; out.failed += results.filter((r) => !r.ok).length;
    } catch (e) { out.failed += group.length; console.error("sequence add", sequenceId, (e as Error).message); }
  }
  return out;
}

/** A pause counts only when the tool has confirmed it. Until then the sequence is marked owed, retried on every pass, and it alerts. */
async function pauseWhole(db: Db, c: Connector, s: SeqRow, reason: string, actor = DESK) {
  let confirmed = true;
  try { await c.pauseSequence(s.external_id!); } catch (e) { confirmed = false; console.error("sequence pause", s.id, (e as Error).message); }
  await db.tx(async (q) => {
    await q("UPDATE sequences SET state = CASE WHEN $3 THEN 'paused' ELSE state END, pause_owed = NOT $3, pause_reason = $2 WHERE id = $1", [s.id, reason, confirmed]);
    await logActivity(q, s.event_id, actor, "sequence", confirmed ? `Paused ${s.name}: ${reason}` : `Could NOT pause ${s.name} in ${c.name}, so it may still be sending. Retrying. Why it was stopped: ${reason}`);
  });
  return confirmed;
}

/** Ends a sequence for good: everyone in it comes out, and the tool stops it. */
async function endSequence(db: Db, c: Connector, s: SeqRow, cause: string) {
  await pauseWhole(db, c, s, cause);
  await db.tx(async (q) => {
    // Only people who were simply in the sequence take the calendar's reason. Anyone already paused keeps theirs: a meeting, a reply or a booth conversation must not
    // become "the event started", which lets a person be added again after the event. An out-of-office was only ever temporary, so it takes the calendar's reason.
    await q(`UPDATE enrollments SET state = 'removed', pending_op = ${OWED_REMOVE_SQL}, cause = CASE WHEN cause IS NULL OR cause = 'out_of_office' THEN $2 ELSE cause END, changed_at = now() WHERE sequence_id = $1 AND state <> 'removed'`, [s.id, cause]);
    await q("UPDATE sequences SET state = 'archived' WHERE id = $1 AND NOT pause_owed", [s.id]);
  });
}

/** What the calendar ends. Pre-event copy stops on the event's first day, or at closing if it is somehow still out. The post-event wave ends 24 days after the last day, so one started on the last allowed day finishes, and at scoring at the latest. */
export async function calendarSweep(db: Db, deps: LifecycleDeps) {
  const now = nowOf(deps);
  const rows = await db.query<SeqRow & { first_day: string; last_day: string; country: string | null; motion: string }>(`SELECT s.*, e.starts_on::text AS first_day, ${LAST_DAY_SQL}::text AS last_day, e.country, e.motion FROM sequences s JOIN events e ON e.id = s.event_id WHERE s.state <> 'archived'`);
  let ended = 0;
  for (const s of rows) {
    const c = deps.connectors[s.connector];
    if (!c) continue;
    const today = localDay(now, s.country);
    // A draft that never got a campaign in the tool has nothing to stop there: it just ends here, when its time comes.
    if (!s.external_id) {
      const due = s.phase === "pre" ? today >= s.first_day || ["closing", "scored"].includes(s.motion) : s.motion === "scored" || today >= addDays(s.last_day, POST_WAVE_END_DAYS);
      if (due) await db.tx(async (q) => {
        await q(`UPDATE enrollments SET state = 'removed', pending_op = NULL, cause = CASE WHEN cause IS NULL OR cause = 'out_of_office' THEN $2 ELSE cause END, changed_at = now() WHERE sequence_id = $1 AND state <> 'removed' AND external_contact_id IS NULL AND NOT add_attempted`, [s.id, s.phase === "pre" && today >= s.first_day ? "event_started" : "event_closed"]);
        await q("UPDATE sequences SET state = 'archived' WHERE id = $1", [s.id]);
      });
      continue;
    }
    if (s.phase === "pre" && today >= s.first_day) { await endSequence(db, c, s, "event_started"); ended++; }
    else if (s.phase === "pre" && ["closing", "scored"].includes(s.motion)) { await endSequence(db, c, s, "event_closed"); ended++; }
    else if (s.phase === "post" && (s.motion === "scored" || today >= addDays(s.last_day, POST_WAVE_END_DAYS))) { await endSequence(db, c, s, "event_closed"); ended++; }
  }
  if (ended) await drainOps(db, deps);
  return { ended };
}

/** After looking at the first cohort, a person lets the rest go. */
export async function releaseSequence(db: Db, deps: LifecycleDeps, sequenceId: string, actor: string) {
  const rows = await db.query<{ event_id: string; name: string }>("UPDATE sequences SET released_by = $2 WHERE id = $1 AND released_by IS NULL RETURNING event_id, name", [sequenceId, actor]);
  if (!rows.length) throw new RuleError("That sequence is already released.");
  await logActivity(db.query, rows[0].event_id, actor, "sequence", `Released the rest of ${rows[0].name} after the first cohort`);
  await drainOps(db, deps, rows[0].event_id);
}

/** A person gives a sequence the campaign it runs on, in a tool that cannot make one. One campaign, one sequence. */
export async function attachCampaign(db: Db, deps: LifecycleDeps, sequenceId: string, externalId: string, actor: string) {
  const [s] = await db.query<SeqRow>("SELECT * FROM sequences WHERE id = $1", [sequenceId]);
  if (!s) throw new RuleError("That sequence does not exist.");
  const [taken] = await db.query("SELECT 1 FROM sequences WHERE connector = $1 AND external_id = $2 AND id <> $3", [s.connector, externalId, sequenceId]);
  if (taken) throw new RuleError("That campaign already belongs to another sequence. Each sequence needs its own, so pausing one never pauses another.");
  await db.tx(async (q) => { await q("UPDATE sequences SET external_id = $2 WHERE id = $1", [sequenceId, externalId]); await logActivity(q, s.event_id, actor, "sequence", `Connected ${s.name} to its campaign in ${s.connector}`); });
  await planSenders(db, deps, sequenceId, actor);
  await drainOps(db, deps, s.event_id);
}

/** What a person confirms at launch that the desk cannot check itself: DKIM, one-click unsubscribe, and any setting the tool will not take through its API. */
export async function confirmLaunchChecklist(db: Db, sequenceId: string, actor: string) {
  const rows = await db.query<{ event_id: string; name: string }>("UPDATE sequences SET checklist_by = $2, checklist_at = now() WHERE id = $1 RETURNING event_id, name", [sequenceId, actor]);
  if (!rows.length) throw new RuleError("That sequence does not exist.");
  await logActivity(db.query, rows[0].event_id, actor, "sequence", `Confirmed the launch checklist for ${rows[0].name}`);
}

/** The switch that stops every send and resume, and pauses everything running. */
export async function stopAllSending(db: Db, deps: LifecycleDeps, actor: string, reason: string) {
  if (!isGtm(actor)) throw new RuleError("Only GTM Engineering can stop all sending.");
  await db.query("UPDATE desk_controls SET sending_stopped_at = now(), stopped_by = $1, reason = $2", [actor, reason]);
  for (const s of await db.query<SeqRow>("SELECT * FROM sequences WHERE state = 'active' AND external_id IS NOT NULL")) { const c = deps.connectors[s.connector]; if (c) await pauseWhole(db, c, s, `All sending stopped by ${actor}: ${reason}`, actor); }
}
export async function restartSending(db: Db, actor: string) {
  if (!isGtm(actor)) throw new RuleError("Only GTM Engineering can restart sending.");
  await db.query("UPDATE desk_controls SET sending_stopped_at = NULL, stopped_by = NULL, reason = NULL");
}

/** Watches each sequence's real state. Going live, or coming back from a pause, re-runs the gate and takes out anyone who now fails. */
export async function observeSequences(db: Db, deps: LifecycleDeps) {
  const now = nowOf(deps);
  const seqs = await db.query<SeqRow>("SELECT * FROM sequences WHERE state <> 'archived' AND external_id IS NOT NULL");
  for (const s of seqs) {
    const c = deps.connectors[s.connector];
    if (!c) continue;
    if (s.pause_owed) { await pauseWhole(db, c, s, "Retrying a pause the tool had not confirmed."); continue; }
    const stopped = await sendingStopped(db.query);
    let real: SequenceState;
    try { real = c.capabilities.observesLaunch ? await c.sequenceState(s.external_id!) : (await db.query("SELECT 1 FROM enrollments WHERE sequence_id = $1 AND state = 'enrolled' LIMIT 1", [s.id])).length ? "active" : "draft"; }
    catch (e) { console.error("sequence state", s.id, (e as Error).message); continue; }
    if (real === s.state) continue;
    if (real === "archived" && s.state !== "archived") {
      // The tool ended it. Its people are out, with that cause, so they are free for the next event.
      await db.tx(async (q) => { await q("UPDATE sequences SET state = 'archived' WHERE id = $1", [s.id]); await q("UPDATE enrollments SET state = 'removed', pending_op = NULL, cause = 'campaign_ended', changed_at = now() WHERE sequence_id = $1 AND state <> 'removed'", [s.id]); });
      continue;
    }
    if (real !== "active") { await db.query("UPDATE sequences SET state = $2 WHERE id = $1", [s.id, real]); continue; }
    if (stopped) { await pauseWhole(db, c, s, "All sending is stopped, so a campaign started in the tool was paused again."); continue; }
    // Not enough healthy senders: it does not run, whatever the tool was told.
    if (!(await launchAllowed(db, s.id))) { await pauseWhole(db, c, s, "There are not enough healthy senders for this sequence."); continue; }
    if (!(await settingsConfirmed(db, deps, c, s))) { await pauseWhole(db, c, s, "Its send window, tracking or stop-on-reply are not what the desk set, or the launch checklist is not confirmed."); continue; }
    // It went live, or came back. Nobody keeps going on an old answer.
    const open = await db.query<{ contact_id: string }>("SELECT contact_id FROM enrollments WHERE sequence_id = $1 AND state IN ('adding', 'enrolled')", [s.id]);
    let results;
    try { results = await runGate(db, deps, s.event_id, open.map((o) => o.contact_id), s.channel, "launch"); }
    catch (e) {
      if (!(e instanceof CrmDown)) throw e;
      await pauseWhole(db, c, s, "The CRM could not answer the checks at launch, so the whole sequence was paused.");
      continue;
    }
    await db.tx(async (q) => {
      await q("UPDATE sequences SET state = 'active', launched_at = coalesce(launched_at, $2), gate_passed_at = $2, pause_reason = NULL WHERE id = $1", [s.id, now.toISOString()]);
      const failed = results.filter((r) => !r.passed);
      for (const r of failed) await q(`UPDATE enrollments SET state = 'removed', pending_op = ${OWED_REMOVE_SQL}, cause = $3, changed_at = now() WHERE sequence_id = $1 AND contact_id = $2 AND state <> 'removed'`, [s.id, r.contact_id, `gate:${r.reason}`]);
      await logActivity(q, s.event_id, DESK, "sequence", `${s.name} is live. ${results.length - failed.length} passed the launch check, ${failed.length} came out.`);
      const [e] = await q<{ motion: string }>("SELECT motion FROM events WHERE id = $1 FOR UPDATE", [s.event_id]);
      if (e.motion === "sequencing") await moveMotion(q, s.event_id, "in_market", DESK, "The first sequence went live");
    });
  }
  await drainOps(db, deps);
}

/** After launch nothing waits for a gate: every 15 minutes the opt-out and CRM flags are read again for everyone active. */
export async function flagSweep(db: Db, deps: LifecycleDeps) {
  const rows = await db.query<{ contact_id: string }>("SELECT DISTINCT contact_id FROM enrollments WHERE state = 'enrolled' OR (state IN ('adding', 'paused') AND pending_op IN ('add', 'resume'))");
  if (!rows.length) return { removed: 0 };
  let checked;
  try { checked = await preSendCheck(db, rows.map((r) => r.contact_id), deps.crm); }
  catch (e) { if (e instanceof CrmDown) return { removed: 0, crm_down: true }; throw e; }
  await db.tx(async (q) => { for (const b of checked.blocked) await stopContacts(q, [b.id], "remove", `flag:${b.reason}`); });
  // A deal that reached a late stage since launch: the account's owner should be talking to them, not a sequence.
  let paused = 0;
  if (crmConnected(deps.crm)) {
    const accounts = await db.query<{ domain: string; company: string; event_id: string; late: string[] | null }>("SELECT DISTINCT ON (n.domain) n.domain, co.name AS company, n.event_id, s.settings->'late_stages' AS late FROM enrollments n JOIN contacts k ON k.id = n.contact_id JOIN companies co ON co.id = k.company_id LEFT JOIN event_settings s ON s.event_id = n.event_id WHERE n.state IN ('enrolled', 'adding') ORDER BY n.domain");
    for (const a of accounts) {
      let info;
      try { info = deps.crm.lookupByDomain ? await deps.crm.lookupByDomain(a.domain, a.company, nowOf(deps).toISOString().slice(0, 10)) : null; } catch { break; }
      const late = Array.isArray(a.late) ? a.late.map((x) => String(x).toLowerCase()) : DEFAULT_LATE_STAGES;
      if (!info?.deal_stage || !late.includes(info.deal_stage.toLowerCase())) continue;
      await db.tx(async (q) => { await stopDomain(q, a.domain, "pause", "new_late_deal", null); await logActivity(q, a.event_id, DESK, "sequence", `${a.company} now has a ${info.deal_stage} deal, so its people were paused for the owner`); });
      paused++;
    }
  }
  if (checked.blocked.length || paused) await drainOps(db, deps);
  return { removed: checked.blocked.length, paused };
}

/** Puts paused people back whose time has come, each through the gate. A failure stays paused, and says why in the gate log. */
/** A sequence that lost its senders stops here, the same way as any other pause. */
export async function pauseSequenceById(db: Db, deps: LifecycleDeps, sequenceId: string, reason: string) {
  const [s] = await db.query<SeqRow>("SELECT * FROM sequences WHERE id = $1", [sequenceId]);
  const c = deps.connectors[s.connector];
  if (c) await pauseWhole(db, c, s, reason);
}

export async function resumeDue(db: Db, deps: LifecycleDeps) {
  const now = nowOf(deps);
  const due = await db.query<{ id: string; event_id: string; contact_id: string; channel: Channel }>("SELECT id, event_id, contact_id, channel FROM enrollments WHERE state = 'paused' AND pending_op IS NULL AND resume_at IS NOT NULL AND resume_at <= $1::timestamptz", [now.toISOString()]);
  let resumed = 0;
  for (const d of due) {
    let r;
    try { [r] = await runGate(db, deps, d.event_id, [d.contact_id], d.channel, "resume"); }
    catch (e) { if (e instanceof CrmDown) continue; throw e; }
    if (r.passed) { await db.query("UPDATE enrollments SET pending_op = 'resume', resume_at = NULL, cause = NULL, cause_id = NULL WHERE id = $1 AND state = 'paused'", [d.id]); resumed++; }
    else await db.query("UPDATE enrollments SET resume_at = $2 WHERE id = $1", [d.id, r.reason?.startsWith("hold:") || r.reason === "reply_waiting" ? null : r.retry_after?.toISOString() ?? null]);
  }
  if (resumed) await drainOps(db, deps);
  return { resumed };
}

/** A person's own decision to put someone back. The gate still has the last word. */
export async function resumePerson(db: Db, deps: LifecycleDeps, eventId: string, contactId: string, actor: string) {
  const rows = await db.query<{ id: string; channel: Channel }>("SELECT id, channel FROM enrollments WHERE event_id = $1 AND contact_id = $2 AND state = 'paused'", [eventId, contactId]);
  if (!rows.length) throw new RuleError("That person is not paused.");
  const refused: string[] = [];
  for (const row of rows) {
    const [r] = await runGate(db, deps, eventId, [contactId], row.channel, "resume");
    if (!r.passed) { refused.push(r.reason!); continue; }
    await db.query("UPDATE enrollments SET pending_op = 'resume', resume_at = NULL, cause = NULL, cause_id = NULL WHERE id = $1", [row.id]);
  }
  await logActivity(db.query, eventId, actor, "sequence", refused.length ? `Could not resume someone: ${refused.join(", ")}` : "Resumed someone");
  await drainOps(db, deps, eventId);
  return { resumed: rows.length - refused.length, refused };
}

/** Pauses a sequence whose bounce rate crossed the line, and opens a case. */
export async function bounceWatch(db: Db, deps: LifecycleDeps, opts: { threshold?: number; minSends?: number } = {}) {
  const threshold = opts.threshold ?? BOUNCE_PAUSE_RATE, minSends = opts.minSends ?? BOUNCE_MIN_SENDS;
  const rows = await db.query<SeqRow & { sends: number; bounces: number }>(
    `SELECT s.*, (SELECT count(DISTINCT t.contact_id) FROM touches t JOIN enrollments n ON n.contact_id = t.contact_id AND n.sequence_id = s.id WHERE t.kind = 'send' AND t.event_id = s.event_id AND t.channel = s.channel)::int AS sends,
            (SELECT count(DISTINCT m.contact_id) FROM inbound_messages m JOIN enrollments n ON n.contact_id = m.contact_id AND n.sequence_id = s.id WHERE m.code = 'bounced' AND m.event_id = s.event_id)::int AS bounces
     FROM sequences s WHERE s.state = 'active' AND s.channel = 'email'`);
  for (const s of rows) {
    if (s.sends < minSends || s.bounces / s.sends <= threshold) continue;
    const c = deps.connectors[s.connector];
    if (!c) continue;
    await pauseWhole(db, c, s, `Bounce rate ${Math.round((s.bounces / s.sends) * 1000) / 10}% is over ${threshold * 100}%.`);
    await db.tx((q) => openLifecycleCase(q, { eventId: s.event_id, kind: "bounce_rate", summary: `${s.name} paused itself: ${s.bounces} of ${s.sends} addresses bounced.`, facts: [{ sequence: s.name, bounced: s.bounces, sent: s.sends }], payload: { sequence_id: s.id } }));
  }
}
