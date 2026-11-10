# Sequences in the desk: the data and the view

**Status:** spec, 2026-11-10, asked for by Bryan ("this needs to be redesigned... we might need side panels too... we need a way to get sequences data in the desk... pre event and post event"). Goldfish-reviewed the same day (1 Blocker, 9 Major, 5 Nit), rewritten, re-reviewed (all resolved, 3 new Major), and fixed again. Built 2026-11-10: migration 0047, `src/server/sequence-view.ts`, `SequenceSheet` in `src/app/Objects.tsx`, tests in `tests/sequence-data.test.ts`.

## The problem

The Outreach tab's Sequences fold (`SequenceGrid` in `src/app/Motion.tsx`) is a grid of counts, before and after the event, by group and channel, that opens a strip of inbox addresses. It says who was put in a sequence. It does not say what the sequence did: who was reached, at which step people replied, what bounced, how LinkedIn invites fared.

What reaches the desk today, and what it loses:

- The five connectors (Instantly, HeyReach, Smartlead, Apollo, and Gong, which reports nothing) turn each tool event into a `ToolEvent` with a `signal` of `send`, `reply`, `bounce` or `unsubscribe` (`src/server/connectors/types.ts`). `ingestEvents` in `src/server/replies.ts` records them.
- **Sends arrive by webhook only.** The polls (`events()`) return replies, and Apollo's also bounces; none returns sends. A missed send webhook is a silent undercount.
- A send becomes a `touches` row with `sender` and `step` (migration 0041), but not its sequence. Any other signal becomes an `inbound_messages` row plus a touch with neither sequence, step nor sender. The reply-coded touches (`reply_<code>`) are written later, by `applyCode`.
- Only Instantly reads `step` from its payload. HeyReach registers only its reply webhook, so on LinkedIn no person is ever "reached" in real mode.
- No open or click tracking, on purpose (`track_opens: false`, `src/server/sending.ts`). Unchanged.

## Decisions

### 1. Which sequence an event belongs to

- `findContact` already picks one enrollment (the one in the sequence the event names, else the latest added). It returns that enrollment's `sequence_id` too.
- `touches` and `inbound_messages` gain `sequence_id` (references `sequences`, `ON DELETE SET NULL`) and `inbound_messages` gains `step`. The send touch, the inbound row and the touch written beside it carry the matched sequence and the event's step. A bounce or unsubscribe touch also carries the event's `sender` when the tool gives one.
- `reply_<code>` touches are written from the inbound row and inherit its `sequence_id` and `step` (`Msg` gains both).
- **The sequence and the credited event are separate facts and both stand.** A reply's `event_id` stays the credited event (`creditedEvent`, the latest send), as today; its `sequence_id` is the enrollment it matched. The per-sequence read selects by `sequence_id` only, so a reply is counted in the sequence that drew it even when the event credit went elsewhere.
- A reply with no step takes the step of the last send to that person in that sequence.
- **Backfill** (in the migration): a touch with a contact and no sequence takes the sequence of that contact's enrollment on the same channel **and the same event** added at or before the touch, latest first. An inbound row (whose `event_id` is the credited event, not the sequence's) takes the enrollment on the same channel **and the same connector** added at or before it, latest first; `reply_<code>` touches take their inbound row's. Unlike the live rule, the backfill cannot prefer the sequence the tool named, so an old reply to a before-the-event sequence that arrived after the person was added to the after one is filed under the after one. What cannot be placed stays null, and the read counts it apart ("not placed"), never guesses.

### 2. LinkedIn: invites are sends, acceptances are recorded

- `EventSignal` gains `invite` and `accepted`. They get their own branch in `ingestEvents`, before the inbound path: **they never write an `inbound_messages` row and never pause anyone.**
- An `invite` is written as a `send` touch with `action = 'invite'`, a new column on `touches` (a LinkedIn message is `action = 'message'`, email leaves it null). It is a column of its own, not `reason`, because erasing a person blanks `reason` (`forgetPerson`, `src/server/operating.ts`). So everything that counts on sends (the funnel's reached, the follow-up groups, `creditedEvent`, the gate's last-send check, `rep-day`) treats a person who got an invite as reached, which is what it is: the first touch of the LinkedIn sequence. The per-sequence read tells invites and messages apart by `action`. Two side effects, both accepted: sender health (`withDeskRates`) counts invites as sends for LinkedIn accounts, harmless with no bounces there; and the funnel's replied, which needs a send, now counts a reply from someone who only got an invite.
- An `accepted` is a touch of kind `accepted`. Nothing switches on it except the new read and the person's timeline ("Accepted on LinkedIn").
- HeyReach: one webhook per event type (`CONNECTION_REQUEST_SENT`, `CONNECTION_REQUEST_ACCEPTED`, `MESSAGE_SENT`, and the existing reply event), mapped in one table to `invite`, `accepted`, `send`, `reply`. `registerWebhooks` checks for an existing webhook by URL, campaign **and event type**, so campaigns that already have the reply webhook get the other three. **Unconfirmed:** the names come from third-party docs (Make, Zapier, OutboundSync); HeyReach's own list was partial.
- Each `ToolEvent` keeps a `provider_message_id` unique per tool event; for HeyReach it is `<event type>:<id from the payload>`, so an invite and an acceptance for one person never collide.

### 3. What each tool reports

`Capabilities` gains `reports: Signal[]`, the signals that tool's webhooks deliver: Instantly and Smartlead `send, reply, bounce, unsubscribe`; HeyReach `invite, accepted, send, reply`; Apollo `reply, bounce`; Gong none. A figure built from a signal the tool does not report reads "not reported by <tool>", never 0. Only Instantly gives a step. Smartlead's step is not parsed, and HeyReach's payloads carry none, so per-step figures for both read "not reported", and their replies get no step from the last send either.

### 4. One read per sequence, and what it counts

`GET /api/events/:id/sequences` and `GET /api/events/:id/sequences/:sid`, read-only, open to reps (no money in them). Definitions, so nothing is counted two ways:

- **In it:** enrollments by state (in, paused, removed) and, for removed, the cause.
- **Reached:** distinct people with a send touch in this sequence (invites included). LinkedIn also: invites, accepted (distinct people), and accepted as a share of invites.
- **Replied:** distinct people with an inbound reply in this sequence and a send in it, with the same exclusions as the funnel (out of office, bounced, unsubscribed, wrong person, departed are not "replied"). **By code** lists every reply, those included.
- **By step:** messages sent at each step (a count of sends, not people), and the people whose reply, bounce or unsubscribe carries that step. Steps are numbered from 1 on screen; a connector that reports from 0 adds 1.
- **Meetings:** people in this sequence with a meeting booked after a reply in it.
- **Senders:** each inbox or account with its sends here; bounces beside it only where the tool gave the sender.
- **Over time:** sends per day, against the event's days.
- **Not placed:** sends and replies on the event with no sequence.

The per-step sends add up to the sequence's messages sent, not to "reached". Sequences do not add up to the funnel, because one person can be in an email and a LinkedIn sequence; the screen never shows a sum across them.

### 5. The view

- The Sequences fold keeps its two halves, Before the event and After the event, and replaces the grid with rows like the rest of the page: channel and region, state, people in it, reached, replied, meetings, with a bar for reached of people in. An empty half says what will happen and when.
- A row opens a side sheet, object kind `sequence` (`?sequence=<id>`): figures across the top (in it, reached, replied, meetings; on LinkedIn, accepted), the steps as a short ladder, sends over time, senders, replies by code (each opening its reply sheet), and the setup and actions from `SequenceDetail` at the foot. `objectHref`, `backHref`, the `ObjectSheets` switch and the sheet kinds in `src/app/Objects.tsx` gain the kind.
- Above each half, a row says when it started and who started it, in the same form as the follow-up row Bryan approved: "Pre-event sequences started" (who confirmed the first launched sequence's checklist, `checklist_by`, and the day of the first `launched_at`, with how many days before the event) and "Follow-up sequences started" (who pressed Start the follow-up, and the day, with how many days after). Before a half has started, its row says when it will.
- The funnel's "Reached" row opens the fold too ("In sequences" already does).
- The person's timeline names the new steps ("Invited on LinkedIn", "Accepted on LinkedIn"); `rep-day.ts`'s path query includes `accepted`.
- `docs/DESIGN-CHECKLIST.md` holds.

### 6. Demo data

`demo-run.ts` seeds: provider ids that include the sequence (`send:<sequence>:<contact>:<step>`), so a person in a before and an after sequence keeps both; a sender from the sequence's own senders; two or three steps on email; on LinkedIn an invite, then for some an acceptance and a message.

### 7. One naming convention (Bryan, 2026-11-10)

A sequence has one name, the same in the desk and in the sequencer's campaign list: `Desk | <YYYY-MM> <event> | <Before or Follow-up> | <Email or LinkedIn> | <audience> | <region> | <desk id>`, for example `Desk | 2026-03 Shoptalk Spring 2026 | Before | Email | Priority A | Americas | 6ab154`. "Desk" first lets a team filter every desk-made campaign in the tool; the start month next sorts them in event order; every part is always present and in this order and case; the last six characters of the desk's id end it, since the desk finds its campaign again by this name after a crash. ASCII only, at most 120 characters, the event name shortening first. Audience words: Priority A/B/C, Scanned at booth, Reached before, Not reached before. Region words: Americas, EMEA, APAC, Event region. Code: `src/shared/sequence-name.ts`; tests: `tests/sequence-name.test.ts`. Sequences made before this keep their name.

## Unchanged

Sending, the gate, holds and when a cadence stops. Money is not in any of this.

## Tests

- Ingest: each signal keeps its sequence and step; `invite` writes a send touch with `reason = 'invite'` and no inbound row and pauses nobody; `accepted` likewise; an unmatched event keeps null; a webhook and a poll of the same reply count once; a reply credited to one event keeps the sequence it matched.
- HeyReach: each event type maps to its signal; an unknown type is ignored; registering on a campaign that has the reply webhook adds the other three.
- Backfill: places what it can, leaves the rest null.
- Read: per-step sends sum to messages sent; accepted never exceeds invites; replied matches the funnel's exclusions; a tool that does not report a signal shows "not reported"; a rep can read it.
- Demo: every seeded sequence has steps and senders; LinkedIn has invites and accepts.

## Not proven

No connector has been called for real. The HeyReach event names are from third-party docs. Instantly's `step` is documented, not observed, and whether it counts from 0 is unknown. Whether HeyReach's webhook and poll give the same reply the same id is unknown (an existing risk).
