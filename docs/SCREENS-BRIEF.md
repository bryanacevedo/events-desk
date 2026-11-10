# Screens brief

Bryan's decisions on the web app, 2026-11-08. This replaces earlier instructions where they conflict. Work is split into rounds at the bottom.

## Look and copy

- Desk look: white, forest green #1F5D3F, sand #E9DFCB, orange #D1501C. Headings IBM Plex Sans 500 through one token. Body Geist. No em dashes.
- Must feel made by a person. No KPI tile rows, gradients, icon-in-a-circle cards.
- **Cut the explaining.** Do not describe what things are, how the screen works, or how the demo differs from live. Bryan called these AI design: "The number is days to the doors, or days since. Past events keep their outreach list; ended ones keep the reason.", "6 events, including the ones that are over or were ended.", "1 event left this year, 4 need something. $2,398 in seats committed in 2026.", "In the demo the outreach list is a file. A live setup shares it as a Google Sheet." Find every sentence like these and remove it. Page titles stay plain. Subtitles are absent unless they carry something a person acts on. Errors and empty states stay short.
- **No random tags.** Bryan on a lone orange "Over the Q4 budget by $63,992" and a lone underlined "Why": "these random tags also read ai generated". No colored helper sentences floating under a row and no stray underlined words as controls. A warning belongs inside the data it qualifies, compact and in a set form ("$63,992 over Q4"). A row that has more to show expands itself with a quiet chevron. Use the shared components for these across the app.
- **No red or orange text, no pill tags.** Bryan, 2026-11-09: "get rid of that red in fonts across the app" and, on a filled "over Q4" pill, "i hate these". Color lives on marks, bars and fills; words stay ink or mute. Money in a header is a large Plex figure on the right with a plain label: green when there is room, ink when over. Errors are ink behind one small mark.
- **No underlined words as controls.** Secondary controls are real quiet buttons. Opening an outreach list is always `SheetButton`.
- **It should feel alive.** Cards lean to the mouse, rows and logos answer hover, bars draw in, screens rise in, the sidebar pill slides. All of it stops under reduced motion.
- Two named lists, never the bare word "list" where either could be meant. **Attendee list**: the upload. **Outreach list**: the delivered Google Sheet. Tight spaces: "Attendees in", "Outreach ready". "Open the sheet" is fine on a button.
- Filters and search where they make sense: Events, Seats, the people and companies on an event, Budget and Usage by-event tables. Quiet controls, counts that update, URL-held so a filtered view can be shared. Not on short pages.

## Sidebar

Top: Overview, My day, Events, Seats, Budget, Usage. My day (added 2026-11-09) is each rep's start: people waiting on them, meetings with briefs, free slots, with a count like Seats. Bottom, in this order: Request seats button, then Settings, then Acting as, then the quiet demo note. Brand mark and icons stay. Phone bar: Overview, Events, Seats, Budget, More (Usage, Settings); Request seats reachable from Seats and Events.

Calendar and All events are merged into **Events**. Approvals is replaced by **Seats**.

## Personas

Acting as: Maya Ortiz (SDR, requests seats, uploads attendee lists, runs them), Dan Whitlock (approves seats), GTM Team (GTM Engineering, the only one with Settings). This stands in for a real login later.

## Overview

Header is about the program only, plain title, no sentence built around one event. Main object is a horizontal rail of event cards: chronological, opens at today, drag, trackpad, arrows, keyboard, swipe with snap, next card peeks, month labels, today marker. Under it, secondary: at risk, grouped by what is needed with the most urgent few and a way to see all; seats waiting; outreach lists delivered lately with Open the sheet and A/B/C counts. Clicking a card opens the side sheet and stays on Overview.

## Side sheet (Overview and Events)

Shared component. Stays on the page. Closes on click outside, Esc, close control, and a click on another card closes or switches it. Focus trapped and returned. Shows dates and place, state and next action, who is going, list counts, Open the sheet when delivered. "Open the full page" is a real button and the only way deeper. "End this event" lives quietly on the full page.

## Events (merged Calendar and All events)

One visual tab for the whole program, past and future, opening on what is coming. Not a list as the primary form. Holds 40 events and crowded weeks such as 7 in November. Search and filters: time, region, state. Add event action for GTM Team and approvers, with name, dates, place, website, ticket price; others suggest an event through the seat request. Bryan reviewed Wall, Lanes and Ring and chose none: the existing timeline (one row per event, a runway bar from today to the event) is the form. Invest in it and make it better; do not replace it.

## Seats

Its own part of the product, kept clearly apart from the outreach work. A seat request is one person asking for their own seat, enforced on the server. One open or approved request per person per event.

Tables: `catalog_events` (name, venue, city, country, starts_on, ends_on, website, seat_price_cents, price_is_estimate, source listed or suggested, suggested_by, confidence, source_url) and `seat_requests` (event_id, requester, status, decided_by, decline reason, form answers). Migration `0020_seat_requests.sql`. The first request on a catalog entry creates the event row in stage requested. Each request is approved on its own. First approved seat moves the event to approved; each later approval adds one. seat_count is the number approved. If all are declined and none approved, the event is declined, and a later request starts a new event row. A late request never touches the pipeline. Nobody approves their own. POST /api/events with a seat count stays for tests and internal seed only.

Form: event from a searchable dropdown of upcoming catalog entries (name, date, city, and who is going, like "3 going, 1 waiting"); price and place fill in. "My event isn't listed" opens a suggestion (name, website, dates, city and country, ticket price), going through the same approval marked as new; approval adds it to the catalog. Then team and role, main goal (new pipeline, existing customers, partners, speaking or sponsoring, market learning), why this event, why you (both required with a minimum length), expected meetings, known accounts attending (optional), travel estimate per person (optional, information only), decide-by date (optional). Shows one ticket plus travel if given. Validated on the server.

Page: seat requests grouped by event, one row per person, approve or decline each, with goal, why, role, expected meetings, ticket cost, decide-by, seats already approved, and what approving would leave in the quarter's ticket budget (a warning when over, never blocking). Only approvers get the buttons; "Decided in Slack" branch stays for live. Filters: event, status, team, mine. Slack message carries goal and why.

Listed events nobody has requested appear muted on Events with a Request action that preselects the event.

## Run step (was the cost card)

Not an approval. The person who uploaded the current attendee list confirms the paid steps on the event page, "Review cost and run": what will run, at most how much, credits and model-call caps, Run, and stop. In two-card flow, the same for Research and Outreach. Others see it read-only: "Waiting on Maya to run this". Overview shows the uploader "Your attendee list is ready to run". Server enforcement is the backend step.

## Event page

Full redesign, large case first, at four volumes: flagship (full attendees-large.csv, about 1,650 rows, 420 companies, 40-plus cases, 10 to 15 approved people), about 200 rows, about 25 rows, and no attendee list yet. The stage decides what leads. Shape of a big list in compact form (A/B/C, tier spread, drop reasons, top companies). Rows never render unbounded: search, filters by priority, tier and status, paging with "showing 50 of 1,650". Cases grouped so 40-plus clear quickly. Activity collapsed. Delivered primary action is Open the sheet in a new tab; Excel download only when there is no link, quietly, with the error. Optional `SAMPLE_SHEET_URL` env var gives seeded delivered events a link; never hard-code one. Record ticket cost per seat. Audit covers all four volumes on desktop and phone, render under about 1 second after data loads.

## Settings

Only GTM Team can open it. Anyone else clicking it gets one line telling them to contact GTM Engineering. Enforce on the server too: settings and ICP write routes refuse anyone else. Acting as is not security; real Google login comes later.

Settings has its own second-level nav like the sidebar, with these sections:

1. **ICP**: what exists now, version, date, source, one line, a few facts, Upload a new version, Paste text, past versions. Compile steps open only after an upload, with minimal words.
2. **Scoring**: the priority matrix (company tier by title tier into A, B, C, no-title handling), prospect quotas (tier 1 up to 5, tier 2 up to 3), tier 1 share warning, small list threshold.
3. **Titles and people**: personas, buyer titles, title keywords per tier, people per company, add prospects default.
4. **Lists**: never contact, existing customers, and a third tray, **Opted out** (who, reason, who recorded it, date; search when long; "Add someone" by email or name at a company, confirmed before it is kept since there is no undo). Opt-outs are also recorded from the person panel on an event page, where a quiet "Opt out" asks first and the drop reason then reads "Opted out" everywhere.
5. **Data rules**: email rule, catch-all handling, pattern guessing off, freshness 180 days, verification reuse 30 days, firmographics cache 90 days, candidates per person.
6. **Spend limits**: per-step caps, model per step, re-tier allowance, real-run row limit.
7. **Connections**: Apollo, ZeroBounce, Anthropic, Google, Slack: connected or not, vendor health. Never show a key.
8. **Team and access**: who approves seats, who is GTM, Slack user mapping.

Show current values read from real config. Make a value editable only where the server already supports saving it; the rest are read-only for now.

## Budget

Tickets only. Apollo, model, travel, sponsorship stay out. Spent: tickets recorded as purchased, at actual amount. Committed: approved seats not yet purchased. Waiting: pending seat requests. Left, and left if all waiting is approved. Yearly budget with quarterly split, set by approvers, activity logged. One calm strip for the year with quarters; by-event table with search and paging; breakdown by team and region. Migration `0021_budget.sql`. No double counting. Warn, never block.

## Usage

Read only, from the real ledger, query in `src/server/usage.ts`. Bryan's rule, across the whole system: vendor credits and AI dollars are different things and are never added together or converted. Apollo and ZeroBounce are measured in their own credits, drawn from each company subscription's pre-allocated pool, with no dollar value. Only AI model calls are in dollars. Each vendor is named accurately. Usage shows each vendor against its pool, AI dollars on their own, and an event-level table with search and paging. Very few words. Simulated runs labeled once as simulated.

## Sample data

Real events from `samples/real-events.json`. Everything else is fictional (people, staff, Orrery, attendee lists, their companies) and the demo says once, in one quiet place: real event names, simulated attendees. Never suggest a real event's actual attendee list. Null prices flagged as estimates. Roster of about 20 fictional staff; flagship 10 to 15 approved, dinners 1 to 3. No screen shows one person asking for more than one seat. All behind the opt-in demo seed option; test fixtures unchanged.

## Rounds

1. Sidebar and routes, personas, naming sweep, copy cut, Overview fixes, Settings shell with access gate.
2. Seats model and form, then real events.
3. Merged Events tab from the chosen direction, shared side sheet.
4. Event page at volume.
5. Budget and Usage.

Before starting, read the code as it stands: an earlier agent stopped partway through round 1. Do not touch src/server pipeline, tiering, research, or evals files; another agent owns them.

## From the build conversation (2026-11-08 to 11-09)

Bryan's pointers that shaped the app as it looks now. Read these before any new screen.

- Events Desk has its own look. It is not the backlog's, and it never borrows another project's bones.
- It must feel made by a person. A good interface gives the useful data and leaves people room to think; it does not lay out every number and relation it has.
- Plain words, no technical jargon. Stage names say what is going on.
- Real things where they exist: real event logos, people avatars.
- Events must not blend together: the event header carries the event's own look.
- One timeline for an event's whole life, in the header. A section never repeats the stage in a second bar.
- Overview cards stay light: no trailing to-do line inside a card.
- Dropdowns: one chevron, the same inset, everywhere.
- No lock icons. No random tags. Nothing that looks left behind by accident.
- Forms that start something big (Request seats) open in a floating sheet, not on top of the page.
- Formatting is checked to the cell: nothing cut off, every column fits its header.
- Settings and every new screen are brought up to the level of the rest of the app, with the mistakes already corrected elsewhere left corrected.
- More decoration is not better: if an addition makes a place noisier, take it out.
- Long is a failure: a screen or a message that reads long gets cut.
- New sections are built from the shared parts: the brief's bar rows, rows that open with a chevron, folds, figures in set form ("4 costs to add").
