# Into the shared world (redesign step 6, Phase 4)

Spec for `~/Developer/events-rethink/steps/step-6.md`. The step is sized at 4 to 5 sessions, so it is built in four parts. This session writes the spec for all of it and builds part 1. Decisions from 85 on (84 is Bryan's Overview and copy call of the same day) in `docs/DECISIONS.md`.

Sources: `events-rethink/PLAN.md` sections 7 and 10; `shared-world-plan/DESIGN.md` sections 2b, 7 and 13; CRM Desk `docs/API.md` and `docs/CONNECTING.md` on `origin/main` (checked 2026-11-15); Account Desk `docs/DECISIONS.md` 66, 68 and 69 on `origin/main`.

## 1. What is true on 2026-11-15 (checked, not assumed)

- `INTEGRATED_WITH` is built in Account Desk (`src/outbound/integration.py`: `market_desk`, `events_desk`, `crm_desk`) and Market Desk. In Events Desk it is a stub (`src/server/integration.ts`, 5 lines, no behaviour). Building it is part 1.
- Account Desk's option A trigger exists: with `INTEGRATED_WITH=events_desk` and a CRM that lists campaign members, a member of an event or webinar campaign whose status is registered, attended or no show becomes a signal and starts the `event_follow_up` play. It reads `GET /changes/campaign_members`. It does not read `targeted`, `declined` or `waitlist`, and it has no trigger for "target accounts likely at the event" (that is part 3 and Account Desk's change).
- CRM Desk's campaign write already takes `parent_id`, `budget_cents` and `actual_cost_cents` (`records.py`), campaign `type` is one of `event`, `webinar`, `email`, `outbound`, `other`, and members take one of six meanings (`sent`, `registered`, `attended`, `met`, `no_show`, `responded`) or a status key or label from the campaign's own list. A label the campaign does not have is refused with the list of allowed ones. A person adds a campaign's own statuses in its screens; a desk cannot. So Declined, Waitlist and Targeted are a contract change in CRM Desk, not a label Events Desk can send today.
- CRM Desk's index lists a pointer row `campaign_member_statuses` owned by Events Desk, with no version or hash, because Events Desk does not publish yet (CRM Desk decision 72).
- `POST /activities` takes `type` (`email`, `call`, `meeting`, `note`, ...), `direction`, `contact`, `subject`, `external_id`. A repeated `external_id` answers the same record.
- `lumen-world` is at 1.2.0. It has `events.csv` (kind `conference`, `webinar`, `dinner`), `team.csv` with an `events_desk_role` column, and `attendance.csv`. It has none of the world additions of PLAN section 10 (the Las Vegas side dinner, the 2025 Money20/20 USA row, assessment facts, the sponsorship and talk, the later clock). Another agent owns that repository right now, so those additions are written down in `events-rethink/steps/step-6-cross-repo.md`.
- Events Desk's own simulated world (`samples/world.json`, `src/shared/world.ts`) is a different thing from `lumen-world`. Part 2 is where Events Desk starts reading the shared one.

### 1.1 What the code does not do today (found by the goldfish review, checked)

- `queueCampaignMembers` has no caller. Only Met (`meetings.ts`) and Responded (`replies.ts`) member rows are queued; Invited, Registered, Attended, No show and the hosted guest statuses never reach the CRM. The campaign is queued only at list delivery (`pipeline.ts`, `top-up.ts`), so a conference with no list, or a hosted dinner, never gets one. Member keys `cm:<event>:<contact>` with `ON CONFLICT DO NOTHING` swallow later status moves. Account Desk's trigger reads registered, attended, no show and met members and only for fit tiers A and B (`pipeline.py`, `catalog.py`), so today it would see almost nothing from Events Desk.
- CRM Desk keeps the first status and subject of an activity; a status changes by `PATCH /activities/{id}`. It refuses `proposed` and `rescheduled` meetings. A refused member status is a 422 whose allowed list is inside the sentence, and a status key or label a person added to a campaign (for example a "Declined" meaning `no_show`) is matched before the meaning.
- CRM Desk's campaign `budget_cents` and `actual_cost_cents` are visible to and editable by every member by default; only its computed figures are gated by the money role. Campaigns carry no currency. Events Desk has no currency column; its cost total (`eventCost`) adds tickets, travel and AI, not only recorded cost lines.
- `debrief_facts` hold account, theme, fact and quote, no person. The fact text is model-extracted; only the quote is checked word for word. Sends are recorded from the sequencer webhook (`replies.ts` `ingestEvents`); a touch has no subject and may be LinkedIn.
- `integration.ts` already parses the setting and `hosted-reminders.ts` uses it. Account Desk reads `INTEGRATED_WITH` on each call. CRM Desk's index pointer for `campaign_member_statuses` stays null even after Events Desk publishes, because CRM Desk holds no address or key for another desk (decision 72).

## 2. The four parts

| Part | What it builds | Needs from outside |
|---|---|---|
| 1 (this session) | This spec. `INTEGRATED_WITH` as a real setting and its states. Every route classified, the sequencer off for new work under `account_desk` (routes, card approval and `sending.ts`), the ICP page read-only under `market_desk`. The deferral panel. Campaign type by event kind and the parent link for hosted side events in the adapter. The published `campaign_member_statuses` definition. Route-level tests of both states (`tests/integration.test.ts`); the per-row DESIGN 2b table test moves to part 2 because most rows are about the writes built there. | Nothing. |
| 2 | Everything that writes members, activities and money, built on a spec section of its own (7 to 9 below are the design, rewritten against the code facts in 1.1): queueing every member status where it happens, campaign creation at plan confirmation, meeting activities as create then PATCH, debrief activities, campaign money. Reading the shared world: a pinned `lumen-world` release (the 18 events, the roster, Lumen Ledger as the seller), Market Desk's ICP and the tier from the record, the fixed demo clock, the coverage gate. | CRM Desk: campaign money hidden from members by default (cross-repo). A tagged `lumen-world` release with an Events Desk slice. |
| 3 | The world additions loaded. Targeted members and the target-accounts trigger end to end. The held statuses released once CRM Desk carries `targeted`, `waitlist` and `declined`. The deferral panel's play status. | `lumen-world` additions, Account Desk's trigger, CRM Desk's contract change (all in `step-6-cross-repo.md`). |
| 4 | The four-desk rehearsal, the demo snapshot, the film notes (PLAN section 11). | Parts 2 and 3 landed in all four repositories. |

Part 1 is complete on its own: alone, nothing changes; with `account_desk` or `market_desk` named, the two hidden jobs are hidden and the rest works. It does not make Account Desk's follow-up fire: that needs the member writes of part 2 (1.1).

## 3. `INTEGRATED_WITH` (part 1)

`INTEGRATED_WITH` is a comma list of the other desks present: `account_desk`, `market_desk`, `crm_desk`. Unset means alone. It is validated at boot (a bad name stops the server) and read on each call, as Account Desk does, through `integratedWith(env)` so a test changes it without an import. A name that is not one of the three stops the server at boot with the three names. `events_desk` is not accepted here (a desk never names itself). `crm_desk` is accepted and changes nothing: the CRM is chosen by `CRM=crmdesk` (decision 46) and `INTEGRATED_WITH=crm_desk` without it is allowed, because a buyer may run Salesforce later; it is shown on the settings read as "named, not connected" when `CRM` is not `crmdesk`.

`GET /api/integration` answers `{ with: [...], crm: "crm_desk" | "sim" | "mock" | "none", crm_named_not_connected: boolean, sequencer: "events_desk" | "account_desk", icp: "events_desk" | "market_desk", campaigns: "events_desk" }`. Everyone signed in may read it; it holds no money.

### 3.1 What each name changes

- `account_desk`: the sequencer is off for new work. One middleware on `POST /api/*` answers 409 `owned_by_account_desk` (a sentence naming Account Desk) for exactly these routes: `/api/events/:id/motion/tools`, `/motion/legal-basis`, `/motion/sequences`; `/api/motion/sequences/:sid/campaign`, `/checklist`, `/release`, `/placement-override`; `/api/motion/templates`, `/placement`, `/account-domains`; and `/api/events/:id/motion/start` unless its body says `purpose: "debrief_only"` (the route's default is outreach, so an empty body is refused). A Motion card for outreach that was requested earlier is refused at confirmation too (`confirmMotionCard`, so an approval cannot start what the route would refuse), (`launchAllowed` is not gated: `observeSequences` calls it for sequences already running, and gating it would pause them with a false reason.) Left on (they act on events already running): `/api/motion/consent`, `/domains`, `/restart`, `/stop` and `/api/events/:id/motion/contacts/:cid/resume`; also (a person must always be able to stop sending), capture, replies handled, forget, costs, slots, meetings and outcomes, owners, debriefs, learning, and every transactional send. A sequence launched before the setting was turned on keeps being observed, its replies keep being handled and it ends on its own (events already running keep working). Turn the name off and the routes answer again.
- `market_desk`: the ICP page keeps showing the profile in force and its version. `/api/icp/documents`, `/compiles/:id/start`, `/confirm`, `/bench` (put), `/bench/run`, `/bench/example`, `/publish`, `/reopen` and the draft PATCH answer 409 `owned_by_market_desk` (start and bench run are paid model calls, so they are refused too). `/compiles/:id/cancel` stays. The profile already in force stays in force until part 2 reads Market Desk's `icp.md`. Turn the name off and upload returns.
- `crm_desk`: no behaviour of its own (see above).

### 3.2 Every DESIGN 2b row, in both states

For each row of DESIGN 2b the tests state what Events Desk does alone and what it does with the owner present. Most rows say "nothing is hidden". The test (`tests/integration-2b.test.ts`) is one table: a row, the state, a probe, the expected answer. A second test lists every route of the app in both states and asserts the difference is exactly the routes of 3.1.

| DESIGN 2b row | Alone | Integrated | Part |
|---|---|---|---|
| Accounts | Works from the companies on each list; creates no account | Same; a company not in the record stays a company name | 1 (no change, asserted) |
| Company data | Own vendors | Own vendors for companies the record lacks; the record's value shown when it has one | 2 for the read; 1 asserts nothing is written |
| ICP and fit scoring | Own ICP document, compiled and published on the ICP page | `market_desk`: page read-only, 409 on upload and publish | 1 |
| Tiers and segments | Own tiering | `market_desk`: own company tier skipped for a company the record tiers; titles still tiered | 2 |
| AE and SDR ownership | Reads the owner by lookup, sets none | Same | 1 (asserted) |
| Plan, territories, capacity | Not this desk's | Same | none |
| Contacts and the person record | Own people table | Same, with `/go` link to the contact when the CRM answers | 1 (asserted) |
| People finding and enrichment | Own | Nothing hidden | 1 (asserted) |
| Suppression, opt-outs, flags | Own list decides | The record is checked before every first touch (`CRM=crmdesk`) | 1 (asserted, existing tests) |
| Contact basis and region rules | Own gates | Nothing hidden | 1 (asserted) |
| Campaigns and event members | Own events and lists | Events Desk owns the campaign and its members in CRM Desk | 1 |
| Outbound sequences, sending, replies | Own sequences and inboxes | `account_desk`: sequencer off for new work (3.1); replies on running sequences still handled | 1 |
| Activities, tasks, timeline | Own history | Activities for sends, replies, meetings and accepted debrief notes go to the record (section 5); own queues stay | 1 |
| Meetings | Books and tracks its own | Stored once in the record by `calendar_event_id`; the second desk does not log it again | 1 (asserted: a meeting the record already holds is not written again) |
| Leads and qualifying | Writes the person | Writes the person; qualifies nothing | 1 (asserted) |
| Lifecycle stage, do not prospect | Own statuses | Reads the flag; never moves a stage back | 1 (asserted) |
| Opportunities and pipeline | `simCrm` deals in the demo, blank live | Reads deals back, never creates one | 1 (asserted) |
| Attribution | Own results | Does not overwrite another desk's source | 1 (asserted: no write to `source_desk`) |
| Results and reporting | Own scorecards | Own scorecards; revenue from the record's deals | 1 (asserted) |
| Held-back groups | Own set-aside share | Unchanged | 1 (asserted) |
| Call notes and what was learned | Own debriefs | An accepted debrief note is also an activity on the record (section 5) | 1 |
| Duplicates, merges, erasure | Own dedupe and erasure | Erasure reaches the outbox; a 409 `erased` is a finished write | 1 (asserted, existing tests) |
| Team roster and users | Own users | Roster from the world in the demo | 2 |
| Notifications | Own Slack channels | Does not raise a second alert for a decision the record lists | 1 (asserted) |

## 4. Campaigns, types and parents (part 1)

- The campaign `type` is `webinar` for an event whose hosted involvement has `hosted_format = 'webinar'`, else `event`. Today every campaign is `Conference` in the call and `event` in the body (`crm-desk.ts`); the call now carries the type through the `createCampaign` argument, which becomes a closed set (`"event" | "webinar"`).
- A hosted event that names a conference (`involvements.conference_event_id`) creates its campaign with `parent_id` set to the conference's CRM campaign id. The conference's campaign must exist first. This is new behaviour, not a copy of the member rows (those count attempts and fail after 5): the child row waits as `queued` with `last_error` "parent not in the CRM yet", counts no attempt, and raises an alert after 24 hours so it never waits silently. The conference campaign is queued when its plan is confirmed, not only at list delivery (part 1 adds that queueing for the campaign only, so a hosted dinner's parent exists). A hosted event with no conference is a campaign with no parent.
- Budget and actual cost are **not in part 1**. They need a currency decision (events have no currency column and CRM Desk campaigns carry none), an exact definition (the cost total adds tickets, travel and AI; AI cents are fractional), one outbox row per event that reads the latest numbers when it drains (a key with the numbers in it swallows a change back to an earlier value), and CRM Desk hiding the two fields from members by default (they are open to every member today, so the money rule would break). Part 2, with the cross-repo item.

## 5. Activities in the outbox (design for part 2, rewritten there against 1.1)

The table below is the first draft the review found wrong in four places; part 2's spec replaces it with: meetings as one create row then a status PATCH row (not one create per status), skipping meetings that came from the CRM and the statuses CRM Desk refuses; sends queued from `ingestEvents`, never suppressed under `account_desk` (those sequences are this desk's), with the channel mapped and the subject taken from the template step; debrief activities carrying the theme and the verbatim quote (a model wrote the fact text, and nothing a model wrote goes in a message a person reads) and attached at account level or by the reviewer choosing the contact; opt-out does not cancel queued rows, erasure does, and it must cancel `held` rows too.

New outbox kind `activity`. One row per fact, `desk_key = "activity:<kind>:<id>"`, so a second queueing is a no-op (`ON CONFLICT (desk_key) DO NOTHING`, already how creates work). In part 2, the CRM adapter's new optional method `createActivity({ record, type, direction, subject, body, at, key })` posts `/activities` with `external_id = "events_desk:" + key`; a CRM that does not have the method gets nothing queued (as `canWrite` already says).

| Fact | Queued by | `type` | Subject | Key |
|---|---|---|---|---|
| A sequence email sent | the sequence observer when a step is recorded | `email`, `out` | the step's subject | `activity:send:<touch id>` |
| A reply received | `replies.ts` where the reply is stored | `email`, `in` | "Replied: " plus the subject | `activity:reply:<reply id>` |
| A meeting booked or held | `meetings.ts` where the status moves | `meeting` with `meeting_status` | the event's name | `activity:meeting:<meeting id>:<status>` |
| An accepted debrief note | `closeout.ts` `reviewDebrief` on `accepted`, one per fact that names a person at an account in the list | `note` | "Conversation at <event>" | `activity:debrief:<debrief fact id>` |

A debrief fact is queued only when its person is a known contact of the event (the fact's `account` and a contact row); it carries the fact and the quote, never a person's other notes. The body is the template `"<theme>: <fact>"`, which a person wrote; no model writes it. A person who opted out or was erased has their queued activities cancelled by the code that already cancels their outbox rows (`operating.ts` line 285 and `person-record.ts`). A 409 `erased` is a finished write.

With `account_desk` named, the "send" rows are not queued by this desk (Account Desk writes its own emails); every other row is.

## 6. Member statuses and the definition (the definition is part 1; sending the three new statuses is part 3)

The desk's statuses and what CRM Desk calls them:

| Status | Meaning in CRM Desk today | New meaning needed |
|---|---|---|
| Targeted | none | `targeted` |
| Invited | `sent` | |
| Registered | `registered` | |
| Waitlist | none | `waitlist` |
| Declined | none | `declined` |
| Attended | `attended` | |
| Met | `met` | |
| No show | `no_show` | |
| Watched later (webinars) | `responded` | |

- The adapter's status map gains `targeted`, `waitlist` and `declined` and sends them by meaning name. CRM Desk answers 4xx with the list of statuses it allows when it does not carry them. The adapter turns that, for these three only, into `CrmContractGap`; the outbox marks the row `held` (a new status value), keeps it and does not count an attempt. A sweep retries held rows once a day and when the published definition's version changes. A refusal of any of the six stays a failure. Before part 3 builds this, the three meaning names are agreed with CRM Desk's owner (they are guesses until then), the answered status is checked equal to the intended meaning (a person's own "Declined" status meaning no show would otherwise match first), a held row a newer status supersedes is dropped, held rows are cancelled on erasure, and the retry trigger is a change in CRM Desk, not Events Desk's own definition version. Nothing is written under another meaning: a Declined person is never sent as `no_show`.
- Events Desk publishes the definition `campaign_member_statuses`, as CRM Desk's `definitions` are published: `GET /api/definitions` (the list and an index), `GET /api/definitions/campaign_member_statuses?version=<n>`, `GET /api/definitions/campaign_member_statuses/versions`. The body is `{"statuses": [{"key", "label", "meaning", "applies": ["event"|"webinar"], "responded"}]}` sorted by funnel order. The hash is SHA-256 of the body as JSON with sorted keys, no spaces and non-ASCII kept, prefixed `sha256:`, the same as CRM Desk's. A new version is appended when the body in code differs from the latest stored one, at boot and on each read (same rule as CRM Desk). Table `definition_versions` (name, version, hash, body, changed_by, published_at), append-only, a trigger refuses update and delete.
- The webinar template has Watched later instead of Met (PLAN section 7), so `applies` says so.

## 7. The deferral panel (part 1)

With `account_desk` named, the event page's Outreach section opens on a panel instead of the sequence builder buttons: "Account Desk runs the outreach for this event.", an "Open in Account Desk" button when `DESK_LINKS` carries `account_desk=https://...` (links only, it never switches anything), and three rows the desk still owns (Badge scans and notes, Replies, Meetings) that open their folds. Built provisionally as direction A of three Fable directions (`~/Developer/events-desk-review/step6/deferral-panel.html`, screenshots `panel-A-1440.png` and `panel-A-375.png`). Not built yet, for part 2 and 3: the counts of people by status (the desk has no member status data until part 2 queues them), the booking link with a copy button, and the play's status (cross-repo item 5). The folds under the panel (sequences already running, senders) still show for events that were running before the setting; they hold only history.

## 8. Tests (part 1)

- `tests/integration.test.ts`: parse, the boot refusal, both states of every route in 3.1, the route-difference test.
- `tests/integration-2b.test.ts` (part 2, with the writes): the table in 3.2, each row alone and integrated. Part 1 has `tests/integration.test.ts` only.
- `tests/crm-adapter-step6.test.ts`: type by kind, the parent on a hosted event, the child waits for its parent, money written once and only in USD, the activity call and its `external_id`, the three held statuses, a held row released when the CRM carries it.
- `tests/outbox-activities.test.ts`: each fact queues one row, twice queues one, opt-out cancels, `account_desk` suppresses the send rows only.
- `tests/definitions.test.ts`: body, hash equals CRM Desk's algorithm on a known body, versions append, update and delete refused.
- Existing: `crm-desk-contract.test.ts` (the live half is skipped without `CRM_DESK_URL`), `connector-contract.test.ts`, every lifecycle test, `rep-sees-no-money.test.ts`, `new-registrations.test.ts`.
- Not tested in part 1, said plainly: a real CRM Desk round trip of the new activity and parent calls (the live half of the contract suite is skipped without the three variables).
- Part 1's tests exclude the member, activity and money tests of 8, which move to part 2 with their code.

## 9. Out of this step

Cold promotion to people not invited personally (Account Desk's). Salesforce. Anything in `outbound-desk`, `lumen-world`, `crm-build` or `market-desk`: written in `events-rethink/steps/step-6-cross-repo.md` for the master.

## 10. Review record

Goldfish review of this spec by a fresh Opus subagent, before code (2026-11-15): 2 Blockers, 8 Majors, 13 Nits. Section 11.

## 11. Goldfish findings and what happened

- Blocker 1 (members and campaigns mostly never queued): true. Recorded in 1.1; the member writes move to part 2 with their own spec, and part 1 does not claim option A fires.
- Blocker 2 (meeting activity keys): true. Part 2 design in section 5.
- Major 3 (debrief facts): fixed in section 5 (quote, not model text; account-level).
- Major 4 and 5 (campaign money): moved out of part 1; cross-repo item for CRM Desk's field visibility.
- Major 6 (sends): fixed in section 5.
- Major 7 (held statuses): fixed in section 6.
- Major 8 (waiting child): fixed in section 4.
- Major 9 (route gating): fixed in 3.1, every route classified.
- Major 10 (Market Desk's ICP): part 2 reads `icp.md` and the tier (parts table).
- Nits 11 to 23: 11, 12, 14, 18 and 21 corrected in the text; 13 in 1.1; 15 (tag is v1.1.0, code and status say 1.2.0): the pin in part 2 is by commit, not tag; 16 and 17: noted in 1.1; 19 (owner column, Results link, "not in the CRM", every send): added to the 3.2 table text in the tests; 20: migration 0058 adds `definition_versions` in part 1, and the `activity`, `campaign_update` and `held` values with part 2; 22 and 23: closed means stage `scored`; `applies` lists are sorted and the endpoints are readable by anyone signed in.

## 12. Part 2: member, activity and money writes, and reading the world (spec written before code, 2026-11-15)

Replaces the design in sections 5 and the member and money lines of 4 and 6 for what part 2 builds. Facts are the code of `f849a9c` (1.1 holds the rest). Migration 0059.

### 12.1 What part 2 builds, and what it does not

Built: every member status the CRM carries is queued from where the desk knows it; the event's campaign is queued when the plan is approved; meetings, replies, sends and accepted debrief facts become activities; campaign money is built and kept off; the demo reads a pinned `lumen-world` slice; the per-row DESIGN 2b table test; the part 1 review leftovers.

Not built, and said so: Targeted, Waitlist and Declined are not sent (CRM Desk carries no such meaning; part 3). A guest who moves from Registered to Declined stays Registered in the CRM until part 3; the sweep counts these as `awaiting_contract` and the integration read shows the count, so it is visible and not silent. Campaign money is not written to CRM Desk (12.5). Market Desk's ICP and its tier are not read (cross-repo item 11 has no answer yet); the page stays read-only under `market_desk` with its last profile.

### 12.2 Member rows

- One outbox row per status move: `desk_key = "cm:<event>:<member>:<status key>"`, where member is the contact id or the guest id and status key is one of `sent`, `registered`, `attended`, `no_show`, `met`, `responded`. The old keys `cm:<event>:<contact>` (the enrolment row and the reply row shared one key, so the second was swallowed) are no longer written; rows already in the table stay as they are.
- Where they come from, as a sweep from state, run at the start of each outbox drain: `syncMembers(db, crm)`. A table `crm_member_sync (event_id, member_kind, member_id, last_status, queued_at)` holds the last status queued for each member. The sweep reads the current status of each hosted guest with an address (`event_guests`) and each enrolled contact, compares it with `last_status`, and queues a row when it differs. Why a sweep and not a call at each change: guest status changes in twelve places (invite, RSVP, waitlist promotion, check-in, undo, close attendance, walk-in, and more), contact status in more. A sweep from state cannot miss one, repeating it is harmless (the table and the key), and the latest status always wins. The cost is up to one sweep interval (5 minutes) of delay, and a state that came and went between two sweeps is never sent.
- Mapping. Guest: `invited` sends `sent`; `registered`, `attended`, `no_show` send themselves; `listed`, `waitlist`, `declined` are `awaiting_contract` and nothing is queued or recorded for them. Contact in a launched sequence: `sent`; with an inbound reply that needed a rep: `responded`; with a held meeting: `met`. A contact the CRM tells us attended is not read back in part 2.
- Order and staleness. Rows for one member drain oldest first. Before a member row is carried out, if a newer row for the same member is queued or done, this row is set to `cancelled` with `last_error` "superseded" and not sent, so a retry of an old status never moves the CRM backward. `met` is not overwritten by a later `responded` or `sent` (a person who met us and then replied is still met): the sweep never queues a lower status over `met`.
- Waiting. A member row whose event has no CRM campaign id yet (its campaign row is queued, or waiting on its parent) is not an attempt and not a failure: `last_error` says "campaign not in the CRM yet" and it stays queued. A row that has waited more than 24 hours raises one alert per event per day (`raiseAlert`, key `crm_wait:<event>`), the same for a child campaign row waiting on its parent. The alert is raised by the lifecycle step, not by the drain, so a drain that cannot run still gets it.
- Campaign at plan approval. `approveWithin` (and the approval route that does not auto-approve) queues the event's campaign in its own transaction through `queueCampaign`, so a hosted dinner or a conference with no list has one. Delivery still queues it too; the key makes the second a no-op.
- Erasure and opt-out. An erased person's queued member and activity rows are cancelled, held or not (the code that cancels outbox rows by person already does this; the new kinds are added to its list and a test proves it). An opt-out does not cancel them (a person who unsubscribes still attended).

### 12.3 Activities

New outbox kinds `activity` and `activity_update`, and a Crm method `createActivity({ record, type, direction, subject, at, key, meeting })` that posts `/activities` with `external_id = "events_desk:" + key`, and `updateActivity({ id, meeting_status })` that PATCHes it. A CRM without the methods gets nothing queued.

| Fact | Where it is queued | Row | Key |
|---|---|---|---|
| Meeting booked | `meetings.ts` where the row is inserted | `activity`: type `meeting`, `meeting_status: booked`, `meeting_at`, `meeting_timezone`, subject "Meeting at <event>" | `activity:meeting:<id>` |
| Meeting held, no show, cancelled | `recordOutcome` | `activity_update` setting that status. CRM Desk refuses `proposed` and `rescheduled`, so those never queue an update; a reschedule is a new create only if the time changed (new key with the time) | `activity:meeting:<id>:<status>` |
| Reply received | `replies.ts` where the reply is stored | `activity`: `email`, `in`, subject "Reply at <event>" (the desk stores the body; the body is not sent) | `activity:reply:<message id>` |
| Send | `replies.ts ingestEvents` where a touch of kind `send` is added | `activity`: `email` or `linkedin` by the touch's channel, `out`, subject "<event> outreach, step <n>". Not queued under `account_desk` only if the sequence is Account Desk's; this desk's own sequences are always written | `activity:send:<touch id>` |
| Accepted debrief fact | `reviewDebrief` on `accepted` | `activity`: `note`, subject "Conversation at <event>", body the template "<theme>: <quote>" (the quote is checked word for word; the fact text is model-written and is not sent) | `activity:debrief:<fact id>` |

- A meeting that came from the CRM (`source = 'calendar'` read back through `ingestCrmMeetings`) is not written again. Source `crm` is not a source in this table; the sync marks meetings it ingested with `external_key` starting with the CRM's id, and the test reads that, not a guess.
- A debrief fact has an account and no person. It is queued only when exactly one contact of the event at that account has a held meeting; otherwise it is not queued and the review screen's count of "facts not placed" is unchanged by it (nothing is shown in part 2; the count is in the integration read as `debrief_unplaced`).
- `member -> record` uses the same `askPeople` lookup as members; a person with no record gets no activity (no lead is created for an activity).
- Mapping a meeting status the CRM does not take: `no_show` is sent as `no_show`.

### 12.4 Money, built and off

`campaign_money` outbox kind, one row per event with a CRM campaign: `desk_key = "money:<event>"` replaced by a fresh row each time a change is seen (key `money:<event>:<n>`, `n` from `events.crm_money_n`). The row carries only the event id; the numbers are read when it drains, so a change back to an earlier value is not swallowed. `budget_cents` is the sum of the plan's `budget_lines.planned_cents`; `actual_cost_cents` is tickets bought plus recorded cost lines (`ticket_purchases`, `event_costs`), whole cents; AI cost and travel estimates are not in it. USD only: an install writes money only when `CRM_CAMPAIGN_MONEY=usd` is set, and that is set by a person after checking that CRM Desk hides the two fields from members (cross-repo item 7). Unset (the default), the sweep queues nothing, and a test proves both. `GET /api/integration` carries `campaign_money: "off" | "on"`.

### 12.5 Reading the world

- `samples/lumen-world/` holds a copy of `events.csv`, `team.csv` and `manifest.json` from `lumen-world` `release/world-v1.1.0/public` at commit `400566a` (superseded: v1.3.0 at a008e18, section 13), and `PIN.json` (repository, commit, release, files and their SHA-256). It is a copy, not a link: Events Desk must run without that repository. `src/server/world-slice.ts` reads and checks it (hash per file, format version, the 18 events: 11 conferences, 5 webinars, 2 dinners), exposes `worldSlice()`, and `scripts/world-refresh.mjs` re-copies it from a checked-out `lumen-world` tag and rewrites the pin. The code and status of `lumen-world` say 1.2.0 but only v1.1.0 is a tag, so the pin is the commit.
- The demo seed adds nothing from it in part 2 beyond the roster and the seller: `GET /api/world` answers the pin, the seller (Lumen Ledger), the 18 events and the roster's Events Desk roles. The demo's own events keep their ids. Loading the world's events as the demo's events is part 3, with the world additions.
- Fixed demo clock: `DEMO_NOW` (a date) fixes "today" in the demo and the seed; unset keeps today's behaviour. The world's clock is 2026-11-12 14:00 UTC. A test seeds on the fixed clock twice and compares.
- Coverage gate: `tests/integration-2b.test.ts` reads the DESIGN 2b table of this spec (3.2) and fails when a row has no case or a case names a row that is not there, the way Account Desk's `coverage.py` does for its scenarios.
- Not read in part 2: Market Desk's ICP and tiers; the world's attendance and its additions (part 3).

### 12.6 Part 1 review leftovers

- A member row waits while its campaign row is queued (12.2); the 24 hour alert (12.2).
- `publishAll` runs at boot, after migrations.
- A fixture hash from CRM Desk's own test is added to `tests/definitions.test.ts` (CRM Desk's `tests/test_definitions.py` body and its published hash; the test fails on a different algorithm).
- A TRUNCATE guard on `definition_versions` in migration 0059.
- `/motion/checklist`, `/campaign` and `/release` stay closed under `account_desk` for sequences drafted before the setting: they start sending, and sending new work is what the setting turns off. Sequences launched earlier keep running (decision 88).

### 12.7 Tests

`tests/member-sync.test.ts` (every mapping, the sweep twice queues once, superseded rows, `met` sticks, awaiting_contract counted, waiting and the alert, campaign at approval, erasure cancels, opt-out does not), `tests/outbox-activities.test.ts` (each fact once, meetings create then update, refused statuses never queued, debrief placed or not, sends under both states), `tests/campaign-money.test.ts` (off by default, on writes once and reads latest at drain, USD only, definition of the two numbers), `tests/world-slice.test.ts` (hashes, counts, the clock), `tests/integration-2b.test.ts` (the table and its coverage gate), the definitions fixture. Existing suites stay green. Not tested: a real CRM Desk round trip of the new calls (the live half of the contract suite is skipped without its variables).

### 12.8 Goldfish review of section 12 (fresh Opus, 2026-11-15): 1 Blocker, 10 Majors, 12 Nits, and what changed

The review checked the design against the code and CRM Desk. This section overrides 12.2 to 12.5 where they differ. Every Blocker and Major is accepted:

1. Blocker, echo. CRM Desk's `/changes/meetings` returns every meeting, so a meeting this desk writes would be booked again as `cal:crm:<id>`. `ingestCrmMeetings` skips any CRM activity id that is the `result_id` of one of this desk's activity rows; the meeting row sends `calendar_event_id` when it has one.
2. Return to an earlier status. The key gets a sequence: `cm:<event>:<email>:<status>:<n>`, `n` kept in the sync table, so a check-in undone (attended back to registered) is sent.
3. `no_show` is added to the adapter's map, and an unknown status throws instead of falling back to `sent`.
4. One member is one email per event. The sync is keyed `(event, lowercased email)` and the status is derived from state (the highest of: guest status, contact in a launched sequence = sent, replied = responded, held meeting = met, with precedence met, attended, no show, registered, responded, sent), so a guest who is also a contact is one member and the sticky rule is not needed: the status is recomputed from state each sweep, so an undo lowers it.
5. Erasure. Every new payload carries the email (that is what `forgetPerson` cancels by); the sweep skips an email on the suppression list as erased, and skips a guest whose address was removed.
6. Campaign. Plan approval in `per_seat` mode never reaches `approveWithin`, so the sweep also queues the campaign of any event that has a member to send or whose plan was submitted. `approveWithin` is not changed.
7. Replies. Only matched `inbound_messages` with `signal = 'reply'` and a contact become activities, with the type from the channel.
8. Meetings are swept from state too: the create row once (status `proposed` waits until it is booked), update rows with a sequence key, the update waits for the create row's `result_id`. A reschedule changes nothing in the CRM in part 2 (said so). Only meetings whose `external_key` starts `cal:crm:` are skipped.
9. Money. The flag is checked in the sweep, the drain and the adapter; one row per event, set back to queued when the computed pair differs from the last pair sent (kept in the sync table); turning the flag off cancels none and sends none, and a row queued while on stays queued.
10. World. The vendored slice is the output of lumen-world's own `slice` command for `events_desk`, with its manifest, and its pin; if the command is not available the copy is stated as a hand copy in `PIN.json`.
11. Two drains. One in-process lock around the sweep and the drain.
- Nits taken: createActivity takes `body` and uses `occurred_at`; send activities come from `touches` (kind `send`) by touch id, no `account_desk` condition (Account Desk's sequences never reach this desk); `DEMO_TODAY` exists, so `DEMO_NOW` is dropped and the fixed clock test uses `DEMO_TODAY`; 4's claim that part 1 queues the campaign at confirmation is corrected (only delivery does); the sweep covers events starting within the last 180 days or later; the `no_show` line is reworded; a debrief fact's `account` is matched to a company by lowercase name equality; "held rows" is not a part 2 thing; Watched later has no source in part 2.

## 13. Part 3: the world additions, targeted members, the pre-event trigger, the held statuses, the panel's play status (spec written before code, 2026-11-15)

Three repositories change: `lumen-world` (additions, release 1.3.0), Account Desk (the pre-event trigger and a read), Events Desk (this repository). Facts checked on `origin/main` on 2026-11-15: CRM Desk `6ab3e22` carries nine member meanings including `targeted`, `waitlist` and `declined` (none counts as a response), a structured 422 `unknown_status` with `detail.allowed_meanings`, and `GET /definitions` `features.campaign_member_meanings` (a desk that holds rows back releases them when its name appears there). Account Desk `fe853bc` reads `registered`, `attended`, `no_show` and `met` members of event and webinar campaigns, for fit tiers A and B only, through `pipeline.ingest_members`, the signal types in `seed/catalog.py` `EVENT_SIGNAL_TYPES` and the play `EVENT_PLAY`, created only under `INTEGRATED_WITH=events_desk`. lumen-world `34c7d31` is 1.2.0, tags exist only to v1.1.0, `events_desk` slice has `events.csv`, `team.csv`, `truth/attendance.csv`.

### 13.1 Who does what (the centaur)

| Step | Agent | Person |
|---|---|---|
| Find people at target accounts and write them to the CRM as `targeted` | Events Desk's sweep | Sets the event's target accounts, the plan and the booking link |
| Start the pre-event play, research, draft the emails | Account Desk | Approves every message before it goes (the play's autonomy stays `draft`), and launches or edits the play as with any play |
| Stop a play when someone declines | Account Desk (stopping is the safe direction) | Can restart by hand |
| Say whether Declined or Waitlist counts | The CRM's meanings | Decided here, below |

Nothing in this part sends an email by itself, creates an account, moves an owner or scores anything.

### 13.2 The world: release 1.3.0 (lumen-world)

- **The clock is not moved.** The brief of step 6 asked for about 2026-11-24. NOW decides the signals, the job moves, the rehearsal window (`NOW - REHEARSAL_START`), the history cut and the 28,432 steps of the delivered journal that CRM Desk and Account Desk replay; moving it changes every desk's demo and invalidates those journals, while CRM Desk and Market Desk are being written by another agent. Instead 1.3.0 adds `events_desk_today = 2026-11-24` to `public/clock.json` and the Events Desk slice; only Events Desk's demo uses it (`DEMO_TODAY`). Nothing in the world is dated after 2026-11-12 except upcoming events, so no row is out of order at 2026-11-24. Money20/20 USA's 30-day scorecard (about 20 November) is past by then. Recorded as a deviation from the plan and flagged for Bryan.
- **Additive only.** Every file of 1.2.0 is byte for byte the same in 1.3.0 (a test compares the SHA-256 of each 1.2.0 file against a digest recorded from a 1.2.0 build, so CRM Desk's and Account Desk's slices and journals do not change). New files use their own seeded random streams so no existing draw moves. New files appear only in the `events_desk` slice (and in the release manifest).
- **New files** (columns in `docs/DATA.md`):
  - `public/events_extra.csv`: `event_id, name, kind, start, end, city, country, venue, size, theme, region, list_price_usd, price_source, organizer_url, source_url, confidence, owner, parent_event_id, cost_usd, cost_note`. Two rows: the Lumen Ledger side dinner in Las Vegas on 2026-10-20 (kind `dinner`, 24 seats, `parent_event_id` the Money20/20 USA 2026 id, venue named but invented, `confidence` `invented`, its own cost), and Money20/20 USA 2025 (2025-10-26 to 2025-10-29, The Venetian, Las Vegas; real dates and city, price and cost sourced or left empty with `cost_note`; `confidence` as the existing rows use it).
  - `truth/dinner_guests.csv`: `event_id, person_id, company_world_id, status, invited_at, responded_at`; 38 to 44 people at fit companies, status one of `invited`, `registered`, `waitlist`, `declined`, `attended`, `no_show` (the dinner is past: no `invited` or `registered` rows remain; every state is present at least once; `waitlist` rows are people who were waitlisted and then declined or never moved, so the state exists in the data). Seats 24: attended plus no_show at most 24, the rest waitlist, declined.
  - `public/assessment_facts.json`: Money20/20 USA's assessment facts (ticket price, attendee mix by seniority and sector, what the organiser publishes, a source and a confidence for each; an empty value is `null`, never a guess; where a fact is not known the file says `unknown`). Written only from what `REAL_EVENTS` already holds and clearly labelled invented values.
  - `public/sponsorships.csv` and `public/talks.csv`: one sponsorship (package, price in USD, the standard deliverables, status `confirmed`) and one talk (title, speaker from `team.csv` with an Events Desk role, status `accepted`, session date) for Lumen Ledger at one conference (SaaStr Annual 2027, the next that fits; a sponsorship price is invented and labelled so).
  - `truth/event_targets.csv`: `event_id, company_world_id, person_id, why, likelihood`. For each upcoming conference starting after now (AWS re:Invent 2026, Forrester B2B Summit 2027, SaaStr Annual 2027, Money20/20 Europe 2027): 30 to 40 companies likely to be there with no registration in the world yet (fit, region and theme as `attendance()` weights them), one finance or revenue person each, `why` a template sentence, `likelihood` `high` or `medium` from the same weights. This is what Events Desk writes as `targeted` members. No person appears who left the company before the event.
- Version 1.3.0 in `__init__.py`, a git tag `v1.3.0` and the release manifest. `python -m lumen_world slice RELEASE events_desk OUT` copies the new files. A test checks: 1.2.0 files unchanged, every guest and target person exists and held their seat then, every company id exists, seats and states as above, the guard (`guard.py`) finds no `truth` path in Events Desk's public files, determinism (build twice, same hashes). `stage/rehearse.py --verify` and `stage/audit.py` run unchanged and pass (the rehearsal does not read the new files).
- A decision in `docs/DECISIONS.md` (21) records the clock, the additive rule and the files.

### 13.3 Events Desk loads the world

- `samples/lumen-world/` is re-vendored from the 1.3.0 slice (`scripts/world-refresh.mjs` takes the tag `v1.3.0`; `PIN.json` records the tag and its commit). `world-slice.ts` verifies the new files by hash and counts.
- A demo loader (`src/server/seed-world.ts`, run by the demo seed under `WORLD=lumen`, the demo's default after this part; unset keeps today's seed) reads the slice and creates: the 18 world events with the world's own ids as `external_id`, kinds, dates and prices; attendance as the lists the desk would have received (contacts with their people, per event, for events that have started or have registrations); the Las Vegas dinner as a hosted event, child of Money20/20 USA, with its guests in the states above (guest `listed` for none); the 2025 Money20/20 USA event as a past, scored event with its cost lines; Money20/20 USA's assessment answers with their source and a "sample" mark where the world says `unknown` or invented; the sponsorship and the talk through the same tables the desk uses; the roster from `team.csv` and Lumen Ledger as the seller. The target members of 13.4 read `truth/event_targets.csv`. Today is `DEMO_TODAY=2026-11-24` under this seed. It never calls a vendor or a model; it is deterministic (a test seeds twice and compares a digest of every table it writes).
- The demo's existing events and scenarios (AWS re:Invent assessment in flight, the Orrery dinner) are kept where they do not clash with a world event; where one does (same conference), the world's row wins and the old seed row is not created, and the audits and tests that named it are updated in the same change, with the list in the decision.
- The loader never writes outside the demo's own database; nothing in it reads `truth/` except the two files above that the slice copies for this desk (`dinner_guests.csv`, `event_targets.csv`), whose use is the demo's seed of its own people.

### 13.4 Targeted members and the statuses (Events Desk)

- **Meanings sent.** `targeted`, `waitlist`, `declined`, with the six already sent. The adapter's map already holds them; the sweep stops skipping them.
- **Where they come from** (the sweep in `crm-sync.ts`, one member per event and address, the highest status wins by this order, low to high: `targeted` 0, `sent` 10, `responded` 20, `waitlist` 30, `declined` 35, `registered` 40, `no_show` 50, `attended` 60, `met` 70). A decline is a person's answer and so beats a send or a reply but never an attendance:
  - a hosted guest with status `listed` and an address is `targeted`; `waitlist` is `waitlist`; `declined` is `declined`; `invited` stays `sent`;
  - a contact of an event with an address, not dropped, whose company is a target account (tier A or B in the desk's own tiering, or Market Desk's tier under `market_desk`; or the company is on the event's target-account list for a hosted event), not enrolled, not replied, no meeting, is `targeted`, up to 500 per event in priority order (the cap bounds what is written to the CRM; the remainder are counted as `targeted_over_cap`);
  - a person on the suppression list (opt-out), or whose country the email rule blocks, is never `targeted` (a person Account Desk's own gate would refuse is not announced as a target): counted as `targeted_barred`;
  - the world's `event_targets.csv` people are contacts of their event in the demo, so they follow the same rule.
- **Released by the CRM, not by the clock.** `Crm.features()` reads `GET /definitions` `features.campaign_member_meanings` (cached 1 hour; an unreadable answer keeps the last good one and never releases). The sweep queues a row for one of the three only when the list names it; otherwise it counts `awaiting_contract` as in part 2. A row already queued when the CRM answers `unknown_status` for one of the three (or a CRM without the list) is set to the new outbox status `held` (migration 0060 adds the value), keeps its payload, counts no attempt and raises no failure; the drain's daily pass and any change in the feature list set `held` rows back to `queued`. A refusal of any of the other six stays a failure. A `held` row is cancelled ("superseded") when a newer row exists for the same member, and by erasure like every member row.
- **Checked equal.** The answer to a member write carries the status the CRM stored; for these three the adapter checks it equals the meaning sent and marks the row failed with "stored as <x>" when it differs (a person's own status labelled Declined with another meaning would otherwise win).
- **Moving on.** `targeted` to `sent` (enrolled), `registered`, `declined` and the rest are new rows (the key carries the sequence). The CRM move uses `update: true`.
- **What the CRM does with them.** Nothing: Events Desk owns the campaign, and the members are read-only to people in CRM Desk.
- **Counts.** `GET /api/integration` carries `members: {targeted, sent, responded, waitlist, declined, registered, no_show, attended, met}` across events, `awaiting_contract`, `held`, `targeted_barred`, `targeted_over_cap`, and the feature list read.

### 13.5 Account Desk: the pre-event trigger (option A)

- Signal type `event_targeted` ("Likely at an event": "Someone at the company is on the list of people we want to meet at an event the CRM records.", level person, weight 10, half-life 21 days) added to `EVENT_SIGNAL_TYPES`, and a second play `event_pre_event` ("Before the event"; hypothesis "A short note before the event, with a way to book time there, gets answered more often than one after it."; trigger `any_of: [event_targeted]`, `fit_tiers: [A, B]`, `min_priority: 20`, `within_days: 30`; personas revops, controller, cfo; max people 2; sequence: email `open` day 0, LinkedIn connect day 3 (SDR), email `follow_up` day 7; autonomy `draft`; urgent false; created live by `ensure_event_play` in the same way and only under `INTEGRATED_WITH=events_desk`). Alone, nothing changes.
- `MEMBER_SIGNALS` gains `targeted` ("is on the list for", `event_targeted`, strength 0.4); the external id keeps `member:<campaign>:<contact>:<status>`. `waitlist` makes no signal and is counted. `declined`: **stops a play.** The person's active or pending enrolments in `event_pre_event` and `event_follow_up` of that campaign are stopped with reason `declined_event` (a stop is the safe direction and the person can restart), the audit log records it, and a later `registered` from the same person makes a new signal and starts nothing by itself that the play's own rules would not start. A declined person gets no `event_targeted` or `event_registered` signal made from the older rows still in the feed.
- A person who moves from `targeted` to `registered`, `attended`, `met` or `no_show` has their pre-event enrolment stopped with reason `event_status_moved` (they answered; the follow-up play takes over by its own trigger).
- **Booking link.** The play's drafts name the event and carry its booking link, never a link Account Desk invented. The link comes from Events Desk: with `EVENTS_DESK_URL` and `EVENTS_DESK_READ_KEY` set, ingest calls `GET <url>/api/desk/campaigns/<campaign ref>` once per campaign per day and stores `booking_url`, the event name, dates and city in the signal's evidence. Without the settings, or when the call fails or the event has no link, the draft says that a reply will find a time, and no link is written (a test proves no link appears). A draft context field `event.booking_url` is added to the draft prompt's inputs, and the stand-in drafts of the pre-event play use the same fields.
- **A read for Events Desk.** `GET /api/desk/campaigns/<campaign ref>/plays`, with `Authorization: Bearer <DESK_READ_KEY>` (404 when the key is unset; a wrong key is 401), answers `{campaign_ref, plays: [{key, name, states: {proposed, approving, active, stopped, ...}, people: {pending, active, replied, stopped_declined, ...}}], as_of}`: counts only, no names or addresses, for the plays started from that campaign's signals. Migration 0040 adds `signals.campaign_ref` (nullable, set for member signals) and an index; a signal from before has none and is not counted.
- Decision 94 in Account Desk records: a declined person stops a play; waitlist makes no signal; the booking link comes only from Events Desk; and why the trigger is a member and not an account (CRM Desk members are people).
- Tests: targeted becomes a signal and a pre-event proposal for an A or B account and not for a C; waitlist counted, no signal; declined stops both plays' enrolments and records the reason; a moved status stops pre-event only; alone (no `events_desk`) the new signal types and play do not exist; the booking link present, absent, unreachable; the read endpoint's auth (unset 404, wrong 401, right 200), counts and no personal data in the body; the coverage gate stays 0 missing.

### 13.6 The deferral panel (Events Desk)

Under `account_desk`, the Outreach section's panel gains: the counts of people by status for this event (from the desk's own sync table, so it never waits on a network call); the booking link as a field a person sets (migration 0060 adds `events.booking_url`, validated as an http or https address, empty allowed) with a Copy button; and the play status read from Account Desk (13.5) as one line per play in words ("Before the event: 12 in the play, 4 waiting for approval, 1 stopped because they declined"), with "Play status unavailable" and the time of the last good read when the call fails. The read needs `ACCOUNT_DESK_URL` and `ACCOUNT_DESK_READ_KEY`; with `DESK_LINKS` only, the panel shows the link and the counts. The panel reads at most once a minute per event (cached), never blocks the page, and carries no names. Events Desk's own `GET /api/desk/campaigns/<crm campaign id>` (Bearer `DESK_READ_KEY`, 404 when unset) answers `{event, starts_on, ends_on, city, booking_url}` for Account Desk. Screens follow `BRYAN-DESIGN-INSTRUMENT.md` (status in ink, no pills or dots), checked at 1536 and 375 px; `design-lint` and `screen-copy` pass; no em dashes.

### 13.7 Tests (Events Desk)

`tests/member-statuses.test.ts` (each guest and contact mapping, the order of statuses, barred and over-cap counts, the feature gate, `held` set and released and superseded and erased, equal-meaning check, key sequence); `tests/world-load.test.ts` (the slice's hashes, the loader twice gives one digest, the 18 events, the dinner's states and seats, the 2025 row, no `truth` read beyond the two named files, the clock); `tests/desk-read.test.ts` (auth and body of the read, panel counts, play-status cached, unavailable text); `tests/integration-2b.test.ts` gains the rows for the held statuses; the CRM Desk contract tests run against a running CRM Desk (`origin/main`) for `targeted`, `waitlist`, `declined` where a CRM is available and skip otherwise (said in the report). Existing suites, both audits and design-lint stay green.

### 13.8 Not in this part

The four-desk rehearsal, Events Desk's journal steps in `stage/rehearse.py`, the demo snapshot and the film notes are part 4. A real Account Desk round trip over HTTP (both desks running) is part 4's rehearsal; part 3 tests the read with a stand-in server. No Render deploy.

### 13.9 Goldfish review of section 13 (fresh Opus, 2026-11-15): 2 Blockers, 11 Majors, 6 Nits, and what changed

This section overrides 13.1 to 13.7 where they differ. All accepted.

1. Clock file. 1.2.0 files stay byte identical, `public/clock.json` included. The date goes in a new `public/events_desk_clock.json` (`{"events_desk_today": "2026-11-24"}`), copied only into the `events_desk` slice.
2. The loader reads public files only. lumen-world publishes, for the `events_desk` slice only, `public/events_desk_attendance.csv` (event_id, name, title, email, company, domain, status, registered_at), `public/events_desk_guests.csv` (the dinner's guests, same columns plus invited_at, responded_at) and `public/events_desk_targets.csv` (event_id, name, title, email, company, domain, why, likelihood), all built from the world's people but carrying no person or company ids from `truth/`. `dinner_guests.csv` and `event_targets.csv` stay in `truth/` of the release for the world's own tests and are not copied to any slice. The `events_desk` slice's existing files do not change. The guard test covers Events Desk's vendored files and `seed-world.ts` reads nothing outside `samples/lumen-world/public`.
3. Adapter. Three changes, listed: the status map in `crm-desk.ts` gains `targeted`, `waitlist`, `declined` (today `meaning()` throws for them); a refused member write raises a typed error carrying `unknown_status` and `allowed_meanings` (today an untyped "refused: 422"); `updateCampaignMemberStatus` returns the stored status so the equal check can run.
4. Target rule. Not Market Desk's tier (12.1: unanswered). A contact is a target when `contacts.priority` is A or B or its company's `tier` is 1 or 2 (builder reads the columns and names the exact predicate in the decision); a hosted guest's list is the desk's global target-account list (`target_accounts`), as guests already are.
5. No leads. A `targeted`, `waitlist` or `declined` member row never calls `createLead` whatever `write_leads` says (the person is written as a contact only when the CRM already holds them; otherwise as today's member write does, no lead). A test proves it.
6. Erasure. Both cancel paths (`person-record.ts` by person, `operating.ts` by email) and the drain's erasure check cover `status IN ('queued','held')`; a test per path.
7. Booking link. Only the day-7 `follow_up` email may carry it (the copy gate refuses a link in an `open` email); the day-0 email says a reply will find a time. LinkedIn carries none.
8. One open play per account. Stopping a pre-event enrolment closes its account play (stopped, `close_reason` `declined_event` or `event_status_moved`) when no other enrolment of it is open, so `event_follow_up` can be proposed. Tests for both.
9. `ensure_event_play` adds each missing play, not only when `event_follow_up` is absent; a test on an install that already has `event_follow_up`.
10. Launch. Stated plainly: like `event_follow_up` (decision 69), `ensure_event_play` creates the pre-event play live and names its launcher; the setting is the decision. Every message still waits for a person's approval (autonomy `draft`). The 13.1 table is read that way.
11. Timing. Events Desk writes `targeted` (and moves guests to it) only within 45 days before an event's start and not after its end (`TARGET_LEAD_DAYS`, a constant in the desk's config); earlier, the person is not announced. Account Desk's `within_days` then fits. In the demo at 2026-11-24 only AWS re:Invent 2026 qualifies. `waitlist` and `declined` have no window.
12. `DEMO_TODAY` restamps plan and seed dates only; the sweep and views use the database clock. The loader seeds states explicitly (the dinner past, Money20/20 USA scored) so nothing depends on a clock; the spec no longer claims a global fixed clock for the demo.
13. Determinism. The digest of the loader's output leaves out generated ids and timestamps and keys rows by the world's ids.
14. The equal-status check stays as a guard; the stated reason is corrected: CRM Desk resolves by meaning first, so a person's label cannot win; the check catches an older CRM.
15. A campaign is queued only for events with at least one releasable member (built after the feature gate).
16. The dinner is past: guests are `registered`-then-`attended`, `no_show`, `waitlist`, `declined` (no `invited`), all four present. The 2026-12-01 hire in `team.csv` is dated after 2026-11-12: the statement reads "no history after now".
17. Tier filtering is in the play trigger, not in `ingest_members`.
18. The decision for removed seed rows is Events Desk decision 91; the sweep and world decisions follow in number (91 to 94). Migrations: Events Desk 0060, Account Desk 0040, no lumen-world migration.
19. The booking-link fetch runs before ingest's transaction opens.
Missing tests added: leads, held erasure on both paths, pre-event blocks follow-up, `ensure_event_play` on an old install, link refused in the open email, the sweep never moving a member below what the CRM holds when the feature list shrinks (rows not released stay `held`, nothing is sent lower).

### 13.10 What was built, and where it differs from 13.1 to 13.9 (Events Desk, 2026-11-15)

Built as 13.4 to 13.9 say: the adapter and the sweep (`crm-desk.ts`, `crm-sync.ts`, `crm-outbox.ts`), migration 0060, the vendored 1.3.0 slice, `worldData()`, `seed-world.ts`, the deferral panel and the two routes, tests `member-statuses`, `world-load`, `desk-read` and two cases in `integration-2b`. Decisions 91 to 94. Where it differs:

1. Migration 0060 also adds `events.external_id` (the world's id for an event), which 13.3 named without saying where it lives.
2. `held` rows are held in two places: before the call when the CRM's own list does not name the status, and after it when the CRM answers `unknown_status`. A list the desk could not read is no answer, so the CRM decides.
3. A member whose highest status is not yet released is written at the highest status that is (13.4 said only that the row is counted); it is never written lower than what was sent.
4. The 11 conferences were already the demo's events, so the loader keeps them and tags them; the world's attendance is loaded as contacts only for conferences with no list (none today) and as guests for the 7 hosted events. The demo's own Money20/20 USA customer dinner is not made under the world. See decision 91 for the list.
5. Money20/20 USA 2025 has no list, price or cost in the world, so it is scored with nothing to count and no cost line (13.3 said "with its cost lines"; the world has none).
6. The assessment answers are one source and one answer marked Sample: the world's facts do not address the seven directory questions.
7. The play status is on its own route (`/api/events/:id/desk-plays`), not in the panel's read, so the panel's counts and link show at once.
8. Roster and seller are read by `GET /api/world` (part 2) and used as owners and host names; no new tables hold them.
9. Not run: the CRM Desk contract tests against a running CRM Desk (`tests/crm-desk-contract.test.ts` skips without its variables), and Account Desk's side of the plays read (a stand-in server in the tests).


## 14. Part 4: the four-desk rehearsal, the real calls between the desks, the snapshot and the film notes (spec written before code, 2026-11-15)

Four repositories change, in this order of landing: `crm-build` (one small replay change), `lumen-world` (rehearsal steps, a check, a wiring proof), `outbound-desk` (Account Desk: one change from part 3's leftovers) and `events-desk` (this one). Nothing in this part changes what a person sees on a screen, so the design instrument and the design lint are run but nothing new is designed; the one exception is the demo snapshot, which is rebuilt (14.7).

### 14.1 Who does what (the centaur)

| Step | Agent | Person |
|---|---|---|
| Write campaigns, members (targeted, waitlist, declined, registered, attended, no show) and activities to CRM Desk | Events Desk's sweep and outbox, the same code a live install runs | Sets the plan, the targets, the booking link; nothing here sends an email |
| Read the booking link, start the pre-event note, stop it on a decline | Account Desk (reads Events Desk, drafts) | Approves every message; the rehearsal sends none |
| Read the play status | Events Desk (reads Account Desk, counts only) | Decides what to do with a stalled play |
| Say whether the four desks agree | `stage/audit.py` (reads, changes nothing) | Reads the result |

### 14.2 Events Desk's half of the journal (lumen-world `stage/rehearse.py`, Events Desk `scripts/rehearse.ts`)

The rehearsal does not write Events Desk's calls by hand: it runs Events Desk. `scripts/rehearse.ts` (new, Events Desk) migrates its own database, runs `seed()` on the world (`world: true`, the demo's default), sets `deps.crm = crmDeskCrm(CRM_DESK_URL, CRM_DESK_KEY, journalFetch)`, then runs `syncCrm` and `drainOutbox` until the outbox is empty or stuck, and prints one JSON line (counts: campaigns, members by status, activities, held, failed, refused). It never calls a vendor or a model (the demo's stand-ins). `journalFetch` (new, `src/server/journal-fetch.ts`) wraps `fetch`: it appends a line to the file `EVENTS_JOURNAL` for every call that writes (any method but GET, except the two reads made with POST, `/contacts/contactability` and `/accounts/lookup`), in the shape the other desks use: `{actor: "events_desk", method, path (without /api/v1), body, status, answer}` and an `idempotency_key` when it sent one. `at` is not written by the script: the runner fills it from CRM Desk's clock (`app_now()`), as it does for the website forms. The runner appends these lines to the journal after the website forms and Market Desk's MQA and before Market Desk's pull.

What the journal must contain (the runner stops if any is absent): a campaign create for each event with someone to write; a campaign create with `parent_id` for the Las Vegas dinner (parent: Money20/20 USA 2026's campaign) and `type: event` or `webinar` as the event's kind says; members at `targeted`, `waitlist`, `declined`, `registered`, `attended` and `no_show`; activities with an `external_id` beginning `events_desk:`. A call CRM Desk refuses is journaled with its status; the run stops on any refusal other than a named one: `already_member`, `erased`, and `unknown_status` for a status CRM Desk does not name (none today). The count of refusals is reported.

CRM Desk's replay (`src/crm/sim/lumen.py`) learns one actor: when the journal holds `events_desk` steps it makes a fifth key (`--desk events_desk`, after the four it makes today, in the same order the rehearsal makes it), sends those steps with it, and does not move the clock for them (as Account Desk's and the website's). Without `events_desk` steps nothing changes: every existing journal replays as before.

### 14.3 What the rehearsal's clock does to Events Desk

Events Desk keeps `public/events_desk_clock.json` at 2026-11-24 and its SQL uses the database's `current_date` for the 45 day target window (13.4). The rehearsal runs on the wall clock, so *which* of the 142 targets are written depends on the day it is run; the journal is the record, and `--verify` replays the journal, not Events Desk, so the verification does not depend on the day. CRM Desk does not refuse an activity dated after its own now (the rehearsal's CRM sits at 2026-11-12 14:00 UTC), but its audit rule "nothing is dated after now" would then fail. So before the drain `scripts/rehearse.ts` cancels every queued activity whose time is after `EVENTS_NOW` (the CRM's now, given by the runner) with the reason `after the CRM's clock`, and reports the count by kind; those rows are not written, not hidden. No audit rule is loosened. The world clock is not moved here (the question is with Bryan).

### 14.4 Verification and the audit

`--verify` rebuilds each desk from its half: CRM Desk's half now includes the `events_desk` steps. `SAME["crm"]` gains the ids of campaigns and campaign members (`external_refs` is already counted), so a replay that differs on Events Desk's writes fails. Events Desk is not replayed (its demo seeds from the world, not from a journal); `--verify` says so in its output. `stage/audit.py` gains check 10, which runs when Events Desk's journal is present: every campaign written under `events_desk:` has a type of `event` or `webinar`; the dinner's campaign has its parent; the members at `waitlist`, `declined` and `targeted` are present for the dinner and the four coming conferences and none is counted as a response (the CRM's `responded` flag); no activity written by Events Desk is dated after now; no member's contact is marked do-not-contact or unsubscribed; every member's contact exists. The 9 earlier checks are untouched and must still pass: `audit.py` prints today no count line; it gains one ("N of M checks passed, K skipped: <names>"), where M counts only the checks that ran. The "9 of 9" in the status files is the 4 that always run plus the 5 that need Account Desk's database; the tenth runs only with Events Desk's journal.

### 14.5 The real calls between the desks (`stage/wire.py`, new)

After the rehearsal, with its databases still there, the runner (`python stage/wire.py`) starts: CRM Desk on its own port; Events Desk (`node src/server/node.ts` on its rehearsal database, not `--demo`, `CRM=crmdesk`, its key, `INTEGRATED_WITH=account_desk,market_desk,crm_desk`, `DESK_READ_KEY`, `ACCOUNT_DESK_URL`, `ACCOUNT_DESK_READ_KEY`); Account Desk (its server on a copy of the rehearsal's database, `INTEGRATED_WITH=events_desk,market_desk,crm_desk`, `CRM=crmdesk`, `EVENTS_DESK_URL`, `EVENTS_DESK_READ_KEY`, `DESK_READ_KEY`). Keys are made by the runner for this run and never printed. It proves, with real HTTP and no stand-ins:

1. Events Desk answers `GET /api/desk/campaigns/<crm campaign id>` with the right key (the event, dates, city, `booking_url`), 401 with a wrong key and 404 where no event has that campaign.
2. Account Desk's `event_link.event_for` reads that answer over the network and a draft sentence carries the booking link (the day-7 email only, as decision 94 says).
3. Account Desk reads the targeted members from CRM Desk and makes `event_targeted` signals; a member the CRM holds at `declined` makes none.
4. A person who was targeted and is then written `declined` by Events Desk has their stored signal set aside by Account Desk's next read.
5. Events Desk's `GET /api/events/<id>/desk-plays` (play status) reads Account Desk's `GET /api/desk/campaigns/<ref>/plays` and returns lines; with a wrong key it says `unavailable`, with none `off`.

Not proven by this runner, and said so in the status: a send (nothing here sends), a play running for days on Account Desk's own clock, and Render.

The CRM Desk contract tests run against the live CRM Desk of the same run: Events Desk's `tests/crm-desk-contract.test.ts` (with `CRM_DESK_URL`, `CRM_DESK_KEY` made `--desk events_desk`, `CRM_DESK_ADMIN_KEY`) and Account Desk's `tests/test_crm_contract.py`. Their pass counts and skips are recorded.

### 14.6 Part 3's leftovers

- Account Desk (`pipeline.py`): the Events Desk HTTP call (`_events_for` to `event_link.event_for`) ran inside `crm_sync`'s transaction, which holds the deal, owner and account rows it has written. It moves to its own job, `crm_members`, enqueued by `crm_sync` only when `INTEGRATED_WITH` names Events Desk (a dedupe key keeps it to one), so an Account Desk without Events Desk runs the same jobs as before and the deterministic demo is unchanged. The new job holds no row but its own job row while it waits on the network; the day's answer is still written on its own connection. `tests/test_event_pre_event.py` and any test that expected members ingested inside `crm_sync` call the new handler.
- Events Desk: a test for `deskCampaignRead`'s key compare (equal, different length, same length and one character different, empty, a different scheme word, extra spaces) and that a key with trailing spaces in the environment is trimmed; `same` is exported for it.
- `npm ci` in the main checkout `~/Developer/events-desk` (offline-safe: if the registry is unreachable the result is reported, not hidden), and the four `ev6d_` databases on port 54329 dropped (done before this spec was written: `ev6d_test_050be480`, `ev6d_test_c75086d1`, `ev6d_demo_6d502801`, `ev6d_demo_d704887a`).

### 14.7 The demo snapshot and the film notes

`make demo-snapshot` is rebuilt on the world build: the snapshot's world is the vendored 1.3.0 slice with the clock at 2026-11-24. The new snapshot is checked by opening the demo from it (the world's events are there, the dinner has its 40 guests, health answers) and the design lint and screen copy pass. It is committed with the status. Film notes (`docs/FILM-NOTES.md`, new): the shot list for the four-desk story with what each shot proves and where its data comes from, in Bryan's words rules (no em dashes, facts only, placeholders where unknown); no film is made here.

### 14.8 Tests and gates

New: Events Desk `tests/journal-fetch.test.ts` (what is journaled and what is not, the shape, no key or header written), `tests/desk-read.test.ts` (the key compare), a test of `scripts/rehearse.ts` against a stand-in CRM server (the line shape and the required statuses); lumen-world `tests/test_rehearsal_events.py` for the pure parts (merge of journal lines, the required-contents check, check 10 on small fixtures); Account Desk a test that the Events Desk call is outside `crm_sync` and the new job runs it; CRM Desk a replay test with a small `events_desk` journal. Before each push: the full suites (Events Desk with `--testTimeout=60000`), tsc, ruff, both Events Desk audits on a fresh server, the Account Desk coverage gate (0 missing), the rehearsal `--verify` and the audit. An Opus code review of the diffs.

### 14.9 Not in this part

Moving the world clock; a sending Events Desk under `INTEGRATED_WITH=account_desk` (it is off by design, 13.1); Market Desk's tier replacing the priority-or-tier rule (cross-repo item 11, still open); a rehearsal in which Account Desk reacts to Events Desk's members over days (the wiring proof shows one read and one stop, not the weeks); Render deploys (not deployed: deploys are manual); new screens.

### 14.10 Goldfish review of section 14 (fresh Opus, 2026-11-15): 1 Blocker, 8 Majors, 6 Nits, and what changed

- Blocker: CRM Desk does not refuse future-dated activities, and audit check 2 would fail on them. Changed: 14.3 (rows after the CRM's now are cancelled by the driver with a reason and counted).
- `seed()` needs `{ real: true, today, world: true }`; `rehearse.ts` uses exactly that. The driver uses Postgres (database `ev6p4_events`), not PGlite, so `wire.py` can start the server on it.
- The demo's sends, meetings and debriefs come from the demo motion at server start, not from `seed()`. The driver therefore calls the same motion code when it can; whatever activities exist are what is written, and the required-contents list for activities is reduced to "if any exist, each has an `external_id` beginning `events_desk:`". Campaigns and members (all six statuses, the dinner's parent) stay required.
- No seed sets `booking_url`: `wire.py` sets one through the API before proofs 1 and 2. Proof 1 uses a top-level event (the dinner is a child and answers 404 by design).
- The fifth key is made in the rehearsal's key block (before the `sequence` line), as the fifth, only when Events Desk steps follow; the replay mirrors that.
- Order: `--verify` and `audit.py` run before `wire.py`; `wire.py` works on copies (`ev6p4_wire_*`) of the CRM and Account Desk databases, so the audit never reads what the wiring changed.
- 14.6 corrected: the new job holds no deal, owner or account row (it writes its own settings and signals only); the tests to update are `tests/test_event_pre_event.py` (its `sync` helper) and the Events Desk cases in `tests/test_crm_world.py`; `sim/runner.py` calls `crm_sync` directly and stays unchanged because the job is enqueued only when `INTEGRATED_WITH` names Events Desk.
- Nits taken: no idempotency key is sent by Events Desk (clause removed); the key-compare and journal tests extend `tests/desk-read.test.ts`; the journal summary line lists `events_desk`.

### 14.11 What was built, and where it differs from 14.1 to 14.10 (2026-11-15)

Built as 14.2 to 14.7 say: `scripts/rehearse.ts` and `src/server/journal-fetch.ts` (Events Desk); the `events_desk` actor and fifth key in CRM Desk's replay (`crm-build` `src/crm/sim/lumen.py`); `events_half`, `check_events_lines` and the `--no-events` flag in lumen-world `stage/rehearse.py`; `events_repo` and `run_events` in `stage/desks.py`; audit check 10 and a summary line in `stage/audit.py`; `stage/wire.py` and `stage/contract.py`; Account Desk's `crm_members` job (decision 95 there); the key-compare tests; the rebuilt snapshot; `docs/FILM-NOTES.md`. Decision 95 here. Where it differs:

1. The activities in the journal are few (2 in the final run: one meeting and one send): the demo's sends, replies and debriefs come from the demo pipeline. The script writes 30 sends and three held meetings as the desk's own rows (decision 95); most of those people are not in the CRM, so only one meeting and one send reach it. This is the weakest part of the rehearsal's coverage of 14.2 and is said in the status.
2. Guests who waited or declined are written as leads first (decision 95), which 14.2 did not say; without it the CRM held none of the dinner's declined guests and the required statuses could not be written.
3. CRM Desk's replay test (14.8) is not a unit test: the replay is proved by `--verify` (CRM Desk identical on 7 checks, including the campaign and member ids).
4. `wire.py` clears Account Desk's member cursor before the decline is read, because CRM Desk's clock stands still in a rehearsal and the decline carries the same time as the target before it; with a running clock the cursor reads it.
5. The wiring proofs read one event's play status: after the decline the play is stopped, and Events Desk says so in words.
6. `--verify` replays CRM Desk, Market Desk and Account Desk; Events Desk is not replayed (said in 14.4).
7. The journals the rehearsal regenerates are not delivered to the desks' `world/` folders: Account Desk's coverage gate shows 1 scenario missing on a build from them (a chance scenario), 0 missing on the committed journal. Copies are in `~/Developer/.wt/ev6p4-journals/`; it is a decision for Bryan.
8. From the Opus code review of the diffs: the rehearsal enables `write_leads` on every event (so the `write_leads=false` path is not run by it; the tests cover that path); rows to an address that is not `.example` are cancelled and counted separately (`cancelled_not_example`); `scripts/rehearse.ts` takes only a database that starts with the runner's prefix (`EVENTS_DB_PREFIX`, set by `stage/rehearse.py`); audit check 10 now checks every member's contact for do-not-contact and unsubscribe and the summary line names what was skipped; the promised test of `rehearse.ts` against a stand-in CRM server was not written (the run against a live CRM Desk is the proof); `wire.py` check 2 proves the booking link was read and kept, not that a draft sentence carries it (decision 94's test covers the sentence); the member job holds plays and signals from earlier batches while a later batch of over 200 members waits on the network (decision 95 says "no deal, owner or account row", which holds).
