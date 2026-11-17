# Film notes: the four-desk story (step 6 part 4, 2026-11-15)

For the film in `~/Developer/events-rethink/PLAN.md` section 11. Notes only: no film is made here, no narration written. Every number below is read from a run (the rehearsal's output, the world's files or a test), and a number marked `read at the shoot` must be read again from the rehearsal that is on screen, because the rehearsal's totals move with the code. No em dashes, no names of real clients, no real volumes (the world is simulated; say so in the film once).

## One line per shot: what it proves and where its data comes from

| # | Shot | What it proves | Where the data comes from |
|---|---|---|---|
| 1 | Dan Whitlock opens Events Desk: the year, what is due this week | The field marketer's own view; Lumen Ledger is the seller | The vendored world slice (`samples/lumen-world`, release 1.3.0 at a008e18), the world's 18 events, the clock at 2026-11-24 |
| 2 | Money20/20 USA: assessment, passes, sponsorship, a talk, the goal | The bet is written down before money moves | World 1.3.0 additions: the 2025 Money20/20 USA row, its assessment facts (marked Sample where the world has none), the sponsorship and talk at SaaStr Annual 2027 |
| 3 | The audience: target accounts, then the people, a reason on every drop | The agent finds people; a person decides who is dropped | `events_desk_targets.csv` (142 targets over the four coming conferences); the sweep writes only those inside the 45 day window |
| 4 | The Las Vegas side dinner: 24 seats, guests by state | The host event hangs under its conference | `events_desk_guests.csv`: 40 guests (20 attended, 2 no-show, 8 waitlist, 10 declined) |
| 5 | The CRM side, split screen: CRM Desk shows the dinner as a child campaign of Money20/20 USA, with its members at Targeted, Waitlist, Declined, Registered, Attended, No show | Events Desk wrote them; Waitlist and Declined are not responses | The rehearsal's CRM Desk after `stage/rehearse.py`; audit check 10 states the same facts (`read at the shoot` for counts) |
| 6 | The booking link: Dan pastes one link on the Outreach tab | A person sets the link; Account Desk reads it, never invents it | `stage/wire.py` checks 1 and 2 (Events Desk's keyed read, Account Desk's read of it) |
| 7 | Account Desk: a targeted person becomes a pre-event note, a draft waiting for approval, the day-7 draft carries the link | The agent drafts; the person approves; nothing is sent | `wire.py` check 3 (signals from targeted members), decision 94 in Account Desk (the link sits in the day-7 email only) |
| 8 | A person declines: the play stops, and the Outreach panel says so in words | Stopping is the safe direction and is automatic; restarting is a person's call | `wire.py` checks 4 and 5 (the decline written by Events Desk's own key, the play stopped, the status read back) |
| 9 | After: owner say, the debrief quote placed on the right contact | Events Desk writes only the quote, never model text | `crm-sync.ts` section 6 (debriefs); not exercised by the rehearsal (no debrief is accepted in the world), so shoot it on the demo |
| 10 | The result against the goal and the comparison with accounts nobody met | The loop closes with a number | Events Desk's own scorecard on the world's scored events; not part of this part |

## What to show on screen, and what not to

- Show the audit's last line (`N of M checks passed`) once, as proof that four desks agree; do not read the check names aloud.
- The CRM Desk screen must be the rehearsal's database, not a hosted demo: the hosted demos are separate builds.
- Do not show the Render pages (not deployed: Render deploys on hold, SESSIONS rule 20) and do not claim a live install.
- Nothing is sent in any shot. Say "drafts" where the on-screen word is Draft.
- Where a screen shows an example address (`.example`), keep it on screen: it is the proof the world is simulated.

## Facts the narration may use (each checked against a run or a file)

- Four desks on one simulated company, one rehearsal, each desk replays its own half and ends identical (`--verify`).
- Events Desk writes with its own key, scoped to its own desk, and CRM Desk records who wrote what.
- A decline is not a response; a waitlist is not a response; a target is not a response.
- Account Desk reads Events Desk for the event's name, dates and booking link once per campaign per day, outside its CRM transaction (decision 95).

## Not proven, so not in the film

- A send, a reply or a meeting held at an event on a real clock: the rehearsal journals only one send and one meeting from Events Desk and the demo's activities are stand-ins.
- Anything live on Render.
- Market Desk's tier replacing the priority-or-tier rule for targets (cross-repo item 11, open).
