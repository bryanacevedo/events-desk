/* The demo's stand-in for the outside world after delivery: people answering, meetings happening. Each press moves one event forward one step. It runs through every real rule, with the real connector code over a stand-in tool. All rates here are authored, and the screen says simulated. */

import { createHash } from "node:crypto";
import { currentUploader, decideApproval } from "./approvals.ts";
import { answerCase } from "./cases.ts";
import type { Db } from "./db.ts";
import type { FakeTool } from "./connectors/fake.ts";
import type { ToolEvent } from "./connectors/types.ts";
import { RuleError } from "./events.ts";
import { captureOnsite, drainNotifications } from "./operating.ts";
import { bookMeeting, eventZone, recordOutcome } from "./meetings.ts";
import { LAST_DAY_SQL, requestMotionCard } from "./motion.ts";
import { openOwnerDecisions, sendOwnerCards, ownerSweep } from "./owners.ts";
import { ingestEvents, processInbound } from "./replies.ts";
import { approveTemplate, attachCampaign, calendarSweep, confirmLaunchChecklist, createDrafts, drainOps, observeSequences, recordLegalBasis, setTools } from "./sequences.ts";
import { recordConsent, recordPlacement } from "./sending.ts";
import { recordEventCost, writeScorecards } from "./closeout.ts";
import { moveMotion } from "./motion-state.ts";
import { loadPeople, regionOf } from "./gate.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import type { Crm, CrmOpportunity } from "./providers.ts";
import { postEventState } from "./post-event.ts";
import { zoneAt } from "../shared/motion.ts";
import { companyDisplayName } from "../shared/names.ts";

const u = (s: string) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16) / 0xffffffff;
const GTM = "GTM Team";
const REP = "Maya Ortiz";

/* Each kind of answer comes in several wordings, so two people never send the same sentence. The classifier reads them the same way. */
const WORDINGS: Record<string, string[]> = {
  "Sounds good, tell me more about how this works.": ["Sounds good, tell me more about how this works.", "Interested. How does it handle people who sign up at the door?", "Sounds good. We have this problem every show; what does setup look like?", "Interested. Could you send a short overview? I'll share it with our events lead.", "Tell me more about how this fits with the badge scanner we already use."],
  "Happy to book a call. Thursday afternoon works for me.": ["Happy to meet at the show. Send me a time that suits you.", "Let's meet while we're both there. Mornings are easier for me.", "Sure, book 30 minutes with me at the event.", "Yes, let's meet at the show. Booth or coffee, either works.", "Worth a call. Pick a slot and I'll come by the booth."],
  "I am out of office and back on 2027-12-20.": ["I am out of office this week and back on Monday.", "Out of the office this week, back on Monday.", "I'm away until the 21st with limited access to email.", "Out of office at a conference. I'll reply when I'm back."],
  "Not interested, thanks.": ["Not interested, thanks.", "Not interested this year, our budget is spoken for.", "No thanks, we're set for now.", "Not interested right now, thanks for thinking of us."],
};
// After the event, a yes to a meeting reads like one: the show is over. Same classifier words (meet, call, book).
const AFTER_WORDINGS: Record<string, string[]> = {
  "Happy to book a call. Thursday afternoon works for me.": ["Sorry we missed each other at the show. Happy to book a call next week.", "Now the show is over, let's set up a call.", "Good timing. Book 30 minutes with me next week.", "Yes, let's meet next week while it is fresh.", "Worth a call. Send me a couple of times."],
};
// Wordings rotate in order, so the replies on one screen never repeat each other.
const said = new Map<string, number>();
const wording = (body: string, phase: string = "pre") => { const w = (phase === "post" ? AFTER_WORDINGS[body] : null) ?? WORDINGS[body]; if (!w) return body; const k = `${phase}|${body}`, n = said.get(k) ?? 0; said.set(k, n + 1); return w[n % w.length]; };

const REPLIES: { share: number; body: string; signal?: ToolEvent["signal"] }[] = [
  { share: 0.12, body: "Sounds good, tell me more about how this works." },
  { share: 0.08, body: "Happy to book a call. Thursday afternoon works for me." },
  { share: 0.06, body: "I am out of office and back on 2027-12-20." },
  { share: 0.06, body: "Not interested, thanks." },
  { share: 0.02, body: "Please remove me from this list." },
  { share: 0.02, body: "", signal: "bounce" },
];

/** Deals appear at some of the accounts that were met. */
/** A deal already open before the event is one an account has with us (it moves forward); one opened after a meeting is new business. */
const DEMO_DEALS = { open: ["renewal", "expansion"], fresh: ["new logo", "platform pilot"] };
const DEMO_OWNERS = ["Priya Natarajan", "Tomas Lindqvist", "Adaeze Okonkwo", "Mateo Ruiz", "Hanna Berg"];
const DEMO_NEXT = ["Security review with their IT team", "Pricing call on the calendar", "Pilot scope to sign off", "Order form with their legal team", "Second demo for the wider team"];
export const demoOpportunities = (db: Db, now: () => Date) => async (accounts: { ref: string; name?: string | null }[]): Promise<Record<string, CrmOpportunity[]>> => {
  const met = new Set((await db.query<{ domain: string }>("SELECT DISTINCT domain FROM meetings WHERE status = 'held'")).map((m) => m.domain));
  const owners = new Map((await db.query<{ domain: string; owner: string }>("SELECT DISTINCT ON (primary_domain) primary_domain AS domain, account_owner AS owner FROM companies WHERE account_owner IS NOT NULL AND primary_domain = ANY($1::text[])", [accounts.map((a) => a.ref)])).map((r) => [r.domain, r.owner]));
  const day = (d: number) => new Date(now().getTime() + d * 86_400_000).toISOString();
  // A deal's history hangs off the meeting it followed: opened about a week after, at proposal a few weeks later, never past today.
  const metOn = new Map((await db.query<{ domain: string; at: string }>("SELECT domain, min(scheduled_at)::text AS at FROM meetings WHERE status = 'held' GROUP BY domain")).map((m) => [m.domain, new Date(m.at).getTime()]));
  const after = (ref: string, d: number) => new Date(Math.min(now().getTime(), (metOn.get(ref) ?? now().getTime()) + d * 86_400_000)).toISOString();
  return Object.fromEntries(accounts.map((a) => {
  if (u(`opp|${a.ref}`) > (met.has(a.ref) ? 0.7 : 0.2)) return [a.ref, []];
  // An open deal that was already running before the event moved forward after it; a new one opened after the meeting.
  const open = u(`old|${a.ref}`) < 0.3;
  return [a.ref, [{
    id: `opp_${a.ref}`, name: `${companyDisplayName(a.name ?? a.ref)} ${(open ? DEMO_DEALS.open : DEMO_DEALS.fresh)[Math.floor(u(`deal|${a.ref}`) * 2)]}`,
    url: `https://login.salesforce.com/?startURL=${encodeURIComponent(`/lightning/r/Opportunity/opp_${a.ref}/view`)}`,
    owner: owners.get(a.ref) ?? DEMO_OWNERS[Math.floor(u(`own|${a.ref}`) * DEMO_OWNERS.length)],
    next_step: DEMO_NEXT[Math.floor(u(`next|${a.ref}`) * DEMO_NEXT.length)],
    stage: "Proposal", amount_cents: Math.round(2_000_000 + u(`amt|${a.ref}`) * 9_000_000),
    created_date: open ? after(a.ref, -70) : after(a.ref, 5 + Math.round(u(`gap|${a.ref}`) * 6)), close_date: day(30 + Math.round(u(`close|${a.ref}`) * 60)),
    stage_history: open
      ? [{ stage: "Discovery", at: after(a.ref, -70) }, { stage: "Evaluation", at: after(a.ref, -31) }, { stage: "Proposal", at: after(a.ref, 12 + Math.round(u(`prop|${a.ref}`) * 20)) }]
      : [{ stage: "Discovery", at: after(a.ref, 5 + Math.round(u(`gap|${a.ref}`) * 6)) }, { stage: "Proposal", at: after(a.ref, 26 + Math.round(u(`prop|${a.ref}`) * 24)) }],
  } satisfies CrmOpportunity]];
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
    const live = await db.query<{ contact_id: string; email: string | null; linkedin: string | null; sequence: string | null; sequence_id: string; channel: string; connector: string; senders: string[]; phase: string }>(
      `SELECT n.contact_id, k.email, k.linkedin, s.external_id AS sequence, s.id AS sequence_id, n.channel, s.connector, s.phase,
              coalesce((SELECT array_agg(x.address ORDER BY x.address) FROM sequence_senders x WHERE x.sequence_id = s.id AND x.role = 'primary' AND x.dropped_at IS NULL), '{}') AS senders
       FROM enrollments n JOIN contacts k ON k.id = n.contact_id JOIN sequences s ON s.id = n.sequence_id WHERE n.event_id = $1 AND n.state = 'enrolled' ORDER BY n.id`, [eventId]);
    const by = new Map<string, ToolEvent[]>();
    const add = (c: string, x: ToolEvent) => by.set(c, [...(by.get(c) ?? []), x]);
    for (const p of live) {
      const base = { channel: p.channel as "email" | "linkedin", sequence_external_id: p.sequence, email: p.channel === "email" ? p.email : null, linkedin: p.channel === "linkedin" ? p.linkedin : null, external_contact_id: null, at: new Date().toISOString() };
      // What the tool would report: on email, the first message and for most a second, from one of the sequence's inboxes;
      // on LinkedIn, the connection request, then for those who accept, a message. Ids carry the sequence, so a person in a
      // before and an after sequence keeps both.
      const sender = p.senders.length ? p.senders[Math.floor(u(`sender|${p.contact_id}|${p.sequence_id}`) * p.senders.length)] : null;
      const id = (k: string) => `${k}:${p.sequence_id}:${p.contact_id}`;
      if (p.channel === "linkedin") {
        add(p.connector, { ...base, provider_message_id: id("invite"), signal: "invite", body: null, sender, step: null });
        if (u(`accept|${p.contact_id}`) < 0.42) {
          add(p.connector, { ...base, provider_message_id: id("accepted"), signal: "accepted", body: null, sender, step: null });
          add(p.connector, { ...base, provider_message_id: id("message"), signal: "send", body: null, sender, step: null });
        }
        continue;
      }
      add(p.connector, { ...base, provider_message_id: id("send1"), signal: "send", body: null, sender, step: 1 });
      if (u(`second|${p.contact_id}`) < 0.7) add(p.connector, { ...base, provider_message_id: id("send2"), signal: "send", body: null, sender, step: 2 });
      let r = u(`reply|${p.contact_id}`);
      for (const x of REPLIES) { if (r < x.share) { add(p.connector, { ...base, provider_message_id: `reply:${p.sequence_id}:${p.contact_id}`, signal: x.signal ?? "reply", body: x.body ? wording(x.body, p.phase) : null, thread_url: p.connector === "heyreach" ? "https://app.heyreach.io/app/inbox" : "https://app.instantly.ai/app/unibox" }); break; } r -= x.share; }
    }
    for (const [name, events] of by) await ingestEvents(db, deps, deps.connectors[name], events);
    await processInbound(db, deps, 2000);
    // In the sample, Maya covers these accounts, so her day has something in it whoever owns them in the sample CRM.
    await db.query("UPDATE inbound_messages SET owner = $2 WHERE event_id = $1 AND respond_by IS NOT NULL", [eventId, REP]);
    await drainNotifications(db, deps);
    // Most of the people who said yes end up in a meeting.
    // Before the event, meetings are booked for the show floor and none is held yet; after it opens, most are held.
    const [{ started, opens, venue, country }] = await db.query<{ started: boolean; opens: string; venue: string | null; country: string | null }>("SELECT starts_on::date <= current_date AS started, starts_on::text AS opens, venue, country FROM events WHERE id = $1", [eventId]);
    const tz = zoneAt(venue, country) ?? "UTC";
    const hot = await db.query<{ contact_id: string }>("SELECT contact_id FROM inbound_messages WHERE event_id = $1 AND code IN ('interested', 'meeting_request') AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.contact_id = inbound_messages.contact_id) ORDER BY id", [eventId]);
    let held = 0;
    for (const [i, h] of hot.entries()) {
      // The latest warm reply is still waiting for its answer, so there is always one for a rep to pick up.
      if (i === hot.length - 1 && hot.length > 1) continue;
      if (u(`meet|${h.contact_id}`) > 0.75) continue;
      // Most held already; the rest are coming up, so a rep's day has meetings with briefs in it.
      const upcoming = !started || u(`soon|${h.contact_id}`) < 0.4;
      const at = started ? new Date(Date.now() + (upcoming ? 2 : -1) * 86_400_000) : new Date(`${opens.slice(0, 10)}T00:00:00Z`);
      if (!started) {
        // Between 09:00 and 17:00 where the event is.
        at.setUTCHours(9 + Math.floor(u(`hour|${h.contact_id}`) * 8), u(`half|${h.contact_id}`) < 0.5 ? 0 : 30);
        const offset = new Date(at.toLocaleString("en-US", { timeZone: tz })).getTime() - new Date(at.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
        at.setTime(at.getTime() - offset);
      }
      const m = await bookMeeting(db, deps, { contact_id: h.contact_id, scheduled_at: at.toISOString(), source: "reply", rep: REP }, REP);
      if (!upcoming) { await recordOutcome(db, deps, m.id, "held", REP); held++; }
    }
    // Nobody is met at a booth before the event opens.
    const [firstCap] = started ? await db.query("SELECT 1 FROM onsite_captures WHERE event_id = $1 LIMIT 1", [eventId]) : [true];
    // Walk-ups met at the booth: each event takes the next three in the list, so no two events share a person.
    if (!firstCap) {
      const [{ n }] = await db.query<{ n: number }>("SELECT count(DISTINCT event_id)::int AS n FROM onsite_captures");
      const start = n * 3;
      for (let i = 0; i < 3; i++) {
        const w = WALKUPS[(start + i) % WALKUPS.length];
        const slug = w.company.toLowerCase().replace(/[^a-z0-9]+/g, "");
        await captureOnsite(db, deps, eventId, REP, { full_name: w.name, email: `${w.name.split(" ")[0].toLowerCase()}@${slug}.example`, company: w.company, title: w.title, note: w.note, temperature: i === 0 ? "hot" : "warm", met: true });
      }
    }
    // Each event's own package and stand, at its own price, rounded the way invoices are.
    const PACKAGES = ["Silver package", "Gold package", "Bronze package plus a speaking slot", "Startup pavilion package"];
    const STANDS = ["10x10 stand and furniture", "Shared stand in the partner pavilion", "8x8 stand, power and lead scanner", "Corner stand and AV"];
    const pick = <T,>(xs: T[], k: string) => xs[Math.floor(u(`${k}|${eventId}`) * xs.length)];
    await recordEventCost(db, eventId, GTM, "sponsorship", 800_000 + Math.round(u(`spons|${eventId}`) * 16) * 50_000, `${pick(PACKAGES, "pkg")}, invoice ${2000 + Math.floor(u(`inv|${eventId}`) * 900)}`);
    await recordEventCost(db, eventId, GTM, "booth", 250_000 + Math.round(u(`booth|${eventId}`) * 8) * 25_000, pick(STANDS, "stand"));
    return { did: `Sends went out and people answered. ${held} meetings held${started ? ", plus 3 walk-ups at the booth" : ""}.` };
  }
  throw new RuleError("Nothing more to simulate here. The event closes on its own clock.");
}

export const withDemoCrm = (crm: Crm | undefined, db: Db, now: () => Date): Crm | undefined => (crm ? { ...crm, opportunities: demoOpportunities(db, now) } : crm);

/** Invented walk-ups for the demo's booth captures. */
const WALKUPS = [
  { name: "Lena Fischer", company: "Brightmoor Payments", title: "Head of Payments", note: "Asked how the desk handles owners who keep an account." },
  { name: "Omar Haddad", company: "Kestrel Ledger", title: "VP Revenue Operations", note: "Wants a demo for their events team next month." },
  { name: "Sara Lindqvist", company: "Nordvik Commerce", title: "Director of Partnerships", note: "Runs twelve events a year; the follow-up is their pain." },
  { name: "Diego Ramos", company: "Altamar Logistics", title: "Head of Growth", note: "Asked for pricing and a short call next week." },
  { name: "Aiko Tanaka", company: "Hoshi Retail Systems", title: "Field Marketing Lead", note: "Interested in the seat approvals for her leadership." },
  { name: "Ben Carter", company: "Quayside Data", title: "Sales Director", note: "Came back a second time with his CMO." },
  { name: "Leila Shah", company: "Lumen Billing", title: "Revenue Operations Manager", note: "Wants to see the CRM sync with Salesforce." },
  { name: "Lucas Moreau", company: "Sablier Fintech", title: "Head of Events", note: "Asked how replies reach the right rep." },
  { name: "Ines Duarte", company: "Ribeira Freight", title: "Chief Revenue Officer", note: "Quick chat; send a one-pager." },
  { name: "Tomás Varga", company: "Danube Pay", title: "Head of Partnerships", note: "Wants the follow-up groups for his own team." },
  { name: "Grace Okafor", company: "Harbourline Insurance", title: "VP Marketing", note: "Asked who approves the seats." },
  { name: "Mateo Silva", company: "Cerro Analytics", title: "GTM Engineer", note: "Wants to read the gate rules before a call." },
  { name: "Hannah Brooks", company: "Ashgrove Health", title: "Director of Events", note: "Booked a demo for after the holidays." },
  { name: "Yusuf Demir", company: "Bosphorus Trade", title: "Sales Operations Lead", note: "Asked how the inboxes are picked." },
  { name: "Claire Dubois", company: "Lumiere Commerce", title: "Chief Marketing Officer", note: "Wants the ROI view for her board." },
];

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
  const toMarket = async (id: string, d: LifecycleDeps = deps) => {
    for (let k = 0; k < 6 && (await motion(id))?.motion !== "in_market"; k++) await demoAdvance(db, d, tools, id, { pressFollowUp: true });
    await demoAdvance(db, d, tools, id, { pressFollowUp: true });
  };
  // A finished event ran two waves, as a real one would: its pre-event sequences, run on a clock eighteen days before it opened,
  // then its follow-up after it closed. Without the first, the demo's past events would show only a follow-up.
  const twoWaves = async (id: string) => {
    const [{ starts_on }] = await db.query<{ starts_on: string }>("SELECT starts_on::text AS starts_on FROM events WHERE id = $1", [id]);
    const before = new Date(Date.parse(`${starts_on}T14:00:00Z`) - 18 * 86_400_000);
    await toMarket(id, { ...deps, now: () => before });
    // The event opened: the calendar ends the pre-event sequences, which frees everyone in them for the follow-up.
    await calendarSweep(db, deps);
    await db.query("UPDATE events SET motion = 'sequencing' WHERE id = $1 AND motion = 'in_market'", [id]);
    await toMarket(id);
  };
  for (const [id, stage] of DEMO_STAGES) {
    if ((await motion(id))?.stage !== "delivered") continue;
    if (stage === "owners") { await demoAdvance(db, deps, tools, id); continue; }
    if (stage === "follow_up_ready") { for (let k = 0; k < 3 && (await motion(id)).motion !== "sequencing"; k++) await demoAdvance(db, deps, tools, id); continue; }
    if (stage === "sequencing") { for (let k = 0; k < 3 && (await motion(id)).motion !== "sequencing"; k++) await demoAdvance(db, deps, tools, id); await demoAdvance(db, deps, tools, id, { pressFollowUp: true }); continue; }
    // A finished event had its list settled before outreach, as a team would: every open case answered the way the desk suggested.
    const settle = async () => {
      // Every reply that came in is read first, so a case it opens is settled here, not left for the server's first pass after boot.
      await processInbound(db, deps, 5000);
      for (const c of await db.query<{ id: string; suggested: string | null }>("SELECT id, suggested FROM review_cases WHERE event_id = $1 AND status = 'open'", [id])) {
        try { await answerCase(db, id, c.id, (await currentUploader(db.query, id))?.uploaded_by ?? "Maya Ortiz", c.suggested ?? "dismiss"); } catch { /* a case its answer no longer fits stays open */ }
      }
    };
    if (stage === "closing" || stage === "scored") { await settle(); await twoWaves(id); await settle(); } else await toMarket(id);
    if (stage === "closing" || stage === "scored") { await db.tx((q) => moveMotion(q, id, "closing", "Events Desk", "Fourteen days after the event")); await redateDemo(db); }
    // The scorecards run before Shoptalk closes, so NRF is scored and Shoptalk stays in closing.
    if (stage === "scored") await writeScorecards(db, deps);
  }
  // The calendar ends what has run its course: a follow-up wave 24 days after its event, anything of a scored event.
  await calendarSweep(db, deps);
  // Last: nothing unread is left behind, and a finished event has nothing open. A live event keeps what it has, as a real one would.
  await processInbound(db, deps, 5000);
  for (const [id, stage] of DEMO_STAGES) {
    if (stage !== "closing" && stage !== "scored") continue;
    // A reply set aside is answered as a person would read it: one that says unsubscribe is an opt-out; otherwise the model's own reading stands.
    for (const c of await db.query<{ id: string; suggested: string | null; kind: string; summary: string; model_code: string | null }>(
      `SELECT r.id, r.suggested, r.kind, r.summary, (SELECT i.model_code FROM inbound_messages i WHERE i.id = r.payload->>'inbound_id') AS model_code FROM review_cases r WHERE r.event_id = $1 AND r.status = 'open'`, [id])) {
      const answer = c.suggested ?? (c.kind === "reply_doubtful" ? (/unsubscribe/i.test(c.summary) ? "unsubscribe" : c.model_code && c.model_code !== "other" ? c.model_code : "not_interested") : "dismiss");
      try { await answerCase(db, id, c.id, (await currentUploader(db.query, id))?.uploaded_by ?? "Maya Ortiz", answer); } catch { /* left open */ }
    }
  }
  await redateDemo(db);
  await seedDemoDebriefs(db);
  // NRF's costs are all in, as a scored event's should be; Shoptalk, still closing, has lines left for Overview to ask about.
  for (const [category, cents, note] of [["dinners", 240_000, "Customer dinner, Tuesday"], ["swag", 0, ""], ["tools", 49_900, "Badge scanner rental"], ["rep_time", 0, ""]] as const)
    await recordEventCost(db, "evt_nrf-2026-retail-s-big-show", "Dan Whitlock", category, cents, note);
  await recordEventCost(db, "evt_shoptalk-spring-2026", "Dan Whitlock", "dinners", 180_000, "Dinner with two prospects");
  // The flagship ended weeks ago. Once its meetings are in, they are dated at the event, and Maya owes her notes from it:
  // asked two days after its last day, as the desk does.
  const FLAGSHIP = "evt_money20-20-usa-2026";
  for (let i = 0; i < 240; i++) { const [h] = await db.query("SELECT 1 FROM meetings WHERE event_id = $1 AND status = 'held' LIMIT 1", [FLAGSHIP]); if (h) break; await new Promise((r) => setTimeout(r, 1000)); }
  await redateDemo(db);
  await db.query(`INSERT INTO debriefs (id, event_id, author, prompted_at) SELECT 'dbf_demo_flagship', e.id, $2, ((${LAST_DAY_SQL})::date + 2 + time '16:00')::timestamptz FROM events e
    WHERE e.id = $1 AND EXISTS (SELECT 1 FROM meetings m WHERE m.event_id = e.id AND m.rep = $2 AND m.status = 'held') ON CONFLICT (event_id, author) DO NOTHING`, [FLAGSHIP, REP]);
}

/* What the rep wrote after each finished sample event, so "What we learned" has something in it. Sample notes, like every attendee here:
   NRF's are accepted and sorted into themes; Shoptalk's wait for leadership to review. */
const DEMO_NOTES: Record<string, { status: "accepted" | "answered"; body: string; facts: [string, string, string][] }> = {
  "evt_nrf-2026-retail-s-big-show": {
    status: "accepted",
    body: "Busy floor, short conversations. The retail ops people all said some version of \"We spend the week after a show rebuilding the list in a spreadsheet.\" Hoshi's events lead added \"By the time the list is clean, the buyers have forgotten us.\" Two accounts already scan badges with an app; one put it as \"We have the scanner. What we don't have is anything after the scan.\" Quayside runs its follow-up through its marketing agency: \"Our agency sends one email to everyone a week later.\" Budgets close in March: \"If it isn't in the plan by March, it waits a year.\" Two of them want a pilot on one regional show first: \"Prove it on a small show and we will bring it to the big one.\" New logos came from the email before the show, not the booth; the booth was mostly customers.",
    facts: [
      ["pain", "Retail ops teams rebuild their event list by hand the week after a show.", "We spend the week after a show rebuilding the list in a spreadsheet."],
      ["pain", "Speed of follow-up hurts them more than the state of the list.", "By the time the list is clean, the buyers have forgotten us."],
      ["competitor", "Accounts that already scan badges want this behind their scanner, not instead of it.", "We have the scanner. What we don't have is anything after the scan."],
      ["competitor", "Some hand the follow-up to their marketing agency, which sends one generic email a week later.", "Our agency sends one email to everyone a week later."],
      ["timing", "Next year's budgets close in March, so follow-ups have to land before then.", "If it isn't in the plan by March, it waits a year."],
      ["timing", "Buyers want to prove it on a small regional show before trusting it with the flagship.", "Prove it on a small show and we will bring it to the big one."],
      ["relationship", "New logos booked off the email before the show; the booth was mostly existing customers.", ""],
    ],
  },
  "evt_shoptalk-spring-2026": {
    status: "answered",
    body: "Smaller crowd than NRF but the right titles: heads of ecommerce and growth. Three asked whether we sync to Marketing Cloud, not just the CRM: \"Our nurture lives in Marketing Cloud, not Sales Cloud.\" One competitor demoed next to us all week, and a buyer summed it up: \"Theirs stops at the scan. Yours keeps going.\" Next time book dinners before the show, the evenings were where the long conversations happened.",
    facts: [
      ["product_gap", "Buyers asked for a Marketing Cloud sync; the desk writes only to the CRM.", "Our nurture lives in Marketing Cloud, not Sales Cloud."],
      ["competitor", "A competitor demoed beside us; buyers compared the two on the follow-up.", "Theirs stops at the scan. Yours keeps going."],
      ["general", "Book dinners before the show: the long conversations happened in the evenings.", ""],
    ],
  },
};
async function seedDemoDebriefs(db: Db) {
  for (const [eventId, n] of Object.entries(DEMO_NOTES)) {
    const [have] = await db.query("SELECT 1 FROM debriefs WHERE event_id = $1", [eventId]);
    if (have) continue;
    const [last] = await db.query<{ day: string }>(`SELECT (${LAST_DAY_SQL} + 3)::text AS day FROM events e WHERE e.id = $1`, [eventId]);
    if (!last) continue;
    const id = `dbf_demo_${eventId.slice(4, 16)}`;
    await db.query("INSERT INTO debriefs (id, event_id, author, prompted_at, body, answered_at, extracted, status, decided_by) VALUES ($1, $2, $3, $4, $5, $4, true, $6, $7)", [id, eventId, REP, `${last.day}T16:00:00Z`, n.body, n.status, n.status === "accepted" ? "Dan Whitlock" : null]);
    for (const [i, [theme, fact, quote]] of n.facts.entries()) await db.query("INSERT INTO debrief_facts (id, debrief_id, account, theme, fact, quote) VALUES ($1, $2, NULL, $3, $4, $5)", [`${id}_${i}`, id, theme, fact, quote]);
  }
}

/* The sample runs every step in a few seconds, so everything it writes carries the same minute. A finished (closing or scored) event's activity is
   laid back over the weeks around it, in the order it happened: added three weeks out, sends over the next days, replies the
   week before, meetings on the show floor, at times a person would keep. Events still ahead keep their dates; their meetings
   get ordinary hours. */
export async function redateDemo(db: Db) {
  const C = "(hashtext(t.contact_id)::bigint & 2147483647)";
  const S = "(e.starts_on::date + time '13:00')";
  const N = `greatest(1, (${LAST_DAY_SQL})::date - e.starts_on::date + 1)`;
  const past = "e.motion IN ('closing', 'scored')";
  const reply = (c: string) => `${S} - interval '12 days' + make_interval(days => (${c} % 6)::int, hours => 1, mins => (${c} % 420)::int)`;
  // A meeting on the show floor: one of the event's days, between 09:00 and 17:00 in the meeting's own zone.
  const meet = (c: string, tz: string) => `((e.starts_on::date + make_interval(days => (${c} % ${N})::int))::timestamp + interval '9 hours' + make_interval(mins => ((${c} / 7) % 16)::int * 30)) AT TIME ZONE ${tz}`;
  const TZ_OF_TOUCH = "coalesce((SELECT m.timezone FROM meetings m WHERE m.contact_id = t.contact_id AND m.event_id = t.event_id LIMIT 1), 'UTC')";
  // Anything from a follow-up sequence happened after the event closed: added the day after, sent over the days after that, answered later.
  const L = `(${LAST_DAY_SQL})::date + time '15:00'`;
  const POST = "(SELECT x.phase FROM sequences x WHERE x.id = t.sequence_id) = 'post'";
  await db.query(`UPDATE touches t SET at = CASE
      WHEN ${POST} AND t.kind = 'sequence_add' THEN ${L} + interval '1 day' + make_interval(mins => (${C} % 240)::int)
      WHEN ${POST} AND t.kind IN ('send', 'accepted') THEN ${L} + interval '1 day' + make_interval(days => (${C} % 3)::int + 3 * (coalesce(t.step, 1) - 1) + CASE WHEN t.action = 'message' OR t.kind = 'accepted' THEN 2 ELSE 0 END, mins => (${C} % 300)::int)
      WHEN ${POST} AND t.kind LIKE 'reply_%' THEN ${L} + interval '4 days' + make_interval(days => (${C} % 5)::int, mins => (${C} % 420)::int)
      WHEN t.kind = 'sequence_add' THEN ${S} - interval '21 days' + make_interval(days => (${C} % 3)::int, mins => (${C} % 240)::int) + CASE WHEN t.channel = 'linkedin' THEN interval '2 hours 17 minutes' ELSE interval '0' END
      WHEN t.kind = 'send' THEN ${S} - interval '17 days' + make_interval(days => (${C} % 4)::int + CASE WHEN t.channel = 'linkedin' THEN 1 ELSE 0 END + 3 * (coalesce(t.step, 1) - 1) + CASE WHEN t.action = 'message' THEN 2 ELSE 0 END, mins => (${C} % 300)::int)
      WHEN t.kind = 'accepted' THEN ${S} - interval '15 days' + make_interval(days => (${C} % 4)::int, mins => (${C} % 300)::int)
      WHEN t.kind LIKE 'reply_%' THEN ${reply(C)}
      WHEN t.kind = 'meeting_booked' THEN ${reply(C)} + make_interval(hours => 3, mins => (${C} % 90)::int)
      WHEN t.kind LIKE 'meeting_%' THEN ${meet(C, TZ_OF_TOUCH)} + interval '45 minutes'
      WHEN t.kind IN ('met_onsite', 'badge_scan') THEN ${S} + make_interval(days => (${C} % ${N})::int, hours => 1, mins => (${C} % 300)::int)
      ELSE ${S} - interval '17 days' + make_interval(days => (${C} % 4)::int, mins => (${C} % 300)::int) END
    FROM events e WHERE e.id = t.event_id AND ${past} AND t.contact_id IS NOT NULL`);
  // Replies: every stamp on the row moves with it; a reply still open on a finished event was answered by its owner that afternoon.
  await db.query(`UPDATE inbound_messages t SET received_at = n.at, decided_at = t.decided_at + (n.at - t.received_at), respond_by = t.respond_by + (n.at - t.received_at),
      handled_at = coalesce(t.handled_at + (n.at - t.received_at), CASE WHEN t.respond_by IS NOT NULL THEN n.at + interval '4 hours' END),
      handled_by = coalesce(t.handled_by, CASE WHEN t.respond_by IS NOT NULL THEN t.owner END), escalated_at = t.escalated_at + (n.at - t.received_at)
    FROM (SELECT t.id, CASE WHEN ${POST} THEN ${L} + interval '4 days' + make_interval(days => (${C} % 5)::int, mins => (${C} % 420)::int) ELSE ${reply(C)} END AS at FROM inbound_messages t JOIN events e ON e.id = t.event_id WHERE ${past} AND t.contact_id IS NOT NULL) n WHERE n.id = t.id`);
  await db.query(`UPDATE sequences s SET launched_at = CASE WHEN s.phase = 'post' THEN ${L} + interval '1 day' ELSE ${S} - interval '18 days' END
    FROM events e WHERE e.id = s.event_id AND ${past} AND s.launched_at IS NOT NULL`);
  await db.query(`UPDATE enrollments t SET added_at = ${S} - interval '21 days' + make_interval(days => (${C} % 3)::int, mins => (${C} % 240)::int), changed_at = ${S} - interval '17 days' + make_interval(days => (${C} % 4)::int, mins => (${C} % 300)::int)
    FROM events e WHERE e.id = t.event_id AND ${past}`);
  await db.query(`UPDATE enrollments t SET added_at = ${L} + interval '1 day', changed_at = ${L} + interval '1 day' + interval '2 hours'
    FROM events e, sequences x WHERE e.id = t.event_id AND x.id = t.sequence_id AND x.phase = 'post' AND ${past}`);
  await db.query(`UPDATE meetings t SET scheduled_at = n.at, outcome_at = CASE WHEN t.outcome_at IS NULL THEN NULL ELSE n.at + interval '45 minutes' END,
      reminded_at = CASE WHEN t.reminded_at IS NULL THEN NULL ELSE n.at - interval '1 day' END, created_at = n.booked
    FROM (SELECT t.id, ${meet(C, "t.timezone")} AS at, ${reply(C)} + interval '3 hours' AS booked FROM meetings t JOIN events e ON e.id = t.event_id WHERE ${past} AND t.contact_id IS NOT NULL) n WHERE n.id = t.id`);
  // A finished event leaves nothing booked: a meeting never recorded went unattended.
  await db.query(`UPDATE meetings t SET status = 'no_show', outcome_at = t.scheduled_at + interval '45 minutes' FROM events e WHERE e.id = t.event_id AND ${past} AND t.status = 'booked'`);
  // Ahead of an event: the same days, at ordinary hours.
  // Any event that has opened: its list was uploaded a month before, and its history runs in order from then until two weeks after it
  // closed (or until today while it is still following up), so no step of a March event says November.
  const T = `CASE WHEN ${past} OR (${LAST_DAY_SQL})::date < current_date - 14 THEN least(now(), ((${LAST_DAY_SQL})::date + 14 + time '15:00')::timestamptz) ELSE now() END`;
  await db.query(`UPDATE uploads u SET created_at = (e.starts_on::date - 30 + time '14:00')::timestamptz + make_interval(mins => (hashtext(u.id)::bigint & 2147483647)::int % 240)
    FROM events e WHERE e.id = u.event_id AND e.starts_on::date <= current_date`);
  // What the research spent (credits, model calls, stored answers reused) was spent when the list came in, over the days after, not
  // today: Usage's month and its pools read the right months.
  for (const t of ["credit_ledger", "llm_calls", "reuse_log"]) {
    await db.query(`UPDATE ${t} x SET created_at = (coalesce(p.starts_on, e.starts_on)::date - 30 + time '14:00')::timestamptz + make_interval(mins => ((hashtext(x.id::text)::bigint & 2147483647) % 7200)::int)
      FROM events e LEFT JOIN events p ON p.id = e.parent_event_id WHERE e.id = x.event_id AND e.starts_on::date <= current_date`);
  }
  await db.query(`UPDATE activity_log a SET created_at = r.at FROM (
      SELECT a.id, (e.starts_on::date - 30 + time '14:00')::timestamptz + (${T} - (e.starts_on::date - 30 + time '14:00')::timestamptz) * (row_number() OVER (PARTITION BY a.event_id ORDER BY a.created_at, a.id) - 1)::float8 / greatest(1, count(*) OVER (PARTITION BY a.event_id))::float8 AS at
      FROM activity_log a JOIN events e ON e.id = a.event_id WHERE e.starts_on::date <= current_date) r WHERE r.id = a.id`);
  await db.query(`UPDATE events e SET post_started_at = ((${LAST_DAY_SQL})::date + 1 + time '15:00')::timestamptz WHERE e.post_started_at IS NOT NULL AND e.starts_on::date <= current_date`);
  // Still following up: the sends went out before the event; each reply's steps carry its reply's own time.
  await db.query(`UPDATE touches t SET at = CASE WHEN t.kind = 'sequence_add' THEN ${S} - interval '21 days' + make_interval(days => (${C} % 3)::int, mins => (${C} % 240)::int) + CASE WHEN t.channel = 'linkedin' THEN interval '2 hours 17 minutes' ELSE interval '0' END
      ELSE ${S} - interval '17 days' + make_interval(days => (${C} % 4)::int + CASE WHEN t.channel = 'linkedin' THEN 1 ELSE 0 END + 3 * (coalesce(t.step, 1) - 1) + CASE WHEN t.action = 'message' OR t.kind = 'accepted' THEN 2 ELSE 0 END, mins => (${C} % 300)::int) END
    FROM events e WHERE e.id = t.event_id AND e.starts_on::date <= current_date AND NOT (${past}) AND t.kind IN ('sequence_add', 'send', 'accepted')`);
  await db.query(`UPDATE inbound_messages i SET received_at = i.received_at - make_interval(mins => ((hashtext(i.id)::bigint & 2147483647) % 1440)::int)
    FROM events e WHERE e.id = i.event_id AND e.starts_on::date <= current_date AND NOT (${past}) AND i.received_at > now() - interval '1 hour'`);
  await db.query(`UPDATE touches t SET at = i.received_at FROM inbound_messages i, events e WHERE e.id = t.event_id AND i.contact_id = t.contact_id AND i.event_id = t.event_id
    AND e.starts_on::date <= current_date AND NOT (${past}) AND t.kind LIKE 'reply_%'`);
  await db.query(`UPDATE touches t SET at = i.received_at + interval '3 hours' FROM inbound_messages i, events e WHERE e.id = t.event_id AND i.contact_id = t.contact_id AND i.event_id = t.event_id
    AND e.starts_on::date <= current_date AND NOT (${past}) AND t.kind = 'meeting_booked'`);
  // An event still ahead, already in outreach: people were added two weeks ago and emailed over the days after; each reply's steps sit at the reply,
  // a few hours apart; a reply arrived over the last day, not all in one minute. Nothing is dated after now.
  const ahead = "e.starts_on::date > current_date AND e.motion IN ('in_market', 'sequencing')";
  await db.query(`UPDATE touches t SET at = CASE WHEN t.kind = 'sequence_add' THEN now() - interval '14 days' + make_interval(days => (${C} % 2)::int, mins => (${C} % 240)::int) + CASE WHEN t.channel = 'linkedin' THEN interval '2 hours 17 minutes' ELSE interval '0' END
      ELSE now() - interval '11 days' + make_interval(days => (${C} % 4)::int + CASE WHEN t.channel = 'linkedin' THEN 1 ELSE 0 END + 3 * (coalesce(t.step, 1) - 1) + CASE WHEN t.action = 'message' OR t.kind = 'accepted' THEN 2 ELSE 0 END, mins => (${C} % 300)::int) END
    FROM events e WHERE e.id = t.event_id AND ${ahead} AND t.kind IN ('sequence_add', 'send', 'accepted')`);
  await db.query(`UPDATE inbound_messages i SET received_at = i.received_at - make_interval(mins => 60 + ((hashtext(i.id)::bigint & 2147483647) % 1380)::int)
    FROM events e WHERE e.id = i.event_id AND ${ahead} AND i.received_at > now() - interval '1 hour'`);
  await db.query(`UPDATE touches t SET at = i.received_at FROM inbound_messages i, events e WHERE e.id = t.event_id AND i.contact_id = t.contact_id AND i.event_id = t.event_id AND ${ahead} AND t.kind LIKE 'reply_%'`);
  await db.query(`UPDATE touches t SET at = least(now() - interval '5 minutes', i.received_at + interval '2 hours 40 minutes') FROM inbound_messages i, events e WHERE e.id = t.event_id AND i.contact_id = t.contact_id AND i.event_id = t.event_id AND ${ahead} AND t.kind = 'meeting_booked'`);
  // Walk-ups at an event that has happened and is still following up: on its days, at booth hours where it was.
  for (const ev of await db.query<{ id: string; n: number }>(`SELECT e.id, ${N} AS n FROM events e WHERE e.starts_on::date <= current_date AND NOT (${past})`)) {
    const tz = await eventZone((sql, args) => db.query(sql, args), ev.id);
    const H = "(hashtext(c.id)::bigint & 2147483647)";
    await db.query(`UPDATE onsite_captures c SET captured_at = ((e.starts_on::date + make_interval(days => (${H} % $2)::int))::timestamp + interval '10 hours' + make_interval(mins => (${H} % 420)::int)) AT TIME ZONE $3
      FROM events e WHERE e.id = c.event_id AND c.event_id = $1`, [ev.id, ev.n, tz]);
    await db.query("UPDATE meetings m SET scheduled_at = c.captured_at, outcome_at = c.captured_at + interval '30 minutes', timezone = $2 FROM onsite_captures c WHERE c.event_id = $1 AND m.external_key = 'onsite:' || c.id", [ev.id, tz]);
    await db.query("UPDATE touches t SET at = c.captured_at FROM onsite_captures c WHERE c.event_id = $1 AND t.event_id = $1 AND t.contact_id = c.contact_id AND t.kind IN ('met_onsite', 'badge_scan', 'meeting_held')", [ev.id]);
  }
  // Meetings after an event opened, still live: the same days, between 09:00 and 17:00 in the meeting's own zone.
  await db.query(`UPDATE meetings t SET scheduled_at = (date_trunc('day', t.scheduled_at AT TIME ZONE t.timezone) + interval '9 hours' + make_interval(mins => ((${C} / 7) % 16)::int * 30)) AT TIME ZONE t.timezone
    FROM events e WHERE e.id = t.event_id AND NOT (${past}) AND e.starts_on::date <= current_date AND t.contact_id IS NOT NULL AND t.source <> 'onsite'`);
  await db.query(`UPDATE onsite_captures t SET captured_at = (e.starts_on::date + time '14:00') + make_interval(days => ((hashtext(t.id)::bigint & 2147483647) % ${N})::int, mins => ((hashtext(t.id)::bigint & 2147483647) % 300)::int)
    FROM events e WHERE e.id = t.event_id AND ${past}`);
  // Costs are entered when they happen: what is booked ahead (sponsorship, booth, tools) weeks before the event, the rest just after it.
  await db.query(`UPDATE event_costs c SET recorded_at = CASE WHEN c.category IN ('sponsorship', 'booth', 'tools') THEN (e.starts_on::date - 24 + time '15:00')::timestamptz + make_interval(days => ((hashtext(c.id)::bigint & 2147483647) % 6)::int)
      ELSE least(now(), ((${LAST_DAY_SQL})::date + 2 + time '16:00')::timestamptz + make_interval(days => ((hashtext(c.id)::bigint & 2147483647) % 3)::int)) END
    FROM events e WHERE e.id = c.event_id AND e.starts_on::date <= current_date`);
  // And a meeting's own step sits at the meeting.
  await db.query(`UPDATE touches t SET at = m.scheduled_at + interval '45 minutes' FROM meetings m, events e WHERE e.id = t.event_id AND m.contact_id = t.contact_id AND m.event_id = t.event_id
    AND e.starts_on::date <= current_date AND NOT (${past}) AND t.kind LIKE 'meeting_%' AND t.kind <> 'meeting_booked'`);
  // A booth meeting is the booth conversation: same moment, the event's own zone, on every event, finished or not.
  await db.query("UPDATE meetings m SET scheduled_at = c.captured_at, outcome_at = CASE WHEN m.outcome_at IS NULL THEN NULL ELSE c.captured_at + interval '30 minutes' END FROM onsite_captures c WHERE m.external_key = 'onsite:' || c.id");
  await db.query("UPDATE touches t SET at = c.captured_at FROM onsite_captures c WHERE t.contact_id = c.contact_id AND t.event_id = c.event_id AND t.kind IN ('met_onsite', 'badge_scan')");
  // Last, so every date reads in order whatever moved above it.
  // An event still following up: its follow-up was added the day after it closed, sent over the days after, answered after that, never later than now.
  const LIVE = "e.starts_on::date <= current_date AND NOT (" + past + ")";
  await db.query(`UPDATE touches t SET at = least(now() - interval '1 hour', CASE
      WHEN t.kind = 'sequence_add' THEN ${L} + interval '1 day' + make_interval(mins => (${C} % 240)::int)
      ELSE ${L} + interval '1 day' + make_interval(days => (${C} % 3)::int + 3 * (coalesce(t.step, 1) - 1) + CASE WHEN t.action = 'message' OR t.kind = 'accepted' THEN 2 ELSE 0 END, mins => (${C} % 300)::int) END)
    FROM events e WHERE e.id = t.event_id AND ${LIVE} AND ${POST} AND t.kind IN ('sequence_add', 'send', 'accepted')`);
  await db.query(`UPDATE inbound_messages t SET received_at = least(now() - make_interval(mins => 30 + (${C} % 600)::int), ${L} + interval '4 days' + make_interval(days => (${C} % 5)::int, mins => (${C} % 420)::int))
    FROM events e WHERE e.id = t.event_id AND ${LIVE} AND ${POST} AND t.contact_id IS NOT NULL`);
  await db.query(`UPDATE touches t SET at = i.received_at FROM inbound_messages i, events e WHERE e.id = t.event_id AND i.contact_id = t.contact_id AND i.sequence_id = t.sequence_id AND ${LIVE} AND t.kind LIKE 'reply_%'`);
  // A sequence started when its first message went: pre-event ones before the event, follow-ups the day after it closed.
  await db.query(`UPDATE sequences s SET launched_at = sub.first FROM (SELECT t.sequence_id, min(t.at) - interval '2 hours' AS first FROM touches t WHERE t.kind = 'send' AND t.sequence_id IS NOT NULL GROUP BY 1) sub
    WHERE s.id = sub.sequence_id AND s.launched_at IS NOT NULL`);
  // An answer comes after the reply it answers, within the day it was due; a reply is due a day after it arrived.
  await db.query(`UPDATE inbound_messages SET respond_by = received_at + interval '1 day' WHERE respond_by IS NOT NULL AND (respond_by < received_at OR respond_by > received_at + interval '3 days')`);
  await db.query(`UPDATE inbound_messages SET handled_at = least(now() - interval '5 minutes', received_at + interval '4 hours') WHERE handled_at IS NOT NULL AND (handled_at < received_at OR handled_at > received_at + interval '7 days')`);
  // A meeting booked from a reply is after that reply: three days on, mid-afternoon where the meeting is.
  await db.query(`UPDATE meetings m SET scheduled_at = CASE WHEN m.status IN ('held', 'no_show') THEN least(now() - interval '2 hours', x.at) ELSE x.at END, outcome_at = CASE WHEN m.outcome_at IS NULL THEN NULL ELSE least(now() - interval '1 hour', x.at + interval '45 minutes') END
    FROM (SELECT m2.id, (date_trunc('day', (min(i.received_at) + interval '3 days') AT TIME ZONE coalesce(m2.timezone, 'UTC')) + interval '15 hours') AT TIME ZONE coalesce(m2.timezone, 'UTC') AS at
          FROM meetings m2 JOIN inbound_messages i ON i.contact_id = m2.contact_id AND i.signal = 'reply' WHERE m2.source = 'reply' GROUP BY m2.id, m2.timezone, m2.scheduled_at HAVING min(i.received_at) > m2.scheduled_at) x
    WHERE m.id = x.id`);
  await db.query(`UPDATE touches t SET at = m.scheduled_at + interval '45 minutes' FROM meetings m WHERE m.contact_id = t.contact_id AND m.event_id = t.event_id AND m.source = 'reply' AND t.kind LIKE 'meeting_%' AND t.kind <> 'meeting_booked' AND t.at < m.scheduled_at`);
}
