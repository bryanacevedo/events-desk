# Runbook

## Static snapshot

The public demo as plain files, for a host that has no server and costs nothing. It is a read-only copy: the same screens, the
demo's own sample data (Lumen Ledger, invented), and a note at the top of every page that says so. The whole bundle tells search
engines to stay away. It was staged at first (no README link); since the Render demo was deleted on 2026-11-27 it is the only
public demo, and the README links it (96d39c0).

### What it is

`scripts/build-static-snapshot.ts` (run by `make snapshot`):

1. Unpacks `samples/demo-snapshot.tgz`, the database the Render demo opened (deleted 2026-11-27), into a temporary folder and opens it in this process.
   It reads nothing else. It refuses to start when `DATABASE_URL` is set, and the copy it reads is thrown away afterwards.
2. Runs the app in the same process (`createApp(...).fetch`, no port) with `PUBLIC_DEMO=1`, the sample's own day (2026-11-24)
   and the same start the hosted demo makes (`src/server/node.ts`).
3. Reads every page's data the way the screens do, as each person in **Acting as** (Maya Okafor, Camille Laurent, Dan Whitlock,
   GTM Team) and as a visitor who has not chosen yet. An answer every one of them gets alike is saved once; otherwise one per person.
4. Saves the answers as gzip shards (`_snapshot/abc.json.gz`, by the first three characters of the SHA-1 of the request), the
   workbooks, scan CSVs, scanner codes and uploaded files the pages link to as plain files, and the built app beside them.
5. Compares a fingerprint of every table (rows, newest row version, a hash of the rows) before and after. If a read changed
   anything, the build stops and nothing is published. It also stops if a path the screens read has no saved answer, if the
   bundle is over 60 MB or over 19,000 files (the free plan takes 20,000).

In the browser `scripts/static-snapshot/shim.js` runs before the app and answers every `/api` call from the shards. Every change
(`POST`, `PATCH`, `PUT`, `DELETE`) is refused with the desk's own kind of sentence, the one its server uses for files:
"This public demo does not take changes. To try them, run the desk yourself: the README shows how." The app shows it where it
shows any refusal. The bar at the top of every screen says it is a snapshot and links to no other desk. On a wide screen it has no Hide button; on a
phone (760 px or less) it can be hidden for the session (decision 109, revised 2026-11-26).

### Build and look

    make snapshot                                  # npm run build, then the snapshot, into .snapshot/
    npx --yes serve .snapshot                      # or any static server; open it at 390 px and at desktop width

Takes about 2 to 3 minutes on a laptop (the crawl makes about 48,000 reads, one per person asked, and keeps 9,729 answers in 3,721 shards; the bundle is about 10 MB in 3,951 files). The first build of a day also unpacks the sample (22 MB).

The scanner's read is the one read that touches the database: it retries the badge scans waiting for a person (`resolvePending`), as the app does on every visit. It runs once before the check, and its saved answers are read last; the build stops if any other table changes, or if any table changes during the main crawl. This all happens on the temporary copy.

### Deploy

Cloudflare Pages project `events-desk-demo` (free plan, served at https://events-desk-demo.leandrive.io). From the laptop:

    infisical run --projectId ce8806da-34c3-4f9a-85f0-555617ccb710 --env prod --recursive -- \
      npx --yes wrangler@4.156.1 pages deploy .snapshot --project-name events-desk-demo --branch main --commit-dirty=true

The token and account id come from Infisical into the wrangler process only. Never print them, write them to a file or commit them.

From GitHub Actions: `.github/workflows/static-snapshot.yml` (run by hand, or by a push to `main` that touches the app, the
sample or the snapshot code). It builds on every run and keeps the bundle as an artifact for 30 days. It publishes only when both
secrets exist, and passes without them. Both secrets are set (2026-11-18), so a push to `main` that touches those paths publishes (nothing here touches Render, whose service was deleted on 2026-11-27);
the last publish was run 45962646217 on 2026-11-27, for 3ad7fe1. To set them again:

    gh secret set CLOUDFLARE_API_TOKEN -R bryanacevedo/events-desk
    gh secret set CLOUDFLARE_ACCOUNT_ID -R bryanacevedo/events-desk

The job needs no database service and no keys. On a public repository Actions minutes are not billed.

### Roll back

Cloudflare dashboard, Workers & Pages, `events-desk-demo`, Deployments, the older one, Rollback to this deployment. Or list them with
`wrangler pages deployment list --project-name events-desk-demo` and roll back through the API. Rolling forward again is the same
action on the newer deployment.

### What does not carry over (read this before you link it anywhere)

- **No change is saved, and none is tried.** Every button that changes something shows the refusal above. The desk's own refusals
  (a rep opening Settings, money for a non-lead) are the server's answers, saved as they were.
- **Search and filters inside a list.** The people and companies lists of every event are saved page by page for the default
  view, and the first two pages of each single filter (priority, tier, source, dropped, all). A typed search, a combined filter
  or a page past those answers "not in the snapshot", and the list says "Not in the snapshot.". Budget and Usage keep the default
  view of every page, not their filters or search.
- **My day, replies, meetings, debriefs, the sequences and the cases** are the sample's own state when the snapshot was taken.
  Pressing a reply handled, booking a slot or answering a debrief is refused.
- **The scanner** is a phone app that needs a camera. Its link opens the event instead; there is no scanning, no photos.
- **Uploads, the Google Sheet, Slack, the directory extension and recordings** do nothing (uploads and the directory are refused
  by the public demo itself).
- **Kit images** (the social cards the desk draws) are not saved; the kit sheet shows its text.
- **The clock is the sample's** (24 November 2026), the same as the hosted demo; "days to go" do not move.
- **As old as its build.** Rebuild after a change to the sample or the screens.
- No acting as anyone but the four in the list.

### Checks

`tests/static-snapshot.test.ts`: every path the screens read has a saved answer (a crawl of a few events), the crawl changes
nothing and sends only reads, the shim and the build compute the same key, the shim refuses every change in the app's words, the
bundle is noindex, and a build beside a `DATABASE_URL` refuses to run.
