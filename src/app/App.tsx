/* Shell and router. A persistent sidebar on desktop, a tab bar on phones. Overview (home), Events,
   Seats, Settings, and the full event page. The acting person is a sidebar choice in every mode. There is no login: it is self-asserted. */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { get } from "./api";
import { Events } from "./Events";
import { Event } from "./Event";
import { Icon, Mark } from "./icons";
import { Overview } from "./Overview";
import { Seats } from "./Seats";
import { Budget } from "./Budget";
import { Usage } from "./Usage";
import { MyDay } from "./MyDay";
import { Results } from "./Results";
import { More } from "./More";
import { PersonAvatar } from "./PersonAvatar";
import { Settings } from "./Settings";
import { PERSONAS } from "../shared/roles";
import { loadNeeds, type Needs } from "./waiting";
import { isGtm } from "../shared/roles";
import { setDemoCalendar } from "./stages";

export const PEOPLE = PERSONAS.map((p) => p.name);
interface Ctx { actor: string; demo: boolean; needs: Needs | null; refresh: () => Promise<void>; go: (to: string) => void }
const AppCtx = createContext<Ctx>({ actor: PEOPLE[0], demo: false, needs: null, refresh: async () => {}, go: (to) => { location.href = to; } });
export const useActor = () => useContext(AppCtx);

function storedActor() { try { const a = localStorage.getItem("actor"); return a && PEOPLE.includes(a) ? a : PEOPLE[0]; } catch { return PEOPLE[0]; } }
function rememberActor(a: string) { try { localStorage.setItem("actor", a); } catch { /* private window */ } }

/** Old places keep working: Calendar and All events are Events, Approvals and Needs are Seats. The query string stays. */
const MOVED: Record<string, string> = { "/calendar": "/events", "/all": "/events", "/approvals": "/seats", "/needs": "/seats", "/icp": "/settings" };
export function canonical(url: string) {
  const [pathname, query] = url.split("?");
  return (MOVED[pathname] ?? pathname) + (query ? `?${query}` : "");
}

export function usePath() {
  const read = () => canonical(location.pathname + location.search);
  const [path, setPath] = useState(read());
  useEffect(() => {
    if (read() !== location.pathname + location.search) history.replaceState(null, "", read());
    const on = () => setPath(read());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  // pushState does not announce a new #view, so a link to another view of the page already open says so itself.
  const go = (raw: string) => { const to = canonical(raw); history.pushState(null, "", to); setPath(to); if (to.includes("#")) window.dispatchEvent(new HashChangeEvent("hashchange")); if (!to.includes("?event=")) scrollTo(0, 0); };
  return [path, go] as const;
}

export function Link({ to, go, className, children, ...rest }: { to: string; go: (to: string) => void; className?: string; children?: ReactNode; "aria-label"?: string; "aria-current"?: "page"; style?: React.CSSProperties; title?: string }) {
  return <a href={to} className={className} {...rest} onClick={(ev) => { if (ev.metaKey || ev.ctrlKey || ev.button !== 0) return; ev.preventDefault(); go(to); }}>{children}</a>;
}

type Place = "overview" | "events" | "seats" | "budget" | "results" | "usage" | "more" | "settings" | "event" | "myday";
function placeOf(pathname: string): Place {
  if (/^\/event\//.test(pathname)) return "event";
  if (pathname === "/events") return "events";
  if (pathname === "/seats") return "seats";
  if (pathname === "/budget") return "budget";
  if (pathname === "/results") return "results";
  if (pathname === "/usage") return "usage";
  if (pathname === "/my-day") return "myday";
  if (pathname === "/more") return "more";
  if (pathname === "/settings") return "settings";
  return "overview";
}

export function App() {
  const [path, go] = usePath();
  const [actor, setActor] = useState(storedActor());
  const [demo, setDemo] = useState<boolean | null>(null);
  const [needs, setNeeds] = useState<Needs | null>(null);
  const refresh = useCallback(async () => { setNeeds(await loadNeeds()); }, []);
  const pathname = path.split("?")[0];
  useEffect(() => { get<{ demo: boolean }>("/api/health").then((h) => setDemo(Boolean(h?.demo))); }, []);
  useEffect(() => { refresh(); }, [pathname, refresh]);
  // How many people are waiting on whoever is acting, across events.
  const [waiting, setWaiting] = useState(0), [dayHas, setDayHas] = useState(false);
  useEffect(() => { get<{ replies: unknown[]; meetings: unknown[]; captures: unknown[] }>(`/api/motion/my-day?rep=${encodeURIComponent(actor)}`).then((d) => { setWaiting(d?.replies.length ?? 0); setDayHas(Boolean(d && (d.replies.length || d.meetings.length || d.captures.length))); }); }, [actor, pathname]);

  const search = new URLSearchParams(path.split("?")[1] ?? "");
  const eventId = pathname.match(/^\/event\/([^/]+)/)?.[1];
  const place = placeOf(pathname);
  const count = needs?.approvals.length ?? 0;
  // Seats is where leadership decides seat requests. Everyone else follows their own requests on My day, so the tab is only in the approvers' menu.
  // Budget and Usage are company spend: leadership's and GTM Engineering's, not an SDR's day.
  setDemoCalendar(Boolean(demo));
  const approver = Boolean(needs?.approvers.includes(actor)), lead = approver || isGtm(actor);
  // My day is the rep's page: replies, meetings, people met. Leadership's day is the seat queue on Overview and Seats, so an empty My day stays out of their menu.
  const showDay = !lead || dayHas;
  const navAt = ["overview", ...(showDay ? ["myday"] : []), "events", ...(approver ? ["seats"] : []), ...(lead ? ["budget", "results", "usage"] : [])].indexOf(place);
  if (demo === null) return null;

  const item = (to: string, p: Place, label: string, icon: ReactNode, cls: string, badge?: number) => (
    <Link to={to} go={go} className={cls} aria-current={place === p ? "page" : undefined}>
      <span className="ico">{icon}</span><span className="lbl">{label}</span>
      {badge ? <span className="n" aria-label={`${badge} waiting`}>{badge}</span> : null}
    </Link>
  );
  const pick = (ev: { target: { value: string } }) => { setActor(ev.target.value); rememberActor(ev.target.value); };

  return (
    <AppCtx.Provider value={{ actor, demo, needs, refresh, go }}>
      <div className="app">
        <nav className="side" aria-label="Events Desk">
          <Link to="/" go={go} className="brand"><Mark /><span>Events Desk</span></Link>
          <div className="navlist" style={{ "--at": navAt } as React.CSSProperties} data-on={navAt >= 0 ? "" : undefined}>
            {item("/", "overview", "Overview", <Icon.overview />, "navitem")}
            {showDay && item("/my-day", "myday", "My day", <Icon.calendar />, "navitem", waiting)}
            {item("/events", "events", "Events", <Icon.events />, "navitem")}
            {approver && item("/seats", "seats", "Seats", <Icon.seats />, "navitem", count)}
            {lead && item("/budget", "budget", "Budget", <Icon.budget />, "navitem")}
            {lead && item("/results", "results", "Results", <Icon.results />, "navitem")}
            {lead && item("/usage", "usage", "Usage", <Icon.usage />, "navitem")}
          </div>
          <span className="spacer" />
          <div className="side-foot">
            <Link to="/events?request=1" go={go} className="btn side-cta">Request seats</Link>
            {isGtm(actor) && item("/settings", "settings", "Settings", <Icon.settings />, "navitem")}
            <label className="acting"><PersonAvatar name={actor} size={28} /><span>Acting as</span>
              <select value={actor} onChange={pick}>{PEOPLE.map((p) => <option key={p}>{p}</option>)}</select>
            </label>
            {demo && <p className="demo-note">Real event names, simulated attendees.</p>}
          </div>
        </nav>

        <main className="main" data-screen={place}>
          <header className="phone-top">
            <Link to="/" go={go} className="brand"><Mark size={22} /><span>Events Desk</span></Link>
            <span className="spacer" />
            <select className="phone-actor" aria-label="Acting as" value={actor} onChange={pick}>{PEOPLE.map((p) => <option key={p}>{p}</option>)}</select>
          </header>
          {place === "overview" && <Overview go={go} sheetId={search.get("event")} />}
          {place === "events" && <Events go={go} sheetId={search.get("event")} requesting={search.get("request") === "1"} preselect={search.get("catalog")} search={search} />}
          {place === "seats" && <Seats go={go} search={search} requesting={search.get("request") === "1"} preselect={search.get("catalog")} />}
          {place === "budget" && (lead ? <Budget go={go} search={search} /> : <p className="md-clear">Budget is for leadership and GTM Engineering.</p>)}
          {place === "results" && (lead ? <Results go={go} /> : <p className="md-clear">Results are for leadership and GTM Engineering.</p>)}
          {place === "usage" && (lead ? <Usage go={go} search={search} /> : <p className="md-clear">Usage is for leadership and GTM Engineering.</p>)}
          {place === "myday" && <MyDay />}
          {place === "more" && <More go={go} showDay={approver && showDay} />}
          {place === "settings" && <Settings go={go} compileId={search.get("compile")} section={search.get("section")} />}
          {place === "event" && <Event key={eventId} id={eventId!} go={go} />}
        </main>

        <nav className="tabs" aria-label="Events Desk">
          {item("/", "overview", "Overview", <Icon.overview />, "tab")}
          {item("/events", "events", "Events", <Icon.events />, "tab")}
          {approver ? item("/seats", "seats", "Seats", <Icon.seats />, "tab", count) : showDay && item("/my-day", "myday", "My day", <Icon.calendar />, "tab", waiting)}
          {lead && item("/budget", "budget", "Budget", <Icon.budget />, "tab")}
          {/* More holds Usage and Settings, which are leadership's and GTM's. For anyone else it would be an empty page. */}
          {lead && <Link to="/more" go={go} className="tab" aria-current={["more", "usage", "settings"].includes(place) ? "page" : undefined}><span className="ico"><Icon.more /></span><span className="lbl">More</span></Link>}
        </nav>
      </div>
    </AppCtx.Provider>
  );
}
