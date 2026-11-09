# After delivery: the rest of an event's life (v2 spec)

Status: draft, 2026-11-09. Nothing here is built. v1 ends at a delivered list. This covers what happens to that list until the event has a score and its lessons have reached the next event.

Rules carried over from v1: code decides, a model only reads or writes where stated; a person confirms anything that spends or reaches someone; every row keeps a reason; credits and dollars are never added; every stage move is in code. New rule: **a real outreach step never launches itself.**

## The problems this has to solve

1. A delivered list is worth nothing until someone works it. Account owners must get a say before a team sequences their accounts.
2. Two motions touching one company must not collide. An owner in a live deal, and an SDR sequence to the same account, is the classic failure.
3. Sending platforms' own reply labels are unreliable. The desk must read every reply itself.
4. A reply is not always interest. Out of office, unsubscribe, bounce, wrong person and "I left" are different events with different consequences, and must not pollute reply rates.
5. A booked meeting has to stop the rest of that company's automated outreach.
6. Nobody remembers what was learned at the event unless they are asked within days.
7. Pipeline arrives weeks later, so a score at delivery is meaningless. An event gets scored at 30 days, then revised.
8. What was learned has to reach the next seat decision and the next list, through a person.

## The shape

Each event keeps its stage. `delivered` stops being the end: a new `motion` state runs beside it, so nothing in v1 changes meaning.

| Layer | What it adds | Who decides |
|---|---|---|
| A. Intake | Lists with only email or LinkedIn proven end to end | Uploader, as today |
| B. Owner say | Accounts with an owner get asked before anyone sequences them | Account owner, 48 hours, then the default |
| C. Sequences | Pre-approved templates, one sequence per event and priority, enrollment after every check | The uploader presses create; launch stays in the sequencer, by hand |
| D. Touch log | One table, keyed on company domain, that every motion writes to | Code |
| E. Replies | Every reply read and classified, routed by our own label | Model classifies; code routes; a person sees doubtful ones |
| F. Meetings | Booked, halted, prepped, outcome recorded | Rep |
| G. CRM sync | Campaign membership, activity, opt-outs written back through the outbox | Code, fill-blanks only |
| H. Debrief | People who met someone are asked within days; facts kept with their quote | A person accepts each debrief |
| I. Scorecard | One funnel definition, a score at 30 days, revised at 60 and 90 | Code |
| J. Learning | What converted, shown where the next decision is made | A person accepts any change to the ICP or rules |
| K. Integrity | Nightly invariants that observe and alert, never repair | Code observes, a person fixes |

## A. Lists with only email or LinkedIn

Today's mapper accepts a list with any one of company, email or LinkedIn, and a row with only an email or LinkedIn is kept as a person with no company. The reverse lookup job attaches them. What is missing is proof and pricing:

- End-to-end tests for an email-only list, a LinkedIn-only list, a mixed list, and an all-webmail email list.
- A work email's domain resolves the company for free. Webmail needs the paid reverse lookup. The card prices only the second.
- A name is not required to find a person from a LinkedIn profile, but the email loop needs one: the reverse result supplies it. A person still nameless after reverse lookup drops with a reason.

## B. Owner say

When a list is delivered, each account with a CRM owner produces one owner decision: **include** (the team may sequence them) or **mine** (the owner reaches out, excluded from sequences). Sent by Slack DM, one message per owner, grouped by account. Silence for 48 hours means include, and the owner is told before that happens. Accounts with an open late-stage deal default to **mine**. Live mode with no CRM has no owners, so this layer does nothing, and says so.

## C. Sequences

New seam, like `Crm`: `Sequencer { name; listTemplates; createSequence; addContacts; pause; status }`, with a mock, a simulated vendor and an Apollo adapter. Apollo's API calls sequences `emailer_campaigns`, enrollment is `add_contact_ids`, contacts must already exist in Apollo, and it needs a master key. Unproven until a real key runs it.

- Templates are approved once, in Settings, with a version. An event uses the version current at creation.
- One button after delivery creates a draft sequence per priority. It cannot launch. Launch happens by a person in the sequencer.
- **Enrollment gate, in code, per person, immediately before adding:** not dropped; owner said include; email verified; `preSendCheck` passes (opt-out, CRM flags, read fresh); no active sequence elsewhere for that person; no meeting booked or live thread at the domain (touch log); Review tab decisions applied. Anyone refused gets a reason and stays on the list.
- Adding is idempotent per person and sequence.

## D. Touch log

`touches (domain, person_id, event_id, kind, channel, at, source, dedup_key)` with a unique `dedup_key`. Sequence enrollment, each send, reply, meeting and owner action writes here. Keyed on company domain because that is the join every motion shares. This single table is what stops collisions.

## E. Replies

Inbound from the sequencer (webhook where one exists, otherwise a poll) goes to a table first and is processed by a job, so a crash replays safely.

- Signed where the source signs. Deduplicated on the provider's message id.
- One model call classifies each reply into a fixed list: interested, meeting request, referral, not now, not interested, out of office, unsubscribe, bounced, wrong person, departed, other.
- **Carve-outs** leave the engagement table before it is written, so reply rates need no filter: out of office, unsubscribe, bounce, wrong person, departed.
- Consequences in code: unsubscribe writes a suppression and queues the CRM opt-out; bounce marks the verification negative; wrong person writes a wrong-person suppression; departed drops the person from active sequences and opens a re-find for their successor, as a case; a referral opens a case with the named person.
- Any genuine reply stops that person's cadence and writes a touch. A reply to one contact does not stop colleagues; a booking does.
- Confidence under a threshold, or `other`, goes to a person in the event's Slack thread.
- The model never drafts or sends an answer.

## F. Meetings

Three ways in: a rep marks a reply booked, a row in the Sheet's Meetings tab, or a calendar webhook. Deduplicated on person and start time.

- On booking, every other contact at that domain is paused in active sequences, kept and never deleted, and the touch log records why.
- A prep brief is available through Concierge, from delivered facts, and states only what the desk holds.
- After the meeting: held, no show, rescheduled, cancelled, with outcome. A no-show reopens nothing automatically.

## G. CRM sync

Extends `crm_outbox`: a campaign per event, campaign membership with status (sequenced, replied, met), and a Task for each meeting. Fill-blanks only, as today, except the opt-out. A real Salesforce adapter is written against the seam and tested on recorded shapes, and stays unproven until a real org connects. Opportunities are read, never written.

## H. Debrief

Two to three days after the event, anyone with a meeting gets a short Slack prompt: what was learned, about the account and about the event. One model call extracts facts, and **every fact must quote the debrief as a literal substring or it is discarded**: a check, not an instruction. A person accepts or rejects each debrief. Only accepted ones aggregate. Runs accumulate, because one pass can miss facts.

## I. Scorecard

One SQL view defines the funnel, and every screen reads it: list rows, kept people, enrolled, delivered, replied (genuine), meetings booked, meetings held, opportunities touched, pipeline influenced.

- Influence, stated plainly: an opportunity counts if its account had a held meeting from this event and the opportunity was opened or advanced within 90 days. It is influence, never sole credit, and the screen says so.
- Cost sits apart: tickets and travel in dollars, AI in dollars, credits per provider in credits. Cost per meeting uses dollars only and is labeled as excluding credits.
- The score is computed at 30 days, then revised at 60 and 90, with each version kept. It is a small published formula with each part visible. A low-count event shows its counts and no score.
- Event scores appear where a seat request for the same conference is decided.

## J. Learning

All aggregation is `GROUP BY`, so it can be audited.

- Which company tiers, title tiers and segments produced meetings. Which reasons dropped people who later appeared in a deal.
- Accepted debrief facts, by account and by theme.
- A proposal is a suggested edit to the ICP or title table, with its evidence and sample size. It takes a person to accept, and creates a new ICP version through the existing confirm flow. Fewer than a stated number of outcomes shows as "too few to say".

## K. Integrity

Nightly invariants: nobody opted out is enrolled; nobody enrolled lacks a verified email; every enrollment has a passed gate row; every paused contact has a cause; ledger reservations balance; funnel counts never increase down the funnel. A failure alerts and records. It never repairs.

## Testing and stress

- Simulated sequencer, replies and meetings use authored rates, labeled as such, exactly as v1 does.
- Webhook replay: 10,000 events with duplicates and out-of-order delivery produce the same state as one clean pass.
- Concurrency: run against real Postgres in CI as well as PGlite, closing the v1 gap on the row lock.
- Crash at every step of enrollment, reply handling and merge: replay equals clean.
- Reply classifier: real recorded evals on a labeled set, with a frozen holdout, as in v1.
- Every layer ships with invariants and its own screen state.

## Build order

A intake proof. D touch log. B owner say. C sequences and the gate. E replies. F meetings. G CRM sync. I scorecard. H debrief. J learning. K integrity alongside each. Real Postgres in CI first.

## Open

- Whether Apollo offers reply webhooks. If not, replies are polled.
- Whether an event channel per event suits a real team, or a thread per event.
- The score's weights. They start simple and visible, and real outcomes will have to set them.
