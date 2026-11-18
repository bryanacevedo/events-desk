/* The first screen of the sample desk: what this desk is for in one sentence, one first step, and a short tour reachable from it.
   Shown on the Overview in the demo only; a real team already knows its desk. */

import { Link } from "./App";

/** The finished event the first step opens: replies, meetings and what the desk set aside, all read after the event. */
export const FIRST_STEP_EVENT = "evt_money20-20-usa-2026";

/** Where a buyer goes next (Bryan, 2026-11-17): a mail to him. A mailto link opens in the mail app, so it carries no target or rel. */
export const CONTACT_URL = "mailto:bryan@leandrive.io?subject=Events%20Desk%20demo";

export const VALUE_LINE = "Events Desk takes a conference from the request for a seat to a list of people to contact, and shows which events paid back.";

export const TOUR_HIRING = [
  "Overview: every event on a line from earlier to later, with where each one stands.",
  "Open Money20/20 USA 2026 and read its Outreach: who replied, who met us, who was set aside and why.",
  "Choose Dan Whitlock under Acting as, open Seats, and decide a request.",
  "Open the plan of an event: its goal against what happened.",
] as const;

export const TOUR_BUYER = [
  "Events: every listed event by date, and who each one waits on.",
  "Request a seat: the form a rep fills in and an approver reads.",
  "Choosing: which events to repeat, and where the numbers are too thin to say.",
  "Results: pipeline per dollar for the events that finished.",
] as const;

export const NEXT_STEP_LEAD = "Next step:";
export const NEXT_STEP_LINK = "Write to Bryan about your own data";
export const NEXT_STEP = `${NEXT_STEP_LEAD} ${NEXT_STEP_LINK}`;

export function StartHere({ go }: { go: (to: string) => void }) {
  return (
    <section className="first-screen" aria-label="Start here">
      <p className="first-lede">{VALUE_LINE}</p>
      <div className="actions">
        <Link to={`/event/${FIRST_STEP_EVENT}#outreach`} go={go} className="btn">See a finished event</Link>
        <span className="small mute">Money20/20 USA 2026, with its replies and meetings.</span>
      </div>
      <details>
        <summary>Take the tour</summary>
        <div className="paths">
          <div><h3>If you are judging the build</h3><ol>{TOUR_HIRING.map((t) => <li key={t}>{t}</li>)}</ol></div>
          <div><h3>If you run events</h3><ol>{TOUR_BUYER.map((t) => <li key={t}>{t}</li>)}</ol>
            <p className="next">{NEXT_STEP_LEAD} <a href={CONTACT_URL}>{NEXT_STEP_LINK}</a></p></div>
        </div>
      </details>
    </section>
  );
}
