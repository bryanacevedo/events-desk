# Design checklist

Every rule Bryan has set for the screens, in one place, as checks. Nothing reaches him for review until every screen it touches
passes these, checked in a real browser by a reviewer who has not seen the work (the hands-on goldfish), not only by the builder.
Where a rule can be measured, a script measures it; the rest the reviewer checks by eye. Sources: SCREENS-BRIEF.md and Bryan's
corrections during the v2 build, 2026-11-08 to 11-10.

## Words

- [ ] No sentence explains a screen, a heading, a figure or a row. The screen explains itself. (Gate: `tests/screen-copy.test.ts`.)
- [ ] No data written as a sentence ("17 people dropped as low tier, 1 deal since", "$43,802, $14,601 per meeting held, plus 136 credits"). Values are laid out as values: a figure with a one-word label, or a field.
- [ ] Words people wrote (a rep's notes, a buyer's quote) are welcome. Words the app strings together are not.
- [ ] No jargon a rep or a VP would not use ("held out at random", "waterfall", "flat-priced", "perspective", "the model"). Plain words.
- [ ] A label never claims more than the data: a deal is pipeline, not "bought"; "on target" needs a target.
- [ ] One name for one thing across every screen.
- [ ] Where a person came from is always named, in its accent: Attendee in green, Prospect in blue.
- [ ] A value is shown once per view: never as a heading and again in the line under it.
- [ ] Every bar says what it measures, on the bar: a share ("31%"), a share of something named ("28% of Q1"), or used of approved ("44 of 604"). A bar with no number beside it is decoration. The one exception is a timeline drawn on a date axis (the Events runway): the axis is its scale, and a step count on it added nothing (Bryan, 2026-11-10).
- [ ] Rows in one list share one right edge: amounts, actions and the figure above them line up. An action that appears on hover takes the place of the value it acts on ("Edit" replaces the amount, "Open" replaces the time).
- [ ] A history or log line that is really counts shows them as figures with a plain label ("Tier mix: 87 tier 1, 133 tier 2"), never a run-on sentence.
- [ ] A decision card shows only what helps make the decision; raw file fields that say nothing about it (registration IDs, ticket types, badge names) stay out.
- [ ] Display tidies what people read (company names in capitals become Title Case) without changing what the pipeline reads.
- [ ] Each figure has one home. Its breakdown lives in one place (an event's cost lines on its Cost tab); elsewhere it appears as one figure that links there.
- [ ] No em dashes. No red or orange text.

## Look

- [ ] Nothing that reads machine-made: no coloured status dots, no pills or tags, no quote cards with a coloured left edge, no icon-in-a-circle cards, no KPI tile rows, no gradients. The one coloured mark allowed is a count of things waiting on the reader (the number beside Seats, My day, or a tab), which Bryan asked for.
- [ ] Nothing is underlined to say it can be clicked.
- [ ] Elegant and subtle, never overdesigned: the lightest fix wins (a figure, a field, or removing the thing).
- [ ] Built from the shared parts: trays of tiles, the brief's bar rows, folds, figures in a row, side sheets. No new kind of element without a reason.
- [ ] Space: nothing cramped, nothing floating in empty white.
- [ ] Alignment: blocks share the page's edges; a row of figures has equal space between figures (not equal columns, which leave uneven gaps when numbers differ in length), every figure row in the app, each label centred under its figure and every label on one baseline (Gate: `scripts/audit-layout.mjs`); nothing narrower than its neighbours by accident.
- [ ] Numbers that sit together are the same size; a supporting figure is a step under the verdict it supports.
- [ ] A buyer's own words carry the green opening quote mark, and a full reply sits in a speech bubble, everywhere they appear.
- [ ] One button per purpose: never two buttons that take you to the same place.
- [ ] Button words cannot be misread: no "Close" beside deal words; a panel closes with the same × as a sheet.
- [ ] Buttons look like buttons: the green pill for the main action, never a plain bordered box.

## Structure

- [ ] One layer at a time. Replace, don't add: new information takes a weaker thing's place.
- [ ] Separate jobs live in separate tabs (Outreach is not Results). Replies, and decisions about replies, live on Outreach; decisions about who is on the list live on People.
- [ ] A tab with decisions waiting shows how many, like the menu's count beside Seats.
- [ ] The menu follows the person's job: nobody sees a page they cannot use or that would be empty for them. GTM Engineering sees every page that has work or figures for it; My day is a rep's page and stays out of GTM's menu while it would be empty.
- [ ] Company money (cost, pipeline, deals, return, AI spend) only for leadership and GTM, on every screen and every read.
- [ ] Everything that names a person, a company, an event, a reply, a meeting or a deal opens it.

## Side sheets (every object: event, reply, meeting, deal)

- [ ] Who or what it is: face or logo, name, context as links.
- [ ] Its key figures in one row.
- [ ] The action that matters (reply in the tool, open in the CRM, record the outcome).
- [ ] The account it belongs to, and the people there.
- [ ] What it came from and what it led to, each one tap away.
- [ ] The path so far.
- [ ] A sheet opened from another sheet shows the way back to it.
- [ ] Opening, switching and closing keep the reader's place; Esc, a click outside, back and × all close it. (Gate: `scripts/audit-interactions.mjs`.)

## Behaviour

- [ ] Motion in the Overview's language: rows arrive one after another, figures settle, bars draw, rows slide and lift on hover, logos tilt, "Open" replaces the time.
- [ ] Nothing jumps, flashes, reloads or loses the reader's place, including switching tabs.
- [ ] Clicking a row does the same kind of thing everywhere.
- [ ] A link to a person lands on that person: their row open and scrolled into view.
- [ ] Time words fit the event: a past event says who went, shows no countdown, and does not repeat its stage as a note.
- [ ] No console errors. Nothing takes over a second to answer.
- [ ] Phone width: nothing scrolls sideways, nothing overlaps, every tap target is at least 44px. (Gate: `scripts/audit-layout.mjs`.)

## Data a visitor will see

- [ ] Demo data holds up to a close look: dates fit the event, times vary, names are distinct, sample controls do not look like real work.
- [ ] The same figure is the same value on every screen.
