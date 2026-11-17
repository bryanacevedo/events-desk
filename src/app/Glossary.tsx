/* The words this desk uses, in plain words, one click from the Overview and the Events page. Each is a fact about the desk, not a tour. */

import { useState } from "react";

export const WORDS: [string, string][] = [
  ["Planning, Confirmed, Preparing, Live, Following up, Scored", "Where an event is in its plan: written and waiting for approval, approved, within 30 days of the doors, happening, after it, and closed with a result."],
  ["Waiting on seats, No attendee list yet, Ready to run", "Where the list is: seats waiting for a decision, seats approved and no attendee list in, list in and the cost agreed."],
  ["Case, Cases to settle", "Two sources disagree and the desk will not pick one alone, such as one company under two names. A person settles each."],
  ["Tier 1, 2, 3", "How well a company fits who the team sells to. Tier 1 is the closest fit."],
  ["Priority A, B, C", "Which people at a company to write to first."],
  ["Sequence", "A set of messages sent one after another to a person, until they reply."],
  ["In market", "Outreach has started for the event and the messages are going out."],
  ["Reached, Replies, Meetings", "People written to, people who answered, and meetings held. People met at the booth have no outreach, so they count only as meetings."],
  ["Held back by account owners", "People left out of outreach because a salesperson already owns that account."],
  ["Paused", "The run stopped because a step failed. Resume tries it again."],
  ["Ledger, Trays, Timeline", "Three ways to lay out the same Overview: one list, boxes by kind, or along a calendar."],
  ["Acting as", "Who you are in this sample. Each person sees and may do different things. GTM Team is GTM Engineering."],
  ["Research companies, Verify and find contacts, Outreach list ready", "The steps from an attendee list to a list of people to write to: look each company up, check the emails and find more people, then the list is ready."],
  ["Kit, Make my kit", "Images and text made for a talk or a seat, for the person to post themselves. The desk never posts."],
  ["Meeting slots, Open slots", "Times the team offers for meetings. Open slots adds them; a free slot has no one booked yet."],
  ["Why we go, Taking part, Who goes", "On a plan: the reason for going, the ways the team takes part (passes, a talk, a booth), and the people who go."],
  ["Scanner", "A page for a phone at the booth: it saves each badge or conversation, and sends them when there is signal."],
];

export function Glossary() {
  const [open, setOpen] = useState(false);
  return (
    <details className="gloss" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>What the words mean</summary>
      <dl>{WORDS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </details>
  );
}
