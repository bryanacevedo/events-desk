# Before the list, and choosing events (redesign step 7)

Spec for `~/Developer/events-rethink/steps/step-7.md` (PLAN section 5 path 2, section 9 step 7). Written 2026-11-15 before any code. Decisions 96 onward in `docs/DECISIONS.md`. Migration 0061.

## 1. What this adds, and which side each step is on

The centaur rule (SESSIONS, 2026-11-15): code does the volume, a person keeps the judgment.

| Piece | Code does | A model does | A person decides |
|---|---|---|---|
| Target accounts likely at an event | Matches the team's target accounts against pasted or uploaded speaker and sponsor pages, against the company lists of earlier editions of the same conference, and against people already captured for the event. Shows the sentence each match came from | Nothing | Adds the page, rejects a wrong match (with a reason) |
| Meeting goal tracker | Counts held and booked meetings by rep against the event's goal; lists who goes and has nothing booked | Nothing | Whether to push; nothing is sent from here |
| Choosing events | Ranks next year's candidates by a stated rule from overlap, cost and past return | Nothing | Which to plan: the ranking only orders a list |
| Which events to repeat | Counts, compares groups of past events, corrects for the number of comparisons, says "too few to say" | Words a pattern that passes (checked in code) | Records Repeat or Drop with a reason |

No blended score (LIFECYCLE 11: "no blended number until real outcomes justify weights"). Every figure on the screen is a count or a dollar amount with its source.

## 2. Words

- **Target accounts**: the existing `target_accounts` table (migration 0053): companies the team chose, by upload, manual entry, CRM or Market Desk. This step adds the screen to read and upload them (hosted events already used the table). It adds no tier column: with Market Desk connected its A and B accounts are what gets written there; alone, the team's uploaded file is the list.
- **Candidate**: a `catalog_events` row (the desk's list of conferences) that starts at least 30 days after today (`CANDIDATE_LEAD_DAYS`, so next week's committed events are not offered as a choice) and within 400 days (`CANDIDATE_DAYS`), whether or not it has an event row. Its event row, when several share the `catalog_id`, is the one with `parent_event_id IS NULL`, not declined first, then the newest.
- **Series**: one conference across years. Its key is `conferenceKey(name)` (`src/shared/assessment.ts`), after one planner-made link (section 7). "Money20/20 Europe 2026" and "Money20/20 Europe 2027" are one series.
- **Page**: text of a speaker, sponsor or exhibitor page, pasted or uploaded for a candidate. **Match**: a target account named on a page (or by domain), with the line it was found on.
- **Evidence kinds** for "likely there": `page` (a counted match on a page), `past` (the account was on the company list of an earlier edition of the series that we have a list for), `captured` (a company at the candidate's own event row with a person already in the desk, by any source).
- **Today** is the desk's own: `todayOf(deps)` (the demo's clock, `samples/lumen-world/events_desk_clock.json` read through `world-slice.ts`, 2026-11-24). `current_date` in SQL is never used here.

## 3. Data (migration 0061)

```
roster_pages   id, catalog_id -> catalog_events (cascade), kind speaker|sponsor, input pasted|uploaded, filename, body (<= 60000), body_hash, added_by, created_at, UNIQUE (catalog_id, body_hash)
roster_matches id, page_id -> roster_pages (cascade), account_id -> target_accounts (cascade), matched_on domain|name, quote, status counted|rejected, rejected_by, rejected_reason, rejected_at,
               UNIQUE (page_id, account_id), CHECK ((status='rejected') = (rejected_by IS NOT NULL AND length(trim(coalesce(rejected_reason, ''))) > 0 AND rejected_at IS NOT NULL))
series_links   alias_key PK, series_key, reason NOT NULL (non-empty), created_by, created_at, CHECK (alias_key <> series_key)
repeat_decisions id, series_key, decision repeat|drop, reason, decided_by, decided_at, evidence jsonb, CHECK (decision = 'repeat' OR length(trim(coalesce(reason, ''))) > 0)   -- insert only; the latest row per series is current
repeat_wordings id, reading_hash, pattern_key, status pending|done|failed, text, by model|template, model, input_tokens, output_tokens, created_at, UNIQUE (reading_hash, pattern_key)
```

A reason on every drop and every rejected match is enforced by the database, as for every other drop in the desk. Every such CHECK wraps the reason in `coalesce(..., '')`, because `length(trim(NULL)) > 0` is NULL and a CHECK accepts NULL (`series_links.reason` is `NOT NULL` with the same non-empty CHECK). A migration test inserts a NULL reason into each table and expects a refusal.

## 4. Target accounts and matching (`src/server/overlap.ts`)

- `normName(s)`: lower case, accents folded, `&` to "and", punctuation to spaces, then the legal suffix tokens (inc, llc, ltd, plc, gmbh, sa, ag, corp, corporation, co, company, limited, holdings, group) removed from the end only and repeatedly, spaces collapsed. An account whose normalized name is a single token of fewer than 3 characters, or is in `AMBIGUOUS_NAMES` (a short list of common words kept in `overlap.ts`), is matched on domain only.
- `matchPage(body, accounts)` is pure. The page is cleaned (HTML tags removed, entities decoded with `decodeEntities`); it is split into lines. A line is split into tokens on anything that is not a letter or digit (Unicode aware; JS `\b` is not used because it fails on accented names) and each token is normalized as above. **Domain match**: the account's domain equals a host on the line, or its `www.` form, or the host of an `@` address (subdomains do not count). **Name match**: the account's normalized tokens appear as one contiguous run in the line's tokens, and the first token of that run begins with an upper case letter or a digit in the original text. Domain is tried first. One match per account per page, first line wins, `quote` is that line trimmed to 200 characters, accounts taken in name order, so the same page and accounts give the same list.
- A wrong match can be rejected with a reason. Rejections hold for the candidate, not the page: when a page is added, an account that already has a rejected match on any page of the same `catalog_id` is stored as rejected with that reason, so an edited page does not bring it back.
- `likelyThere(db, today, catalogId)` returns, per target account, its evidence: `page` (counted matches, with the page kind and quote), `past` (the series' earlier editions with a list: companies of those events matched by domain, else by `normName`), `captured` (companies of the candidate's own event row, same matching, with the count of people at the company). `past` and `captured` count only people whose `contacts.source` is `attendee` or `onsite`; a `prospect` (a person the desk chose to target, such as the world's people-to-meet file) never counts as evidence that the account will be there. An account counts once however many kinds name it. Totals: `accounts` (distinct), and `by_kind` counts (an account can sit in more than one kind).
- Target account rows are read as given. Domain is lower case from the table; company domains are `companies.primary_domain`.

## 5. The tracker (`src/server/goal-tracker.ts`, `GET /api/events/:id/goal-tracker`)

For an event with `goal_meetings_held`:

- **Phase** from `starts_on`, `ends_on` (else `starts_on`) and today: `before`, `during`, `after`.
- **Counted meetings**: `booked` and `rescheduled` are booked (a moved meeting keeps its row and stays live, as in Overview and the CRM sweep). Before and during: held plus booked; after: held only, with a separate count of booked or rescheduled meetings with no outcome, "waiting for an outcome". `proposed`, `cancelled` and `no_show` never count. Held is `count(DISTINCT contact_id)` over held meetings, the `event_funnel` `held_all` definition, so after the event the held figure is read from `goalResult` and the Plan tab never shows two held numbers; a test pins Money20/20 USA 2026 at its recorded held figure of 10 of 16.
- **By rep**: every person the `who_goes` view lists with the role attend or host (seat status approved or none; per-seat events keep who goes in `seat_requests`, which that view folds in), plus any `meetings.rep` with a counted meeting. A rep is matched by name, case blind. A meeting with no rep is counted in the total and listed as "no rep named". Each rep row: held, booked, and `nothing_booked` true when going and zero of both.
- **Words** (counts, never percentages): before `18 of 30 meetings booked, 9 days out`; during `18 of 30 meetings booked or held, day 2 of 4`; after `10 of 16 meetings held, ended 34 days ago` (and `, 2 booked and waiting for an outcome` when so). A goal of 0 reads as no goal. No goal: the route answers `goal: null` and the screen shows nothing.
- Counts only. No dollar key in the answer; it is readable by anyone who can read the event (a rep too), and goes through `forRep` anyway.
- **Accounts met** (`goalResult` in `plan.ts`) stops being the tier 1 stand-in when the team has target accounts: it counts target accounts with a held meeting at the event (meeting `domain` equals the account's domain, else the contact's company `normName` equals the account's). With no target accounts the tier 1 stand-in stays and its words do not change (the existing test keeps passing). `goalResult.accounts` gains `basis`: `target_list` or `tier1`, and the Result and tracker show it in a small caption ("from your target account list", "tier 1 companies"). Uploading a list therefore changes how past events' accounts met read; that is stated in the decision and the caption says which basis applies.

## 6. Choosing (`src/server/ranking.ts`, `GET /api/choosing`; for leadership, GTM and planners, `canPlan`; reps get 403 as for Budget)

For each candidate:

- `event`: the event row if any (id, stage, plan stage, decline reason), else "no plan yet".
- `likely`: the section 4 evidence; its account list (names, owner, deal stage) with kinds.
- `cost`: the plan's planned total (`plannedTotal`) when above 0, kind `plan`; else one pass at the catalog price when `price_is_estimate` is false, kind `one_pass`; else one pass at an estimated price, kind `one_pass_estimate`; else kind `unknown`. 0 cents is unknown. The kind is shown in words. Dollars appear here only because the route is leadership's.
- `past`: from the most recent earlier edition of the series that has a written scorecard, else a reading made without writing for an event in motion `closing` or `scored` (the same read `/api/results` makes): held meetings, cost, held per $1,000 (only when scored, at least 5 held, as in the scorecard), pipeline per dollar (only when the CRM was read), the event's name and year. `vs_median`: `above`, `below` or `same` against the median held per $1,000 of every scored past event in the desk, each event counted once by its latest written scorecard window; `null` when the edition is not scored or there are fewer than 2 scored events to take a median from.
- `ours_last`: the latest `repeat_decisions` row for the series (decision, reason, who, when), shown beside the row.

**The order** (fixed, printed on the screen as "How this is ordered"): three groups, in this order: not declined and not below the median; last edition below the median; declined (kept in the list with its reason). Inside a group: cost kind (`plan`, `one_pass`, `one_pass_estimate`, `unknown`), because a plan's whole budget and one pass are not the same cost and are never divided into each other; inside a kind, target accounts per $1,000 of cost, highest first, compared by integer cross multiplication (`a1 * c2` against `a2 * c1`, no float division); then target accounts; then start date; then `catalog_events.id`. The ordering is a pure function of the candidates: adding or removing an unrelated candidate never moves another (the median uses past events only), and a test pins it.

Each candidate answers `reasons`: short sentences built from the facts by code ("37 target accounts likely there: 24 from last year's list, 9 named on a sponsor page, 12 with people already captured", "Cost: the plan, $24,000", "Last time: 10 held meetings, 0.4 per $1,000, below the median of 1.1"). No model.

Routes (all `canPlan` to read; writes need `canPlan` except where noted):
`GET /api/target-accounts` (new); `POST /api/target-accounts` and `/import` already exist with `canPlan` (`hosted-routes.ts`) and are reused; `POST /api/choosing/:catalogId/pages` (`{kind, input, filename?, text}`; HTML is reduced to text; more than 60,000 characters is refused, not cut); `DELETE /api/choosing/pages/:id`; `POST /api/choosing/matches/:id/reject` (`{reason}`) and `/restore`; `POST /api/choosing/series-links` (`{name, same_as, reason}`); `GET /api/choosing/repeat`; `POST /api/choosing/repeat/decisions` (`{series_key, decision, reason}`, leadership or GTM only: `isLead`); `POST /api/choosing/repeat/word` (planners).

## 7. Series links

A conference that changed its name (SaaStr AI Annual 2026 became SaaStr Annual 2027 in the world) does not join by `conferenceKey`. A planner links the later name to the earlier one with a reason; `series_links.alias_key` is the key of the name being linked, `series_key` the key it joins. `seriesKey(db, name)` follows one link (no chains: a link to a key that is itself an alias is refused). The assessment's `conference_key` is not changed.

## 8. Which events to repeat (`src/server/repeat.ts`, `src/server/stats.ts`, `GET /api/choosing/repeat`)

Method copied from Account Desk's `suggestions.py` (DECISIONS 47 there), adapted to events.

**Units.** Past events (ended, `parent_event_id IS NULL`, not hosted) with a written scorecard (the latest window). **Outcome**: the event's `held_all` reached its `goal_meetings_held`. A past event with no goal is left out of the patterns and counted ("N past events had no goal"). Hosted events are left out (a dinner is not a conference).

**Series table** (always shown): for each series with a unit, its editions (name, year, held, goal, cost, held per $1,000 when scored) and the current `repeat_decisions` row. Counts only. A series with one edition reads "one edition so far".

**Patterns.** Three groupings, each value a group: `size` (the catalog's size class), `involvement` (the event carried a sponsorship, a talk, or a hosted side event, read from child `involvements.conference_event_id = event.id` for the last: three groups, an event in each it has), `region` (North America, Europe, Other, from the country). For each group G: `n_in` units in G, `k` of them met the goal, `m` units met the goal in all, `total` units. Skipped when `n_in = total` (nothing to compare against).

**Deviations from Account Desk, on purpose (decision 99).** Account Desk puts its minimum on the positive count and counts a pair as looked at when `k >= 1`. This desk has far fewer units, so: a pair is **looked at** when `n_in >= MIN_EVENTS` (5) and `total - n_in >= MIN_EVENTS` (5), a condition on the margins only, which is valid for the correction and does not loosen it when outcomes cluster. With `pairs` pairs looked at, `alpha_each = 0.05 / pairs` (Bonferroni). `p` is the one-sided Fisher exact test that G does better than the rest: the upper tail of the hypergeometric, exact integers (BigInt), `P(X >= k)` (`stats.fisherGreater(k, n_in, m, total)`, the same arguments as Account Desk's `fisher_greater`). Account Desk's "two different SDRs" has no event equivalent (an event's requester is usually the one planner), so it is replaced by `k >= MIN_GOAL_MET` (3). LIFECYCLE 12's "fewer than 20 outcomes reads too few to say" is for people groups and stays; for events the floor is 5 on each side (DECISIONS 99 amends LIFECYCLE 12 with a line).

A pattern **passes** when it is looked at, `k >= 3`, `rate_in > rate_out` and `p < alpha_each`. A pair not looked at reads **"too few to say"** with its counts ("2 of 3 met their goal; 1 of 1 elsewhere") and is not in `pairs`. A looked-at pair that does not pass reads "no clear difference" with `p` and `alpha_each`. The screen always shows `pairs`, the correction, and the counts for every pair. The thresholds are in one constant (`REPEAT_RULE`), shown on the screen.

**Wording.** `templateWords(pattern)` is the code-written sentence for a passing pattern ("Flagship events met their goal 5 of 6 times, the others 1 of 7."). `POST /api/choosing/repeat/word` words each passing pattern once per reading: it inserts a `repeat_wordings` row `pending` (unique on the reading hash and the pattern, so a repeat is a no-op), then calls the model with the new step `repeat_word` and the facts. A model answer is shown only if `checkWording` accepts it: JSON `{"text": ...}`, at most 2 sentences, no em or en dash, every number in it is one of the pattern's numbers and no name is outside the packet (`allowedFrom` and `numbersIn` from `perspective-check.ts`), no advice words ("should", "recommend", "we suggest"). Otherwise the template is used. The row records `by`: `model` or `template`. The simulated model (the demo and the tests) is not a model: it returns the code-written text it is handed, and the row says `template`. The screen shows the mark "Worded by the desk's template, no model" or "Worded by <model>, checked against the counts". A call that fails stays `failed`, is never repeated for that reading, and the template is shown. One reading is at most 6 calls: the passing patterns with the lowest `p`, ties by pattern key. The reading hash is a hash of the facts of the passing patterns, so a new past event makes a new reading.

**Decision.** A person records Repeat or Drop for a series; a drop needs a reason (enforced), a repeat may have one. The row keeps `evidence` (the series table row and the passing patterns as shown). It is advice to the team's own planning; it changes no event. Leadership and GTM only.

## 9. Money and roles

- The Choosing page and every `/api/choosing` and `/api/target-accounts` read are `canPlan` (the same gate as Budget and Results). A rep is refused with the standing money sentence. The tracker route is counts only.
- The tracker holds no company money. The ranking, the `reasons` strings (which carry dollars; `forRep` strips by key and would miss them) and the series table (cost, held per $1,000) hold it, so every one of them is behind `canPlan` and none is on a route a rep can read. `tests/rep-sees-no-money.test.ts` gains the tracker read for a rep and the refusal for the Choosing reads.
- Nothing here sends anything, books anything or spends credits. The one paid call is `repeat_word`, a model call counted before it is made, never repeated, and not available in the demo (the simulated model).

## 10. The demo (`src/server/seed-choosing.ts`, after `seed-world.ts`)

All from the vendored world slice and files this repository adds; nothing from the world's `truth/`.

- **Target accounts** (`source = upload`, a sample list named as such in the activity line): the 142 companies of `events_desk_targets.csv`, owners null (the world has no company region, so none is invented). Past-attendance overlap then comes only from the 38 of them that also sit on past lists: small, real, not circular.
- **Pages**: two sample pages in `samples/rosters/` (SaaStr Annual 2027's sponsor page and Forrester B2B Summit's speaker page), text written for the demo and named as samples (the file's first line says so, and the page's `filename` carries `sample`). They name target accounts and some that are not.
- **A series link**: SaaStr Annual to SaaStr AI Annual, reason "Renamed for 2027".
- **Two sample catalog rows** (`source = suggested`, `suggested_by` "sample", marked in the row): Money20/20 USA 2027 and Dreamforce 2027, so a candidate has a scored earlier edition (Money20/20 USA 2026 with 10 held, Dreamforce 2026 with 8) and the demo shows past return, "vs median" and the demotion. Without them no candidate in the window has a scored edition.
- **A goal and booked meetings** on an event in the near future (by the real booking path) so the tracker shows "days out"; Money20/20 USA 2026 keeps its goal of 16 and the tracker reads it after the event: held 10, by rep. The tracker's days-out reading is shown on the near event the seed gives a goal; it is also proven by tests.
- **No decision and no wording** is seeded: the demo's two scored events are too few to say, and that is what it shows. Nothing model-worded is invented. The wording path is proven by tests with a simulated model, marked as a template.

## 11. Screens

New page **Choosing** (`/choosing`, nav after Events for leadership, GTM and planners; on a phone under More). Design: the desk's own patterns only (ExpandRow, `pl-rows`, the `fig` figures, side sheets, Editable); T4 status is a word in ink. Sections: "Next year's candidates" (ranked rows that open to the reasons, the accounts, the pages), "Which events to repeat" (the series table, the patterns with counts and the correction, the decision), "Target accounts" (a count, the source, an upload). The tracker is a block in the Plan tab's Goal section, in all three layouts. No explainer subtitles; copy has no em dash.

## 12. Tests

`tests/choosing-overlap.test.ts` (normName, matchPage: domains, names, boundaries, capitalization, suffixes, determinism; likelyThere kinds and counts once; reject needs a reason and is not re-proposed), `tests/choosing-ranking.test.ts` (cost kinds, past return and median, the order, stability when an unrelated candidate is added or removed, declined last, series links), `tests/choosing-repeat.test.ts` (Fisher against known values and against Account Desk's own cases, the correction divides by pairs looked at, `n_in` of 4 reads too few, a constructed table that passes, one that has enough events and does not, the wording check, the simulated wording marked template, never repeated), `tests/goal-tracker.test.ts` (three phases, counted statuses including rescheduled and one held figure with `goalResult`, by rep, nothing booked, no rep named, accounts met by target accounts and the stand-in), the rep money test, the migration constraints, and the demo seed (`tests/choosing-seed.test.ts`). Existing results, scorecard, goal-result and prompt-cache tests stay green (the new step has an INPUT line). Each CHECK is tried with NULL, empty and blank reasons. Before the push: the full suite, `tsc`, both audits on a fresh server, design-lint, screen-copy, and the views looked at in a browser at 1536 and 375 px.

## 13. Not built, and risks

- No upload of PDFs or images of a page; text and HTML only. A model reading of a page's company names is not built (the match is code on purpose: a miss is visible as "not on the page", a wrong match is rejectable).
- Past attendance uses the lists the desk holds. An event that was never uploaded has none, and the screen says so ("no list from last year").
- The wording step has not been run against a real model in this step.
- **Risk: legal.** Matching people already captured uses the same data and terms as before; this step adds no new collection.
