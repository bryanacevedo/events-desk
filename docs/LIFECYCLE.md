# After delivery: the rest of an event's life (v2 spec)

Status: built on branch `v2`, 2026-11-09, on simulated tools and fakes; none of it has run against a real sequencer, CRM or calendar account. Decisions taken while building are in `docs/DECISIONS.md`, section 33.

v1 ends at a delivered list. This covers what happens until the event has a score and its lessons reach the next event.

Terms. **Uploader**: the person who uploaded the list and confirms its cards. **Card**: a cost card, the confirmed spending cap. **Case**: a question the desk opens for a person (`review_cases`). **Outbox**: `crm_outbox`, what is owed to the CRM. **Concierge**: the Q&A agent over delivered lists.

Rules carried over: code decides, and a model only reads or writes where stated. A person confirms anything that spends or reaches someone. Every row keeps a reason. Credits and dollars are never added. New rules: **a real outreach step never launches itself**, and **when in doubt about whether someone may be contacted, stop contacting them first and ask second.**

## 1. The motion

A delivered event keeps stage `delivered`. A new column `events.motion` runs beside it, changed only through one function that refuses any move not in this table, as `moveEvent` does for stages. New-registration top-ups have no motion of their own: their people join the parent event.

| From | To | When |
|---|---|---|
| `none` | `owners` | The uploader starts outreach, and a CRM is connected |
| `none` | `sequencing` | The uploader starts outreach, and no CRM is connected |
| `none` | `closing` | No outreach was started by 14 days after the event's last day |
| `owners` | `sequencing` | Every decision is in, defaulted, or handed to the uploader |
| `sequencing` | `in_market` | The desk observes a launch |
| `sequencing` | `closing` | Nothing launched by 14 days after the last day |
| `in_market` | `closing` | 14 days after the last day |
| `closing` | `scored` | The 30-day scorecard is written, with or without a score |

`scored` is terminal; the 60 and 90-day revisions are versions of the scorecard.

**Clocks** read `catalog_events.ends_on`, falling back to `events.starts_on`. A date is the event's local day where the country is known, otherwise UTC, and the screen says which. An event **delivered after it ended** goes through the same motion with post-event templates only, and its debrief date is delivery plus 2 days.

## 2. Every step that spends is on a card

Only two-card events can start outreach: an old single-card card (`step_caps` null) is refused for every Motion step in code. A third card, the **Motion card**, prices reply classification (one call per expected reply, at a stated cap), debrief extraction, successor finding and any contact creation the connected tools charge for. Worst case first, the uploader confirms, and that is the cap. It is requested when outreach starts, or alone for an event with no outreach that still wants debriefs.

While it is pending, the motion waits in its current state. Declined, outreach does not start and the event stays at `none`, and the uploader may ask again.

When a cap runs out, code checks still act (section 8). Anything that needed the model becomes doubtful, stays stopped, and the event's activity says so.

## 3. Intake: lists with only an email or LinkedIn

The mapper already accepts these. Reverse lookup runs only on the two-card flow, and that is where this is supported: single-card events stay as they are.

- `ReverseLookup` gains a person result (`full_name`, `title`, `linkedin`). `attachReverse` writes them only where the row is blank. The live adapter stops discarding `j.person`.
- Every person with no company gets the paid lookup, priced on the card. Placing work emails free by domain was built and backed out: in the authored world it raised false merges from 2 to 6, because a work address can be a former employer's. When the lookup finds nothing, a work email's domain places the person, under a provisional label from the domain that firmographics replace. Webmail with no match drops.
- A one-column headerless list of emails or LinkedIn URLs is detected as that, by its values, not read as companies.
- A person with a verified address and no name stays on the list, marked `name unknown`, and cannot be sequenced until a person names them, because templates need a name. A named person with a LinkedIn profile and no address found stays on the list for LinkedIn only. Anyone else with no address drops as `no_email_found`, as today.
- No title means the title-unknown priority, as today.
- Tests: email-only, LinkedIn-only, mixed, all-webmail, headerless.

## 4. Owner say

On starting outreach, each account with a CRM owner produces one decision, posted to the event's Slack channel with the owner @-mentioned, grouped per owner. **Include** lets the team sequence the account. **Mine** keeps it out and writes a touch, so the desk knows.

- The owner's name is resolved through `SLACK_USER_MAP`. **An unmapped owner, or a Slack message that failed to send, never defaults to include**: the clock starts only when a message is delivered, and otherwise the decision goes to the uploader as a case. An unanswered case holds only that account out of sequences; the event moves on.
- The owner is read fresh from the CRM when decisions are sent. If it changed, the new owner is asked.
- Silence for 2 business days means include. The owner is warned at 1 business day. Weekends do not count, on the desk's configured calendar.
- A late **mine** still works: it removes the account's people from any draft or active sequence, recorded with its cause.
- **Mine** applies to that event only.
- This reuses v1's `late_stage_deal` case rather than adding a second rule. Keep means **mine**, Dismiss means **include**, an answer given at delivery counts, and an unanswered case defaults to **mine**. Both read one list of late stages, configured in settings because real stage names vary.
- No CRM connected: no owners, the state is skipped, and the screen says why.

## 5. Sequences, on any tool

**The desk owns the rules. A sequencer is a plug.** Nothing about Instantly, Smartlead, Gong, HeyReach or Apollo reaches any code outside its connector.

A person has one **cadence** across channels. A channel is `email` or `linkedin`. An event can connect one tool per channel.

```
Connector {
  name; channels;
  capabilities: { createsSequences; pause: "contact" | "remove-only"; events: "webhook" | "poll" | "both";
                  replyBodies; needsCrmRecord; observesLaunch };
  listTemplates(); ensureContact(person) -> externalId;
  createSequence(name, templateId, senders) -> externalId;
  addContacts(sequenceId, [externalId]) -> per-contact result;
  removeContact(...); pauseContact(...); resumeContact(...); pauseSequence(...);
  sequenceState(id) -> draft | active | paused | archived;
  events(since) -> normalized events;  verifyWebhook(request) -> normalized events
}
```

- **Connectors declare what they can do, and the desk adapts.** A tool that cannot pause a person gets removed and re-added, with the reason recorded. A tool with no reply text degrades to status only and says so. A tool that needs a CRM record (Gong assigns by CRM id) refuses anyone without one, with a reason. A tool that cannot create sequences is pointed at one a person made. Anything a tool would do on its own that breaks a rule is the connector's problem to prevent: HeyReach reactivates a paused campaign when leads are added, so its connector never adds to a paused campaign.
- **One contract test suite every connector must pass**, run against a scripted fake of each tool. Adding a tool means writing one file and passing the suite. Connectors built: **Instantly and HeyReach** first, simulated in the demo and labeled, then Smartlead, Apollo and Gong. None is proven until a real account runs it.
- **Channel choice.** Email needs a verified address. LinkedIn needs a profile. Someone with only a LinkedIn profile goes LinkedIn-only, and someone with only an email goes email-only.
- Templates are approved once in Settings, versioned, per channel, and labeled **pre-event** or **post-event**. An event uses pre-event until its first day and post-event after.
- The uploader presses one button to create draft sequences per priority and channel. Pressing again adds only people not yet added: this is how late registrations join, and owner say runs first for any account new to the event.

**The gate runs at every moment someone could be contacted: at adding, at launch, and at every resume.** Per person, per channel:

1. Not dropped, not suppressed (opt-out and wrong person).
2. Owner decision is include or defaulted. A pending decision fails.
3. Email channel: verified twice, or once if the uploader chose that for this event; verification inside the reuse window; no CRM bounce since. LinkedIn channel: a profile URL.
4. `preSendCheck` passes, extended with account do-not-prospect and wrong-person suppressions.
5. Not in another cadence, active or paused.
6. No hold applies (section 6), and no CRM activity in the last 14 days that the desk did not cause, unless the owner said include after that date.
7. A legal basis is recorded for the person's region (below).
8. Named, because templates need a name. A person with `person_id` missing is linked first.

A CRM that cannot answer fails the gate. At launch that **pauses the whole sequence** and alerts. A refusal has a reason and, when it can clear, a `retry_after`, and a sweep retries those.

**At launch:** the desk observes `sequenceState` turn active by polling and re-runs the gate, removing anyone who now fails within one poll interval, default 5 minutes.

**After launch, nothing waits for a gate.** Any opt-out, from any source (`recordOptOut`, a reply, the CRM), removes that person from every cadence at once, and a sweep every 15 minutes re-reads CRM flags and suppressions for everyone active.

- Deleting an event with an active sequence is refused. A Review tab drop removes the person.
- **Sender limits:** per-sender daily caps live in the tool; where it exposes them the desk warns. A bounce rate over a configured threshold (default 3%, a rule of thumb to confirm) pauses that sequence and opens a case. Authentication and one-click unsubscribe are the sending tool's job, and the launch checklist says so.
- **Legal basis is a person's decision.** Before launch the uploader records the basis for contacting this list, per region. Region comes from the person's location, then the company's country. Unknown is its own region. The desk stores who recorded it and what they said, gives no legal advice, and excludes any region with no recorded basis.

## 5a. The sending layer

A sequence that does not have enough healthy senders does not go out. Built in `src/shared/sending.ts` and `src/server/sending.ts`. Every number is a default to confirm against real sending.

- **How many.** The desk simulates the sequence: first touches spread over the launch days (default 5), each later step landing on top. The busiest day divided by the per-sender cap (default 30 emails a day, 20 LinkedIn actions) is how many senders it needs, plus 20% spare.
- **Which ones.** Each connector lists its accounts with health. A sender is refused for: not connected, health not reported or below the floor (default 90, raised to the tool's own guidance), under 14 days warm, bounce over 2%, spam over 0.3%, or already fully used by other live sequences. The rest are ranked healthiest first and spread, at most 4 per domain.
- **Proof it lands.** A domain with no SPF and DMARC record is not used. Where a placement test tool is in use, a domain with no passing test in 7 days is not used (at least 80% to inbox). DKIM needs a selector the desk does not know, so the tool's own check stands for it, and the launch checklist says so.
- **Short means stopped.** Too few healthy senders: the sequence is marked short, says how many it lacks, and pauses if someone launches it anyway.
- **While it runs.** Every sweep re-reads every sender. One that goes bad is dropped and a spare takes over. With no spare left, the sequence pauses and a person hears.
- **What a tool cannot do.** A tool that does not show its accounts (Gong) is marked "not visible" and the screen says the desk cannot vouch for them. A tool that shows them but cannot be told which to use (HeyReach) gets a named list for a person to attach.

## 5b. The post-event wave

Status: built on `v2`, 2026-11-09, in `src/server/post-event.ts`, tested in `tests/post-event.test.ts`. Before it, pre-event sequences ended on the event's first day and nothing started the follow-up: a person had to remember to press set up again, and a press on day one already counted as "post". A fresh review of the spec found nine gaps before building; each is answered below.

**When.** An event's days are its catalog dates, or its own `ends_on` for a custom multi-day event, or its start date for a one-day event, in the event's local time. Pre-event sequences end on the first day. While the event is on, set up refuses. The day after the last day, the event's channel gets a card for the person who uploaded the list: who goes into the follow-up, in groups, **after every check has run**, with the reasons the rest are held back, and one button when anyone is ready. In Slack, anyone mapped in `SLACK_USER_MAP` can press it; on the web, it is on the Outreach screen and the event page. Nothing starts without a press. One business day without a press brings one reminder. The button works until 10 days after the last day; after that, set up says the window has closed. An event whose owners are still deciding gets its card once they are done, if the window is still open.

**Who, by what happened at the event.** After the event, that matters more than the tier did. Each person is in the first group that fits:

| Group | Who | What happens |
|---|---|---|
| Met | A meeting at this event (any status), an on-site meeting, or a quick-add capture | Nothing automated. A rep has them. |
| Hot | A capture marked hot | At capture time: a task in the CRM and a card in the event's channel for the rep who had the conversation, the same day. Never sequenced. |
| Replied | Replied to anything for this event, other than an out-of-office or a bounce | Nothing automated. The reply flow and a rep have them. |
| Scanned | A badge scan, including walk-ups who were never on the list | The `scanned` post-event template |
| Reached | Sent at least one pre-event step for this event | The `reached` template |
| Not reached | Everyone else kept on the list | The `not_reached` template |

Each group falls back to the general post-event template when it has none of its own. Copy for "not reached" should not assume the person came: the list is registrants, and nothing tells the desk who attended unless they were scanned. The gate still runs for everyone: a walk-up with an email nobody verified does not go in by email, a person at a company with a meeting is held by that meeting, and a no or an opt-out keeps them out.

**Who can come back.** Ending a sequence on the calendar relabels only people who were simply in it, or paused only for an out-of-office. Anyone paused for anything else keeps their own reason (a meeting, a reply, a booth conversation), so they cannot slip into the follow-up. Found by the review: before this, the event starting relabeled everyone, which would have put someone who said "interested" before the event into the wave.

**How long.** A post-event template's last step comes at most 10 days after its first, checked when it is approved. Post-event sequences end 24 days after the last day, so one started on the last allowed day finishes, and at scoring at the latest. The event moving to closing at day 14 no longer cuts them short. A draft that never got a campaign in its tool ends on the same calendar.

**Same rules as every sequence:** the gate at add, launch and resume, sender sizing and health, the launch checklist, the first cohort, the CRM trail. Post-event sequences are keyed by channel, group and zone (the group lives in the `priority` column), where pre-event ones are keyed by channel, priority and zone.

**Not built:** a hand-off at the end of the wave (nurture is the CRM's), and telling attendees from registrants beyond badge scans.

## 6. Touch log and holds

`touches (id, domain, person_id null, contact_id null, event_id, kind, channel, reason, at, source, dedup_key unique)`.

Every sequence add, send, reply, meeting and owner decision writes one. **It stops collisions only for what it can see**: a sequence launched directly in the sequencer without the desk, or an owner's own email, never arrives. The CRM's last activity date is read at each gate to narrow that gap, and the screen does not claim more.

**Holds** are rows, not inferred: `holds (domain, person_id null, event_id null, cause, cause_id, started_at, expires_at not null)`. A null person means the whole domain. A null event means every event.

| Cause | Scope | Expires |
|---|---|---|
| Booked meeting | Domain, all events | Outcome recorded plus 14 days; 30 days after the meeting if no outcome, and the rep is reminded at day 3 |
| Mine | Domain, that event | The event's motion reaches `scored` |
| Live thread: a genuine reply with no resolution | Domain, all events (colleagues pause too) | 14 days |

**A hold's expiry never restarts anyone.** It only makes them eligible, and a resume still passes the gate. A person under a **doubtful** reply is not on a hold at all: they stay stopped until a person decides.

Companies with no domain (single-card) cannot be held and cannot be sequenced. A parent and its subsidiaries are one hold when the desk knows the link.

**Attribution across events.** A reply or meeting is credited to the event whose sequence sent the last message to that person. Touches outside any sequence are credited to the most recent event they were on the list for.

## 7. Replies

Each connector turns its tool's webhooks or polling into the same normalized events, per its declared capabilities. Where a tool's webhooks have proved unreliable, poll and webhook both run and the unique message id removes duplicates. A reply on any channel is handled the same way.

Inbound goes to `inbound_messages` first, unique on the provider's message id, and a job processes it, so a crash replays safely.

- One model call classifies into: interested, meeting request, referral, not now, not interested, out of office, unsubscribe, bounced, wrong person, departed, other. Output is a code from the list. **Reply text is untrusted data, fenced, and can only choose a code.**
- **Code runs first.** An explicit bounce signal from the provider, and unsubscribe keywords, are matched before any model call.
- **Stop before thinking.** Every inbound message immediately pauses that person's whole cadence on every channel, before classification. It resumes only if the classification says so and the gate passes.
- Confidence is not a model score. A reply is **doubtful** when the classification fails validation, is `other`, the card has run out, or the model contradicts a code match. **A code match for unsubscribe always acts**, doubtful or not. Doubtful replies stay stopped until a person decides, and nothing expires that.
- **Consequences, in code, and only after the checks above:**

| Code | What happens |
|---|---|
| Unsubscribe | Suppression, CRM opt-out queued, removed from every sequence at every event |
| Bounced | Verification marked negative, removed from sequences |
| Wrong person | Wrong-person suppression, removed |
| Departed | Removed, successor case opened |
| Out of office | Resumes after the stated return date, or 7 days |
| Referral | Case with the named person |
| Interested, meeting request | Stays paused for a rep, posted to the event's Slack channel with the account owner @-mentioned |
| Not now, not interested | Removed from this sequence, recorded |

A suppression caused by a model label alone (no code match) is marked `needs_confirmation` and a person sees it, while the person stays stopped. The model never drafts or sends.

Reply rates read a single view that excludes the carve-out codes.

## 8. Meetings

Three ways in: a rep marks a reply booked, the Sheet's Meetings tab, or a calendar webhook through a `Calendar` seam. Meetings rows gain a hidden id so a reschedule updates a row. Times are stored with a timezone.

- Booking pauses the booked person and every other contact at the domain, kept and never deleted, with a hold.
- Status: proposed, booked, held, no-show, cancelled, rescheduled. **Cancelled or no-show releases the hold** after a rep confirms, and paused people resume.
- A rep who cancels without recording it is caught by the 30-day expiry in section 6.
- A prep brief is a new Concierge tool, reading only delivered facts through its existing views. It adds no CRM fields beyond those already on the delivered list.

## 9. CRM sync

The outbox's retry safety rests on writes that only fill blanks. Creates are different, so:

- New outbox kinds `campaign_member` and `task`, each with a desk-generated key stored on the row.
- **Campaign member:** Salesforce errors when a member already exists rather than duplicating, so that error counts as success.
- **Task:** the record id is stored on success. Since a crash after the call could create a duplicate, the Task carries the desk's key in a custom field and the adapter checks for it first.
- **Net-new people** have no record. They are written as Leads only if the uploader turned that on for the event, otherwise they are skipped and counted. One exception: a positive reply always creates its trail, a Lead if there is no record, the campaign member as Responded, and a task for the rep. A Lead outbox row looks up the email first, so a crash cannot duplicate one.
- The seam gains `createCampaignMember`, `createTask`, `createLead` and `opportunities(accountIds)`, the last returning id, stage, amount, created date and stage history. All of this is tested on simulated shapes and unproven until a real org connects.

## 10. Debrief

Two days after the event's last day, or delivery if later, anyone with a held meeting gets a short Slack prompt. One model call, on the Motion card, extracts facts. With no approved Motion card the prompt still goes out and the answer is kept, unread by any model. **Every fact must quote the debrief as a literal substring or it is discarded.** A person accepts or rejects each debrief, and only accepted ones aggregate. Re-running accumulates.

## 11. Scorecard

One SQL view defines each funnel step. Enrollment funnel: kept, enrolled, sent, replied, booked, held. **Meetings logged with no enrollment are counted beside it, not inside it**, so the steps can be compared honestly.

- **Pipeline:** an opportunity counts only if its account had a held meeting credited to this event. **New pipeline** is created within 30 days after that meeting, with no open deal at the account at the time. **Pipeline it moved** was already open and moved forward within 90 days after. One opportunity is credited to one event. It is influence, never sole credit, and needs `opportunities()`. With no CRM the line reads "not available".
- Cost stays apart: tickets, and travel from seat requests, in dollars; AI in dollars; credits per provider in credits. Cost per held meeting uses dollars only and says it excludes credits.
- **Timing:** first score 30 days after the event's last day, revised at 60 and 90, each version kept.
- **Score:** held meetings per thousand dollars, and influenced pipeline per dollar, each shown beside the median of past events. No blended number until real outcomes justify weights. An event with fewer than 5 held meetings shows its counts and no score.
- Past scores appear where a seat request for the same conference is decided.

## 12. Learning

All aggregation is `GROUP BY`.

- Meetings by company tier, title tier and segment. People dropped who later appear in a deal.
- Accepted debrief facts, by account and theme.
- A proposal is a suggested edit to the ICP or title table, with its evidence. It takes a person to accept, and goes through the existing ICP confirm screen as a new version. Fewer than 20 outcomes in a group reads "too few to say".

## 12a. Slack, in the open

Every event has its own public channel (`evt-<event-name>`), opened by the desk on its first post and stored on the event. Everything about the event goes there: the cost card for its paid steps (to the SDR who uploaded the list, the only person who can confirm it), owner cards and the one-day warning, hot replies, doubtful replies, replies nobody picked up, meeting reminders, debrief prompts, the daily digest, the scorecard. The person a card is for is @-mentioned at the top and invited to the channel first, because Slack does not notify someone outside a channel. Nothing goes by direct message: a reply or an owner card sent privately is work the rest of the team cannot see, cover for, or learn from. This is the same call v1 made for cost approvals (DECISIONS §10).

Seat requests and seat approvals are leadership's and never go to an event channel, where everyone is: they go to the seats channel (`SLACK_SEATS_CHANNEL`, defaulting to the approvals channel). All of it is tested against a stand-in for Slack; real channel creation and the `channels:manage` scope have not run in a real workspace. Problems that belong to no one event go to the ops channel (`SLACK_OPS_CHANNEL`, defaulting to the approvals channel): a tool gone quiet, a pass that hangs, a step that failed. One per problem per day. A Slack message that failed for good is not announced to the same Slack; it is logged, kept as an alert, and counted on `/api/health`.

The background pass runs every five minutes. Every call to a tool times out at 30 seconds and every Slack call at 15, so one hung call cannot hold every stop behind it. A pass still running after 15 minutes is posted straight to the ops channel by the next timer, not queued behind the stuck pass. Once a pass has run in the process, `/api/health` answers 503 when none has finished for 20 minutes, and it carries today's alert count, for an outside uptime check that works even when Slack does not.

## 13. Integrity

Nightly checks that observe, alert and never repair. Nobody opted out is enrolled. Everyone enrolled passed a gate that has a row. Every pause has a cause and every hold an expiry. Ledger reservations balance. **The enrollment funnel never increases down its steps**, with logged meetings outside it by definition.

## 14. Testing and stress

- Simulated sequencer, replies and meetings use authored rates, labeled, as v1 does.
- Replay: 10,000 inbound events with duplicates and out-of-order delivery equal one clean pass.
- Real Postgres in CI alongside PGlite, closing v1's row-lock gap.
- Crash at every step of enrollment, reply handling and outbox: replay equals clean.
- Reply classifier: real recorded evals on a labeled set with a frozen holdout, plus an injection set of replies that try to instruct the model.
- Collision tests: unsubscribe mid-enrollment, launch before the poll, owner changes, cancelled meetings, a person in two events, a reply on one channel while the other is mid-step, a resume after a hold expires.
- Every connector passes the same contract suite.
- The gate at 10,000 people on real Postgres (`BENCH_GATE=1`, `tests/gate-scale.bench.test.ts`), with ten touches and two messages of history per person: 60.5 s before, 18.4 s after rewriting the cool-off check as three indexed lookups and adding two partial indexes (migration 0043), with the same 9,775 passed and 225 in cool-off. The rest is about eight round trips per person; batching each check over the whole list is the next step if a press needs to be faster. The funnel view reads in 34 ms at that size. Not measured: the other-cadence check with many live enrollments at other events (the bench had none).

## 15. Build order

Real Postgres in CI. Intake. Motion and Motion card. Touch log and holds. Owner say. Connector contract, the Instantly and HeyReach connectors, and the gate. Replies. Meetings. CRM sync. Scorecard. Debrief. Learning. Integrity alongside each.

## Open, to confirm on a real account

- Each tool's real payloads, plan requirements and limits: webhooks on Instantly reportedly need a higher plan, and none of this has run against a real account.
- Real Salesforce stage names, custom fields and Lead rules.
- Whether a thread per event suits a real team better than a channel per event. Built as a thread first.
