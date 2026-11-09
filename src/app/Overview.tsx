/* The home for someone running events all year. A plain title, then the rail: one card per event
   in date order, opened at today, the past one move to the left. Under it, what is at risk,
   seats waiting, and the outreach lists delivered lately. */

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { EventRow } from "../shared/domain";
import { get, type DeliveredLately } from "./api";
import { Link, useActor } from "./App";
import { EventLogo } from "./EventLogo";
import { Chevron, SheetButton, ShowMore } from "./Patterns";
import { SideSheet } from "./SideSheet";
import { stepAt, type NeedItem } from "./waiting";
import { city, daysTo, plural, shortDate, todayYmd } from "./words";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthKey = (ymd: string) => ymd.slice(0, 7);
const monthLabel = (ymd: string) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;
const DELIVERED_SHOWN = 5;

/** One state per card: its words and a tone. */
function cardState(e: EventRow, today: string): { words: string; tone: "ok" | "wait" | "run" | "off" } {
  const past = e.starts_on.slice(0, 10) < today;
  switch (e.stage) {
    case "requested": return { words: "Waiting on seats", tone: "wait" };
    case "approved": return { words: "No attendee list yet", tone: "wait" };
    case "mapped": return { words: "Attendees in", tone: "wait" };
    case "quoted": return { words: "Ready to run", tone: "wait" };
    case "paused": return { words: "Paused", tone: "wait" };
    case "ready_for_review": return { words: "Cases to settle", tone: "wait" };
    case "tiering": case "enriching": case "flagging": case "researching": case "finding_people": return { words: "Running", tone: "run" };
    case "delivered": return { words: "Outreach list ready", tone: "ok" };
    case "declined": return { words: "Ended", tone: "off" };
  }
}

/** Five steps from seats to outreach ready, as one track. The step an event is on carries the color. */
function Track({ e, tone, cases }: { e: EventRow; tone: string; cases: number }) {
  const done = stepAt(e, cases);
  return (
    <span className={`c-track ${tone}`} role="img" aria-label={`${done} of 5 steps done`}>
      {[0, 1, 2, 3, 4].map((s) => <i key={s} style={{ "--s": s } as CSSProperties} className={s < done ? "on" : s === done && tone !== "off" ? "now" : ""} />)}
    </span>
  );
}

/** What a row at risk puts on its right edge: how many conflicts, or how long until the doors open. */
function riskSide(i: NeedItem, e?: EventRow): { text: string; soon: boolean } {
  if (i.kind === "case") return { text: plural(i.caseCount ?? 0, "conflict"), soon: false };
  if (!e) return { text: "", soon: false };
  const n = daysTo(e.starts_on);
  if (n === 0) return { text: "Today", soon: true };
  if (n < 0) return { text: `${plural(-n, "day")} ago`, soon: false };
  return { text: `in ${plural(n, "day")}`, soon: n <= 14 };
}

/** At-risk groups, most urgent kind first; items inside each are already sorted soonest first. */
const GROUPS: [string, (i: NeedItem) => boolean][] = [
  ["No attendee list", (i) => i.kind === "soon" || (i.kind === "step" && i.fix === "Add the attendee list")],
  ["Paused", (i) => i.kind === "paused"],
  ["Conflicts to settle", (i) => i.kind === "case"],
  ["Ready to run", (i) => i.kind === "step" && i.fix === "Review cost and run"],
  ["Cost card not asked for", (i) => i.kind === "step" && i.fix === "Ask for the card"],
];

/** The card leans toward the mouse and a soft light follows it. Mouse only; touch and reduced motion stay still. */
function tilt(ev: PointerEvent<HTMLDivElement>) {
  if (ev.pointerType !== "mouse" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = (ev.target as HTMLElement).closest<HTMLElement>(".card");
  if (!c) return;
  const r = c.getBoundingClientRect();
  const x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
  c.style.setProperty("--ry", `${((x - 0.5) * 9).toFixed(2)}deg`);
  c.style.setProperty("--rx", `${((0.5 - y) * 7).toFixed(2)}deg`);
  c.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
  c.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
}
function untilt(ev: PointerEvent<HTMLDivElement>) {
  const c = (ev.target as HTMLElement).closest<HTMLElement>(".card");
  if (!c || c.contains(ev.relatedTarget as Node | null)) return;
  c.style.removeProperty("--ry");
  c.style.removeProperty("--rx");
}

export function Overview({ go, sheetId }: { go: (to: string) => void; sheetId: string | null }) {
  const { needs } = useActor();
  const [lately, setLately] = useState<DeliveredLately[] | null>(null);
  const rail = useRef<HTMLDivElement>(null);
  const todayMark = useRef<HTMLDivElement>(null);
  useEffect(() => { get<{ delivered: DeliveredLately[] }>("/api/overview").then((j) => setLately(j?.delivered ?? [])); }, [needs]);
  // Open on today: the first upcoming card sits at the left edge, the past is one move left.
  useEffect(() => {
    const r = rail.current, m = todayMark.current;
    const slot = m?.parentElement as HTMLElement | null;
    if (r && slot) r.scrollLeft = Math.max(0, slot.offsetLeft - 18);
  }, [needs]);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  if (!needs) return null;

  const today = todayYmd();
  const all = [...needs.events].sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.name.localeCompare(b.name));
  const byId = new Map(all.map((e) => [e.id, e]));
  const firstUpcoming = all.findIndex((e) => e.starts_on.slice(0, 10) >= today);
  const seatsWaiting = needs.approvals.filter((a) => a.kind === "seats");
  const waitingLogos = [...new Map(needs.requests.filter((r) => r.status === "pending").map((r) => [r.event_id, r])).values()].slice(0, 5);

  const step = (dir: 1 | -1) => { const r = rail.current; if (r) r.scrollBy({ left: dir * Math.round(r.clientWidth * 0.8), behavior: "smooth" }); };
  const onKey = (ev: React.KeyboardEvent) => { if (ev.key === "ArrowRight") { ev.preventDefault(); step(1); } if (ev.key === "ArrowLeft") { ev.preventDefault(); step(-1); } };

  const deliveredAll = openGroups.delivered;
  const deliveredShown = deliveredAll ? lately : lately?.slice(0, DELIVERED_SHOWN);

  return (
    <>
      <header className="hero" data-ready="1">
        <div>
          <h1>Overview</h1>
        </div>
        <span className="spacer" />
        <div className="rail-arrows" aria-hidden="true">
          <button type="button" className="arrow" onClick={() => step(-1)} aria-label="Earlier events">←</button>
          <button type="button" className="arrow" onClick={() => step(1)} aria-label="Later events">→</button>
        </div>
      </header>

      <section className="railwrap" aria-label="Events in date order">
        <div className="rail" ref={rail} tabIndex={0} onKeyDown={onKey} onPointerMove={tilt} onPointerOut={untilt} aria-label="Events, left is earlier, right is later">
          {all.map((e, i) => {
            const s = cardState(e, today);
            const monthStart = i === 0 || monthKey(all[i - 1].starts_on) !== monthKey(e.starts_on);
            const past = e.starts_on.slice(0, 10) < today;
            const d = new Date(`${e.starts_on.slice(0, 10)}T12:00:00`);
            const name = e.name.replace(/\s+20\d\d$/, "");
            const c = city(e.venue);
            const going = e.stage === "requested" ? `${e.seat_count} waiting` : `${e.seat_count} going`;
            const where = [c && !name.includes(c) ? c : "", going].filter(Boolean).join(" · ");
            const order = firstUpcoming === -1 ? 0 : Math.min(9, Math.max(0, i - firstUpcoming));
            return (
              <div className="slot" key={e.id} style={{ "--i": order } as CSSProperties}>
                <p className="c-month">{monthStart ? monthLabel(e.starts_on) : " "}</p>
                {i === firstUpcoming && <div className="c-today" ref={todayMark}><span>Today</span></div>}
                <Link to={`/?event=${e.id}`} go={go} data-opens-sheet="" data-row={e.id} title={e.name} style={{ "--brand": e.brand_color ?? "#1F5D3F" } as CSSProperties} className={`card ${s.tone}${past ? " past" : ""}${sheetId === e.id ? " open" : ""}`}>
                  <span className="c-band">
                    <span className="c-day"><b>{d.getDate()}</b><span>{d.toLocaleDateString("en-GB", { month: "short" })}<br />{d.toLocaleDateString("en-GB", { weekday: "short" })}</span></span>
                    <EventLogo name={e.name} website={e.website} size={38} />
                  </span>
                  <span className="c-body">
                    <span className="c-name">{name}</span>
                    <span className="c-where">{where}</span>
                    <span className="c-state">{s.words}<svg className="c-go" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8h9.5M8.5 4l4 4-4 4" /></svg></span>
                    <Track e={e} tone={s.tone} cases={needs.items.find((n) => n.kind === "case" && n.eventId === e.id)?.caseCount ?? 0} />
                  </span>
                </Link>
              </div>
            );
          })}
          {firstUpcoming === -1 && <div className="c-today end" ref={todayMark}><span>Today</span></div>}
          {!all.length && <p className="mute">No events yet. <Link to="/events?request=1" go={go} className="u">Request seats</Link> to start one.</p>}
        </div>
      </section>

      <div className="ov-cols">
        <section className="ov" aria-label="At risk">
          <div className="ov-h"><h2 className="display">At risk</h2>{needs.items.length > 0 && <span>{needs.items.length}</span>}</div>
          {needs.items.length ? GROUPS.map(([title, test]) => {
            const items = needs.items.filter(test);
            if (!items.length) return null;
            const open = openGroups[title];
            const shown = open ? items : items.slice(0, 3);
            return (
              <div className="tray" key={title}>
                <h3><b>{title}</b><span>{items.length}</span></h3>
                {shown.map((i) => {
                  const e = byId.get(i.eventId);
                  const side = riskSide(i, e);
                  return (
                    <Link to={`/event/${i.eventId}`} go={go} className="risk" key={i.id}>
                      <EventLogo name={i.eventName} website={e?.website} size={34} />
                      <span className="who-text"><b>{i.eventName}</b>{e && <span className="small mute">{[shortDate(e.starts_on), city(e.venue)].filter(Boolean).join(" · ")}</span>}</span>
                      <span className="risk-end">
                        <span className={`risk-when${side.soon ? " soon" : ""}`}>{side.text}</span>
                        <span className="risk-go">{i.fix}<Chevron right /></span>
                      </span>
                    </Link>
                  );
                })}
                {items.length > 3 && <ShowMore open={Boolean(open)} n={items.length} onClick={() => setOpenGroups({ ...openGroups, [title]: !open })} />}
              </div>
            );
          }) : <p className="mute tray-empty">Nothing at risk.</p>}
        </section>

        <div className="ov-right">
          {seatsWaiting.length > 0
            ? (
              <Link to="/seats" go={go} className="seatcall" aria-label={`${plural(seatsWaiting.length, "seat request")} waiting. Open Seats`}>
                <b>{seatsWaiting.length}</b>
                <span className="seatcall-w">seat {seatsWaiting.length === 1 ? "request" : "requests"}<br />waiting</span>
                <span className="seatcall-logos" aria-hidden="true">{waitingLogos.map((r) => <EventLogo key={r.event_id} name={r.name} website={r.website} size={36} />)}</span>
                <span className="seatcall-go" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h9.5M8.5 4l4 4-4 4" /></svg></span>
              </Link>
            )
            : <p className="mute tray-empty">No seat requests waiting.</p>}

          <section className="ov" aria-label="Outreach lists delivered">
            <div className="ov-h"><h2 className="display">Outreach lists delivered</h2>{lately && lately.length > 0 && <span>{lately.length}</span>}</div>
            {lately === null ? null : lately.length ? (
              <div className="tray">
                <ul className="lately">
                  {deliveredShown!.map((d) => (
                    <li key={d.id}>
                      <EventLogo name={d.name} website={d.website} size={34} />
                      <div className="who-text"><p className="name"><Link to={`/event/${d.id}`} go={go}>{d.name}</Link></p><p className="small mute">{[shortDate(d.starts_on), city(d.venue)].filter(Boolean).join(" · ")}</p></div>
                      <p className="abc" aria-label={`${d.a} priority A, ${d.b} priority B, ${d.c} priority C`}>
                        <span className={`a${d.a ? "" : " zero"}`}><i>A</i>{d.a}</span><span className={`b${d.b ? "" : " zero"}`}><i>B</i>{d.b}</span><span className={`c${d.c ? "" : " zero"}`}><i>C</i>{d.c}</span>
                      </p>
                      {d.sheet_url ? <SheetButton href={d.sheet_url} compact label={`Open the outreach sheet for ${d.name}`} /> : <span className="small mute">No sheet</span>}
                    </li>
                  ))}
                </ul>
                {lately.length > DELIVERED_SHOWN && <ShowMore open={Boolean(deliveredAll)} n={lately.length} onClick={() => setOpenGroups({ ...openGroups, delivered: !deliveredAll })} />}
              </div>
            ) : <p className="mute tray-empty">None yet.</p>}
          </section>
        </div>
      </div>
      {sheetId && <SideSheet id={sheetId} go={go} close={() => go("/")} />}
    </>
  );
}
