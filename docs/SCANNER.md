# The scanner (redesign step 3)

Spec written 2026-11-14 before any code. Plan section 6.4 and decision 8 in `~/Developer/events-rethink/PLAN.md` (including "What the community voice changes"), `events-rethink/raw/badge-scanning.md`, brief `events-rethink/steps/step-3.md`. Migration `0054_scanner.sql`. Decisions from 63 on.

## 1. The job

One phone web app for every rep at an event, from the scan to the follow-up. Per scan the rep does at most four things: scan, set hot, warm or cold with the event's qualifiers, say what was promised, save. The person then belongs to that rep.

Everything the rep does works with no signal. The desk is told when the phone is next open and online.

## 2. Words used here

- **Scan**: one act of scanning or typing one person, by one rep, at one moment. One row, whose id the phone makes (`scans.id`). Two reps scanning one person is two scans and one person.
- **Method**, best first: `badge_code` (a code that carries contact data, decoded on the phone), `badge_id` (a code that is only an id, resolved by the organizer's API), `badge_photo` (a photo of the badge face, read by a vision model), `card_photo` (a business card, same), `typed` (typing, with an email lookup against the event's own people).
- **Person**: a `contacts` row on the event (today's capture path, decision 45). A scan places one person or joins an existing one.
- **Placed**: the scan has a person and the hand-over has run. **Lookup pending**: a badge id waiting for the organizer's API. **Needs fields**: a photo with nothing read yet. **To confirm**: placed from a photo, with at least one field the reader was not sure of.
- **Qualifier**: a short question set for the event (at most three), each answered yes, no or blank on the scan.
- **Promise**: "what we promised them" (plan, community voice): free text, with an owner (a team member) for sending it. Optional.
- **Organizer adapter**: the one interface the desk calls to turn a badge id into a person (`organizer-api.ts`). Swapcard's Exhibitor API is the first implementation.

## 3. Must not change

A reason on every drop, enforced by the database (a duplicate merged by review is dropped with the existing reason `duplicate`). The gate before every touch. Owner say. Scans handed to the rep who scanned them. Booking holds the whole company. The money rules: a vision read is counted before the call and never repeated on an unknown outcome; credits and dollars are never added; money stays out of every rep read. Late registrations still merge. Events already running keep working. Country rules gate outreach, not the source: the scanner stores the person's country when it knows it and never blocks a scan for it; the existing gate decides later whether an email may go. Events Desk stays standalone: the scanner needs nothing from another desk, and the organizer adapter is optional.

## 4. Data model (`0054_scanner.sql`)

- `contacts.registrant_id text`, index on `(event_id, registrant_id) WHERE registrant_id IS NOT NULL`. The organizer's id for the person, when a scan or an import carries one.
- `scanner_settings(event_id PK, qualifiers jsonb, notice_text, notice_version int, organizer text null, organizer_event_ref, organizer_exhibitor_ref, updated_by, updated_at)`. `qualifiers` is a list of at most three `{id, label}`; `organizer` is null or `swapcard`. A key is never stored: it comes from the environment (`SWAPCARD_API_KEY`).
- `scans`: `id text PK` (the phone's UUID, checked against `^[A-Za-z0-9-]{8,64}$`), `event_id`, `rep`, `method` (check), `raw_payload text` (capped at 4,000 characters), `fields jsonb` (name, email, phone, title, company, country, linkedin), `uncertain jsonb` (field names a reader flagged), `registrant_id`, `temperature` (hot, warm, cold; default warm), `qualifiers jsonb` (qualifier id to yes or no), `note`, `promise`, `promise_owner`, `next_step`, `next_step_on date`, `marketing_consent boolean NOT NULL DEFAULT false`, `consent_notice_version int`, `consent_wording text`, `consent_at timestamptz`, `scanned_at` (the phone's clock), `received_at` (the server's), `seconds int` (time on the one screen), `state` (placed, lookup_pending, needs_fields, to_confirm, failed), `state_detail`, `contact_id`, `capture_id`, `near_contact_id`, `review` (null, open, same, different), `confirmed_by`, `confirmed_at`, `device text`.
- `scan_photos(scan_id PK, kind badge|card, mime, total_bytes, received_bytes, data bytea, read_state none|pending|read|failed)`. One photo per scan. `data` is appended by offset; the photo is complete when `received_bytes = total_bytes`. A photo is at most 8 MB and `image/jpeg`, `image/png` or `image/webp`.
- Nothing else is new. The hand-over is `onsite_captures` and the existing hold, touch, task and card path.

## 5. Decoding on the phone (`src/scan/decode.ts`, pure parsing in `src/shared/scan.ts`)

1. `BarcodeDetector` where the browser has it (Chrome on Android). Where it is missing (iOS Safari) a WebAssembly ZXing decoder (`zxing-wasm`, the maintained one; `zxing-js` and `html5-qrcode` are not used) runs in a worker on a downscaled frame.
2. The decoded text is classified by `classifyPayload`: a `BEGIN:VCARD` block is a vCard; text starting `MECARD:` is a MeCard; a `https` URL whose query carries contact fields (`name`, `email`, `company`, `title`) is a contact link; anything else is an id. A vCard or MeCard or contact link is `badge_code` and fills the fields on the phone. An id is `badge_id`: the raw text is the code, and the id is also the `registrant_id` candidate.
3. Parsing is forgiving and exact: vCard line folding and `\,` escapes, `N` and `FN`, `ORG`, `TITLE`, `EMAIL`, `TEL`, `ADR` country, `URL` for LinkedIn; MeCard `N:Last,First;EMAIL:...;TEL:...;ORG:...;;`. A value is kept as printed (typos included) and trimmed. A field never invented.
4. The raw payload and, where the rep chose it, a photo are always kept.

## 6. The offline queue (`src/scan/queue.ts`, `sync.ts`, the service worker)

- Each scan is written to IndexedDB with its id before anything else happens. A photo is stored as a Blob beside it.
- Sync runs while the app is open and online: on load, on `online`, on `visibilitychange` to visible, every 30 seconds while unsynced scans exist, and from the Sync button. iPhones cannot sync in the background; the app says so and prompts at day's end: when local time passes 18:00, or the event's last day ends, with unsynced scans, the Today screen's primary action becomes "Sync now" and a line says what is waiting.
- Order of one sync: for each unsynced scan, in time order, `POST /api/events/:id/scans` (idempotent on the id; a repeat is answered with the stored result and changes nothing); then its photo in 256 KB chunks with `PUT .../photo?offset=` (the server answers the bytes it holds, so an interrupted upload resumes from there); then, when the photo carries the only data, `POST /api/scans/:id/read`.
- The unsynced count is shown on every screen of the app. It counts scans not yet answered plus photos not yet complete.
- A scan is removed from the phone only after the server answered placed (or lookup pending) and its photo is complete. Scans stay in the phone's own Today list for the event for 7 days after that, then are cleared. CSV export lists every scan the phone holds (the unsynced ones always); it is the fallback when sync cannot work.
- The service worker caches the app shell and its assets (listed from the built `index.html` at install) and serves `/scan/<id>` from the shell offline. The event's scanner settings are cached in IndexedDB at every online open. A first open with no signal and no cached settings says so and offers typing only with the default notice.
- Camera in a home-screen web app: open WebKit bugs. The app tries the camera, and when it fails or freezes for four seconds says so and offers "Open in Safari" guidance, the photo picker (`<input type=file capture>`), and typing, which need no live camera. A Safari-tab path is the same URL. The scan screen avoids hash routing so the permission prompt is not repeated. **Manual test on two real phones is part of done and is recorded in PROJECT-STATUS** (iPhone Safari and home-screen, Android Chrome); the build cannot prove it.

## 7. The server

`src/server/scans.ts`:

- `ingestScan(db, deps, eventId, rep, input)`: validates, then inside one transaction takes the id's row with `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING`; when the id exists the stored result is returned and nothing runs again (the hand-over included). Then, in order:
  1. **Resolve.** `badge_code` carries its fields. `badge_id` with an adapter configured and a key present: call it (outside the transaction, with the call counted first); a found person fills the fields and the `registrant_id`; not found fails the scan with `state=failed` and the adapter's reason in words; no adapter or the call unavailable leaves `lookup_pending`, which the next sync (and `POST /api/events/:id/scans/resolve`) retries. A photo method waits for the photo and the read (`needs_fields`). `typed` looks the email up among the event's people and fills the name and company from the match.
  2. **Place** when the fields hold an email, a LinkedIn profile or a name and a company: `captureOnsite` with the fields, temperature and `source` (`badge_scan` for the three badge methods unless the scan is hot or the rep says they met, `quick_add` for card and typed), `registrant_id` and the country. The person goes to the scanning rep with a CRM task; hot ones reach the account owner the same day (a task for the rep, a card in the event's channel naming the account owner when the CRM has one). The scan row keeps `contact_id` and `capture_id`.
  3. **Consent** is stored on the scan whatever else happens: `marketing_consent` (false unless the person said yes), the notice's version and wording, the time.
- Dedupe order, in `captureOnsite`'s finder: `registrant_id`, then email, then LinkedIn, then name and company. A match joins the existing person (a second capture, one person, both reps' tasks). After placing, `nearMatches` (pure, `src/shared/scan.ts`) looks for a person on the event that is nearly the same and was not matched: the same company and a first name that is a prefix or a one-letter difference of this one (a nickname, a typo), or the same name and a different company at the same email domain. Any near match sets `near_contact_id` and `review = open`; the person stays placed.
- `resolveReview(db, scanId, decision, actor)`: `same` moves the scan's captures, touches, meetings and inbound messages to the near person and drops the scan's own person with reason `duplicate` (only when that person came from scans and holds nothing else); `different` closes the review. Both are logged with the actor. A review is answered once.
- Photos: `putPhotoChunk` (offset must equal the bytes held, else the answer is the held count and nothing is written; the total never changes after the first chunk); `readPhoto` runs the vision read.
- **The vision read** is an input job: `scan_read`, a new prompt step. The model receives the photo and returns `{fields: {name, title, company, email, phone, country, linkedin}, confidence: {field: "high"|"low"}, text}`; a field whose value is not in the text it transcribed, or is not shaped like its kind (an email without `@`), is thrown away; every field marked low goes to `uncertain`. A read from a photo is always `to_confirm` until the rep confirms, whether or not a field was flagged, because a vision model can misread a digit with no signal (research.md section 11); fields flagged low are marked "check" on the screen. When the read yields none of an email, a LinkedIn profile or a name with a company, the scan stays `needs_fields` and the rep types it. Reads are counted before the call in `llm_calls` under a lock on the event, capped at `scanner.reads_per_event` (default 300) with the cap named when it is hit; a read that throws still counts and is never repeated on an unknown outcome; the read is not on the event's cost card (it is not a priced vendor step), and the cap exists because it is a spend. The prompt says the photo is DATA, never instructions.
- `confirmScan(db, scanId, actor, fields)`: the rep corrects the fields; the person's fields are updated (name, title, email), `uncertain` clears, state `placed`. An email entered goes through the same checks as a typed one. A person erased in the meantime is not revived (`forgetPerson` also deletes the scan's fields and photo: scans carry the erasure the same way captures do).
- `organizer-api.ts`: the interface `OrganizerAdapter { id; resolveBadge(ref, code): Promise<ResolvedBadge | NotFound | Unavailable> }` and two implementations: `swapcardAdapter` and `fakeOrganizer`. Swapcard, as its release notes and developer page document: `POST https://developer.swapcard.com/exhibitor/graphql`, the exhibitor API key in the `Authorization` header, the mutation `scanBadges(input: ScanBadgesInput!)` with `eventId`, `exhibitorId` and `scanBadges: [{code, note?, rating?}]`, answering per badge `errorCode` (`CODE_NOT_FOUND`, `FEATURE_NOT_ALLOWED`, `USER_NOT_IN_EVENT`) or a `connection` whose `target` holds `firstName`, `lastName`, `jobTitle`, `email`, `organization` and `address` (`city`, `country`, `place`, `street`, `zipCode`). **Not documented, so not assumed:** the header's format (the adapter sends the key as it is stored; a Bearer prefix is a setting), rate limits and batch limits, whether a re-scan makes a second connection, and the consent rules (the page says only that Swapcard follows the app's own rules). The desk therefore sends one badge per call, treats `CODE_NOT_FOUND` as no match, `FEATURE_NOT_ALLOWED` and `USER_NOT_IN_EVENT` as "this exhibitor cannot look that up", and any network or other error as unavailable (retry later). A badge scanned through the API creates a connection on the organizer's side as if scanned in the Swapcard app; the desk says so on the setup screen. **A live call waits for a show that enables it.** The contract test replays the documented responses (found, not found, each error code, a `null` field) against a recorded fake transport; nothing calls the network.

Routes (`src/server/scan-routes.ts`, mounted once, every one behind the existing actor and write-key rule):

- `GET /api/events/:id/scanner`: what the phone needs offline: the event's name and days, the notice text and version, the qualifiers, the organizer's name if one is set, the rep's own counts. Any actor.
- `PUT /api/events/:id/scanner/settings`: qualifiers, notice, organizer. A planner, a lead or GTM.
- `POST /api/events/:id/scans`: any actor. The actor is the rep. 
- `PUT /api/scans/:id/photo` and `GET /api/scans/:id/photo` (the held byte count, or the image for a person who may read it); `POST /api/scans/:id/read`.
- `POST /api/scans/:id/confirm`: the scan's rep, a planner, a lead or GTM.
- `GET /api/events/:id/scans`: a rep reads their own; planners, leads and GTM read all, with the review list and a count of each state. `GET /api/events/:id/scans.csv`: the same rows as a file (scan time, rep, method, name, email, company, title, phone, country, temperature, qualifiers, promise, owner, next step, consent, state). A cell starting `=`, `+`, `-` or `@` is prefixed with `'`.
- `POST /api/scans/:id/review`, `POST /api/events/:id/scans/resolve`.
- The demo refuses the live organizer adapter and the real model, and uses the fake adapter and a scripted reader.

## 8. The one screen after the scan, and the target

Hot, warm or cold first and large. Below it the event's qualifiers, then the note (a text area that takes the keyboard's dictation; the web speech API is patchy on iOS and is not used), then the promise and its owner, then the next step and its date. The notice line sits under the Save button. The marketing-consent box is unchecked and says what it grants. The person's fields are above the rest, each one editable, with the uncertain ones marked "check". `seconds` is the time from the screen opening to Save and is stored on the scan. The target is ten seconds with no typing beyond the note; the desk shows the median per rep on the event's Scanner tab and says how many scans it rests on, and when it is under five it says so.

## 9. Consent and legal risk

**Risk: legal.** Consent for scanned contacts is contested in the EU; vendors differ (Eventscribe treats the scan as opt-in, other guides still want specific consent). The desk's default: the notice line is on the scan screen, marketing consent is off unless the person says yes, and the wording version and time are stored per scan. The scanner does not decide whether an email may be sent; the existing gate does, by country and basis. Counsel confirms before any live use, and before marketing to EU people from a scan. The notice default is "We will keep your details to follow up on our conversation. Tell us if you would rather we did not." and is editable per event; each edit is a new version, and old scans keep the wording they were shown.

## 10. Screens

1. **The scanner** (phone, `/scan/<event id>`, its own entry like the RSVP page: no desk chrome, the actor from the same stored choice). Three states: scan (camera, the five methods, unsynced count, sync), the one screen after a scan, and Today (my scans, unsynced, to confirm, export, the day's-end prompt).
2. **The Scanner tab** on the event (desk): setup (qualifiers, notice with its version, organizer and its refs, a link and a QR code to open the phone app), the review list of near matches, the scans of the event with the median seconds, to-confirm and lookup-pending counts, the CSV export.

Both are designed in three directions first (`~/Developer/events-desk-review/step3/<screen>-directions/`); the recommended one is built provisionally. T4: status is a word in ink, no pills or dots or warm warning colours.

## 11. Tests

Pure: vCard and MeCard parsing (folding, escapes, missing fields), `classifyPayload`, `nearMatches`, the CSV cell guard. Server: the same id twice is one scan and one capture; dedupe order (registrant id, then email, then name and company; the near match opens a review; two reps one person two scans); consent stored with wording and version, off by default; the hand-over (task for the rep, hot card, scan-only tier); the photo upload resumes at the held offset and rejects a bad offset; the read is counted before the call and the cap holds; low-confidence fields flagged; an invented field thrown away; erasure removes scan fields and photo; a rep reads only their own scans; the CSV. The Swapcard contract test against the documented responses and the fake. A Playwright test feeding a fake camera stream (a generated QR image through Chromium's fake device) for decode. Existing: `post-event.test.ts`, `lifecycle.test.ts`, `rep-day.test.ts`.

## 12. Not doing in step 3

NFC. A background sync that works on iPhone (it cannot). Hardware scanners. A live Swapcard call (waits for a show). Lead retrieval from Cvent or Cadmium (the adapter interface takes them later). Voice transcription of the note. Auto-sending anything to a scanned person. The directory extension and screen recordings (step 4). A native app.

## 13. Open questions, and the defaults the build proceeds on

- Whether `zxing-wasm`'s wasm file can be served from the app's own origin and cached by the service worker: the build proves it, or falls back to typing and the photo picker and says so.
- The notice wording is a default, not legal advice.
- The target of ten seconds is unmeasured until a real event; the desk records it.

## 14. Review fixes (goldfish, Opus 5.5, 2026-11-14) and what the build does

The review found 3 Blocker, 12 Major and 5 Nit items. Every one is answered here; where this section differs from sections 4 to 9, this section wins.

**Blockers**
1. **Transactions.** `ingestScan` is three steps, each its own transaction, each safe to run again: (a) insert the scan row in state `received` with `ON CONFLICT (id) DO NOTHING`; (b) resolve (adapter call or read, outside any transaction, counted first); (c) place, which runs `captureOnsite` and, in the same transaction, sets `contact_id`, `capture_id` and the final state on the scan (`captureOnsite` takes a `scan_id` and does this itself, so placing is atomic with the capture). A repeat POST for a row still in `received` or `lookup_pending` runs the steps it has not finished; a repeat for a row past that returns the stored result and changes nothing. The capture's id is derived from the scan's (`cap_` plus the scan id), so a crash between capture and scan update cannot make two captures.
2. **Lookup retries.** A row is claimed with `UPDATE scans SET state = 'resolving' WHERE id = $1 AND state = 'lookup_pending' RETURNING`, so a sync and a resolve running together cannot both call the organizer. `POST /api/events/:id/scans/resolve` claims every pending row of the event one by one; the phone calls it at the end of every sync, `GET .../scanner` does too, and the desk's Scanner tab has a "Retry lookups" action. The phone does not need to hold the scan for this.
3. **Vision.** `Llm` gets an optional `read(step, prompt, image)` beside `complete`, with `image = {mime, base64}`. The real model sends it as an image block; the mock returns a scripted read from a hint. `scan_read` is a new entry in `TEMPLATES` (prompts.ts) so it has a prompt hash and is recorded like the others. The output of a `scan_read` call is not stored in `llm_calls` (the row keeps tokens and the model), because it holds a person's card text.

**Major**
- *Dedupe order* is enforced: the finder orders by which key matched (`registrant_id`, then email, then LinkedIn, then name and company) and `Capture` gains `registrant_id`, `country`, `phone`. `captureOnsite` changes are listed in the PR text; section 4's "Nothing else is new" is wrong and is withdrawn.
- *The task for the rep:* a scan with an email always gets the rep's CRM task (scan-only: "Badge scanned"; conversation: "Follow up with"; hot: "Hot from the booth"). A scan with no email gets no CRM task (the CRM key is an email) and appears in the rep's My day instead; the screen says "no email, no CRM task".
- *The account owner on hot:* read from `owner_decisions.owner` for the company, else the CRM owner on the person when the CRM has one, else none. The same-day card names the owner and goes to the rep and the owner. Without either it goes to the rep only and says no owner is known.
- *No attendee list:* the first scan on such an event adds an `uploads` row named "Scanner" (empty mapping, zero rows) so the person traces to a row as every person does.
- *Merge:* `resolveReview` moves `onsite_captures`, `touches`, `meetings`, `inbound_messages` and every other scan's `contact_id` and `near_contact_id` to the kept person in one transaction, copies `followup_tier` and the consent, then drops the scan's own person with reason `duplicate`. It merges only when that person has no enrollments, no reply and no source row except the one the scan's own capture made; otherwise it refuses and says why, and the lead resolves by hand.
- *Erasure:* `forgetPerson` also deletes scans whose `contact_id` is among the person's or whose `fields->>'email'` or `raw_payload` holds the address, with their photos (`scan_photos` cascades; `scans.capture_id` is `ON DELETE SET NULL`); scans with no person (failed, needs fields) are scrubbed by the address and, for a photo scan, by the name found. Note, promise and consent wording are on the deleted row. A phone's own copy and any CSV already exported are outside the desk's reach and the privacy text says so.
- *Who may read:* acting as is self-declared across the whole desk (app.ts says so); the scanner does not pretend otherwise. What it adds: a repeat POST for an id by a different actor is refused (409) rather than answered with the stored result; photo PUT, GET and read check that the actor is the scan's rep or a planner, lead or GTM.
- *What the rep sees:* `placed`: the person and the hand-over. `lookup_pending`: "Waiting for lookup" (counts as synced, stays in Today until resolved). `failed`: the reason in words (badge not found, this exhibitor cannot look that up for this show) and two actions, photograph the badge or type the person; both create a new scan. `needs_fields`: "Not read yet" or, after a read that found nothing, "Could not read: type it". `to_confirm`: listed under "To confirm" with the fields marked "check"; it is synced and is not counted in the unsynced figure. `FEATURE_NOT_ALLOWED` and `USER_NOT_IN_EVENT` fail the scan (a retry cannot help). A person's edits after sync go through `POST /api/scans/:id/confirm`, never through a repeat POST, and the phone sends them that way.
- *confirmScan and duplicates:* a corrected email is run through the same finder; a match on another person opens a review (`near_contact_id`) instead of merging silently.
- *Consent on the person:* `contacts.marketing_consent boolean NOT NULL DEFAULT false` and `contacts.consent_note text` (source, wording version, time). Set true when any scan of that person says yes; never set back to false by a later scan (withdrawal is an opt-out, which exists). The scan keeps the wording it was shown.
- *Keys per show:* `SWAPCARD_KEYS` in the environment is a JSON map from exhibitor ref to key; the setup screen shows whether a key is present for the event's exhibitor ref and never the key.

**Nits**
- The CSV guard prefixes `'` to a cell that starts with `=`, `+`, `-`, `@`, a tab, a carriage return or a space-then-one-of-those, except a phone number written `+` and digits, spaces, dots, dashes or brackets only.
- The day's-end prompt uses the event's time zone (`eventZone`), 18:00 or after the last day's end.
- A country goes to `contacts.person_location` (as `regionOf` reads it).
- The photo chunk is written under a row lock; mime is decided by the file's first bytes, not the client's word; photos and raw payloads are deleted 90 days after the event's last day by the same job as reply text.
- Section 1's "belongs to that rep" means the CRM task and the follow-up are the scanning rep's; two reps scanning one person is two tasks.

## 15. What Bryan chose (provisional) and what the directions said

Directions: `~/Developer/events-desk-review/step3/scan-directions/` (phone) and `.../scanner-tab-directions/` (desk). Built provisionally, before he picks: the phone scanner is direction A (camera first, a sheet after the scan) with C's grouped Today inside the sheet; the Scanner tab is direction B (the ledger first, setup and review in side sheets).

## 16. Built (2026-11-14), and where it differs from sections 1 to 15

Files: `migrations/0054_scanner.sql`; `src/shared/scan.ts` (parsers, `classifyPayload`, `nearMatches`, CSV guard, image sniffing); `src/server/scans.ts`, `scan-routes.ts`, `organizer-api.ts`, `seed-scans.ts`; `src/scan/` (`ScanApp.tsx`, `queue.ts`, `sync.ts`, `decode.ts`, `decode.worker.ts`, `scan.css`); `public/scan-sw.js`; `src/app/Scanner.tsx`; `scripts/e2e-scan.mjs`. `captureOnsite` gained optional fields and an ordered finder; `forgetPerson` and `purgeOldBodies` reach scans.

1. **Four methods on the phone, not five.** Badge code and badge id are one act for the rep (point at a code), so the strip reads Code, Photo, Card, Type. A decoded id is saved as a `badge_id` scan and shows "Looked up when this phone syncs". (The directions flagged this as an open call.)
2. **Warm is preselected.** The one screen opens with warm set, so a scan that needs no tap is not slower. The server's default is warm too.
3. **Photos are taken from the live camera stream** (one frame, 1600 px, JPEG), with a file picker (`capture="environment"`) as the path when the camera will not open or freezes in a home-screen app. A photo taken with no signal is read when the phone syncs; it shows as "Read at sync".
4. **The Scanner tab is on delivered events** (the event page with Plan, Outreach, People). Before delivery and on hosted events (which have check-in) it does not appear. The phone app works for any event id.
5. **The reader in the demo cannot see.** The simulated model returns what a seed hands it and nothing otherwise, so a card photographed in the demo reads "Could not read: type it". The seeded card (Money20/20 USA) was read through the real code path with a scripted reader. No real vision call was made in this step; the real prompt is untried against a real photo, and the cost of one is not measured.
6. **The service worker's file list is generated at build** (`dist/scan-assets.json`, scripts, styles, the decoder's wasm and the Latin fonts) because the decoder's chunks are not in `index.html`. The content policy gained `'wasm-unsafe-eval'`, `worker-src 'self'`, `media-src` and `blob:` images.
7. **The QR code is made on the server** (`GET /api/events/:id/scanner/qr.png`, from the app's own copy of the encoder) so the desk bundle carries no encoder.
8. **`design-lint` and `screen-copy` now scan `src/scan`.** Three sentences were added to `docs/SCREEN-COPY.txt` for Bryan to see: the two camera-failure lines and the "this browser will not keep scans" line, plus the "Syncs only while this page stays open" template.
9. **Playwright, not vitest, drives the camera.** `scripts/e2e-scan.mjs` starts Chrome with a video file as its camera (a QR carrying a vCard), goes offline, scans the badge and photographs a card, comes back online and checks both arrived once with consent stored. It runs through the browser's own decoder and, with `WASM=1`, the WebAssembly one. `tests/scan-e2e.test.ts` wraps it and runs only when `E2E_SCAN_BASE` names a running desk.

## 17. Not proven yet

- iPhone Safari and the iPhone home-screen app, and Android Chrome, on real phones: airplane-mode scan, then one sync. Chrome on a Mac with a fake camera proves the offline queue, the decoder (both paths) and the idempotent sync; it does not prove WebKit's camera behaviour.
- A real vision read of a real card. Its accuracy on cards is unmeasured (the research found no independent card benchmark).
- A live Swapcard call, and the Authorization header's format.
- The ten-second target. The desk records the seconds and shows the median; there is no real event yet.

## 18. Second review (goldfish, Opus 5.5, spec against code, 2026-11-14) and what changed

Three Blocker and seven Major findings, all answered in the code:

- **Sync sends each scan as the rep who made it** (`it.rep`), not whoever the phone says it is now, so a shared phone cannot credit one rep's scans to another. Only a definitive refusal from the desk (400, 409, 413) ends a scan on the phone; a 401, 403, 404 or a server error leaves it queued and tried again. Every write to the phone's queue changes a fresh copy of the item and clears only the edit that went, so an edit saved during a sync is kept.
- **A lookup claim carries its own time** (`scans.claimed_at`), so a slow claim is not reset because the scan is old.
- **The organizer adapter is connected live** when `SWAPCARD_KEYS` is set (`node.ts`). The demo has none, so its badge ids wait, as the live desk's would with no key.
- **What was promised reaches its owner.** The promise owner gets a CRM task of their own (`promise:<capture>`, due on the next step's date or two days out), and the rep's task body carries the note, the promise and the next step. The hot card says when no account owner is known and when there is no CRM task because there is no email; the phone says "No email, no CRM task." under the person.
- **A read with no transcription marks every field "check"** instead of passing unverified values as sure.
- **Erasure also clears `registrant_id` and consent on the person**, deletes a photo scan that never became a person by the name found on it, and matches the address in `raw_payload` as text, not as a LIKE pattern.
- **The day's-end prompt is on the camera screen** as well as Today: after 18:00 in the event's zone, or after its last day, with anything unsynced, a line and a green "Sync now" sit above the methods.
- Smaller: only a planner, a lead or GTM decides a near match (it merges people); `confirmScan` changes the person only when the scan made them; one statement makes the "Scanner" list so two first scans cannot make two; a scan that fails for an unknown reason goes back to `received` unless it is a badge id; the read's call row keeps the real prompt hash.

**Left as is, and said:** `Capture.phone` is carried but there is no phone column on a person, so it stays on the scan; a badge-id lookup is not counted before its call (the adapter's rate limits are not documented, so there is nothing to count against yet).
