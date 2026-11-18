/* Shell and router. A persistent sidebar on desktop, a tab bar on phones. Overview (home), Events,
   Seats, Settings, and the full event page. The acting person is a sidebar choice in every mode. There is no login: it is self-asserted. */

import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { get } from "./api";
import { Icon, Mark } from "./icons";
import { PersonAvatar } from "./PersonAvatar";
import { PageSkeleton } from "./Skeleton";
import { DemoBar } from "./DemoBar";
import { PERSONAS } from "../shared/roles";
import { loadNeeds, type Needs } from "./waiting";
import { isGtm } from "../shared/roles";
import { setDemoCalendar } from "./stages";
import { setSampleTools } from "./tools";
import { LOADING, decisionsOf, plannerAccess, type Decisions } from "./access";

/* Each page is its own file the browser fetches when it is opened. The shell (sidebar, bar, tabs) is the only thing every visit downloads first. */
const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType<any>>>, name: K) => lazy(() => load().then((m) => ({ default: m[name] })));
const Events = page(() => import("./Events"), "Events");
const Event = page(() => import("./Event"), "Event");
const Overview = page(() => import("./Overview"), "Overview");
const Seats = page(() => import("./Seats"), "Seats");
const SeatDecisions = page(() => import("./SeatDecisions"), "SeatDecisions");
const Budget = page(() => import("./Budget"), "Budget");
const Usage = page(() => import("./Usage"), "Usage");
const MyDay = page(() => import("./MyDay"), "MyDay");
const Results = page(() => import("./Results"), "Results");
const Choosing = page(() => import("./Choosing"), "Choosing");
const Speaking = page(() => import("./Speaking"), "Speaking");
const More = page(() => import("./More"), "More");
const Settings = page(() => import("./Settings"), "Settings");
const ObjectSheets = page(() => import("./Objects"), "ObjectSheets");

export const PEOPLE = PERSONAS.map((p) => p.name);
interface Ctx { actor: string; demo: boolean; sample: Sample; decisions: Decisions; needs: Needs | null; refresh: () => Promise<void>; go: (to: string) => void; /** A line at the foot of the screen that stays across a page change, for a thing that was just sent. */ toast: (words: string) => void }
/** What the demo says about itself (from /api/health): whether it is the public one, and the day its sample events were set around. */
export interface Sample { publicDemo: boolean; day: string | null; /** Set only by the static snapshot (decision 109): the day it was taken, as words. */ snapshot?: string | null }
const AppCtx = createContext<Ctx>({ actor: PEOPLE[0], demo: false, sample: { publicDemo: false, day: null }, decisions: "none", needs: null, refresh: async () => {}, go: (to) => { location.href = to; }, toast: () => {} });
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
  // A new page starts at its top. Opening, switching or closing a side sheet keeps the same page and the reader's place on it.
  const go = (raw: string) => { const to = canonical(raw); const samePage = to.split(/[?#]/)[0] === location.pathname; history.pushState(null, "", to); setPath(to); if (to.includes("#")) window.dispatchEvent(new HashChangeEvent("hashchange")); if (!samePage) scrollTo(0, 0); };
  return [path, go] as const;
}

export function Link({ to, go, className, children, ...rest }: { to: string; go: (to: string) => void; className?: string; children?: ReactNode; "aria-label"?: string; "aria-current"?: "page"; style?: React.CSSProperties; title?: string; tabIndex?: number }) {
  return <a href={to} className={className} {...rest} onClick={(ev) => { if (ev.metaKey || ev.ctrlKey || ev.button !== 0) return; ev.preventDefault(); go(to); }}>{children}</a>;
}

type Place = "overview" | "events" | "seats" | "seatdecisions" | "budget" | "results" | "choosing" | "speaking" | "usage" | "more" | "settings" | "event" | "myday";
function placeOf(pathname: string): Place {
  if (/^\/event\//.test(pathname)) return "event";
  if (pathname === "/events") return "events";
  if (pathname === "/seats") return "seats";
  if (pathname === "/seat-decisions" || pathname === "/waiting") return "seatdecisions";
  if (pathname === "/budget") return "budget";
  if (pathname === "/results") return "results";
  if (pathname === "/choosing") return "choosing";
  if (pathname === "/speaking") return "speaking";
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
  // The hash is a view inside a page (#result, #people): it never changes which page this is.
  const [beforeHash] = path.split("#");
  const pathname = beforeHash.split("?")[0];
  const [decisions, setDecisions] = useState<Decisions>("none");
  const [note, setNote] = useState("");
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(""), 7000); return () => clearTimeout(t); }, [note]);
  const [sample, setSample] = useState<Sample>({ publicDemo: false, day: null });
  useEffect(() => { get<{ demo: boolean; decisions?: string; public_demo?: boolean; sample_day?: string | null; snapshot?: { taken_on: string } }>("/api/health").then((h) => { setDemo(Boolean(h?.demo)); setDecisions(decisionsOf(h)); setSample({ publicDemo: Boolean(h?.public_demo), day: h?.sample_day ?? null, snapshot: h?.snapshot?.taken_on ?? null }); }); }, []);
  useEffect(() => { refresh(); }, [pathname, refresh]);
  // How many people are waiting on whoever is acting, across events.
  const [decide, setDecide] = useState(0);
  useEffect(() => { get<{ total: number }>("/api/waiting").then((d) => setDecide(d?.total ?? 0)); }, [actor, needs?.requests.length, pathname]);
  const [waiting, setWaiting] = useState(0), [dayHas, setDayHas] = useState(false), [speaks, setSpeaks] = useState(false), [kits, setKits] = useState(0);
  useEffect(() => { get<{ replies: unknown[]; meetings: unknown[]; captures: unknown[]; notes?: unknown[] }>(`/api/motion/my-day?rep=${encodeURIComponent(actor)}`).then((d) => { setWaiting((d?.replies.length ?? 0) + (d?.notes?.length ?? 0)); setDayHas(Boolean(d && (d.replies.length || d.meetings.length || d.captures.length || d.notes?.length))); }); }, [actor, pathname]);

  // Someone who is not a planner still reaches Speaking when a talk names them. Their kits keep My day in their menu.
  useEffect(() => {
    get<{ talks: unknown[] }>("/api/speaking").then((d) => setSpeaks(Boolean(d && d.talks.length)));
    get<{ offers: { person: string }[] }>("/api/kit/offers").then((d) => setKits((d?.offers ?? []).filter((o) => o.person === actor).length));
  }, [actor, pathname]);

  const search = new URLSearchParams(beforeHash.split("?")[1] ?? "");
  const eventId = pathname.match(/^\/event\/([^/]+)/)?.[1];
  const place = placeOf(pathname);
  const count = needs?.approvals.length ?? 0;
  // Seats is where leadership decides seat requests; GTM Engineering sees the same queue. Reps follow their own requests on My day.
  // Budget and Usage are company spend: leadership's and GTM Engineering's, not an SDR's day.
  setDemoCalendar(Boolean(demo));
  setSampleTools(Boolean(demo));
  const approver = Boolean(needs?.approvers.includes(actor)), lead = approver || isGtm(actor);
  // My day is the rep's page: replies, meetings, people met. Leadership's day is the seat queue on Overview and Seats, so an empty My day stays out of their menu.
  const plans = lead || Boolean(needs?.planners.includes(actor));
  const planner = plannerAccess(needs, actor, lead);
  const showDay = !lead || dayHas || kits > 0;
  const showSpeaking = plans || speaks;
  const navAt = ["overview", ...(showDay ? ["myday"] : []), ...(plans ? ["seatdecisions"] : []), "events", ...(plans ? ["choosing"] : []), ...(lead ? ["seats"] : []), ...(lead ? ["budget"] : []), ...(plans ? ["results"] : []), ...(showSpeaking ? ["speaking"] : []), ...(lead ? ["usage"] : [])].indexOf(place);

  const item = (to: string, p: Place, label: string, icon: ReactNode, cls: string, badge?: number) => (
    <Link to={to} go={go} className={cls} aria-current={place === p ? "page" : undefined}>
      <span className="ico">{icon}</span><span className="lbl">{label}</span>
      {badge ? <span className="n" aria-label={`${badge} waiting`}>{badge}</span> : null}
    </Link>
  );
  const pick = (ev: { target: { value: string } }) => { setActor(ev.target.value); rememberActor(ev.target.value); };

  return (
    <AppCtx.Provider value={{ actor, demo: Boolean(demo), sample, decisions, needs, refresh, go, toast: setNote }}>
      {demo && <DemoBar sample={sample} />}
      <div className="app">
        <nav className="side" aria-label="Events Desk">
          <div className="brand-block">
            <Link to="/" go={go} className="brand"><Mark /><span>Events Desk</span></Link>
            <div className="tagline">Event-led pipeline</div>
          </div>
          <div className="navlist" style={{ "--at": navAt } as React.CSSProperties} data-on={navAt >= 0 ? "" : undefined}>
            {item("/", "overview", "Overview", <Icon.overview />, "navitem")}
            {showDay && item("/my-day", "myday", "My day", <Icon.calendar />, "navitem", waiting)}
            {plans && item("/waiting", "seatdecisions", "Waiting on you", <Icon.seats />, "navitem", decide)}
            {item("/events", "events", "Events", <Icon.events />, "navitem")}
            {plans && item("/choosing", "choosing", "Choosing", <Icon.choosing />, "navitem")}
            {lead && item("/seats", "seats", "Seats", <Icon.seats />, "navitem", approver ? count : 0)}
            {lead && item("/budget", "budget", "Budget", <Icon.budget />, "navitem")}
            {plans && item("/results", "results", "Results", <Icon.results />, "navitem")}
            {showSpeaking && item("/speaking", "speaking", "Speaking", <Icon.speaking />, "navitem")}
            {lead && item("/usage", "usage", "Usage", <Icon.usage />, "navitem")}
          </div>
          <span className="spacer" />
          <div className="side-foot">
            <Link to="/events?request=1" go={go} className="btn line small side-cta">Request a seat</Link>
            {isGtm(actor) && item("/settings", "settings", "Settings", <Icon.settings />, "navitem")}
            <label className="acting"><PersonAvatar name={actor} size={28} /><span>Acting as</span>
              <select value={actor} onChange={pick}>{PERSONAS.map((p) => <option key={p.name} value={p.name}>{p.name}, {p.role}</option>)}</select>
            </label>
            {demo && <p className="demo-note">Real event names, simulated attendees.</p>}
          </div>
        </nav>

        <main className="main" data-screen={place}>
          <header className="phone-top">
            <Link to="/" go={go} className="brand"><Mark size={22} /><span>Events Desk</span></Link>
            <span className="spacer" />
            <select className="phone-actor" aria-label="Acting as" value={actor} onChange={pick}>{PERSONAS.map((p) => <option key={p.name} value={p.name}>{p.name}, {p.role}</option>)}</select>
          </header>
          {/* Nothing is drawn from a page until the desk has said whether it is the demo; the shell around it is already on screen. */}
          {demo === null ? <PageSkeleton /> : <Suspense fallback={<PageSkeleton />}>
          {place === "overview" && <Overview go={go} sheetId={search.get("event")} />}
          {place === "events" && <Events go={go} sheetId={search.get("event")} requesting={search.get("request") === "1"} preselect={search.get("catalog")} search={search} />}
          {place === "seats" && (lead ? <Seats go={go} search={search} requesting={search.get("request") === "1"} preselect={search.get("catalog")} /> : <p className="md-clear">Seats are for leadership and GTM Engineering.</p>)}
          {place === "seatdecisions" && (plans ? <SeatDecisions /> : <p className="md-clear">Decisions are for leadership, planners and GTM Engineering.</p>)}
          {place === "budget" && (lead ? <Budget go={go} search={search} /> : <p className="md-clear">Budget is for leadership and GTM Engineering.</p>)}
          {place === "results" && (planner === "yes" ? <Results go={go} /> : planner === "loading" ? <PageSkeleton /> : <p className="md-clear">Results are for planners, leadership and GTM Engineering.</p>)}
          {place === "choosing" && (planner === "yes" ? <Choosing go={go} /> : planner === "loading" ? <PageSkeleton /> : <p className="md-clear">Choosing is for planners, leadership and GTM Engineering.</p>)}
          {place === "speaking" && <Speaking />}
          {place === "usage" && (lead ? <Usage go={go} search={search} /> : <p className="md-clear">Usage is for leadership and GTM Engineering.</p>)}
          {/* A reply, meeting or deal opened from an event sheet opens over whichever page the sheet was on. The event page and My day draw their own. */}
          {!["event", "myday"].includes(place) && <Suspense fallback={null}><ObjectSheets /></Suspense>}
          {place === "myday" && <MyDay />}
          {place === "more" && <More go={go} showDay={approver && showDay} showSpeaking={showSpeaking} />}
          {place === "settings" && <Settings go={go} compileId={search.get("compile")} section={search.get("section")} />}
          {place === "event" && <Event key={eventId} id={eventId!} go={go} />}
          </Suspense>}
        </main>

        <nav className="tabs" aria-label="Events Desk">
          {item("/", "overview", "Overview", <Icon.overview />, "tab")}
          {item("/events", "events", "Events", <Icon.events />, "tab")}
          {lead ? item("/seats", "seats", "Seats", <Icon.seats />, "tab", approver ? count : 0) : showDay && item("/my-day", "myday", "My day", <Icon.calendar />, "tab", waiting)}
          {lead && item("/budget", "budget", "Budget", <Icon.budget />, "tab")}
          {/* More holds Usage and Settings, which are leadership's and GTM's. For anyone else it would be an empty page. */}
          {(lead || showSpeaking) && <Link to="/more" go={go} className="tab" aria-current={["more", "usage", "settings", "speaking", "choosing"].includes(place) ? "page" : undefined}><span className="ico"><Icon.more /></span><span className="lbl">More</span></Link>}
        </nav>
      </div>
      {note && <div className="toast" role="status" aria-live="polite"><span>{note}</span><button type="button" onClick={() => setNote("")} aria-label="Dismiss">&times;</button></div>}
    </AppCtx.Provider>
  );
}
