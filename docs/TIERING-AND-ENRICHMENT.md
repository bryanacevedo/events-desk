# Tiering and enrichment: design

**Status:** approved, version 3. Build-order steps 1 to 8 are built (see `SPEC.md`, "The two-card flow", "Layer 0", "The ICP", "Identity (Layer 1)" and "Gates, firmographics and company tier"); step 9 is not. Corrected after two fresh-eyes reviews and outside research. On approval it changes the matching parts of `SPEC.md` and leaves everything it does not mention in force: file types and limits, column mapping, the decline flow, double-click safety, approver and vendor-rate settings, LinkedIn validation, CI replay and Concierge gates. The priority matrix carries over unchanged. v1 stays single-tenant, so "seller" means the one company running this install.

**Evidence warning.** No neutral benchmark exists for finders, verifiers, waterfalls, catch-all share or LLM account fit. Nearly every published accuracy figure comes from a vendor that ranked itself first. So vendor numbers are used only as rough starting points, and the design measures its own.

## The job

Turn a messy list into the right people at the right companies, reachable at an email that works, without paying for anyone who will never be contacted. The hard case is a list that is only company names.

Four separate questions, each measured separately:

1. Is this the company we think it is?
2. Does it fit, and how well?
3. Does this person work there now, in a role that matters?
4. Will this email reach them?

## Words used here

- **ICP:** the structured definition of who the seller wants as a customer. See below.
- **Persona:** a buying role, as a function plus a seniority range.
- **Claim:** any value from an uploaded file, until something independent supports it.
- **Identity:** a company's confirmed primary domain, plus its parent if known.
- **Reveal:** the paid vendor call that returns a person's email, employer and LinkedIn. It is the first step of the email loop, not a separate charge. Anything a reveal returns is stored and reused, and never bought twice.
- **Segment** and **company type:** closed lists defined in the ICP, assigned to each company at tiering.
- **Catch-all rule:** a domain whose mail server accepts every address cannot confirm anyone, so nobody there qualifies unless an optional specialist verifier confirms them.
- **Review case:** a data conflict only a person can settle, with allowed answers. Defined in "Review cases".
- **Research card** and **Outreach card:** the two cost approvals.

## The pipeline

```
Before any approval (free, code only)
  1. Parse, distrust, clean, list quality report
  2. Free identity from evidence in the file, exact-name list matches
  3. Free title pass: a company whose only people are Title 3 stops here unless prospects are on; show Research card
        APPROVAL 1: Research card
Research (paid, capped)
  4. Resolve remaining companies, reverse lookups, free CRM read by domain
  5. Domain-based list matches and hard gates that need no firmographics
  6. Firmographics
  7. ICP hard rules, then company tier, segment and company type
  8. Spread check
     Review cases are answered or skipped; settled companies finish research
        APPROVAL 2: Outreach card, quoted with no open cases
Outreach (paid, capped)
  9. Free people search
 10. Title tier, then priority, so C costs nothing
 11. Rank and choose; quotas apply to prospects only
 12. Catch-all probe per domain, before any reveal
 13. Reveal, employment check, then verification loop
 14. LinkedIn, final dedupe, conflict detection, deliver
```

Stages become: requested, approved, mapped, quoted, researching, ready for review, finding people, delivered, plus declined and paused.

**Why two cards.** One card would quote a 2,000-row list as if every company were enriched. After research, the number of companies at each tier is known, so the second quote is close to real. It is also the natural place for a person to fix tiers before the expensive part.

## The ICP

The ICP decides tiering more than anything else, so it is a first-class, structured, versioned object, not a paragraph.

```
ICP
  version, owner, last reviewed
  segments: named groups, each with its own definition
  hard rules: disqualifiers checked in code
      employee range, geography served, business model, industry, must-have or must-not-have
  fit dimensions: each with what strong, partial and weak look like
      what the company sells and to whom, the problem we solve, scale, how it buys
  tier definitions: what makes 1, 2 and 3, in plain words per segment
  worked examples: real named companies with the right tier and why
  counter-examples: companies that look right and are not, and why
  personas per segment, with a function, seniority range and priority
  title adjustments by company type and size
```

**Rules.**

- Hard rules run in code. The model only judges what needs judgment.
- Examples and counter-examples do most of the work in the prompt, so they are the part worth the most care.
- Every tier stores the ICP version that produced it. A changed ICP re-tiers, and never mixes with old tiers.
- An ICP is per seller. Events inherit the seller's current version and can override segments for a specific show.
- Corrections from people become candidate examples. A person approves any change; the system never edits its own ICP.
- Research did not settle which signals predict conversion. So the ICP starts from what the team believes and from won deals, and stays editable. It does not claim to be learned.

**Where an ICP comes from.** Teams already have this written down in their own format, so a team uploads its document and the system compiles it. The document is never pasted into a prompt and used directly: hard rules could not be enforced in code, versions could not be compared, and two runs could read it differently.

1. **Upload** a document or paste text. It is treated as data, and instructions inside it are ignored.
2. **Compile.** A model extracts a draft of the structure above. Each field quotes the passage it came from. A person starts this and sees its cost first.
3. **Gaps.** The draft lists what the document did not say, such as no counter-examples or no employee range, and asks for those.
4. **Confirm.** A person edits and approves the draft. Hard rules are shown as plain rules they can read.
5. **Test bench.** The draft tiers a sample of companies the team already knows the answer to, such as won deals, lost deals and bad fits. Wrong answers are corrected and become examples.
6. **Publish** as a version. Uploading a revised document produces a diff against the current version, and nothing changes until a person approves it.

No document means filling in the same structure by hand.

**A trivial baseline must be beaten.** Size band plus keyword rules is the benchmark. If the model does not beat it on the holdout, the model is not earning its cost.

## Layer 0: distrust the input

Attendee lists are filled in by people getting past a form. Every uploaded value is a claim. This layer is code only, since nothing paid may run before an approval.

| What people do | How it is caught | What happens |
|---|---|---|
| Website field blank or filler | Blank, placeholder list, does not resolve | Ignored |
| Placeholder domains | Configured list | Discarded; the row continues on name and company |
| One domain on many unrelated companies | Same domain under different company names with no name resemblance | Identifies nobody |
| One assistant registers a team under one email | Same email on different names | Email discarded for all; each person continues. Today's upload code drops these as duplicates, and that changes |
| Fake address on a real domain | Never trusted | Full verification |
| Keyboard mash, filler | Known filler and clear keyboard patterns only. Short all-capital names such as KPMG, HSBC, DHL, AAA are never treated as junk. Doubtful values are left alone and judged in Research | Field blanked only when certain. A row with no usable company, email or LinkedIn drops as `junk_row` |
| Fields in the wrong column | Value-shape checks | Moved when certain, otherwise left and flagged in the quality report |
| Person's own name as company | Comparison on the row | Treated as no company |
| Self-employed, student, press | Configured list | Dropped as `not_a_company` |

A row needs any one of company, email or LinkedIn, which changes today's upload code: a file with no company column, and rows without a company, stop being refused. The list quality report (rows with placeholders, junk, shared emails) appears on the Research card, so a poor list is visible before money is spent.

## Layer 1: company identity

Identity is a confirmed primary domain, with the parent stored when known. **Evidence, strongest first:**

1. A work email domain, if it has a mail server, is not free webmail, is not a placeholder, is not shared across unrelated companies, and either resembles the company name or is confirmed by company search. One email under a different company name is not enough. Free, so done before the card.
2. Company search by name, which is free on vendors that allow it, weighed by name similarity, event country and how many candidates fit.
3. A person match on first name, last name and company, at most one per unresolved company, only when free evidence failed. It is accepted only if the employer it returns matches the row's company, because this input is known for returning the right name at the wrong company. It is a reveal: its result is stored and reused later. It is the one paid reveal allowed before tiering, and it is priced on the Research card.
4. A company LinkedIn URL.
5. The form's website field, only if it resolves and nothing stronger disagrees.

Reverse lookups for rows with only a LinkedIn URL or only an email run in stage 4, under the Research card.

Outcomes:

| State | Meaning | Spends? |
|---|---|---|
| Resolved | A work email domain that passes the checks, or one company search candidate with a near-exact name and no close rival, or two independent sources agreeing | Yes |
| Ambiguous | Two candidates with similar names and no way to separate them | No, until a person settles the case |
| Not found | No candidate | No. Counted at the review step, where a person can supply a domain. Otherwise dropped as `company_not_found` |

Name-and-company input gave weak results in the vendor-run tests found (best real rate 54.9%, wrong-domain errors up to 22.5%), which is why identity comes first.

Rows resolving to one domain become one company. Subsidiaries on a parent's domain, or with a parent recorded, inherit customer and exclusion status by default, and that raises a review case. If the vendor reporting identity is down, the step waits. An outage never produces `company_not_found`.

## Layer 2: gates and firmographics

Exclusion and customer lists accept names or domains. An exact normalized name match drops before the card, free. An exact domain match drops after identity. Fuzzy matches never act alone: they become review cases. CRM is read by confirmed domain in stage 4 and gains an account type field, so a company the CRM calls a customer that the list missed becomes a review case. This replaces the CRM timing in `SPEC.md`.

Firmographics come from free company search first where the vendor allows it, and paid enrichment only when fields are missing. Vendor fields are treated as unverified, and accuracy is checked on a hand-verified sample. Classification uses a business description, because industry codes disagree across vendors.

ICP hard rules run after firmographics, so a failed company has cost one lookup. That is the honest minimum. A hard rule fires only when the field is present: a missing value is Unknown, never a failure. Industry is a soft signal by default, because vendors disagree on it.

Cache by domain, with a name-to-domain map, aged out after 90 days. A human correction overwrites the cache.

## Layer 3: company tier

**Outcomes are 1, 2, 3 and Unknown.** Models fail quietly on obscure companies, and event lists are full of them.

The model gets the ICP, firmographics and description. It returns tier, segment, company type, reason code and **the fact it relied on**. A tier citing no supplied fact becomes Unknown. Output values come from closed lists and are validated in code, and refusal and truncation are handled.

Unknown triggers one website read, then one retry. Still Unknown spends nothing and becomes a review case.

**The second look does not use the model's stated confidence.** Stated confidence is not a probability until calibrated on our own labels. Instead a second model looks at every tier 1, because that is where the money goes, and at any tier disagreeing with the baseline, computed per company at runtime, by more than one level. Disagreement is a review case. Whether a second model helps was unproven, so it stayed only if it improved the holdout. It did not (22 companies read, no disagreement), and it was cut on 2026-11-09 (docs/DECISIONS.md, 24).

Tier results cache on domain plus ICP version, never domain alone.

**Spread check.** Before Approval 2, code flags these: tier 1 above the configured share (starting value 25%), over half Unknown, nothing in tier 1, or a list under 20 companies where shares mean little. It warns and shows examples. Before Approval 2 a person can change the ICP or settings and re-tier, charged against a stated re-tier allowance on the Research card. An event pins its ICP version when the Research card is approved, so a new version never touches an event already running.

## Layer 4: finding people

Free search by domain, filtered by persona and by the event's region where the vendor supports it, returning titles and freshness dates. It runs for company-only rows and when prospects are on. Free search can hide last names and LinkedIn URLs, so pre-payment dedupe and suppression use the vendor's person id, and a final dedupe runs after reveal. Nothing is paid until after ranking, apart from the identity exception in Layer 1.

**Title tier comes before any reveal**, so a C is never paid for.

- Titles are parsed into function and seniority. Abbreviations, two-part titles and Spanish titles are covered by rules, and the rest go to the model with the company as context.
- Title tier comes from the persona for that segment, with adjustments by company type and size, such as a bank VP ranking below a software VP.
- Ambiguous abbreviations such as CRO always get company context.
- Cache on normalized title, company type, size band and persona version.

Priority is the existing matrix, with Unknown treated as a review case rather than a tier:

| | Title 1 | Title 2 | Title 3 | No title |
|---|---|---|---|---|
| **Company 1** | A | B | C | A |
| **Company 2** | B | C | C | B |
| **Company 3** | C | C | C | C |

**Ranking** within a company, for those at A or B: persona match, region relevance, variety across functions, then record freshness and whether the vendor says an email exists. The event gains a country field. Older records rank lower, and the freshness date is not treated as proof of employment.

**Quotas:** tier 1 up to 5 discovered people, tier 2 up to 3. A title with one holder is accepted; a common title is ranked and capped. If a tier 1 company ends with nobody reachable, that is reported as a gap.

Attendees follow the same title and priority logic and are never cut by a quota. Prospects remain optional per event.

## Layer 5: email

Overridden in part by `docs/DATA-HYGIENE.md`, section 0: Apollo and ZeroBounce are the only direct email vendors. A candidate from Apollo's match or reveal needs Apollo's Verified and a ZeroBounce pass; a waterfall candidate carries both in its result; an attendee-list address needs only ZeroBounce to stay and reads "Verified once" without Apollo.

The search ends on a verified address or runs out of attempts: at most 3 candidates per person.

```
candidates, in order:
  1. Uploaded email, if Layer 0 kept it
  2. Vendors, cheapest-confident first, each returning an email at the person's employer. A discovered person must be revealed first by the vendor that found them, since other finders need a full name
  3. Pattern guess, only if turned on

for each candidate:
  no mail server on the domain, or a role or disposable address: next candidate
  already dropped for this person before: next candidate
  domain known catch-all: apply the catch-all rule, stop
  verifier 1
    undeliverable: next candidate
    temporary response: unknown, retry once later
    catch-all: mark the domain, apply the catch-all rule, stop
    deliverable: verifier 2
      deliverable: keep and stop
      catch-all: mark the domain, apply the catch-all rule, stop
      anything else: next candidate
none left: drop, with the most specific reason
```

**Catch-all probe.** Before anyone at a domain is revealed, one verifier call on a random address at that domain tests whether it accepts everything. It costs one verifier credit per domain and prevents paying for reveals nobody could use. Domain state is cached.

**All drop reasons:** `duplicate`, `no_company`, `junk_row`, `not_a_company`, `company_not_found`, `excluded_company`, `existing_customer`, `low_tier`, `tiering_failed`, `no_people_found`, `no_email_found`, `not_deliverable`, `email_unconfirmed`, `catch_all_unconfirmed`, `employment_unconfirmed`, `vendor_error`, `budget_cap`, `rejected_in_review`, `opted_out`, `crm_unsubscribed`, `crm_do_not_contact`.

**What verification does not prove.** A verified address means a mailbox exists, not that it belongs to this person. So the address must come from a source tied to the person, and the local part must fit the person's name, or it becomes a review case.

**Pattern guessing is off by default.** It needs verified addresses at that domain, and generating addresses by guessing carries legal risk in some markets. The FTC lists "dictionary attack" address generation, and EU rules are stricter. Counsel should sign off before it is switched on.

**Employment.** Right after reveal and before any verifier is paid, the employer must match the company's domain, a known alias or its parent. For a discovered person a mismatch drops as `employment_unconfirmed`. A registered attendee who disagrees with the vendor becomes a review case. Research found no reliable way to confirm current employment, so this catches wrong-company matches, not every job change.

**Re-verify** any cached result older than 30 days before delivery. A vendor-run decay test found 5.5% of a verified list unusable after 8 weeks. Cache positive and negative results by address.

## Vendors

Every vendor at every step has its own rate limit, backoff and circuit breaker.

- A failing vendor is skipped and the waterfall continues.
- The event pauses when every vendor at a step is down. ZeroBounce is the one verifier, so an outage there pauses the event.
- Apollo can answer a burst with an empty success that looks like no match. So a known-good lookup runs when results suddenly dry up, and no "nobody found" is final until it passes.
- Charging is modeled per vendor and outcome, since some charge on a miss.
- Waterfall length is an open question. In the two comparisons found, a waterfall barely beat, or lost to, a good single source. Each added vendor must show its gain.
- Every value stores source, time, attempts and license. Export and resale restrictions are honored by default.
- A suppression list spans events: opt-outs and known wrong-person pairs. A person's Drop in one event's review stays with that event.
- Where a vendor reports a real balance, it is read after the run and compared to the ledger, since Apollo's real burn can exceed what a response reports. Caps bound the configured cost, and any gap is shown.
- The second verifier is required by the owner's rule, and its added value is measured too.

## Paying for it

Paid calls keep the existing rule: reserve, call, settle, with hard caps. Caps are now per card and per step, and LLM cost is per step because models differ.

**Research card:** one person match per unresolved company, reverse lookups, firmographics, and for each company up to 4 tier calls (one invalid-answer retry on each of two passes) plus one website read and one second look, plus a stated re-tier allowance. It covers every company, so a settled case never needs more money.

**Outreach card:** maximum people is attendees at A or B, plus companies times quota. Per person: Apollo's match once, its email waterfall at the configured worst case, ZeroBounce on up to 3 candidates with one retry, one LinkedIn lookup. Plus one catch-all probe per domain, title parsing, model flags and the Concierge allowance. It also shows an estimate, clearly labeled, using configured hit rates until real ones exist. A declined Outreach card returns to the review step; the research stays paid for.

Anything refused at a cap drops with `budget_cap` where it affects a person, and raises a review case where it affects a company. Caps stay in credits and in LLM calls per step, which needs a ledger change.

## Review cases

A case has a kind, the conflicting values, a suggested answer and its allowed answers. Answers are applied by one function per kind.

**Before Approval 2, these hold spend:** ambiguous identity, company not found, Unknown tier, second-look disagreement, fuzzy match to a customer or exclusion, CRM says customer but the list does not, subsidiary inheritance. A settled company finishes its research immediately, already covered by the Research card. Someone can skip what remains, which means no spend for those companies. The Outreach card is generated only once no case is open, so it can never be exceeded by a late answer.

**After delivery, these need a person but block nothing:** a registered attendee the vendor places elsewhere, a name that does not fit the address, a free webmail address, same person at two companies, a late-stage deal with an owner, model flags on title, tenure or name.

Each decision is stored as labeled data with its reason.

## Proving it works

Three separate kinds of proof, which are not interchangeable.

1. **Logic, in a simulated world.** Fictional companies and people with known truth, and vendors that misbehave at set rates: stale employers, right name at the wrong company, wrong emails, catch-all domains, rate limits, silent throttling, outages. Hard cases are written on purpose. This proves the code does the right thing. Its accuracy numbers only reflect rates we chose.
2. **Model judgment.** Labeled sets split into a development set and a frozen holdout, reported with confidence intervals. Tuning on the set you score on inflates results; in one study a judge prompt fell from kappa 0.555 on the tuning set to 0.350 on held-out data. Gates carry over (company 85%, title 90%, no tier 3 labeled tier 1) and apply to the holdout, with Unknown counted as wrong and capped at 25% so abstaining cannot pass. The fictional list cannot test how models handle real obscure companies, so the holdout needs real public companies, labeled by hand against the ICP. The existing title score of 100% was tuned on its own test set, so it does not count.
3. **Real accuracy.** A small hand-verified gold set of real records, per vendor, scored on wrong-domain and find rate. Nothing else can establish it. Without sending, question 4 can only be measured as verifier agreement; true delivery needs bounces, which arrive when sending exists.

## Starting values for new settings

These are judgment calls with no outside evidence behind them, and are meant to be tuned.

| Setting | Value |
|---|---|
| Tier 1 share warning | 25% |
| Small list | under 20 companies |
| Quota, tier 1 and tier 2 | 5 and 3 |
| Candidates per person | 3 |
| Record freshness limit | 180 days |
| Verification reuse, positive and negative | 30 days |
| Firmographics cache | 90 days |

Model choices start at Haiku 5.5 for title parsing and flags, Sonnet 5.5 for company tier, Opus 5.5 for the second look and Concierge. A step moves only if its holdout gate still passes.

## Decisions needed

1. **Catch-all domains.** Vendor data puts catch-all at roughly 20% to 27% of domains and about 36% of decision-maker contacts in one sample, so a strict rule drops many people, sometimes at the best accounts. Recommendation: keep the rule, report these as a gap, and add a specialist catch-all verifier as an optional step that still must confirm. Claimed accuracy for those tools is disputed (97% claimed, 73.6% in the one head-to-head).
2. **Two cards.** Assumed here. One more approval, in exchange for a real quote and a place to fix tiers.
3. **The ICP for the demo.** A fictional seller with a real, structured ICP is needed for the demo and the evals.
4. **Vendors for real adapters.** Apollo needs a paid plan.

## Build order

1. Simulated world and measures.
2. Foundation: data model for identity and caches, two cards, new stages, per-step caps, review case model, event country.
3. Layer 0, ingest changes, list quality report, free title pass.
4. ICP object, upload and compile, demo ICP.
5. Identity, with vendor seams, breakers, throttling detection, CRM by domain.
6. Gates, firmographics, company tier, baseline, holdout, spread check.
7. People search, title parsing, priority, ranking, quotas.
8. Catch-all probe, reveal, employment check, email loop, suppression, caches.
9. Conflict cases after delivery, Companies tab, screens and workbook updates. The workbook gains an **Other attendees** tab: uploaded attendees at a tier 3 company or with a tier 3 title (not every priority C), with name, title, company, both tiers and the reason, and no paid enrichment. The tab appears only when the list had such people, so a company-only list does not show it.

**Cut line if time runs out:** the second look, website reads and catch-all verifier go first. Identity, the ICP object and the email loop are never cut.
