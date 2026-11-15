# Speaking and the "I'm going" kit (redesign step 5)

Spec written 2026-11-14 before any code. Plan sections 3, 6.2 and 6.5, and the notes "Decided by Bryan" in `~/Developer/events-rethink/PLAN.md`; research sections 9 and 12 and `raw/social-kit.md`. Steps 1 to 4 are `docs/EVENT-PLAN.md`, `HOSTED.md`, `SCANNER.md`, `DIRECTORY.md`. Migration `0056` (0055 is the last on `origin/main`; take the next free number again before pushing).

## 1. The job

**Speaking.** A team that speaks at an event keeps four things in one place: the calls for papers that are open (deadline, link), the talk it proposes (abstract, speaker, status, slide deadline, rehearsal date), the second person's approval of the abstract before it is submitted and of the slides before they go to the organizer, and what the talk produced (scans from the session, the follow-up that names it, the line in the Result).

**The kit.** When a person is going, speaking, sponsoring or hosting, the desk renders their "I'm going" images from templates, shows them, and lets the person download them and post them. The desk never posts, never holds a LinkedIn credential and calls no LinkedIn address.

## 2. Words used here

- **Call**: a call for papers (or content) on an event, with a closing day and a link. **Candidate event**: an event whose plan stage is `planning`; it is an `events` row, so a call hangs off `events.id` and a catalog entry with no plan has no call (make it a plan first).
- **Talk**: one `talk` involvement's content. One talk row per `talk` involvement, made the first time anyone writes it. The involvement keeps `talk_title` and `speaker`; the talk row is the source of truth and writes both back in the same transaction so Plan reads as before.
- **Author**: the last person who changed the words being approved (the abstract and title, or the slides link). **Approver**: someone else who may plan (`canPlan`).
- **Kit**: one person's set of images for one event and one role. **Role**: `attending`, `speaking`, `sponsoring` or `hosting`.
- **Offer**: the kit row the desk writes when something fires it. An offer is not an image; images are drawn when the person opens it and are kept nowhere.

## 3. Must not change

All of `EVENT-PLAN.md` section 3 and `HOSTED.md` section 3 hold. Specifically: a reason on every drop (a declined talk and a passed call carry one, in the database); the gate before every touch (nothing here sends mail); owner say; scans handed to the rep who scanned them; the money rules (nothing here holds dollars, so `forRep` has nothing to strip, and `tests/rep-sees-no-money.test.ts` stays green); `gate.ts`, `sending.ts`, `ledger.ts`, `paid.ts`, `spend-guard.ts` and the country rule are not edited. The public demo keeps refusing uploads, so a kit photo upload is refused there; the Slack photo and the no-photo kit still work in it.

## 4. Data model: `0056_speaking.sql`

**`calls_for_papers`**: `id`, `event_id` (REFERENCES events ON DELETE CASCADE, a top-level event only), `title` (non-empty, what the call is, for example "Call for content"), `url` (non-empty, `https://` or `http://`), `closes_on date NOT NULL`, `notes text`, `route` in `editorial, paid` (default `editorial`), `status` in `open, submitted, passed` (default `open`), `passed_reason text`, `talk_id` (set when a talk is made from it), `source` in `person, model`, `source_url text`, `added_by`, `created_at`. CHECK `(status = 'passed') = (passed_reason non-blank)`. "Closed" is not stored: an open call whose day has gone is read as closed against the clock (the deps clock, as Plan does).

**`talks`**: `id`, `event_id`, `involvement_id` UNIQUE REFERENCES involvements, `cfp_id` (nullable, SET NULL), `title` (default empty), `abstract` (default empty), `speaker` (default empty), `status` in `drafting, approved_to_submit, submitted, accepted, declined` (default `drafting`), `abstract_by text`, `abstract_approved_by`, `abstract_approved_at`, `slides_url text`, `slides_by`, `slides_approved_by`, `slides_approved_at`, `slides_sent_on date`, `submitted_on date`, `slide_due_on date`, `rehearsal_on date`, `declined_reason`, `updated_by`, `updated_at`, `created_at`. The database refuses, by CHECK:

1. `abstract_approved_by <> abstract_by` and both or neither of `abstract_approved_by`, `abstract_approved_at` (the author never approves; a missing author is never approved).
2. `slides_approved_by <> slides_by`, with the same pairing, and `slides_approved_by` needs a `slides_url`.
3. `status IN ('approved_to_submit', 'submitted', 'accepted')` needs an approved abstract; `'submitted'` and `'accepted'` need `submitted_on`; `'declined'` needs a non-blank `declined_reason` and the reverse.
4. `slides_sent_on` needs approved slides.

The two-person rule is therefore in the schema as well as in the code. A SQL path that skips the app still cannot let the author approve or move a talk forward unapproved.

**`kit_offers`**: `id`, `event_id`, `person` (a name, as everywhere), `role` in the four roles, `reason` in `seat_approved, talk_accepted, hosted_confirmed, sponsorship_confirmed, asked`, `source_id text` (the seat request, talk or involvement that fired it), `status` in `offered, dismissed`, `photo_use` in `none, upload, slack` (default `none`), `post_url text` (the link the person pasted back), `posted_at`, `created_at`. UNIQUE `(event_id, person, role)`, so firing twice is one offer and a dismissed offer stays dismissed unless the person asks again.

**`kit_photos`**: one row per person (not per event, the person keeps one): `person` PK, `bytes bytea`, `mime`, `source` in `upload, slack`, `created_at`. Removing it deletes the row. Nothing else stores a copy: renders are not cached. An upload is a PNG or JPEG of at most 2 MB, checked by its first bytes, not by its name.

**`scans`** gains `talk_id text REFERENCES talks(id) ON DELETE SET NULL`; the scan input accepts `talk_id` and refuses one from another event or a talk that is not `accepted`.

**`llm_calls`**: the call-reading step is `cfp_read`, counted before the call under a lock on the event, at most 5 reads an event (like the assessment's cap, `READS_PER_EVENT` for it is named in code), and never on the cost card (decision 65's reasoning).

## 5. Talks: the rules

States move forward only: `drafting` to `approved_to_submit` to `submitted` to `accepted` or `declined`. `declined` may also come from `drafting`, `approved_to_submit` or `submitted` and needs a reason. Nothing leaves `accepted` or `declined`.

1. **Who writes.** A planner, or the person named as speaker, writes the title, abstract, speaker, dates and slides link. A rep who is not the speaker reads the talk and changes nothing.
2. **Editing words resets approval.** Changing the title or the abstract sets `abstract_by` to the editor and clears the abstract approval; if the status was `approved_to_submit` it returns to `drafting`. Once `submitted`, the abstract and title are a record and cannot change (a decline is final too). Changing `slides_url` sets `slides_by` and clears the slide approval.
3. **Approve the abstract.** A planner who is not `abstract_by` approves it, which needs a non-empty title, abstract and speaker, and moves the talk to `approved_to_submit`. The author approving gets a 403 with the sentence "Nobody can approve their own words. Ask someone else." (the DB check is the backstop).
4. **Submit.** Needs `approved_to_submit`. Records `submitted_on` (today, the deps clock) and, if the talk came from a call, marks that call `submitted`. A submission is the person telling the desk they sent it; the desk sends nothing to the organizer.
5. **Accepted or declined.** Recorded by a planner. Accepting fires the speaker's kit (section 8) and confirms the talk's involvement; declining needs a reason and drops nothing else.
6. **Slides.** A link, because the desk holds no deck files. Approving the slides is the same two-person rule. "Sent to the organizer" (`slides_sent_on`) needs approved slides. The slide deadline and rehearsal day are dates; an accepted talk with a slide deadline in the past and slides not sent is read as late, in words.
7. **Every change is logged** in the event's activity with the actor, as the plan's are.

## 6. Calls: the rules

A planner adds a call (title, link, closing day, optional notes). Reading: calls on the event, soonest closing first, each with a closing word in the plan's own due vocabulary (`dueWords`: "Today", "6 days", "3 days late"). The event page and the year plan's week list surface a call closing within 14 days. A call can be marked passed (a reason is required) or made into a talk (creates a `talk` involvement on the event if there is none yet, a talk row, and links it).

**A model may propose.** A planner gives a page address or pastes page text. The desk fetches the page (the same `PageFetcher` the assessment uses; the demo never fetches, the person pastes) and asks the model one question: which calls for papers does this page announce, each with a title, a closing day and a link copied from the page. The reply is checked in code: a closing day must be a real date, the link must be an address that appears in the page, and each proposal must carry a quote that appears in the page text; anything else is dropped. A kept proposal is shown to the person as a proposal and becomes a call only when the person adds it (`source = model`, `source_url` kept). AI is in the input; the person decides; the output is the person's click.

## 7. Credit: scans, follow-up and the Result

1. **Scans.** A rep on a talk's event may mark a scan as "from the session" by picking the talk; `scans.talk_id` stores it. The scan list and CSV show the talk.
2. **Follow-up names the talk.** The post-event follow-up templates gain `{talk}`, filled with the title of the talk the person's scan was credited to, and a person with no such scan gets the template's other wording (the sentence with `{talk}` is dropped, not left blank). `template-check.ts` knows the new token.
3. **The Result.** The Result view gains a "Talks" part under the sponsorship's part: for each accepted talk, scans credited, people placed, hot scans, and meetings held with people who came from those scans. The desk counts only what its own rows say. There is no outside benchmark for a talk, and the screen says what is counted and does not compare.

## 8. The kit

**Fires** on four writes, each inside the transaction that makes it true: `decideSeat` approving a seat (role `attending`, the requester); a talk becoming `accepted` (`speaking`, the speaker); a hosted involvement becoming confirmed (`hosting`, the person on the event with the `host` role, else its creator); a sponsorship involvement becoming confirmed (`sponsoring`, its creator). A person can also ask for a kit for any event they are on, in any role the event gives them. The offer writes one row and one activity line; it shows on the person's My day and on the event's Plan, to that person and to planners, never to other reps.

**The photo.** One of three: none (initials, drawn like the desk's avatars), an upload, or the Slack profile photo, which exists only when Slack is connected (`cfg.slack` with a token and a `userMap` entry for the person) and is fetched once with `users.profile.get` (scope `users.profile:read`), taking `image_512` over `image_original`, and stored in `kit_photos` with source `slack`. A Slack photo is a copy the person chose: they tap "Use my Slack photo", see it, and keep or remove it. Slack is never read in the background, and when Slack is not connected the control is absent, not disabled. Removing the photo deletes the row, in one tap, with no reason. A custom-image flag from Slack (`is_custom_image` false) shows the sentence "This looks like Slack's default picture" and still lets the person choose.

**The branding.** The event's organizer kit when one exists: a logo or colour set the person (a planner) saved on the event as "Organizer kit" (a logo as a PNG or SVG of at most 500 KB checked by its bytes, a main colour and a hashtag), because the organizer's own assets are given to the team and not found by the desk. Without one: the event name and dates in the seller's style (the desk's own ink and green, IBM Plex Sans). The event's existing `EventLogo` is reused where the event already has one.

**The images.** Rendered on the server from one template per role with Satori (layout to SVG) and Resvg (SVG to PNG). Fonts are IBM Plex Sans 400 and 600 from the already-installed `@fontsource` package, read from disk once. Sizes, exact pixels, all PNG:

| Id | Pixels | Use |
|---|---|---|
| `post_landscape` | 1200 x 627 | LinkedIn post |
| `post_portrait` | 1080 x 1350 | LinkedIn post, 4:5 |
| `banner` | 1584 x 396 | LinkedIn banner |
| `square` | 1080 x 1080 | other feeds |
| `story` | 1080 x 1920 | 9:16 story |
| `signature` | 600 x 150 | email signature banner |

That is six images. The brief's "five sizes" counts the two LinkedIn post shapes as one, so the kit is "five sizes, six files". The sizes are LinkedIn's help page (banner, High), LinkedIn's ad specs (post ratios, High for ads only) and third-party figures for the rest (Low); the screen does not claim LinkedIn publishes an organic post size.

**The words.** Captions are templates with the person's event, role, talk title, booth or dinner filled in; no model writes them. Every role has two or three wordings, and the person chooses one and edits it in a text box before copying. A field with no value (no booth) removes its own sentence. Copy follows the desk's rules: no em dashes, no hashtag stack (the organizer's one hashtag when there is one), no emoji, no "excited to announce", no "thrilled", no "delighted".

**Review, download, post.** A kit sheet shows the six images with their pixel sizes, the caption, a download per image and a "Download all". It carries the sentence "You post this yourself. Events Desk never posts for you." and a field for the post link. A pasted link is saved (`post_url`, `posted_at`), checked only to be a `https` address on `linkedin.com` (a text check, never fetched). The Result for an event with kits counts people who posted against the meetings held by posters and by non-posters, side by side, and labels it "Counted by this desk, not a finding": self-selection is not removed and the screen says no more than the counts.

**No network call to LinkedIn.** No code path in this repository requests a LinkedIn address. A test reads every source file for `linkedin.com` fetches and asserts the only mentions are the link check and display strings. The only outbound call this step adds is Slack's `users.profile.get`, and only on the person's tap.

## 9. Views

- **Speaking** (new page, reached from More, planners and the speaker): the calls across events, soonest closing first, each with the event, the closing word, the link, the talk if any, and the controls above (add, propose from a page, make into a talk, pass); under it the talks, with status in words.
- **The talk** (a section in the Plan tab's Talk tray): the title, abstract (inline edit), speaker, dates, the two approvals as words with the name and day, status, and the next step as one button.
- **The kit** (a side sheet, `SideSheet`, from My day, from the person's row on Plan and from the seat card): photo choice, six images, captions, post link.
- **Result**: a Talks part and, when kits exist, a posting count.

Every screen follows `BRYAN-DESIGN-INSTRUMENT.md`: status is a word in ink (no pills, dots or warm colours); a ledger, not cards; four type sizes at most; no explainer subtitles. The demo seeds Money20/20 Europe 2027 as a candidate event with an open call closing 2026-11-27, and a talk on Money20/20 USA 2026 that is accepted with approved slides, scans credited to it, and a seat-approval kit offer for the demo's field marketer.

## 10. Routes

Reads and writes go through the plan's own pattern (`run`, `refuse`, `forRep`): `GET /api/speaking` (calls and talks the actor may see), `POST /api/events/:id/calls`, `PATCH /api/calls/:id`, `POST /api/calls/:id/pass`, `POST /api/calls/:id/talk`, `POST /api/events/:id/calls/propose`, `GET|PATCH /api/talks/:id`, `POST /api/talks/:id/{approve-abstract,submit,accept,decline,approve-slides,slides-sent}`, `GET /api/kit/offers`, `POST /api/events/:id/kit` (ask), `GET /api/kit/:offer`, `GET /api/kit/:offer/image/:size`, `PUT|DELETE /api/kit/photo`, `POST /api/kit/photo/slack`, `PATCH /api/kit/:offer` (post link, dismiss), `PUT /api/events/:id/organizer-kit`. A rep may read and change only their own offers and photo. A planner reads every offer on an event. The image route answers the person and planners only.

## 11. Tests

Talk status rules and the two-person rule (app and database, by direct SQL), edit resets approval, submitted words are frozen; call deadlines and the reading of "closed"; the model's proposal checks (a real model-shaped reply with a bad date, a link not in the page and a missing quote are dropped; a good one is kept as a proposal and is not a call until added; the cap holds); kit fires on seat approval, talk accepted, hosted confirmed, sponsorship confirmed and is one row on a repeat; every size renders at its exact pixel size (PNG header read, then a stored snapshot hash of the render for a fixed input); a photo only from upload or connected Slack (Slack absent: refused); the upload check by bytes; removing the photo deletes the bytes; no source file requests LinkedIn; a rep cannot read another rep's kit; scan credit validation; the follow-up names the talk and drops the sentence without one; Result counts. Existing: `approvals.test.ts`, `slack-channels.test.ts`, `rep-sees-no-money.test.ts`.

## 12. Not doing

Posting to LinkedIn by any means; a LinkedIn sign-in; storing rendered images; a model writing captions or abstracts; background removal in the browser (AGPL); finding calls by crawling the web; submitting to an organizer's portal; holding slide files; speaker travel or fees (they are budget lines already); a talk-to-pipeline benchmark.
