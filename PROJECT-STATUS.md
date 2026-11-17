# Events Desk: project status

**Updated:** 2026-11-17. **Decisions:** `docs/DECISIONS.md`, 1 to 108. **Render:** auto-deploy is off on the service (verified through the Render API on 2026-11-16, read-only); a push deploys nothing and a deploy happens only when Bryan says. `render.yaml` does not say so: the setting lives on the Render service, where auto-deploy was turned off because the monthly build minutes ran out; nothing in this repository changes it. The last Events Desk deploy, on 2026-11-15, ended build_failed, so the live demo at https://events-desk.onrender.com lags `main`; no live commit is claimed here.

Docs are part of done: README, PROJECT-STATUS and docs change in the same commit as the behaviour, counts or setup they describe. `make docs-check` (also run by the suite) enforces it.

## Simulation fixes: first paint, the sample's own words, plan decisions without Slack (2026-11-17, branch `simfix/events-desk`)

Worktree `.wt/simfix-events-desk`, from `origin/main` 216c0fe, not pushed. Decisions 104 to 108, migration 0062. From the first-visit review (`workday-sim-plan/runs/s4/demo-user/SYNTHESIS.txt`) and the S5 review (`runs/s5/REVIEW.txt`).

**Built:** a grey shell in `index.html`; the app draws before `/api/health` answers; every page is its own file; open cases in one read (`GET /api/cases/open`); scripts compressed and cached for a year; skeletons for every wait, and a settle of 120 ms for a page change (decision 106). A slim demo bar, a first screen with one sentence, one first step and a tour of two short lists, tools named by their job in the sample, a glossary, empty places with an example, "Request a seat" made quiet, contrast measured by `scripts/contrast.mjs` (decision 107). Plan decisions in the app when there is no Slack (104); a planner closes plan against actual, and Results lists it (105); the last target import kept (108). Small fixes: the scanner's person under its own key, a line saying who a seat request went to, drop reasons at the quoted stage, the waiting plan and abstract under Needs me now, the scanner link before delivery, focus into the Request a seat dialog, a stacked timeline under 1000 px so a long title cannot print over the status, "Declined" and "Scored" said one way, booth meetings and people met told apart, a booked meeting whose time has passed no longer "coming up", one row for the event the seed made twice.

**Review fixes, 2026-11-17 (fresh diff review of 0b0d79f):** a missing `/assets/` file is a 404 and never `index.html` with a year-long cache (`src/server/static.ts`, tested by `tests/static-files.test.ts`); `/` now gets `no-cache` and compression like a deep link; a page file that fails after a deploy reloads the tab once (`src/app/ChunkGuard.tsx`), then shows a Reload button instead of a blank app. "Close the result" shows only when the server accepts it (motion `none`; decision 105 reworded to say so, and the plan read carries `event.motion`). Tests added: no decision route with Slack connected, a second decision refused. Decision 104 says the decider is the self-declared name. Skipped count on the last import is rows less added less updated (the kept list is capped at 200). Meetings "coming up" count from the sample day in the demo. One existing test changed, not weakened: the source check in `tests/simfix.test.ts` ("sends the scripts compressed and cacheable") reads `src/server/static.ts` where the middleware moved, and asserts `mountStatic(api)` in `node.ts`.

**Not proven:** the 3 to 18 second blanks on the live demo were not reproduced (the sandbox cannot reach it); locally every read answers in under 100 ms, so the fix removes the stacked waits that could be measured (uncompressed 720 kB, no cache header, a gate on `/api/health`, about 15 reads before the first paint) and nothing more is claimed. The new screens were looked at in the browser pane at 800 and 390 px only where noted in the report. New screen sentences are in `docs/SCREEN-COPY.txt` for Bryan to read.

## Sim mode and in-app seat decisions (2026-11-17, branch `product/events`)

Sim mode (decision 102): `SIM_DB_GUARD=1` plus `SIM_MODE=1` builds the simulated vendors and the demo lifecycle over a simulation `DATABASE_URL`; off by default, refuses beside `LIVE_SPEND`, `LIVE_SEND` or a transactional sender, or without the guard. Seat decisions in the app (decision 103): `/seat-decisions` for approvers, the same `decideSeat` as Slack, a second decision refused. Tests `tests/sim-mode.test.ts` and `tests/seat-decisions.test.ts`. Not verified: a real start of `node.ts` over Neon (sim mode was tested through `resolveMode`, `buildSim` and `createApp`), and the new screen in a browser. Not pushed or deployed.

## S6 public doc pass (2026-11-17, bl_144)

README checked claim by claim against the code after `daaa27f`. Corrected: the assessment eval now reports the re-recording (19 of 19, in-sample, after the `download` question was reworded) instead of the first 16 of 19; the body limit names the 4 MB frame route; the sample data paragraph says the conferences also come from the shared world's `events.csv` and that the webinars, dinners and both sellers (Orrery, Lumen Ledger) are invented. Every README link answered 200 on 2026-11-17. Hygiene: a former-employer name in `docs/HOSTED.md` and a local credential path in this file removed. Docs only, no code changed.

## S4 standalone-day review fixes (2026-11-17)

Worktree `.wt/s4-events-desk`, branch `s4/standalone`. From the fresh review of the standalone persona day (`workday-sim-plan/runs/s4/events/review.txt`), only the items it marked small and safe. Fixed: no Approve, Approve again or Decline button where the plan decision route does not exist (the screen says where decisions are taken, from `/api/health.decisions`: panel, slack or none); Choosing and Results wait with "Loading." while the planners load instead of showing a refusal, and Choosing says it could not load when its reads fail; planners see Results in the menu (decision 54); a loading line on the app shell, the event page, Plan, Overview, Events, My day and Choosing; Outreach, the Scanner and My day say "not available on this desk" once their read has finished with nothing, instead of staying blank or "Loading" forever; the plan read runs its independent queries together instead of one after another. Stale doc line about the Slack plan card corrected. New screen sentences are in `docs/SCREEN-COPY.txt` for Bryan to read. Not built, because they are product decisions: the simulation mode over a real database, and a seat and plan approval path without Slack.

## S2b: docs never stale (2026-11-17)

README refreshed (no test counts, migration range, stray Choosing paragraph made a section, deploys are manual); `.env.example` lists the 15 variables it was missing and 9 developer or internal ones are on the gate's allowlist; stale lines about Render and the decision range corrected; one superseded decision annotated. Docs gate `scripts/docs-check.mjs` with `tests/docs-check.test.ts` and `make docs-check`; a pre-push hook is proposed in `docs/PRE-PUSH-HOOK.md`, not installed. Left as they are, by rule: decisions 50 to 57 sit out of numeric order in `docs/DECISIONS.md` and decision 83 is dated before 81.

## Redesign step 7: before the list, and choosing events (2026-11-15)

Worktree `.wt/ev7-events-desk`, branch `ev7/before-the-list`. Spec `docs/CHOOSING.md` (goldfish-reviewed by a fresh Opus agent before code: 2 Blockers, 12 Majors, all fixed in the spec), decisions 96 to 101, migration 0061. Not deployed: auto-deploy is off on Render and a deploy happens only when Bryan says.

**Built:** target accounts read and matched against pasted or uploaded speaker and sponsor pages (code, with the line quoted; a wrong match is rejected with a reason, held per conference), earlier editions' lists and people already captured; the meeting goal tracker in the Plan tab's Goal (by rep, who has nothing booked, one held figure with the Result); the Choosing page (leadership, GTM, planners) ranking candidates by a printed rule from overlap, cost and last edition's return; which events to repeat with Fisher exact, Bonferroni over the pairs looked at, "too few to say" under 5 a side, a Repeat or Drop decision with a reason; a model step `repeat_word` that words passing patterns, checked in code, template in the demo. Accounts met now counts the team's target list when it has one (caption says the basis).

**Demo (day 2026-11-24):** 156 target accounts, two sample pages, SaaStr link, two sample catalog rows (Money20/20 USA 2027, Dreamforce 2027) so past return and "below the median" show, GITEX Global 2026 with a goal of 20 and 7 booked meetings, Money20/20 USA 2026 read after the event (held 10 of 16, by rep). Which events to repeat reads "too few to say" (2 scored events): honest, not seeded otherwise.

**Not proven:** `repeat_word` against a real model (the demo and tests use the simulated one, marked template); a real speaker or sponsor page; PDFs are not read. Money20/20 USA 2026's accounts met reads 0 of 10 from the target list, because the demo's met companies are not on the world's list (shown honestly with its basis).

**Hand-off:** unblocks step 8 (ready for a real team). Open: whether the Choosing page should also sit in the Plan tab's Audience.

## Redesign step 6, part 4 of 4: the four-desk rehearsal, the real calls, the snapshot, the film notes (2026-11-15)

Worktree `.wt/ev6p4-events-desk`, branch `ev6p4/part4`. Spec `docs/SHARED-WORLD.md` section 14 (goldfish-reviewed by a fresh Opus agent before code: 1 Blocker, 8 Majors, 6 Nits, all in 14.10), 14.11 (what was built), decision 95, `docs/FILM-NOTES.md`. Not deployed: auto-deploy is off on Render and a deploy happens only when Bryan says.

**Built:** `scripts/rehearse.ts` and `src/server/journal-fetch.ts` (Events Desk's own sweep and outbox run against a live CRM Desk, every write journaled without the key); lumen-world `stage/rehearse.py` step 7b, audit check 10, `stage/wire.py` (real HTTP between the three servers) and `stage/contract.py`; CRM Desk's replay learns the `events_desk` actor and a fifth key; Account Desk reads Events Desk in its own job (`crm_members`); a test of the key compare (`tests/desk-read.test.ts`); `tests/journal-fetch.test.ts`; the demo snapshot rebuilt on world 1.3.0.

**Checked by running (2026-11-15):** full suite `npx vitest run --testTimeout=60000` 1,825 passed, 14 skipped; `tsc --noEmit` clean; design-lint and the suite's design-lint test pass; layout audit and interaction audit pass on a fresh server (the interaction audit needs the demo motion to finish, about two minutes after start; run at once it reports "Event reply: nothing to open"); the rebuilt snapshot opens (49 events, the side dinner, `/api/health` ok). Four-desk rehearsal `stage/rehearse.py --verify`: 22,989 steps (481 from Events Desk: 14 campaigns, 388 member writes, 1 meeting and 1 send; non-deterministic then, the deterministic count is 22,987 and 479, below), CRM Desk identical on 7 checks, Market Desk on 1, Account Desk on 4. `stage/audit.py`: 10 of 10. `stage/wire.py`: 11 of 11 (booking link read over HTTP, targeted members become signals, a decline stops the play, the play status read back in words, wrong key refused). CRM Desk contract tests against a live CRM Desk: Events Desk's 7 passed, Account Desk's `test_crm_contract.py` passed (none skipped).

**Not proven or not done:** (1) [Since delivered 2026-11-16: the four-desk journals are on the desks' mains.] At the time the rehearsal's regenerated journals were NOT delivered to the desks' `world/` folders or committed: Account Desk's coverage gate on a build from them shows 1 scenario missing ("set aside and still set aside", a chance scenario; the committed journal gives 0 missing). They are kept in `~/Developer/.wt/ev6p4-journals/` with the run's log. Decision for Bryan below. (2) Almost no activities reach the CRM from the rehearsal (the demo's sends and replies come from the demo pipeline; see 14.11 item 1). (3) Nothing is sent; no play ran for days. (4) The world clock is not moved (Events Desk's date stays 2026-11-24, `current_date` in SQL is still the wall clock). (5) `npm ci` in the main checkout ran, but that checkout was on an old commit whose lockfile lacked satori, resvg and zxing. Done 2026-11-16: the main checkout was fast-forwarded to origin/main and `npm ci` ran.

**Hand-off:** step 7. Open: whether to deliver the four-desk journals (and tune or accept Account Desk's chance scenario), Market Desk's tier replacing the priority-or-tier rule (cross-repo item 11).

## Redesign step 6, part 3 of 4: the world additions, targeted members, the held statuses, the panel (2026-11-15)

Worktree `.wt/ev6d-events-desk`, branch `ev6d/part3` (on main). Spec `docs/SHARED-WORLD.md` section 13 (goldfish-reviewed, 13.9) and 13.10 (what was built and where it differs). Decisions 91 to 94, migration 0060. Commits: adapter and sweep, world loading, the panel.

**Built:** `Crm.features()` and the typed `unknown_status` error; the three statuses (targeted, waitlist, declined) in the sweep with the order, the 45 day lead window, the cap of 500, barred counts, no leads; outbox status `held` (released on a change in the CRM's list and daily, superseded, erased); stored-status check; `GET /api/integration` counts; lumen-world 1.3.0 vendored by `scripts/world-refresh.mjs`; `seed-world.ts` (the demo's default, `WORLD=lumen`, today 2026-11-24); the Outreach panel's booking link, counts and play status; `GET /api/desk/campaigns/<crm campaign id>` for Account Desk. Tests `member-statuses`, `world-load`, `desk-read`, `integration-2b`. No existing test changed except the pin in `shared-world-part2` and one assertion there (waitlist is now a meaning).

**Not proven:** a real round trip with CRM Desk (the contract tests skip without a running CRM) or with Account Desk (a stand-in server answers the plays read); the lumen-world release was built in a scratch directory from the tagged worktree, not from a pushed tag; the panel was looked at in a browser with its two reads patched in the page (the demo's stand-in CRM writes no members, so counts are zero there); the full week's behaviour of the sweep on 2026-11-24 data against a live CRM.

**Hand-off for part 4 (the four-desk rehearsal):** (1) Events Desk journal steps in lumen-world `stage/rehearse.py` (targeted, registered, declined, attended, with the dinner's guests from `events_desk_guests.csv`); (2) run all four desks together with `INTEGRATED_WITH=account_desk,market_desk,crm_desk`, `CRM=crmdesk`, `DESK_READ_KEY`, `ACCOUNT_DESK_URL`, `ACCOUNT_DESK_READ_KEY`, and check the booking link reaches Account Desk's drafts and a declined person's play stops; (3) `make demo-snapshot` on the world build (it now seeds the world, so rebuild the snapshot); (4) film notes. Needs from the other repos: Account Desk part 3 on main (the `/api/desk/campaigns/<ref>/plays` read and the `event_pre_event` play), lumen-world v1.3.0 pushed and pinned by the other desks. Open: the old seed's duplicate Money20/20 Europe 2027 event (decision 91); whether Market Desk's tier should replace the priority-or-tier rule (cross-repo item 11).

**Environment note:** this worktree's `node_modules` points at `.wt/view-events-desk/node_modules` because the main checkout's lacks satori, `@resvg/resvg-js` and `zxing-wasm` (offline); `npm ci` fixes it. Without them `tsc` and the suites that import the social kit fail.

## Redesign step 6, part 2 of 4: member, activity and money writes, the world read (2026-11-15)

Worktree `.wt/ev6c-events-desk`, branch `ev6c/shared-world-2`. Spec `docs/SHARED-WORLD.md` sections 12 (goldfish-reviewed by a fresh Opus agent before code: 1 Blocker, 10 Majors, 12 Nits, all in 12.8), decisions 88 to 90, migration 0059. Needs from other repos: `~/Developer/events-rethink/steps/step-6-cross-repo.md` (items 12 to 15 added).

**Built:** `src/server/crm-sync.ts`, a sweep from state before each outbox drain: one member per event and address with the highest status (sequence number in the key, so an undone check-in is sent), meetings (create, then a status update that waits), sends, matched replies, accepted debrief quotes; the event campaign queued for any event with someone to write; a member row waits without an attempt and an alert rises after 24 hours; the CRM's echo of our own meetings is skipped; erasure now reaches guests and `crm_sync`; `no_show` mapped and an unknown status throws; one drain at a time; `publishAll` at boot; TRUNCATE guard; CRM Desk's own hash fixture; per-row DESIGN 2b table test with a coverage gate (`tests/integration-2b.test.ts`); `GET /api/world` reading the pinned lumen-world events_desk slice (`samples/lumen-world`, commit 400566a, hashes checked; re-pinned to a008e18, v1.3.0, in part 3). Tests `crm-sync`, `shared-world-part2`, `integration-2b`.

**Built and off:** campaign money (`CRM_CAMPAIGN_MONEY=usd`). CRM Desk has no budget or actual cost fields on campaigns at all (checked), so it stays off until its item 7 adds them hidden from members.

**Not built:** Targeted, Waitlist and Declined are counted, not sent (part 3, needs CRM Desk). Market Desk's ICP and tier are not read (cross-repo item 11 unanswered). The world's events are not loaded as the demo's events (part 3, with the additions). A reschedule does not change the CRM meeting. `calendar_event_id` is not sent (not in CRM Desk's docs on main).

**Live check pending Render build minutes.** Pushed to main without waiting on a deploy; live stays on the last good build until Bryan fixes billing.

**Hand-off for part 3:** release held statuses once CRM Desk carries them (remove them from the sweep's skip list in `crm-sync.ts`), the target-accounts trigger, the world additions, and the deferral panel's counts and play status. Part 4: rehearsal, demo snapshot, film notes.

## Redesign step 6, part 1 of 4: into the shared world (2026-11-15)

Worktree `.wt/ev6b-events-desk`, branch `ev6b/shared-world`. Spec `docs/SHARED-WORLD.md` (goldfish-reviewed by a fresh Opus agent before code: 2 Blockers, 8 Majors, 13 Nits, all handled in section 11). Decisions 84 to 87, migration 0058. Needs from other repos: `~/Developer/events-rethink/steps/step-6-cross-repo.md`.

**Built in part 1:** Bryan's Overview move (date cards then the seat bar at the top of all three layouts), "Meeting held", the tagline "Event-led pipeline" (decision 84); `INTEGRATED_WITH` real (`src/server/integration.ts`, `GET /api/integration`, 409 on the closed routes, `launchAllowed` and card confirmation gated); the deferral panel on the Outreach tab (direction A of three, provisional); campaign type and a parent for hosted side events; `GET /api/definitions` publishing `campaign_member_statuses`. Tests `tests/integration.test.ts`.

**Hand-off for part 2 (a fresh session, same worktree or a new one from origin/main):**
1. Write `docs/SHARED-WORLD.md` part 2 spec first, goldfish it, then build: queue every member status where it happens (guest status changes, registrations, check-in, no-show) keyed `cm:<event>:<contact>:<status>`; call `queueCampaign` at plan confirmation; meeting activities as create then PATCH; send activities from `ingestEvents`; debrief activities (quote, not model text); campaign money (needs CRM Desk item 7 first, a currency decision, one row per event).
2. Read the shared world from a pinned `lumen-world` commit (18 events, roster, Lumen Ledger as seller), Market Desk's ICP and the tier from the record, the fixed demo clock, the coverage gate.
3. The tests that were left out of part 1: member, activity and money tests, and the per-row DESIGN 2b table (`tests/integration-2b.test.ts`; part 1 has the route-level proof only).
4. Counts, booking link and play status on the deferral panel.
5. From the Opus code review, not done: a member row must wait (no attempt counted) while its event's own campaign row is still queued, and an alert when a child waits over 24 hours; call `publishAll` at boot; add a fixture hash from CRM Desk's own test to `tests/integration.test.ts`; a TRUNCATE guard on `definition_versions`; `/motion/checklist`, `/campaign` and `/release` are closed for sequences drafted before the setting (decide whether those should stay open for events already started).

**Open for Bryan:** direction A of the deferral panel is provisional.

## Redesign step 6, session 1: the Overview layout choice (2026-11-15)

Worktree `.wt/ev6-events-desk`, branch `ev6/overview-views`. Decisions 81 and 82, migration 0057.

**Step 5 live check (2026-11-15):** Render deploy `dep-dbspm3nf3r2c73elp0h0` is live on `79c46d7`; `/api/health` answers; Overview, Speaking and an event page load at 1440 and 375 with no sideways scroll and no console errors (screenshots in `~/Developer/events-desk-review/step5/live/`). The old `.wt/ev5-events-desk` worktree and branch `ev5/speaking` are removed.

**Built:** the Overview in three layouts, A ledger, B trays (the default), C timeline, a per-person choice kept on the server, with a quiet switcher in the page header. Tests `tests/overview-views.test.ts`; the layout audit measures all three, the interaction audit checks the pick.

**Bryan's picks, recorded (decision 82):** email gate stays, sponsorship kit offer stays, Get the attendee list C, Scanner tab B, phone scanner A (a B rebuild was started and dropped; nothing of it is in the code).

**Prompt caching (bl_117) brought in:** the three `cache/prompt-caching` commits are cherry-picked onto this branch (its DECISIONS entry is now 83, its marker test `tests/prompt-cache.test.ts` kept). Its measured numbers are from 2026-11-14 real calls on the same code (about 90% lower input cost once warm); the re-measure Bryan asked for was not repeated in this session, no new spend.

**Review:** an Opus review of the Overview diff found a squeezed timeline week when nothing is late, an optimistic pick that could be overwritten or lost on a failed save, hidden money labels on desktop and a bar that overflowed at year end; all four are fixed.

**Landed:** `39623c0` on `main`, deploy live 2026-11-15. Live check at 1440 and 375: all three layouts open, no sideways scroll, no console errors (`~/Developer/events-desk-review/step6/live/`). The full suite passes with `--testTimeout=60000` (1,695 passed, 14 skipped); at the default 5 s the heavy workbook tests time out when the machine is busy.

**Not done:** step 6 itself (into the shared world: SPEC, goldfish review, three directions, build) has not been started (done later: parts 1 to 4, sections above); it is 4 to 5 sessions by its own brief and the context of this session was spent. It needs a fresh session, which also owns the Account Desk and CRM Desk agreements it names.

## Redesign step 5, speaking and the social kit (2026-11-14)

Worktree `.wt/ev5-events-desk`, branch `ev5/speaking`. Spec `docs/SPEAKING.md`, decisions 74 to 80, migration 0056. Baseline before the work: the full suite was green (the Chrome tests need the sandbox off here).

**Built:** calls for papers per event with the model proposing from a page and the person adding; the talk with its states and the two-person approvals (CHECKs in the database); scan credit and a Talks part in the Result; the kit (offers fired by seat approval, talk accepted, hosted or sponsorship confirmed; photo from upload or Slack on tap; organizer kit; six PNGs by Satori and Resvg; template captions; post link pasted back; posting counts). Screens: the Speaking page, the talk section in the Plan tab, the kit sheet, a Kits ledger on My day, a "From the session" pick on the phone scanner. Design: three directions in `~/Developer/events-desk-review/step5/`, A with C's kit sheet built provisionally.

**Not proven, for Bryan:** the Slack photo against a real workspace (tested with a stand-in; the scope `users.profile:read` is needed); the real model reading a real call page (the demo and tests use the simulated reader); the organizer's real kit assets; whether the LinkedIn post sizes are right (only the banner is LinkedIn's own figure).

## Redesign step 4, the directory extension and the screen recording (2026-11-14)

Worktree `.wt/ev4-events-desk`, branch `ev4/extension`. Spec `docs/DIRECTORY.md` (section 13 holds the goldfish fixes), decisions 69 to 73, migration 0055.

**Built:** a Chrome extension (`extension/`, Manifest V3, loaded unpacked; permissions activeTab, scripting, storage; no content scripts, no cookies; the reader is injected only when the person presses Read) with a Swapcard reader that finds a person from the profile link, never from class names, and says "layout unknown" when a matched page yields nothing. Capture keys made in Settings (hashed, shown once, scope add_people only, Bearer on two routes). Reads are staged with a source sentence and the event's terms note built by the server, judged by one pure function into staged or to check, and brought in through `ingestUpload` and Layer 0 with per-person `list_source`, `read_note` and `read_terms`. Screen recording: frames are taken in the browser (the video never leaves the computer), each read by the model once (counted before the call, capped, never repeated), checked in code against its own transcription. Panel "Get the attendee list" with the four paths in Bryan's order, a To check list, and Settings "Browser extension". Erasure and a 90-day purge reach reads.

**Outreach rule (Bryan, 2026-11-14):** by country, never by source. The one gate edit: `country_blocked` on email for IT, CH, SE, DK, BE, AT, NO and DE (config list), for everyone. **This changes an existing rule:** before, only hosted guests read that list. The demo records a basis for every region, so German, Italian and Danish demo people no longer get email. Not run against live data from here; count live contacts it would touch with: contacts whose last comma part of `person_location`, or `companies.firmo->>'country'`, normalizes to a blocked code and who are in or eligible for an email sequence. **Risk: legal.** Swapcard's terms bar collecting other users' data without consent; counsel confirms before live use.

**Design:** three directions in `~/Developer/events-desk-review/step4/directions/` (A Walkthrough, B Ledger, C Sheets). C built provisionally.

**Vision eval** (`evals/recordings/directory_read.json`, claude-opus-5-5, 8 synthetic frames, $0.185): 35 of 40 people found, names exact 35 of 35, no wrong company, no invented person, the instruction line in a frame was not followed but one person's title was read as that text (so it goes to check), one reply came back in a code fence (now parsed). In-sample on a fake app; floors widened after seeing the run, noted in the code.

**Not proven, for Bryan:** loading the extension in your Chrome on a real Swapcard directory (the fixtures are reconstructions from Swapcard's public patterns, not captures; selectors may need one real capture); a real phone screen recording; the toolbar press and the host-permission prompt (automation cannot click them). Adding directory people to a delivered list is not built. Brella, Grip, Whova and Cvent readers are later.

## Redesign step 3, the scanner (2026-11-14)

Worktree `.wt/ev3`, branch `ev3`. Spec `docs/SCANNER.md` (sections 14 and 18 hold the two goldfish reviews' fixes, 16 the build's deviations, 17 what is not proven), decisions 63 to 68, migration 0054.

**Built:** a phone web app at `/scan/<event id>`: camera first, badge codes decoded on the phone (the browser's own decoder, or a WebAssembly one in a worker, from the app's own files), photo of a badge or card (read by the model, every field it doubted marked "check", a person confirms), typing; one screen after the scan (hot, warm or cold, the event's qualifiers, a note, what we promised and who sends it, next step and date, consent off by default with the notice and its version); an IndexedDB queue with a client id per scan, sync while the app is open (load, online, return, every 30 seconds, button), an idempotent POST, photos in resumable pieces, an unsynced count on every screen, CSV export, a day's-end prompt, and a service worker that keeps the app shell. The desk side: dedupe (registrant id, email, LinkedIn, name at the company; near matches to a review list; two reps, one person, two scans), the person to the scanning rep with a CRM task (hot the same day, naming the account owner), the promise to its owner as a task, consent on the scan and the person, erasure reaching scans and photos, the organizer adapter (Swapcard, tested against its documented responses and a fake), the Scanner tab on the event (ledger, median seconds per rep, reads used, setup and review in side sheets, QR code). Directions: `~/Developer/events-desk-review/step3/scan-directions/` (A built) and `scanner-tab-directions/` (B built), provisional until Bryan picks.

**Landed:** `df2198d` on `main` (with `9b97fac`, the assessment leftovers). **Live check, 2026-11-14:** Render deployed it; on https://events-desk.onrender.com the Scanner tab (12 seeded scans, one near match open), the Tokyo empty state, the phone scanner (camera, Today, typing), the QR code, the manifest and `scan-assets.json` all load at 1440 and 375 (screenshots in `~/Developer/events-desk-review/step3/live/`). The offline scan was not run against the public demo (it would write scans into it).

**Gates, 2026-11-14:** full suite 1,481 passed and 14 skipped; `tsc`, design-lint (now also scanning `src/scan`) and screen-copy clean; both audits against the demo built from the new snapshot (the layout audit now measures the Scanner tab and the phone scanner; against a freshly seeded `make demo` the interaction audit's My day check can fail, because that seeding is not deterministic run to run, which is also true on `main`); Playwright end to end with a fake camera on both decoders: badge scanned offline, card photographed offline, back online, both arrived once with consent stored. Two goldfish reviews by Opus 5.5 (spec, then spec against code); every Blocker and Major fixed.

**Assessment leftovers (decision 68):** `assessment_propose` is in the strict stale check, and the `download` question now says whose download it asks about. Re-recorded with the real model (claude-opus-5-5, 7 calls, $0.07): 19 of 19 labelled answers (was 16 of 19). It is an in-sample number (the wording was written after seeing the misses on these pages), so it shows the two failures are fixed, not that the question generalises.

**Not proven, for Bryan:** the manual test on two real phones (iPhone Safari and home-screen, Android Chrome): airplane-mode scan, then one sync. Chrome on a Mac proves the queue, the decoders and the sync; WebKit's home-screen camera bugs are open and the app's fallbacks (Safari, the photo picker, typing) are untried on a phone. A real vision read of a real card is untried and its accuracy unmeasured. A live Swapcard call waits for a show that enables it. The ten-second target is unmeasured. **Risk: legal.** The consent wording is a default, and counsel confirms before any live use and before marketing to EU people from a scan.

## Redesign step 2, hosted events (2026-11-14)

Worktree `.wt/ev2`, branch `ev2`. Spec `docs/HOSTED.md` (section 21 holds the goldfish fixes, 23 and 24 the build's deviations), decisions 58 to 61, migration 0053.

**Built:** guest list (target accounts, nominations, Luma and Splash CSV), personal invitations drafted and logged (the desk never sends them), the public RSVP link (192-bit token, one 404 for every bad link), waitlist under a row lock, reminders and seat-open mail only to registered guests from a transactional sender that does not depend on the sequencer, expected no-shows (20 percent default, your own history after two closed dinners), venue minimum, guarantee and cancellation steps (into the week's deadlines), phone check-in with walk-ins and undo, closing attendance into attended and no-show follow-up groups with owners' notes, co-host split and lead rule. Screens: Guests tab, check-in, public RSVP, hosted Result, My day guests. Directions in `~/Developer/events-desk-review/step2/` (recommended ones built provisionally: guests B, check-in C, RSVP B). Orrery customer dinner in Lisbon is now a hosted plan. The demo's Money20/20 "$0 of $800,000" was a reading error (an unread pipeline printed as $0); it now says not read.

**Gates:** full suite 1,427 passed, 12 skipped; tsc, design-lint, screen-copy clean; both audits pass against the demo; two goldfish reviews (spec, then spec against code), every Major fixed.

**Open:** the live transactional sender is unproven against a provider; `assessment_propose` has a real-model recording (2026-11-14) and is scored, 16 of 19 labelled answers matched, `download` is the weak question; CRM account fill for target accounts waits for step 7; Bryan picks the three direction sets.

## Redesign step 2, server side (2026-11-14)

Worktree `.wt/ev2`, branch `ev2`. Spec `docs/HOSTED.md` (what was built and where it differs: section 23), migration 0053.

**Built:** guest lists with one owner each, invitations drafted from a template and logged when the host sends them, the public RSVP link (one 404 for every bad token, 30 bad tokens a minute per address), waitlist and promotion under a row lock, reminders and logistics from a transactional sender that does not depend on the sequencer, country rules, expected no-shows (default, set, history), venue dates in the week's deadlines, check-in with walk-ins and undo, closing attendance, the two follow-up groups with the owners' notes, co-host split and lead rule, Luma and Splash imports, target accounts and suggestions, and the demo's dinners. Also fixed: a goal's pipeline line no longer reads "$0 of $800,000" when the scorecard had no CRM.

**Client side (2026-11-14, provisional directions):** the Guests tab (guests direction B), Check-in at `/event/<id>#check-in` (check-in direction C), the public RSVP page at `/rsvp/<token>` (RSVP direction B, its own entry in `main.tsx`), the hosted Result tab with Close attendance, and My day's guests. Built from the recommended directions before Bryan chose; `docs/HOSTED.md` section 24 lists where the screens differ from the spec.

**Open:** the live transactional sender is not proven against a provider; the CRM fill of target accounts is step 7; the demo snapshot needs rebuilding (`make demo-snapshot`) to carry the new dinners.

## Redesign step 1, finished (2026-11-14)

Worktree `.wt/ev1b`, branch `ev1b`. Spec `docs/EVENT-PLAN.md` (progress and deviations in section 18), decisions 47 to 57.

**Built since session 2:** the live-mode Slack plan card (Approve and Decline, approver mapped through `userMap`, never the maker); sponsorship with its package, the standard eight deliverables and promised against received (0050); `list_source` on every upload, row and person (0051); Overview "This week" and "The year" (Direction A, provisional); the assessment with quoted evidence, the organizer request email (drafted from a template, copied and sent by the person, expected date and follow-up tracked) and past events read against their goals (0052); the demo seed (AWS re:Invent 2026 in flight with deliverables late, today and this week; Money20/20 USA 2026 and Dreamforce 2026 read against goals; a late GITEX follow-up; re:Invent's list "emailed by the organizer"); `restampDemoPlan` keeps those dates true on any day; README plan section.

**Gates, 2026-11-14:** full suite 1,342 passed, 12 skipped, no timeouts; `tsc` clean; design-lint and screen-copy clean; both audits against the demo (see the ship notes).

**Open:**
- The assessment step was recorded from the real model on 2026-11-14 (`evals/recordings/assessment_propose.json`, claude-opus-5-5, 7 calls, $0.06) and is scored against the hand labels by `src/evals/assessment.ts` (`tests/assessment-evals.test.ts`, `node scripts/eval-report.ts`): 16 of 19 labelled answers, floors per question, no invented quote, injection page clean. The demo, the seed and the logic tests replay the hand-labelled recording (`evals/assessment.hand-recording.json`), never the real one. Re-record after any prompt change: `LIVE_SPEND=1 EVALS_MAX_ITEMS=7 node scripts/record-evals.ts assessment_propose`.
- Bryan picks one of three Overview directions (`~/Developer/events-desk-review/step1/overview-directions/index.html`); A is built provisionally.
- The re:Invent assessment answers are marked sample answers, not facts about the organizer.
- Orrery customer dinner, Lisbon, was a pending seat suggestion; step 2 made it a hosted plan.
- Money20/20 USA 2026 and Dreamforce 2026 now end scored in the demo.

## Redesign step 1, session 2 (2026-11-14): leftovers done

Worktree `~/Developer/events-desk/.claude/worktrees/admiring-kepler-c6dcf2`, branch `claude/admiring-kepler-c6dcf2`. Spec `docs/EVENT-PLAN.md` (progress in section 18), decisions 47 to 50, 54 to 56.

**Done on top of session 1:** the New plan form (Events, planners: a listed conference, one not listed, or a hosted event); in-place editing on the Plan tab for planners (reason, goal, budget lines one at a time, who goes, ways of taking part); Decline with a reason for the approver; `can_plan` on the plan read and `planners` in the client's needs; the demo's in-flight plan is AWS re:Invent 2026, written onto the existing paused event that holds its list and twelve seats (decision 55); demo snapshot rebuilt; `tests/plan-edit-decline-seed.test.ts`. Full suite 1,241 passed, 12 skipped; the one failure was the new seed test timing out under load (5 s limit, 7 s alone), now given 60 s and passing. tsc, design-lint, screen-copy and both audits clean.

**Not done (next, in order; done since, see 'Redesign step 1, finished'):** live-mode Slack plan card; sponsorship, deliverables, `list_source`, Overview year plan and week's deadlines (0050, 0051, session 2 of the original plan); the assessment, organizer request, past events read against their goals, the Money20/20 USA 2026 seed (0052, session 3); a seed test for those; README for the plan. re:Invent's upload source "emailed by the organizer" waits for 0051.

**Spec:** `docs/SPEC.md`, goldfish-reviewed 2026-11-08 before any code (12 Major, 13 Nit, no Blocker; 24 fixed, 1 moot because a clause gate was closed). It has been edited to match the code since. **Decisions:** `docs/DECISIONS.md`, 1 to 108.

## Now (2026-11-12)

- `main` holds the upgrade below and the CRM switch. (Corrected 2026-11-17: Render auto-deploy is OFF, verified through the Render API on 2026-11-16, so a push deploys nothing; the earlier 2026-11-12 line about automatic deploys was wrong.) Checked live on 2026-11-12: the upgrade's security headers and the sidebar tagline "From the seat to the result" (83ea0fa) are on https://events-desk.onrender.com. The CRM switch (dfc9bc8) was not checked on the live site; it changes nothing while `CRM` is unset.
- CRM switch (decision 46): `CRM` unset keeps today's CRM (`simCrm` in the demo, `noCrm` live); `CRM=crmdesk` uses CRM Desk through `src/server/crm-desk.ts` with `CRM_DESK_URL` and `CRM_DESK_KEY`; `CRM=salesforce` is refused. Contract tests 1, 3, 4, 5 and 6 in `tests/crm-desk-contract.test.ts`; the three against a running CRM Desk are skipped without `CRM_DESK_URL`, `CRM_DESK_KEY` and `CRM_DESK_ADMIN_KEY`.
- Design-lint held items cleared on 2026-11-12 with Bryan's approval: all five idle `breathe` loops removed (T6; running states keep their colour, no motion) and the `.al-meta` separator dot replaced by a 1px `--line-2` hairline. `docs/DESIGN-LINT-BASELINE.txt` is now empty. Suite after: 1,159 passed, 12 skipped.
- `npx vitest run` on 2026-11-12: 1,158 passed, 12 skipped (1,170).
- Film: the v4 walkthrough (3:41) is published at https://bryanacevedo.github.io/project-videos/video/events-desk.mp4 and linked from the README.

## Upgrade from Account Desk (2026-11-11, merged into `main` and live since 2026-11-12)

Events Desk held against the bar Account Desk set, by six fresh reviewers (docs, demo data against rules, copy, design at 1536 and 390, compliance, security). Every finding and what happened to it is in `docs/UPGRADE-AUDIT.md`.

- Security: a body limit on every route (1 MB, about 20 MB on file routes), security headers, the public demo refuses webhooks, Slack calls and review workbooks and takes at most 60 changes a minute per address (keyed on the address the proxy appends; a soft limit), reps no longer get seat prices and estimates from `/api/approvals` or other people's travel and the budget from `/api/seat-requests`, the website reader stops at 200 KB, deal links must be http(s).
- Erasure now reaches the attendee-file row, the stored original file, the paid-answer caches, history lines and Slack cards, and refuses an empty address.
- Copy: counts instead of percentages where the groups are small, the ratio says how many costs are not entered yet and when it rests on under five meetings, one word for cost, "Met against the rest" instead of "How we know", no mixed totals on Overview.
- Design: readable zeros and past cards, the seat decision first on a phone, the People list on the page's edge, kind labels in ink, and Account Desk's soft halo on the one decision on the Result tab (notes to accept).
- README: plain eval wording, what the public demo refuses, and an honest compliance section (contact basis, unsubscribe, opt-outs, erasure, privacy notice, retention, LinkedIn).
- Tests, 2026-11-12 on the branch, before the merge and the CRM switch: `npx vitest run` 1,154 passed, 9 skipped (1,163), and `npx tsc --noEmit` clean. Under heavy load (a film render at the same time) four slow tests hit the 5 s limit and passed when rerun alone. Not run: the layout and interaction audits, the real-Postgres suite.
- Film v4: `~/Developer/events-desk-video/renders/events-desk-film-v4.mp4` and its phone copy, the v3 film with the 16 screens whose UI changed recaptured from the same snapshot (the result screens after the Cost tab's lines are entered as none, as the narration has it); no narrated line changed, so nothing was re-voiced. `hyperframes check` passes. Published on the project-videos site on 2026-11-12.

Not done, for Bryan: the demo seed stamps past events with the build time and never closes or scores them (Shoptalk shows Closing 230 days on, five events are past their close). Fixing it means a new snapshot, which changes the figures the film reads. Country rules for the contact basis, a template check for unsubscribe and sender address, LinkedIn-profile opt-outs, a privacy notice and a retention schedule are disclosed, not built.

## v2, after delivery (built on `v2`, merged into `main` 2026-11-09)

Built 2026-11-09 from `docs/LIFECYCLE.md`: owner say, the connector contract with four tools, the sending layer, the gate, replies, meetings and on-site capture, CRM campaign and trail, scorecard and ROI, debrief, learning, integrity, the Outreach section and My day. Decisions in `docs/DECISIONS.md`, section 33. The gap list from the two outside reviews is kept privately, outside the repo.

v2 merged to main and deployed 2026-11-09 (`1aed654`), checked on the live link. Second design round deployed 2026-11-10 (`58691ba`): My day redesigned with real rows in its folds, every stage after delivery seeded in the demo (NRF scored, Shoptalk closing, Money20/20 Europe follow-up ready, Dreamforce sequencing, FINNOSUMMIT owners, Tokyo in market), distinct booth walk-ups per event, clickable names everywhere, lead-only money views. Third design round deployed 2026-11-10 (`e1f9f88`): replies and meetings open their own side sheets (`src/app/Objects.tsx`, `GET /api/motion/replies/:id`, `GET /api/motion/meetings/:id`), Overview-style motion on every page, no status dots or hover underlines, menus by job (My day only for people with reply and meeting work, Settings for GTM only). Fourth round deployed 2026-11-10 (`efdaf6b`, Bryan's yes; Render's auto-deploy did not fire, triggered by API, live bundle matches the local build): automatic cost-card pricing with the confirm step kept (decision 39), the Cost tab ledger for leads, the learnings slider, money stripped from every rep read, and the fourth fresh-eyes review's findings (one value per view, honest Usage months, slots in the event's zone, phone tap targets and Budget rows, no console errors). 1134 tests pass on PGlite and Postgres; both audits clean. The v2 video is stopped at Bryan's call (voice track in the video repo, not built). The 5.4x vs 5.49 mismatch is gone: Overview and the event read the same ratio (checked 2026-11-10, Shoptalk 2.66 and NRF 2.38 on both). Not rechecked: 46 vs 43 people to reach. Sixth round deployed 2026-11-10 (`2b98a3f`, Bryan's yes, triggered by API, live bundle matches the local build, closed events clean after the first background pass): eight sequences an event, four audiences on two channels (decision 45), a badge scan handed to the rep who scanned them, the sequence sheet's cadence and accounts by owner, two hands-on design reviews of every sheet with their findings fixed, the stray case on closed demo events fixed. 1148 tests pass on PGlite and Postgres; both audits clean. Deployed 2026-11-10 (`97bea47`, Bryan's yes, triggered by API, live bundle matches the local build, checked on the live link): the People tab's dropped-people block retitled "Excluded from outreach" with its total (117 on Shoptalk), each bar now a share of that total, and the button reads "All 12 reasons" (it counted reasons, not people). The 117 reconciles: 99 person rows and 11 company rows dropped from the 130-row file, plus 7 of the 30 people the desk found. Fifth round deployed 2026-11-10 (`288d2e8`, Bryan's green light, triggered by API, live bundle matches the local build): sequence data and the sequence sheet (decision 42), person, company and sequence sheets with a color per sheet kind (decision 43), the Replies fold, the stage-handoff test, a two-wave demo, the sequence naming convention (decision 44). Next: the requirements docs. My day is in the sidebar for reps, and for leads with reply or meeting work (checked in `src/app/App.tsx` 2026-11-10; the earlier open call was stale).

## Where it stands

All nine build slices are done, and the later design work (tiering and enrichment, data hygiene, new registrations, the screen rounds, the Sheet design) is built. Everything runs end to end on simulated vendors and mocks. `make demo` goes from seat request to a delivered Google-Sheet-style workbook. `make ask Q="..."` runs Concierge over its MCP server. The walkthrough video is in the README. Bryan chose one end-to-end video over two cuts.

Checked on 2026-11-10 by running them:

- `npx vitest run` on `v2` (2026-11-10, `efdaf6b`, same as `main`): 1,134 passed, 9 skipped (1,143 tests), on PGlite and with TEST_ALL_ON_POSTGRES on real Postgres 18. Skips need TEST_DATABASE_URL (run in CI) or BENCH_GATE=1 (the 10,000-person gate bench, 18.4 s after migration 0043).
- `node scripts/audit-layout.mjs` and `node scripts/audit-interactions.mjs` against the demo: both pass, no console errors.
- `npx tsc --noEmit`: clean.
- `EVALS_STRICT=1 npx vitest run` on the three eval test files: passes, so no recording is stale and CI would not be red on evals.

**Public** at https://github.com/bryanacevedo/events-desk since 2026-11-09. CI passed on the first push. The walkthrough is hosted on the project's GitHub Pages site. **Live demo** at https://events-desk.onrender.com (Render free plan, `render.yaml`, service `events-desk`). It opens prebuilt data (`samples/demo-snapshot.tgz`, rebuild with `make demo-snapshot` when the seed changes), must run on Node 26 (Node 24 needs about 840 MB to start and the plan allows 512), takes no uploads (`PUBLIC_DEMO`), and sleeps after 15 idle minutes, then needs about a minute. Measured on Render: 269 MB peak, through a live research run.

To resume: run `npx vitest run --testTimeout=60000`, then pick from "Needs Bryan" below.

## Proven and not proven

**Proven, on simulated vendors and fakes.** The whole flow, the money rules (reserve under a row lock, caps, no repeat on an unknown outcome), the email rule, the CRM checks and write-back against a simulated CRM, reuse and the saved log, new registrations and the Sheet refresh against a fake publisher, the Summary checks. Plus two real runs: one real sample workbook published to Google Sheets with `make publish-sample` (2026-11-08; fonts, groups, filter views and sparklines read back through the API), and real model calls for the evals and three for the Summary.

**Not proven.**

- Salesforce: no adapter exists, and `CRM=salesforce` is refused. With `CRM` unset, live mode uses `noCrm`: no CRM check runs, owner and deal stay blank, nothing is written back. Field names, match quality, limits and the write path are all unknown.
- Slack: signed commands, buttons and messages, on fakes only.
- Apollo: the key on file is on the free plan. `mixed_people/search`, `mixed_people/api_search` and `people/match` returned 403 `API_INACCESSIBLE` on 2026-11-08 and the waterfall cannot be reached, so no real Apollo call has completed. Request and response shapes are from documentation, tested on faked responses. The search-response `linkedin_url` field and the single-person match shape are unconfirmed.
- ZeroBounce: faked responses only.
- Real Postgres at scale: the whole suite runs on real Postgres 18 through postgres.js with TEST_ALL_ON_POSTGRES (locally, not in CI), which covers bytea storage of original files too; CI runs `tests/real-postgres.test.ts`, including 60 concurrent reservations over 12 connections. Contention from several servers at once, and a production-size database, are untested.
- Google beyond the sample: the real delivery path of a delivered event, review sync, whether Drive keeps the hidden contact id and the Decision dropdown, a concurrent edit during a refresh (it is lost), and the consent-screen labels in `docs/GOOGLE-SETUP.md` (written from memory).
- The real website reader (fakes only) and a real model reading an ICP document (the demo uses a deterministic parser for its one document).
- No real Research run has priced a tier call inside the app, so the cost card's AI estimate for tiering is arithmetic, not a measurement (decision 26).
- There is no real login. "Acting as" is self-asserted in every mode. The personal-data GET routes (contacts, workbook, original files and rows, opt-outs) are open. `WRITE_KEY` is one shared key.
- The people-world, email-world and other world tests use authored rates. They show the code copes with those rates, nothing about real data.

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
- **Two cards.** Research card (identity, firmographics, company tier, website read; worst case 5 model calls per company since the second look was cut) and Outreach card (titles, people, reveal, email loop, LinkedIn, review, perspective, Concierge). The desk prices each card as soon as it can be made, and the uploader confirms (decision 39). Single-card flow remains for old events and its tests.
- **Tiering.** Hard rules in code, company tier with Unknown and a cited fact, tier cache by domain and ICP version, spread check, re-tier within an allowance, title parsing (rules, then the model), persona tiers, ranking and quotas.
- **Email.** Apollo match, Apollo waterfall by polling, ZeroBounce plus Apollo's Verified, catch-all probe, employment check, vendor guards that pause instead of dropping. Hunter and NeverBounce are gone as direct vendors (decision 23). Attendee-list addresses usually read "Verified once".
- **Reuse.** Stored answers replace paid calls; `reuse_log` shows what was saved.
- **CRM and person record.** Salesforce flag checks that fail closed (simulated CRM only), the `people` table, write-back queue, `preSendCheck` wired to nothing.
- **New registrations.** Top-up as a hidden event, merge in one transaction, Sheet refresh that keeps typed work (decision 29, `tests/new-registrations.test.ts`, 66 tests).
- **Delivery.** Workbook (Summary, Review, Attendees, Prospects, Companies, Other attendees, Meetings, hidden Lists), Google Sheet with a Sheets-API finish, Excel download, Review sync. The Summary opening is model-written and code-checked, with a code-written fallback per part.
- **After delivery (v2).** Owner say, the connector contract with four tools, sending, the gate, replies, meetings and on-site capture, scorecards at 30 to 365 days, debriefs and learning, the Result tab and Results page, and each event's Cost tab ledger (decision 40). Money is leadership's and GTM's on every read (decision 41).
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

- The v3 film is shipped (2026-11-10, Bryan: "Ship it"): the whole system in 3:41, one narrator in v1's structure (Kokoro am_eric), one spine (Quillridge Systems and Camille Bélanger), each camera move timed to the word it shows. It replaced the 3:19 film; the README now links the v4 cut (same story, refreshed screens) on the project-videos site. Script `~/Developer/events-desk-video/SCRIPT-V3.md` (fresh-eyes reviewed). Next: the requirements docs for every build.
- Paid Apollo and a ZeroBounce key, then one real run on a very small list. The waterfall lineup is set in Apollo, and a sample of a few hundred contacts decides it.
- Connect Salesforce when wanted (an adapter has to be written first; CRM Desk is the other option, `CRM=crmdesk`). Confirm Do Not Call.
- The real credit allotment in each vendor's pool, for the Usage page.
- Real Slack: create the app and test signed commands and buttons.
- A fresh title holdout, if the title figure is to be quoted as held out.
- Whether the Summary's 1-cent AI rate should change once a real Research run is priced.

## History

- 2026-11-08: slices 1 to 8; first real eval recording; workbook redesign; Excel upload and Google Sheet delivery; tiering and enrichment steps 1 to 9; the simulated world and spend guard; seat requests, Budget, Usage, Settings and the new shell. Two fresh reviewers checked the README and the code, and all reproduced bugs were fixed with tests.
- 2026-11-09 (replaced 2026-11-10 by the 3:41 film, above): End-to-end walkthrough video made and approved by Bryan (3:19, voiced, captions, `docs/video/`). One video, no separate narrated cut. Project: `~/Developer/events-desk-video`.
- 2026-11-09, late: Google app in production, home and privacy pages live, sample Sheet public to view. Two goldfish reviews of the whole system; every code defect they named fixed or disclosed (decision 30, `tests/goldfish-fixes.test.ts`).
- 2026-11-09: screen rounds 1 to 5 and a cleanup pass; Sheet design passes 1 and 2 (decisions 18 to 20); original files and event delete (21); model-written Summary (22); Apollo and ZeroBounce only, with reuse and saved credits (23); real re-recording of the evals, second look cut (24); title gate (25); AI priced from tokens (26); Summary retest (27); Salesforce checks, person record and write-back on a simulated CRM (28); new registrations (29). The simulated wrong-priority-A floor moved from 20% to 25% (decision 27).
- 2026-11-10: Three more design rounds deployed (`58691ba`, `e1f9f88`, `efdaf6b`), each after a hands-on fresh-eyes review: side sheets for replies, meetings, deals and notes; the desk prices cost cards itself (decision 39); the Cost tab ledger (decision 40); no money in any rep read (decision 41); the design checklist in `docs/DESIGN-CHECKLIST.md` with its layout and interaction audits.

## Prompt caching (2026-11-13, Backlog bl_117, branch `cache/prompt-caching`, on main in 4ba07bf)

Cache markers, tests and cache-aware cost accounting are in; measured with real calls on 2026-11-14: warm input cost about 87 to 91% lower on the tasks measured (see decision 83). On main.

Gate results (2026-11-15, unattended writer): both Events Desk audits clean on a fresh demo server; full suite 1,820 passed 14 skipped; Account Desk full suite green and coverage 99 scenarios 92 shown 0 missing; lumen-world 57 tests, ruff clean, rehearse --verify identical (CRM 5, Market 1, Account 4), audit 9 of 9. Not deployed: auto-deploy is off on Render and a deploy happens only when Bryan says.

## Rehearsal made deterministic (2026-11-16, session ec-shrink)

Before, the four-desk rehearsal wrote a different Events Desk half on every run (481, 483 and 485 steps in three runs; 477 and 478 in two 3-day runs). Causes and fixes: `scripts/rehearse.ts` numbers the desk's ids for that run (an uploaded list's contact ids come from `crypto.randomUUID`), picks its 30 people by email and name, fixes the wall clock to the demo's day, and turns vacuum and parallel scans off for its database. `src/server/crm-sync.ts` (the order members are queued in) and `src/server/crm-outbox.ts` (the order the outbox is written to the CRM, and the email queue) now break ties by email before the id; same results, a fixed order. Test: `tests/rehearse-order.test.ts` (5 tests); `crm-sync`, `crm-desk-contract` and `crm-hygiene` tests pass. Proved: two full four-desk runs at the same time on separate copies came out byte-identical (22,987 steps, 479 from this desk). The desk itself keeps its random ids.

## Simulation database guard and tracing (2026-11-16, session S3, bl_148)
Events Desk can run against its own Neon simulation project (aws-us-east-1, Postgres 18.7) by `DATABASE_URL` alone: the default is unchanged and the public demo keeps its built-in database. A guard (`src/server/simguard.ts`, on only when `SIM_DB_GUARD=1`) refuses any host that is not this laptop or a simulation project and any database not named `neondb` or `sim_*`; tested. Optional OpenTelemetry tracing (`telemetry`, off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, localhost only). Tools and measurements: `~/Developer/workday-sim-plan/simdb` and `observability`, PLAN.md Revision 6. Finding: a live rebuild over Neon's 60 ms round trip is far too slow (hours), so databases are built on the laptop and copied in bulk. Not deployed: auto-deploy is off on Render and a deploy happens only when Bryan says.
