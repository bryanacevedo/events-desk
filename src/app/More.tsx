/* Phone only: where the tab bar's More goes. Usage and Settings for those who own them, and My day for an approver who has something on it (their tab is Seats). */

import { Link, useActor } from "./App";
import { isGtm } from "../shared/roles";
import { Icon } from "./icons";

export function More({ go, showDay }: { go: (to: string) => void; showDay: boolean }) {
  const { actor, needs } = useActor();
  const lead = Boolean(needs?.approvers.includes(actor)) || isGtm(actor);
  return (
    <>
      <header className="hero" data-ready="1"><div><h1>More</h1></div></header>
      <nav className="morelist" aria-label="More">
        {showDay && <Link to="/my-day" go={go} className="navitem"><span className="ico"><Icon.calendar /></span><span className="lbl">My day</span></Link>}
        {lead && <Link to="/usage" go={go} className="navitem"><span className="ico"><Icon.usage /></span><span className="lbl">Usage</span></Link>}
        {isGtm(actor) && <Link to="/settings" go={go} className="navitem"><span className="ico"><Icon.settings /></span><span className="lbl">Settings</span></Link>}
      </nav>
    </>
  );
}
