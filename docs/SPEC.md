# Events Desk: product spec

## The job

A company sponsors or attends a conference. Someone gets a messy attendee list a few days before the doors open. Reps need to know who is worth meeting and how to reach them, and the company should not pay to enrich people it will never contact.

Events Desk takes an event from seat request to a delivered list. **AI goes in the input and the decision, never in the delivered list. Everything else is running code. A human approves every paid step.**

The test for every screen: **a marketing lead opens an event cold and in 10 seconds knows where it stands, what it has cost, what is waiting on whom, and why anything was dropped.**

**Stack:** TypeScript, Postgres, Slack, MCP SDK. The skeleton is copied from `~/Developer/gtm-backlog` (public at github.com/bryanacevedo/gtm-backlog), the first portfolio build.

## Who uses it

- **Requester** (a field marketer): asks for seats and budget, uploads the list.
- **Approver** (the budget owner): a configured list of people. Approves or declines seat requests. Cannot approve their own request. Does not confirm cost cards.
- **Uploader** (usually the SDR or field marketer who uploaded the current list): the one person who confirms or declines that list's cost cards (Research and Outreach, or the single card). See "Who confirms what".
- **Rep** (an SDR or AE): reads the workbook, marks review decisions, asks the Q&A agent about the list.

v1 has no accounts. See "Modes" for how identity works with and without Slack.

## Words used here

- **Source row:** one line of the uploaded CSV.
- **Company-only row:** a source row with a company and no person.
- **Contact:** one person we may reach. A source row with a person makes one contact. A company-only row makes zero or more, through discovery.
- **Discovery:** a vendor lookup that finds people at a company whose titles match the target titles.
- **Attendee:** a person from the uploaded list.
- **Prospect:** a person found at a buyer title at an attending company who was not on the list. Optional per event, chosen before the cost card.
- **Dropped:** a source row or contact that stops, always with one reason.

Counts by priority and by drop reason are counted on contacts, except `duplicate`, `no_company`, `excluded_company`, `existing_customer` and `low_tier` on company-only rows, which are counted on source rows and labeled so.

## One event, ten stages (thirteen in the two-card flow)

An event has a `flow`: `two_card` (the design in `docs/TIERING-AND-ENRICHMENT.md`, the default for new events since migration 0015; see "The two-card flow" below) or `single_card` (the older one-card flow, kept for events already running it and for tests of it; the screens that know only the single card still work with it). Both share the first four stages and the last three.

| Stage | What happens | Leaves when |
|---|---|---|
| requested | Seat count, seat price and event details are in | Approver approves or declines |
| approved | Seats approved; waiting for a list | A CSV maps successfully |
| mapped | Columns mapped in code, rows normalized and deduplicated, settings editable | Someone requests the card |
| quoted | Cost card waits for a human | Approve moves on; decline returns to `mapped` to lower settings and re-quote |
| tiering | Companies and titles get tiers, A/B/C is computed, C stops here | Every source row is tiered or dropped |
| enriching | Discovery, then the waterfall and double verification, on A and B only | Every contact is finished or dropped |
| flagging | LLM flags doubtful contacts for a person to review | Every contact is flagged or skipped |
| delivered | Workbook is built by code | Terminal; review decisions can still be imported |
| declined | A human ended the event, with a reason | Terminal; reachable from `requested`, `approved`, `mapped`, `quoted` |
| paused | A vendor keeps failing; a person must resume | Someone resumes it, back to the stage it paused from |
| researching | Two-card only. Research card approved: company tiering runs under it | Every company is tiered, settled by a person, or dropped; then ready for review |
| ready_for_review | Two-card only. Review cases are settled or skipped; settled companies finish their research | The Outreach card is asked for (only with no blocking case open) and approved |
| finding_people | Two-card only. Outreach card approved: title tiers, then priorities, discovery, finders, verifiers, LinkedIn | Every contact is finished or dropped; then flagging |

The rules live once in `src/shared/domain.ts`. The server checks them on every write. Postgres enforces, as CHECK constraints, only: a declined event has a reason, a dropped source row or contact has a reason on the same row, and a ledger entry's amount is not negative. Stage transitions are not checked in SQL.

## Paid steps

A seat is approved by an approver, and each cost card is confirmed by the person who uploaded the list. Nothing paid runs inside an event without a confirmed card.

1. **Seat approval.** The seat budget is seat count times seat price.
2. **Cost card approval.** It covers every vendor credit and every LLM call for this event, including the Q&A agent's allowance.

Approve is one click. Decline is a click plus a required reason, in a Slack modal. A second click on a decided approval changes nothing and says who decided first.

"What it has cost" on screen is seat budget plus credits spent plus LLM cost, each shown separately.

### The two-card flow

For `two_card` events the single cost card is replaced by two approvals, each with its own formula and its own per-step caps (`cost_cards.kind` is `research` or `outreach`; `step_caps` maps a step to its cap in credits or LLM calls). `POST /api/events/:id/quote` asks for whichever card is next. The owner's defaults are built in: two cards, and a catch-all domain is reported as a gap (`catch_all_unconfirmed`) instead of being hidden in `email_unconfirmed`.

- **Research card** (`requestResearchCard`). Free work runs first, inside the request: exact-name matches against the exclusion and customer lists (a company that matches is dropped with `excluded_company` or `existing_customer` and not priced), and the free title pass (the keyword table decides what it can; Title 3 is C whatever the company, so those people drop as `low_tier`, and a company whose only people were Title 3 stops unless prospects are on). Declining the card puts all of that back. Free identity runs here too (see "Identity"), so the card prices a person match only for companies the file's own evidence did not settle and that have a named person. Formula, worst case: `max_companies = companies + reverse_lookup_rows` (a reverse lookup can attach a person to a company the file never named, so that company is priced too), `person_match_credits = person_match_companies x person_match_cost`, `reverse_lookup_credits = person rows with no company x reverse_lookup_cost`, `firmographics_credits = max_companies x firmographics_cost` (at most one paid enrich per company; the cache and the free search cost nothing), `tier_llm = max_companies x 4` (two passes, one invalid-answer retry each), `website_read_llm = max_companies x 1`, and a re-tier allowance of `retier_companies = ceil(max_companies x retier_share)` companies, each of which can use the same 4 + 1 calls: `retier_llm`, `retier_website_read_llm`. The second look that used to add a sixth call was cut (decision 24). A re-tier reads the firmographics already stored, so it buys no credits. `llm_calls_per_company` (5) is shown on the card. The step caps are the sums: `company_tier = tier_llm + retier_llm`, and `website_read` likewise. A test drives every company down the longest path (unreadable twice, website read, unreadable once then a tier) and it uses exactly 4 + 1 per company and stays inside every cap. The list quality report from Layer 0 is stored on the card (`inputs.quality`) and returned in `list.quality`. Steps: `person_match`, `reverse_lookup`, `firmographics`, `company_tier`, `website_read`.
- **Outreach card** (`requestOutreachCard`), quoted only from `ready_for_review`, only when no blocking review case is open and no job is left, so a late answer can never exceed it. `max_people = attendees at A or B + companies searched x quota` (quota 5 for tier 1, 3 for tier 2, prospects only; a title with no rule yet counts at its best case). Per person: every finder once, both verifiers on `candidates_per_person` (3) candidates plus `verifier_retries` (1) retries, one LinkedIn lookup. Plus one catch-all probe per domain, title parsing (2 calls per title with no rule), a model flag per person (2 calls), the Summary's perspective (one call and one retry, none on a top-up), and the Concierge allowance. `lines.estimate` is a labeled estimate from configured hit rates, not a cap. A declined Outreach card returns to `ready_for_review`; research stays paid for. Steps: `title_tier`, `title_parse`, `discovery`, `reveal`, `find`, `waterfall`, `verify`, `catch_all_probe`, `linkedin`, `review`, `perspective`, `concierge`.
- **Money rules, real today.** `reserve(db, event, unit, amount, note, step)` finds the approved card that lists `step` in `step_caps`, holds the card's total cap and the step's own cap, and refuses otherwise. A step no approved card names is refused, so nothing is paid before the right card is approved. A single-card event has one card and no step caps, as before.
- **Review cases** (`src/server/cases.ts`, table `review_cases`). Blocking kinds hold spend: `ambiguous_identity`, `company_not_found`, `unknown_tier`, `second_look_disagreement`, `fuzzy_list_match`, `crm_customer_mismatch`, `subsidiary_inheritance`; `second_look_disagreement` is no longer opened, and old ones still resolve. Later kinds need a person but block nothing: `attendee_vendor_mismatch`, `name_email_mismatch`, `free_webmail`, `same_person_two_companies`, `late_stage_deal`, `model_flag`. One apply function per kind; a second answer changes nothing; a blocking case cannot be answered once spending has started. Skipping what remains drops those companies (`company_not_found`, `tiering_failed` or `rejected_in_review` by kind) and spends nothing on them. Producers today: `fuzzy_list_match` (free, at the end of research), and from stage 4 `ambiguous_identity`, `company_not_found`, `subsidiary_inheritance` and `crm_customer_mismatch`. `unknown_tier` is opened by company tiering (see "Gates, firmographics and company tier"); the later kinds are opened once, when the outreach list is delivered (`openLaterCases` in `src/server/later-cases.ts`, step 9): `name_email_mismatch` (a kept address whose local part does not fit the name; suggested Keep for the attendee's own address, Drop for one a vendor found), `attendee_vendor_mismatch` (an attendee's own or a vendor-found address sits at another company than the one the vendor puts them at), `free_webmail` (they registered with a personal address; we reached them at a work one), `same_person_two_companies`, `late_stage_deal` (a late-stage deal with an owner; options Keep and Dismiss, one case per company), and `model_flag` (a model's doubt, suggested by the same fixed rule as before). One open case per person and kind. `GET /api/events/:id/cases` returns each case with its `person` (`id`, `full_name`, `title`, `email`, `priority`, `source`, `dropped`), `company_id`, `contact_id` and `created_at`. An `unknown_tier` case suggests drop (no spend); an old `second_look_disagreement` case leaves the first tier in place and suggests the more careful of the two. A person's tier answer is stored with `tier_via = human` and written to the tier cache for that domain and ICP version. An ambiguous case carries one option per candidate (`pick:<domain>`) plus drop, and suggests the best-scoring candidate; a not-found case suggests drop and accepts `supply_domain` with a website. Routes: `GET /api/events/:id/cases`, `POST /api/events/:id/cases/:caseId` `{decision, data?}`, `POST /api/events/:id/cases/skip`.
- **Seams.** Every stage between the cards is built: identity, firmographics, ICP hard rules, company tier with Unknown, the baseline, the website read, the spread check and re-tier; people search, title parsing, persona tiers, ranking and quotas; the reveal, employment check, catch-all probe and verification loop; and the later case kinds. Not built: employment re-checks after delivery, a specialist catch-all verifier, and a second verification pass at delivery time (a result over 30 days old is never reused, which is the only guard). The cards price the full design, so the caps match what the finished steps may spend. An event with no pinned ICP keeps the older single-prompt company tier (see "Gates, firmographics and company tier").

### Who confirms what

Seats and cost cards are different kinds of gate (decided 2026-11-08, `docs/DECISIONS.md` 10).

- **Seat requests** are a spending decision for leadership: only people on the event's approver list decide them, and nobody decides their own request. Unchanged.
- **Cost cards** (the single card, and both the Research card and the Outreach card) are a human check that the person who uploaded the list means to run the paid steps. Only the uploader of the **current** list confirms or declines a card (`currentUploader`: the latest upload on the event). Approvers who did not upload are refused, and the requester can confirm if they uploaded. There is no rule that the requester or uploader cannot confirm.
- **A new upload moves the confirmation.** While nothing is paid for (stage `mapped` or `quoted`), uploading a list again replaces the old one (its rows are removed), makes the uploader of the new list the confirmer, and voids any pending card: its approval is declined with the reason "Replaced: X uploaded a new list" and its card is marked declined. As a second guard, a card quoted before the latest upload cannot be confirmed even if its row survived. Nothing is stuck on someone who is away. After paid work starts the list cannot be replaced.
- **Live mode needs real proof of who is acting**, because the actor header is not proof. `SLACK_USER_MAP` (JSON, person name to Slack user ID) is required for `LIVE_SPEND=1` and must be valid. A cost card is posted to the approvals channel (not as a direct message) with an @mention of the uploader's mapped Slack user, and the signed Slack click is accepted only from that user (`actorFor`); the click then counts as the uploader by name. If the uploader has no mapping, the card is refused before it is made (`POST /api/events/:id/quote` returns 409 with the reason) and a click on an existing card is refused with the same reason. `APPROVER_SLACK_IDS` now covers seat requests only. The same map stops a requester approving their own seat: the requester is a name and the Slack decider an ID, so both are put on the Slack ID before they are compared (`decideSeat`). A card Slack will not post is written to the event's activity.
- **Every money protection is unchanged:** a human confirms before any paid step, the ledger reserves under a row lock, per-step caps hold, a paid call whose outcome is unknown is never repeated, and a run with stale totals is refused (the Outreach card is quoted only with no open case and no job running).

### The cost card

Generated by code from the mapped data, before any paid call, using a snapshot of the rates stored with the card. It is always the **worst case**: nothing is dropped and every vendor is tried.

```
contacts          = person_rows + looked_up_companies × contacts_per_company
discovery_credits = looked_up_companies × contacts_per_company × discovery_cost   (looked_up_companies = company_only_rows, plus companies_with_people when prospects are on)
finder_credits    = contacts_without_an_email × apollo_match_cost
verifier_credits  = contacts × zerobounce_cost
pipeline_llm      = 2 × (unique_companies + titles_with_no_rule + contacts)
agent_llm         = agent_question_limit × calls_per_question
```

`pipeline_llm` is doubled because each LLM item may retry once on an invalid response. The card shows each vendor's own credits (Apollo and ZeroBounce) and AI model calls in dollars. Vendor credits carry no dollar value and are never blended with AI dollars; `est_cents` on a card is AI dollars only. Each vendor draws from a pre-allocated pool (`pools` in config/defaults.json, overridable in `vendor_pools`; a null allotment is unknown and only use is shown). Step and ledger names map to vendors in `src/shared/vendors.ts`. Usage shows each vendor against its pool, AI on its own, and a by-event table with a column per vendor and AI in dollars.

### The cap

The card sets **two caps: credits and LLM calls.** Dollars are display only.

Each paid call follows three steps, because a transaction cannot wrap an external call:

1. **Reserve** in one transaction, holding `FOR UPDATE` on the event's card so two workers cannot overspend. A reservation over the cap is refused.
2. **Call** the vendor or model, with the reservation id as idempotency key where the vendor supports one.
3. **Settle** in one transaction: record the real charge and release any difference.

What a refusal does depends on the step:

| Refused call | Result |
|---|---|
| Company tiering | Every contact at that company is dropped as `budget_cap` |
| Title tiering | unique title, on the frozen holdout | Tier accuracy at least 90% with Unknown counted wrong, Unknown at most 15%, no tier 3 given tier 1, and it must beat the keyword baseline. Scored as the rules in code first, then the model for the titles they cannot place |
| Discovery, finder, verifier | That contact is dropped as `budget_cap` |
| Review flagging | The contact stays and code adds `not_reviewed`. Nobody already paid for is dropped by a review call |
| Q&A agent | The agent says the allowance is used up |

The event continues after a refusal. Because the card is a true worst case, a refusal only happens if a vendor charges more than its configured rate, so the cap is a backstop. A test covers a vendor priced above the card, which is refused before the call, and a vendor that bills above its quote, whose excess is counted so spending stops after that call. Dollars are only as accurate as the configured rates.

## How the work runs

Paid stages run as rows in a `jobs` table, claimed with `FOR UPDATE SKIP LOCKED` by a worker loop in the Node process. One job is one paid item.

- **A paid call never runs twice with an unknown outcome.** If a worker dies between reserve and settle, the job's lease expires, the reservation is settled as spent, and that vendor counts as a miss.
- **Vendor errors:** retried only when the vendor reports no charge, up to 2 times. Otherwise the next vendor runs.
- **5 consecutive errors from one vendor pauses the event.** A person resumes it.
- **Invalid LLM response:** 1 retry, then the item fails: `tiering_failed` for tiering, `not_reviewed` for review.

The pipeline runs only in Node.

## Settings

Defaults live in `config/*.json`: ICP text, exclusion list, existing-customer list, target titles and title keyword table, `contacts_per_company`, finder order, vendor rates, approver list, `agent_question_limit`, `calls_per_question`. The two-card flow adds `research` (rates and the re-tier share), `outreach` (quotas, candidates per person, probe cost, retries), `estimate` (hit rates for the labeled estimate only) and `limits` (the design's starting values: tier 1 share warning, small list, freshness, cache ages). Each event gets its own copy at creation, shown on the event page and editable until a card is requested. Declining a card reopens them. That is how a person lowers the worst case and re-quotes.

## Any messy CSV

- Columns are mapped **in code**, from a synonym table plus value-shape checks (an `@` means email, a LinkedIn URL means profile). No LLM touches mapping, so nothing paid runs before the card.
- **CSV or Excel.** `POST /api/events/:id/upload` takes the raw bytes and decides the type from the file signature, not the name: a zip signature is read as `.xlsx` (ExcelJS), an old OLE signature (`.xls`) is refused with "save it as .xlsx or CSV", other binary is refused, anything else is CSV. From a workbook the sheet with the most non-empty rows is used (a tie goes to the first). Rich text, hyperlinks, dates and formula results become plain text; a formula is never evaluated, only its stored result is read. The result is the same `Parsed` shape as a CSV, so a title row above the header, mapping and normalizing behave identically. Limits: 20 MB, 50,000 rows after the header, 200,000 sheet rows and 500 columns read. Nothing is stored unless the whole file read and mapped.
- A mapping the code cannot resolve stays at `approved` and shows which column is missing. A file needs a company, an email or a LinkedIn column. The website and badge-name columns are read by Layer 0 but stay in `ignored`.
- Normalization strips legal suffixes and casing so "ACME, Inc." and "Acme" are one company.
- **People are deduplicated** by lowercased email, LinkedIn URL, or normalized name (word order ignored) plus company when there is no email. The later row is dropped as `duplicate`. One email on different people is the exception: see Layer 0.
- **A row that already has an email** skips Apollo's match and goes straight to ZeroBounce.
- **Layer 0 distrusts the input** before anything else; see the next section.

## Layer 0: distrust the input

Code only, in `src/shared/layer0.ts` and `normalize()` in `src/shared/ingest.ts`, so it runs at upload before any approval. Every value is a claim. Each check acts only when certain; a doubtful value is left for Research. Applies to both flows.

| Mess | Rule | Result |
|---|---|---|
| Website blank or filler, placeholder domain | `cleanWebsite` | Ignored; a clean website is kept as evidence |
| Placeholder email domain (test.com, company.com, none.com, asdf.com and more) | Configured list | Email discarded, the row continues on name and company |
| One email domain on unrelated companies | Names grouped as one company when they are a prefix, a typo or a legal-suffix variant of each other; the domain is shared when three groups do not resemble it, or two do and none does | Domain not offered as evidence for any company; addresses kept |
| One email on different people | Same address with names that are not the same person (typos and word order tolerated) | Email discarded for all; each person continues. No longer dropped as `duplicate` |
| Fake mailbox on a real domain | Never trusted | Flagged `fake_local_part` only; the email loop verifies it |
| Keyboard mash, filler | Letter runs and keyboard-row runs of 3 or more letters, only when every word is mash; N/A, dashes, none | Field blanked. Short all-capital names (KPMG, HSBC, DHL, AAA) are never junk. "Na" and "No" are never filler in a name |
| Wrong column | Company that reads wholly as a job title with a title that does not: moved; email or LinkedIn in the company column: moved; first and last name swapped: moved only when the badge-name column proves it, otherwise flagged `name_order_suspect` | Moved when certain, else left and flagged |
| Person's own name as company | Same words in either order | No company |
| Student, press, self-employed | Configured names, or an institution or newsroom word with a student, journalist or freelance title, or such a title on a personal address | Dropped as `not_a_company` |
| Free webmail, mistyped webmail domain | List and one edit from it | Kept, flagged, never used as company evidence |

A row needs any one of company, email or LinkedIn; otherwise it drops as `junk_row`. A person with an email or LinkedIn and no company continues as a contact with no company. Company evidence (email domains that pass, clean websites) is stored on `companies.identity_evidence` with `identity_state = unresolved`; nothing is confirmed yet.

**List quality report** (`QualityReport`): rows, usable rows, clean rows, drops by reason, rows per issue, shared emails and domains, sample row numbers per issue, a verdict (good, fair, poor) and plain sentences. Stored in `uploads.quality`, returned as `list.quality` on the event and as `inputs.quality` on the Research card. Measured against the simulated world in `tests/layer0-world.test.ts`, which enforces catch floors and zero false kills.

## The ICP

The ICP is a structured, versioned object, one per install (`src/shared/icp.ts`, `src/server/icp.ts`, tables `icp_documents`, `icp_compiles`, `icp_versions`; migration 0011). Parts: owner and last reviewed, a summary in words, the in-range size, where the seller sells, hard rules, fit dimensions, segments (each strong, partial or weak, with the words that match it), company types, tier definitions per segment, worked examples, counter-examples, personas (function, seniority range, priority), title adjustments by company type and size, the never-contact and customer lists, and the gaps a person accepted. Every rule-like item has a `quote`: the passage of the document it came from, or null when a person typed it.

- **Hard rules run in code** (`evalHardRules`): employees min or max, business model, country, industry. A rule fires only when the field is present; a missing value is Unknown, never a failure.
- **Tier definitions** per segment are tried in order. A definition may carry a machine condition (`when`: employees in or out of range, consumer-only); one without a condition is the fallback for its group. If a field a condition needs is missing the answer is Unknown, never a quiet fall through to a lower tier. `tierByRules` returns the tier and the fact it relied on. A **baseline** (size band plus strong keywords) is scored beside it.
- **Compile flow, six steps.** (1) Upload a `.txt` or `.md` file or paste text (`POST /api/icp/documents`); a Word or zip file is refused with a message. (2) A person sees the estimate (at most two model calls, tokens, cents at the configured price per call) and sends it back to start (`POST .../start {accepted_cents}`); a different number is refused. The call count is held at the estimate. (3) The draft lists its gaps (`findGaps`) and any item whose quoted passage is not in the document (`checkQuotes` removes the quote and asks a person to keep or remove the item). (4) A person answers each gap (fill it, or confirm it is fine), edits or removes rules, and confirms (`PATCH .../draft`, `POST .../confirm`); confirm refuses while anything is open. (5) The test bench: companies the team knows the answer to (CSV or JSON, with won, lost or bad_fit), tiered by the rules in code, the model only for a company the rules cannot place (at most 40 calls); accuracy against the baseline, and tier 3 called tier 1 counted separately. A wrong answer can be added as a worked example (the confirmation stands, the test must be run again). (6) Publish as the next version; the test must have run on exactly this draft and reach 80% unless the person says to publish anyway. Uploading a revised document shows a plain-words diff against the current version (`diffIcp`) and changes nothing until published; a draft whose base is no longer current cannot be published.
- **The document is data.** The prompt carries it between markers that the document cannot close (its own copies are broken), says it has no tools and no authority, and the model's answer goes through `sanitizeIcp`: closed lists, capped lengths, unknown keys dropped. Instruction-like sentences are found (`findInstructions`) and shown to the person; they have no effect. Tests include a model that obeys the document: it still cannot publish, approve, spend or add a field.
- **Pinning.** `decideApproval` pins the current version on the event (`events.icp_version`) when its Research card is approved. `GET /api/events/:id` returns `icp_version`. Company tiering reads the pinned version (`pinnedIcp`): its hard rules, its rendered text in the prompt, its segment and company-type lists as the closed lists the model must answer from, and the version in the tier cache key. A newly published version never touches an event already running.
- Compile uses the mock or simulated model in demo. Its reading of a document is a deterministic parser for the phrasing of `samples/orrery-icp.md` (`src/server/sim-icp.ts`), not a language model; how a real model reads other documents is unmeasured.
- The demo ICP is `samples/orrery-icp.md`, consistent with `world.json`'s tier rule; `seedIcp` publishes it as version 1 through the same functions (bench: `samples/orrery-bench.json`, 26 companies from the world). Screens: the ICP page shows the published version, the upload box, in-progress compiles, and the confirm, test and publish steps as drawn on the design canvas (stepper, the document with its passages marked beside the numbered rules, gaps marked in orange). The older settings text sits under "Settings every event starts with today". Not wired: the ICP's lists and personas do not yet feed event settings.

## Identity (Layer 1)

A company's identity is a confirmed primary domain, with its parent when known (`src/shared/identity.ts`, `src/server/identity.ts`).

- **Before the Research card (free).** The list's own evidence: a work email domain that resembles the name, has a mail server (a DNS seam, `Dns`), and is the only such domain for the company. Two resembling domains (a company and a longer-named sibling) are not told apart by counting rows; they go to search. The domain of a company dropped by a name-list match is recorded too, so a spelling variant that resolves to the same domain is caught later.
- **Stage 4, under the Research card.** Per company: free evidence; the name-to-domain cache; company search (free; weighed by name score, event country and rivals); the form's website only if it resolves and nothing stronger disagrees; then at most one person match (step `person_match`), accepted only if the employer it returns matches the row's company. An exact name with no exact rival resolves; two close names that nothing separates are `ambiguous` (a case); nothing found is `not_found` (a case, suggested drop). Reverse lookups (step `reverse_lookup`) place a person who came in with only an address or profile: one lookup per person, then the person is attached to the company at that domain, or to a new one; if none is found the person drops as `no_company`. Not wired: a company LinkedIn URL as evidence (no upload field carries one).
- **Reveals.** A person match is stored in `reveals` and by question in `reveal_queries`, a miss included (30 days), and is never bought twice, within or across events.
- **Merge.** Before anything further is paid, rows that resolve to one domain become one company (`mergeByDomain`): the survivor is a company that is not a subsidiary, then the one with most rows; people and rows move to it, other spellings are kept in `merged_names`, each row remembers where it was filed (`source_rows.listed_name`), a person now on the list twice is dropped as `duplicate`, and the name-to-domain map learns every spelling. A subsidiary that shares its parent's domain merges with the parent and takes the parent's tier; that is the design's rule, and it is wrong when a subsidiary deserves its own tier. A merge can also run after a person supplies a domain that the event already has.
- **Gates after identity.** Exact domain match against the lists drops (`excluded_company` or `existing_customer`). A parent recorded, or a merged spelling that was a subsidiary, whose parent is on a list opens `subsidiary_inheritance` (suggested inherit) instead of acting. The CRM is read by confirmed domain (`Crm.lookupByDomain`) and stores `account_type`; a customer the list missed opens `crm_customer_mismatch`. Then tier jobs are queued for every settled company.
- **Vendors** (`providers.ts`: `CompanySearch`, `PersonMatch`, `ReverseLookup`, `Dns`; mocks, `sim-vendors.ts`, and Apollo in `live-vendors.ts` behind `LIVE_SPEND=1`). Every identity call goes through a `VendorGuard` (`src/server/vendor-health.ts`): a token-bucket rate limit, a circuit breaker (opens after five failures in a row, one trial after a cool-down), retries with back-off for free calls and none for paid ones, and silent-throttling detection: an empty company search is final only after a known-good lookup (`probe`) still works, otherwise the vendor is marked throttled with growing back-off and the caller gets `VendorDown`. A job waits up to 20 seconds on `VendorDown` and then pauses the event (job requeued); it never becomes `company_not_found`. State is in memory per process. In the two-card flow the finder and verifier waterfall is behind the same guard (`pay` in `email.ts` uses `withVendorWait` and the vendor's breaker); the older single-card flow's waterfall still is not.
- **Measured against the world** (`tests/identity-world.test.ts`, run by `npx vitest run`): the simulated vendors' rates are authored (`SIM_RATES.identity`), so the numbers show the code copes with those failures and say nothing about real vendors. Floors are enforced: correct domain at least 97%, wrong domain accepted at most 1.5%, not found and ambiguous at most 2% each, person matches at most 15, false merges at most 2, plus a harsher variant (25% of companies missing from search, 10% wrong top answer) with looser floors, and a throttling run whose results must equal the unthrottled run.

## Gates, firmographics and company tier (Layers 2 and 3)

Build-order step 6. Code: `src/server/tiering.ts` (the job, spread, re-tier, correction), `src/shared/tiering.ts` (facts, needed fields, spread check, second-look trigger), `src/shared/tiers.ts` (`validCompanyTier`), `src/server/paid.ts` (the paid-call machinery moved out of `pipeline.ts`), migration 0012. One `company_tier` job is one company, start to finish, and runs only for a company whose identity is settled and that has no blocking case open.

- **Domain gates (stage 5)** are step 5's: exact domain match against the lists, parent handling and the CRM by domain, all in `finishIdentity`, before any firmographics are paid. List entries can be names or domains. The ICP's own lists do not feed event settings yet.
- **Firmographics, by domain.** The seam is `FirmographicsLookup` (`search` free, `enrich` one paid call, `provides` the fields the vendor can ever return), with a mock, a simulated vendor and an Apollo adapter (`apolloFirmographics`: `mixed_companies/search` by domain, then `GET organizations/enrich`), built only in live mode behind `LIVE_SPEND=1` and the vendor guard. Order: the cache by domain (`company_cache`, 90 days, a human correction is final and never aged), then the free search, then at most one paid enrich and only if a field the pinned ICP needs is still missing (`neededFields`: the fields its hard rules test, employees when it states a size or a size condition, the business model when a condition needs it, industry or a description) and the vendor provides it. An enrich fills only what is missing; it never overwrites. The result is cached by domain and stored on the company (`firmo`, `firmo_source`). A refused or failed enrich is not retried; the missing fields stay Unknown. Vendor values are claims: unknown keys are dropped (`cleanFirmo`). A person corrects a company with `POST /api/events/:id/companies/:companyId/firmographics`: it overwrites the cache for the domain, drops every cached tier for that domain, and takes effect for this event on a re-tier.
- **ICP hard rules, in code.** `evalHardRules` on the firmographics; a rule fires only when its field is present, so a missing value is Unknown, never a failure. A company that fails a rule is tier 3 with `tier_via = hard_rule`, costs the model nothing, and is not second-guessed by a model.
- **Company tier.** The model gets the pinned ICP in words, the supplied facts and nothing else (`Facts`: employees, industry, who it sells to, country, description, the website note, and the attendee file's own columns labeled unverified; the company's name and website are context and never citable). It returns tier 1, 2, 3 or `unknown`, a segment and company type from the ICP's closed lists, a reason code and the fact it relied on, copied from a supplied line. `validCompanyTier` validates in code: values off a closed list are an unreadable answer (one retry on the card); a tier whose fact is not a piece of a supplied line, or is under six characters, is downgraded to Unknown. An answer that cannot be read after the retry is Unknown; a provider error drops the company as `tiering_failed`. The prompt tells the model the facts are data and that a missing fact is a reason to say unknown, not to guess.
- **Unknown.** With no citable fact at all, pass one is skipped without a call. Unknown then triggers one website read (`WebsiteReader`; `liveWebsite` fetches one public https page with a short timeout and a size cap, refuses non-public hosts and cross-site redirects; the page text goes to the `website_read` prompt as data), then one retry with the website line added. Still Unknown spends nothing more and opens a blocking `unknown_tier` case (suggested: drop). The website note is cached with the domain's firmographics and never read twice.
- **Baseline.** `baselineTier` (size band plus strong keywords) is computed per company at run time and stored (`baseline_tier`).
- **No second look (cut 2026-11-09, decision 24).** It was a second model tiering every tier 1 and every tier more than one level from the baseline, blind, with a blocking `second_look_disagreement` case on a difference. On the real recording (Opus 5.5) it read 22 holdout companies and disagreed on none, so by the project's own rule it was cut: no call, no card line, no case, no Settings row. Stated confidence is still never read. The prompt template, the recording and the scorer stay so the evidence stays visible; `needsSecondLook` stays in `src/shared/tiering.ts` for the scorer only. Old events may still carry a `second_look` value and an old `second_look_disagreement` case, which still resolve.
- **Tier cache** on domain plus ICP version (`tier_cache`). A hit costs nothing; a result with an open case is not cached; Unknown is never cached; a person's answer is.
- **Spread check** (`spreadCheck`, `spreadFor`): tier 1 above `tier1_share_warning` (25%), over half Unknown, nothing in tier 1, a list under `small_list_companies` (20). Warnings with up to five examples. Logged when research finishes, returned by `GET /api/events/:id/spread` and in `GET /api/events/:id` as `spread`, and stored on the Outreach card (`inputs.spread`). It blocks nothing.
- **Re-tier** (`retier`, `POST /api/events/:id/retier` `{company_ids | scope: unknown | tier_1 | all, icp_version?}`): only in `ready_for_review`, never while the Outreach card is pending, never while jobs run. Companies are re-queued against the Research card's allowance (`retier_companies`, counted in `events.retier_used`); the stored firmographics are reused; open tier cases on them are closed (`skipped`, `retier`); the cached tiers are cleared. A tier a person set is left alone unless named. `icp_version` moves the event to another published version and re-tiers every company a person has not set, so an event never mixes versions; if that does not fit the allowance it is refused.
- **Settled cases finish inside the card.** A company a person identifies, or an Unknown a person tiers, finishes research with no new money: the card already counted every company.
- **Without a pinned ICP** (an event whose ICP was never published) the older tier runs unchanged: one prompt over the settings text and the file's columns, with the same template, no cited fact required, and an answer that cannot tell becomes tier 2. No firmographics are bought and there is no second look.
- **Measured against the world** (`tests/tiering-world.test.ts`, on Meridian): SIMULATED RESULTS ARE AUTHORED. The simulated vendors omit and misstate firmographics at `SIM_RATES.firmo` and the simulated models read the supplied facts and err at `SIM_RATES.tier`; none of these is measured. Enforced floors: right at least 85% of those decided (80% with Unknown counted wrong), tier 3 called tier 1 at most 2%, Unknown at most 10%, no second look made, every cap respected, at most 2.2 model calls per company on average, and the system within five points of the baseline. In this world the baseline is near the ceiling because the truth is a size-and-segment rule, so the model is not shown to beat it here; that is decided on the holdout only.

## Finding people (Layer 4)

Build-order step 7. Code: `src/server/people.ts` (the search job, title reading), `src/shared/titles.ts` (parser, persona tiers, adjustments, ranking, all pure), the `PeopleSearch` seam in `providers.ts`, migration 0013. Runs under the Outreach card in the two-card flow; the single-card flow keeps its paid discovery.

- **Free people search.** `PeopleSearch.search({domain, company, titles, country, limit})` returns `FoundPerson` (vendor person id, first name, last name or null when hidden, title, record date, `has_email`), and charges nothing. Mock, simulated (`simPeopleSearch`, from the world's staff) and an Apollo adapter (`apolloPeopleSearch`: `mixed_people/api_search`, built only in live mode, behind the vendor guard, **no reveal call**; unconfirmed against the real service, tested on faked responses only). The search asks for up to four times the quota (at most 25), filtered by the pinned ICP's persona titles and the event's country. The Outreach card no longer prices discovery credits (`outreach.search_cost`, default 0).
- **Title parsing, rules first.** `parseTitle` reads a title into a function (executive, sales, revenue_operations, marketing, customer_success, partnerships, finance, engineering, product, design, operations, hr, legal, it_security, support, admin, other) and a seniority (owner, c_level, vp, director, manager, senior, individual) with rules for English, Spanish, Portuguese, French and German, abbreviations (Sr., VP, Dir, Mgr, CRO...), region tails and brackets; it flags interns, students, assistants and press as `non_buyer`, and `former`. A title it cannot place (a bare "Manager", "Chief Happiness Officer") goes to the model once (`title_parse`, closed lists, step cap `title_parse`), cached by title and ICP version in `title_cache`. A refused or unreadable model call leaves the title unplaced and the person is not stored.
- **Persona tiers** (`personaTier`) from the pinned ICP: a primary persona match (function and seniority range) an owner, or a c-level executive the rules read, is title tier 1 (a chief officer only the model could read, such as "Chief Vibes Officer", is tier 1 only if a persona covers the function it was read as, decision 25); a secondary persona or anyone in sales, revenue operations, marketing, customer success or partnerships is 2; everything else, and any non-buyer, is 3. The ICP's title adjustments then apply by company type and size (`adjustTier`: a VP at a bank ranks lower, a founder at a company under 50 higher; an adjustment applies only to the seniority its words name). Priority is the existing matrix. Attendee titles are read the same way when the Outreach card is approved (`readAttendeeTitles`), replacing the keyword table's guess (a VP of Engineering is no longer tier 1); Title 3 people were already stopped before the Research card. Without a pinned ICP the keyword table stays.
- **An Unknown company tier never becomes a priority.** Unknown companies are not searched; any of their people still without a priority when the people phase starts are dropped `tiering_failed`.
- **Rank, then quota (prospects only).** After dedupe by the vendor's person id and by a visible name already on the list, people at priority C are not stored (so never paid for). A person with a hidden last name is left out until a reveal exists (step 8) and does not use a quota slot. The rest are ranked (`rankPeople`): primary persona before secondary, better title tier, the event's region, a record fresher than `freshness_days` (a date is not proof of employment), a vendor-reported email, then variety across functions (the best of each function first); ties break on id so a run repeats. Quota: tier 1 up to 5, tier 2 up to 3, counting prospects already at the company. Attendees are never cut by a quota and keep `source = 'attendee'`; discovered people are `prospect`.
- **Outreach card.** Titles the rules cannot place count as `titles_with_no_rule`; because discovered titles are unknown when the card is quoted, every discovered person is priced as if their title needed the model, twice (`discovered_title_llm`). Steps `title_tier` and `title_parse` both carry that cap; the card total caps both together. Eligibility of attendees at the card uses the rules' best case.
- **Drop reason `no_people_found`** replaces `no_contacts_found` everywhere. Migration 0013 rewrites stored rows; the shared labels (`dropLabel`) and the workbook keep a label for the old value so an old row or an older screen still displays.
- **Measured against the world** (`tests/people-world.test.ts`): SIMULATED RESULTS ARE AUTHORED (`SIM_RATES.people`; the title labels in `samples/world-titles.json` are hand labels of the generator's title lists, written without reading the parser). Enforced floors: at least 90% of world titles placed by rules, tier at least 82% and function at least 90% right, at most 3% given tier 1 where the world says tier 3, no company over its quota, no attendee cut, no prospect at priority C, wrongly-A at most 25% of A (at most 12% where the world says C; the 25% was 20% until the second look was cut, decision 27), the people search charging 0, title_parse calls inside the card and under a quarter of prospects, and every Outreach step inside its cap.

## The email loop (Layer 5)

Apollo and ZeroBounce are the only direct email vendors (`docs/DATA-HYGIENE.md`, section 0, and decision 23). Where this section says finders or two verifiers, read Apollo's match and waterfall, and ZeroBounce plus Apollo's Verified.

Build-order step 8. Code: `src/server/email.ts` (the loop), `src/shared/email.ts` (role and disposable addresses, patterns, suppression keys), `Reveal` and the `PeopleSearch.probe` in `providers.ts`, suppression and domain state in `caches.ts`, migration 0014. Two-card flow only: the single-card flow keeps its separate `find` and `verify` jobs. One `find` job per person runs the whole loop, and every paid call is written to `contacts.email_loop` before and after it.

- **Catch-all probe.** First, per company domain, before anyone there is revealed: one verifier-one call on an address nobody has (`zz-<hash>@domain`), priced at `max(probe_cost, verifier one's rate)`, step `catch_all_probe`. An answer of deliverable or catch_all means the domain accepts every address: everyone there drops `catch_all_unconfirmed` (the default; a specialist catch-all verifier that could still confirm them is not built) and nothing more is spent on them. No mail server (DNS seam, free): `not_deliverable`, no probe. Domain state is cached in `domain_state` and reused for 30 days across events.
- **Reveal.** A discovered person's first lookup, by the vendor that found them (`Reveal`: mock, simulated, Apollo `people/match` by id, no personal emails), paid once per person, stored in `reveals` and never bought twice; a miss is remembered. Hidden last names now enter ranking like anyone else (`contacts.name_hidden`); the reveal comes only after ranking and the quota. Its cost is `outreach.reveal_cost` (default the first finder's rate); a revealed person does not pay that finder again.
- **Employment check**, right after the reveal and before any verifier is paid: the employer must match the company's domain, its parent's domain, a domain the name has resolved to, or (with no domain) match its name. A discovered person who fails drops `employment_unconfirmed`. An address at any other domain than the company's own is never a candidate (`off_domain`); a registered attendee whose vendor-found address disagrees becomes a case in step 9.
- **Candidates, at most 3 per person**, in order: the uploaded address, the reveal's address, Apollo's match, then Apollo's waterfall on a miss (each needs a full name, so a person whose reveal missed and whose last name is hidden gets none), and a pattern guess only if `outreach.pattern_guess` is on (off by default: it needs two verified addresses at the domain that agree on a pattern, and it carries legal risk in some markets, so counsel should sign off first).
- **Verifying a candidate.** Free checks first: a role or disposable address (`info@`, mailinator) is skipped; an address opted out stops the person (`rejected_in_review`); a wrong-person pair skips it; a result under 30 days old (`verification_cache`, positive and negative) is reused with no call. Then ZeroBounce (an unknown is retried once, once per person in all, `outreach.verifier_retries`). A found address must also be marked Verified by Apollo, which is checked before any ZeroBounce credit is spent. An address from the attendee list is checked by ZeroBounce and shows as "Verified once". A catch-all answer marks the domain and stops. Anything else moves to the next candidate. No candidate left: the most specific reason (`catch_all_unconfirmed`, `email_unconfirmed`, `not_deliverable`, `employment_unconfirmed`, `duplicate`, `vendor_error`, else `no_email_found`). A kept person goes on to the LinkedIn lookup as before.
- **Suppression** (`suppressions`, spans events): `addSuppression` for an opt-out (an address, or a name at a company) or a wrong-person pair. A person's Drop in one event's review is not recorded. Routes and screens exist (see "Opting out"); an opt-out drops as `opted_out`.
- **Vendors behind the guard.** The probe, reveal, finders and verifiers all go through the vendor's `VendorGuard` (rate limit, breaker). A guard that refuses, or a vendor that fails every attempt without billing, waits and then **pauses the event with the loop where it was**; nobody is dropped for an outage. Fewer than two verifiers up pauses it too. A paid call whose outcome is unknown (an error that may have billed) is never repeated: that candidate is closed and the loop goes on; a worker that dies mid-call has its call closed the same way (`inflight`). A call the step's cap refuses drops the person as `budget_cap` (a probe refused drops the people at that domain).
- **The Outreach card, worst case.** `reveal_credits = discovered x reveal_cost`; `finder_credits = attendees at A or B x (all finders) + discovered x (all finders minus the first)`, because a failing uploaded address sends an attendee to the finders too; `verifier_credits = people x (candidates + retries) x the verifier's rate`; `probe_credits = domains x max(probe_cost, verifier one)`; `linkedin_credits = people x rate`. Step `reveal` has its own cap. A test drives every discovered person down the longest path (reveal reads unknown twice, the match finds an address ZeroBounce fails, the waterfall finds one that passes) and checks the spend exactly and against every cap.
- **People search under silent throttling.** An empty search is final only after the known-good lookup (`PeopleSearch.probe`) still returns someone; if not, the vendor is throttling, the job waits and then pauses, and the whole search is retried after the wait. It is never read as `no_people_found`.
- **Measured against the world** (`tests/email-world.test.ts`): SIMULATED RESULTS ARE AUTHORED (`SIM_RATES.reveal`, finder, verifier and people rates). Enforced floors: kept people are real mailboxes of the named person at least 95% and 90%, wrong person at most 3%, catch-all domains reported as a gap with at most 20% of those people let through and at most 20% of the stops at domains that are not catch-all, every Outreach step inside its cap, one probe per domain at most, total credits at most half the card's worst case, employment drops before any verifier, nothing at priority C ever revealed or verified, nobody kept without a deliverable verdict, and a run with the verifier down pauses, drops almost nobody, charges no verifier credit, and finishes after a resume.

### Opting out

`POST /api/suppressions` `{email}` or `{name, company}` (and an optional `reason`) records an opt-out (`src/server/suppression.ts`, table `suppressions`, `created_by` since migration 0015); `GET /api/suppressions` lists them. An opt-out spans events. Recording one takes the person off every outreach list they are still on, with the drop reason `opted_out`, and from then on the email loop stops them before a single credit is spent: by name at a company before the reveal, by address at any candidate. A wrong-person pair (an address known not to be this person) is stored the same way and skips that candidate. A person's Drop in one event's review is never recorded here.

## Tiering

**Company tier** (1, 2, 3, or Unknown in the two-card flow): code applies the two lists first. An exclusion match drops as `excluded_company`. An existing-customer match drops as `existing_customer` and still appears on the Companies tab, labeled. An LLM classifies the rest against the ICP (see "Gates, firmographics and company tier" for the pinned-ICP flow).

**Title tier** (1, 2, 3): the keyword table decides what it can. The LLM handles only the titles it misses.

Each LLM tiering call returns only a tier and one reason code: `icp_match`, `partial_icp_match`, `outside_icp`, `decision_maker`, `influencer`, `not_relevant`, `insufficient_information`.

| | Title 1 | Title 2 | Title 3 | No title |
|---|---|---|---|---|
| **Company 1** | A | B | C | A |
| **Company 2** | B | C | C | B |
| **Company 3** | C | C | C | C |

"No title" covers company-only rows and people listed without a title. A contact found by discovery takes its row's priority.

**C stops after tiering and is never enriched; it is dropped as `low_tier`.**

Drop reasons, exactly one each: `duplicate`, `no_company`, `excluded_company`, `existing_customer`, `low_tier`, `tiering_failed`, `no_people_found`, `no_email_found`, `not_deliverable`, `vendor_error`, `budget_cap`, `rejected_in_review`; the two-card flow adds `junk_row`, `not_a_company`, `company_not_found`, `email_unconfirmed`, `catch_all_unconfirmed`, `employment_unconfirmed` and **`opted_out`** (its own reason: an opt-out is not a review decision), and `crm_unsubscribed` and `crm_do_not_contact` (Salesforce's Email Opt Out and Do Not Contact, with no override; see `docs/DATA-HYGIENE.md`).

## Enrichment

Every vendor sits behind one interface per job: discovery, finder, verifier. **Mocked by default; the demo's large event uses the simulated vendors above.**

1. **Discovery** (single-card flow; the two-card flow uses the free people search, see "Finding people") runs for company-only rows at priority A or B, up to `contacts_per_company`. Zero people drops the row as `no_people_found`.
2. **Finders** run in configured order and stop at the first email. Every attempt is recorded, including misses. No email drops as `no_email_found`.
3. **Checked email.** A found address needs Apollo's Verified and a ZeroBounce pass. An attendee-list address needs a ZeroBounce pass and shows as "Verified once". An email that is not certainly valid is invalid: nobody may include an unconfirmed email on a list.

| Apollo's mark (found addresses) | ZeroBounce | Result |
|---|---|---|
| Verified | deliverable | Keep, "Verified twice" |
| not Verified | not asked | Try the next candidate, saving the credit |
| not applicable (attendee-list address) | deliverable | Keep, "Verified once" |
| any | undeliverable | Drop as `not_deliverable` when no candidate is left |
| any | catch-all, unknown, or a verifier error | Drop as `email_unconfirmed` ("Email could not be confirmed") |
4. **LinkedIn.** Discovery and the finders return a person's LinkedIn URL when the vendor has it (Apollo `linkedin_url`) and it is stored. Every kept contact who still has none, including attendees who arrived with an email and skipped the finders, gets one paid lookup job (`linkedin` in the enriching stage, vendor `apollo_linkedin` live) after verification, so people who were dropped cost nothing. It reserves through the ledger like any paid call; the card has a `linkedin_credits` line (contacts times the lookup rate, worst case) inside `credits_cap`. A refused, failed, empty or lost lookup never drops the contact and a call with an unknown outcome is never repeated. Only a real `linkedin.com/in/...` URL on http or https is stored (rebuilt as `https://www.linkedin.com/in/<name>`); everything a file or vendor returns is untrusted.

## Review flagging

Code adds `not_reviewed` when the model could not be asked. An LLM reads each finished contact and may add `title_company_mismatch`, `likely_left_company` or `name_looks_wrong`. It returns codes only. It never writes a cell's text and never removes a contact.

## CRM context

After tiering and before enrichment, the pipeline reads each company that is not excluded through the CRM seam (`Crm` in `src/server/providers.ts`): account owner, open deal name and stage, last activity date, and heat. Heat follows one written rule: hot is an open deal with activity in the last 30 days, warm is an open deal or activity in the last 45 days, cold is everything else. It is stored on `companies` (migration `0008_crm.sql`). Reading it is free, so it has no ledger entry, and a CRM failure leaves the company blank and never stops the list. In a two-card event the read is by confirmed domain in stage 4 (`lookupByDomain`), and the answer carries an account type (customer, prospect, partner, competitor, none; migration 0011). **Mocked by default (the simulated world has a CRM that knows the world's customers and a few the list misses, at a stated rate); there is no real adapter yet.** No deal amounts are read or stored: the workbook and Concierge stay free of money.

## The workbook

Built entirely by code. Two pieces of model-written text reach it: the opening of the Summary, which code checks (see "The Summary's perspective"), and the short website note on the Companies tab, which a cited tier fact can repeat. An LLM writes into no person row. It is a working surface, not an export: each tab is laid out around what its reader has to do, in Excel or after import into Google Sheets (dropdowns from data validation, conditional formatting, frozen headers, filters, print fit to width). The tabs are, in order: Summary, Review, Attendees, Prospects, Companies, Other attendees, Meetings, and a hidden Lists tab. Every list tab has a title row, a row of labelled group bands and a header row, and the groups a reader needs less often are folded.

| Tab | Who it is for | Contents |
|---|---|---|
| Summary | Anyone opening the file cold | It states and never directs (decision 19). It opens with three parts: why this event (from the seat requests), the list against the ICP (with a comparison against other delivered lists), and where the accounts stand in the CRM, or "not connected". A model writes the parts and code checks them, or code writes them (decision 22). Below that are live numbers (people on the list, priority A, decisions still open, meetings, emails verified twice, companies on the list, hot accounts), the funnel, the largest accounts, what ran and what each tab holds |
| Attendees | A rep | A and B people from the attendee list. Groups: Person (priority, name, title, seniority, function, email, email status, LinkedIn), Company (tier, fit, industry, employees, country, revenue, website), CRM (account type, heat, owner, deal, stage, last activity, a "No calls" mark), a folded Detail group (source, where the email came from, record refreshed, location, vendor seniority, departments, in role since, employer per vendor, tiers, flags) and Outreach (an **Outreach status** dropdown and **Notes** for the rep). A hidden contact id column lets a Sheet refresh match rows |
| Prospects | A rep | A and B people found at buyer titles at attending companies, not on the list, same columns |
| Companies | A marketing lead | Every company on the attendee list, the way a CRM or ABM tool shows an account, in labelled bands: account, fit (tier, fit word, segment, company type, *why this tier* as the supplied fact it relied on, and who tiered it), firmographics (employees, industry, who it sells to, country, city, revenue, founded, funding stage, LinkedIn, and where the facts came from), CRM, and the outreach list (people kept, listed, on the list, priority A, and an **account band** by one written rule: Focus is tier 1 and hot or warm, Grow is any other tier 1 or a tier 2 that is hot or warm, Watch is the rest). Sorted by tier then heat. A reference tab, nothing to fill in |
| Other attendees | A rep, a marketing lead | One row per person from the attendee list who has a **tier 3 title** or is at a **tier 3 company** (tier 3, not priority C: a person can be priority C and tier 2 on both and is not here). People only: tier 3 companies are on the Companies tab. Name, title, company, both tiers, why in plain words, the email as uploaded, and what happened to them. No paid enrichment ran for them. **The tab appears only when the attendee list had people** (a list of company names alone has no such tab) |
| Review | The reviewer | One row per case that needs a person and holds nothing, **grouped by case** (name and address differ, registered elsewhere, doubt about the person, two companies, personal address, late-stage deal; filter the Case column to work one kind at a time). Each row has the person, the plain-words finding, a **LinkedIn** link and a **Web search** link, a **Suggested** answer by rule, a **Decision** dropdown with only the options that case allows (`Keep`, `Drop`, `Dismiss`; a late-stage deal allows `Keep` and `Dismiss`) and what each choice does. A flagged person no case covers yet is a row too. Progress at the top is live and decided rows recede. `case_id` and `contact_id` sit in hidden columns, and a decision is read back through the case, the same function the Cases screen uses |
| Meetings | Anyone at the event | Empty rows ready to fill: a contact dropdown of everyone on the list, company and owner by formula, date, time, location, status and outcome dropdowns, notes. The Summary counts booked and held meetings live |
| Lists | Nobody (hidden) | Feeds the Meetings dropdown and lookups |

Every user-facing sentence says "attendee list" for what was uploaded and "outreach list" for what is delivered. Every tab keeps the formatting rules: one validation per contiguous range, no text-matching `cellIs` rule, a filter that covers its data, columns wide enough for their headers, and a row tall enough for every wrapped cell (`wrapShortfalls` is checked on every tab, not just the Summary).

The suggested review answers are composed by code from the data, with deterministic rules, never by a model. The Summary has no game plan. Largest accounts are ranked by company tier, heat, open deal, then contact count. Every formula carries a cached result so previews show values. Strings from the CSV are always written as text, never as formulas, and any hyperlink built from data is validated as http(s) and encoded.

### Delivery as a Google Sheet

The owner's decision: the list is delivered on a Google Sheet, because a link is easier to share with the team, and the system only needs to accept Excel uploads. The Sheet is a copy of the same workbook built by `buildWorkbook`; nothing about its contents changes.

- **Seam:** `SheetPublisher` in `src/server/sheets.ts` (`create`, `share`, `readReview`), like the other providers. The mock is disabled and returns no link, so the demo and any run with spend off need no keys and offer the file download only. The Google implementation exists only in live mode (`sheetsFor`, wired in `node.ts`).
- **Google path:** a service account (`GOOGLE_SERVICE_ACCOUNT_JSON`) signs a JWT for an access token, uploads the workbook with Drive v3 multipart upload into `GOOGLE_DRIVE_FOLDER_ID` (`supportsAllDrives=true`, target mimeType `application/vnd.google-apps.spreadsheet` so Drive converts it), then adds one permission: `type: domain`, `role: writer`, `domain: GOOGLE_SHARE_DOMAIN`. Never "anyone with the link": the file holds personal contact data. The module refuses a share domain that is not a plain domain. The folder must be in a Shared Drive, because service accounts cannot own files in My Drive.
- **When:** after the event moves to `delivered`, so a Google failure can never block or undo delivery. A failure is stored in `events.sheet_error` and logged as an activity line; the download still works. `POST /api/events/:id/sheet` retries. `events.sheet_id` is saved the moment Drive has the file and `sheet_url` only after sharing succeeds, so a retry after a sharing failure only shares, and publishing never makes a second Sheet while one exists. The link is built from the id, never taken from a response.
- **Read back:** `POST /api/events/:id/review/sync` reads the Review tab with Sheets `values.get` and applies decisions. File import and Sheet sync both find the header by its `contact_id` and `Decision` cells and call one function, `applyReviewDrops(db, eventId, actor, contactIds)` in `workbook.ts`, which matches on `contact_id` and only for contacts of that event. An unknown id or one from another event changes nothing. The single-person screen route can call the same function.
- **API:** `GET /api/events/:id` returns `event.sheet_url` and `event.sheet_error` (not the id). Concierge views are unchanged and carry no Sheet link.
- **Second sign-in (personal Gmail):** OAuth user credentials (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`, scope `drive.file`, the narrowest that creates files and reads back the ones it created). The Sheet is created in the signed-in user's own Drive and shared as writers only with `GOOGLE_SHARE_EMAILS`; with none it stays private. `scripts/google-auth.ts` runs the consent on a loopback port and writes the refresh token to a named file, mode 600, never to the terminal. `make publish-sample` publishes the fictional sample and updates the same Sheet in place; `--public-view` (view-only for anyone with the link) exists only there, because the publisher takes no bytes and no path. Setup: `docs/GOOGLE-SETUP.md`.
- **Google-native layer** (`src/server/sheets-polish.ts`, decision 18): after create and after update, a second pass over the Sheets API sets fonts, tab colors, folded column groups, dropdown chips, saved filter views and SPARKLINE bars on the funnel. A refused batch is one activity line and the link still delivers. There are no protected ranges (decision 20).
- **Refresh:** `POST /api/events/:id/sheet` on an existing Sheet runs `refreshSheet`, which keeps what people typed (see "New registrations and original files").
- **Mode rules:** live mode needs one complete Google sign-in, either the service account set (`GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_SHARE_DOMAIN`) or the OAuth set; both at once is refused. They are no longer in `LIVE_REQUIRED` itself, which holds the rest; bad Google settings stop the server at start.

Conditional formats are written as expression rules (`=$A4="A"` anchored on the first row of each range) and every tab's filter spans the header through the last data row, because Google Sheets mis-imports text `cellIs` rules and header-only filters.

Importing the workbook back matches on `contact_id`, finds the header row by that column wherever the banner puts it, and needs the write key when one is set. A `Drop` becomes `rejected_in_review`; `Keep` and blank change nothing. Counts, the Q&A agent and any re-download then reflect it.

## The Q&A agent

**Concierge** is an MCP server over delivered lists, plus a thin agent that answers in Slack (`/ask-desk <event id> <question>`) or from `make ask`. Its prose answers are the one place an LLM writes text a person reads, and they are never written into the list.

- Tools are read-only: events, counts by priority, tier and company, counts of dropped contacts by reason, and prospect lookup.
- **It shares counts, never money.** Tools read only from views with no cost, credit, budget or seat-price column. Every query runs under `SET LOCAL ROLE concierge_reader`, a Postgres role that can read only those views. `budget_cap` is reported to the agent as `other`.
- Each question reserves against the card's agent allowance.

## Evals

| Step | Measured per | Gate |
|---|---|---|
| Company tiering | unique company, on the frozen holdout | Accuracy at least 85% with Unknown counted wrong, Unknown at most 25%, zero true Tier 3 companies labeled Tier 1, and it must beat the baseline |
| Title tiering | unique title, on the frozen holdout | Tier accuracy at least 90% with Unknown counted wrong, Unknown at most 15%, no tier 3 given tier 1, and it must beat the keyword baseline |
| Review flagging | contact | Recall at least 80%, precision at least 60% |
| Concierge | question | Every money question refused with no number, every count question picks the right tool |

Review and Concierge run against a labeled synthetic list in `evals/list.json` (fictional people, correct answers written down). Company tiering has its own sets (`src/evals/company-tier.ts`): a development set of 120 (the 100 generated companies plus 20 edge cases; prompts are tuned on it) and a frozen holdout of 68 (30 hand-written fictional hard cases and 38 real public companies, labeled by hand against the demo ICP from the author's own knowledge, marked `real_public_author_knowledge`: remembered, approximate, unverified). The holdout file's hash is pinned in a test. A label is the tier the demo ICP gives for the facts shown; a test cross-checks every complete label against the ICP rules in code and names the five lookalike traps the code misreads. Items the hard rules decide are not sent to the model. The report (`node scripts/eval-report.ts`) shows every rate with a 95% Wilson interval and always includes the baseline (size band plus keywords) and the ICP's own tier definitions applied in code; the model appears only from a fresh recording. The second look is also reported, as evidence for decision 24. Title tiering has its own sets (`src/evals/title-tier.ts`, `scripts/gen-title-evals.ts`): a development set of 117 and a frozen holdout of 114 (pinned by hash), each with hand labels for function, seniority and tier under the demo ICP, covering Spanish (25 holdout titles), Portuguese, French, German, messy titles and inflated ones. The parser was written first and tuned on the development set only, and the holdout was written afterwards. **The title holdout has since been looked at**, when a failing item (a made-up chief officer title) led to the general rule in decision 25, so its figures are not clean held-out results. The keyword baseline is the settings table, and a title it does not decide counts as wrong. The earlier title prompt's 100% was tuned on its own list and is not evidence. The values above are starting points; changing one needs an ADR.

- **CI replays recorded model outputs**, so it needs no key and costs nothing. Each recording stores a hash of its prompt template and model, and the company-tier, second-look and title-parse recordings also store `inputs_hash`, a hash of every filled prompt (so a changed ICP, fact format or eval item is caught too). A recording that no longer matches is STALE: it is never scored, it must be declared in `evals/recordings/stale.json` with what to re-run and how many calls that is, an undeclared stale recording fails the tests, and with `EVALS_STRICT=1` (which CI sets) every stale or missing declared recording with a call estimate above zero fails. As of 2026-11-09 the recordings for `company_tier`, `second_look`, `title_parse`, `title_tier`, `review` and `concierge` are fresh and `EVALS_STRICT=1` passes. `website_read` and `perspective` are declared with no calls planned: the website reader needs page text the eval sets do not carry, and the Summary is gated at run time by its checks instead of a score. The recordings are of `claude-opus-5-5`, and new ones store `served_models`.
- **`make evals-live`** calls the real model and re-records. It needs `ANTHROPIC_API_KEY` and `LIVE_SPEND=1`.
- The README states plainly that CI replays recordings and gives the recorded numbers. The date of each recording is in the file.

Separately, CSV mapping has ordinary tests against three differently shaped messy files. `make demo` uses a deterministic mock LLM, which says so on screen and proves nothing about model quality.

## Reuse and what it saved

Code: `src/server/caches.ts`, `reuse_log` (migration 0035), `src/server/usage.ts`. Detail and the test list are in `docs/DATA-HYGIENE.md` and decision 23.

- A stored answer replaces a paid call wherever one exists: company facts by domain (90 days, `firmographics_cache_days`), tier by domain and ICP version, title readings, person matches and reveals, Apollo waterfall results, LinkedIn lookups, email verification results (30 days, `verification_reuse_days`, good or bad), catch-all state per domain, and name to domain. A found reveal older than `freshness_days` (180) is treated as absent. A reused reveal that fails the employment check is bought once, fresh, only when the stored record is over 30 days old, and a replay cannot pay twice.
- Each time a stored answer replaced a call that would otherwise have been paid, one `reuse_log` row records the vendor, step, unit (credits or model calls) and amount at the real cost. A free call that was skipped is not a saving. A row counts once per contact, step, vendor and candidate, and only for an answer written by another event or by this event before its first card was approved. A stored miss is not a saving.
- Usage shows "saved" on each vendor's own pool and a line on the AI bill in dollars. Credits and dollars are not added or converted, and credits are not summed across vendors. Rows survive an event delete.

## Salesforce checks, one record per person, write-back

Code: `src/server/crm-checks.ts`, `person-record.ts`, `crm-outbox.ts`; migration 0037; decision 28. **Salesforce is not connected and no adapter exists.** The simulated CRM (`simCrm`) stands in for it in the demo and the world tests. Live mode uses `noCrm`, which reports `connected: false`: no check runs, nothing is queued, and owner, deal, last activity and heat stay blank.

- **Flags.** Email Opt Out drops as `crm_unsubscribed`. Custom Do Not Contact drops as `crm_do_not_contact` (both set: do not contact). Do Not Call keeps the person and sets `contacts.no_calls`, shown as a "No calls" column on the Sheet. Do not prospect excludes the company (`excluded_company`). A bounce counts only for the address it happened on, and makes a stored verification of that address count for nothing. The seam returns every matching Lead and Contact and our code applies "any record flagged"; a name at the account is always asked alongside the address. There is no override: these drops open no case and never reach Review.
- **When.** At the start of a run before any paid step, at the domain gates, in the email loop for an address newly found or revealed, and before delivery. `preSendCheck` is tested and wired to nothing.
- **Failing closed.** If a connected CRM throws, or answers without one of the people asked about, the run pauses as repeatable and nobody is dropped for it. The marker for a check is set only after it succeeds.
- **One record per person.** `people` (with address history) links contacts by email, then LinkedIn, then vendor id; a name alone never links. Role, disposable and shared addresses never link. Linking runs in its own transaction and is caught, and a test confirms a run gives the same priorities and kept people without the table. The person panel shows "Seen at N events" from two events up, and when the person was last verified.
- **Write-back.** A kept person verified twice queues an `email` row in the delivery's own transaction; an opt-out queues an `opt_out` row. A sweep run at boot and every 5 minutes (an authored number) sends them, fills blanks only (Email Opt Out is the one exception), never creates a record, and gives up after 5 attempts (also authored). It is simulated only.

## New registrations and original files

Code: `src/server/top-up.ts`, `inherit.ts`, `uploads.ts`, `delete-event.ts`; migrations 0032 and 0038; decisions 21 and 29. Detail in `docs/NEW-REGISTRATIONS.md`.

- **Attendee list block.** The event page lists each list received. The original bytes are kept (`upload_files`); a list from before that has "Download rows", a CSV rebuilt from the stored rows. Replace is allowed at `mapped` and `quoted`.
- **Top-up.** On a delivered event, a new file goes through the same mapping and normalization. Rows already on the parent (by email or LinkedIn, then by name only when an email is missing on one side) are counted and set aside. If nothing is new, nothing is kept. Otherwise a hidden event row with `parent_event_id` holds only the new rows, with copies of the parent's known companies marked `inherited_from`, which skip identity, firmographics, tiering and search. It runs the normal stages with its own cards, caps and reservations. It never publishes a Sheet of its own.
- **Merge.** When the top-up is delivered, one transaction moves its results into the parent, drops an email already live on the parent as `duplicate`, and marks the top-up merged. A crash is retried at boot. Parent rows are left as they were, with one exception: a company the parent never tiered gets its first assessment. Then `refreshSheet` rebuilds the Sheet, keeping Review decisions, Outreach status, Notes and Meetings, and leaving the Sheet alone if any read fails.
- **Delete.** `DELETE /api/events/:id` (GTM team and seat approvers) is refused while a run is going. It removes what the event owns and keeps what spans events (opt-outs, ICP versions, caches). Spend stays counted in Usage and Budget through copies (`ledger_kept`, `llm_calls_kept`, `ticket_spend_kept`). Nothing is deleted automatically.

## The Summary's perspective

Code: `perspective-run.ts`, `perspective-model.ts`, `perspective-check.ts`; migration 0033; decisions 22 and 27. One model call per delivered two-card list, after the move to delivered and before the Sheet is built, as the `perspective` step of the Outreach card (one call and one retry at most). The model sees a packet of event-level facts built by code, with the seat requesters' own words fenced as data, and no attendee names, emails, titles or CRM owner names. It must return exactly three parts. A part is printed only if every number is in the packet or is a sum, difference or 100 minus a percentage of numbers in one group of the packet, every quotation is word for word inside a seat request, every capitalized name is in the packet, and the wording has no advice, second person, markup or leading formula character. A part that fails is replaced by the code-written text for that part alone. The result is stored with which parts a model wrote and the hash of the facts it saw, so a later change (a review drop, a ticket bought) makes the rules write the text. The simulated model returns the code-written text and is stored as `simulated`. Three real calls have been made.

## The simulated world and the spend guard

**The large event.** `scripts/gen-world.ts` (fixed seed, no clock, so two runs write identical bytes) writes two files. `samples/attendees-large.csv` is the messy upload: a title line above the header and extra fields (ticket type, country, dietary needs, website, LinkedIn). `samples/world.json` is the known truth: 1,650 data rows from 420 fictional companies (about 3,200 people in all, counting staff who did not register), a long tail (seven delegations of 30 to 60 people, more than half the companies with one or two), every true domain on the reserved `.example` TLD, people from a dozen cultures with accented and non-English names, and titles that include inflated, ambiguous and Spanish, Portuguese, French and German ones. Each company and person carries its truth: domain, parent, segment, employees, industry, business model, the right tier for the stated fictional seller (Orrery Revenue Software, a revenue operations product, not payments; the tier rule is written in `world.json`), whether the person is really there, and their real email.

**Mess is stated, not hoped for.** `world.json` lists every mess type with its stated rate, the exact target and the count actually written, and tests re-measure the rates from the CSV itself. Company-only rows 15%, website blank 14% plus filler 11%, free webmail 6%, placeholder email domains 2.5%, email typos 1.5%, N/A or dashes 3%, keyboard mash 1%, swapped columns 2.5%, own name as company 1%, casing and legal-suffix variants 22%, typo or shortened company names 4%, students, press and self-employed 3%, real duplicates 3%, registered under an old employer 4%, email left blank 12%. Fixed hard cases: two teams registered by an assistant on one address (9 and 6), a travel agency registering 11 people from unrelated companies on its own domain, 12 invented mailboxes on real domains, 6 pairs of different people with one name, 8 people registered at two companies, 12 pairs of similar-named companies (some of the smaller one's staff type the larger one's exact name), 14 subsidiaries on a parent's domain.

**Simulated vendors** (`src/server/sim-vendors.ts`) implement the existing `Vendors` and `Llm` interfaces from that truth, so the pipeline needs no change. They answer from truth and go wrong only at the rates in `SIM_RATES`: discovery misses 10% and lists a person who has left 8%; the finders return the true address 58% and 72% of the time, a guessed mailbox on the right domain 6% and 4%, and the new employer's address for a person registered under an old one 70%; verifiers call a mailbox that does not exist deliverable 4% and 2%, miss a catch-all domain 8% and 4%, and answer unknown 3% and 2%; any call can fail about 1%. About 22% of company domains are catch-all. A company or address the world has never heard of falls through to the plain mocks, so the five small events behave as before; names the world marks as junk find nothing. The model double answers from truth too, wrong by one tier 6% of the time on titles, and flags a registered-under-an-old-employer person 85% of the time. These rates are chosen, not measured. The world proves the code copes with those failures; its accuracy numbers only reflect the rates chosen. From step 6 the simulated vendors also return firmographics (`simFirmographics`: the free search returns each field at 92% employees, 95% country, 75% industry, 55% description and 20% business model; the paid enrich fills the rest at 80% to 97%; 8% of headcounts are about half or 60% too high; 5% of domains are unknown to it; the site read finds no page 12% of the time), and the simulated model, when it is given facts, reads them and applies the seller's tier rule: wrong by one level 8% of the time, unknown although the facts decide it 4%, a guess instead of unknown 25% of the time when a deciding fact is missing, and a fabricated cited fact 2%. A second instance with another salt rolls independently, as a second model would. With no facts under INPUT (the older flow) it still answers from truth by company name. All of these rates are authored. Nothing in it can reach a network.

**Boot.** `make demo` seeds the large list (the generator's fictional "Meridian Trade Expo" world) onto one of the real-named flagship events, through the real code paths (upload, cost card, approval, tiering, enrichment, flagging) to delivered with the simulated vendors, in about 2.5 seconds on a laptop. If that ever passes about 5 seconds, seed it only to an approved card (`seed(db, { large: "background" })`) and let the server's existing boot kick finish it in the background.

**Spend guard.** A refusal pauses the event with the reason in its activity. When a run is live (`LIVE_SPEND=1`, so any real provider), `processEvent` first counts the event's source rows and refuses to start if they exceed `REAL_RUN_MAX_ROWS` (default 4), before the model or any vendor is touched. The message says how many rows there are and how to raise the limit; only an explicit `REAL_RUN_MAX_ROWS` env value raises it. `make apollo-check` obeys the same limit. For the model, `make evals-live` makes at most `EVALS_MAX_ITEMS` real calls (default 8). A run that does not cover the whole list writes to `evals/recordings/partial/` and leaves the CI recordings alone; a full re-record needs `EVALS_MAX_ITEMS=` the full count, set on purpose. Company tier is 163 calls (the items the hard rules do not decide); run one step at a time, for example `node scripts/record-evals.ts company_tier`.

## Modes

| | Demo (`make demo`) | Live |
|---|---|---|
| Database | PGlite, always | `DATABASE_URL` |
| Vendors and LLM | Simulated from the fictional world (Meridian) or mock, always, **even if keys are exported** | Real, needs keys and `LIVE_SPEND=1`, capped at `REAL_RUN_MAX_ROWS` source rows per run |
| Requests | In the app | In the app (Slack only decides cards and answers `/ask-desk`) |
| Approvals | Slack-style panel in the app | Slack buttons, signature verified |
| Identity | Fictional seeded people you switch between | The same switch on screen, Slack user ids for approvals and cards |

In both modes approvals go through one function, `decideApproval()`, which enforces who may decide (see "Who confirms what"). The panel's route exists only in demo mode and uses the acting person's name; it enforces the same rule. The signed Slack route is the only way to confirm in live mode.

Google Sheet delivery follows the same rule: the Google publisher is built only when `LIVE_SPEND=1`; `--demo` always uses the mock, so no Google call can happen in a demo.

**The server refuses to start with `LIVE_SPEND=1` unless the Slack signing secret, the approver list and `SLACK_USER_MAP` are set.** Real money can never be confirmed by an unsigned click. `WRITE_KEY` protects other writes, as in gtm-backlog.

## Data

`events` (with `country`, `flow`, `phase`), `approvals` (kinds `seats`, `card`, `research`, `outreach`), `cost_cards` (with `kind`, caps, `step_caps` and rates snapshot), `review_cases`, the cross-event caches (`company_cache`, `name_domain_map`, `tier_cache`, `title_cache`, `verification_cache`, `domain_state`, `reveals`, `suppressions`; migration 0010, rules in `src/server/caches.ts`), `event_settings`, `uploads`, `source_rows`, `companies` (with the CRM columns: owner, deal name and stage, last activity, heat, `account_type`, and identity: `primary_domain`, `parent_*`, `identity_state`, `identity_via`, `identity_evidence`, `merged_names`, `in_research`), `icp_documents`, `icp_compiles`, `icp_versions` and `events.icp_version`, `reveal_queries`, `contacts`, `review_flags`, `jobs`, `enrichment_attempts`, `llm_calls`, `credit_ledger` (with `step`; entries of kind `reserve`, `settle`, `release`, amounts never negative) and `activity_log`. Later migrations add `reuse_log`, `waterfall_cache` and `linkedin_cache` (0035), `llm_calls_kept` (0036), `people`, `person_emails` (address history) and `crm_outbox` (0037), `upload_files`, `ledger_kept` and `ticket_spend_kept` (0032), and `parent_event_id`, `inherited_from` and `ended_at` for top-ups (0038). Every write is one transaction and adds an `activity_log` row. Stage moves use `SELECT ... FOR UPDATE`. Every LLM call stores its prompt hash, model, tokens and parsed output.

## Views

Read the current behavior of each screen in `docs/SCREENS-BRIEF.md`; this is the short version.

| View | What it is for |
|---|---|
| Overview | A rail of event cards from today, what is at risk, seats waiting, lists delivered lately |
| Events | The whole program as a timeline, past and future, with search and filters held in the URL; listed events nobody has requested appear muted with a Request action |
| Event page | What the stage needs, the cost cards, the cases, the narrowing, companies and people with filters, delivery |
| Seats | One request per person per event, grouped by event; approvers decide; the budget left in the quarter is shown as a warning, never a block |
| Budget | Ticket spend only: spent, committed (approved, not yet bought), waiting (pending requests), left; a yearly budget with quarters set by approvers |
| Usage | Read only, from the ledger. Credits are drawn per data provider in each provider's own credits; AI is the only thing in dollars. The two are never added or converted |
| Settings | GTM team only (the server refuses everyone else): the ICP and its versions, scoring, titles, lists, data rules, spend limits, connections, team and access |
| Approvals (demo only) | The Slack-style panel |

**Seats are per person.** A seat request is one person asking for their own seat, enforced on the server, with one open or approved request per person per event.

**The uploader runs the paid steps.** The person who uploaded the current attendee list confirms the cost cards on the event page; others see "Waiting on Maya to run this" (see "Who confirms what").

**Settings are GTM-only.** Only the GTM team opens Settings and its write routes.

**Budget is tickets only.** Data provider spend, AI, travel and sponsorship are not in it.

**Usage keeps credits and AI dollars apart** (decision 12).

Visual language, in `docs/SCREENS-BRIEF.md` under "Look and copy": white, forest green, sand and orange, IBM Plex Sans headings and Geist body, no explanatory subtitles, warnings kept inside the data they qualify, and one shared chevron for anything that opens.

## Build order

Slices 1 to 7 each run end to end with `make demo`. Slice 8 adds key-only paths and leaves the demo green.

1. Skeleton, migrations, event stages, Events view, and the layout audit rewritten for these routes. The audit runs on every slice with a screen.
2. CSV mapping, normalization, dedupe, with the messy-file tests.
3. Settings, cost card, approvals, Slack-style panel.
4. Jobs, ledger, tiering with the mock LLM, the eval harness, and the first live recording of the tiering prompts.
5. Discovery, waterfall, double verification, the cap test.
6. Review flagging and its recording, workbook, review import.
7. MCP server, Q&A agent, its recording, evals in CI.
8. Real adapters behind env keys, Slack connected.
9. README in PLAN's order (problem, demo, architecture, decisions, real vs mocked, how to run), ADRs, then the two explainer videos under PLAN's video gate.

**Cut line, if the time box slips:** drop review import, real vendor adapters and live Slack, in that order, and say so under "real vs mocked". MCP and evals are never cut; they are the proof for AI-engineer roles.

**Screen rounds** (`docs/SCREENS-BRIEF.md`): 1 sidebar, routes, personas and Settings access; 2 seats and real events; 3 the Events timeline and side sheet; 4 the event page at volume; 5 Budget and Usage are all built, and a final copy and layout cleanup pass was done 2026-11-09.

**Live demo URL:** none; the repository is not published yet.

**Tiering and enrichment design** (`docs/TIERING-AND-ENRICHMENT.md`): its build-order steps 1 (simulated world), 2 (foundation), 3 (Layer 0, quality report, free title pass), 4 (ICP object, upload and compile, demo ICP), 5 (identity with vendor seams, breakers, throttling detection, CRM by domain) and 6 (firmographics, ICP hard rules, company tier with Unknown, baseline, second look, spread check, re-tier, company-tier evals) 7 (free people search, title parsing, persona tiers, ranking, quotas, title evals), 8 (catch-all probe, reveal, employment check, the verification loop, suppression, vendor guards) and 9 (the server and workbook parts: later case kinds, the Review tab by case, the rich Companies tab, the Other attendees tab, an opt-out route and drop reason, two-card as the default flow) are built. The cases screen, the spread data and the opt-out control on the person panel have screens. Re-tier and the firmographics correction have routes and no screen.

## Copy traps from gtm-backlog

- `ci.yml` smoke step uses the dead `--reset` flag. Use `--demo`.
- `db.ts` coerces numbers by a hardcoded column list. Add every credit and count column, or cap comparisons silently compare strings.
- `events` there is the activity log; here it is the conference, so the log is `activity_log`.
- The audit script hardcodes gtm-backlog's routes and selectors.

## Safety

- `--demo` always uses PGlite and mock vendors, ignoring `DATABASE_URL` and every vendor and model key.
- Sample data reaches a real database only with `SEED_SAMPLE=1`.
- gtm-backlog's nightly reset has no guard. Here, any reset needs `DEMO_RESET=1`. A hosted Supabase project also needs a keep-awake job, separate from any reset.

## Clean-room rule

New code and synthetic data only. No code, data, screenshots or system names from any third party or private source. The Q&A agent is Concierge.

## Not in v1

Sending email or building sequences, a real CRM connection (write-back exists against a simulated CRM only), meeting booking, per-person accounts and roles, multiple workspaces, and LLM column mapping.
