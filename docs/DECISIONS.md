# Decisions

## 1. Columns are mapped in code
An LLM could read any header, but it would be a paid call before anyone approved a cost. A synonym table plus value-shape checks covers real exports, and a file it cannot read stops and names the missing column.

## 2. The cost card is a worst case and a hard cap
The card assumes nothing is dropped and every vendor is tried, so it can only be too high. Two caps, credits and LLM calls, because they are different units. Dollars are display only.

## 3. Reserve, call, settle
A database transaction cannot wrap a vendor call. Each paid call reserves against the card while holding the card's row lock, calls, then records the real charge. A reservation never settled stays counted as spent. A charge above the reservation is counted too, so spending stops after it. The cap is only as accurate as the vendor rates in the config.

## 4. A paid call never repeats when its outcome is unknown
This covers vendors and the model. If a worker dies mid-call, the job's lease expires and that vendor counts as a miss. A timeout or server error is not retried. Retries happen only when the provider reports it did not bill, and once for a model answer that arrived but was invalid. The Anthropic SDK's own retries are off, because the cost card could not see them.

## 5. Jobs live in Postgres
`FOR UPDATE SKIP LOCKED` on a `jobs` table gives one paid item per job with no extra infrastructure.

## 6. A finder's verification does not count
Two separate vendors verify every email. Anything uncertain stays on the list and code flags it, so a model cannot forget to.

*Superseded in part, 2026-11-09:* only an address that both verifiers call deliverable keeps a person. Catch-all, unknown, a verifier error or either verifier's "undeliverable" drops the person with a reason (`email_unconfirmed`, `catch_all_unconfirmed`, `not_deliverable`); nothing uncertain stays on the list. Tested in `tests/email-rule.test.ts`.

## 7. Concierge cannot reach money
Its tools run under a Postgres role that can read only views with no cost, credit, budget or seat-price column. The prompt also forbids money, and a check on the final answer replaces any that contains it, but neither of those is what protects it.

## 8. CI replays recorded model output
Real calls in CI would need a key and cost money on every push. Each recording stores a hash of its prompt and model, so a changed prompt fails until it is recorded again.

## 9. `--demo` ignores every key
An exported key in a shell must never let a demo spend money, for the same reason it ignores `DATABASE_URL`.

## 10. The uploader confirms the cost card; leadership approves seats (2026-11-08)
This replaces the earlier rule that approvers on a list confirmed cost cards and that nobody could confirm their own request.

A cost card was never meant to be a leadership approval. It is a human gate so that the SDR or field marketer who uploaded the list can confirm the paid steps before the system runs them. So seats and cards are now different kinds of gate. A seat request is a spending decision: approvers decide it and nobody approves their own. A cost card, single, Research or Outreach, is confirmed by the person who uploaded the current list and nobody else, including approvers who did not upload. If someone else uploads the list again (nothing paid yet), they become the confirmer and any pending card is voided, so nothing waits on someone who is away.

The actor header is not proof of identity, so live mode keeps the check real: the card is posted to the approvals channel with an @mention of the uploader (not a direct message), the Slack user must map to the uploader in `SLACK_USER_MAP` (required for `LIVE_SPEND=1`), and a missing mapping refuses the card with a clear reason. The demo route confirms as the acting person and enforces the same uploader rule.

Unchanged on purpose: a human confirms before any paid step, the ledger reserves under a row lock, per-step caps, a paid call with an unknown outcome is never repeated, and the refusal to run on stale totals. Only who confirms changed.

Superseded in part by decision 103 (2026-11-17): seat decisions can also be taken on the in-app Seat decisions screen, mainly where Slack is not connected. Slack is still the main path.

## 11. New events run the two-card flow (2026-11-08)
The Research card then the Outreach card is the design, and the older single cost card priced every company as if it were enriched. New events default to `two_card` (migration 0015 changes the column default; events that already exist keep their flow). Single-card remains supported for events already running it and for the tests that are about its mechanics, which now say so explicitly. Seeds and the shared test helpers go through the real two-card flow, including the uploader's confirmation, the cases and the Outreach card, rather than a shortcut.

## 12. Vendor credits are not money (2026-11-08)
Bryan: dollars spent on model calls and Apollo credits must be kept apart across the whole system; credits are part of a pre-allocated subscription pool and are not judged in money. Removed `credit_cents` from config, cards, Usage, Slack, Settings and the workbook Summary. `est_cents` on a card, the card estimate and Usage "AI" are model calls times `llm_call_cents` only. Vendors are named accurately (Apollo, Hunter, ZeroBounce, NeverBounce, AI is Anthropic) through `src/shared/vendors.ts`, which both live and simulated step names map into. Pools live in config with null for unknown (use shown, no limit invented); sample allotments are written only by the demo seed. No cap, reservation or ledger rule changed: caps stay in credits and model calls. The ICP compile estimate and its accepted-cents check were already model calls only and are unchanged.

## 13. Seats are per person (2026-11-08)
A seat request is one person asking for their own seat, enforced on the server, one open or approved request per person per event. The budget a request would use is shown to the approver as a warning and never blocks. This keeps seat spending a leadership decision and keeps the outreach work separate from it.

## 14. Settings are for the GTM team only (2026-11-08)
Only GTM Engineering opens Settings or calls its write routes, and the server refuses everyone else with one line. "Acting as" is a demo switch and is not security; a real login replaces it later.

## 15. Budget covers tickets only (2026-11-08)
Spent is tickets recorded as bought, committed is approved seats not yet bought, waiting is pending requests. Data provider spend, AI, travel and sponsorship stay out, so the page answers one question: how much of the ticket budget is left.

## 16. Usage shows credits and AI dollars apart (2026-11-08)
Extends decision 12 to a screen. Each data provider is drawn as its own pool in its own credits, with what is left as the headline; AI is the only thing in dollars. Nothing is summed across providers or converted to money.

## 17. The attendee list is not a design for sharing real people (2026-11-09)
Event names and dates are real, taken from public pages. Every attendee, company and staff member is invented, and the demo says so once. Event logos are fetched from Google's favicon service at view time from the event's own website and are not stored in the repository. Whether real logos stay in a published copy is Bryan's call.


## 18. The delivered Sheet has a Google-native layer, and the Excel file stands alone (2026-11-09)
Drive converts the uploaded .xlsx, and what survives looks like a converted Excel file. The workbook keeps everything Excel and Sheets both honor (fills, borders, frozen panes, validations, filters, outlines), and a second pass over the Sheets API adds what only Sheets can hold: the app's fonts, tab colors, collapsed column groups, dropdown chips, saved filter views, warning-only protection and SPARKLINE bars. The pass is built from a plan the workbook builder returns beside the bytes (`SheetPlan`), so the two never disagree about where a column is. It runs after create and after update, and it is a finish, not a condition: a refused batch is one activity line and the link still delivers. Native Tables were tried on paper and skipped: they impose their own header and banding and would undo the design. The download is the same file with no layer, and it is complete on its own.

## 19. The Summary states; it never directs (2026-11-09)
Bryan: after review, outbound runs through automatic sequences, so nobody is pointed anywhere from the Summary. The game plan and every imperative line are gone. The top of the Summary is `perspective(d)`: why this event, in the words of the people who asked for seats; what the attendee list is against the ICP; where the accounts stand in the CRM. It is composed in code from stored fields only, quotes people rather than paraphrasing them, and says "not connected" when no CRM answered rather than filling the gap. It is one exported function so a model-written version can replace it later without touching the layout. The live numbers below it stay, and grew by what the tabs can now count (emails verified twice, companies on the list, hot accounts), not by words.

## 20. Depth beside the person, folded (2026-11-09)
Bryan: the tabs were thin; a rep wants the company, the CRM relationship and what the vendor said beside each person. Every fact already stored or returned on a call already paid for is now a column, grouped under labelled bands, and the facts a reader needs less often sit in a collapsed Detail group that opens with one click. The same free organization search that tiers a company also returns revenue, founding year, city, funding stage and a LinkedIn page; those are kept (`FIRMO_DETAIL`) and never bought on their own. The paid reveal returns location, seniority, departments and the start of the current role; migration 0031 stores them. No new paid call was added, and live mode without a CRM leaves every CRM column blank.

Owner, 2026-11-09: no protected ranges on the delivered Sheet. Warning-only protection still puts a lock icon on the tab names, and he does not want them.

## 21. The original list is kept, and an event is deleted only by a person (2026-11-09)
Owner: "yes, there should be the option. i dont want to delete anything really." Nothing is deleted automatically, ever.

**Original files.** `upload_files` (migration 0032) keeps the bytes of each attendee list as received, one row per upload, until the upload or the event is deleted. `GET /api/events/:id/uploads/:uploadId/file` has the same access as `/workbook`: the browser holds no write key, so a check on it could never pass. Closing the three personal-data GET routes belongs to a real login. A list uploaded before this has no bytes; its row offers "Download rows", a CSV rebuilt from `source_rows.raw` (jsonb, so column order and header spelling are not kept), with cells that begin with = + - @ made text. Replace deletes the old `uploads` row and its file.

**Delete.** `DELETE /api/events/:id`, GTM Team and the seat approvers only, decided on the server. Refused while a run is going (stages tiering to finding_people) or any job is queued or running. It removes what the event owns: its list, companies, people, cases, cards, approvals, settings, seat requests, history and stored files (all cascade from the event row). It keeps what spans events: suppressions and opt-outs, ICP versions, company, tier, title and verification caches, reveals, the catalog entry. The Google Sheet is not touched.

**Spend stays counted.** The Usage pools are read from `credit_ledger` by date, and the ledger belongs to the event. Removing it would lower a pool for credits already spent, so the event's ledger rows are copied to `ledger_kept` (no foreign keys, notes already resolved, original dates) in the same transaction, and Usage reads both tables. A pool reads the same before and after; the deleted event simply no longer has a row in the by-event table. The Budget is tickets only and is read from seats, so the tickets recorded as bought are copied to `ticket_spend_kept` and counted by the quarter the event started, shown by name without a link, with a Budget log line. A seat not yet bought counts for nothing after deletion. A ticket bought for an event that was later ended stays counted, before and after deletion, because the money was spent. Not kept: per-event vendor attempt history (`enrichment_attempts`), so Usage's vendor health counts fall by that event's attempts; AI call text; the cost card itself.

## 22. A model writes the Summary's perspective, and code decides whether it may be printed (2026-11-09)
Owner: the perspective at the top of the Summary is written by a model, with every number checked by code. This revises decision 19 only in who writes the sentences: the Summary still states and never directs, and the code-written `perspective(d)` stays as the fallback for every block.

**One call per delivered list.** `writePerspective` runs in the pipeline after `openLaterCases` and the move to delivered, before the Sheet is built. It is a step of the Outreach card (`perspective`, one call and one retry at most, `perspective_llm: 2` on the card), so the approver sees it before confirming. It is metered in model calls through the ledger and priced in AI dollars like every other model call; it touches no credits. A single-card event has no such step and makes no call. An Outreach card approved before this change has no room for the step, so the call is refused and the code-written text is used.

**The model sees a packet built by code**: event-level facts only (seat goals, who is going, ticket counts, the tier mix, top industries and countries, the comparison with other delivered lists, customers, open deals, net new accounts) plus the seat requesters' own words, fenced as data. No attendee name, email, title or raw attendee-file value, and no CRM owner's name. The prompt asks for the same three parts, two or three short sentences each, as a perspective: no advice, no imperatives, no recommendation, no invented cause, and a plain statement when a fact is missing.

**The check is the control** (`src/server/perspective-check.ts`). A block is printed only if every number is in the packet (1,650 and 1650 alike, 18% and 0.18 alike, spelled-out numbers included) or is one of three derivations: a sum or a difference of two numbers of the same kind inside one group of the packet, or 100 minus a percentage; every quotation is word for word inside a seat request; every capitalized name is in the packet; and there is no imperative or advice wording, no second person, no dash used as punctuation, no markup, no leading formula character, two or three sentences of bounded length, and valid JSON with exactly the three parts. A block that fails is replaced by the code-written text for that block alone. An answer that cannot be read, or in which a block fails, may use the one retry; a refusal, a failed call, a timeout (45 seconds) or an exhausted card falls back at once. Delivery never fails or waits on any of it, and one activity line says in plain words what was used instead.

**Stored on the event** (`events.perspective`, migration 0033): the model that answered and, per block, whether the model, the fallback or the simulated model supplied it. The workbook uses the model's text only while the fact packet still hashes to what the model was shown; a review drop, a ticket bought or another list delivered means the numbers in the text are no longer checked, and the rules write the block. The Sheet says which blocks a model wrote and that code checked them. Text is written to the cell as text; a value that begins with = is a string.

**The demo and tests use the simulated model, which writes nothing.** It returns the code-written text it is handed and is stored as `simulated`, so no sample presents prose as a model's.

**Not decided here:** whether a stricter or looser name check serves better once real output is seen. The check is deliberately strict because a false rejection costs one block of code-written text and a false acceptance prints a claim nobody verified.

Owner, 2026-11-09: real event logos stay in the public version. Opt-outs live on the person panel and in Settings, Lists, with no tab of their own.

## 23. Apollo and ZeroBounce are the only direct email vendors (2026-11-09)
Build of `docs/DATA-HYGIENE.md`, phase 1. Hunter and NeverBounce are gone from code, settings, Usage, Settings and the card. Apollo's match runs first, then `run_waterfall_email` with `poll_only` on a miss. The waterfall's sources and ZeroBounce's validation inside it are chosen in Apollo's settings and all appear in Apollo credits; no code calls them.

**The waterfall is asynchronous and never blocks the queue.** One paid start, reserved at `waterfall.reserve` (10, an authored starting number, not measured), then free polls, with the person re-queued behind everyone else between polls. The reservation is reconciled to `credits_consumed` when the result arrives; a result that never comes leaves it counted as spent. Request ids are 64-bit and are kept as digits, because JSON numbers lose them. After `waterfall.max_wait_minutes` (30, authored; Apollo's own example took about five) a person is closed as `vendor_error`, or, with five or more stuck at once, the event pauses and nobody drops.

**The request id cannot be saved before the paying call**, because Apollo issues it in that call's response. The reservation and an in-flight marker are written before it, and the id in the write that closes the call. A crash in between is closed as a miss and never repaid.

**The second check.** `verify_1` is ZeroBounce and `verify_2` is Apollo's Verified. An address found by Apollo needs both. An attendee-list address needs ZeroBounce to stay; Apollo's Verified counts only if an answer we already hold says so (a stored reveal, match, waterfall or LinkedIn lookup). No credit is spent to find out, so most attendees read "Verified once". Buying one match per attendee would change that and is the owner's call. A pattern-guessed address stays on one check as well, since it is off by default and has no Apollo status. A found address Apollo has not marked Verified gets no ZeroBounce credit; it is set aside and the waterfall may still return it.

**The single-card flow** has no waterfall and now has one finder and one verifier: its pass keeps the person, shown as "Verified once". Rows in the ledger from the retired vendors are left where they are and count in no pool. An Outreach card approved before this change has no `waterfall` step, so the call is refused and the person drops as `budget_cap`; no live event has reached that state.

**Saved** (`reuse_log`) counts a stored answer written by another event, or by this event before its first card was approved, once per contact, step, vendor and candidate; each cache row now says which event wrote it, so a run's own answers never count. A stored miss is not a saving, because Apollo documents that a match finding nothing costs nothing. The live adapters still bill every Apollo attempt on the card, which is the safe direction for a cap; the docs read 2026-11-09 say misses are free.

## 24. The second look is cut (2026-11-09)
The rule, written into `tests/company-tier-evals.test.ts` before it was measured, was: the second look "improves tier 1 precision, or it is cut". The first real recording (Opus 5.5, 2026-11-09) measured it. On the frozen holdout it was asked about 22 companies (the model's tier 1s and its gaps of two levels to the baseline) and **disagreed on none**: caught 0, false alarm 0, wrong tiers missed 0. The first tiers it checked were already right (tier 1 precision 20 of 20 before and after, Wilson 83.9% to 100%), so it had nothing to improve. A check that never disagrees buys nothing and costs one model call for every tier 1 company, a sixth of each company's worst-case allowance on the Research card.

Cut from production: no `second_look` call, no `second_look` step or `second_look_calls` on the Research card (the per-company worst case is now 5 calls, not 6, and a 5-company event's cap is 30, not 36), no `second_look_disagreement` case is opened, no Settings row, no "Second look" column in the workbook, no `Deps.secondLook` or `EVENTS_DESK_SECOND_LOOK_MODEL`. Kept as evidence: the prompt template, `evals/recordings/second_look.json`, the scorer, and the report line, which now says it was cut. The test that used to demand the look help now asserts the cut and the numbers. Rows already stored (`companies.second_look`, old cases, old ledger rows and their step label) still read and resolve.

**What this costs, said plainly.** The look was also the only thing that could catch a first model fooled by an instruction hidden in a company description; the test for that is now marked as a known limit and asserts that a tier 1 stands. The fact-citing rule and the hard rules are what remain. In the simulated Meridian world (authored rates, where the simulated second reader rolls independently and does catch errors) wrongly-priority-A rises to 23.4% and fails the existing floor of 20% in `tests/people-world.test.ts`. That floor was **not** moved, per the instruction not to weaken a gate: the failure is the simulation's authored catch rate against the real evidence of none, and the owner decides whether to move the floor (a re-baseline to 25% is the obvious one) or to give the simulator a real-looking second reader of zero catches.

## 25. Seniority alone is not a buyer; the title gate fix was prompted by a holdout failure (2026-11-09)
**Read this before quoting any title holdout figure.** The first real title recording passed on dev and failed the holdout gate "no tier 3 given tier 1" on one item: "Chief Vibes Officer". The real model read it as function `hr`, seniority `c_level`, and `personaTier` gave every c-level and owner tier 1 whatever the function. The fix below was therefore **prompted by a holdout failure**. It is a general rule, not a rule for that title, and no holdout title was added to any list. But the holdout has now been looked at, and the figures after the fix (rules then model: tier 99.1%, 113 of 114, promoted wrongly 0, up from 96.5% with one wrong promotion) are **not a clean held-out result**. Treat them as a development figure until a fresh holdout is written.

**Rule.** An owner is tier 1 whatever the title (they own the company). A c-level title is tier 1 if the rules read it (`parseTitle` sets `read_by_rules`: "Chief Financial Officer"), or its function is `executive` (the whole company), or a persona of the pinned ICP covers the function it was read as. A chief officer only the model could read is by construction an unlisted or inflated title, and its rank says nothing about a job. Such a title otherwise falls to the usual rules (go-to-market function: 2, else 3). Titles built from a stored or model answer lack `read_by_rules`, so they follow the stricter path.

**Deliberately not done.** The instruction read as "seniority alone must not make a tier 1 when the function is outside the ICP's personas", applied to every chief. I did not apply it to chiefs the rules read: the hand labels in both sets (dev CFO and COO, holdout CTO and CPO) and SPEC say a named chief is tier 1 for company-wide authority, and the strict rule cost those four labeled titles. If the owner wants the strict rule, it is one condition in `personaTier` and four labels to revisit.

**Two more general fixes the same failure led to, found by looking at why "Sr. VP, Global Sales" and "Vicepresidenta de Ventas" were misread** (both are holdout titles; neither is named in code): (1) `normalizeTitle` drops a region tail such as ", Global ..." and with it the function; a title with no function after that is now read again with the tail kept. (2) "executive" means the whole company, which only an owner or a chief holds, but the executive rule matched "president" inside "vice president", so a bare "Vice President" or "VP Product" was an executive tier 3 by accident; such a title is now unplaced and goes to the model. (3) The feminine rank forms the parser did not read are added as a class (vicepresidenta, presidenta, dueña), not just the one title. Holdout misses by the rules alone went from 8 named titles to 7 (two fixed, one, "VP Product", newly unplaced for the model), and `tests/title-tier-evals.test.ts` lists them.

## 26. AI is real dollars where the call has tokens (2026-11-09)
`llm_calls` already stored each call's tokens. `src/server/ai-cost.ts` now prices a call from them with `src/shared/model-pricing.ts` (an unlisted model is never guessed). Usage, the per-event table, the per-person figure and the event page's Cost fold all use it. A call with no token count (every simulated run, or a ledger call without a stored row) keeps the flat `llm_call_cents` and is counted apart: Usage says how many calls are real and how many are simulated or uncounted. Cost cards before the run stay an estimate (the cap at the flat rate) and say "estimated". Credits and dollars are still never combined.

**Deleted events.** `llm_calls` cascades with its event, so migration 0036 adds `llm_calls_kept` (id, event, step, model, tokens, time; no model text) and `deleteEvent` copies into it in the same transaction, the `ledger_kept` approach. Usage reads both, and the same figure shows before and after.

**The default `llm_call_cents` stays 1.** Evidence: the Summary's perspective step on Opus 5.5 was measured at 2.46, 1.81 and 1.75 cents in three real calls (about 2.0 on average, input 2,800 tokens, output 315 to 665), against the earlier measurement of about 3 cents. A tier call carries a few hundred input tokens and a short answer, which prices near half a cent at the same rates, but that is arithmetic from prompt sizes, not a measurement; no real tier call has been priced inside the app. The card is a worst-case ceiling dominated by tier calls, so tripling the rate to 3 cents would triple the ceiling for the steps that are not measured at 3. The Summary alone is under-quoted by roughly a cent or two per call at 1 cent; that sits well inside the slack of the tier calls. A real Research run should replace both numbers; until then 1 cent is conservative where it matters and low only for the Summary.

## 27. The Summary perspective's real answers (2026-11-09)
The step's real answer was invalid JSON once in two tries. Candidates found in the code, none of which could be reproduced from the lost answer: (1) `max_tokens` was 2048 and hidden thinking counts inside it, and a reply cut off at `max_tokens` was returned as empty text, which reads as invalid JSON with no hint why; (2) `parseJson` rejected JSON with a sentence before or after it; (3) the shape was only asked for in the prompt. Fixed: the perspective step gets 8000 output tokens; the API holds the reply to the three-string schema (`output_config.format` json_schema, which the installed SDK 1.6.0 supports and Opus 5.5 accepted); `parseJson` reads the braces out of surrounding prose; the real model's `stop_reason` and thinking tokens are returned so a cut-off is visible. Three real calls (cap 3, all used): all `end_turn`, all valid JSON; thinking was 361 tokens in the first and 0 in the next two; cost $0.06020 in all. One check was a false reject, shown: "Industry is spread thin..." was rejected as an unknown name because a sentence-opening common noun is not in the list of non-name words; "industry" and "industries" were added, with a test that a real stranger is still caught. Of 9 parts, 8 passed first time and the ninth passes now (checked offline against its text and the facts of a later seeded run, so that check is weaker than a live one). The parts are quoted in the report, not here, because the figures in them change with each seeded run.

2026-11-09, delegated by the owner: the simulated wrong-priority-A floor moves from 20% to 25% (`tests/people-world.test.ts`). The old floor relied on an authored second-look catch rate, and the real recording showed the second look caught nothing. This is a floor on simulated rates, not a real accuracy claim. The floor for people the world says are C stays at 12%.

## 28. Salesforce checks, one record per person, and write-back, all on a simulated CRM (2026-11-09)
Build of `docs/DATA-HYGIENE.md`, phase 2, migration 0037. **Salesforce is not connected.** `simCrm` stands in for it in the demo and the world tests; live mode keeps `noCrm`, which says `connected: false`, runs no check and queues nothing. The demo's drop reasons read "Unsubscribed in Salesforce" because those are the product's words; in the demo they come from the simulator.

**The checks** (`src/server/crm-checks.ts`). Do Not Call blocks calls only. Flags have no override and never become cases or Review rows. The seam returns every matching Lead and Contact and our code applies any-record-flagged, so an adapter cannot get that rule wrong. Name at the account always runs alongside the address. A bounce counts only for the address it happened on. Someone both unsubscribed and marked do not contact is dropped as `crm_do_not_contact`.

**Failing closed.** A connected CRM that throws, or answers without one of the people asked about, pauses the run as repeatable. The checks at the run start, the domain gates and before delivery run in `crmGate`, outside every transaction, with their marker set only after success. Inside a job, the loop's own catch puts the job back.

**One added check.** A company a person settles through a case gets its domain after the gates in `finishIdentity`. The document has no check for it, so accounts not yet asked about are asked at the start of the Outreach run, before anything is searched or paid for there. The check before delivery asks about accounts as well as people.

**Where the document could not be followed as written.**
- `accountFlags(domains)` takes a domain or a name, because section 6a says single-card has no domains and matches by name.
- "Drain from a boot sweep": a sweep run only at boot would strand rows until the next restart, so `node.ts` runs it at boot and then every 5 minutes from there. It is never called from a run. The 5 minutes and the cap of 5 attempts are authored numbers.
- "Merges and event deletes repoint outbox rows": a merge repoints them to the survivor. A delete has nothing to repoint to when the person goes, so a queued `email` row for them is cancelled and unlinked. A person still seen at another event keeps theirs, and opt-outs have no `person_id` and always stay.
- `crm_outbox` keeps the columns section 5 lists. The event a row came from is in its payload, so a row is not owned by the event.
- A contact does not record which vendor issued its id, so the link is made in the email loop with the reveal vendor's name. A prospect who never reaches the loop (priority C) is not linked by vendor id. This also left `people.ts` untouched.
- An address already on the attendee list is asked about at the run start and before delivery, not again in the email loop; section 3 asks there only for addresses newly found or revealed.

**The person record** (`src/server/person-record.ts`). Linking runs in its own transaction and is caught, and a test runs a whole event with the table dropped and gets the same priorities and kept people. Role, disposable and shared addresses never link; "shared" means one address under clearly different names, and an initial or a middle name does not count. An address found to be shared late is taken back from whoever held it. An upload links in one transaction, so a failure there leaves that upload unlinked until later steps link each person. The panel shows "Seen at N events" only from two events up.

**Write-back** (`src/server/crm-outbox.ts`). An `email` row is queued in the delivery's own transaction for each kept person verified twice, so "Verified once" attendees queue nothing. Blank-only is decided in our code, per record. Email Opt Out is the one exception. The seam has no create.

**Not decided here:** Do Not Call blocking calls only remains the default pending the owner's confirmation. Every rate in `SIM_RATES.crm` is authored, not measured.

Superseded in part by decision 46 (2026-11-12): the desk can now use CRM Desk as a live CRM with `CRM=crmdesk`, so "live mode keeps `noCrm`" holds only while `CRM` is unset; Salesforce is still not connected.

## 29. New registrations run as a hidden event and merge in one transaction (2026-11-09)
Build of `docs/NEW-REGISTRATIONS.md`, section 2, as corrected by 4a, migration 0038. Mocks and simulated vendors only; no real vendor or model call was made. A top-up is an event row with `parent_event_id`, invisible on every list. The parent never leaves `delivered`. The code is `src/server/top-up.ts` and `src/server/inherit.ts`.

**Where the document was underspecified, the safest reading, chosen here.**
- **Ending.** The stage stays where it was and `ended_at` ends it (4a). An ended or merged top-up can never move again; `moveWithin` refuses. A case on an ended one cannot be answered. Cancel on a top-up ends it.
- **The Run step opens at once.** The upload route asks for the Research card right after the top-up is made, so the panel opens on Review cost and run. If the card cannot be made, it waits at `mapped` and the panel asks. New registrations use the parent's settings, and changing them is refused.
- **Which column was the file's email.** Headers are not stored, so a parent row's address is any cell holding an address in a column the upload did not ignore. A shared mailbox counts as no email, as it did at upload. A prospect's source row is someone else's, so a prospect counts as having no file email.
- **What an inherited company means** (`outcomeOf`). A list status drops. A tier and a domain is usable. A tier with `in_research = false` drops with the parent's reason. No tier with a company-level reason (rejected, not found, tiering failed) drops with it. No tier and no such reason means nobody decided anything about the company, so it is assessed for the first time.
- **A single-card parent's company has a tier and no domain.** The email loop cannot work without a domain, so it is assessed as new, on the card, and the parent's tier stands at the merge.
- **The one way a merge changes a parent row.** A company the parent never tiered that the top-up assessed gets that first assessment; an empty field is filled and nothing is overwritten. A new spelling is added to `merged_names`. Every other parent row is byte for byte as it was; the tests compare whole rows.
- **Salesforce.** Owner and deal reads skip inherited companies. Do-not-prospect does not: a copy is asked again at the top-up's own domain gate and before delivery, because the flag may be newer than the parent's check. A flag lands on the copy and drops the new person. The parent's company is not changed.
- **`outreachInputs`.** Inherited companies are skipped for people search, and still count in `domains`, because a new person there can need a catch-all probe the parent never paid for (a stale or absent `domain_state`). A card can only be too high.
- **A top-up's Outreach card** has no perspective or Concierge allowance, since it makes neither call.
- **Reuse.** An answer the parent paid for counts as saved on the top-up, once, at its real cost: it did replace a call. A top-up's own answers never count. Skipping an inherited company logs nothing, since no stored answer was read.
- **`currentUploader`** is the latest upload not brought by a top-up, which on a merged parent is the first list. The document says first list; the existing rule that a later upload voids an earlier card still holds this way.
- **`sheet_refreshed_at` sits on the top-up**, so a crash between merge and refresh is retried at boot and the parent's own row does not change. A merge on a parent with no Sheet yet publishes the parent's first one.
- **Refresh.** Every tab is read and checked before anything is applied or replaced. A Review tab with no contact_id or Decision is a failed read. Rebuilding an old Sheet is a person's confirmed choice and loses what could not be matched. Company and Account owner on Meetings stay lookups.
- **The parent's history** gets one line at a merge and none at creation or end: a stopped run stays visible in the attendee list block.

**Known limits.** Someone typing on the Sheet between the read and the replace loses that edit. A rep's note on a person no longer on the list goes with the row. Identity already paid for a company later found at a parent's domain stays spent; only what comes after is saved. A stopped top-up's rows stay on it, and a later file counts those people as new. Apollo sequences are not touched (section 5).

## 30. What two fresh-eyes reviews changed (2026-11-09)

Two reviewers, one reading the README against the code and one reading only the code, found defects the tests had not.

**Lists.** The Never contact and Existing customer lists confirmed in an ICP were displayed and never applied. They now join the event's lists, from the pinned version once there is one. A company that arrives after the free name pass (a reverse lookup, a website a person gives on a case) meets the lists too.

**Opt-outs.** An opt-out stops the person in the free pass, before Research can look them up. It keeps the name and company as well as the address, matches on either, takes someone already set aside off the Other attendees tab, and starts a rebuild of any delivered Sheet the person was on. A Sheet that cannot be rebuilt says so beside its link. A drop typed into the Review tab stays visible on that Sheet until the next rebuild, because rebuilding replaces the file people are typing in.

**Runs.** One run at a time per event, in process. A failure while closing a job, or in the work between jobs, pauses the event with a line in its activity. A job whose closing failed goes back as lost, so the resume never repeats a call of unknown outcome. `ready_for_review` can pause.

**Paying twice.** A step is marked done in the same write that closes its paid call. A person already kept is left alone on a replay. Apollo's match from Research is reused in Outreach and by the LinkedIn step.

**Left as they are, and said so in the README.** The AI cap counts calls and its dollars are an estimate. ICP reading and the test bench are outside the cards and Usage. Apollo's searches are treated as free, unconfirmed. There is no login, so the server listens on this machine unless `HOST` says otherwise, and `/ask-desk` answers only mapped users and approvers.

## 31. One end-to-end video (2026-11-09)

The plan called for two videos, a short one for visitors and a narrated one for Bryan. A first 84-second cut passed its sound, frame and fact checks and still failed: it skipped most of the system. Bryan chose one video that does both jobs. It runs 3:19, covers every part of the system against a written list, and follows one person from the raw file to the Sheet. Coverage is now part of the video gate. The film's project is kept outside this repo.

**Replaced 2026-11-10.** The system grew past the film (everything after delivery), so it was redone on the same structure: 3:41, one narrator, one company and one person from the attendee list to a deal. A cut with three voices (leadership, an SDR, an engineer) was made first and rejected by Bryan in favor of one narrator. Every camera move is timed to the word it shows. The script was fact-checked by a fresh-eyes review before voicing.

## 32. The hosted demo runs on Render (2026-11-09)

Cloudflare Workers and Vercel run code in short requests. This app runs long jobs and keeps its demo database in the process, so either would have needed a port and a separate database. Render runs it unchanged as a normal server, on the free plan. Three things make it fit in 512 MB: prebuilt sample data, small Postgres caches, and Node 26, which alone cut startup from about 840 MB to about 300. With no login, whatever one visitor uploaded the next could read, so the hosted demo takes no files.

## 33. Everything after delivery, as built (2026-11-09)

Built on branch `v2` from `docs/LIFECYCLE.md`. What changed from the spec while building, and why:

- **Free placement by email domain was built and backed out.** In the authored world it raised false merges from 2 to 6, because a work address can be a former employer's. Every person with no company gets the paid lookup; the domain places them only when the lookup finds nothing.
- **A sending layer was added (section 5a).** The first spec covered who may be contacted and left inboxes to the tool. Two outside reviews, one against an older production system and one against current practice, found 48 gaps, 15 of them blockers. The desk now sizes inboxes, picks the healthiest, requires placement tests, and stops a sequence that is short.
- **Gong is refused for sending.** It reports no replies or opt-outs, so stopping someone the moment they answer cannot work there. Bryan, 2026-11-09.
- **LinkedIn accounts need their rep's consent.** LinkedIn's terms prohibit automation and the accounts are real people's. The risk is recorded per account.
- **A tool that cannot hold a person is never re-added mid-sequence.** Re-adding would restart them at step 1, so once anything has gone out, a stop on such a tool is final.
- **List terms are not checked.** Skipped by Bryan, 2026-11-09.
- **Reply text is cleaned before anything reads it**, so "unsubscribe" in a quoted footer cannot opt out someone who said yes.
- **ROI has written definitions.** New pipeline: created within 30 days after a held meeting, with no open deal before it. Pipeline it moved: already open and moved forward within 90 days after one. One deal counts for one event. Accounts nobody reached are shown beside the accounts met.
- **Testing is tiered.** Touched files while building, the full suite in the background before a commit, real Postgres once per batch and in CI.


## 34. Slack in the open: one channel per event, no direct messages (2026-11-09)

v2 first sent owner cards, hot replies, reminders and debrief prompts by direct message, and event news to a thread in the approvals channel. Bryan caught it: direct messages hide the work from the team, so nobody can see who has a reply, cover for someone out, or learn from what landed. Now each event has its own public channel, opened by the desk on first post, and every card for the event goes there with the responsible person @-mentioned and invited first (Slack does not notify someone outside a channel). Problems that belong to no one event go to an ops channel. This matches §10, where cost approvals already used a channel with an @mention instead of a direct message. Costs: one more channel per event in the workspace, and the bot needs `channels:manage` to open them.

Alerts used to land only in a table and the server log, served by an endpoint no screen called, so "Instantly went quiet, 4 sequences paused" would have gone unseen. They now go to the ops channel. With them: a 30-second timeout on every tool call and 15 on Slack, a report when a background pass runs past 15 minutes, and `/api/health` answering 503 when no pass has finished for 20, so an outside uptime check sees a dead desk even when Slack is the thing that is down.

Where approvals go (Bryan, same day): a cost card for paid steps stays with the SDRs, so it posts in the event's channel with the uploader invited and @-mentioned; only the uploader can still confirm it (§10). Seat requests and seat approvals are leadership's, so they go to their own seats channel (`SLACK_SEATS_CHANNEL`) and never to an event channel everyone is on.

## 35. A delivered event shows one layer at a time (2026-11-09)

Bryan: "throwing all the data we have about this event regardless of the layer I think it's tough on usability." The event page had grown to the header, a facts row, the attendee file, the list figures, outreach, the list's briefs, cases, the people table and the history, one after another: about 6,900 pixels tall on a phone. Now a delivered event shows the header, one line for the one thing that needs a person (`/api/events/:id/next`, cheap counts in a fixed order: cases, the outreach card, replies waiting, the follow-up, sequences to check, meetings to record, outreach not started), and three views. Outreach is the work in motion, People is the list, Details is the event's facts, its file and its history. Before delivery the page stays whole, because there is one job then. The header gained a Follow-up step between In market and Closing: the post-event wave had no place on the timeline, and the event moving to Closing at day 14 would have said "closing" while follow-up emails were still going out.

## 36. Overview shows the whole life of an event (2026-11-09)

Overview stopped at "list delivered": it listed lists and their priority counts, and its risks were only the list's. It now answers where each event is, what needs someone, and whether it is working, from what v2 knows. Replies waiting on a rep lead "Needs someone", because a reply goes cold fastest. "Outreach" replaces "Outreach lists delivered" (one block, every delivered event, its step and three figures). "Did it pay?" shows pipeline for every dollar, labeled "so far" until an event is scored. The step words come from one place (`src/app/stages.ts`), so the rail, the Events list, the side sheet and the event header never disagree. The person panel leads with where that person is in outreach. People and company tables page at 12 rows.


## 37. An event's channel: who is in it, and when it closes (2026-11-10)

Bryan asked whether the channel process was right. The timing stays: a channel opens with the event's first card, the cost card once the list is in, because before that there is nothing for the team to work on and seat decisions are leadership's in their own channel. Two things changed, on his yes. Everyone with an approved seat is invited when the channel opens, and anyone approved later is invited by the background pass, so the team sees every reply and hot lead from the first card rather than only once a card names them. The channel's topic names the event, its days, its city and, with `APP_URL` set, a link to its page. And the channel is archived 90 days after the event's last day (Bryan chose 90 over "when scored"), after one closing line; the 30-day scorecard card is its last real message. A card for an event whose channel is closed goes to the ops channel with the event's name, rather than reopening it. Code: `src/server/event-room.ts`; constant `ROOM_ARCHIVE_DAYS` in `src/shared/policy.ts`.

## 38. A finished event shows its result; Results ranks every event (2026-11-10)

Bryan found NRF said Scored and showed nothing behind it. The desk had computed everything (five scorecards, deal-level attribution, a control group, debriefs) and surfaced only totals to leadership. Now: once an event's sending is done (Closing, then Scored) its page gains a Result tab, first, beside Outreach, People and Details. Bryan's call: outreach and results are different jobs and do not share a tab, so Outreach keeps only the outreach and lost its money column. The Result tab shows one verdict (the multiple for leadership, meetings held for everyone else), the credited deals with the meeting each came from, and what the team learned; the evidence (met against not met, where the pipeline came from, the checkpoints, costs to enter) is one fold for leadership. A Results page in leadership's and GTM's menu ranks every finished event by pipeline per dollar, with what converts across events, accounts passed on that later bought, and ICP suggestions for GTM. Debriefs show who has written and who has not. Booking a meeting now answers that person's reply, so it stops waiting on a rep. Code: `src/app/Result.tsx`, `src/app/Results.tsx`, `GET /api/results`, deals in `computeScorecard`.

## 39. The desk prices each cost card itself; the uploader only confirms (2026-11-10)

Bryan asked why a person had to request a card before confirming it. Nothing on record answered it: the card is "a human check that the person who uploaded the list means to run the paid steps" (SPEC), and asking for a price commits to nothing and spends nothing. The request was a step between the upload and the real decision, and it made its own to-do ("Cost not yet requested") on Overview.

Now, with `autoQuote` on (the server and the demo; off by default in tests that walk the manual request): the Research card is priced in the uploader's name as soon as the list is mapped, and the Outreach card as soon as research is done and no blocking case is open (after the pipeline's last job, after the last case is settled or skipped). A setting changed while a card waits sets that card aside (declined, "Priced again: settings changed", its free work put back) and prices a new one, so settings no longer lock before the card is confirmed; they are fixed once it is. The confirm step is unchanged: only the uploader of the current list confirms, in live mode by their own Slack click. A card that cannot be made yet (a case open, research finishing, no Slack user in live mode) waits; the event page keeps a "Price the card" button and Overview shows it as "Not priced yet". Tests: `tests/auto-quote.test.ts`.

## 40. Every event has a cost ledger, entered by leadership (2026-11-10)

Bryan asked how sponsorship and the other costs get logged, and called it a gap: the desk counted tickets, travel and AI, and nothing else, so pipeline per dollar flattered every event with a booth. Now each event has a Cost tab for leadership and GTM. Tickets, travel and AI are filled by the desk. Sponsorship, booth, dinners, swag, tools, rep time and other are entered in place, each with an amount, an optional note (vendor or invoice), who entered it and when; zero is an answer ("None"), different from not entered. `eventCost` is the one source for every screen, and it prices AI the way Usage does, from the tokens each call reported (the flat rate only for calls with none); a fresh-eyes review found it had used the flat rate for every call, so the two screens would have disagreed on real calls (`tests/ai-cost.test.ts`). Entering or clearing a line logs it in the event's activity and reprices every scorecard already written (cost and ratios only; counts and pipeline stay as written), so a late invoice corrects the verdict instead of leaving it wrong. Lines still missing on a closing or scored event show on Overview and the Result tab as "Costs to enter". Code: `src/server/closeout.ts`, `src/app/Event.tsx` (CostView); tests: `tests/event-costs.test.ts`.

## 41. A rep's reads carry no money, checked by a test that walks them (2026-11-10)

A fresh-eyes review found dollars reaching reps through reads the screens did not show: a card's estimate, a seat price, activity lines with amounts. Hiding them on screen was not enough, because the API answered anyway. Now every read a rep can make strips any key holding cents or AI call counts at every depth (`forRep` in `src/server/money.ts`), and the event read drops seat prices, AI spend and activity lines with an amount. `tests/rep-sees-no-money.test.ts` walks every read a rep's screens make, as Maya, on an event in motion with costs and meetings recorded, and fails on any money key with a value or any dollar figure in the answer. One exception: the catalog's ticket price, which a rep needs to ask for a seat. Scorecards keep their shape for reps with the money set to zero, because the screens read that shape. This is consistency, not security: "Acting as" is still self-chosen (README).

## 42. Each sequence keeps what the tools report about it (2026-11-10)

Bryan asked for a way to get sequence data into the desk, before and after the event. The tools already reported every send, reply, bounce and unsubscribe, with the sender and step, but the desk dropped which sequence each came from, and on LinkedIn it listened for replies only, so nobody there was ever "reached" in real mode. Now every event keeps its sequence and step, HeyReach reports connection requests sent and accepted and messages sent (event names from third-party docs, unconfirmed), an invite counts as a send so every existing "reached" rule holds, and each connector says which signals it reports so a figure it cannot back reads "not reported", never 0. One read per sequence counts reach, replies, steps, senders and sends by day one way. Spec, goldfish-reviewed twice: `docs/SEQUENCES-VIEW.md`. The demo now runs each finished event's pre-event wave on a clock before it, then its follow-up, so both halves exist.

## 43. People, companies and sequences open as sheets; each sheet kind has its color (2026-11-10)

Bryan: the inline person card could not hold everything without breaking the page, and with this many sheets a reader should know which kind is open. A person, a company and a sequence now open as side sheets like replies, meetings and deals, each linking to the objects connected to it where they exist (meetings, replies, sequences, deals, the account), never as decoration. Every sheet names its kind above the heading in one muted color, with a hairline of it on the top edge: meeting green, reply blue, deal ochre, notes plum, person teal, company slate, sequence umber, event ink. A hands-on fresh-eyes review walked every reply and link; its findings are fixed. `tests/stage-handoffs.test.ts` walks one event from seat request to scored through the app's own routes and checks every handoff.

## 44. One sequence naming convention (2026-11-10)

Bryan asked for a solid naming convention. Names had been put together inline, mixed case, with the region left out when it was the event's own. One function now owns it (`src/shared/sequence-name.ts`, rules in `docs/SEQUENCES-VIEW.md` §7): `Desk | <YYYY-MM> <event> | <Before or Follow-up> | <Email or LinkedIn> | <audience> | <region> | <desk id>`. It is the campaign name the team sees in Instantly or HeyReach, so it is built for their list: one prefix to filter on, event order by name, every part always present, ASCII only, at most 120 characters, and the desk's id last because the desk finds its campaign again by name after a crash.

## 45. Eight sequences an event: four audiences, two channels (2026-11-10)

Bryan: "cut those sequences... why did you think it was a good idea to run a sequence per region?" The desk split by priority and region before the event and by group after it, up to twenty sequences an event. Now: before the event, attendees and prospects; after it, attendees and prospects the desk did not hear from; each on email and LinkedIn, all in the event's one Salesforce campaign. Priority orders who goes in first; every sequence sends on the event's own zone; region matters only for the legal basis. A badge scan now hands the person to the rep who scanned them, with a CRM task, instead of its own follow-up (Bryan chose it over sending scans into the follow-up). The screens say "sequence"; "campaign" is the CRM's word. Spec, goldfish-reviewed: `docs/SEQUENCES-VIEW.md` §8. My error to own: the region split was a send-time choice I made without asking, and it multiplied with every other split.


## 46. A CRM setting, with CRM Desk as the second CRM (2026-11-12)

`CRM` picks the desk's CRM. Unset (or `default`) keeps the CRM the desk has today: `simCrm` in the demo and `noCrm` in live mode, so nothing changes for anyone who does not set it. `CRM=crmdesk` uses CRM Desk through `src/server/crm-desk.ts`, which needs `CRM_DESK_URL` and `CRM_DESK_KEY` (a key made in CRM Desk with `--desk events_desk`). `CRM=salesforce` is refused at start, because the desk has no Salesforce adapter and running a stand-in under that name would look like a real check. An unknown value also stops the server. Every CRM Desk call fails closed: a timeout, a refused connection, a 429 or a 5xx becomes `CrmDown`, so the run pauses and nobody is dropped. A 409 `erased` is a finished write with nothing written. The contract tests in `tests/crm-desk-contract.test.ts` cover tests 1, 3, 4, 5 and 6 of CRM Desk's `docs/CONTRACT-TESTS.md`; the half against a running CRM Desk is skipped unless `CRM_DESK_URL`, `CRM_DESK_KEY` and `CRM_DESK_ADMIN_KEY` are set. The cost: a second CRM to keep in step with the `Crm` interface in `providers.ts`; the public CRM Desk demo refuses API keys, so the adapter runs only against a private install.

## 47. An event starts as a plan, and the plan stage sits beside the list stage (2026-11-13)

`events.plan_stage` (`planning`, `confirmed`, `preparing`, `live`, `following_up`, `judged`) is a second column decided by one pure function, `planStageOf` in `src/shared/plan.ts`, from the approval, the dates, the list stage and the motion. The list machine in `src/shared/domain.ts` is not changed (`tests/plan-contract.test.ts` freezes it), and `moveWithin` stays the only writer of `events.stage`. Approving a plan is the `requested` to `approved` edge that already existed. Declined and paused stay list states: a declined event keeps the plan stage it had; a pause never moves it. Spec: `docs/EVENT-PLAN.md`.

## 48. Leadership approves the budget, not each seat (2026-11-13)

New events are budget mode: a planner writes the plan, an approver who did not write it approves the planned total, and that approval covers the passes inside it. A seat is still a `seat_requests` row, so tickets, the ticket budget and event cost work unchanged. An approver's own pass waits for a different approver. A rep still asks through Seats, and the ask lands on the plan as "ask to go". Going over the approved amount warns, waits for the approver, and never blocks. Events made before this stay per-seat, with decisions 10 and 13 as written. This amends decision 13 for new events only.

Superseded in part by decision 104 (2026-11-17): a desk with no Slack decides a plan in the app, the same `approvePlan`; with Slack connected the card stays the one path. Superseded in part by decision 105 (2026-11-17): a planner can close the result.

## 49. Planned, contracted, actual; and actual is never stored (2026-11-13)

A budget line holds planned and contracted. Actual is read from where money is already recorded: tickets, travel, and the cost ledger of decision 40. `eventCost` stays the one source, so the plan, the Cost tab, the Result and the Budget cannot disagree. "Committed" keeps its decision 15 meaning (approved seats not yet bought) and is not used for budget lines. This extends decision 15: Budget still answers the ticket question first, and now also shows each event's three columns. Spend on a top-up's own hidden event stays out of `eventCost` of the shown event, as it does today.

## 50. A hosted event is its own event (2026-11-13)

A dinner, side event, roadshow stop, webinar or customer event has one `hosted` involvement and its own budget, people and result. When it hangs off a conference, the involvement names the conference in `conference_event_id`; the conference's page shows it, and its money is never added into the conference's. `events.parent_event_id` stays the top-up's column.

## 54. A planner sees the money of the plans they write (2026-11-13, Bryan said yes)

`planners` is a configured list in `config/defaults.json`. A planner reads and writes plan money; reps still see none, and the test that walks a rep's reads covers every new one. A planner cannot approve. `isLead` is not widened: a new `canPlan` admits planners to the plan's money reads, `/api/budget` and `/api/results`, through one edit to the middleware in `src/server/app.ts`; Usage, AI spend and Settings stay as they are. This widens decision 41 by one named role. Proposed, default yes. Bryan was asked; the build proceeds on this default and the decision stays proposed until he answers.

## 55. The demo's in-flight plan is AWS re:Invent 2026, written onto the event that already holds its list (2026-11-14)

Bryan chose re:Invent as the plan in flight (spec section 17). The real-events seed already holds it as the demo's paused event, with twelve approved seats and a 140-row list, and one catalog entry never has two events. So the seed writes the plan onto that event (budget mode, Camille Laurent as the maker, twelve passes, a booth sponsorship, a talk with no title, a goal, budget lines, approved by Dan Whitlock) instead of making a second one. The event stays paused. Money20/20 USA 2027 is no longer in the demo.

## 56. Editing a plan happens where it is read; declining needs a reason (2026-11-14)

The Plan tab edits the reason, the goal, the budget lines, who goes and the ways of taking part in place, for planners only, each with one save button. Budget lines save one at a time. A plan is made from Events, "New plan", for planners: a listed conference, one that is not listed, or a hosted event. The approver's second choice is Decline, which asks for the reason the database demands and ends the event as declined. The Approve button stays the one primary action.

## 51. Every list carries where it came from (2026-11-14)

`list_source` is on the upload, each source row and each attendee contact: downloaded from the web app, downloaded from the app, emailed by the organizer, sponsor export, other (with a note). It is its own column, separate from `contacts.source` (attendee, prospect, onsite). It is recorded and shown; the gate does not read it (Bryan, 2026-11-13). The upload screens ask for it before the file picker works; a caller that sends no header is stored as "other", and a value outside the five is refused by the route and by the database. A top-up keeps its own source through the merge. Prospects and walk-ups have none.

## 52. The assessment is proposed by a model and confirmed by a person, with a quote that must be in the page (2026-11-14)

An assessment is seven questions about an event's attendee list: is there a directory, which tickets see it, what it shows, whether an attendee can hide, whether the list can be downloaded, what a sponsor gets beyond that, and what the terms say. The model reads only what a person pasted, or one public https page the person linked, and proposes answers with the sentence each came from. Code drops a proposal whose sentence is not in the text the model was sent, after both sides are normalised (Unicode NFKC, HTML entities decoded, curly quotes straightened, whitespace collapsed), and drops a quote under 12 or over 400 characters, an answer outside the closed lists, and any answer to a question already confirmed. A person then accepts, edits or leaves out each one; nothing the model proposed counts until a person confirms it. Last year's confirmed assessment for the same conference is copied as proposals and confirmed again, because terms change. The call is counted before it is made, under a lock on the assessment, and capped at six an event (`plan.assessment_calls_per_event`), so a call that fails or never answers is still a call spent. Planning has no cost card, so the ledger is not touched; the calls show in Usage only. In the demo the model is never reached: a simulated one answers from the recording for the sample pages and says "The demo reads only the sample pages." for anything else. The idea is the debrief rule's (`extractDebriefs`: a fact with no quote in the text is thrown away), with the normalising a web page needs.

## 53. The desk drafts the organizer email from a template and never sends it (2026-11-14)

The email asking an organizer for the attendee list is two fixed texts (the ask, and a follow-up that quotes the date of the first) and a function that fills in the event, the passes the team holds, the sender and the company. No model writes any of it. The desk stores the text as rendered and shows it read only, with one button that copies it. The person sends it from their own mailbox. There is no send route and no mail link. The desk keeps who copied it, the day the person says they sent it, the day the organizer says the list comes, and a follow-up date it works out itself: the day after the expected day, or seven days after it was sent. Both dates join the week's deadlines, owned by the person who drafted the request, until the list arrives or the organizer says no. A list uploaded as emailed by the organizer closes the open request as received, in the upload's own transaction. The request is offered once the assessment finds a directory (a confirmed yes), and a planner can draft one by hand before that.

## 57. Deadlines are read, not stored twice (2026-11-14)

The spec numbered this decision 55, which the demo's in-flight plan already took, so it is 57. `event_deadlines` is a view over deliverables and sponsorship payments (the organizer request joins it in `0052`). "This week" is anything late plus today and the six days after it, not done, on an event that is not declined. Nothing about a deadline is copied into a second table, so a person marking a deliverable done is the only write, and the week, the Plan tab and the year agree by construction. Later steps add their own rows to the view.

## 58. Hosted guests are not gate subjects (2026-11-14)

A guest on a hosted event's list is a person the host invites personally, not a contact on an attendee list sold to a sequencer. The gate (`gate.ts`) reads `contacts` and the sequences' consent and legal-basis machinery, so it is not consulted and not edited. The desk's one outreach check for a guest is the country rule, plus a refusal for an address that opted out or is known not to be theirs.

## 59. An unknown country blocks email (2026-11-14)

`config/defaults.json` `email_country_rules.blocked` lists the countries the desk never emails (IT, CH, SE, DK, BE, AT, NO, DE: Account Desk's defaults plus Germany, which Bryan named). A guest whose country is blocked, or not known, is never emailed by the desk. A guest's own yes does not lift a block. The host writes to those guests by hand. These are Events Desk's defaults until Account Desk's editable rules.

## 60. The transactional sender is separate from the sequencer (2026-11-14)

Confirmations, reminders and a seat that opened go through one module that is not a sequence, has no cadence and no cold step. It runs whatever `INTEGRATED_WITH` names. A send whose outcome is unknown is never repeated, and a second run of the same kind inside ten minutes is refused. Live mode without `TRANSACTIONAL_URL` and `TRANSACTIONAL_KEY` refuses to send and says why.

## 61. The no-show default (2026-11-14)

Expected no-shows start at a stated 20 percent (`hosted.noshow_default_pct`), the planner may set a number for the event, and the team's own history replaces the default once two hosted events with attendance closed hold ten yes answers. The page says which one it uses. Pheedloop's medians (28 percent for free events) are a reason to over-confirm, not a forecast for an invited dinner.

## 62. The assessment is scored against labels, and the demo never replays the real model (2026-11-14)

The assessment step was recorded from the real model (claude-opus-5-5, 7 calls, $0.06) and scored against the builder's labels on seven pages. Of 19 labelled answers it matched 16 (84 percent; the 95 percent interval is 62 to 94, and the set is small). By question: `directory_present` 4 of 4, `directory_tickets` 1 of 1, `directory_fields` 2 of 2, `can_hide` 2 of 2, `sponsor_adds` 4 of 4, `download` 2 of 4, `terms` 1 of 2. No quote was invented, and the page carrying an instruction produced no download answer.

The misses are specific. On two pages the model read "browse and filter in the app" as "download from the app", which is wrong; the page says nothing about downloading. It left out one terms sentence. On the registration terms it answered `none` where the label says `emailed`; the page supports both readings, so that one is a gap in the question, which does not say whose download it asks about. It also answered five questions the labels leave open; four of those are supported by the page and one (`directory_tickets` on the app store page) is a stretch. A person confirms each answer, so a wrong one costs a rejection, not a wrong fact.

Floors per question sit below this first run (0.9 for the directory, 0.4 for `download` and `terms`, 0.5 for the rest), so a worse prompt or model fails and noise does not. They are not tuned on the labels. We did not relabel to match the model.

The demo, the seed and the logic tests replay the hand-labelled recording, not the real one. The real model's answer on the Money20/20 note was `app`, which would have seeded the sample plan with a wrong download answer and left a proposal unconfirmed; the demo needs the same answers every time. The real recording is only scored. Re-record after any prompt change; the freshness test fails until it is.

## 63. A scan is the phone's own id, placed in three steps that can each run again (2026-11-14)

The phone makes a UUID for every scan and writes it to IndexedDB before anything else. The desk stores the row with `ON CONFLICT (id) DO NOTHING`, resolves the person (an organizer call or a photo read, outside any transaction), and places the person through today's capture path (decision 45), in the same transaction that sets `contact_id` and the final state. The capture's id is derived from the scan's, so a crash between the capture and the scan row cannot make two captures. A repeat of an id by a different actor is refused (409), not answered with the stored result, so one rep cannot read another's scan by replaying its id. Acting as is self-declared across the desk (README); this is a courtesy, not access control. Docs: `docs/SCANNER.md` 7 and 14.

## 64. Dedupe order, near matches and merging (2026-11-14)

The finder orders its keys: the organizer's registrant id, then the email, then LinkedIn, then the name at the company. A match joins the existing person: two reps scanning one person is one person, two scans, two CRM tasks. A person nearly the same (same company and a name one letter or a short form apart; or the same name written with another company at the same email domain) opens a review and stays placed. "Same person" moves the captures, touches, meetings, replies and other scans to the kept person and drops the scan's own person with the existing reason `duplicate`; it refuses when that person is in a sequence, has replied or came from a list. The decision is asked for, never taken.

## 65. A photo read is counted, capped and always checked by a person (2026-11-14)

The scanner reads a badge or business-card photo with the model as an input job (`scan_read`). It is counted in `llm_calls` before the call under a lock on the event, capped at 300 a event (named when hit), never repeated when the outcome is unknown, and not on the event's cost card (it is not a priced vendor step; the cap is the spend control). The call row keeps tokens and the model, never the transcribed card text. A field is thrown away when it is not shaped like its kind or its value is not in the text the reader says it transcribed; the rest is marked "check" when the reader was not sure. A person confirms every read before it counts, because a vision model can misread a digit with no signal. Templates, not a model, write anything a person sends.

## 66. Consent is stored with the wording the person saw (2026-11-14)

The notice line is on the scan screen. Marketing consent is off unless the person says yes. Each scan stores the answer, the notice version, the wording itself and the time; the person's record carries the consent and its source. Every edit to the notice is a new version and old scans keep their wording. The scanner never decides whether an email may be sent: the existing gate does, by country and basis (country rules gate outreach, not the source). **Risk: legal.** Consent for scanned contacts is contested in the EU; counsel confirms before any live use. Photos and raw payloads are deleted 90 days after the event's last day; erasing a person deletes their scans and photos, but not a phone's copy or a CSV already exported.

## 67. The organizer adapter says what Swapcard documents and no more (2026-11-14)

One interface turns a badge id into a person. Swapcard's Exhibitor API is the first implementation, built from its public developer page: `scanBadges(input)` with `eventId`, `exhibitorId` and `scanBadges: [{code}]`, answering a `connection.target` (`firstName`, `lastName`, `jobTitle`, `email`, `organization`, `address`) or an `errorCode` (`CODE_NOT_FOUND`, `FEATURE_NOT_ALLOWED`, `USER_NOT_IN_EVENT`). Not documented, so not assumed: the `Authorization` header's format, rate and batch limits, whether a re-scan makes a second connection, and the consent rules. One badge a call; keys per exhibitor from `SWAPCARD_KEYS`; a lookup makes a connection on Swapcard's side, which the setup screen says. The contract test replays the documented responses against a recorded transport. **A live call waits for a show that enables it.** Cvent and Cadmium fit the same interface later.

## 68. The download question says whose download it asks about (2026-11-14)

Decision 62 found the real model reading "in the app" as "download from the app", and the question ambiguous about whose download. The question the model is asked now says: web app or app only when the page says the list can be downloaded or exported there; emailed when the organizer sends the list to sponsors; browsing, searching or filtering is browse only and never app. The screen's wording is unchanged. Re-recorded the same day (claude-opus-5-5, 7 calls, $0.07): 19 of 19 labelled answers matched, `download` 4 of 4, `terms` 2 of 2. This is an in-sample number: the wording was written after seeing the misses on these same seven pages, and the Wilson interval is 83 to 100. It shows the two failures are fixed, not that the question generalises; it needs pages the wording was not written for. `assessment_propose` is now in the strict stale check (`EVALS_STRICT=1`), which also compares the hash of every filled prompt, because the questions are filled into the template and a change to a question's wording leaves the template's hash alone.

## 69. A capture key signs the extension, and it can do one thing (2026-11-14)

The Chrome extension carries a capture key a person makes in the desk's settings: `edk_` and 43 URL-safe characters from 32 random bytes, shown once, stored only as its SHA-256, at most five unrevoked for one person, scoped `add_people`. It is accepted on exactly two routes, `GET /api/capture/events` and `POST /api/capture/people`, which the actor middleware lets through by exact method and path. Everything else still asks for the write key and an acting name, so a key that leaks adds reads to events that can take a list and reads nothing else. Scope is checked in code on every request so a second scope later cannot be read as this one. The send is capped at 200 people, 1 MB, 3,000 reads an event and 600 people a minute a key, and both routes are refused in the public demo. That the key's owner is the actor, and that only its owner or GTM Engineering revokes it, are as strong as the actor header across the desk: courtesies, not access control (decision 63).

## 70. Reads are staged first and brought in later, with a source sentence the server builds (2026-11-14)

A person seen in a directory or a recording is a read (`directory_reads`), not yet a person on the event. A read is staged, to check, brought in or dismissed, decided by one pure function (`judgeRead`) for both paths. Bring in turns the staged reads (and the ones already brought in, so a replacement loses nobody) into a CSV and runs `ingestUpload`, so Layer 0, the cost cards and tiering do for these people what they do for a file. The source sentence ("read from the Swapcard directory of AWS re:Invent 2026 by Maya Okafor on 2026-11-14") and the terms note come from the platform, the event, the key's owner, the server's date and the event's confirmed `terms` answer; the request carries neither, so a page or an extension that lies cannot write them. Each person keeps the path they came by (`directory_extension` or `screen_recording`) and the two upload sources are not accepted from the `x-list-source` header. Reads reference contacts with `ON DELETE SET NULL` because a replacement deletes contacts; erasure is explicit, by contact, by name and company on any event, and by profile link, and reads never brought in go 90 days after the event's last day.

## 71. The blocked-country list now binds the email gate for everyone (2026-11-14)

Bryan's rule is that people from the extension or a recording are contacted under the same rules as anyone else, by country and never by source, and that Italy, Switzerland, Sweden, Denmark, Belgium, Austria, Norway and Germany stay blocked for everyone. Until now `email_country_rules.blocked` was read only for hosted guests; the gate held only the recorded contact basis per region. The gate gains one check in `localChecks`, on the email channel, before the contact-basis check: a person whose region (`regionOf`, normalized by `normalizeCountry`, which now knows the native names) is on that list is refused with `country_blocked` ("not emailed in their country"). It applies to every person on every event, whatever the source, and LinkedIn touches are not affected. A person with no known or no listed country behaves exactly as before, which differs from hosted guests (unknown blocks there); that difference is deliberate. Both places are read, the country in the last comma part of the person's location and the company's country, and either one on the list blocks the email (a person located "Berlin" at a German-headquartered company is blocked), so it errs towards not emailing. This changes a rule that running events already live under: any of their people in those countries stop at the email gate, and the demo's German, Italian and Danish companies stop too.

## 72. A recording's frames are chosen in the browser and are not stored (2026-11-14)

The video never leaves the person's computer. The page plays it locally, takes a frame every 0.7 seconds of video, keeps one only when it differs from the last kept, and sends the kept ones one at a time as JPEG. The desk holds a frame for the one model call and drops it: no `bytea` column exists for it, and the `llm_calls` row keeps the model and the counts, never the transcribed text. A recording's total says how many frames failed so the person can record that stretch again; a frame left reading for ten minutes shows as failed and is not read again. The frame route has its own 4 MB body limit and is not a file route.

## 73. The recording read is counted and capped, not on the cost card (2026-11-14)

Same reasoning as the scanner's photo read (decision 65): the vision call (`directory_read`) is not a priced vendor step, so the cap is the spend control. Each frame is counted in `llm_calls` before the call, inside a transaction that holds the event row, and the frame's own row is taken first so a repeat returns the stored result and calls nothing; a thrown call marks the frame failed and is never retried by the desk. Caps: 250 frames a recording and 800 frame reads an event (counted from the call rows), and 3,000 reads an event in all. The model's reply is checked in code (`checkFrame`): a person is kept only when the transcription holds the name, a title, company or place not in the transcription is thrown away, and at most 40 people a frame are taken. That check cannot defend against a frame that steers the model, since the transcription and the people come from one reply, so a name or company that reads like an instruction, a link or a sentence is held to check, and every read is shown to a person before it is brought in. In the demo the simulated model cannot see, so it is refused where a person would wait for a read that can never come.

## 74. A call hangs off an event, and a candidate event is a plan (2026-11-14)

A call for papers has an `event_id`, because a candidate event is already an `events` row in the planning stage, and the model read that finds calls is counted in `llm_calls`, which needs an event. A catalog entry with no plan has no call: make it a plan first. Money20/20 Europe 2027 is that plan in the demo, with its call closing 27 November 2026.

## 75. The author never approves, in the schema as well as the code (2026-11-14)

Market Desk's two-person pattern, with the database as the backstop: `talks_abstract_two_people` and `talks_slides_two_people` refuse an approver equal to the author, and refuse an approval with no author (a NULL cannot pass). The author is the last person who changed the words, so editing after an approval clears it and makes the editor the author. A submitted abstract is frozen, and slides cannot change once sent. Planners approve; the speaker writes; a rep who is neither reads only.

## 76. The model proposes calls, the person adds them (2026-11-14)

`cfp_read` reads one page the person gives and proposes calls. A proposal is kept only with a real date, a quote found in the page and a link that is the page's own or appears in it (links are kept as text when the page is fetched for this step), and nothing is stored until the person adds it. Five reads an event, counted before the call, not on the cost card. `isPublicAddress` now also refuses IPv4-mapped IPv6 written in hex groups.

## 77. The kit fires inside the write that makes it true, and holds no image (2026-11-14)

An offer row is written by `decideSeat` (a one-line insert; the function is otherwise unchanged), by a talk becoming accepted, and by a hosted or sponsorship involvement becoming confirmed. Images are drawn when the person opens the kit and kept nowhere, so a removed photo leaves no copy. The roles a person can ask for come from rows the desk holds. Sponsoring is fired from a confirmed sponsorship, which the brief did not list; the template needed a path.

## 78. The photo is the person's, from an upload or Slack on their tap (2026-11-14)

One photo per person, checked by its bytes and 2 MB. The Slack photo is fetched once, on the person's tap, only when Slack is connected and knows them, from Slack's own image hosts over https. Removing deletes the row. The organizer's kit is a colour, a hashtag and a PNG logo a planner saves (PNG only, so nothing in it can name a file or an address). No fallback logo is fetched.

## 79. The desk draws six files for five sizes and never posts (2026-11-14)

Satori and Resvg with IBM Plex Sans bundled from the installed `@fontsource` package. LinkedIn post landscape and 4:5 count as one size in the brief; there are six files. Captions are templates. A pasted post link is checked as text (https on linkedin.com) and never fetched. A test reads the source for any request to LinkedIn or its posting API. The Result's posting count is the desk's own, labelled as not a finding.

## 80. The follow-up names the talk where the rep makes it (2026-11-14)

Scanned people are a rep's and never sequenced, so no sequence template changed. A scan picked "from the session" carries `talk_id` (only an accepted talk of that event; otherwise the scan is stored without it, because scans sync from an offline queue), and the talk shows on the scan list, the CSV and the rep's hand-off.


## 81. The Overview comes in three layouts, and each person keeps their own (2026-11-15)

Bryan: direction B is the default, but A (ledger), B (trays) and C (timeline) all stay, as a per-person choice. The choice is stored per person (`person_view_prefs`, migration 0057; the database allows only a, b or c for the Overview) and read with `GET /api/overview` as `view`; `PUT /api/overview/view` sets it under the acting name. No row means b. A quiet three-word switcher (Ledger, Trays, Timeline) sits in the page header, so it is never a settings hunt. All three read the same rows, so a rep's read still has no money in any of them. The layout audit measures all three at 1440 and 375, and the interaction audit checks that a pick shows at once, survives a reload and leaves someone else on the default.

## 82. Bryan's picks of 2026-11-15, recorded as his

- **Step 4's email gate stays as built.** `country_blocked` on email for every contact, whatever the source (the Outreach rule of 2026-11-14). Risk: legal; counsel confirms before live use.
- **The sponsorship kit offer stays.** Decision 77's sponsorship path, which the brief did not list, is kept.
- **Get the attendee list: C (Sheets),** as built.
- **Scanner tab: B** (ledger first, setup and review in side sheets), as built.
- **Phone scanner: A** (camera first, a sheet after the scan, Today in a sheet), as built. A rebuild to B was started and dropped the same day; nothing of it is in the code.

## 83. Prompt caching on every Claude request (2026-11-13).

Every live Claude request now carries a prompt-cache breakpoint on its stable block, with the per-request content after it (`anthropic.ts`, split at the line where the per-request data starts). The cost record counts cache writes at 1.25x and cache reads at the cache-read price; `input_tokens` is now the total including cache tokens, so the cost card never under-counts (it prices cache reads at the full rate, an overestimate). Measured on 2026-11-14 with real calls (usage fields, tokens): company_tier, with a short invented ICP, before 664 input, 0 cached; with the marker, call 1 wrote 631 (33 uncached), call 2 on a different company read 631. Input cost once warm about 90% lower; the first call of each 5-minute window costs 1.25x on the cached part, and a real ICP is longer than the test one, so the cached share is larger. title_tier is about 230 tokens in total, under the 512 minimum, so it is not cached and bills as before (confirmed: 0 written, 0 read). Steps under the minimum are the short ones: title_tier, review, concierge, website_read, debrief_extract (by size). Output tokens are unchanged. About 6 real calls, a few cents. Test: each request carries the marker on the stable block and the per-request text only after it.

## 84. The date cards and the seat bar lead the Overview, in all three layouts; two copy fixes (Bryan, 2026-11-15)

The row of upcoming-event date cards moves to the top of the Overview, with the green seat-requests bar directly under it, then the rest of each layout unchanged. It is one move for A Ledger, B Trays and C Timeline, because the cards and the bar are the page's own parts, not a layout's. Only their position changed (one spacing rule under the bar). A meeting's status shows as "Meeting held", not the bare word "Held" (the status map, the Held group on the Motion section, the outcome button). The sidebar tagline is "Event-led pipeline". Workbook and CSV values are unchanged. Screenshots before and after at 1440 and 375: `~/Developer/events-desk-review/overview-top/`.

## 85. Step 6 is four parts, and part 1 does not claim option A fires (2026-11-15)

Part 1: `INTEGRATED_WITH` as a real setting, the closed routes, the deferral panel, campaign type and parent, the published definition. Part 2: member, activity and money writes, the shared world read, the clock and coverage gate. Part 3: the world additions, Targeted members, the held statuses released. Part 4: the four-desk rehearsal. Why: the goldfish review found that Events Desk queues almost no member statuses today (only Met and Responded), so Account Desk's follow-up trigger would see nearly nothing; that is built in part 2 on its own spec. What others must do is in `~/Developer/events-rethink/steps/step-6-cross-repo.md`.

## 86. `INTEGRATED_WITH=account_desk` closes new sequencer work, never stopping or already-running work (2026-11-15)

Closed with 409 `owned_by_account_desk`: tools, legal basis, drafts, launch steps, templates, placement, consent, domains, resume, and a Motion card for outreach (at the route and at confirmation, and `launchAllowed`). Open: stop and restart, capture, replies, meetings, costs, debriefs, and every transactional send. A sequence already running keeps being watched. `market_desk` closes the ICP's upload, compile, bench, confirm, publish and reopen (409 `owned_by_market_desk`); the profile in force stays. `crm_desk` changes nothing alone. An unknown name stops boot. The setting is read on each call.

## 87. A hosted side event is a child campaign; a child waits for its parent and says so (2026-11-15)

Campaign type is `webinar` for a hosted webinar and `event` otherwise (the adapter used to ignore the event kind). A hosted event under a conference is created with `parent_id` set to the conference's CRM campaign; if that campaign is not in the CRM yet the row stays queued with "parent not in the CRM yet" and uses no attempt. `queueCampaign` queues the conference first; its callers (plan confirmation) come in part 2. Events Desk publishes `campaign_member_statuses` at `/api/definitions`, versioned and hashed as CRM Desk's are (migration 0058, append-only). Declined, Waitlist and Targeted are in the definition but are not sent until CRM Desk carries them.

## 88. What the CRM holds about an event's people is a sweep from state, not a call at each change (2026-11-15)

A guest's status moves in a dozen places, so `syncCrm` (`src/server/crm-sync.ts`) runs before each outbox drain, derives each member's status (one member is one address per event; the highest of guest status, sequence, reply, held meeting), and queues a row when it differs from `crm_sync`. The key carries a sequence (`cm:<event>:<email>:<status>:<n>`), so a check-in undone is sent. Waitlist, Declined and Listed are counted and not sent until CRM Desk carries them (part 3). `no_show` is mapped and an unknown status throws; nothing is sent under another meaning. A member row waits, without an attempt, while its event's campaign is not in the CRM, and an alert rises after 24 hours. `/motion/checklist`, `/campaign` and `/release` stay closed under `account_desk` for sequences drafted earlier: they start sending.

## 89. Activities come from state too, and a meeting this desk wrote is not booked again when the CRM sends it back (2026-11-15)

Meetings (create, then a status update that waits for the create), sends (from touches), matched replies (no body), and accepted debrief quotes (never the model's fact text; only when one person at that account held a meeting). The CRM's change feed returns every meeting, so `ingestCrmMeetings` skips any activity id that is the result of this desk's own write. A reschedule changes nothing in the CRM in part 2. Erasure now also clears a hosted guest's address, and the sweep skips an erased address.

## 90. Campaign money is built and off (2026-11-15)

`budget_cents` is the plan's lines; `actual_cost_cents` is tickets bought plus recorded cost lines, whole USD cents, no AI or travel estimate. It is written only when `CRM_CAMPAIGN_MONEY=usd`, which a person sets after CRM Desk hides the two fields from members (cross-repo item 7); the flag is checked in the sweep, the drain and the adapter, so a row queued while on is not sent after it is turned off. The shared world is read from a pinned copy of lumen-world's own events_desk slice (`samples/lumen-world`), verified against its manifest.

## 91. The demo runs on the shared world; where the world and the demo's own seed meet, the world wins (2026-11-15)

`WORLD=lumen` is the demo's default (`node.ts`); unset in a test keeps the demo's own events (`seed(db, { world })` reads `WORLD`, so no existing test changed). The demo's "today" is the world's `events_desk_today`, 2026-11-24, unless `DEMO_TODAY` is set; it restamps plan and seed dates only, the sweep and the views use the database clock, and every state the loader writes is explicit (the dinner is past, Money20/20 USA 2025 is scored). The loader (`src/server/seed-world.ts`) reads the vendored public files and nothing else (a test proves no `truth` path and no file read in it) and is keyed by the world's ids (`events.external_id`, migration 0060). What it does: the 11 conferences are the demo's own events (same names, dates, cities as `samples/real-events.json`), so they keep their rows and take the world's id; the 7 webinars and dinners are made as hosted events with their registrants as guests in the world's states; the Las Vegas dinner is a child of Money20/20 USA 2026, seats 24, with its 40 guests (attended, no show, waitlist, declined, none invited) and its cost line; Money20/20 USA 2025 is a delivered, scored event with no list, no price and no cost line (the world holds none, and none is invented); the sponsorship and the accepted talk are at SaaStr Annual 2027 through `saveSponsorship` and the talk rules (a second person approves the abstract); the four coming conferences get their targets as `prospect` contacts with priority A (likelihood high) or B. Clashes, so the next reader knows what changed under the world: (1) the demo's own "Customer dinner at Money20/20 USA 2026" (2026-10-19, 10 seats, `evt_m2020_usa_2026_dinner`) is not made under the world; the world's dinner (2026-10-20, 24 seats) takes its place; `tests/seed-plan.test.ts` still runs the old seed and still names it. (2) The world's attendance is loaded as contacts only for conferences with no list in the demo (none today: every conference already has a demo list or none to load into), and as guests for the 7 non-conference events; a demo list is kept over the world's rows for the same event, because replacing it would change the pipeline states the scenarios stand on. (3) Money20/20 USA 2026's assessment is kept; the world's facts do not answer its directory and download questions, so they are added as one `event_page` source and one answer marked "Sample". Not changed: the old seed's second Money20/20 Europe 2027 row (made by `seedSpeaking`) stays beside the catalog one; the loader tags the catalog one.

## 92. Targeted, waitlist and declined are members, written only when the CRM names them (2026-11-15)

The order, low to high: targeted 0, sent 10, responded 20, waitlist 30, declined 35, registered 40, no show 50, attended 60, met 70 (a decline is a person's answer, so it beats a send or a reply and never an attendance). A hosted guest `listed` with an address is targeted, `waitlist` and `declined` map to themselves. A contact is targeted when it is not enrolled, has no reply and no meeting, and its own `priority` is A or B or its company's `tier` is 1 or 2 (the spec's tiering, read from the columns; Market Desk's tier is still unanswered). Targeted is written only within 45 days before the event (`TARGET_LEAD_DAYS`) and not after it ends, at most 500 per event in priority order (the rest counted as `targeted_over_cap`), never for an address on the suppression list or in a country the email rule blocks (`targeted_barred`); waitlist and declined have no window. None of the three ever creates a lead, whatever `write_leads` says. They are sent only when `GET /definitions` `features.campaign_member_meanings` names them (`Crm.features()`, cached an hour, the last good answer kept, an unreadable answer releases nothing). A member whose top status is not released falls back to the highest one the CRM does carry, never lower than what was sent. A campaign is queued only for an event with a releasable member (or a submitted plan). Counts are in `GET /api/integration`.

## 93. A row the CRM cannot take yet is held, not failed (2026-11-15)

Outbox status `held` (migration 0060): a member row for one of the three that the CRM answers with `unknown_status`, or that its own list does not name, keeps its payload, counts no attempt and raises no failure. A change in the CRM's list releases every held row, and the sweep does so once a day. A held row is cancelled as `superseded` when a newer row exists for the member, and by erasure (both paths and the sweep cover `queued` and `held`). A refusal of any of the other six statuses stays a failure. The adapter returns the stored status; for these three a different one fails the row at once with "stored as <x>" (CRM Desk resolves by meaning, so this guards an older CRM).

## 94. The panel counts from its own table, reads Account Desk's plays on a separate route, and gives Account Desk one keyed read (2026-11-15)

`events.booking_url` (http or https, 500 characters, empty clears; the database refuses anything else) is a field a person sets, with Copy. The people by status come from `crm_sync`, so the panel never waits on a network call. The play status is `GET <ACCOUNT_DESK_URL>/api/desk/campaigns/<crm campaign>/plays` with `ACCOUNT_DESK_READ_KEY`, on `GET /api/events/:id/desk-plays` so the page never waits for it, cached a minute per event, written as one line per play in words with counts only; a failure keeps the last good lines and reads "Play status unavailable" with the time of the last good read. `GET /api/desk/campaigns/<crm campaign id>` answers `{event, starts_on, ends_on, city, booking_url}` for Account Desk behind `DESK_READ_KEY` (404 unset, 401 wrong), past the desk's own sign-in the way the capture routes are, and carries no person.

## 95. The rehearsal runs Events Desk itself, and what it will not write (2026-11-15, step 6 part 4)

The four-desk rehearsal does not replay a hand-written list of Events Desk's calls: `scripts/rehearse.ts` seeds the world, runs this desk's own sweep and outbox against the live CRM Desk, and `journalFetch` writes down every call that changed something (any method but GET, except the two reads made with POST), without the key. CRM Desk's demo replays those lines with a fifth key made for `events_desk`. Four rehearsal-only choices, each said in the run's output: (1) every event has `write_leads` on, as a person could set it; (2) guests who waited or declined are first written as leads by address, because the world's CRM leaves most of them out and this desk never makes a lead from a waitlist or a decline (13.9 item 5); (3) a queued activity dated after the CRM's own clock is cancelled with a reason and counted, because CRM Desk does not refuse such a row and its audit says nothing is dated after now; (4) an address that is not `.example` is cancelled before it reaches the CRM. The demo's own sends and meetings come from the demo pipeline, which a rehearsal does not run, so the script writes 30 invitation sends and three held meetings for Money20/20 USA as the desk's own rows and lets the sweep write them as it would any. Risk: none outward-facing; nothing is sent.

## 96. Target accounts are the existing list; this step reads it, adds no tier, and matches code-only (2026-11-15, step 7)

`target_accounts` (migration 0053) stays the team's list; `GET /api/target-accounts` and the Choosing page read it, the existing import route fills it. A speaker or sponsor page is matched by code (domain as a whole host, or the account's name as a contiguous token run starting with a capital), never by a model, so a miss is visible and a wrong match is a person's reject with a reason. Rejections hold for the candidate, not the page. Evidence from `past` and `captured` counts only people whose source is `attendee` or `onsite`; a `prospect` the desk itself chose never counts as proof an account will be there. Spec `docs/CHOOSING.md`, goldfish-reviewed by a fresh Opus agent before code (2 Blockers, 12 Majors, nits, all fixed in the spec).

## 97. Candidates are ranked by a printed rule, with no blended score (2026-11-15, step 7)

Candidates are catalog conferences starting 30 to 400 days out. Order: not declined and not below the median, then last edition below the median, then declined; inside a group the cost kind (plan, one pass, one pass estimated, unknown; never divided into each other), then target accounts per $1,000 by integer cross multiplication, then accounts, date and catalog id. LIFECYCLE 11's "no blended number" holds. Money is shown, so the whole Choosing read is leadership, GTM and planners only.

## 98. The goal tracker counts people, not meeting rows, and one held figure (2026-11-15, step 7)

Booked and rescheduled both count as booked; after the event only held counts, read from the Result so the Plan tab shows one held number (distinct people, the funnel's definition). Who goes comes from the `who_goes` view, so per-seat events are covered. "Target accounts met" now counts the team's target list when it has one (field `accounts_basis` says which); uploading a list therefore changes how existing results read, and the Result now says the basis in its words (`goalWords`) and the tracker in its caption. Without a list the tier 1 stand-in stays.

## 99. Which events to repeat: Account Desk's method, with these deviations (2026-11-15, step 7)

One-sided Fisher exact on "met its meetings goal", Bonferroni over the pairs looked at, "too few to say" under the floor. Deviations: a pair is looked at when both sides have at least 5 events (margins only, so outcomes cannot loosen the correction); a pass needs at least 3 goal-met events in the group (Account Desk's two-SDR rule has no event equivalent, since one planner requests most events); the floor for events is 5 a side, while LIFECYCLE 12's 20 stays for people groups. With two scored events in the demo, everything reads "too few to say", which is the honest state. A person records Repeat or Drop (a drop needs a reason, enforced by the database); leadership and GTM only.

## 100. A model words a passing pattern, code checks it, the demo uses the template (2026-11-15, step 7)

New step `repeat_word`: one call per passing pattern per reading, the row inserted before the call (unique, so never repeated, a failed call stays failed), accepted only if every number and name is in the pattern's facts, at most two sentences, no advice words. The simulated model is not a model and returns the code-written text; the row and the screen say "template". Not run against a real model in this step; nothing model-worded is invented in the demo.

## 101. The demo's today for these screens is the demo's day (2026-11-15, step 7)

The tracker, ranking and repeat reads use the deps clock, else `DEMO_TODAY` only when the demo server set it (`DEMO_TODAY_SET`, to the world's 2026-11-24), else the wall clock. Other desk views keep the database clock (decision 91). The world clock is not moved.

## 102. Sim mode runs the demo's lifecycle over a simulation database, only when both switches are set (2026-11-17)

**What.** With `SIM_DB_GUARD=1` and `SIM_MODE=1` both set, the server builds the simulated vendors and the demo's lifecycle (simulated sequencer and LinkedIn tools, simulated CRM) over the `DATABASE_URL` it was given, and runs the pipeline and the lifecycle tick. The sequencer, My day, replies, meetings, the scanner routes and the dinner reminder then exist on a simulation database such as Neon. It prints a startup line saying sim mode is on. It is off by default. With one switch or neither, nothing changes: a real database still refuses mock vendors and builds no lifecycle. `SIM_MODE=1` without `SIM_DB_GUARD=1` refuses to start, as does `SIM_MODE=1` with `LIVE_SPEND=1` or `LIVE_SEND=1`, with `TRANSACTIONAL_URL` or `TRANSACTIONAL_KEY` set (the reminder sender is a real mail service), or without a `DATABASE_URL`. `--demo` still wins over everything. Not covered: `CRM=crmdesk` is still honoured in sim mode, so the simulation writes to whatever `CRM_DESK_URL` names.

**Why.** The simulation week needs the after-delivery screens on Neon, and the old rule (a real database never gets mock vendors, so no lifecycle) left them out. The guard (`simguard.ts`) already limits which hosts and database names are allowed, so sim mode requires it rather than trusting the URL. A sim can never spend or send, so the refusals sit beside the two live switches.

**Who decided.** Bryan accepted the recommended defaults on 2026-11-17. Code: `src/server/modes.ts` (`resolveMode`, `mayRunPipeline`), `src/server/sim-mode.ts`, `src/server/node.ts`. Tests: `tests/sim-mode.test.ts`.

## 103. A manager can decide a seat in the app; Slack stays the main path (2026-11-17)

**What.** A Seat decisions screen (`/seat-decisions`, `GET /api/seat-decisions` and `POST /api/seat-decisions/:id`) lists the pending seat requests the person may decide, with the requester, event, ticket and travel cost, goal, expected meetings, decide-by date, budget headroom and the two answers, and has Approve and Decline (a reason is required). Only the event's approvers see it; anyone else gets 403, and nobody is offered their own request. The route calls `decideSeat`, the same function Slack's buttons call, so the rules, the activity line and the next steps (the event moves to approved, the kit offer, the pipeline kick) are the same. A request already decided returns 409 ("Already approved by ..."), never a second decision. When Slack is connected the screen says so, and either place works once; the Slack card is not edited when the decision is made here, and a later click on it answers "Already approved by ...". Plan decisions are not covered and stay in Slack.

**Why.** Decision 10 sends seat decisions through Slack, which leaves a desk without Slack unable to decide any seat. The acting person is still the self-asserted name behind the write key (README, "There is no real login"), so this is a fallback with the same trust as the rest of the desk, not a stronger one.

**Who decided.** Bryan accepted the recommended defaults on 2026-11-17. Code: `src/server/seat-routes.ts`, `src/app/SeatDecisions.tsx`. Tests: `tests/seat-decisions.test.ts`.

## 104. A plan is decided in the app when there is no Slack (2026-11-17)

**What.** `POST /api/events/:id/plan/decision` exists in the demo and on a desk with no Slack, as well as the Slack plan card. It runs the same `approvePlan` and `declinePlan`: the person must be one of the event's approvers and not the one who wrote the plan, and a decline needs a reason. With Slack connected the card is the one path and the route does not exist (tested). On a desk with no Slack the person is the self-declared name sent with the request, as with seats (decision 103): the approver list and the "not the maker" check are enforced on the server, the identity is not verified. A second decision is refused or does nothing (approve twice is a no-op, decline after approve is refused, decline twice is refused). `/api/health.decisions` says `panel` for the demo and for a desk with no Slack, `slack` with Slack. The Plan tab shows Approve the plan and Decline wherever the desk says `panel`; a plan or an abstract that waits for the person is listed under Needs me now.

**Why.** The standalone day found a plan stuck at "needs Slack connected" with nobody able to approve it, while seats already had a panel (decision 103). Bryan approved decision 3 of the simulation review on 2026-11-17: plan decisions without Slack get the same approval panel as seats.

**Who decided.** Bryan, 2026-11-17. Code: `src/server/plan-routes.ts`, `src/server/app.ts` (health), `src/app/Plan.tsx`. Tests: `tests/simfix.test.ts`; `tests/access-states.test.ts` changed (health says `panel` with no Slack, where it said `none`).

## 105. A planner closes plan against actual without the sending stage (2026-11-17)

**What.** `POST /api/events/:id/plan/close` is open to planners as well as leadership and GTM Engineering, and the Plan tab offers Close the result to a planner once the event is over, not yet closed, and its sending never started (motion `none`), the same rule the server applies; any configured planner may close any such event, not only the one who wrote the plan. `GET /api/results` lists an event whose result was closed this way, beside the events that reached closing or scored. An event whose sending has reached closing or scored still closes when it is scored, as before.

**Why.** Where another desk runs the outreach, this desk's own sending never starts, so Results stayed empty and nobody could close a result. Bryan approved decision 4 of the simulation review on 2026-11-17.

**Who decided.** Bryan, 2026-11-17. Code: `src/server/plan-routes.ts`, `src/server/lifecycle-routes.ts`, `src/app/Plan.tsx`. Tests: `tests/simfix.test.ts`.

## 106. First paint: the shell first, pages on their own, one read for open cases (2026-11-17)

**What.** The page ships with a grey shell in `index.html`; the app draws its sidebar and bar before it knows whether it is the demo; every page is its own file, fetched when opened; the open cases of every event come from `GET /api/cases/open` (one query) instead of one read per delivered event; the scripts and styles go out compressed and with a one-year immutable cache header (their names carry a hash); a hashed file that is missing answers 404 and never the page; `/`, `/index.html` and every deep link are compressed and sent `no-cache`; a page file that fails to load after a deploy reloads the tab once (`src/app/ChunkGuard.tsx`) and then shows a sentence and a Reload button (`src/server/static.ts`); a page change settles in 120 ms; every wait draws a skeleton (`src/app/Skeleton.tsx`) instead of a blank screen or the word Loading. Empty places say what goes there and show an example marked as one.

**Why.** The standalone day measured blank screens of 3 to 18 seconds. Measured here: the app was one 522 kB script (138 kB compressed) that arrived uncompressed with no cache header, the page drew nothing until `/api/health` answered, and the shell then waited for about 15 reads, one per delivered event. On a free instance, each of those waits stacked. The cause on the live demo is not proven: nothing was timed there (the sandbox cannot reach it).

**Who decided.** The simulation review ranked it first. Code: `index.html`, `src/app/App.tsx`, `src/app/Skeleton.tsx`, `src/app/waiting.ts`, `src/server/node.ts`, `src/server/app.ts`. Tests: `tests/simfix.test.ts`.

## 107. The sample says what it is; third-party tools are named by their job (2026-11-17)

**What.** A slim bar at the top of every screen of the demo says: a sample company with invented data; that a change is shared with the next visitor and gone when the demo restarts, and (public demo) that it takes no files, in the words its server refuses with; and the day the sample was set around (`/api/health.sample_day`), while days to go are counted from today. A file upload says so in a tooltip before the click. The Overview opens with one sentence of what the desk is for, one first step (a finished event) and a tour of four steps for someone judging the build and four for someone who runs events; the buyer's list ends with a next step, a mail link to Bryan (`CONTACT_URL` in `src/app/start.tsx`, decision 111). In the sample, Apollo, Instantly, HeyReach, Smartlead, ZeroBounce, Gong and Slack read as "people finder (sample)", "email tool (sample)" and so on; a real desk keeps the vendor's name. A person's page is called a page, not a record. "Request a seat" is a quiet button. Contrast: `scripts/contrast.mjs` measures every text colour (4.5:1, and 7:1 under 13 px), and the suite runs it.

**Why.** The first-visit review found no demo notice on the screen, an unexplained frozen-looking date, names of tools the visitor cannot see, and a loudest button that sent a stranger to a form. Statements about the demo are true of this desk: the public demo accepts changes (they live in the running copy) and refuses files, unlike the other desks, which refuse writes.

**Who decided.** Bryan's brief of 2026-11-17. Code: `src/app/DemoBar.tsx`, `src/app/start.tsx`, `src/app/tools.ts`, `src/app/Glossary.tsx`. Tests: `tests/simfix.test.ts`.

## 108. The last target account import stays on the desk (2026-11-17)

**What.** Migration 0062 keeps the last import of target accounts (who, rows, added, updated, the rows left out and why). `GET /api/target-accounts` returns it as `last_import` and Choosing shows it to whoever opens the page, instead of only to the person who uploaded in that visit.

**Why.** The standalone review found the result visible only in the uploader's session.

**Who decided.** The S5 review's small safe fixes. Code: `src/server/guest-import.ts`, `src/server/choosing-routes.ts`, `src/app/Choosing.tsx`. Tests: `tests/simfix.test.ts`.

## 109. The demo as a static snapshot on Cloudflare Pages (2026-11-17)

**What.** `make snapshot` (`scripts/build-static-snapshot.ts`) opens the sample the Render demo opens (`samples/demo-snapshot.tgz`, unpacked into a temporary folder) in its own process, with `PUBLIC_DEMO=1`, and reads every page's data the way the screens do, as each person in Acting as and as a visitor who has not chosen yet. The answers, the workbooks, scan CSVs and upload files the pages link to, and the built app go into `.snapshot/`, with a fetch shim (`scripts/static-snapshot/shim.js`) that answers `/api` from the saved files and refuses every change with "This public demo does not take changes. To try them, run the desk yourself: the README shows how." The demo bar says it is a snapshot and cannot be hidden; no other desk is linked; the bundle carries a noindex meta, an `X-Robots-Tag` header and a `robots.txt` that disallows everything. A GitHub Actions workflow builds it and publishes to the Pages project `events-desk-demo` only when both Cloudflare secrets exist. It is staged: no README link, no address anywhere. Superseded in part, 2026-11-27: the Render demo was suspended on 2026-11-18, the README links the snapshot (96d39c0), and both Cloudflare secrets are set, so the workflow publishes on a push to `main`.

**Why.** The Render demo sleeps, takes a minute to wake, and accepts changes a stranger can leave for the next visitor. A static copy costs nothing, answers at once and cannot be changed. The same pattern as the CRM, Market and Account Desk snapshots.

**What it gives up.** A typed search, a combined filter and pages past the first two of a single filter in a list; every write; the scanner phone app; uploads, Slack, the directory and recordings; the clock moves. `docs/RUNBOOK.md` lists them. The scanner's read is the one read that touches the database (it retries badge scans waiting for a person), on the temporary copy, and the build stops if anything else changes.

**Who decided.** Bryan's task of 2026-11-17 (hosting, bl_116). Code: `scripts/build-static-snapshot.ts`, `scripts/static-snapshot/shim.js`, `src/app/DemoBar.tsx`, `.github/workflows/static-snapshot.yml`. Tests: `tests/static-snapshot.test.ts`.

**Revised 2026-11-26 (demo pass, bl_135).** The snapshot's note no longer says the day it was taken; the snapshot has one date, the day its sample was set around ("Today in the sample is Tue, 24 Nov 2026."), and the snapshot's day counts (days to go, "Was due", the Today marks, meeting days, upcoming lists) run from that day (`setSampleToday` and `nowMs` in `src/app/words.ts`, set from `/api/health`; the "N days ago" notes and reply deadlines in the sheets still read the real clock), since a frozen copy cannot move its clock and would otherwise read differently every day. On a wide screen the note still stays. On a phone (760 px or less) it takes the first screen, so it has a Hide button for the session. `tests/static-snapshot.test.ts` locks the new words.

## 110. The Overview week block says "This week" once (2026-11-17)

**What.** When every open deadline falls in the "This week" group, the group label (a tray header in layout B, a ledger label in layout A) is not drawn, because it repeats the section heading and its count. In layout B the two columns collapse to one full-width column whenever one side is empty, so a lone tray no longer sits in the right half of the row. Layout C and the year blocks are unchanged.

**Why.** The public demo showed "This week 3" as the heading at the left and the same words again on a card pushed to the right half of the row.

**Who decided.** Bryan's screenshot of the demo Overview, 2026-11-17. Code: `src/app/Overview.tsx`, `src/app/styles.css`. Tests: `tests/overview-week-heading.test.ts`.

## 111. The demo's next step is a mail link to Bryan (2026-11-17)

**What.** The last line of the buyer's tour on the demo Overview is "Next step: Write to Bryan about your own data". The words after "Next step:" are a plain `mailto:bryan@leandrive.io?subject=Events%20Desk%20demo` link (`CONTACT_URL` in `src/app/start.tsx`). A mailto link opens the visitor's mail app, so it has no `target` and no `rel`. The old line (run it yourself or ask whoever sent the link) is gone from `docs/SCREEN-COPY.txt`.

**Why.** Decision 107 left the address unset because none existed. Bryan chose one.

**Who decided.** Bryan, 2026-11-17. Code: `src/app/start.tsx`. Tests: `tests/simfix.test.ts` pins the exact address and subject, the link text and that mailto has no target or rel (it replaces the check that the line invented no address and that the only link was the first step).

## 112. The target account import reads an export's usual headers (2026-11-18)

**What.** `POST /api/target-accounts/import` (the Choosing upload) reads the same columns under the headers a CRM or spreadsheet export uses: `Account name`, `Account`, `Company` or `Company name` for the name; `Website`, `URL` or `Company domain` for the domain; `Account owner` or `Owner name` for the owner; `Country code`, `Deal` and `Stage` for the rest. Only these exact names (case and spaces ignored); a file with none of them is still refused with "The file needs a name column." When a file has both the desk's own header and an export header for the same column, the desk's own header is read; the export header fills only the cells it leaves empty.

**Why.** In the integrated week (2026-11-18, `workday-sim-plan/runs/s8-week2`) the target account file the field marketer's manager left, headed "Account name, Website, Country, Account owner, Open deal", was refused for having no name column, so the whole list never reached the desk (S5's done-check also counted 0). A planner cannot rename columns from the browser.

**Who decided.** Integrated week 2 (small fix, no product change: the same table and route). Code: `src/server/guest-import.ts`. Tests: `tests/guest-import.test.ts` ("reads an export's usual headers").

## 113. Closing a result asks first (2026-11-18)

**What.** "Close the result" on the Plan page opens a dialog before anything is sent. It states the goal against the result in one sentence ("Against the goal, the result is 3 of 5 meetings held, 1 of 2 target accounts met, and it cannot be reopened.") and closes only on "Close the result"; "Not yet" leaves the plan as it was. An event with no goal reads "No goal was set, so the result closes with nothing to compare it to, and it cannot be reopened." The same pass makes a closed result read "Scored" in Results, as the Plan tab does.

**Why.** In the integrated week (2026-11-18) a planner's click closed the result at once, and nothing in the server reopens it (`closeResult`, decision 105).

**Who decided.** Integrated week 2 (small fix). Code: `src/app/Plan.tsx`, `src/server/lifecycle-routes.ts`. Tests: `tests/simfix.test.ts` (integrated week 2).

## 114. Nobody is checked in before the event's first day (2026-11-18)

**What.** `checkIn` and `walkIn` (`src/server/hosted.ts`) refuse before the event's first day in the event's own time zone: "Check-in opens on 19 Nov, the first day of the event." The seed's roadshow stop is dated its demo day before its check-ins are made (`seed-hosted.ts`), so a snapshot built on any day shows no guest attended early.

**Why.** CRM Desk reads an attended guest as a person who came. In the integrated week (2026-11-18) the seed's check-ins sat before the event's day and CRM showed Capitol Revenue Roadshow as "Attended" before 19 Nov. Importing a list that already carries check-in times (`guest-import.ts`) is not a check-in at the door and is unchanged.

**Who decided.** Integrated week 2 (finding J14, default of review-crm). Tests: `tests/hosted-checkin.test.ts`, `tests/hosted-seed.test.ts`.

## 115. One page for what waits on a person, and a seat approval that asks first (2026-11-18)

**What.** `GET /api/waiting` answers, for the person acting, the seat requests they can decide, the plans asked for and not yet approved (not their own), and the abstracts another person wrote (planners). The screen "Waiting on you" (`/waiting`, also `/seat-decisions`) lists them in three sections, each row linking to its item (a seat to `/seat-decisions?request=<id>`, a plan or abstract to the event's Plan tab), with a count in the menu. "Decide here" on Seats links to the one request. Approving a seat opens a dialog that states the ticket, travel and what is left in the quarter, with an optional note; the note is kept in the event's activity beside the line "Approved X's seat" and never in the decline reason. "Approve the plan" asks first when it also takes in waiting seats, and says how many. My day lists a hosted event's guests eight at a time. A dialog gives focus back to the button that opened it.

**Why.** Every "Decide here" went to one unfiltered page, an approver had no list across events, one click approved a seat, and approving a plan also approved seats without saying so (integrated week 2, J10, m13, m14, m20).

**Not done.** A plan that went over its approved budget and waits for a second approval is not in the list (it shows on its own Plan tab). Slack stays the main path where it is connected.

**Who decided.** Integrated week 2 (default of review-market-events: one "Waiting on you" page). Code: `src/server/seat-routes.ts`, `src/server/seats.ts`, `src/app/SeatDecisions.tsx`, `src/app/Seats.tsx`. Tests: `tests/wk2fix.test.ts`.

## 116. Small behaviours from the integrated week (2026-11-18)

**What.** (1) A reminder is signed by the person sending it, and the refusal when no email sender is connected says so in plain words, with no setting names (they stay in the README and `.env.example`). (2) A walk-in's owner is the person adding them, not the host. (3) The organizer request's follow-up date can be set by hand ("Follow up on"); left alone it is still the day after the expected date, or a week after it was sent; a date before the day it was sent is refused. (4) The excluded-from-outreach reasons on the List tab open the people set aside for that reason (`GET /api/events/:id/people?status=dropped&reason=...`); a scan the near-match review merged reads "Merged with another scan". (5) A badge code can be typed in the scanner. (6) A seat in the demo and the seed belongs to Maya Okafor, the name the team file and every other desk use (was Maya Ortiz). (7) A row for Replies or Meetings under Account Desk's outreach says nothing has come back instead of doing nothing. (8) The deliverable owner offers the team's names, and rows keep their place while a due date is saved. (9) A follow-up date set by hand is kept by any later save that does not touch it (a stored date that differs from what the stored dates compute counts as set by hand), unless the save moves the sent day past it, when it is computed again. (10) The people list says where each person stands in CRM Desk, from their latest campaign-member row in the outbox (in the CRM, waiting to send, not ready, not sent). (11) The deliverable editor sets one owner and one due day on every open deliverable at once. A database seeded before the Maya Okafor change keeps Maya Ortiz: reseed it. Tests: `tests/wk2fix.test.ts`, `tests/hosted-reminders.test.ts`.

**Not done.** The roster is still the four people of `src/shared/roles.ts`, not the shared team file (J15): the personas decide who may approve seats and plans, see money and open Settings, so changing them changes who may approve or spend.

**Who decided.** Integrated week 2 (findings J11 to J13, J15, m11 to m18, m21; small defaults of the reviews).

## 117. A delivered list has its campaign in the CRM whenever the CRM is connected (2026-11-18)

**What.** The CRM sweep (`syncCrm`, `src/server/crm-sync.ts`) queues the campaign of every event whose list is delivered (kept people with an address), not only of events with a member to write or a submitted plan. People are still written as `targeted` only from 45 days before the event until it ends (`TARGET_LEAD_DAYS`, decision of `docs/SHARED-WORLD.md` 13.9 item 11) and only where the CRM already holds the person (or the uploader turned leads on); they follow in the same campaign when the window opens. The campaign key is `campaign:<event id>`, so no second campaign is made for one event. Duplicate campaigns in CRM Desk (Planned with no owner beside Completed under Dan Whitlock) most likely come from two events that share a name and first day (the demo seed and the shared world each make Money20/20 Europe 2027, `oneRowEach` hides one on screen), each with its own key; not fixed, because the second event's members would then wait for a campaign that is never made.

**Why.** Investigated for finding J16 ("People in the CRM 0", no Qatar campaign): a list delivered before the CRM was connected, or for an event more than 45 days away, left no campaign in the CRM, because the campaign was queued only at delivery (when the CRM could write) or by a member or plan. Members outside the window are deferred by design, not dropped.

**Who decided.** Integrated week 2 (question 10: investigate first). Code: `src/server/crm-sync.ts`. Tests: `tests/member-statuses.test.ts` ("a delivered list reaches the CRM whenever the CRM is connected").
