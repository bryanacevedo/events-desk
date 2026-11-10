/* Phone only: where the tab bar's More goes. Usage and Settings. */

import { Link } from "./App";
import { Icon } from "./icons";

export function More({ go }: { go: (to: string) => void }) {
  return (
    <>
      <header className="hero" data-ready="1"><div><h1>More</h1></div></header>
      <nav className="morelist" aria-label="More">
        <Link to="/my-day" go={go} className="navitem"><span className="ico"><Icon.calendar /></span><span className="lbl">My day</span></Link>
        <Link to="/usage" go={go} className="navitem"><span className="ico"><Icon.usage /></span><span className="lbl">Usage</span></Link>
        <Link to="/settings" go={go} className="navitem"><span className="ico"><Icon.settings /></span><span className="lbl">Settings</span></Link>
      </nav>
    </>
  );
}
