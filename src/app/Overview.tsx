/* The home for someone running events all year. It answers three things across every event: where each one is (the rail, one card per event in date order,
   opened at today), what needs someone (replies and follow-ups first, then the list's own risks), and whether it is working (outreach, and what it paid). */

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { EventRow } from "../shared/domain";
import { get, send, type DeadlineRow, type LiveRow, type OutreachNeed, type ResultRow, type YearPlanRead } from "./api";
import { Link, useActor } from "./App";
import { EventLogo } from "./EventLogo";
import { Chevron, SheetButton, ShowMore } from "./Patterns";
import { SideSheet } from "./SideSheet";
import { stepAt, type NeedItem } from "./waiting";
import { city, daysTo, money, num, plural, shortDate, todayYmd } from "./words";
import { AFTER, afterStep, deliveredWords } from "./stages";
import { isGtm } from "../shared/roles";
import { DEFAULT_OVERVIEW_VIEW, type OverviewView } from "../server/view-prefs";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthKey = (ymd: string) => ymd.slice(0, 7);
const monthLabel = (ymd: string) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;

/** One state per card: its words and a tone. */
function cardState(e: EventRow, today: string): { words: string; tone: "ok" | "wait" | "run" | "off" } {
  const past = e.starts_on.slice(0, 10) < today;
  switch (e.stage) {
    case "requested": return { words: "Waiting on seats", tone: "wait" };
    case "approved": return { words: e.hosted_format ? "Guest list" : "No attendee list yet", tone: "wait" };
    case "mapped": return { words: "Attendees in", tone: "wait" };
    case "quoted": return { words: "Ready to run", tone: "wait" };
    case "paused": return { words: "Paused", tone: "wait" };
    case "ready_for_review": return { words: "Cases to settle", tone: "wait" };
    case "tiering": case "enriching": case "flagging": case "researching": case "finding_people": return { words: "Running", tone: "run" };
    case "delivered": { const w = deliveredWords(e); return { words: w.words, tone: w.waiting ? "wait" : "ok" }; }
    case "declined": return { words: "Ended", tone: "off" };
  }
}

/** The event's track, as on its header: five steps from seats to the list, then the steps after delivery. The step an event is on carries the color. */
function Track({ e, tone, cases }: { e: EventRow; tone: string; cases: number }) {
  const after = e.stage === "delivered";
  const steps = after ? AFTER.length : 5;
  const done = after ? Math.max(0, AFTER.findIndex(([k]) => k === afterStep(e).key)) + (e.motion === "scored" ? 1 : 0) : stepAt(e, cases);
  return (
    <span className={`c-track ${tone}`} role="img" aria-label={`${done} of ${steps} steps done`}>
      {Array.from({ length: steps }, (_, s) => s).map((s) => <i key={s} style={{ "--s": s } as CSSProperties} className={s < done ? "on" : s === done && tone !== "off" ? "now" : ""} />)}
    </span>
  );
}

/** What a row at risk puts on its right edge: how many cases, or how long until the doors open. */
function riskSide(i: NeedItem, e?: EventRow): { text: string; soon: boolean } {
  if (i.kind === "case") return { text: plural(i.caseCount ?? 0, "case"), soon: false };
  if (!e) return { text: "", soon: false };
  const n = daysTo(e.starts_on);
  if (n === 0) return { text: "Today", soon: true };
  if (n < 0) return { text: `${plural(-n, "day")} ago`, soon: false };
  return { text: `in ${plural(n, "day")}`, soon: n <= 14 };
}

/** After delivery, what needs someone: a reply goes cold fastest, then the follow-up's window, then sending that stopped, then meetings nobody recorded. */
const NEED_GROUPS: [OutreachNeed["kind"], string, string][] = [["replies", "Replies waiting on a rep", "Answer"], ["follow_up", "Follow-up ready", "Start"], ["paused", "Sequences paused", "See why"], ["meetings", "Meetings to record", "Record"], ["costs", "Costs to enter", "Enter"]];

function needSide(i: OutreachNeed): { text: string; soon: boolean } {
  if (i.kind === "replies") return i.overdue ? { text: `${i.overdue} late`, soon: true } : { text: plural(i.n, "reply", "replies"), soon: false };
  if (i.kind === "follow_up") return { text: i.detail ? `until ${shortDate(i.detail.replace("until ", ""))}` : "Ready", soon: true };
  if (i.kind === "paused") return { text: plural(i.n, "paused", "paused"), soon: false };
  if (i.kind === "costs") return { text: plural(i.n, "line"), soon: false };
  return { text: plural(i.n, "meeting"), soon: false };
}

/** At-risk groups, most urgent kind first; items inside each are already sorted soonest first. */
const GROUPS: [string, (i: NeedItem) => boolean][] = [
  ["No attendee list", (i) => i.kind === "soon" || (i.kind === "step" && i.fix === "Add the attendee list")],
  ["Paused", (i) => i.kind === "paused"],
  ["Events with cases to settle", (i) => i.kind === "case"],
  ["Ready to run", (i) => i.kind === "step" && i.fix === "Review and run"],
  ["Not priced yet", (i) => i.kind === "step" && i.fix === "Price it"],
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

const GROUP_WORDS: Record<DeadlineRow["group"], string> = { late: "Late", today: "Today", week: "This week" };
const goWords = (g: { meetings_held: number | null; accounts_met: number | null }) => [g.meetings_held !== null ? plural(g.meetings_held, "meeting") : "", g.accounts_met !== null ? plural(g.accounts_met, "account") : ""].filter(Boolean).join(", ") || "No goal was set";
const day = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Layout A, "Ledger": the week as a full-width hairline ledger grouped Late, Today, This week. Status is the due word in ink. */
function WeekA({ rows, go, logos }: { rows: DeadlineRow[]; go: (to: string) => void; logos: Map<string, string | null> }) {
  return (
    <section className="ov" aria-label="This week">
      <div className="ov-h"><h2 className="display">This week</h2>{rows.length > 0 && <span>{rows.length}</span>}</div>
      {rows.length === 0 ? <p className="mute tray-empty">Nothing is due this week.</p> : (
        <div className="led">
          {(["late", "today", "week"] as const).map((g) => {
            const mine = rows.filter((r) => r.group === g);
            if (!mine.length) return null;
            return (
              <div className={`led-g ${g}`} key={g}>
                <h3 className="led-gh">{GROUP_WORDS[g]}<span>{mine.length}</span></h3>
                <div className="led-rows">
                  {mine.map((r) => (
                    <Link to={`/event/${r.event_id}`} go={go} className="led-r" key={`${r.kind}:${r.ref_id}`} data-row={`${r.kind}:${r.ref_id}`}>
                      <span className="what">{r.label}</span>
                      <span className="meta"><span className="ev"><EventLogo name={r.event_name} website={logos.get(r.event_id)} size={24} /><em>{r.event_name}</em></span><span className="own">{r.owner}</span></span>
                      <span className="swap"><span className="due">{r.due_words}</span><span className="go">Open<Chevron right /></span></span>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Layout A: one table, events in date order with a Today rule and, for leadership and planners, a total row. A rep's read has no money keys, so no money columns are drawn. */
function YearA({ year, go, logos }: { year: YearPlanRead; go: (to: string) => void; logos: Map<string, string | null> }) {
  const lead = year.total_planned_cents !== undefined;
  const ids = new Set(year.events.map((e) => e.event_id));
  const firstUpcoming = year.events.findIndex((e) => e.starts_on.slice(0, 10) >= year.today);
  const amount = (c: number | undefined, none = false) => (c === undefined ? null : none && c === 0 ? <>none</> : <><i>$</i>{(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}</>);
  return (
    <section className="ov" aria-label="The year">
      <div className="ov-h"><h2 className="display">The year</h2><span>{year.year}</span></div>
      {year.events.length === 0 ? <p className="mute tray-empty">No events this year.</p> : (
        <div className={`yr${lead ? "" : " norep"}`}>
          <div className="yr-h"><span /><span>Event</span><span>Taking part</span><span>Stage</span><span className="g">Goal</span>{lead && <><span className="m">Planned</span><span className="m">Contracted</span><span className="m">Actual</span></>}</div>
          {year.events.map((e, i) => {
            const past = e.starts_on.slice(0, 10) < year.today;
            const under = Boolean(e.conference_event_id && ids.has(e.conference_event_id));
            return (
              <div key={e.event_id}>
                {i === firstUpcoming && i > 0 && <div className="yr-now"><span>Today</span></div>}
                <Link to={`/event/${e.event_id}`} go={go} className={`yr-r${past ? " past" : ""}${under ? " under" : ""}`} data-row={e.event_id}>
                  <span className="date">{day(e.starts_on)}{e.involvement_words && <span className="lbl"> · {e.involvement_words}</span>}</span>
                  <span className="ev"><EventLogo name={e.name} website={logos.get(e.event_id)} size={28} /><em>{e.name}</em></span>
                  <span className="inv">{e.involvement_words}</span>
                  <span className={`stage${e.plan_stage === "judged" ? " done" : ""}`}>{e.plan_stage_label}</span>
                  <span className={`goal${e.goal.meetings_held === null && e.goal.accounts_met === null ? " none" : ""}`}>{goWords(e.goal)}</span>
                  {lead && <span className="money">
                    <span className="m"><span className="lbl">Planned</span>{amount(e.planned_cents, true)}</span>
                    <span className="m"><span className="lbl">Contracted</span>{amount(e.contracted_cents, true)}</span>
                    <span className="m"><span className="lbl">Actual</span>{amount(e.actual_cents)}</span>
                  </span>}
                </Link>
              </div>
            );
          })}
          {firstUpcoming === -1 && <div className="yr-now"><span>Today</span></div>}
          {lead && <div className="yr-t"><span className="date" /><span className="t">Year total</span><span className="money">
            <span className="m"><span className="lbl">Planned</span>{amount(year.total_planned_cents)}</span>
            <span className="m"><span className="lbl">Contracted</span>{amount(year.total_contracted_cents)}</span>
            <span className="m"><span className="lbl">Actual</span>{amount(year.total_actual_cents)}</span>
          </span></div>}
        </div>
      )}
    </section>
  );
}

/* ---- Layouts B and C. The same rows as A (docs/OVERVIEW-VIEWS.md): only the shape changes. Reviewed as directions in events-desk-review/step1/overview-directions. ---- */

const QUARTERS = ["January to March", "April to June", "July to September", "October to December"];
const amountOf = (c: number | undefined, none = false) => (c === undefined ? null : none && c === 0 ? <>none</> : <><i>$</i>{(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}</>);
const dayWords = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric" });
const addDays = (ymd: string, n: number) => { const d = new Date(`${ymd.slice(0, 10)}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayOfYear = (ymd: string) => Math.round((Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) - Date.UTC(+ymd.slice(0, 4), 0, 1)) / 86400000);
const yearDays = (y: number) => (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86400000;
const pct = (n: number) => `${(Math.max(0, Math.min(100, n))).toFixed(2)}%`;
const sideLine = (e: YearPlanRead["events"][number]) => [day(e.starts_on), e.involvement_words ? `${e.involvement_words}${e.conference_name ? ` with ${e.conference_name}` : ""}` : ""].filter(Boolean).join(" · ");

function Moneys({ e, total }: { e: { planned_cents?: number; contracted_cents?: number; actual_cents?: number }; total?: boolean }) {
  if (e.planned_cents === undefined && e.contracted_cents === undefined && e.actual_cents === undefined) return null;
  const none = !total;
  return (
    <span className="money">
      <span className={`m${none && e.planned_cents === 0 ? " none" : ""}`}><span className="lbl">Planned</span>{amountOf(e.planned_cents, none)}</span>
      <span className={`m${none && e.contracted_cents === 0 ? " none" : ""}`}><span className="lbl">Contracted</span>{amountOf(e.contracted_cents, none)}</span>
      <span className="m"><span className="lbl">Actual</span>{amountOf(e.actual_cents)}</span>
    </span>
  );
}

/** Layout B, "Trays": the week as trays of white rows side by side, the year as one tray per quarter. */
function WeekB({ rows, go, logos }: { rows: DeadlineRow[]; go: (to: string) => void; logos: Map<string, string | null> }) {
  const tray = (g: DeadlineRow["group"]) => {
    const mine = rows.filter((r) => r.group === g);
    if (!mine.length) return null;
    return (
      <div className={`tray ${g}`} key={g}>
        <h3><b>{GROUP_WORDS[g]}</b><span>{mine.length}</span></h3>
        {mine.map((r) => (
          <Link to={`/event/${r.event_id}`} go={go} className="wk-r" key={`${r.kind}:${r.ref_id}`} data-row={`${r.kind}:${r.ref_id}`}>
            <EventLogo name={r.event_name} website={logos.get(r.event_id)} size={34} />
            <span className="who-text"><b>{r.label}</b><span className="small mute">{[r.event_name, r.owner].filter(Boolean).join(" · ")}</span></span>
            <span className="swap"><span className="due">{r.due_words}</span><span className="go">Open<Chevron right /></span></span>
          </Link>
        ))}
      </div>
    );
  };
  return (
    <section className="ov ovb" aria-label="This week">
      <div className="ov-h"><h2 className="display">This week</h2>{rows.length > 0 && <span>{rows.length}</span>}</div>
      {rows.length === 0 ? <p className="mute tray-empty">Nothing is due this week.</p> : (
        <div className="wk-cols">
          <div className="wk-col">{tray("late")}{tray("today")}</div>
          <div className="wk-col">{tray("week")}</div>
        </div>
      )}
    </section>
  );
}

function YearB({ year, go, logos }: { year: YearPlanRead; go: (to: string) => void; logos: Map<string, string | null> }) {
  const lead = year.total_planned_cents !== undefined;
  const quarters = [0, 1, 2, 3].map((q) => year.events.filter((e) => Math.floor((Number(e.starts_on.slice(5, 7)) - 1) / 3) === q));
  return (
    <section className={`ov ovb${lead ? "" : " norep"}`} aria-label="The year">
      <div className="ov-h"><h2 className="display">The year</h2><span>{year.year}</span></div>
      {year.events.length === 0 ? <p className="mute tray-empty">No events this year.</p> : (
        <div className="yb">
          {lead && <div className="yb-h"><span className="sp" /><span className="m">Planned</span><span className="m">Contracted</span><span className="m">Actual</span></div>}
          {quarters.map((rows, q) => !rows.length ? null : (
            <div className="tray" key={q}>
              <h3><b>{QUARTERS[q]}</b><span>{rows.length}</span></h3>
              {rows.map((e) => (
                <Link to={`/event/${e.event_id}`} go={go} className={`yb-r${e.starts_on.slice(0, 10) < year.today ? " past" : ""}`} key={e.event_id} data-row={e.event_id}>
                  <EventLogo name={e.name} website={logos.get(e.event_id)} size={34} />
                  <span className="who-text"><b>{e.name}</b><span className="small mute">{sideLine(e)}</span></span>
                  <span className="sg"><span className={`stage${e.plan_stage === "judged" ? " done" : ""}`}>{e.plan_stage_label}</span><span className={`goal${e.goal.meetings_held === null && e.goal.accounts_met === null ? " none" : ""}`}>{goWords(e.goal)}</span></span>
                  {lead && <Moneys e={e} />}
                </Link>
              ))}
            </div>
          ))}
          {lead && <div className="yb-t"><span className="t">Year total</span><Moneys total e={{ planned_cents: year.total_planned_cents, contracted_cents: year.total_contracted_cents, actual_cents: year.total_actual_cents }} /></div>}
        </div>
      )}
    </section>
  );
}

/** Layout C, "Timeline": time is the layout. The week is a strip of days with late work held to its left; the year is a runway on a month axis. */
function WeekC({ rows, today, go }: { rows: DeadlineRow[]; today: string; go: (to: string) => void }) {
  const late = rows.filter((r) => r.group === "late");
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const by = days.map((d) => rows.filter((r) => r.group !== "late" && r.due_on.slice(0, 10) === d));
  const cols = by.map((l) => (l.length ? "minmax(0, 1fr)" : "minmax(0, 0.3fr)")).join(" ");
  return (
    <section className="ov ovt" aria-label="This week">
      <div className="ov-h"><h2 className="display">This week</h2>{rows.length > 0 && <span>{rows.length}</span>}</div>
      {rows.length === 0 ? <p className="mute tray-empty">Nothing is due this week.</p> : (
        <div className={`strip${late.length ? "" : " nolate"}`}>
          {late.length > 0 && (
            <div className="late">
              <h3 className="day-h"><b>Late</b><span className="n">{late.length}</span></h3>
              {late.map((r) => (
                <Link to={`/event/${r.event_id}`} go={go} className="wk-i" key={`${r.kind}:${r.ref_id}`} data-row={`${r.kind}:${r.ref_id}`}><b>{r.label}</b><span className="due">{r.due_words}</span><span className="sub">{[r.event_name, r.owner].filter(Boolean).join(" · ")}</span></Link>
              ))}
            </div>
          )}
          <div className="days" style={{ "--days": cols } as CSSProperties}>
            {days.map((d, i) => (
              <div className={`day${i === 0 ? " today" : ""}${by[i].length ? "" : " quiet"}`} key={d}>
                <h3 className="day-h">{i === 0 ? <><b>Today</b><span className="n">{dayWords(d)}</span></> : <span>{dayWords(d)}</span>}</h3>
                <div className="items">
                  {by[i].map((r) => (
                    <Link to={`/event/${r.event_id}`} go={go} className="wk-i" key={`${r.kind}:${r.ref_id}`} data-row={`${r.kind}:${r.ref_id}`}><b>{r.label}</b><span className="sub"><span>{r.event_name}</span>{r.owner && <><i> · </i><span>{r.owner}</span></>}</span></Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function YearC({ year, go, logos }: { year: YearPlanRead; go: (to: string) => void; logos: Map<string, string | null> }) {
  const lead = year.total_planned_cents !== undefined;
  const total = yearDays(year.year);
  const now = dayOfYear(year.today) / total * 100;
  const firstUpcoming = year.events.findIndex((e) => e.starts_on.slice(0, 10) >= year.today);
  const ticks = Array.from({ length: 12 }, (_, m) => ({ m, left: dayOfYear(`${year.year}-${String(m + 1).padStart(2, "0")}-01`) / total * 100 }));
  return (
    <section className={`ov ovt${lead ? "" : " norep"}`} aria-label="The year">
      <div className="ov-h"><h2 className="display">The year</h2><span>{year.year}</span></div>
      {year.events.length === 0 ? <p className="mute tray-empty">No events this year.</p> : (
        <div className="ovt-run">
          <div className="ovt-run-h">
            <span /><span /><span />
            <div className="ovt-axis" aria-hidden="true">
              {ticks.map((t) => <span key={t.m} className={`tick${t.m % 3 ? " quiet" : ""}`} style={{ left: pct(t.left) }}>{t.m % 3 ? "" : MONTHS[t.m].slice(0, 3)}</span>)}
              <span className="now-tag" style={{ left: pct(now) }}>Today</span>
            </div>
            {lead && <><span className="m">Planned</span><span className="m">Contracted</span><span className="m">Actual</span></>}
          </div>
          {year.events.map((e, i) => {
            const past = e.starts_on.slice(0, 10) < year.today;
            const at = dayOfYear(e.starts_on) / total * 100;
            const endDay = e.last_day.slice(0, 4) > String(year.year) ? total - 1 : dayOfYear(e.last_day);
            const w = Math.max(0, Math.min(100 - at, (endDay - dayOfYear(e.starts_on) + 1) / total * 100));
            const newMonth = i === 0 || e.starts_on.slice(5, 7) !== year.events[i - 1].starts_on.slice(5, 7);
            return (
              <div key={e.event_id} style={{ display: "contents" }}>
                {i === firstUpcoming && i > 0 && <p className="mon now">Today</p>}
                {newMonth && <p className="mon">{MONTHS[Number(e.starts_on.slice(5, 7)) - 1]}</p>}
                <Link to={`/event/${e.event_id}`} go={go} className={`ovt-run-r${past ? " past" : ""}`} data-row={e.event_id}>
                  <EventLogo name={e.name} website={logos.get(e.event_id)} size={28} />
                  <span className="ovt-two nm"><b>{e.name}</b><span>{day(e.starts_on)}{e.involvement_words ? ` · ${e.involvement_words}` : ""}</span></span>
                  <span className="ovt-two sg"><span className={`stage${e.plan_stage === "judged" ? " done" : ""}`}>{e.plan_stage_label}</span><span className={`goal${e.goal.meetings_held === null && e.goal.accounts_met === null ? " none" : ""}`}>{goWords(e.goal)}</span></span>
                  <span className="trk" aria-hidden="true" style={{ "--at": pct(at), "--w": pct(w), "--now": pct(now) } as CSSProperties}><u /></span>
                  {lead && <Moneys e={e} />}
                </Link>
              </div>
            );
          })}
          {firstUpcoming === -1 && <p className="mon now">Today</p>}
          {lead && <div className="ovt-run-t"><span className="sp" /><span className="t">Year total</span><Moneys total e={{ planned_cents: year.total_planned_cents, contracted_cents: year.total_contracted_cents, actual_cents: year.total_actual_cents }} /></div>}
        </div>
      )}
    </section>
  );
}

const VIEWS: [OverviewView, string][] = [["a", "Ledger"], ["b", "Trays"], ["c", "Timeline"]];

export function Overview({ go, sheetId }: { go: (to: string) => void; sheetId: string | null }) {
  const { needs, actor } = useActor();
  const [ov, setOv] = useState<{ needs: OutreachNeed[]; live: LiveRow[]; results: ResultRow[]; year: YearPlanRead | null; deadlines: DeadlineRow[] } | null>(null);
  const [view, setView] = useState<OverviewView>(DEFAULT_OVERVIEW_VIEW);
  const picked = useRef(0);
  const rail = useRef<HTMLDivElement>(null);
  const todayMark = useRef<HTMLDivElement>(null);
  useEffect(() => { get<{ needs: OutreachNeed[]; live: LiveRow[]; results: ResultRow[]; year?: YearPlanRead; deadlines?: DeadlineRow[]; view?: OverviewView }>("/api/overview").then((j) => { setOv({ needs: j?.needs ?? [], live: j?.live ?? [], results: j?.results ?? [], year: j?.year ?? null, deadlines: j?.deadlines ?? [] });
    // The server's word is taken on the first load and when the person changes, never over a pick made since.
    if (j?.view && !picked.current) setView(j.view);
  }); }, [needs]);
  useEffect(() => { picked.current = 0; get<{ view?: OverviewView }>("/api/overview").then((j) => { if (j?.view && !picked.current) setView(j.view); }); }, [actor]);
  // Open on today: the first upcoming card sits at the left edge, the past is one move left.
  useEffect(() => {
    const r = rail.current, m = todayMark.current;
    const slot = m?.parentElement as HTMLElement | null;
    if (r && slot) r.scrollLeft = Math.max(0, slot.offsetLeft - 18);
  }, [needs]);
  // The choice is the person's own: it shows at once and is kept on the server under their name.
  const pick = (v: OverviewView) => {
    const n = ++picked.current, was = view;
    setView(v);
    void send("PUT", "/api/overview/view", actor, { view: v }).then((r) => { if (!r.ok && n === picked.current) setView(was); });
  };
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  if (!needs) return null;

  const today = todayYmd();
  const all = [...needs.events].sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.name.localeCompare(b.name));
  const byId = new Map(all.map((e) => [e.id, e]));
  const logos = new Map(all.map((e) => [e.id, e.website ?? null]));
  const firstUpcoming = all.findIndex((e) => e.starts_on.slice(0, 10) >= today);
  const seatsWaiting = needs.approvals.filter((a) => a.kind === "seats");
  const waitingLogos = [...new Map(needs.requests.filter((r) => r.status === "pending").map((r) => [r.event_id, r])).values()].slice(0, 5);

  const step = (dir: 1 | -1) => { const r = rail.current; if (r) r.scrollBy({ left: dir * Math.round(r.clientWidth * 0.8), behavior: "smooth" }); };
  const onKey = (ev: React.KeyboardEvent) => { if (ev.key === "ArrowRight") { ev.preventDefault(); step(1); } if (ev.key === "ArrowLeft") { ev.preventDefault(); step(-1); } };

  const outreachNeeds = ov?.needs ?? [];
  const waiting = needs.items.length + outreachNeeds.length;

  return (
    <>
      <header className="hero" data-ready="1">
        <div>
          <h1>Overview</h1>
        </div>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="Overview layout">{VIEWS.map(([v, w]) => <button key={v} type="button" aria-pressed={view === v} onClick={() => pick(v)}>{w}</button>)}</div>
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
          {!all.length && <p className="mute">No events yet. <Link to="/events?request=1" go={go} className="to">Request a seat</Link> to start one.</p>}
        </div>
      </section>

      <div className="seat-top">
          {!needs.approvers.includes(actor) ? null : seatsWaiting.length > 0
            ? (
              <Link to="/seats" go={go} className="seatcall" aria-label={`${plural(seatsWaiting.length, "seat request")} waiting. Open Seats`}>
                <b>{seatsWaiting.length}</b>
                <span className="seatcall-w">seat {seatsWaiting.length === 1 ? "request" : "requests"}<br />waiting</span>
                <span className="seatcall-logos" aria-hidden="true">{waitingLogos.map((r) => <EventLogo key={r.event_id} name={r.name} website={r.website} size={36} />)}</span>
                <span className="seatcall-go" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h9.5M8.5 4l4 4-4 4" /></svg></span>
              </Link>
            )
            : <p className="mute tray-empty">No seat requests waiting.</p>}
      </div>


      {ov && (view === "a" ? <WeekA rows={ov.deadlines} go={go} logos={logos} /> : view === "c" ? <WeekC rows={ov.deadlines} today={ov.year?.today ?? today} go={go} /> : <WeekB rows={ov.deadlines} go={go} logos={logos} />)}
      {ov?.year && (view === "a" ? <YearA year={ov.year} go={go} logos={logos} /> : view === "c" ? <YearC year={ov.year} go={go} logos={logos} /> : <YearB year={ov.year} go={go} logos={logos} />)}

      <div className="ov-cols">
        <section className="ov" aria-label="Needs someone">
          <div className="ov-h"><h2 className="display">Needs someone</h2></div>
          {NEED_GROUPS.map(([kind, title, fix]) => {
            const items = outreachNeeds.filter((n) => n.kind === kind);
            if (!items.length) return null;
            const open = openGroups[kind];
            return (
              <div className="tray" key={kind}>
                <h3><b>{title}</b>{/* Every count here is of events, like the header's; each row says how many replies, lines or meetings it holds. */}<span>{items.length}</span></h3>
                {(open ? items : items.slice(0, 3)).map((i) => {
                  const e = byId.get(i.event_id);
                  const side = needSide(i);
                  return (
                    <Link to={kind === "costs" ? `/event/${i.event_id}#cost` : kind === "replies" || kind === "meetings" || kind === "paused" ? `/event/${i.event_id}#outreach` : `/?event=${i.event_id}`} go={go} className="risk" key={`${kind}:${i.event_id}`} data-opens-sheet={["costs", "replies", "meetings", "paused"].includes(kind) ? undefined : ""} data-row={`${kind}:${i.event_id}`}>
                      <EventLogo name={i.name} website={i.website} size={34} />
                      <span className="who-text"><b>{i.name}</b>{e && <span className="small mute">{[shortDate(e.starts_on), city(e.venue)].filter(Boolean).join(" · ")}</span>}</span>
                      <span className="risk-end">
                        <span className={`risk-when${side.soon ? " soon" : ""}`}>{side.text}</span>
                        <span className="risk-go">{fix}<Chevron right /></span>
                      </span>
                    </Link>
                  );
                })}
                {items.length > 3 && <ShowMore open={Boolean(open)} n={items.length} onClick={() => setOpenGroups({ ...openGroups, [kind]: !open })} />}
              </div>
            );
          })}
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
          }) : !outreachNeeds.length && <p className="mute tray-empty">Nothing needs anyone right now.</p>}
        </section>

        <div className="ov-right">
          <section className="ov" aria-label="Outreach">
            <div className="ov-h"><h2 className="display">Outreach</h2></div>
            {ov === null ? null : ov.live.length ? (
              <div className="tray">
                <ul className="lately">
                  {ov.live.map((r) => {
                    const step = afterStep({ ...r, stage: "delivered" } as unknown as EventRow);
                    const started = r.motion !== "none";
                    return (
                      <li key={r.id} className="opens" data-opens-sheet="" onClick={(ev) => { if (!(ev.target as HTMLElement).closest("a, button")) go(`/?event=${r.id}`); }}>
                        <EventLogo name={r.name} website={r.website} size={34} />
                        <div className="who-text"><p className="name"><Link to={`/?event=${r.id}`} go={go} title={r.name} data-opens-sheet="">{r.name}</Link></p><p className="small mute">{deliveredWords({ ...r, stage: "delivered" } as unknown as EventRow).words}</p></div>
                        {started
                          ? <p className="abc" aria-label={`${r.sent} reached, ${r.replied} replies, ${r.held} meetings held`}><span className={r.sent ? "" : "zero"}><i>reached</i>{num(r.sent)}</span><span className={r.replied ? "" : "zero"}><i>replies</i>{num(r.replied)}</span><span className={`a${r.held ? "" : " zero"}`}><i>meetings</i>{num(r.held)}</span></p>
                          : <p className="abc"><span><i>to reach</i>{num(r.kept)}</span></p>}
                        {!started && r.sheet_url ? <SheetButton href={r.sheet_url} compact label={`Open the outreach sheet for ${r.name}`} /> : <span />}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : <p className="mute tray-empty">No lists delivered yet.</p>}
          </section>

          {ov && ov.results.length > 0 && (needs.approvers.includes(actor) || isGtm(actor)) && (
            <section className="ov" aria-label="Pipeline per dollar">
              <div className="ov-h"><h2 className="display">Pipeline per dollar</h2></div>
              <div className="tray">
                <ul className="lately paid">
                  {ov.results.map((r) => (
                    <li key={r.id} className="opens" data-opens-sheet="" onClick={(ev) => { if (!(ev.target as HTMLElement).closest("a, button")) go(`/?event=${r.id}`); }}>
                      <EventLogo name={r.name} website={r.website} size={34} />
                      <div className="who-text"><p className="name"><Link to={`/?event=${r.id}`} go={go} title={r.name} data-opens-sheet="">{r.name}</Link></p><p className="small mute">{[`${money(r.pipeline_cents)} pipeline`, `${money(r.cost_cents)} cost`, (r as { costs_missing?: number }).costs_missing ? `${(r as { costs_missing?: number }).costs_missing} not entered yet` : null, r.held < 5 ? "under 5 meetings" : null].filter(Boolean).join("  ·  ")}</p></div>
                      <p className={`paid-x${r.scored ? "" : " thin"}`}>{r.per_dollar !== null ? <><b>{r.per_dollar.toFixed(1)}</b>x</> : <span className="mute">no cost yet</span>}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </div>
      </div>
      {sheetId && <SideSheet id={sheetId} go={go} close={() => go("/")} />}
    </>
  );
}
