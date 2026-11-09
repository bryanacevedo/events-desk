# Events Desk: project status

**Updated:** 2026-11-09. **Spec:** `docs/SPEC.md`, goldfish-reviewed 2026-11-08 before any code (12 Major, 13 Nit, no Blocker; 24 fixed, 1 moot because a clause gate was closed). It has been edited to match the code since. **Decisions:** `docs/DECISIONS.md`, 1 to 30.

## Where it stands

Build slices 1 to 8 of 9 are done, and the later design work (tiering and enrichment, data hygiene, new registrations, the screen rounds, the Sheet design) is built. Everything runs end to end on simulated vendors and mocks. `make demo` goes from seat request to a delivered Google-Sheet-style workbook. `make ask Q="..."` runs Concierge over its MCP server. Slice 9 is not done: git init, the first CI run, and the two explainer videos.

Checked on 2026-11-09 by running them:

- `npx vitest run`: 824 passed, 1 skipped, 52 files (825 tests).
- `npx tsc --noEmit`: clean.
- `EVALS_STRICT=1 npx vitest run` on the three eval test files: passes, so no recording is stale and CI would not be red on evals.

To resume: run `npx vitest run`, then pick from "Needs Bryan" below.

## Proven and not proven

**Proven, on simulated vendors and fakes.** The whole flow, the money rules (reserve under a row lock, caps, no repeat on an unknown outcome), the email rule, the CRM checks and write-back against a simulated CRM, reuse and the saved log, new registrations and the Sheet refresh against a fake publisher, the Summary checks. Plus two real runs: one real sample workbook published to Google Sheets with `make publish-sample` (2026-11-08; fonts, groups, filter views and sparklines read back through the API), and real model calls for the evals and three for the Summary.

**Not proven.**

- Salesforce: no adapter exists. Live mode uses `noCrm`: no CRM check runs, owner and deal stay blank, nothing is written back. Field names, match quality, limits and the write path are all unknown.
- Slack: signed commands, buttons and messages, on fakes only.
- Apollo: the key on file is on the free plan. `mixed_people/search`, `mixed_people/api_search` and `people/match` returned 403 `API_INACCESSIBLE` on 2026-11-08 and the waterfall cannot be reached, so no real Apollo call has completed. Request and response shapes are from documentation, tested on faked responses. The search-response `linkedin_url` field and the single-person match shape are unconfirmed.
- ZeroBounce: faked responses only.
- Real Postgres: all tests use PGlite (one connection). postgres.js has never run here, bytea storage of original files is proven on PGlite only, and the row lock has not been tested under contention.
- Google beyond the sample: the real delivery path of a delivered event, review sync, whether Drive keeps the hidden contact id and the Decision dropdown, a concurrent edit during a refresh (it is lost), and the consent-screen labels in `docs/GOOGLE-SETUP.md` (written from memory).
- The real website reader (fakes only) and a real model reading an ICP document (the demo uses a deterministic parser for its one document).
- No real Research run has priced a tier call inside the app, so the cost card's AI estimate for tiering is arithmetic, not a measurement (decision 26).
- There is no real login. "Acting as" is self-asserted in every mode. The personal-data GET routes (contacts, workbook, original files and rows, opt-outs) are open. `WRITE_KEY` is one shared key.
- The people-world, email-world and other world tests use authored rates. They show the code copes with those rates, nothing about real data.
- The continuous-integration workflow has never run (nothing pushed yet).

## Real model evals (Opus 5.5, recorded 2026-11-08 and 2026-11-09)

From `node scripts/eval-report.ts` and the title report from the same code. Details and intervals are in the README.

- Company tier, holdout of 68: baseline 54 of 68 (79.4%), ICP rules in code 61 (89.7%), hard rules then model 63 (92.6%, Unknown 5), tier 3 called tier 1: 0. Development set of 120: 118 (98.3%), tuned on. Real public companies (38, labeled from memory): 38 of 38, and the rules alone also get 38 of 38.
- Second look: read 22 holdout companies, disagreed on none, cut (decision 24).
- Title, holdout of 114: keyword baseline 23 (20.2%), rules in code 107 (93.9%), model alone 110 (96.5%), rules then model 113 (99.1%), promoted wrongly 0. **The holdout was looked at when the "Chief Vibes Officer" failure was fixed (decision 25), so this is not a clean held-out figure.**
- Review flagging recall and precision 100% on a synthetic list of 150; Concierge 10 of 10 money questions refused, 10 of 10 right tool. Both lists are author-written.
- Summary perspective: three real calls, $0.06020 in all; 8 of 9 parts passed the checks first time and the ninth was a false rejection, since fixed (decision 27). Too few to call a rate.

## What is built

- **Seats, budget, usage, settings.** Per-person seat requests, approver decisions, Budget (tickets only), Usage (credits per provider in their own units, AI in dollars, "saved" from reuse), Settings for the GTM team only (server enforced), the Events timeline and Overview. Screen rounds 1 to 5 of `docs/SCREENS-BRIEF.md` are done.
- **Intake.** CSV or Excel by signature, mapping in code, Layer 0 distrust of the input, a list quality report, original files kept, a manual event delete that keeps spend counted.
- **ICP.** Upload, compile with a priced estimate, gaps, quote checking, a test bench, publish as a version, pin on Research approval. The ICP page exists. The ICP's Never contact and Existing customer lists join the event's lists, from the pinned version (decision 30).
- **Two cards.** Research card (identity, firmographics, company tier, website read; worst case 5 model calls per company since the second look was cut) and Outreach card (titles, people, reveal, email loop, LinkedIn, review, perspective, Concierge). The uploader confirms. Single-card flow remains for old events and its tests.
- **Tiering.** Hard rules in code, company tier with Unknown and a cited fact, tier cache by domain and ICP version, spread check, re-tier within an allowance, title parsing (rules, then the model), persona tiers, ranking and quotas.
- **Email.** Apollo match, Apollo waterfall by polling, ZeroBounce plus Apollo's Verified, catch-all probe, employment check, vendor guards that pause instead of dropping. Hunter and NeverBounce are gone as direct vendors (decision 23). Attendee-list addresses usually read "Verified once".
- **Reuse.** Stored answers replace paid calls; `reuse_log` shows what was saved.
- **CRM and person record.** Salesforce flag checks that fail closed (simulated CRM only), the `people` table, write-back queue, `preSendCheck` wired to nothing.
- **New registrations.** Top-up as a hidden event, merge in one transaction, Sheet refresh that keeps typed work (decision 29, `tests/new-registrations.test.ts`, 66 tests).
- **Delivery.** Workbook (Summary, Review, Attendees, Prospects, Companies, Other attendees, Meetings, hidden Lists), Google Sheet with a Sheets-API finish, Excel download, Review sync. The Summary opening is model-written and code-checked, with a code-written fallback per part.
- **Concierge.** MCP server and agent, read-only views under a Postgres role with no money columns.
- **Guards.** `REAL_RUN_MAX_ROWS` (default 4) on live runs, `EVALS_MAX_ITEMS` (default 8) on recordings, `LIVE_SPEND=1` needs every key, `--demo` ignores every key.

## Known gaps and open items

- The Event page's AI line still says "estimated at the flat rate" for what a card allows.
- The Outreach card screen does not name the `perspective` step.
- No screen for re-tier or the firmographics correction (routes exist).
- A subsidiary that shares its parent's domain takes the parent's tier. Breaker state is in memory per process. A person's answer to a case does not re-run the CRM read.
- Apollo reports no `business_model`, so the consumer-only hard rule is Unknown on Apollo and only the model's reading of a description can catch a consumer company.
- The website reader cannot stop a public name that resolves to a private address. Run the server where it cannot reach internal hosts.
- A tier prompt asks the model to copy a fact word for word. A model that paraphrases becomes Unknown, which may push the real Unknown rate above the simulated one.
- Live vendor charges are recorded at configured rates, not read from bills. Concierge answers only mapped users and approvers.
- A real outage pauses a CRM check on one failure, with no retry. Whether the shared-address test is right on real lists is unknown.
- Do Not Call blocks calls only, pending Bryan's confirmation. Apollo sequences are not touched by a merge (not built).
- A rep's note on a person no longer on the list goes with the row when a Sheet refreshes.
- ICP reading and its test bench are outside the cards and Usage. Apollo's searches are treated as free, unconfirmed. The AI cap counts calls; its dollars are an estimate.
- An outage mid-tier can repeat that company's completed model calls on resume, inside the cap. A re-tier that moves ICP version does not re-apply the new version's lists (route only, no screen). An opt-out by name does not match a merged spelling.
- A drop typed into a Sheet's Review tab stays visible there until the next rebuild.

## Needs Bryan

- First push, then the first CI run. The first commit is made locally (2026-11-09).
- The two explainer videos: scripts drafted at `~/Documents/Career/github-portfolio/videos/events-desk/SCRIPTS.md`, waiting on his approval before anything is rendered.
- Publish the repository. Real event logos stay in the public version (decided).
- Paid Apollo and a ZeroBounce key, then one real run on a very small list. The waterfall lineup is set in Apollo, and a sample of a few hundred contacts decides it.
- Connect Salesforce when wanted. Confirm Do Not Call.
- The real credit allotment in each vendor's pool, for the Usage page.
- Real Slack: create the app and test signed commands and buttons.
- A fresh title holdout, if the title figure is to be quoted as held out.
- Whether the Summary's 1-cent AI rate should change once a real Research run is priced.

## History

- 2026-11-08: slices 1 to 8; first real eval recording; workbook redesign; Excel upload and Google Sheet delivery; tiering and enrichment steps 1 to 9; the simulated world and spend guard; seat requests, Budget, Usage, Settings and the new shell. Two fresh reviewers checked the README and the code, and all reproduced bugs were fixed with tests.
- 2026-11-09, late: Google app in production, home and privacy pages live, sample Sheet public to view. Two goldfish reviews of the whole system; every code defect they named fixed or disclosed (decision 30, `tests/goldfish-fixes.test.ts`).
- 2026-11-09: screen rounds 1 to 5 and a cleanup pass; Sheet design passes 1 and 2 (decisions 18 to 20); original files and event delete (21); model-written Summary (22); Apollo and ZeroBounce only, with reuse and saved credits (23); real re-recording of the evals, second look cut (24); title gate (25); AI priced from tokens (26); Summary retest (27); Salesforce checks, person record and write-back on a simulated CRM (28); new registrations (29). The simulated wrong-priority-A floor moved from 20% to 25% (decision 27).
