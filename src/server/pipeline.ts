/* Runs the paid stages. One job is one paid item. Each paid call is reserve,
   call, settle, because a transaction cannot wrap an external call. */

import { priceIfReady } from "./research.ts";
import { getSettingsNow } from "./approvals.ts";
import { fuzzyListCases } from "./research.ts";
import { dropAtCompany, dropContact, enqueue } from "./work.ts";
import type { Db } from "./db.ts";
import { logActivity, moveEvent, moveWithin, newId, TopUpClosed } from "./events.ts";
import { publishSheet } from "./sheet-delivery.ts";
import { writePerspective } from "./perspective-run.ts";
import { mockSheets, type SheetPublisher } from "./sheets.ts";
import { assertRealRunAllowed, SpendGuardError } from "./spend-guard.ts";
import { fill } from "./prompts.ts";
import { companyContext, companyTierWithIcp, pinnedIcp, pinnedIcpQ, spreadFor } from "./tiering.ts";
import { checkAccounts, checkAddress, checkPeople, CRM_DOWN_WORDS, crmConnected, CrmDown } from "./crm-checks.ts";
import { queueDeliveredEmails } from "./crm-outbox.ts";
import { afterMerge, mergeTopUp } from "./top-up.ts";
import { emailJob } from "./email.ts";
import { linkQuietly } from "./person-record.ts";
import { openLaterCases } from "./later-cases.ts";
import { adjusted, companyFactsOf, peopleSearchJob, readAttendeeTitles, titleTierWithIcp } from "./people.ts";
import { attempt, decide, paidVendor, PauseSignal, withVendorWait, type Ctx, type Job } from "./paid.ts";
import { mockCrm, mockIdentity, VendorError, type Crm, type Llm, type Vendors } from "./providers.ts";
import { attachReverse, dbReveals, finishIdentity, applyResolution, loadIdentityInput, resolveCompany, type ResolveEnv } from "./identity.ts";
import { domainsForName, getFinderResult, getLinkedinResult, isOptedOut, logReuse, putLinkedinResult } from "./caches.ts";
import { VendorDown, VendorHealth, UNLIMITED, type GuardConfig } from "./vendor-health.ts";
import { titleRule, type Settings, type Tier } from "../shared/cost.ts";
import { cleanLinkedin, companyKey, labelFromDomain } from "../shared/ingest.ts";
import { emailDomain, isFreeWebmail, isPlaceholderDomain, isWebmailTypo } from "../shared/layer0.ts";
import type { Flow } from "../shared/domain.ts";
import { vendorWords } from "../shared/vendors.ts";
import { nameKey } from "../shared/email.ts";
import { priority, validCompanyTier, validFlags, validTier, verifyOutcome, type Verdict } from "../shared/tiers.ts";

/** `crm` is free and read-only, so it sits outside the ledger. It defaults to the mock. */
export interface Deps {
  llm: Llm;
  vendorsFor: (s: Settings) => Vendors; crm?: Crm; sheets?: SheetPublisher;
  /** True when the model or vendors are real. A live run is capped by REAL_RUN_MAX_ROWS before any paid call. */
  live?: boolean;
  /** Breakers, rate limits and throttling detection for the identity vendors. Defaults to one per Deps object, with no pacing outside live mode. */
  health?: VendorHealth;
}

const healths = new WeakMap<Deps, VendorHealth>();
/** One VendorHealth per Deps object, so a breaker that opened in one pass is still open in the next. Live mode paces itself; the mocks and the simulated vendors do not. */
function healthFor(deps: Deps): VendorHealth {
  if (deps.health) return deps.health;
  let h = healths.get(deps);
  if (!h) { h = new VendorHealth({ config: deps.live ? undefined : (UNLIMITED as Partial<GuardConfig>) }); healths.set(deps, h); }
  return h;
}
const STAGE_KINDS: Record<string, string> = {
  tiering: "company_tier,title_tier", enriching: "discovery,find,verify,linkedin", flagging: "flag",
  // Two-card flow. Research pays identity, reverse lookups and company tiering under the Research card. Ready for review still runs company_tier jobs, because a
  // company settled by a person finishes its research at once. Finding people pays title tiers, then the people steps, under the Outreach card.
  researching: "identity,reverse,company_tier", ready_for_review: "company_tier", finding_people: "title_tier,discovery,find,verify,linkedin",
};
const LEASE = "2 minutes";
const SYSTEM = "Events Desk";

/* -------------------------------------------------------------- stages */

async function startTiering(db: Db, eventId: string, s: Settings) {
  await db.tx(async (q) => {
    const [e] = await q<{ tiering_started: boolean }>("SELECT tiering_started FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (e.tiering_started) return;
    await q("UPDATE events SET tiering_started = true WHERE id = $1", [eventId]);
    // Rows that came in with an email or LinkedIn and no company would need a reverse lookup, which the single-card flow does not do.
    await q("UPDATE contacts SET drop_reason = 'no_company', dropped_at = now() WHERE event_id = $1 AND company_id IS NULL AND dropped_at IS NULL", [eventId]);
    const excluded = new Set(s.excluded_companies.map(companyKey));
    const customers = new Set(s.existing_customers.map(companyKey));
    for (const co of await q<{ id: string; key: string; list_status: string | null }>("SELECT id, key, list_status FROM companies WHERE event_id = $1", [eventId])) {
      // The CRM check before this already excluded it.
      if (co.list_status === "excluded") continue;
      if (excluded.has(co.key)) {
        await q("UPDATE companies SET list_status = 'excluded' WHERE id = $1", [co.id]);
        await dropAtCompany(q, eventId, co.id, "excluded_company");
      } else if (customers.has(co.key)) {
        await q("UPDATE companies SET list_status = 'existing_customer' WHERE id = $1", [co.id]);
        await dropAtCompany(q, eventId, co.id, "existing_customer");
      } else await enqueue(q, eventId, "company_tier", { company_id: co.id });
    }
    for (const { title_key } of await q<{ title_key: string }>("SELECT DISTINCT lower(title) AS title_key FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND title IS NOT NULL", [eventId])) {
      const tier = titleRule(title_key, s.title_keywords);
      if (tier) await q("INSERT INTO title_tiers (event_id, title_key, tier, reason, source) VALUES ($1, $2, $3, 'keyword_table', 'rule') ON CONFLICT DO NOTHING", [eventId, title_key, tier]);
      else await enqueue(q, eventId, "title_tier", { title_key });
    }
  });
}

/** Reads account owner, open deal, last activity and heat for every company that is
    not excluded. Free, so no reservation. A CRM failure leaves the company blank and
    never stops the list: the workbook shows "Unknown" where the CRM had nothing. */
async function syncCrm(c: Ctx) {
  const crm = c.deps.crm ?? mockCrm;
  const asOf = new Date().toISOString().slice(0, 10);
  const companies = await c.db.query<{ id: string; name: string }>(
    "SELECT id, name FROM companies WHERE event_id = $1 AND heat IS NULL AND in_research AND inherited_from IS NULL AND list_status IS DISTINCT FROM 'excluded' ORDER BY name", [c.eventId]);
  let failed = 0;
  for (const co of companies) {
    try {
      const a = await crm.lookup(co.name, asOf);
      await c.db.query("UPDATE companies SET account_owner = $2, deal_name = $3, deal_stage = $4, last_activity = $5, heat = $6 WHERE id = $1",
        [co.id, a.owner, a.deal_name, a.deal_stage, a.last_activity, a.heat]);
    } catch { failed++; }
  }
  if (failed) await c.db.tx((q) => logActivity(q, c.eventId, SYSTEM, "crm", `${crm.name} had no answer for ${failed} of ${companies.length} companies`));
}

/** Sets every priority, drops C, and queues discovery or the email loop for the rest. `twoCard` leaves the stage move to the caller. */
async function finishTiering(db: Db, eventId: string, s: Settings, twoCard = false) {
  // With a pinned ICP the title tier is adjusted per person by the company's type and size (title adjustments in the ICP).
  const pin = twoCard ? await pinnedIcp(db, eventId) : null;
  await db.tx(async (q) => {
    const contacts = await q<{ id: string; tier: Tier; title_tier: Tier | null; email: string | null; func: string | null; seniority: string | null; non_buyer: boolean | null; company_type: string | null; segment: string | null; firmo: { employees?: number | null } | null }>(
      `SELECT c.id, co.tier, t.tier AS title_tier, c.email, t.func, t.seniority, t.non_buyer, co.company_type, co.segment, co.firmo FROM contacts c JOIN companies co ON co.id = c.company_id
       LEFT JOIN title_tiers t ON t.event_id = c.event_id AND t.title_key = lower(c.title)
       WHERE c.event_id = $1 AND c.dropped_at IS NULL AND co.tier IS NOT NULL`, [eventId]);
    for (const c of contacts) {
      let titleTier = c.title_tier;
      if (pin && titleTier !== null && c.func && c.seniority) {
        titleTier = adjusted(pin, { parsed: { function: c.func as never, seniority: c.seniority as never, non_buyer: c.non_buyer === true, former: false, placed: true }, base: titleTier, via: "rules" }, companyFactsOf(c));
      }
      const p = priority(c.tier, titleTier);
      await q("UPDATE contacts SET priority = $2, title_tier = $3 WHERE id = $1", [c.id, p, titleTier]);
      if (p === "C") await q("UPDATE contacts SET drop_reason = 'low_tier', dropped_at = now() WHERE id = $1", [c.id]);
      else await enqueue(q, eventId, c.email ? "verify" : "find", c.email ? { contact_id: c.id, index: 0 } : { contact_id: c.id, index: 0, errored: false });
    }
    // A company whose tier is still Unknown never becomes a priority. Nothing is paid for its people; they stop here with a reason.
    if (twoCard) {
      // A copy of a parent company carries the reason the parent's people got. Anything else failed here.
      const reason = "coalesce((SELECT co.inherited_drop FROM companies co WHERE co.id = company_id), 'tiering_failed')";
      await q(`UPDATE contacts SET drop_reason = ${reason}, dropped_at = now() WHERE event_id = $1 AND dropped_at IS NULL AND priority IS NULL AND company_id IN (SELECT id FROM companies WHERE event_id = $1 AND tier IS NULL)`, [eventId]);
      await q(`UPDATE source_rows SET drop_reason = ${reason}, dropped_at = now() WHERE event_id = $1 AND dropped_at IS NULL AND kind = 'company_only' AND priority IS NULL AND company_id IN (SELECT id FROM companies WHERE event_id = $1 AND tier IS NULL)`, [eventId]);
    }
    const rows = await q<{ id: string; tier: Tier }>(
      "SELECT r.id, co.tier FROM source_rows r JOIN companies co ON co.id = r.company_id WHERE r.event_id = $1 AND r.kind = 'company_only' AND r.dropped_at IS NULL AND co.tier IS NOT NULL", [eventId]);
    for (const r of rows) {
      const p = priority(r.tier, null);
      await q("UPDATE source_rows SET priority = $2 WHERE id = $1", [r.id, p]);
      if (p === "C") await q("UPDATE source_rows SET drop_reason = 'low_tier', dropped_at = now() WHERE id = $1", [r.id]);
      else await enqueue(q, eventId, "discovery", { source_row_id: r.id });
    }
    if (s.add_prospects) {
      // Buyer titles at attending companies. Companies that are low tier or on a list get no spend.
      const attending = await q<{ company_id: string; source_row_id: string }>(
        `SELECT DISTINCT ON (c.company_id) c.company_id, c.source_row_id FROM contacts c JOIN companies co ON co.id = c.company_id
         WHERE c.event_id = $1 AND co.tier IN (1, 2) AND co.list_status IS NULL AND co.inherited_from IS NULL
           AND NOT EXISTS (SELECT 1 FROM source_rows r WHERE r.company_id = c.company_id AND r.kind = 'company_only' AND r.dropped_at IS NULL)
         ORDER BY c.company_id, c.id`, [eventId]);
      for (const a of attending) await enqueue(q, eventId, "discovery", { source_row_id: a.source_row_id, company_id: a.company_id, add: true });
    }
    if (twoCard) await q("UPDATE events SET phase = 'people' WHERE id = $1", [eventId]);
    else await moveWithin(q, eventId, "enriching", SYSTEM, { detail: "Tiering finished" });
  });
}

/* ---------------------------------------------------- the two-card flow's seam
   STUB SEAM. Build-order steps 5 to 7 replace what runs between the two cards: identity, firmographics, the ICP,
   company tiering with Unknown and a second look, people search, ranking. Until then research is today's company
   tiering, run under the Research card, and the people steps are today's discovery, finders and verifiers, run under
   the Outreach card. The money rules do not depend on the stub: every call below names its step, reserves against the
   approved card that lists that step, and is held to that step's cap. */

async function startResearch(db: Db, eventId: string, _s: Settings) {
  await db.tx(async (q) => {
    const [e] = await q<{ research_started: boolean }>("SELECT research_started FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (e.research_started) return;
    await q("UPDATE events SET research_started = true, phase = 'identity' WHERE id = $1", [eventId]);
    // Stage 4. A person who came in with an email or a LinkedIn profile and no company gets one reverse lookup, under the Research card.
    // With neither there is nothing to look up with.
    await q("UPDATE contacts SET drop_reason = 'no_company', dropped_at = now() WHERE event_id = $1 AND company_id IS NULL AND dropped_at IS NULL AND email IS NULL AND linkedin IS NULL", [eventId]);
    for (const c of await q<{ id: string }>("SELECT id FROM contacts WHERE event_id = $1 AND company_id IS NULL AND dropped_at IS NULL ORDER BY id", [eventId])) await enqueue(q, eventId, "reverse", { contact_id: c.id });
    // Identity for every company the file's own evidence did not settle. Exact-name list matches already ran before the card.
    for (const co of await q<{ id: string }>("SELECT id FROM companies WHERE event_id = $1 AND in_research AND list_status IS NULL AND identity_state <> 'resolved' ORDER BY name", [eventId])) await enqueue(q, eventId, "identity", { company_id: co.id });
  });
}

/** After the Outreach card is approved: queue the title tiers the free pass could not decide. Priorities follow when they are done. */
async function startPeople(db: Db, eventId: string) {
  await db.tx(async (q) => {
    const [e] = await q<{ phase: string | null }>("SELECT phase FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (e.phase) return;
    await q("UPDATE events SET phase = 'titles' WHERE id = $1", [eventId]);
    // With a pinned ICP the rules in code read every attendee title first (readAttendeeTitles, below); only what they cannot place is queued for the model.
    if (await pinnedIcpQ(q, eventId)) return;
    for (const { title_key } of await q<{ title_key: string }>(
      `SELECT DISTINCT lower(c.title) AS title_key FROM contacts c LEFT JOIN title_tiers t ON t.event_id = c.event_id AND t.title_key = lower(c.title)
       WHERE c.event_id = $1 AND c.dropped_at IS NULL AND c.title IS NOT NULL AND t.title_key IS NULL`, [eventId])) await enqueue(q, eventId, "title_tier", { title_key });
  });
}

/** With a pinned ICP, after startPeople has set the phase: read the attendee titles with rules, queue the rest for the model. Once. */
async function startPersonaTitles(db: Db, eventId: string) {
  const pin = await pinnedIcp(db, eventId);
  if (!pin) return;
  const [e] = await db.query<{ phase: string | null; titles_read: boolean }>("SELECT phase, titles_read FROM events WHERE id = $1", [eventId]);
  if (e.phase !== "titles" || e.titles_read) return;
  await readAttendeeTitles(db, eventId, pin);
}

/* ----------------------------------------------------------- CRM do not contact
   A pause is only caught around job handlers, so each check below runs inside crmGate. They run outside every transaction, and the marker is set only after the check has succeeded. */

/** False when the CRM could not answer and the event has paused. The check may be asked again as it stands: nothing was written. */
async function crmGate(c: Ctx, run: () => Promise<unknown>) {
  try { await run(); return true; }
  catch (e) {
    if (!(e instanceof CrmDown)) throw e;
    await moveEvent(c.db, c.eventId, "paused", SYSTEM, { detail: CRM_DOWN_WORDS });
    return false;
  }
}

/** The first step of a run, before anything is paid. People only in the two-card flow: almost no domain is known yet, so accounts are checked at the domain gates in finishIdentity. */
async function crmAtStart(c: Ctx) {
  const crm = c.deps.crm;
  if (!crmConnected(crm)) return;
  const [{ done }] = await c.db.query<{ done: boolean }>("SELECT crm_start_checked AS done FROM events WHERE id = $1", [c.eventId]);
  if (done) return;
  await checkPeople(c.db, crm, c.eventId);
  if (c.flow === "single_card") await checkAccounts(c.db, crm, c.eventId, "named");
  else if (!c.settings.add_prospects) {
    // A company whose only people were just removed needs no research, the same rule the free pass applies.
    await c.db.query(
      `UPDATE companies SET in_research = false WHERE event_id = $1 AND in_research AND inherited_from IS NULL
         AND NOT EXISTS (SELECT 1 FROM contacts k WHERE k.company_id = companies.id AND k.dropped_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM source_rows r WHERE r.company_id = companies.id AND r.kind = 'company_only' AND r.dropped_at IS NULL)`, [c.eventId]);
  }
  await c.db.query("UPDATE events SET crm_start_checked = true WHERE id = $1", [c.eventId]);
}

/** A company a person settled through a case got its domain after the gates in finishIdentity. Nothing is searched or paid for there until it has been asked about. */
async function crmBeforeOutreach(c: Ctx) {
  if (crmConnected(c.deps.crm)) await checkAccounts(c.db, c.deps.crm, c.eventId, "resolved");
}

/** The last thing before delivery, and before openLaterCases, so someone flagged here never becomes a case or a Review row. */
async function crmBeforeDelivery(c: Ctx) {
  const crm = c.deps.crm;
  if (!crmConnected(crm)) return;
  const [{ done }] = await c.db.query<{ done: boolean }>("SELECT crm_final_checked AS done FROM events WHERE id = $1", [c.eventId]);
  if (done) return;
  await checkAccounts(c.db, crm, c.eventId, "live");
  await checkPeople(c.db, crm, c.eventId);
  await c.db.query("UPDATE events SET crm_final_checked = true WHERE id = $1", [c.eventId]);
}

/** The single-card flow's stop before a paid step: our own opt-outs, then the CRM's. Returns the drop reason, or null. A CRM that cannot answer raises CrmDown, which the job loop turns into a pause. */
async function stopReason(c: Ctx, contactId: string, p: { email: string | null; full_name: string | null; company: string; company_key: string; domain: string | null }) {
  if (await isOptedOut(c.db, { email: p.email, name_key: p.full_name ? nameKey(p.full_name) : null, company_key: p.company_key })) return "opted_out";
  if (!crmConnected(c.deps.crm)) return null;
  return (await checkAddress(c.db, c.deps.crm, { id: contactId, full_name: p.full_name, company: p.company, domain: p.domain }, p.email)).reason;
}

/* ---------------------------------------------------------------- jobs */

/** Company tier. An event with a pinned ICP is tiered by tiering.ts: firmographics, hard rules, Unknown, the baseline and the second look.
    An event with none keeps the older flow: one prompt over the settings text and the file's own columns, with one retry. It has no Unknown,
    so an answer that cannot tell is tier 2, the "too little information" tier it always was. */
async function companyTier(c: Ctx, job: Job, lost: boolean) {
  const pin = await pinnedIcp(c.db, c.eventId);
  if (pin) return companyTierWithIcp(c, job, lost, pin);
  const { company_id } = job.payload;
  const fail = async (reason: string) => c.db.tx((q) => dropAtCompany(q, c.eventId, company_id, reason));
  if (lost) return fail("tiering_failed");
  const [co] = await c.db.query<{ name: string }>("SELECT name FROM companies WHERE id = $1", [company_id]);
  const context = await companyContext(c.db, c.eventId, company_id);
  const input = [`Company: ${co.name}`, ...context].join("\n");
  const r = await decide(c, "company_tier", fill("company_tier", { icp: c.settings.icp, segments: "none", company_types: "none", input }), (v) => validCompanyTier(v, { citable: context, requireFact: false }));
  if (r.kind === "refused") return fail("budget_cap");
  if (r.kind === "error") return fail("tiering_failed");
  const a = r.value;
  await c.db.query("UPDATE companies SET tier = $2, tier_reason = $3 WHERE id = $1", [company_id, a.tier ?? 2, a.tier === null ? "insufficient_information" : a.reason]);
}

async function titleTier(c: Ctx, job: Job, lost: boolean) {
  const pin = await pinnedIcp(c.db, c.eventId);
  if (pin) return titleTierWithIcp(c, job, lost, pin);
  const { title_key } = job.payload;
  const fail = (reason: string) => c.db.query("UPDATE contacts SET drop_reason = $3, dropped_at = now() WHERE event_id = $1 AND lower(title) = $2 AND dropped_at IS NULL", [c.eventId, title_key, reason]);
  if (lost) return fail("tiering_failed");
  const r = await decide(c, "title_tier", fill("title_tier", { targets: c.settings.target_titles.join(", "), input: `Title: ${title_key}` }), validTier);
  if (r.kind === "refused") return fail("budget_cap");
  if (r.kind === "error") return fail("tiering_failed");
  await c.db.query("INSERT INTO title_tiers (event_id, title_key, tier, reason, source) VALUES ($1, $2, $3, $4, 'llm')", [c.eventId, title_key, r.value.tier, r.value.reason]);
}

async function identityJob(c: Ctx, job: Job, lost: boolean) {
  const { company_id } = job.payload;
  const loaded = await loadIdentityInput(c.db, company_id);
  if (!loaded) return;
  const [now] = await c.db.query<{ identity_state: string }>("SELECT identity_state FROM companies WHERE id = $1", [company_id]);
  if (now.identity_state === "resolved") return;
  // A worker that died may have paid for a person match whose answer was lost. A person decides; the company is not silently dropped.
  if (lost) return applyResolution(c.db, c.eventId, loaded.company, { state: "not_found", person_match: "error", note: "A worker stopped while this company was being checked, so a paid lookup may or may not have run. Nothing was repeated." });
  const ident = c.vendors.identity ?? mockIdentity(c.settings);
  const pm = ident.personMatch;
  const env: ResolveEnv = {
    health: c.health, identity: ident, country: c.country, reveals: dbReveals(c.db, c.settings.limits.freshness_days, c.eventId),
    domainsForName: (k) => domainsForName(c.db, k, c.settings.limits),
    beforePay: () => c.health.guard(pm.name).assertAvailable(),
    onReused: (at, by) => logReuse(c.db.query, c.eventId, { target: company_id, step: "person_match", vendor: pm.name, unit: "credits", n: pm.cost, answered_at: at, answered_by: by }),
    pay: (run) => paidVendor(c, "person_match", pm.name, pm.cost, "credits", run),
  };
  const r = await withVendorWait(c, () => resolveCompany(env, loaded.input));
  await attempt(c, company_id, ident.companySearch.name, "identity", `${r.state}${r.via ? ` via ${r.via}` : ""}`);
  await applyResolution(c.db, c.eventId, loaded.company, r);
}

async function reverseJob(c: Ctx, job: Job, lost: boolean) {
  const { contact_id } = job.payload;
  const drop = (reason = "no_company") => dropContact(c.db, contact_id, reason);
  if (lost) return drop();
  const [p] = await c.db.query<{ email: string | null; linkedin: string | null }>("SELECT email, linkedin FROM contacts WHERE id = $1 AND company_id IS NULL AND dropped_at IS NULL", [contact_id]);
  if (!p) return;
  const rv = (c.vendors.identity ?? mockIdentity(c.settings)).reverse;
  const g = c.health.guard(rv.name);
  // One lookup per person, as the card prices: the email when there is one, else the profile.
  const byEmail = Boolean(p.email);
  const r = await withVendorWait(c, async () => {
    g.assertAvailable();
    return paidVendor(c, "reverse_lookup", rv.name, rv.cost, "credits", async () => {
      const o = await g.call(() => (byEmail ? rv.byEmail(p.email!) : rv.byLinkedin(p.linkedin!)), { paid: true });
      return { value: o, charged: o.charged };
    });
  });
  if (r.kind === "refused") return drop("budget_cap");
  if (r.kind === "error") return drop("vendor_error");
  await attempt(c, contact_id, rv.name, "reverse_lookup", r.value.company ? "found" : "miss");
  if (r.value.company) { if (!(await attachReverse(c.db, c.eventId, contact_id, r.value.company, "reverse_lookup", r.value.person))) return drop(); return; }
  // The lookup knew nothing, but a work address still says where the person works.
  const d = p.email ? emailDomain(p.email) : null;
  if (d && !isFreeWebmail(d) && !isWebmailTypo(d) && !isPlaceholderDomain(d) && await attachReverse(c.db, c.eventId, contact_id, { name: labelFromDomain(d), domain: d }, "email_domain", r.value.person, true)) return;
  return drop();
}

async function discovery(c: Ctx, job: Job, lost: boolean) {
  // The two-card flow searches for free (people.ts); the single-card flow keeps the paid discovery below.
  if (c.flow === "two_card") return peopleSearchJob(c, job, lost);
  const { source_row_id } = job.payload;
  const adding = job.payload.add === true;
  // A failed prospect search costs the row nothing: its attendee is still on the list.
  const dropRow = async (reason: string) => { if (!adding) await c.db.query("UPDATE source_rows SET drop_reason = $2, dropped_at = now() WHERE id = $1", [source_row_id, reason]); };
  if (lost) return dropRow("vendor_error");
  const [row] = await c.db.query<{ company_id: string; name: string; priority: string; tier: Tier }>("SELECT r.company_id, co.name, r.priority, co.tier FROM source_rows r JOIN companies co ON co.id = r.company_id WHERE r.id = $1", [source_row_id]);
  const v = c.vendors.discovery;
  // The single-card flow uses contacts per company; the two-card flow's quotas live in people.ts.
  const limit = c.settings.contacts_per_company;
  const r = await paidVendor(c, "discovery", v.name, v.cost * limit, "credits", async () => { const o = await v.find(row.name, limit); return { value: o.people, charged: o.charged }; });
  if (r.kind === "refused") return dropRow("budget_cap");
  if (r.kind === "error") return dropRow("vendor_error");
  await attempt(c, source_row_id, v.name, "discovery", `${r.value.length} found`);
  if (!r.value.length) return dropRow("no_people_found");
  await c.db.tx(async (q) => {
    for (const p of r.value.slice(0, limit)) {
      const titleTier = titleRule(p.title, c.settings.title_keywords);
      const known = await q("SELECT 1 FROM contacts WHERE company_id = $1 AND lower(full_name) = lower($2) LIMIT 1", [row.company_id, p.full_name]);
      if (known.length) continue;
      const rank = adding ? priority(row.tier, titleTier) : row.priority;
      if (rank === "C") continue;
      const id = newId("con");
      await q("INSERT INTO contacts (id, event_id, source_row_id, company_id, full_name, title, priority, title_tier, linkedin, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'prospect')", [id, c.eventId, source_row_id, row.company_id, p.full_name, p.title, rank, titleTier, cleanLinkedin(p.linkedin)]);
      await enqueue(q, c.eventId, "find", { contact_id: id, index: 0, errored: false });
    }
  });
}

async function find(c: Ctx, job: Job, lost: boolean) {
  const { contact_id, index } = job.payload;
  let errored = Boolean(job.payload.errored) || lost;
  const finder = c.vendors.finders[index];
  let email: string | null = null;
  if (!lost) {
    const [p] = await c.db.query<{ full_name: string | null; company: string; company_key: string; domain: string | null }>("SELECT c.full_name, co.name AS company, co.key AS company_key, co.primary_domain AS domain FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.id = $1", [contact_id]);
    const stop = await stopReason(c, contact_id, { ...p, email: null });
    if (stop) return dropContact(c.db, contact_id, stop);
    const r = await paidVendor(c, "find", finder.name, finder.cost, "credits", async () => { const o = await finder.find(p); return { value: o, charged: o.charged }; });
    if (r.kind === "refused") return dropContact(c.db, contact_id, "budget_cap");
    if (r.kind === "error") errored = true;
    else {
      email = r.value.value;
      // A profile the finder returned is kept even when it found no email.
      const url = cleanLinkedin(r.value.linkedin);
      if (url) await c.db.query("UPDATE contacts SET linkedin = coalesce(linkedin, $2) WHERE id = $1", [contact_id, url]);
    }
    await attempt(c, contact_id, finder.name, "find", r.kind === "error" ? "error" : email ? "found" : "miss");
  }
  if (email) {
    return c.db.tx(async (q) => {
      // Two people can resolve to one address, and one person can be both listed and discovered.
      const taken = await q("SELECT 1 FROM contacts WHERE event_id = $1 AND email = $2 AND id <> $3 AND dropped_at IS NULL LIMIT 1", [c.eventId, email, contact_id]);
      if (taken.length) { await q("UPDATE contacts SET drop_reason = 'duplicate', dropped_at = now() WHERE id = $1", [contact_id]); return; }
      await q("UPDATE contacts SET email = $2, email_source = $3 WHERE id = $1", [contact_id, email, finder.name]);
      await enqueue(q, c.eventId, "verify", { contact_id, index: 0 });
    });
  }
  if (index + 1 < c.vendors.finders.length) return c.db.tx((q) => enqueue(q, c.eventId, "find", { contact_id, index: index + 1, errored }));
  return dropContact(c.db, contact_id, errored ? "vendor_error" : "no_email_found");
}

async function verify(c: Ctx, job: Job, lost: boolean) {
  const { contact_id, index } = job.payload;
  const v = c.vendors.verifiers[index];
  let verdict: Verdict = "unknown";
  if (!lost) {
    const [p] = await c.db.query<{ email: string; full_name: string | null; company: string; company_key: string; domain: string | null }>("SELECT c.email, c.full_name, co.name AS company, co.key AS company_key, co.primary_domain AS domain FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.id = $1", [contact_id]);
    const stop = await stopReason(c, contact_id, p);
    if (stop) return dropContact(c.db, contact_id, stop);
    const r = await paidVendor(c, "verify", v.name, v.cost, "credits", async () => { const o = await v.verify(p.email); return { value: o.verdict, charged: o.charged }; });
    if (r.kind === "refused") return dropContact(c.db, contact_id, "budget_cap");
    if (r.kind === "ok") verdict = r.value;
    await attempt(c, contact_id, v.name, "verify", r.kind === "ok" ? r.value : "error");
  }
  await c.db.query(`UPDATE contacts SET verify_${index === 0 ? 1 : 2} = $2 WHERE id = $1`, [contact_id, verdict]);
  if (verdict === "undeliverable") return dropContact(c.db, contact_id, "not_deliverable");
  // An email that is not certainly valid is invalid: catch-all, unknown and a verifier error all drop the contact.
  // Stopping at the first such answer also saves the second verifier's credit.
  // The owner's default: a catch-all domain cannot confirm anyone, and is reported as a gap rather than hidden among other unconfirmed emails.
  if (verdict !== "deliverable") return dropContact(c.db, contact_id, verdict === "catch_all" && c.flow === "two_card" ? "catch_all_unconfirmed" : "email_unconfirmed");
  // With one verifier configured its pass is the check, and the Sheet says "Verified once". With two, both must agree.
  if (index + 1 < c.vendors.verifiers.length) return c.db.tx((q) => enqueue(q, c.eventId, "verify", { contact_id, index: index + 1 }));
  const [row] = await c.db.query<{ verify_1: Verdict; verify_2: Verdict; linkedin: string | null }>("SELECT verify_1, verify_2, linkedin FROM contacts WHERE id = $1", [contact_id]);
  if (c.vendors.verifiers.length > 1 && verifyOutcome(row.verify_1, row.verify_2) !== "keep") return dropContact(c.db, contact_id, "email_unconfirmed");
  await c.db.tx(async (q) => {
    // Kept, verified, and still no profile: one paid lookup, then the flag step.
    await enqueue(q, c.eventId, row.linkedin ? "flag" : "linkedin", { contact_id });
  });
  await linkQuietly(c.db, contact_id, { verified: true });
}

/** One paid LinkedIn lookup. It never drops the contact: a refusal, an error, an empty answer or a lost worker
    all move on to flagging, and a call with an unknown outcome is never repeated. */
async function linkedin(c: Ctx, job: Job, lost: boolean) {
  const { contact_id } = job.payload;
  if (!lost) {
    const [p] = await c.db.query<{ full_name: string | null; title: string | null; email: string | null; company: string; company_key: string; linkedin: string | null; dropped_at: string | null }>(
      "SELECT c.full_name, c.title, c.email, c.linkedin, c.dropped_at, co.name AS company, co.key AS company_key FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.id = $1", [contact_id]);
    // Opted out or dropped while waiting in the queue: nothing more is paid for them.
    if (p?.dropped_at) return;
    if (p && !p.linkedin) {
      const v = c.vendors.linkedin;
      const nk = p.full_name ? nameKey(p.full_name) : null;
      /** Apollo's Verified on the very address this person is listed under is that address's second check, which is what turns "Verified once" into "Verified twice". */
      const secondCheck = async (verified: string | null | undefined) => { if (verified && p.email && verified.toLowerCase() === p.email.toLowerCase()) await c.db.query("UPDATE contacts SET verify_2 = 'deliverable' WHERE id = $1 AND verify_1 = 'deliverable' AND verify_2 IS NULL", [contact_id]); };
      const stored = nk ? await getLinkedinResult(c.db, nk, p.company_key, c.settings.limits) : null;
      // The same Apollo record may already have been bought to find the email. Its answer stands, found or not.
      const f = c.vendors.finders[0];
      const known = !stored && nk && f && f.name.startsWith("apollo") && v.name.startsWith("apollo") ? await getFinderResult(c.db, f.name, nk, p.company_key, c.settings.limits) : null;
      if (known) await secondCheck(known.apollo_verified ? known.email : null);
      else if (stored) {
        const url = cleanLinkedin(stored.linkedin);
        if (url) await c.db.query("UPDATE contacts SET linkedin = $2 WHERE id = $1 AND linkedin IS NULL", [contact_id, url]);
        await secondCheck(stored.verified_email);
        // A stored miss saved nothing: Apollo does not charge for a match that finds nobody.
        if (url) await logReuse(c.db.query, c.eventId, { target: contact_id, step: "linkedin", vendor: v.name, unit: "credits", n: v.cost, answered_at: stored.fetched_at, answered_by: stored.event_id });
      } else {
        const r = await paidVendor(c, "linkedin", v.name, v.cost, "credits", async () => { const o = await v.find(p); return { value: o, charged: o.charged }; });
        const url = r.kind === "ok" ? cleanLinkedin(r.value.value) : null;
        if (url) await c.db.query("UPDATE contacts SET linkedin = $2 WHERE id = $1 AND linkedin IS NULL", [contact_id, url]);
        if (r.kind === "ok") { await secondCheck(r.value.verified_email); if (nk) await putLinkedinResult(c.db, nk, p.company_key, url, r.value.verified_email ?? null, c.eventId); }
        await attempt(c, contact_id, v.name, "linkedin", r.kind === "ok" ? (url ? "found" : "miss") : r.kind);
      }
    }
  }
  await linkQuietly(c.db, contact_id, { vendor: c.vendors.reveal?.name });
  await c.db.tx((q) => enqueue(q, c.eventId, "flag", { contact_id }));
}

async function flag(c: Ctx, job: Job, lost: boolean) {
  const { contact_id } = job.payload;
  const skip = () => c.db.query("INSERT INTO review_flags (contact_id, flag, source) VALUES ($1, 'not_reviewed', 'code') ON CONFLICT DO NOTHING", [contact_id]);
  if (lost) return skip();
  const [p] = await c.db.query<{ full_name: string | null; title: string | null; email: string; company: string; dropped_at: string | null }>("SELECT c.full_name, c.title, c.email, c.dropped_at, co.name AS company FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.id = $1", [contact_id]);
  if (p.dropped_at) return;
  const input = `Name: ${p.full_name ?? "unknown"}\nTitle: ${p.title ?? "unknown"}\nCompany: ${p.company}\nEmail: ${p.email}`;
  const r = await decide(c, "review", fill("review", { input }), validFlags);
  if (r.kind !== "ok") return skip();
  for (const f of r.value.flags) await c.db.query("INSERT INTO review_flags (contact_id, flag, source) VALUES ($1, $2, 'llm') ON CONFLICT DO NOTHING", [contact_id, f]);
}

// The two-card flow runs one email loop per person (email.ts); the single-card flow keeps the separate find and verify jobs above.
const twoCard = (single: (c: Ctx, job: Job, lost: boolean) => Promise<unknown>) => (c: Ctx, job: Job, lost: boolean) => (c.flow === "two_card" ? emailJob(c, job, lost) : single(c, job, lost));
const HANDLERS: Record<string, (c: Ctx, job: Job, lost: boolean) => Promise<unknown>> = {
  company_tier: companyTier, title_tier: titleTier, discovery, find: twoCard(find), verify: twoCard(verify), linkedin, flag, identity: identityJob, reverse: reverseJob,
};

/* ----------------------------------------------------------------- loop */

/** A job whose worker died never repeats its paid call: its outcome is unknown. */
async function recoverLost(db: Db, eventId: string) {
  return db.query<Job>("SELECT id, event_id, kind, payload FROM jobs WHERE event_id = $1 AND status = 'running' AND lease_until < now()", [eventId]);
}

async function claim(db: Db, eventId: string, kinds: string) {
  const [job] = await db.query<Job>(
    `UPDATE jobs SET status = 'running', lease_until = now() + interval '${LEASE}'
     WHERE id = (SELECT id FROM jobs WHERE event_id = $1 AND status = 'queued' AND kind = ANY(string_to_array($2, ',')) ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id, event_id, kind, payload`,
    [eventId, kinds],
  );
  return job ?? null;
}

const done = (db: Db, id: string) => db.query("UPDATE jobs SET status = 'done', lease_until = NULL WHERE id = $1", [id]);

/** One run at a time per event: every answered case starts a run, and two at once could finish a phase twice or take a slow call for a lost one. Later ones wait their turn, so none is missed. */
const runs = new WeakMap<object, Map<string, Promise<unknown>>>();
export function processEvent(db: Db, eventId: string, deps: Deps): Promise<string> {
  const perDb = runs.get(db) ?? new Map<string, Promise<unknown>>();
  runs.set(db, perDb);
  const next = (perDb.get(eventId) ?? Promise.resolve()).catch(() => undefined).then(() => runOnce(db, eventId, deps));
  perDb.set(eventId, next);
  const clear = () => { if (perDb.get(eventId) === next) perDb.delete(eventId); };
  next.then(clear, clear);
  return next;
}

/** The event stops where a person can see why. With a job given, that job waits on the queue for the resume. */
async function pauseRun(db: Db, eventId: string, jobId: string | null, err: unknown, outcomeUnknown = false) {
  await db.tx(async (q) => {
    // A job whose closing failed goes back as lost, so the resume closes it again and never repeats a call of unknown outcome.
    if (jobId) await q(outcomeUnknown ? "UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1" : "UPDATE jobs SET status = 'queued', lease_until = NULL WHERE id = $1", [jobId]);
    await moveWithin(q, eventId, "paused", SYSTEM, { detail: err instanceof CrmDown ? CRM_DOWN_WORDS : err instanceof PauseSignal ? `${vendorWords(err.message)} keeps failing` : "A step failed and the run stopped. Resume to try again." });
  });
}

/** Closes a job whose outcome is unknown. Closing can itself reach a vendor that is down, or fail: then the event pauses with the job queued, never with it marked running and the reason only in a log. */
async function closeLost(c: Ctx, job: Job) {
  try { await HANDLERS[job.kind](c, job, true); await done(c.db, job.id); return false; }
  catch (err) {
    if (err instanceof TopUpClosed) throw err;
    if (!(err instanceof PauseSignal)) console.error("job failed while closing", job.kind, err);
    await pauseRun(c.db, c.eventId, job.id, err, true);
    return true;
  }
}

async function runOnce(db: Db, eventId: string, deps: Deps) {
  try { return await runEvent(db, eventId, deps); }
  catch (e) {
    // Discarded in the instant between a stage's work and its move: the run simply stops.
    if (e instanceof TopUpClosed) return "ended";
    // Work between jobs (finishing a phase, opening cases) failed. The event pauses with a line in its activity, so a person can see it and resume.
    const [ev] = await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [eventId]);
    if (!ev || !STAGE_KINDS[ev.stage]) throw e;
    if (!(e instanceof PauseSignal)) console.error("run failed", eventId, e);
    await pauseRun(db, eventId, null, e);
    return "paused";
  }
}

async function runEvent(db: Db, eventId: string, deps: Deps) {
  if (deps.live) {
    try { await assertRealRunAllowed(db, eventId); }
    catch (e) {
      if (!(e instanceof SpendGuardError)) throw e;
      // The card was confirmed, so the event would otherwise sit in a running stage with the reason only in a log. Pause it with the reason where a person looks.
      const [ev] = await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [eventId]);
      if (STAGE_KINDS[ev.stage]) await moveEvent(db, eventId, "paused", SYSTEM, { detail: `Paused before any paid call: ${e.message}` });
      return (await db.query<{ stage: string }>("SELECT stage FROM events WHERE id = $1", [eventId]))[0].stage;
    }
  }
  const settings = await getSettingsNow(db, eventId);
  const [{ flow, country, parent_event_id: parentId }] = await db.query<{ flow: Flow; country: string | null; parent_event_id: string | null }>("SELECT flow, country, parent_event_id FROM events WHERE id = $1", [eventId]);
  const c: Ctx = { db, deps, eventId, settings, vendors: deps.vendorsFor(settings), errors: new Map(), flow, health: healthFor(deps), country };
  for (;;) {
    const [e] = await db.query<{ stage: string; ended_at: string | null; merged_at: string | null }>("SELECT stage, ended_at, merged_at FROM events WHERE id = $1", [eventId]);
    if (e.ended_at || e.merged_at) {
      // Anything a job already holding a worker queued after the end does not run.
      if (e.ended_at) await db.query("UPDATE jobs SET status = 'cancelled', lease_until = NULL WHERE event_id = $1 AND status = 'queued'", [eventId]);
      return e.stage;
    }
    const kinds = STAGE_KINDS[e.stage];
    if (!kinds) return e.stage;
    if (e.stage === "tiering" || e.stage === "researching") {
      if (!(await crmGate(c, () => crmAtStart(c)))) continue;
      await (e.stage === "tiering" ? startTiering(db, eventId, settings) : startResearch(db, eventId, settings));
    } else if (e.stage === "finding_people") {
      if (!(await crmGate(c, () => crmBeforeOutreach(c)))) continue;
      await startPeople(db, eventId); await startPersonaTitles(db, eventId);
    }

    let pausedOnLost = false;
    for (const j of await recoverLost(db, eventId)) if (await closeLost(c, j)) { pausedOnLost = true; break; }
    if (pausedOnLost) continue;

    const job = await claim(db, eventId, kinds);
    if (job) {
      try { await HANDLERS[job.kind](c, job, false); await done(db, job.id); }
      catch (err) {
        // A job whose paid call may have billed is closed as a miss. Only a call known to be unbilled goes back on the queue.
        if (err instanceof PauseSignal && err.repeatable) { await pauseRun(db, eventId, job.id, err); continue; }
        if (!(err instanceof PauseSignal)) console.error("job failed", job.kind, err);
        const paused = await closeLost(c, job);
        if (!paused && err instanceof PauseSignal) await pauseRun(db, eventId, null, err);
      }
      continue;
    }
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE event_id = $1 AND status = 'running'", [eventId]);
    if (n > 0) return e.stage; // Another worker holds a lease; a later run finishes the stage.
    if (e.stage === "tiering") { await syncCrm(c); await finishTiering(db, eventId, settings); }
    else if (e.stage === "researching") {
      const [{ phase }] = await db.query<{ phase: string | null }>("SELECT phase FROM events WHERE id = $1", [eventId]);
      if (phase === "identity") {
        // Every identity and reverse job is done: merge rows that resolve to one domain, apply the domain gates and the CRM, queue the tiers.
        await crmGate(c, () => finishIdentity(db, eventId, settings, deps.crm ?? mockCrm));
        continue;
      }
      await syncCrm(c);
      await fuzzyListCases(db, eventId, settings);
      await moveEvent(db, eventId, "ready_for_review", SYSTEM, { detail: "Research finished" });
      await db.query("UPDATE events SET phase = NULL WHERE id = $1", [eventId]);
      // The spread check warns before Approval 2. It blocks nothing; the Outreach card carries it too.
      const spread = await spreadFor(db.query, eventId, settings);
      await db.tx((q) => logActivity(q, eventId, SYSTEM, "spread", spread.warnings.length ? `Spread check: ${spread.warnings.map((w) => w.text).join(" ")}` : `Spread check: ${spread.counts.tier1} tier 1, ${spread.counts.tier2} tier 2, ${spread.counts.tier3} tier 3, ${spread.counts.unknown} Unknown. Nothing to warn about.`));
    } else if (e.stage === "ready_for_review") { await priceIfReady(eventId); return e.stage; } // Waits for cases to be settled and the Outreach card to be confirmed; the desk prices the card once nothing blocks it.
    else if (e.stage === "finding_people") {
      // Read again: startPeople may have set the phase after this pass began.
      const [{ phase }] = await db.query<{ phase: string | null }>("SELECT phase FROM events WHERE id = $1", [eventId]);
      if (phase === "titles") await finishTiering(db, eventId, settings, true);
      else await moveEvent(db, eventId, "flagging", SYSTEM, { detail: "People found and checked" });
    } else if (e.stage === "enriching") await moveEvent(db, eventId, "flagging", SYSTEM, { detail: "Enrichment finished" });
    else {
      if (!(await crmGate(c, () => crmBeforeDelivery(c)))) continue;
      // Cases that need a person but hold nothing: a mismatch of address or employer, a late-stage deal, a model's doubt. Opened before delivery so the Review tab has them.
      await openLaterCases(db, eventId);
      // A top-up delivers into its parent, in the transaction of the move: it publishes no Sheet, writes no Summary and owes Salesforce nothing until its rows are the parent's.
      if (parentId) {
        const merged = await db.tx(async (q) => { await moveWithin(q, eventId, "delivered", SYSTEM, { detail: "The new registrations are ready" }); return mergeTopUp(q, eventId, SYSTEM, deps.crm); });
        await afterMerge(db, merged, SYSTEM, deps.sheets, c.vendors.reveal?.name);
        continue;
      }
      // What Salesforce is owed is queued with the delivery itself. It is sent later, by the sweep node.ts starts at boot.
      await db.tx(async (q) => { await moveWithin(q, eventId, "delivered", SYSTEM, { detail: "The outreach list is ready" }); await queueDeliveredEmails(q, eventId, deps.crm); });
      await db.tx((q) => logActivity(q, eventId, SYSTEM, "delivered", "Delivered"));
      // The Summary's perspective: one metered model call, checked in code, so publishing and the download read the result. It cannot fail or undo the delivery.
      await writePerspective(c);
      // After the move, and never able to undo it: a failure is recorded on the event.
      await publishSheet(db, eventId, SYSTEM, deps.sheets ?? mockSheets).catch((e) => console.error("sheet", eventId, e));
      // The demo cannot publish, so an event finished there opens the same sample Sheet the seeded ones do.
      const sample = process.env.SAMPLE_SHEET_URL?.trim();
      if (sample && !deps.sheets?.enabled) await db.query("UPDATE events SET sheet_url = $2 WHERE id = $1", [eventId, sample]);
    }
  }
}
