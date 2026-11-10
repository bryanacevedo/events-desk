/* The side sheet, shared by Overview and Events. It stays on the page it was opened from: the event is in
   the URL (?event=id), so a card click opens or switches it and closing returns to the same page.
   Closes on a click outside, Esc and the close control. Focus moves in, stays in, and goes back to the card. */

import { companyDisplayName as co } from "../shared/names";
import { SheetButton } from "./Patterns";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { get } from "./api";
import { Link } from "./App";
import { pickMetrics, type Debrief, type Metrics } from "./Result";
import { fromEventSheet, meetStamp } from "./Objects";
import { isGtm } from "../shared/roles";
import { StageBlock, Stages, useEvent } from "./Event";
import { useActor } from "./App";
import { EventLogo } from "./EventLogo";
import { PersonAvatar } from "./PersonAvatar";
import { city, countdown, daysTo, money, num, plural, shortDate } from "./words";
import { deliveredWords } from "./stages";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** What every side sheet does: focus moves in and stays in, Esc and a click outside close it, and focus goes back to the row that opened it.
    Anything marked data-opens-sheet switches the sheet instead of closing it. */
export function useSheet(close: () => void) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;

  // Focus in on open, back to the card on close. A click on another card switches the sheet, so it is not "outside".
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const prevRow = prev?.getAttribute("data-row") ?? null;
    // Focus goes into the sheet itself, not onto its close button: a keyboard user starts inside it (Tab reaches the close), and
    // a mouse user does not see a focus ring on the close the moment the sheet opens.
    if (ref.current) { ref.current.setAttribute("tabindex", "-1"); ref.current.focus({ preventScroll: true }); }
    document.body.classList.add("sheet-open");
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest("[data-opens-sheet]")) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const els = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length);
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("sheet-open");
      // The card may have been redrawn while the sheet was open; find it again by its id.
      const back = prev && prev.isConnected ? prev : prevRow ? document.querySelector<HTMLElement>(`[data-row="${prevRow}"]`) : null;
      back?.focus();
    };
  }, []);
  return ref;
}

/** `lens` is the page the sheet was opened from, when that page is about money: the sheet then leads with what the event cost and opens its Cost tab. */
export function SideSheet({ id, go, close, lens }: { id: string; go: (to: string) => void; close: () => void; lens?: "cost" }) {
  const ev = useEvent(id);
  const { needs } = useActor();
  const ref = useSheet(close);

  const top = (
    <div className="sheet-top">
      <span className="spacer" />
      <button className="sheet-x" type="button" data-close aria-label="Close" onClick={close}>&times;</button>
    </div>
  );
  if (ev.missing) return <aside className="sheet" ref={ref} role="dialog" aria-label="Event">{top}<p className="mute">That event does not exist.</p></aside>;
  if (!ev.data) return <aside className="sheet" ref={ref} role="dialog" aria-label="Event">{top}</aside>;

  const { event: e, list } = ev.data;
  const going = (needs?.requests ?? []).filter((r) => r.event_id === id && r.status === "approved");
  const waiting = (needs?.requests ?? []).filter((r) => r.event_id === id && r.status === "pending").length;
  const names = going.map((r) => r.requester);
  const prio = Object.fromEntries(list.priorities.map((p) => [p.priority, p.n]));
  const where = [city(e.venue), e.country && !e.venue.includes(e.country) ? e.country : ""].filter(Boolean).join(", ");
  const away = daysTo(e.starts_on);
  const done = ["closing", "scored"].includes((e as { motion?: string | null }).motion ?? "");

  // A small version of the event's own header: who it is, where it stands, the one thing to do, and a few quiet facts. The rest is a click away.
  return (
    <aside className="sheet ob-sheet" ref={ref} role="dialog" aria-label={e.name} data-sheet={id} data-kind="event">
      {top}
      <p className="ob-kind">Event</p>
      <header className="ehero mini" style={{ "--brand": e.brand_color ?? "#1F5D3F" } as CSSProperties}>
        <EventLogo name={e.name} website={e.website} size={48} />
        <div className="ehero-text">
          <h2>{e.name}</h2>
          <p className="mute">{[shortDate(e.starts_on), where].filter(Boolean).join(" · ")}</p>
        </div>
        {away >= 0 && <p className="ehero-count" aria-label={countdown(e.starts_on)}>{away === 0 ? <b>Today</b> : <><b>{away}</b><span>{away === 1 ? "day" : "days"} to go</span></>}</p>}
        <Stages e={e} approvers={needs?.approvers ?? []} cases={ev.open.length} />
      </header>

      {ev.note && !done && <p className="sheet-next">{ev.note}</p>}
      {lens === "cost"
        ? <><div className="actions"><button className="btn" type="button" onClick={() => go(`/event/${id}#cost`)}>Open the cost</button></div><CostStory id={id} done={done} /></>
        : <>
          {done
            ? <div className="actions"><button className="btn" type="button" onClick={() => go(`/event/${id}#result`)}>See the result</button></div>
            : e.stage === "delivered"
              ? e.sheet_url && <div className="actions"><SheetButton href={e.sheet_url} /></div>
              : <StageBlock ev={ev} go={go} compact />}
          <SheetStory id={id} done={done} />
        </>}

      <dl className="sheet-facts">
        {(going.length > 0 || waiting > 0) && (
          <div>
            <dt>{away < 0 ? "Went" : "Going"}</dt>
            <dd>
              {names.length > 0 && <span className="faces">{names.slice(0, 6).map((n) => <PersonAvatar key={n} name={n} size={26} />)}</span>}
              <span>{away < 0 ? plural(going.length, "person", "people") : going.length ? `${going.length} going` : "Nobody yet"}{waiting > 0 && away >= 0 ? `, ${waiting} waiting` : ""}</span>
            </dd>
          </div>
        )}
        {list.upload && <div><dt>Attendees</dt><dd>{plural(list.upload.row_count, "person", "people")}  ·  {plural(list.companies, "company", "companies")}</dd></div>}
        {e.stage === "delivered" && !e.motion?.match(/in_market|follow_up|closing|scored/) && <div><dt>People</dt><dd>{list.people.toLocaleString("en-US")}{prio.A ? `  ·  ${prio.A} A` : ""}{prio.B ? `  ·  ${prio.B} B` : ""}</dd></div>}
      </dl>

      {!done && lens !== "cost" && <button className="btn line sheet-open-full" type="button" onClick={() => go(`/event/${id}`)}>Open the full page</button>}
    </aside>
  );
}

interface SheetMotion {
  motion: string; funnel: { kept: number; sent: number; replied: number; booked: number; held: number; held_all?: number } | null;
  live_score: Metrics | null; scorecards?: { window_days: number; metrics: Metrics }[]; debriefs?: Debrief[];
  meetings: { id: string; status: string; scheduled_at: string; full_name: string | null; company: string | null }[];
}
const THEME: Record<string, string> = { pain: "Their pain", competitor: "Competitors", timing: "Timing", budget: "Budget", product_gap: "What we lack", relationship: "Relationships", general: "Also heard" };
const Go = () => <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/** What the event has done so far, in the sheet: its figures, then the things they are made of, each a tap from its own sheet.
    A finished event shows its result (money only for leadership and GTM); one in market shows its outreach and the next meetings. */
function SheetStory({ id, done }: { id: string; done: boolean }) {
  const { actor, needs, go } = useActor();
  const lead = isGtm(actor) || Boolean(needs?.approvers.includes(actor));
  const [o, setO] = useState<SheetMotion | null>(null);
  useEffect(() => { let live = true; setO(null); get<SheetMotion>(`/api/events/${id}/motion`).then((x) => { if (live) setO(x ?? null); }); return () => { live = false; }; }, [id]);
  if (!o || o.motion === "none" || !o.funnel) return null;
  const fig = (b: string, label: string) => <p key={label}><b>{b}</b><span>{label}</span></p>;

  if (done) {
    const { m } = pickMetrics(o.motion, o.live_score, o.scorecards ?? []);
    if (!m) return null;
    const deals = [...(m.influence.deals ?? [])].sort((a, b) => b.amount_cents - a.amount_cents);
    const ratio = m.roi.pipeline_per_dollar;
    const facts = (o.debriefs ?? []).filter((d) => d.status === "accepted" || lead).flatMap((d) => d.facts).slice(0, 2);
    return (
      <>
        <div className="md-figs ob-figs sheet-figs">
          {lead && m.influence.available
            ? [fig(ratio === null ? "None" : `${ratio.toFixed(1)}x`, "per dollar"), fig(money(m.influence.pipeline_cents), "pipeline"), fig(money(m.cost.dollars_cents), "cost"), fig(num(m.held_all), m.held_all === 1 ? "meeting held" : "meetings held")]
            : [fig(num(m.held_all), m.held_all === 1 ? "meeting held" : "meetings held"), fig(num(m.funnel.replied), m.funnel.replied === 1 ? "reply" : "replies"), fig(num(m.funnel.sent), "reached")]}
        </div>
        {lead && deals.length > 0 && (
          <section className="sheet-sec">
            <h3>The deals<span>{deals.length}</span></h3>
            <ul className="ob-tray">{deals.slice(0, 3).map((d, i) => (
              <li key={d.opportunity_id} style={{ "--i": i } as CSSProperties}>
                <Link to={fromEventSheet("deal", `${id}|${d.opportunity_id}`, id)} go={go} className="ob-row sheet-row" data-opens-sheet="">
                  <span className="ob-face"><EventLogo name={d.account ? co(d.account) : "Account"} website={d.domain ? `https://${d.domain}` : null} size={32} /></span>
                  <span className="ob-who"><b>{d.account ? co(d.account) : "An account"}</b><span>{d.won ? "Won" : d.kind === "sourced" ? "New pipeline" : "Moved forward"}</span></span>
                  <span className="sheet-amt">{money(d.amount_cents)}<Go /></span>
                </Link>
              </li>
            ))}</ul>
            {deals.length > 3 && <Link to={`/event/${id}#result`} go={go} className="ob-link sheet-more"><span className="ob-link-k">The rest</span><span>{deals.length - 3} more</span><span className="ob-link-s">See all {deals.length}<Go /></span></Link>}
          </section>
        )}
        {facts.length > 0 && (
          <section className="sheet-sec">
            <h3>What we learned</h3>
            <div className="sheet-learned">{facts.map((f, i) => <p key={i}><span>{THEME[f.theme] ?? f.theme}</span>{f.fact}</p>)}</div>
          </section>
        )}
      </>
    );
  }

  const f = o.funnel;
  const now = Date.now();
  const next = o.meetings.filter((x) => ["booked", "rescheduled"].includes(x.status) && new Date(x.scheduled_at).getTime() >= now).sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  const booked = o.meetings.filter((x) => ["booked", "rescheduled", "held", "no_show"].includes(x.status)).length;
  return (
    <>
      <div className="md-figs ob-figs sheet-figs">
        {[fig(num(f.sent), "reached"), fig(num(f.replied), f.replied === 1 ? "reply" : "replies"), fig(num(booked), "booked"), fig(num(f.held_all ?? f.held), "held")]}
      </div>
      {next.length > 0 && (
        <section className="sheet-sec">
          <h3>Coming up<span>{next.length}</span></h3>
          <ul className="ob-tray">{next.slice(0, 3).map((x, i) => (
            <li key={x.id} style={{ "--i": i } as CSSProperties}>
              <Link to={fromEventSheet("meeting", x.id, id)} go={go} className="ob-row sheet-row" data-opens-sheet="">
                <span className="ob-face"><PersonAvatar name={x.full_name ?? "Someone"} size={32} /></span>
                <span className="ob-who"><b>{x.full_name ?? "Someone"}</b><span>{x.company ? co(x.company) : ""}</span></span>
                <span className="sheet-amt sheet-when">{meetStamp(x.scheduled_at, (x as { timezone?: string | null }).timezone)}<Go /></span>
              </Link>
            </li>
          ))}</ul>
        </section>
      )}
    </>
  );
}

interface SheetCost { total_cents: number; tickets_cents: number; travel_cents: number; other_cents: number; ai_cents: number; missing: string[]; owed_cents: number; owed_seats: number }

/** The event's cost in the sheet, opened from Budget or Usage: what it has spent and on what, and what is still to enter. Leadership's and GTM's. */
function CostStory({ id, done }: { id: string; done: boolean }) {
  const [c, setC] = useState<SheetCost | null>(null);
  useEffect(() => { let live = true; setC(null); get<SheetCost>(`/api/events/${id}/cost`).then((x) => { if (live) setC(x ?? null); }); return () => { live = false; }; }, [id]);
  if (!c) return null;
  const fig = (b: string, label: string) => <p key={label}><b>{b}</b><span>{label}</span></p>;
  return (
    <div className="md-figs ob-figs sheet-figs">
      {fig(money(c.total_cents), done ? "spent" : "spent so far")}
      {fig(money(c.tickets_cents), "tickets")}
      {c.travel_cents > 0 && fig(money(c.travel_cents), "travel")}
      {c.other_cents > 0 && fig(money(c.other_cents), "event costs")}
      {c.missing.length > 0 && fig(String(c.missing.length), c.missing.length === 1 ? "line to enter" : "lines to enter")}
    </div>
  );
}
