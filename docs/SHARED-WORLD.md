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

- `samples/lumen-world/` holds a copy of `events.csv`, `team.csv` and `manifest.json` from `lumen-world` `release/world-v1.1.0/public` at commit `400566a`, and `PIN.json` (repository, commit, release, files and their SHA-256). It is a copy, not a link: Events Desk must run without that repository. `src/server/world-slice.ts` reads and checks it (hash per file, format version, the 18 events: 11 conferences, 5 webinars, 2 dinners), exposes `worldSlice()`, and `scripts/world-refresh.mjs` re-copies it from a checked-out `lumen-world` tag and rewrites the pin. The code and status of `lumen-world` say 1.2.0 but only v1.1.0 is a tag, so the pin is the commit.
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
