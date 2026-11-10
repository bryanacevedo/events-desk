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
import { More } from "./More";
import { PersonAvatar } from "./PersonAvatar";
import { Settings } from "./Settings";
import { PERSONAS } from "../shared/roles";
import { loadNeeds, type Needs } from "./waiting";

export const PEOPLE = PERSONAS.map((p) => p.name);
interface Ctx { actor: string; demo: boolean; needs: Needs | null; refresh: () => Promise<void> }
const AppCtx = createContext<Ctx>({ actor: PEOPLE[0], demo: false, needs: null, refresh: async () => {} });
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
  const go = (raw: string) => { const to = canonical(raw); history.pushState(null, "", to); setPath(to); if (!to.includes("?event=")) scrollTo(0, 0); };
  return [path, go] as const;
}

export function Link({ to, go, className, children, ...rest }: { to: string; go: (to: string) => void; className?: string; children?: ReactNode; "aria-label"?: string; "aria-current"?: "page"; style?: React.CSSProperties; title?: string }) {
  return <a href={to} className={className} {...rest} onClick={(ev) => { if (ev.metaKey || ev.ctrlKey || ev.button !== 0) return; ev.preventDefault(); go(to); }}>{children}</a>;
}

type Place = "overview" | "events" | "seats" | "budget" | "usage" | "more" | "settings" | "event" | "myday";
function placeOf(pathname: string): Place {
  if (/^\/event\//.test(pathname)) return "event";
  if (pathname === "/events") return "events";
  if (pathname === "/seats") return "seats";
  if (pathname === "/budget") return "budget";
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

  const search = new URLSearchParams(path.split("?")[1] ?? "");
  const eventId = pathname.match(/^\/event\/([^/]+)/)?.[1];
  const place = placeOf(pathname);
  const count = needs?.approvals.length ?? 0;
  const navAt = ["overview", "events", "seats", "budget", "myday", "usage"].indexOf(place);
  if (demo === null) return null;

  const item = (to: string, p: Place, label: string, icon: ReactNode, cls: string, badge?: number) => (
    <Link to={to} go={go} className={cls} aria-current={place === p ? "page" : undefined}>
      <span className="ico">{icon}</span><span className="lbl">{label}</span>
      {badge ? <span className="n" aria-label={`${badge} waiting`}>{badge}</span> : null}
    </Link>
  );
  const pick = (ev: { target: { value: string } }) => { setActor(ev.target.value); rememberActor(ev.target.value); };

  return (
    <AppCtx.Provider value={{ actor, demo, needs, refresh }}>
      <div className="app">
        <nav className="side" aria-label="Events Desk">
          <Link to="/" go={go} className="brand"><Mark /><span>Events Desk</span></Link>
          <div className="navlist" style={{ "--at": navAt } as React.CSSProperties} data-on={navAt >= 0 ? "" : undefined}>
            {item("/", "overview", "Overview", <Icon.overview />, "navitem")}
            {item("/events", "events", "Events", <Icon.events />, "navitem")}
            {item("/seats", "seats", "Seats", <Icon.seats />, "navitem", count)}
            {item("/budget", "budget", "Budget", <Icon.budget />, "navitem")}
            {item("/my-day", "myday", "My day", <Icon.overview />, "navitem")}
            {item("/usage", "usage", "Usage", <Icon.usage />, "navitem")}
          </div>
          <span className="spacer" />
          <div className="side-foot">
            <Link to="/events?request=1" go={go} className="btn side-cta">Request seats</Link>
            {item("/settings", "settings", "Settings", <Icon.settings />, "navitem")}
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
          {place === "budget" && <Budget go={go} search={search} />}
          {place === "usage" && <Usage go={go} search={search} />}
          {place === "myday" && <MyDay />}
          {place === "more" && <More go={go} />}
          {place === "settings" && <Settings go={go} compileId={search.get("compile")} section={search.get("section")} />}
          {place === "event" && <Event key={eventId} id={eventId!} go={go} />}
        </main>

        <nav className="tabs" aria-label="Events Desk">
          {item("/", "overview", "Overview", <Icon.overview />, "tab")}
          {item("/events", "events", "Events", <Icon.events />, "tab")}
          {item("/seats", "seats", "Seats", <Icon.seats />, "tab", count)}
          {item("/budget", "budget", "Budget", <Icon.budget />, "tab")}
          <Link to="/more" go={go} className="tab" aria-current={["more", "usage", "settings"].includes(place) ? "page" : undefined}><span className="ico"><Icon.more /></span><span className="lbl">More</span></Link>
        </nav>
      </div>
    </AppCtx.Provider>
  );
}
