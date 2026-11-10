/* The demo's stand-in for the outside world after delivery: people answering, meetings happening. Each press moves one event forward one step. It runs through every real rule, with the real connector code over a stand-in tool. All rates here are authored, and the screen says simulated. */

import { createHash } from "node:crypto";
import { currentUploader, decideApproval } from "./approvals.ts";
import type { Db } from "./db.ts";
import type { FakeTool } from "./connectors/fake.ts";
import type { ToolEvent } from "./connectors/types.ts";
import { RuleError } from "./events.ts";
import { captureOnsite, drainNotifications } from "./operating.ts";
import { bookMeeting, recordOutcome } from "./meetings.ts";
import { requestMotionCard } from "./motion.ts";
import { openOwnerDecisions, sendOwnerCards, ownerSweep } from "./owners.ts";
import { ingestEvents, processInbound } from "./replies.ts";
import { approveTemplate, attachCampaign, confirmLaunchChecklist, createDrafts, drainOps, observeSequences, recordLegalBasis, setTools } from "./sequences.ts";
import { recordConsent, recordPlacement } from "./sending.ts";
import { recordEventCost, writeScorecards } from "./closeout.ts";
import { moveMotion } from "./motion-state.ts";
import { loadPeople, regionOf } from "./gate.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import type { Crm, CrmOpportunity } from "./providers.ts";
import { postEventState } from "./post-event.ts";

const u = (s: string) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;
const GTM = "GTM Team";
const REP = "Maya Ortiz";

const REPLIES: { share: number; body: string; signal?: ToolEvent["signal"] }[] = [
  { share: 0.12, body: "Sounds good, tell me more about how this works." },
  { share: 0.08, body: "Happy to book a call. Thursday afternoon works for me." },
  { share: 0.06, body: "I am out of office and back on 2027-12-20." },
  { share: 0.06, body: "Not interested, thanks." },
  { share: 0.02, body: "Please remove me from this list." },
  { share: 0.02, body: "", signal: "bounce" },
];

/** Deals appear at some of the accounts that were met. */
export const demoOpportunities = (db: Db, now: () => Date) => async (accounts: { ref: string }[]): Promise<Record<string, CrmOpportunity[]>> => {
  const met = new Set((await db.query<{ domain: string }>("SELECT DISTINCT domain FROM meetings WHERE status = 'held'")).map((m) => m.domain));
  return Object.fromEntries(accounts.map((a) => {
  if (u(`opp|${a.ref}`) > (met.has(a.ref) ? 0.7 : 0.2)) return [a.ref, []];
  const open = u(`old|${a.ref}`) < 0.3, today = now().toISOString();
  return [a.ref, [{ id: `opp_${a.ref}`, stage: "Proposal", amount_cents: Math.round(2_000_000 + u(`amt|${a.ref}`) * 9_000_000), created_date: open ? new Date(now().getTime() - 80 * 86_400_000).toISOString() : today, stage_history: open ? [{ stage: "Proposal", at: today }] : [] } satisfies CrmOpportunity]];
  }));
};

async function ensureSetup(db: Db, deps: LifecycleDeps, tools: Record<string, FakeTool>, eventId: string, actor: string) {
  const [e] = await db.query<{ tools: Record<string, string> }>("SELECT tools FROM events WHERE id = $1", [eventId]);
  if (!e.tools.email) await setTools(db, eventId, actor, { email: "instantly", linkedin: "heyreach" }, deps);
  const have = await db.query<{ channel: string; phase: string }>("SELECT channel, phase FROM sequence_templates WHERE retired_at IS NULL");
  const missing = (c: string, p: string) => !have.some((t) => t.channel === c && t.phase === p);
  const seed = tools.instantly.seqs.get("tpl_email") ? "tpl_email" : tools.instantly.newSeq("tpl_email");
  if (missing("email", "pre")) await approveTemplate(db, GTM, { name: "Before the event", channel: "email", phase: "pre", external_id: seed, steps: [{ day: 0, subject: "{{event}}: worth a quick hello?", body: "Hi {{first_name}}, we will be at {{event}} and {{company}} stood out. Could we meet there?" }, { day: 3, body: "Hi {{first_name}}, a short follow-up in case this got buried." }] });
  if (missing("email", "post")) await approveTemplate(db, GTM, { name: "After the event", channel: "email", phase: "post", external_id: seed, steps: [{ day: 0, subject: "After {{event}}", body: "Hi {{first_name}}, sorry we missed each other at {{event}}. Is this worth ten minutes?" }, { day: 4, body: "Hi {{first_name}}, one last note from me." }] });
  if (missing("linkedin", "pre")) await approveTemplate(db, GTM, { name: "LinkedIn before", channel: "linkedin", phase: "pre", steps: [{ day: 0, body: "Hi {{first_name}}, heading to {{event}} too. Good to connect." }] });
  if (missing("linkedin", "post")) await approveTemplate(db, GTM, { name: "LinkedIn after", channel: "linkedin", phase: "post", steps: [{ day: 0, body: "Hi {{first_name}}, were you at {{event}}? Good to connect." }] });
  const kept = await db.query<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND priority IS NOT NULL", [eventId]);
  for (const region of new Set((await loadPeople(db, eventId, kept.map((k) => k.id))).map(regionOf))) await recordLegalBasis(db, eventId, GTM, region, "Legitimate interest, with a person's sign-off (sample)");
  for (const s of await tools.heyreach.connector.listSenders!()) await recordConsent(db, "heyreach", s.id, "Sample rep", GTM);
  await db.query("INSERT INTO verification_cache (email, verdict, verifier, checked_at) SELECT lower(email), 'deliverable', 'demo', now() FROM contacts WHERE event_id = $1 AND email IS NOT NULL AND verify_1 = 'deliverable' ON CONFLICT (email) DO UPDATE SET checked_at = now()", [eventId]);
  for (const d of ["orrery-mail.example", "orrery-send.example", "tryorrery.example", "getorrery.example", "orreryhq.example", "meetorrery.example"]) for (const provider of ["google", "microsoft"]) await recordPlacement(db, { domain: d, provider, inbox_rate: 0.86 + u(`${d}${provider}`) * 0.12, tool: "sample", tested_at: new Date().toISOString() });
}

/** Moves the event one step. Says what it did. */
/** One step of the demo. `opts.pressFollowUp` lets the demo's own seeding press Start the follow-up; a visitor presses it themselves, because that is a person's call. */
export async function demoAdvance(db: Db, deps: LifecycleDeps, tools: Record<string, FakeTool>, eventId: string, opts: { pressFollowUp?: boolean } = {}): Promise<{ did: string }> {
  const [e] = await db.query<{ motion: string; stage: string }>("SELECT motion, stage FROM events WHERE id = $1", [eventId]);
  if (!e) throw new RuleError("That event does not exist.");
  if (e.stage !== "delivered") throw new RuleError("The list has to be delivered first.");
  const up = await currentUploader(db.query, eventId);
  if (!up) throw new RuleError("This event has no attendee list.");
  if (e.motion === "none") {
    const [waiting] = await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND kind = 'motion' AND status = 'pending'", [eventId]);
    if (!waiting) await requestMotionCard(db, deps, eventId, up.uploaded_by, { holdout_percent: 10 });
    const [a] = await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND kind = 'motion' AND status = 'pending'", [eventId]);
    await decideApproval(db, { approvalId: a.id, actor: up.uploaded_by, decision: "approve" });
    return { did: "The Motion card was confirmed and outreach has started." };
  }
  if (e.motion === "owners") {
    await openOwnerDecisions(db, deps, eventId); await sendOwnerCards(db, deps, eventId);
    await db.query("UPDATE owner_decisions SET status = 'include', via = 'default', decided_at = now(), decided_by = 'Events Desk' WHERE event_id = $1 AND status IN ('pending', 'handed')", [eventId]);
    await db.query("UPDATE review_cases SET status = 'skipped', decision = 'skipped', decided_by = 'Events Desk', decided_at = now() WHERE event_id = $1 AND kind = 'owner_unreachable' AND status = 'open'", [eventId]);
    await ownerSweep(db, deps, eventId);
    return { did: "Account owners had their say. In this sample, nobody kept an account." };
  }
  if (e.motion === "sequencing") {
    await ensureSetup(db, deps, tools, eventId, up.uploaded_by);
    const seqs = await db.query<{ id: string }>("SELECT id FROM sequences WHERE event_id = $1 AND state = 'draft'", [eventId]);
    if (!seqs.length) {
      const pe = await postEventState(db, deps, eventId);
      if (pe?.window === "after" && !pe.started_at && !opts.pressFollowUp) return { did: "The event is over. Press Start the follow-up to send it, group by group." };
      const r = await createDrafts(db, deps, eventId, up.uploaded_by);
      return { did: `Sequences are set up: ${r.added} people added. Inboxes were sized and chosen.` };
    }
    for (const s of await db.query<{ id: string; external_id: string | null; connector: string }>("SELECT id, external_id, connector FROM sequences WHERE event_id = $1 AND state = 'draft'", [eventId])) {
      if (!s.external_id) await attachCampaign(db, deps, s.id, tools[s.connector].newSeq(), up.uploaded_by);
      await confirmLaunchChecklist(db, s.id, up.uploaded_by);
      const [fresh] = await db.query<{ external_id: string }>("SELECT external_id FROM sequences WHERE id = $1", [s.id]);
      tools[s.connector].launch(fresh.external_id);
    }
    await observeSequences(db, deps); await drainOps(db, deps);
    return { did: "The sequences are live. Everyone was checked again at launch." };
  }
  if (e.motion === "in_market") {
    const live = await db.query<{ contact_id: string; email: string | null; linkedin: string | null; sequence: string | null; channel: string; connector: string }>(
      `SELECT n.contact_id, k.email, k.linkedin, s.external_id AS sequence, n.channel, s.connector FROM enrollments n JOIN contacts k ON k.id = n.contact_id JOIN sequences s ON s.id = n.sequence_id WHERE n.event_id = $1 AND n.state = 'enrolled' ORDER BY n.id`, [eventId]);
    const by = new Map<string, ToolEvent[]>();
    const add = (c: string, x: ToolEvent) => by.set(c, [...(by.get(c) ?? []), x]);
    for (const p of live) {
      const base = { channel: p.channel as "email" | "linkedin", sequence_external_id: p.sequence, email: p.channel === "email" ? p.email : null, linkedin: p.channel === "linkedin" ? p.linkedin : null, external_contact_id: null, at: new Date().toISOString() };
      add(p.connector, { ...base, provider_message_id: `send:${p.contact_id}:${p.channel}`, signal: "send", body: null, sender: null, step: 0 });
      if (p.channel !== "email") continue;
      let r = u(`reply|${p.contact_id}`);
      for (const x of REPLIES) { if (r < x.share) { add(p.connector, { ...base, provider_message_id: `reply:${p.contact_id}`, signal: x.signal ?? "reply", body: x.body || null }); break; } r -= x.share; }
    }
    for (const [name, events] of by) await ingestEvents(db, deps, deps.connectors[name], events);
    await processInbound(db, deps, 2000);
    // In the sample, Maya covers these accounts, so her day has something in it whoever owns them in the sample CRM.
    await db.query("UPDATE inbound_messages SET owner = $2 WHERE event_id = $1 AND respond_by IS NOT NULL", [eventId, REP]);
    await drainNotifications(db, deps);
    // Most of the people who said yes end up in a meeting.
    const hot = await db.query<{ contact_id: string }>("SELECT contact_id FROM inbound_messages WHERE event_id = $1 AND code IN ('interested', 'meeting_request') AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.contact_id = inbound_messages.contact_id) ORDER BY id", [eventId]);
    let held = 0;
    for (const h of hot) {
      if (u(`meet|${h.contact_id}`) > 0.75) continue;
      // Most held already; the rest are coming up, so a rep's day has meetings with briefs in it.
      const upcoming = u(`soon|${h.contact_id}`) < 0.4;
      const m = await bookMeeting(db, deps, { contact_id: h.contact_id, scheduled_at: new Date(Date.now() + (upcoming ? 2 : -1) * 86_400_000).toISOString(), source: "reply", rep: REP }, REP);
      if (!upcoming) { await recordOutcome(db, deps, m.id, "held", REP); held++; }
    }
    const [firstCap] = await db.query("SELECT 1 FROM onsite_captures WHERE event_id = $1 LIMIT 1", [eventId]);
    if (!firstCap) for (let i = 1; i <= 3; i++) await captureOnsite(db, deps, eventId, REP, { full_name: `Booth Visitor ${i}`, email: `visitor${i}@walkup${i}.example`, company: `Walk-up Co ${i}`, title: "Head of Payments", note: "Stopped by the booth, asked for a demo.", temperature: "hot", met: true });
    await recordEventCost(db, eventId, GTM, "sponsorship", 1_500_000, "Sample figure");
    await recordEventCost(db, eventId, GTM, "booth", 400_000, "Sample figure");
    return { did: `Sends went out and people answered. ${held} meetings held, plus 3 walk-ups at the booth.` };
  }
  throw new RuleError("Nothing more to simulate here. The event closes on its own clock.");
}

export const withDemoCrm = (crm: Crm | undefined, db: Db, now: () => Date): Crm | undefined => (crm ? { ...crm, opportunities: demoOpportunities(db, now) } : crm);

/* The sample year shows every step after delivery, so a visitor can open each one. Run once at boot, after the flagship is in market. */
type DemoStage = "owners" | "sequencing" | "follow_up_ready" | "in_market" | "closing" | "scored";
export const DEMO_STAGES: [string, DemoStage][] = [
  ["evt_nrf-2026-retail-s-big-show", "scored"],
  ["evt_shoptalk-spring-2026", "closing"],
  ["evt_money20-20-europe-2026", "follow_up_ready"],
  ["evt_dreamforce-2026", "sequencing"],
  ["evt_finnosummit-2026", "owners"],
  ["evt_salesforce-world-tour-tokyo-2026", "in_market"],
];

export async function seedDemoStages(db: Db, deps: LifecycleDeps, tools: Record<string, FakeTool>) {
  const motion = async (id: string) => (await db.query<{ motion: string; stage: string }>("SELECT motion, stage FROM events WHERE id = $1", [id]))[0];
  // Each event waits until its list is delivered by the background build.
  for (const [id] of DEMO_STAGES) for (let i = 0; i < 240 && (await motion(id))?.stage !== "delivered"; i++) await new Promise((r) => setTimeout(r, 1000));
  const toMarket = async (id: string) => {
    for (let k = 0; k < 6 && (await motion(id))?.motion !== "in_market"; k++) await demoAdvance(db, deps, tools, id, { pressFollowUp: true });
    await demoAdvance(db, deps, tools, id, { pressFollowUp: true });
  };
  for (const [id, stage] of DEMO_STAGES) {
    if ((await motion(id))?.stage !== "delivered") continue;
    if (stage === "owners") { await demoAdvance(db, deps, tools, id); continue; }
    if (stage === "follow_up_ready") { for (let k = 0; k < 3 && (await motion(id)).motion !== "sequencing"; k++) await demoAdvance(db, deps, tools, id); continue; }
    if (stage === "sequencing") { for (let k = 0; k < 3 && (await motion(id)).motion !== "sequencing"; k++) await demoAdvance(db, deps, tools, id); await demoAdvance(db, deps, tools, id, { pressFollowUp: true }); continue; }
    await toMarket(id);
    if (stage === "closing" || stage === "scored") await db.tx((q) => moveMotion(q, id, "closing", "Events Desk", "Fourteen days after the event"));
    // The scorecards run before Shoptalk closes, so NRF is scored and Shoptalk stays in closing.
    if (stage === "scored") await writeScorecards(db, deps);
  }
}
