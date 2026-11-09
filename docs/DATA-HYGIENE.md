# Data reuse, Salesforce checks and the person record

Owner's request, 2026-11-09: never pay for the same data twice, respect Salesforce unsubscribes and do not call flags, and be visibly good at data hygiene. Salesforce is not connected; everything here runs against a simulated CRM behind the existing `Crm` seam, and live mode keeps `noCrm`.

## 0. Decisions (made 2026-11-09, the owner delegated these calls)

**Email vendors: Apollo and ZeroBounce only.** Hunter and NeverBounce are removed as direct vendors. This overrides the finder and second-verifier parts of the sections below.
- Apollo's normal match first. On a miss, Apollo's email waterfall (`run_waterfall_email`), with ZeroBounce connected as Apollo's validator through Apollo's own integration, so its cost appears in Apollo credits, set to continue until an address is verified. Hunter may be one of the sources inside Apollo, chosen in Apollo.
- Use `poll_only` and `request_id`, not a webhook: no public URL is needed. The request id is saved in `Loop` before the call so a crash cannot pay twice. Reserve the configured worst case, then reconcile to `credits_consumed` when the result arrives.
- A found address counts as verified twice only when the result reports Apollo `Verified` and a `usedForVerification` ZeroBounce pass.
- Addresses from the attendee list go straight to ZeroBounce, keeping `verification_cache`. If Apollo also reports `Verified` for that person, that is the second check. Otherwise they stay on the list, shown as "Verified once".
- Real Apollo behavior is unproven: the free plan cannot reach these features. The simulated vendors model this flow, and a real sample of a few hundred contacts comes before relying on it.

**Waterfall lineup (starting order, chosen in Apollo's settings, not in code):** Apollo's own data, Hunter, Findymail, Dropcontact, Prospeo, with ZeroBounce validating. Picked without neutral data; the real sample decides the final order.

**Do Not Call** blocks calls only. **Settings, Lists** does not show Salesforce entries: the seam cannot list them. **Build order:** vendor change, reuse and saved credits first; then Salesforce checks, the person record and write-back.

## 1. Reuse

What is already reused: company data (`company_cache`, 90 days), tier by domain and ICP version (`tier_cache`), title readings (`title_cache`), email checks (`verification_cache`, 30 days), domain state (`domain_state`), name to domain (`name_domain_map`), paid reveals and person matches (`reveals`, `reveal_queries`, through `dbReveals`).

What changes:
- **Finder results.** `email.ts` pays each finder per person with no lookup first. New table `finder_cache` (vendor, name_key, company_key, email or null, fetched_at). A found address is reused within `freshness_days`; a miss within 30 days, the same miss window `dbReveals` uses. The cache is read before the card is charged.
- **LinkedIn lookups.** Same treatment if the lookup in `email.ts` has no cache today; confirm before building.
- **Reveal age.** `dbReveals.find` has no age limit on a found person, so a two-year-old reveal would be reused forever. A found reveal older than `freshness_days` is treated as absent. Misses keep the 30-day window.
- **Job changes.** A reused reveal still goes through the employment check. If a reused record fails it, the person is not dropped on old data: the record is treated as absent and bought once, fresh. A record just bought that fails is dropped as today.

## 2. What it saved

New table `reuse_log` (id, event_id with no foreign key so it survives an event delete, vendor, step, unit `credit` or `llm`, n, created_at). One row is written at each point where a stored answer replaced a call that would otherwise have been paid: reveal, person match, firmographics paid enrich, finder, verifier (one row per verifier that was not called, at its own cost), catch-all probe, company tier, second look, website read and title reading. A free call that was skipped is not a saving and is not logged.

Usage shows one small figure on each vendor's pool, "412 saved", over that pool's own period, and a line on the AI bill in dollars. Credits and dollars are never added together or converted, and credits are never summed across vendors. If a pool has no saved credits the figure is absent. In simulated runs the pages say simulated once, as they do today.

## 3. Salesforce do not contact

`Crm` gains optional `connected`, `personFlags(people)` and `accountFlags(domains)`. A person's flags come from every Lead and Contact matching by email, or by name at the account when there is no email; if any record is flagged the person is flagged. `noCrm` reports `connected: false` and no check runs. The simulated CRM flags a small fixed share of the simulated people.

| Salesforce | Effect |
|---|---|
| Email Opt Out | Dropped, reason `crm_unsubscribed` |
| Custom Do Not Contact | Dropped, reason `crm_do_not_contact` |
| Do Not Call | Stays; `contacts.no_calls` true, shown as a Sheet column |
| Email bounced | `verification_cache` is ignored for that address |
| Account do not prospect | The company is excluded, reason `excluded_company` |

Owner's rule: no override. These drops are never cases and never appear on Review. Do Not Call blocking calls only is the default chosen pending his confirmation.

When it runs:
1. As the first step of a run, before any paid step: `startResearch` and `startTiering`. Not in the upload transaction, which must not depend on an outside system.
2. In the email loop, for any address newly found or revealed, before a verifier is paid.
3. Immediately before the move to `delivered`.
4. An exported `preSendCheck(db, contactIds)` for the future Apollo sequence step, tested and not wired to anything.

If a connected CRM cannot answer at any of these points, the run pauses through the existing `PauseSignal` path. Unlike owner and deal lookups, this fails closed. The opt-out check gets added to the single-card `find` and `verify` jobs, which lack it today.

Settings, Lists: when a CRM is connected, Never contact and Existing customers show what Salesforce adds, marked by source, beside the entries kept by hand.

## 4. One record per person

New table `people` (id, email unique when present, linkedin, vendor_person_id, full_name, first_seen, last_seen, last_verified_at). `contacts.person_id` is nullable and added without changing any existing query. A contact is linked at upload and again whenever an email, LinkedIn or vendor id is learned, matching in that order. Two people rows found to be one are merged, the older id surviving. A name alone never links.

The person panel shows "Seen at 3 events" and last verified. Nothing else reads this table yet, so an error here cannot change a run. Deleting an event removes `people` rows left with no contacts.

## 5. Writing back to Salesforce

New table `crm_outbox` (id, person_id, kind `email` or `opt_out`, payload, status, attempts, created_at). On delivery, each kept person with a doubly verified address queues an `email` row. Recording an opt-out queues an `opt_out` row. It fills blank fields only and never overwrites a Salesforce value. `Crm.write` is optional: `noCrm` has none, so nothing is queued in live mode. The queue is drained at the end of `processEvent` and retried, and a failure never affects delivery.

## 6. Tests that must exist

- Second event: the same person costs no finder, reveal or verifier credits, and each avoided call is logged at its real cost. A stale reveal is bought again. A reused record failing the employment check is bought once and not dropped.
- `reuse_log` has no rows for free calls; Usage shows per vendor and in dollars apart; a deleted event's savings stay.
- Each flag's effect, any-record-flagged, no override reachable through the case or Review routes, a CRM failure pausing at each of the three wired points, `noCrm` running no check, single-card opt-outs.
- People linking and merging; a name alone never links; `crm_outbox` fills blanks only and a write failure does not affect delivery.
- A run's priorities and kept people are unchanged by the `people` table.

## 6a. Corrections from the first review (these override the text above)

Blockers:
- **Pausing.** `PauseSignal` is only caught around job handlers. Each CRM check at the run start and before delivery runs as its own job or inside its own catch, outside the `startResearch` and `startTiering` transactions, with a "checked" marker set only after success, and pauses as repeatable.
- **Matching.** Name at the account always runs alongside email, as `isOptedOut` already does. Address alone would miss a Contact opted out under another address.
- **Job changes.** A re-buy needs a floor (only when the stored `reveals.fetched_at` is older than 30 days), a `Loop` flag so a replay cannot pay twice, and the write to the contact moved after the employment check.
- **Account flags.** They run at the domain gates in `finishIdentity`, not at the run start, where almost no domain is known. Single-card has no domains and matches the account by name.

Majors:
- Finder cache stores LinkedIn too and only `ok` outcomes. The LinkedIn lookup lives in `pipeline.ts` `linkedin()` and gets its own cache.
- "Saved" means a stored answer from an earlier event or run, never in-run dedupe. Log rows carry a unique key (contact, step, vendor, candidate) so replays count once. A conditional call counts only when it would really have run: not verifier two after a cached undeliverable, not a free miss, not a second look or website read that was not due, not a free DNS result.
- Bounced compares the bounce date with `checked_at`, is stored on the contact, and is read before `getVerification`.
- Store verifier one's verdict in `Loop`, which fixes an existing double charge when verifier two pauses.
- The check before delivery runs before `openLaterCases`.
- Settings cannot enumerate Salesforce through `accountFlags`; it needs a list call on the seam or the idea is dropped.
- Write-back: Email Opt Out is a checkbox, so an opt-out is an explicit exception to "fills blanks only". Write to every matching record, never create one, cap retries, drain from a boot sweep instead of `processEvent`, queue in the same transaction as delivery. Opt-outs are keyed by address or name, not `person_id`.
- `people` linking runs in its own transaction and is caught. Role and shared addresses never link. Keep an address history table, and `vendor_person_id` is paired with its vendor. Merges and event deletes repoint outbox rows.
- Single-card gets both the local opt-out check and the CRM check in `find` and `verify`.

Nits: unit is `credits`; new reasons go in `DROP_REASONS`, `DROP`, the docs and the world test; `freshness_days` for reveals is measured from `reveals.fetched_at`.

Section 1's finder cache depends on the email vendor decision: if Hunter leaves for Apollo's waterfall, it is replaced by reuse of waterfall results.

## 6b. What phase 1 built (2026-11-09)

Vendor change, reuse and saved credits are in; decision 23 in `docs/DECISIONS.md` records the choices. One point of section 0 could not be built as written: Apollo issues the request id in the response to the paying call, so it cannot be saved before that call. What is written first is the reservation and the in-flight marker; the id is written in the same step that closes the call. A crash in that gap is closed as a miss and never started again.

## 6c. What phase 2 built (2026-11-09)

Salesforce checks, the person record and write-back are in, against a simulated CRM only; decision 28 in `docs/DECISIONS.md` records the choices and where this document could not be followed as written. Salesforce is not connected and live mode keeps `noCrm`.

## 7. Open

- Do Not Call: blocks calls only (default) or removes the person.
