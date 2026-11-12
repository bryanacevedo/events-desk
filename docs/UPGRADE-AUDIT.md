# Upgrade audit, 2026-11-11

Events Desk held against the bar Account Desk set: plain true copy, every label naming what it counts, demo data that obeys the
product's own rules, one decision per screen that stands out, phone at 390 wide, and a fresh reviewer for each kind of check.
Branch `upgrade-from-account-desk`, cut from `origin/main` at `b169b1f`.

## How it was reviewed

Six fresh reviewers, each a separate agent that had not seen the work, each pointed at one thing: docs against code,
demo data against the product's rules, copy, design (hands-on at 1536 and 390), compliance, security. The copy, design,
compliance and security passes finished. The docs and data passes were cut off by a spend limit before they reported; the data pass
was run again during the fixes (below). Two more fresh passes ran at the end, a goldfish on the finished docs and a second review of every change; see "Second pass". The demo they read is the committed snapshot (`samples/demo-snapshot.tgz`),
the same state the v3 film was captured from. Screens before the work: `~/Developer/events-desk-upgrade-shots/before/`.

Severity: **Blocker** breaks the product or misleads a visitor; **Major** a real defect a careful reviewer would call out;
**Nit** small. Status says what was done, checked against the code at the end.

## Security

| # | Sev | Finding | Status |
|---|---|---|---|
| S1 | Major | The public demo accepts sequencer webhooks from anyone: the demo connectors check a secret committed in `connectors/fake.ts`. | Fixed: `/hooks/*` refused on the public demo |
| S2 | Major | `POST /api/events/:id/review` (a workbook upload) is open on the public demo, which says it takes no files. | Fixed: refused on the public demo |
| S3 | Major | No request body limit: every route reads the whole body before any size check, so one large request can exhaust memory. | Fixed: a global limit, larger only on file routes |
| S4 | Major | `GET /api/approvals` returns seat prices and cost estimates to anyone acting as a rep. | Fixed: money stripped for reps |
| S5 | Major | Website reader: DNS-based SSRF (a public name resolving to a private address), and the size cap applies after the whole page is read. Real deployments only. | Size cap fixed; DNS check disclosed in the README |
| S6 | Major | No limit on anonymous writes to the public demo. | Fixed: 60 changes a minute per address, keyed on the address the proxy appends (a soft limit, not abuse protection) |
| S7 | Nit | A CRM deal URL becomes a link with no scheme check. | Fixed: only http(s) links |
| S8 | Nit | No security headers. | Fixed: `secure-headers` |

## Compliance (counsel to confirm every legal point)

| # | Sev | Finding | Status |
|---|---|---|---|
| P1 | Blocker | The contact basis is one free-text note per event and region, regions are raw strings ("Germany", "DE"), only two are strict, and "unknown" can be recorded. It does not encode country law. | Not built; the README now says plainly what the basis is and is not |
| P2 | Blocker | Nothing in code requires an unsubscribe link, sender identity or postal address in an email. | Not built (it would change the demo's templates, and so the state the film was made from); disclosed in the README |
| P3 | Blocker | An unsubscribe recorded only in Apollo or Gong never reaches the desk. | Disclosed in the README; not built |
| P4 | Blocker | Erasure misses the original uploaded file, raw rows, caches, the activity log, and scrubs Slack cards after the name is already gone; an empty input suppresses "". | Fixed with a test, except asking the CRM and the sending tool to delete their copies (disclosed) |
| P5 | Major | No privacy notice for people taken from an attendee list. | Disclosed in the README |
| P6 | Major | No retention schedule for person data. | Disclosed in the README |
| P7 | Major | Role checks on erasure and strict regions rest on the self-chosen "Acting as". | Already disclosed; README line extended |
| P8 | Major | Opt-outs never match a LinkedIn profile. | Not fixed (needs a migration and a matching rule); disclosed |
| P9 | Major | LinkedIn automation consent is the rep's, not the recipient's. | Disclosed in the README |
| P10 | Nit | A badge-scan-only person is not covered by the in-person check at other events. | Not fixed: adding badge scans to the in-person check could also stop the badge-scan follow-up the rules allow; needs a decision |

## Copy

| # | Sev | Finding | Status |
|---|---|---|---|
| C1 | Blocker | "5.4x" pipeline per dollar is shown while the same event has cost lines still to enter. | Fixed: the ratio says how many costs are not entered yet |
| C2 | Blocker | Results shows meeting rates of 7%, 10% from counts too small to read as rates; the count lives only in a tooltip. | Fixed: counts ("2 of 29") |
| C3 | Major | A thin ratio is greyed with the reason only in a tooltip. | Fixed: visible "under 5 meetings" |
| C4 | Major | "1/1 notes" is a bare fraction. | Fixed: "1 of 1 notes" |
| C5 | Major | "How we know" claims proof that five accounts cannot give; rates hide counts; "Ones we..." names nothing. | Fixed: "Met against the rest", counts beside the rates, "Accounts we..." |
| C6 | Major | One figure called "spent" on the Cost tab and "cost" elsewhere. | Fixed: "cost" |
| C7 | Major | Usage "Lookups" names no period; "Saved $1.60" could be the month or the year. | Fixed |
| C8 | Major | "Needs someone 22" adds rows of different kinds; "Cases to settle 10" counts events, not cases. | Fixed: no mixed total; the group says events |
| C9 | Major | README: statistics jargon (Wilson interval, point estimate, recall and precision) and praise headings ("What makes it careful"). | Fixed |
| C10 | Nit | "Second look at people" for the review step that the README calls review flags. | Fixed |
| C11 | Nit | Budget "$30,306 left" beside a quarter "over". | Fixed: "left this year" |
| C12 | Nit | Slack: a performed claim ("The sooner after the event, the better it lands.") and a triad. | Fixed |
| C13 | Nit | Notes have three names (notes owed, debriefs, what we learned). | Screens say notes; "What we learned" kept as the section of accepted notes |

## Design

| # | Sev | Finding | Status |
|---|---|---|---|
| D1 | Major | Zero figures in `--line-2` measure 1.55:1. | Fixed: `--mute` |
| D2 | Major | The Person sheet's kind label is rose-red text, against "no red text". | Fixed: kind colour only on the mark |
| D3 | Major | Keyboard users tab through every past event card before Today. | Not fixed: taking past cards out of the tab order left them unreachable by keyboard (second pass), so it was reverted; a roving tab order is the real fix |
| D4 | Major | Past runway cards fade their text to about 3.1:1. | Fixed: only the date block and logo fade |
| D5 | Major | On a phone the one decision on Overview (seat requests waiting) sits below everything. | Fixed: first on phones |
| D6 | Major | The People list stops 124px short of the page's right edge. | Fixed |
| D7 | Nit | The waiting badge, white on orange, is 4.31:1. | Fixed |
| D8 | Nit | Monogram logos crop in the seat call's logo stack. | Fixed |
| D9 | Nit | Seat rows show an empty grey circle for people with no photo. | Not fixed, not reproduced: the photos load lazily and the full-page capture may have caught them unloaded |
| D10 | Nit | Phone People rows misalign the tier and grade. | Not fixed |
| D11 | Nit | A few phone tap targets are 38 to 42px. | Fixed |
| D12 | Nit | Event sheet repeats a theme label. | Not fixed |
| D13 | Nit | People tab stacks three headings with near-duplicate counts. | Not fixed (35 includes people set aside on review; 32 is people to reach) |

## Demo data against the product's rules (fresh reviewer, during the fixes)

| # | Sev | Finding | Status |
|---|---|---|---|
| R1 | Blocker | Shoptalk Spring 2026 shows Closing with no scorecard 230 days after it ended, while the older NRF 2026 is Scored. | Not fixed (see below) |
| R2 | Blocker | Five delivered events are past the 14-day close but never closed (Money20/20 Europe and Dreamforce sequencing, FINNOSUMMIT owners with no decisions, Money20/20 USA in market 21 days after). | Not fixed (see below) |
| R3 | Major | Results says NRF is not scored and Shoptalk is, the reverse of their stages: the flag means "five or more meetings", not "scorecard written". | Screens now say "under 5 meetings" as well as greying the figure; the field name is unchanged |
| R4 | Major | Delivery, seat requests and creation are stamped with the build time (10 November), after outreach dates months earlier. | Not fixed (see below) |
| R5 | Major | `GET /api/seat-requests` gave a rep other people's travel and the budget headroom. | Fixed with a test |
| R6 | Major | Overview lists missing costs for Shoptalk only, though Money20/20 USA has four missing; it follows from R2. | Not fixed |
| R7 | Nit | Shoptalk's notes were answered the second they were asked. | Not fixed |
| R8 | Nit | Shoptalk: 4 met (people) against 5 meetings held; 35 people against 32 to reach. Different units, unlabelled. | Not fixed |

R1, R2, R4 and R6 share one cause: the seed builds past events at the build time and never runs the lifecycle's close and scorecard pass over them. Fixing it means changing the seed and rebuilding `samples/demo-snapshot.tgz`, which changes Shoptalk from Closing to Scored and every figure the film reads. That is Bryan's call (a new snapshot means a film pass from scratch), so it is listed for him and not done here.

Coverage the demo never shows: a single-card event, a new-registrations top-up, a pending or declined cost card, an event with no CRM, the "nobody reached" comparison, a won deal, a 365-day scorecard, a declined note, and "not now", bounce or wrong-person replies.

## Ported from Account Desk

| # | What | Status |
|---|---|---|
| A1 | The one thing waiting on a decision carries the soft halo Account Desk gives a proposed play (notes to accept on the Result tab). | Done |

## Second pass (two fresh reviewers, end of the night)

Found and fixed: the write limit trusted the first forwarded address (now the last, which the proxy adds; old entries expire instead of the map being cleared); past cards had no keyboard way in (reverted, D3 above); "3 to enter" did not say what it counted (now "not entered yet"); the halo could repeat on a second note (first only); the phone tap-target rule reached inline links (now rows and the brand only); the erasure scrub could touch other people's lines and read `%` and `_` as wildcards (now only the person's events, literal match); "of the rest" doubled up (now "others"); docs stated the file limit three ways and gave no test count.

Left: one reviewer found "Review flags" vaguer than the old label; reps still receive every seat's ticket and purchase price from `/api/seat-requests` while `/api/events` hides the list price from them (the README now says reps see ticket prices); the halo card repeats the author's name under the line that already names them.

## Tests

Before: 1,148 passed, 9 skipped (1,157). After: see PROJECT-STATUS, which records the final run.
