# Hosted events (redesign step 2)

Spec written 2026-11-14 before any code. Plan sections 3 and 6.3, decision 6, and the notes "Decided by Bryan" and "What the community voice changes" in `~/Developer/events-rethink/PLAN.md`. Step 1 is `docs/EVENT-PLAN.md`. Migrations `0053` and up.

## 1. The job

An event the team hosts (dinner, side event, roadshow stop, webinar, customer event) runs from a guest list to a result in one place:

1. **Guest list.** People come from target accounts and open deals, from nominations by account executives (AEs), or from a Luma or Splash CSV. Every guest has exactly one owner.
2. **Invitations** go out personally from the host's own mailbox with the desk's RSVP link. The desk drafts the text from a template, the host sends it, and the desk logs that it went. The desk never sends an invitation.
3. **RSVP** on a public page, one link per guest: yes, no, dietary needs.
4. **Waitlist** when the yes answers reach the capacity (the hosted involvement's `headcount`).
5. **Reminders and logistics** go only to people whose status is `registered`, from a transactional sender that is not the sequencer.
6. **Expected no-shows**: a stated default the planner can change, replaced by the team's own history once there is some.
7. **Venue**: minimum spend, headcount guarantee date, cancellation steps, on the budget line from step 1.
8. **Check-in on a phone** against the guest list, walk-ins added, seating by the host.
9. **After**: attended and no-show are two follow-up groups; each guest's owner gets the notes; a co-hosted event carries a cost split and a lead-ownership rule.
10. **Webinars**: import registrants and attendance. No hosting: no invitations, no check-in, no seating.

## 2. Words used here

- **Guest**: a person on a hosted event's list. One row per person per event. Not a `contacts` row (those belong to an attendee list); a guest has no source row.
- **Owner**: the one team member who answers for the guest (the AE for an account, the nominator for a nomination, the importer for an import until reassigned). Never empty, never two.
- **Host**: the person whose mailbox sends the invitation, from `event_people` with the `host` role. The event's `host_email` is the mailbox the template names.
- **Registered**: the guest said yes and there was room. **Waitlist**: said yes, no room.
- **Transactional sender**: the one module that mails people who asked for the mail (a confirmation, a reminder, a seat that opened). It is not a sequence, has no cadence and no cold step.
- **Country rules**: `config/defaults.json` `email_country_rules.blocked` (a list of ISO codes, the same defaults Account Desk ships: IT, CH, SE, DK, BE, AT, NO, plus DE, which Bryan named as a hard no). A guest whose country is in that list, or unknown, is never emailed by the desk.

## 3. Must not change

All ten items of `EVENT-PLAN.md` section 3 hold. In addition:

1. `src/server/gate.ts`, `sequences.ts`, `sending.ts`, `ledger.ts`, `paid.ts` and `spend-guard.ts` are not edited. Hosted guests are not gate subjects (the gate reads `contacts` and the sequences' consent and legal-basis machinery). The country rules are the whole of the desk's outreach check for hosted events (Bryan, 2026-11-13).
2. A reason on every drop, enforced by the database: removing a guest needs a reason (`event_guests_removal_has_reason`).
3. Money keys carry `cents` so `forRep` strips them; venue minimum spend and the co-host split read through `forRep`. `tests/rep-sees-no-money.test.ts` gains the new reads.
4. Hosted events already seeded (the dinners, the roadshow, the side dinner) keep reading as before; a hosted event with no guests reads "No guests yet", never an error.
5. The public demo still refuses uploads (the Luma and Splash import is an upload) and webhooks.
6. Events Desk runs alone. `INTEGRATED_WITH` unset changes nothing. With it naming `account_desk`, the sequencer is not this step's concern (step 6); the transactional sender and the invitation log keep working.

## 4. Data model: `0053_hosted.sql`

All ids are `text` from `newId`. All money integer cents. Everything cascades from `events`.

**`target_accounts`** (the accounts a guest list is built from; alone, uploaded or typed; with the CRM, copied from it)

| Column | Rule |
|---|---|
| `id`, `name` (non-empty), `domain` (lower-case, nullable), `country` (ISO code, nullable), `owner` (text, nullable), `open_deal` (text, nullable), `deal_stage` (text, nullable), `source` in `upload, crm, market_desk, manual`, `created_by`, `created_at` | unique on `lower(name)` |

**`hosted_events`** (one row per hosted event; written when the first hosted read or write needs it)

`event_id` PK; `capacity integer` (null reads from the hosted involvement's `headcount`); `noshow_pct integer` (null = default or history; CHECK 0 to 90); `host_name text`; `host_email text`; `doors_at text` (`HH:MM`, event-local); `address text`; `welcome text` (one line the RSVP page shows, at most 300 characters); `closed_at timestamptz` (when attendance was closed and the no-shows decided); `rsvp_open boolean default true`.

**`event_guests`**

| Column | Rule |
|---|---|
| `id`, `event_id` | |
| `name` NOT NULL non-empty, `email` (lower-cased, nullable), `company`, `title`, `country` (ISO code or null) | |
| `account_id` | references `target_accounts` ON DELETE SET NULL |
| `owner` NOT NULL non-empty | one owner |
| `side` | `us` or `partner`, default `us` (co-hosted lead rule) |
| `source` | `account, deal, nomination, luma, splash, walk_in, manual` |
| `nominated_by` | text, nullable |
| `status` | `listed, invited, registered, waitlist, declined, attended, no_show`, default `listed` |
| `rsvp_token` | text UNIQUE NOT NULL, 24 random bytes as base64url (192 bits) |
| `dietary` text default '', `decline_note` text default '' | |
| `invited_at`, `rsvp_at`, `waitlisted_at`, `checked_in_at` | timestamptz |
| `checked_in_by` text | pair CHECK with `checked_in_at` |
| `seat` text default '' | the host's table or seat, free text |
| `notes` text default '' | the host's notes for the owner |
| `removed_at`, `removed_reason` | CHECK both or neither; reason non-blank |
| `created_by`, `created_at` | |

Indexes: `(event_id)`; unique `(event_id, lower(email))` where `email IS NOT NULL AND removed_at IS NULL`; unique `(event_id, lower(name), lower(company))` where `removed_at IS NULL AND email IS NULL`.

**`guest_log`**: `id, event_id, guest_id, kind, detail, actor, at`. Kinds: `invitation_logged, status, reminder, seat_open, owner, note, import, walk_in`.

**`guest_invitations`**: `id, event_id, guest_id, sent_by, sent_on date, mailbox text, logged_by, logged_at`. A guest may have several (a second nudge); the desk shows the last.

**`reminder_runs`**: `id, event_id, kind` (`reminder, logistics`), `subject, body, created_by, created_at, sent_count, skipped jsonb` (`{reason: count}`). **`reminder_sends`**: `id, run_id, guest_id, email, sent_at, outcome` (`sent, failed`).

**`event_venues`**: `event_id` PK, `name, address, budget_line_id` (references `budget_lines` ON DELETE SET NULL), `minimum_spend_cents bigint`, `guarantee_headcount integer`, `guarantee_by date`, `note`. **`venue_cancellation_steps`**: `id, event_id, position, by_date date, rule text, fee_cents bigint`.

**`cohosts`**: `event_id` PK, `partner text`, `our_share_percent integer CHECK 0..100`, `lead_rule text CHECK IN ('own_invites','by_account','partner_keeps_theirs')`, `note`.

**`transactional_outbox`**: `id, event_id, guest_id, kind, to_email, subject, body, state` (`queued, sent, failed`), `provider_ref, created_at, sent_at`. The simulated sender and the live one both write here first, so a test can read exactly what went out.

Backfill: none. No existing event has guests.

## 5. The RSVP state machine (`src/shared/rsvp.ts`, pure)

States and the moves each who may make:

| From | To | Who |
|---|---|---|
| `listed` | `invited` | the host logs an invitation |
| `listed`, `invited` | `registered` or `waitlist` | the guest answers yes (waitlist when registered count is at capacity) |
| `listed`, `invited`, `registered`, `waitlist` | `declined` | the guest answers no |
| `declined` | `registered` or `waitlist` | the guest changes to yes |
| `registered` | `declined` | the guest changes to no; the first waitlisted guest is promoted to `registered` in the same transaction |
| `waitlist` | `registered` | promotion, or the host moves them |
| `listed, invited, registered, waitlist` | `attended` | check-in (the host) |
| `attended` | `registered` | undo a check-in made by mistake |
| `registered` | `no_show` | closing attendance, only after the event's last day or by the host's "Close the door" on the day |
| `no_show` | `attended` | the guest arrived late and was checked in after closing |

Anything else is a refusal with one sentence. `transition(from, to, ctx)` returns an error string or null and is used by every writer. A guest cannot be `attended` and `declined` at once: status is one column.

Answering yes after the event's day began is refused ("The date has passed"); the page then shows the guest's last answer, read only. `rsvp_open = false` refuses new yes answers (the page says the list is full; a no is always accepted).

## 6. The public RSVP link

- **URL** `/rsvp/<token>`. The token is 24 random bytes from `crypto.randomBytes`, base64url, stored as `rsvp_token`. It encodes nothing and is not derived from an id, name or email. 192 bits is not guessable.
- **Routes** `GET /api/rsvp/:token` and `POST /api/rsvp/:token`. They need no actor and no write key (the guest has neither). They are the only `/api` writes that do not, and they are named in the app's middleware by exact pattern.
- **A bad, unknown, removed or malformed token** answers the same `404` body, `{"error":"This link is not valid."}`, with the same timing class (one indexed lookup). Per address, more than 30 bad tokens a minute answers `429`. The lookup is keyed on the token only.
- **The response reveals**: the event's name, day, doors time, venue name and address, the host's name, the welcome line, the guest's own first name and status, their own dietary note, and whether the list is open. It never carries: any other guest, the owner, the account, a company, the event id, a guest id, any money, any count of other guests.
- **POST body** `{ answer: "yes"|"no", dietary?: string (at most 300), note?: string (at most 300) }`. The answer is recorded in `guest_log` with actor `guest`. Dietary text is stored as typed, escaped on display.
- Public demo: allowed (it stores into the demo's database; the per-address write limit already applies). Imports are refused there.

## 7. Invitations

- The host's template is fixed text with the event, day, venue, a sentence from `welcome`, the guest's first name, and the RSVP link (`APP_URL` or the request's origin, plus `/rsvp/<token>`). No model writes it (the Yuno rule).
- `GET /api/events/:id/guests/:gid/invitation` returns `{ subject, body, link }`, refused with the reason when the country rule blocks the guest.
- `POST .../invitation` (`{ sent_on?, mailbox? }`) logs it: `guest_invitations` row, `invited_at`, status `listed` to `invited`, a `guest_log` row. It is refused for a guest whose country is blocked or unknown ("Email in Germany needs a region rule first", the Account Desk's own wording) and for a guest with no email. The owner or the host or a planner may log it; nobody else.
- A guest list row says whether the invitation went and when ("Invited 12 Nov by Camille"). Nothing the desk does sends it.

## 8. Reminders and logistics (the transactional sender)

- `reminderPreview(db, eventId, kind)` returns the audience and the text. The audience is guests with status exactly `registered`, with an email, whose country passes the rules. Everyone else is counted by the reason they were skipped (`not_registered`, `no_email`, `country`), never mailed.
- `sendReminder(db, deps, eventId, kind, actor)` writes `transactional_outbox` rows and hands each to `TransactionalSender.send`. The send is idempotent per `(run, guest)`.
- Text: fixed templates (`reminder`: day, doors, address, the RSVP link to change the answer; `logistics`: the host's free-text note added by a planner or host, at most 600 characters, wrapped by the same fixed frame).
- The sender is an interface in `src/server/transactional.ts`. The demo and tests use a simulated one. Live mode uses `TRANSACTIONAL_URL` and `TRANSACTIONAL_KEY` (a JSON POST); nothing else is assumed about the provider. The live path is not proven against a provider and the README says so.
- **It does not depend on the sequencer.** `integratedWith()` reads `INTEGRATED_WITH` (comma list; stubbed here until step 6 provides the setting). `sendReminder` runs whatever it names. A test sets it to `account_desk` and the reminder still goes.
- A seat that opens (a registered guest declines, the first waitlisted guest is promoted) sends one `seat_open` message through the same sender, to that guest only.

## 9. Expected no-shows

- Default `hosted.noshow_default_pct` in `config/defaults.json` is **20** (a stated starting guess; Pheedloop's medians of 28 percent for free events and 37 percent for 10 to 49 people are a reason to over-confirm, not a forecast for an invited dinner).
- The planner may set `hosted_events.noshow_pct` for the event.
- **History replaces the default** once the team has at least `history_min_events` (2) hosted events with attendance closed and at least `history_min_yes` (10) guests who had said yes across them: the rate is no-shows divided by those who had said yes. The page says which one it is using ("Your own events: 4 of 31 said yes and did not come").
- Reads return `{ rate_pct, basis: "default"|"set"|"history", yes, expected_attending, confirm_to_fill }` where `confirm_to_fill = ceil(capacity / (1 - rate))`, the number to over-confirm to.

## 10. Venue and budget

- `event_venues` attaches to a budget line the plan already has (category `dinners` or `other`), so the venue minimum is a field of an existing line, not a second amount. It adds nothing to the planned total.
- Reads give: the minimum spend, the headcount guarantee, its date, the cancellation steps in date order, the next date that matters and how many days away it is, and "Registered 9, expected 7 at 20 percent, guarantee 10 by 3 Dec".
- A date that matters and is within seven days enters the week's deadlines (`weekDeadlines`) as a deadline of kind `venue`, read, not stored twice (decision 57). It leaves when the date passes or the event is declined.
- All keys that hold dollars end in `cents`; `forRep` strips them. The headcount guarantee and the dates are not money and stay.

## 11. Check-in on a phone

- One screen, the guest list sorted for the door: name first, search first, one tap to check in. Primary action: Check in. A walk-in is added from the same screen (name, company, one owner defaulting to the host, optional email) and arrives `attended` with `source = walk_in`.
- Seating: the host sets `seat` per guest, free text. Not required to check in.
- Check-in is written by anyone acting as someone on the event's people list or a planner or lead; undo restores `registered`.
- The screen works at 375 px with no horizontal scroll and tap targets of at least 44 px. It shows counts: in, expected, over capacity.

## 12. After the event

- `closeAttendance(db, eventId, actor, today)` marks every `registered` guest `no_show` (sets `hosted_events.closed_at`). It refuses before the event day. A guest on the waitlist, `listed`, `invited` or `declined` stays what they were.
- `followUp(db, eventId)` returns two groups: **attended** (with who they are, their owner and the host's notes) and **no_show**, each with a count and the fixed follow-up wording (thank you, and "we missed you"), each guest with their owner. Waitlist and no-answer are shown apart ("Did not answer") and not followed up as either group.
- Each guest's owner gets the notes: closing writes one `guest_log` row of kind `note` per guest with notes, and queues a notification to the owner when the owner maps to a Slack user. The owner's list (`GET /api/hosted/mine`) shows their guests across events with status, notes and the group.
- The follow-up text is a template the owner copies and sends from their own mailbox; the desk queues no email to either group. Cold follow-up of the no-show group is outbound and belongs to Account Desk when it is connected (decision 6); alone, it is the owner's mailbox.
- Co-hosted: `cohosts` row gives our share percent. The cost the event shows is the whole cost with "Our share" next to it, both through `forRep`. Lead ownership: `own_invites` (each side keeps the guests it invited: `side`), `by_account` (the account's owner side keeps all guests of that account), `partner_keeps_theirs` (partner's guests are the partner's; ours stay ours). The follow-up lists each guest with `side` and says which side follows up.

## 13. Imports

- `POST /api/events/:id/guests/import` takes a CSV body or file (`source`: `luma` or `splash`), the same body limit as the other file routes. Refused in the public demo and for a webinar's wrong kind of use only when it is not a hosted event.
- Header detection is by name, case-insensitive, trimmed: Luma `name | first_name, last_name | email | approval_status | checked_in_at | ticket_name | created_at`, Splash `First Name, Last Name, Email, Company, Title, Status, Attended`. A row with no email and no name is skipped and counted; a row whose email already exists on the list updates status only if it moves forward (registered to attended) and is counted as "already there".
- Luma `approval_status` `approved` or blank and Splash `Registered` mean `registered`; `declined`, `rejected` or `Not attending` mean `declined`; `pending`, `waitlist` or `Waitlisted` mean `waitlist`; a `checked_in_at` value or Splash `Attended` of yes means `attended`. An unknown status is not guessed: the row is skipped with the value shown.
- Owner: the importer. Country is read from a `country` column when present; otherwise null (an imported guest is never mailed by the desk until a country is set, per the rules in section 2, but is still imported and followed up by the owner).
- Imports log one `guest_log` row of kind `import` with the counts.
- A webinar's attendance may come in a second import of the same shape: statuses move only forward.

## 14. Target accounts

- `POST /api/target-accounts/import` (CSV: `name, domain, country, owner, open_deal, deal_stage`) and `POST /api/target-accounts` (one). Alone, these are the only way in; with a CRM connected and `CRM=crmdesk`, the same table can be filled from its accounts (not built in this step: the route is the seam and the README says so).
- `GET /api/events/:id/guests/suggestions` lists target accounts with an open deal or an owner that are not already on the event's list, with their owner. "Add" creates a guest placeholder (a person is needed to invite: name and email are required to invite, not to list, so a company-only placeholder may be added with a contact name typed by the owner). The list never adds a person without an owner.
- A guest nominated by an AE records `nominated_by` and takes the nominator as owner by default.
- Two pools (a conference's attendees plus local people) stay possible: a hosted event with `conference_event_id` offers that conference's tier 1 companies as suggestions too. This is the community-voice note and is a suggestion list only.

## 15. Server modules and routes

New: `src/shared/rsvp.ts` (states, `transition`), `src/shared/country-rules.ts` (`emailAllowed(country)`, the reason words), `src/server/hosted.ts` (guests, invitations, seating, check-in, walk-ins, closing, follow-up, estimates, venue, co-host), `src/server/rsvp.ts` (the public link, rate limit), `src/server/transactional.ts` (interface, simulated, live), `src/server/guest-import.ts` (Luma and Splash), `src/server/hosted-routes.ts`, `src/server/integration.ts` (`integratedWith`). Touched: `app.ts` (mount, the two public paths in the actor middleware, the import path in the public demo refusal and the file-route size), `plan.ts` (`eventDeadlines` joins venue dates; `planWaitingOn` for a hosted event reads the guest list), `seed-year.ts` and `seed-plan.ts` (the dinners), `defaults.json`, the client.

Routes (all but the first two need an actor; writes need the write key as today):

- `GET|POST /api/rsvp/:token`
- `GET /api/events/:id/hosted` (the whole page: guests with statuses, counts, estimate, venue, cohost, reminder state; a rep reads it through `forRep`)
- `PATCH /api/events/:id/hosted` (capacity, `noshow_pct`, host, doors, address, welcome, `rsvp_open`)
- `POST /api/events/:id/guests` (one or a nomination), `PATCH .../guests/:gid` (name, email, company, title, country, owner, seat, notes, dietary, side), `DELETE .../guests/:gid` (reason in the body)
- `GET|POST /api/events/:id/guests/:gid/invitation`
- `POST /api/events/:id/guests/:gid/check-in` and `.../undo-check-in`, `POST /api/events/:id/walk-ins`
- `POST /api/events/:id/guests/:gid/move` (the host moves someone off the waitlist or to declined)
- `GET|POST /api/events/:id/reminders` (preview, send)
- `POST /api/events/:id/close-attendance`, `GET /api/events/:id/follow-up`
- `PUT /api/events/:id/venue`, `PUT /api/events/:id/cohosts`
- `POST /api/events/:id/guests/import`, `GET /api/events/:id/guests/suggestions`, `POST /api/target-accounts`, `POST /api/target-accounts/import`
- `GET /api/hosted/mine`

Who may write: planners, leads and GTM, and the people on the event's list with the `host` role. A rep who is not on the list reads the guest list (owner words only) and may log an invitation for a guest they own.

## 16. Screens

- **Event, Guests tab** (hosted events only; replaces People on a hosted event, which has no attendee file): the list with each guest's status as a word in ink, owner, invitation date; filters by status; "Nominate a guest" and "Import registrants" as secondary; the primary action is "Invite" on the next guest who needs it, and, once the list is invited, "Send reminder". Capacity, expected attendance and the venue guarantee on a row above the list. Three directions first (rendered).
- **Check-in**, a phone screen reached from the Guests tab and from My day on the event's day. Three directions first.
- **The RSVP page**, public, one column, three fields. Three directions first.
- **After**: the Result tab of a hosted event shows attendance, cost per guest who came, the two follow-up groups with the owners' notes, and the pipeline from the existing scorecard.
- T4 (status is a word in ink: no pills, dots or warm warning colours), no em dashes, no explainer subtitles, one obvious primary action per screen. `docs/SCREEN-COPY.txt` and design-lint run on every screen.

## 17. Seed (the demo)

- **Golden Gate Field Dinner** (10 Dec 2026, San Francisco, capacity 10, 22 listed on the demo's day): target accounts uploaded, eleven guests invited from the host's mailbox, five registered, one waitlisted, two declined, three not yet answered, one reminder queued to registered only, a venue with a minimum spend and a guarantee in 13 days, and the plan's budget line. The no-show estimate is the default.
- **Lakeside Field Dinner** (22 Sep 2026): closed, with attended and no-show, which with Riverbend and Cascadia gives three closed dinners, so the estimate on the open dinner reads "Your own events".
- A dinner **on the demo's day** at the point of check-in: Capitol Revenue Roadshow (the roadshow stop of 19 Nov 2026 moved by `restampDemoPlan` to today in the demo only) with registered guests, one checked in, one walk-in.
- **Orrery customer dinner, Lisbon**: a hosted plan (a customer event) with a host and six listed guests, no longer a pending seat suggestion.
- All of it written through the same code the routes use.

## 18. Tests

New: `tests/rsvp-state.test.ts` (every row of section 5, the illegal ones), `tests/rsvp-link.test.ts` (unguessable, same 404 for every bad kind, response keys whitelist, no other guest, rate limit), `tests/hosted-reminders.test.ts` (only `registered`, country rules, `INTEGRATED_WITH=account_desk` still sends, seat-open on promotion), `tests/hosted-checkin.test.ts` (check-in, walk-in, undo, closing, capacity not enforced on walk-ins), `tests/hosted-noshow.test.ts` (default, set, history, over-confirm), `tests/hosted-followup.test.ts` (groups, owners, notes, co-host split and lead rule), `tests/guest-import.test.ts` (Luma and Splash, forward-only, skipped rows), `tests/hosted-seed.test.ts` (the demo runs end to end), `tests/hosted-money.test.ts` (rep reads carry no `cents`). Existing: `post-event`, `lifecycle`, `rep-day`, `public-demo` untouched and green.

## 19. Not doing in step 2

- Account Desk sends cold promotion (step 6). Sequencer changes for `INTEGRATED_WITH` (step 6).
- Reading accounts from a live CRM (the table and import exist; the CRM fill is step 7's with the target account list).
- Plus-ones, ticket tiers, payments, calendar invites, SMS.
- A live transactional provider proven against a real mailbox.

## 20. Open questions, and the defaults the build proceeds on

1. The default no-show rate. **20 percent**, changeable per event.
2. The blocked-country list. The Account Desk defaults plus DE. Editable settings with a history come with Account Desk's bl_130; here it is the file.
3. Unknown country blocks emailing. The guest form asks for it; imports without it are followed up by the owner.

## 21. Review fixes (goldfish, Opus 5.5, 2026-11-14) and what the build does

These override anything above they contradict.

1. **Capacity.** `hosted_events.capacity` is explicit and is what the seed sets (Golden Gate 10, Capitol 12, Lakeside 8). When null it falls back to the hosted involvement's `headcount` only if that is at least 1; with neither, there is no capacity, nobody is waitlisted, and the page says "No limit set". The seeded `headcount` on the plan is the number of hosts, so it is not read as capacity by the seed.
2. **A waitlist at 5 of 10.** The seed answers yes through `answerRsvp` with capacity 5 (five registered, the sixth waitlisted), then sets capacity to 10 through `PATCH hosted`. Raising capacity does not promote anyone: promotion happens on a decline or a removal, or when the host moves the guest. So the demo shows five registered, one waitlisted and room for the host to move them in.
3. **History seed.** Riverbend, Cascadia and Lakeside each get guests through the same code, are closed with `closeAttendance`, and set `closed_at`; yes counts at least 10 across them.
4. **Locking.** Every status-changing write (`answerRsvp`, decline promotion, `move`, remove) first upserts the `hosted_events` row, then `SELECT ... FOR UPDATE` on it, inside one transaction. The first waitlisted guest is the lowest `(waitlisted_at, id)`.
5. **State machine additions.** `invited -> invited` (a nudge) is allowed for the invitation log only. `registered -> registered` and `waitlist -> waitlist` are allowed for a repeated yes that edits dietary text. The host's `move` may take `waitlist -> registered` and any open status to `declined`; the move to `declined` needs a reason (stored in `decline_note`). `declined -> attended` is allowed at check-in. Undo of a check-in restores the status the guest had before (`prior_status` column on `event_guests`), and is refused after attendance is closed. Removing a registered guest promotes the same way a decline does. Lowering capacity below the registered count only warns.
6. **Venue deadlines** are added by `CREATE OR REPLACE VIEW event_deadlines` in 0053 (kind `venue`), read like every other deadline: late stays late until the date is done or the event is declined; there is no database clock in the view; "N days late" is computed from the deps clock as today.
7. **Opt-outs.** The desk also refuses to email a guest whose address `isOptedOut` or `isWrongPerson` (from `caches.ts`), in addition to the country rules. `gate.ts` is not edited.
8. **Country rules** read `config/defaults.json` `email_country_rules`: `blocked` (IT, CH, SE, DK, BE, AT, NO, DE), and the message "Not emailed in this country" for a blocked country and "Their country is not known, so no email until it is" for unknown. A guest's own RSVP yes does not lift a block. These are Events Desk's defaults pending Account Desk's bl_130 editable rules.
9. **Imports are uploads.** `/api/target-accounts/import` and `/api/events/:id/guests/import` are refused in the public demo, are in the file-route size class, and need an actor and the write key.
10. **Idempotent sends.** `reminder_sends` has UNIQUE `(run_id, guest_id)` and is the truth; the outbox row carries `run_id` and a state `queued, sent, failed, unknown`. A send whose outcome is unknown is never repeated. A second reminder run for the same kind within 10 minutes is refused. Sends happen after the database transaction commits.
11. **Live mode** without `TRANSACTIONAL_URL` and `TRANSACTIONAL_KEY` refuses to send a reminder with a plain message; no key joins `LIVE_REQUIRED`, and the simulated sender is used only in demo and tests.
12. **Free text and money.** Every hosted read that carries free text runs it through the same `/\$\s?\d/` filter the activity feed uses, for a rep. `tests/hosted-money.test.ts` checks both keys and text.
13. **Who writes.** One rule everywhere: planners, leads and GTM; people on the event's list with the `host` role; for a single guest, that guest's owner (invitation, notes). Check-in: the same, plus any person on the event's list.
14. **Placeholder guests.** `name` stays required. A company-only placeholder is not stored; the owner types a contact name. The name unique index is on `(event_id, lower(name), lower(coalesce(company,'')))`.
15. **History.** Only hosted events whose format is not `webinar`, with `closed_at`, count. "Said yes" means status registered, attended or no_show at closing. A rate over 90 percent is capped at 90 in the estimate.
16. **Owner say** is not applied to hosted guests (they are not on a list sold to a sequencer); the conference-pool suggestions show the company's owner and the owner's decision word, and a company the owner kept shows "Owner has it" and is added only by that owner.
17. **Imports.** Forward order is `listed < invited < waitlist < registered < attended`; declined and no_show are never overwritten by an import except `attended`. `checked_in_by` for an imported attendance is the importer. A name-only duplicate counts as "already there". `guest_log.guest_id` is nullable for event-level rows.
18. **Webinars** refuse invitations, check-in and seating with one sentence.
19. **The RSVP link's reads** never carry `rsvp_token` for anyone but a person allowed to write that guest (host, planner, lead, GTM, the guest's owner); `GET hosted` strips it for others. GETs for `/api/rsvp/` take no actor. Time zone: the event's country zone (`eventZone` in `meetings.ts`) defines "the event's day" and `doors_at`.
20. **The bad-token limit** keys the same way the public demo's limit does (last `x-forwarded-for` entry, else "local").
21. **The 22 numbered seeds** in section 17: Golden Gate is the dinner run from list to reminder; Lakeside, Riverbend and Cascadia are closed history with follow-up groups; Capitol carries check-in with a walk-in on the demo's day; the same dinner is not required to carry all phases. The CRM account fill is deferred to step 7 (section 19) and noted for Bryan.
22. New decisions 58 to 61: hosted guests are not gate subjects; unknown country blocks mail; transactional sender separate from the sequencer; the no-show default. `docs/SPEC.md` links this file.
