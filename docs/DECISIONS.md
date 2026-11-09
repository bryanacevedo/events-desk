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

