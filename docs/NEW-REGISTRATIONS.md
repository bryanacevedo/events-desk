# Attendee list block and new registrations

Owner's request, 2026-11-09: people need a way to submit new registration lists, and a way to get back to the attendee list that was first submitted. Today an event takes one upload, the page has no Replace button although the server allows a replacement at `mapped` and `quoted`, a list that has run cannot be added to, and the original file is not kept (only `source_rows.raw` and the filename).

Terms. **Run step**: the person who uploaded a list confirms its paid steps (cost cards, `docs/DECISIONS.md` item 10). **Parent**: the delivered event. **Top-up**: the internal event that runs one file of new registrations.

## 1. Attendee list block

Shown on the event page once an upload exists: one row per list received, oldest first, with filename, who, date, rows, and for top-ups how many were new.

- New table `upload_files` (upload_id primary key, event_id, content_type, bytes). The upload limit stays 20 MB.
- Download is `GET /api/events/:id/uploads/:uploadId/file`, filename sanitized, upload checked against the event, and held to the same write-key check as non-GET routes because the file is raw personal data.
- Uploads from before this change have no bytes. Their row offers "Download rows", a CSV rebuilt from `source_rows.raw`, and says so.
- **Replace** shows at `mapped` and `quoted` on a normal event. Replacing deletes the old `uploads` row and its file, so the block shows one list.
- `POST /upload` stays first-list and replace only. It is refused on a top-up and at `delivered`.

## 2. New registrations

### The shape

A first attempt reused the delivered event, marking rows by batch and scoping each pipeline query. A fresh-eyes review found that unsafe: the pipeline is built around event-wide writes (`undoFreePass`, `freePass`, `finishIdentity`, `mergeByDomain`, `fuzzyListCases`, `openLaterCases`, title failure handling, spend guards, card pricing), and any one left unscoped damages or re-pays for delivered work.

So a top-up is **its own event row**, invisible as an event, with `parent_event_id` set. Every query scoped by `event_id` is then correct without being touched. The parent never leaves `delivered`: its Sheet, download, Overview place, Usage and End rules do not change while a top-up runs.

### Creating a top-up

Only when the parent is `delivered`, and only one open top-up at a time.

The file goes through `mapColumns` and `normalize`. Rows dropped at upload (junk rows, name-only rows) are counted apart and are never "new".

**Already in.** A row is already in if it matches anyone on the parent, attendee or prospect, dropped or not, using the same rule ingest uses for duplicates within a file (`shared/ingest.ts`: email or LinkedIn first; names decide only when an email is missing on one side, through `nameSet`). Emails are compared against what the file held (`source_rows.raw`) as well as `contacts.email`, because vendors overwrite the latter. A company-only row is already in if its company matches.

**Company match.** Against the parent's `key`, its `merged_names`, then `primary_domain` when the row carries a website or email domain.

**Nothing new.** No top-up exists afterwards, the file is not kept, and the response gives the counts.

**Something new.** One transaction creates the top-up event at `mapped` (same flow, settings and pinned ICP version as the parent, `seat_count` 0, the uploader as requester), its upload and file, and only the new rows. `row_count` is the number of new rows.

### Known companies and titles cost nothing

Each matched parent company is copied into the top-up with `inherited_from` set, carrying identity, domain, tier, firmographics, CRM facts and `list_status` as they stand, merged names included. A parent company with no usable tier stays without one, and the new person there drops with the reason the parent's people got.

Changes needed, all narrow and conditional on `inherited_from` so normal events behave as today:
- Identity, firmographics, company tier, CRM and add-prospects skip inherited companies.
- `mergeByDomain` never deletes an inherited row; `survivorOf` always ranks it first.
- `freePass` and `undoFreePass` leave inherited rows as they are, while `excluded_company` and `existing_customer` still drop a new person at one.
- Parent `title_tiers` are copied in. `startPersonaTitles` stops inferring "already read" from existing rows and uses an explicit column, so new titles are read and only unknown ones are paid for.
- `startTiering` title inserts use `ON CONFLICT DO NOTHING`.
- A top-up with nothing to research goes `quoted` to `researching` with a zero card and finishes through the normal path; a person with no company still gets a paid reverse lookup and appears on the card.

### Running

Stages, cards, the Run step, Slack and spend guards all apply to the top-up as an event. Reservations and row limits are its own, so nothing draws on a parent card. Cases are settled on the top-up, before it merges, in the panel below.

Ending at any point (declining a card, Discard, or Stop) sets the top-up to `declined`. It stays in the block as stopped. The parent is untouched. Money already spent stays recorded against the top-up and shows in Usage under the parent.

### Merging

When the top-up reaches `delivered`, one transaction moves its results into the parent: upload and file, source rows, contacts, new companies and answered cases. Rows pointing at an inherited company are re-pointed at the parent company. An email that already exists live on the parent is dropped as `duplicate`, so outreach never reaches someone twice. The top-up is marked `merged_at`, with no rows left. Answered cases arrive answered and are not asked again.

### The Sheet

`publishSheet` returns early when a link exists, so `refreshSheet` is new, and the retry route calls it. Rebuilding replaces the whole Sheet, and people type into it. So before replacing:
1. Read and apply Review decisions (`syncReview`).
2. Read Outreach status and Notes from Attendees and Prospects, keyed by a new hidden contact id column, and the Meetings rows as whole rows.
3. Write those into the rebuilt workbook.

A Sheet with no contact id column (published before this) cannot be matched: the event says so, and it is left alone until someone chooses to rebuild it. If a read fails, nothing is replaced, `sheet_error` is set and shown beside Open the sheet, and the download still works.

### Hiding the top-up

`parent_event_id IS NULL` on: `/api/events`, Overview, Events, Seats, Budget and the catalog links. Usage rolls a top-up's spend into its parent's row. `GET /api/events/:id` returns open and past top-ups for the parent.

### Counts

Rows received is the first file's rows plus each top-up's new rows. The funnel in the workbook and `Narrowing` use that, not the sum of file sizes and not the latest file.

## 3. Screens

- Attendee list block directly under the event's header facts. At `delivered` it has "Add new registrations".
- After upload: "212 new, 1,650 already in", then a panel rendering the top-up's own `StageBlock` (Review cost and run, cases, progress), with Discard.
- The stage tracker stays on Delivered. Design rules from `docs/SCREENS-BRIEF.md` apply.

## 4. Tests that must exist

- A top-up reserves and spends only for its new rows and new companies. Parent contacts, priorities, emails and companies are unchanged by a run, a decline and a merge (full row comparison before and after).
- Each match rule, in both directions of the email-missing rule; a merged spelling attaches to the parent company; a dropped or opted-out person stays out; a parent prospect who later registers; an all-duplicate file; a junk-only file.
- A file with different columns.
- Declining the Research card on a top-up leaves the parent untouched.
- `POST /upload` is refused at `delivered` and on a top-up.
- Merge moves everything, drops a live duplicate email, and is atomic.
- Replace removes the old upload and file. Download returns the exact bytes. An upload id from another event is refused. The write key is enforced.
- Sheet refresh keeps Review decisions, rep columns and Meetings; a failed read leaves the Sheet alone and shows the error; an old Sheet is left alone.
- No top-up appears in any list screen; Usage rolls it up.

## 4a. Corrections from the second review (these override the text above)

The separate-event shape held up. "Every event-scoped query is correct without being touched" did not, once a top-up holds copied company rows. Before building:

- **Creating.** `events.seat_count` has `CHECK (seat_count > 0)`: the migration relaxes it for rows with a parent. A top-up never publishes a Sheet of its own (`processEvent` calls `publishSheet` after `delivered`).
- **Ending.** Stages like `researching`, `finding_people` and `paused` cannot reach `declined`, and `declined` needs a reason. A top-up ends through a new `ended_at` marker that cancels its jobs. `moveError` stays as it is. A declined card ends the top-up.
- **Company match is not finished at creation.** After identity, a top-up company whose `primary_domain` matches a parent company is replaced by an inherited copy before `mergeByDomain`. The list gate also reads the parent's status. Merge resolves a key collision instead of aborting.
- **What an inherited company means.** Carry the parent's outcome: a company a person rejected (`in_research = false` with a tier) drops new people there with no spend. A company skipped only because its attendees were Title 3 is assessed for the first time. `finishTiering` needs that distinction; today it always writes `tiering_failed`.
- **Inherited rows are skipped by** `fuzzyListCases`, the `finishIdentity` loop, `late_stage_deal`, `spreadFor`, `retier`, `researchInputs` and `outreachInputs`.
- **Already in.** Mirror `ingest.ts` exactly: LinkedIn is consulted only when a row has no email. When the parent's file had no email and a vendor found one, the parent's found address counts, and a different address on the new row with the same name and company is treated as the same person.
- **Merging.** Runs in the same transaction as the top-up's move to `delivered`, or is retried on boot so a crash cannot block later top-ups. It runs after `openLaterCases` and moves open and skipped cases too, with their company pointers remapped. It also moves `title_tiers` and new `merged_names`. The top-up keeps its ledger and cards for Usage. `listSummary`, `currentUploader` and the workbook's "What ran" read the first list and the parent plus its top-ups. Merge triggers `refreshSheet`, and the polish step runs again.
- **Download rows.** `raw` is jsonb, so column order is lost and headers are not stored. A rebuilt CSV says so.
- **Download access.** The browser holds no write key, so a write-key check cannot pass. Use the same access as `/workbook`, and treat closing all three personal-data GET routes as part of real login.
- **Counts.** Store file rows and already-in on the upload, apart from new rows.
- **Single-card parents.** Top-ups are two-card only. A parent with no ICP gets no pin on its top-up.
- **Retention.** No event delete route exists, so "until the event is deleted" currently means forever.

## 5. Open

- **Build order (owner, 2026-11-09).** Section 1 and the delete option were built first. Section 2 is built (2026-11-09, migration 0038, decision 29 in `docs/DECISIONS.md`), against mocks and simulated vendors only.
- **Retention (owner, 2026-11-09).** Nothing is deleted automatically. Original files stay until a person deletes the event. Events get a manual delete option, confirmed and irreversible, removing the event's rows and files.
- **Apollo sequences.** Once review feeds automatic sequences, a merge must enroll only its new people. Not built here.
