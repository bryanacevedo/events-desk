/* Events: the whole program, past and future, as one timeline. One row per event, its logo, a
   short state, and a runway from today to the doors that fills as the five steps are done. Opens
   on what is coming. Find and the filters (time, region, state) live in the URL. The scale gives
   the near weeks room and compresses the far months, so seven events in one month stay apart. An
   event opens in the side sheet; Add event opens its form in one too. */

import { useEffect, useRef, useState } from "react";
import type { EventRow } from "../shared/domain";
import { isGtm } from "../shared/roles";
import { send, type CatalogEntry } from "./api";
import { Link, useActor } from "./App";
import { EventLogo } from "./EventLogo";
import { RequestSeats } from "./RequestForm";
import { SideSheet } from "./SideSheet";
import { holderWords, stepAt, type Needs } from "./waiting";
import { city, countdown, daysTo, firstName, isRunning, plural, shortDate, todayYmd } from "./words";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const noon = (s: string) => new Date(`${s.slice(0, 10)}T12:00:00`);
const REGIONS: [string, string, string[]][] = [
  ["na", "North America", ["United States", "Canada"]],
  ["latam", "Latin America", ["Brazil", "Mexico", "Argentina", "Chile", "Colombia"]],
  ["eu", "Europe", ["Netherlands", "Ireland", "Portugal", "Spain", "France", "Germany", "United Kingdom", "Italy"]],
  ["me", "Middle East", ["Saudi Arabia", "United Arab Emirates", "Qatar"]],
  ["apac", "Asia Pacific", ["Thailand", "Japan", "Singapore", "Australia", "India"]],
];
const regionOf = (country: string) => REGIONS.find((r) => r[2].includes(country))?.[0] ?? "other";
const TIMES = { coming: "Coming", past: "Past", all: "All" } as const;
type TimeKey = keyof typeof TIMES;
const STATES = { wait: "Needs someone", run: "Running", ready: "Outreach list ready", ended: "Ended", listed: "Not requested" } as const;
type StateKey = keyof typeof STATES;
/** Far dates are compressed: a day near today takes more room than a day next spring. */
const POW = 0.6;

interface Row { key: string; name: string; website: string | null; starts_on: string; ends_on: string; country: string; place: string; e?: EventRow; c?: CatalogEntry }
interface State { key: StateKey; words: string; who: string | null; tone: "wait" | "run" | "ok" | "off" | "none" }

/** One short state per row, and the person it waits on only where a name helps. */
function stateOf(r: Row, today: string, needs: Needs): State {
  const e = r.e;
  if (!e) return { key: "listed", words: "Not requested", who: null, tone: "none" };
  const past = r.ends_on < today;
  const owner = firstName(e.uploaded_by ?? e.requested_by);
  if (isRunning(e.stage)) return { key: "run", words: "Running", who: null, tone: "run" };
  switch (e.stage) {
    case "requested": { const n = needs.requests.filter((q) => q.event_id === e.id && q.status === "pending").length; return { key: "wait", words: n > 1 ? `${n} seats waiting` : "Seat waiting", who: holderWords(needs.approvers), tone: "wait" }; }
    case "approved": return { key: "wait", words: "No attendee list", who: owner, tone: "wait" };
    case "mapped": case "quoted": return { key: "wait", words: "Ready to run", who: owner, tone: "wait" };
    case "ready_for_review": { const n = needs.items.find((i) => i.kind === "case" && i.eventId === e.id)?.caseCount; return { key: "wait", words: n ? `${plural(n, "case")} to settle` : "Cases to settle", who: null, tone: "wait" }; }
    case "paused": return { key: "wait", words: "Paused", who: null, tone: "wait" };
    case "delivered": return { key: "ready", words: "Outreach list ready", who: null, tone: "ok" };
    case "declined": return { key: "ended", words: "Ended", who: null, tone: "off" };
    default: return { key: "run", words: "Running", who: null, tone: "run" };
  }
}

export function Events({ go, sheetId, requesting, preselect, search }: { go: (to: string) => void; sheetId: string | null; requesting: boolean; preselect: string | null; search: URLSearchParams }) {
  const { needs, actor } = useActor();
  useEffect(() => { if (sheetId) document.body.classList.add("sheet-open"); else document.body.classList.remove("sheet-open"); return () => document.body.classList.remove("sheet-open"); }, [sheetId]);
  // The axis is laid out in percent; which month labels fit depends on its real width.
  const axisRef = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(700);
  useEffect(() => {
    const el = axisRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackW(el.clientWidth || 700));
    ro.observe(el);
    setTrackW(el.clientWidth || 700);
    return () => ro.disconnect();
  }, [needs]);
  if (!needs) return null;

  const today = todayYmd();
  const time: TimeKey = (search.get("time") as TimeKey) in TIMES ? (search.get("time") as TimeKey) : "coming";
  const region = search.get("region") ?? "", state = search.get("state") ?? "", q = (search.get("q") ?? "").trim().toLowerCase();
  const adding = search.get("add") === "1";
  const canAdd = isGtm(actor) || needs.approvers.includes(actor);

  // Every event, plus the listed events nobody has asked for (a catalog entry with no live event row).
  const catById = new Map(needs.catalog.map((c) => [c.id, c]));
  const used = new Set(needs.events.map((e) => e.catalog_id));
  const rows: Row[] = [
    ...needs.events.map((e): Row => { const c = e.catalog_id ? catById.get(e.catalog_id) : undefined; const s = e.starts_on.slice(0, 10); return { key: e.id, name: e.name, website: e.website ?? c?.website ?? null, starts_on: s, ends_on: c?.ends_on ?? s, country: e.country ?? c?.country ?? "", place: city(e.venue), e }; }),
    ...needs.catalog.filter((c) => !c.event_id && !used.has(c.id) && c.ends_on >= today).map((c): Row => ({ key: c.id, name: c.name, website: c.website, starts_on: c.starts_on, ends_on: c.ends_on, country: c.country, place: c.city, c })),
  ].sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.name.localeCompare(b.name));
  const isPast = (r: Row) => r.ends_on < today;
  const inTime = (r: Row) => time === "all" || (time === "past") === isPast(r);
  const windowRows = rows.filter(inTime);
  const shown = windowRows.filter((r) => (!region || regionOf(r.country) === region) && (!state || stateOf(r, today, needs).key === state) && (!q || `${r.name} ${r.place} ${r.country}`.toLowerCase().includes(q)));
  const regions = REGIONS.filter((r) => rows.some((x) => regionOf(x.country) === r[0]));

  // The scale: days from today, compressed, over the window. Coming starts at today; Past ends there.
  const ds = windowRows.map((r) => daysTo(r.starts_on));
  let min = Math.min(0, ...ds), max = Math.max(0, ...ds);
  if (time === "coming") { min = 0; max = Math.max(max, 45); }
  if (time === "past") { max = 0; min = Math.min(min, -45); }
  const f = (d: number) => Math.sign(d) * Math.pow(Math.abs(d), POW);
  const span = f(max) - f(min) || 1;
  const x = (d: number) => ((f(d) - f(min)) / span) * 100;
  const todayX = x(0);
  // Month boundaries across the window; a label only where it fits after the last one and clear of the Today tag.
  const ticks: { x: number; label: string; show: boolean }[] = [];
  const t0 = noon(today);
  const pct = (pxWidth: number) => (pxWidth / trackW) * 100;
  const wide = (label: string) => pct(label.length * 6.8 + 14);
  let lastEnd = -100;
  for (let m = Math.floor(min / 28) - 1; m <= Math.ceil(max / 28) + 1; m++) {
    const d = new Date(t0.getFullYear(), t0.getMonth() + m, 1, 12);
    const days = Math.round((d.getTime() - t0.getTime()) / 86_400_000);
    if (days < min || days > max) continue;
    const px = x(days);
    const label = d.getMonth() === 0 || ticks.length === 0 ? `${MON[d.getMonth()]} ${d.getFullYear()}` : MON[d.getMonth()];
    const w = wide(label);
    const clearOfToday = px + w < todayX - pct(26) || px > todayX + pct(26);
    const show = px >= lastEnd && px + w <= 100 && clearOfToday;
    if (show) lastEnd = px + w;
    ticks.push({ x: px, label, show });
  }

  const to = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(search);
    for (const k of ["request", "catalog", "add"]) p.delete(k);
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === "" || (k === "time" && v === "coming")) p.delete(k); else p.set(k, v); }
    const s = p.toString();
    go(`/events${s ? `?${s}` : ""}`);
  };
  const keepQuery = () => { const p = new URLSearchParams(search); for (const k of ["request", "catalog", "add", "event"]) p.delete(k); const s = p.toString(); return `/events${s ? `?${s}` : ""}`; };
  const withParam = (k: string, v: string) => { const p = new URLSearchParams(search); for (const kk of ["request", "catalog", "add", "event"]) p.delete(kk); p.set(k, v); return `/events?${p.toString()}`; };
  const count = (k: TimeKey) => rows.filter((r) => k === "all" || (k === "past") === isPast(r)).length;

  return (
    <>
      <header className="hero" data-ready="1">
        <div><h1>Events</h1></div>
        <span className="spacer" />
        {canAdd && <Link to={withParam("add", "1")} go={go} className="btn line small tl-add">Add event</Link>}
        <Link to={withParam("request", "1")} go={go} className="btn phone-only">Request seats</Link>
      </header>

      {requesting && <RequestSeats preselect={preselect} onDone={() => go("/seats?mine=1&status=all")} onClose={() => go(keepQuery())} />}

      <div className="filters tl-filters" role="group" aria-label="Find and filter events">
        <form className="search" onSubmit={(ev) => ev.preventDefault()} role="search">
          <label htmlFor="q" className="sr-only">Find an event</label>
          <input id="q" name="q" type="search" placeholder="Find" autoComplete="off" value={search.get("q") ?? ""} onChange={(ev) => to({ q: ev.target.value })} />
        </form>
        <div className="seg" role="group" aria-label="Time">
          {(Object.keys(TIMES) as TimeKey[]).map((k) => <button key={k} type="button" aria-pressed={time === k} onClick={() => to({ time: k })}>{TIMES[k]} <span className="mute">{count(k)}</span></button>)}
        </div>
        <div className="tl-sels">
          <label className="filter"><span className="sr-only">Region</span>
            <select value={region} onChange={(ev) => to({ region: ev.target.value })} aria-label="Region"><option value="">All regions</option>{regions.map((r) => <option key={r[0]} value={r[0]}>{r[1]}</option>)}</select>
          </label>
          <label className="filter"><span className="sr-only">State</span>
            <select value={state} onChange={(ev) => to({ state: ev.target.value })} aria-label="State"><option value="">Any state</option>{(Object.keys(STATES) as StateKey[]).map((k) => <option key={k} value={k}>{STATES[k]}</option>)}</select>
          </label>
        </div>
        {(q || region || state) && <p className="small mute tl-count">{plural(shown.length, "event")}</p>}
      </div>

      <section className="tl" aria-label="Events in date order">
        <div className="tl-axis" aria-hidden="true">
          <div className="tl-axis-track" ref={axisRef}>
            {ticks.map((t) => <span key={t.x} className={`tl-tick${t.show ? "" : " quiet"}`} style={{ left: `${t.x}%` }}>{t.show ? t.label : ""}</span>)}
            <span className={`tl-today-tag${todayX > 80 ? " flip" : todayX < 4 ? " start" : ""}`} style={{ left: `${todayX}%` }}>Today</span>
          </div>
        </div>
        <div className="tl-body">
          <div className="tl-marks" aria-hidden="true"><span className="tl-today" style={{ left: `${todayX}%` }} /></div>
          {shown.map((r) => {
            const s = stateOf(r, today, needs);
            const past = isPast(r);
            const d = daysTo(r.starts_on);
            const x1 = x(Math.max(min, Math.min(max, d)));
            const dateWords = shortDate(r.starts_on);
            // The date sits after its dot unless it would leave the track; then it sits before it.
            const flip = x1 + wide(dateWords) > 100;
            const done = r.e && r.e.stage !== "declined" ? stepAt(r.e, needs.items.find((n) => n.kind === "case" && n.eventId === r.e!.id)?.caseCount ?? 0) : 0;
            const runway = Boolean(r.e) && !past && r.e!.stage !== "declined";
            const inner = (
              <>
                <EventLogo name={r.name} website={r.website} size={28} />
                <div className="tl-name"><p className="name">{r.name}</p><p className="small mute">{r.place}</p></div>
                {r.c
                  ? <p className="tl-state none"><span className="tl-req">Request a seat</span></p>
                  : <p className={`tl-state ${s.tone}`}><i className="tl-sign" aria-hidden="true" /><span className="tl-words"><b>{s.words}</b>{s.who && <span>{s.who}</span>}</span></p>}
                <div className="tl-track">
                  {runway && (
                    <div className={`tl-bar ${s.tone}`} style={{ left: `${Math.min(todayX, x1)}%`, width: `${Math.max(0, x1 - todayX)}%` }} role="img" aria-label={`${done} of 5 steps done`}>
                      <i style={{ width: `${(done / 5) * 100}%` }} />
                      {done < 5 && <b style={{ left: `${(done / 5) * 100}%` }} />}
                      {[20, 40, 60, 80].map((p) => <u key={p} style={{ left: `${p}%` }} />)}
                    </div>
                  )}
                  <span className={`tl-dot ${s.tone}${r.c ? " listed" : ""}`} style={{ left: `${x1}%` }} />
                  <span className={`tl-end${flip ? " flip" : ""}${past || r.c ? " mute" : ""}`} style={flip ? { right: `${100 - x1}%` } : { left: `${x1}%` }}>{dateWords}</span>
                </div>
              </>
            );
            const label = `${r.name}, ${countdown(r.starts_on)}, ${s.words}${s.who ? `, ${s.who}` : ""}`;
            return r.e
              ? <Link key={r.key} to={withParam("event", r.e.id)} go={go} data-opens-sheet="" data-row={r.key} className={`tl-row${past ? " past" : ""}`} aria-current={sheetId === r.key ? "page" : undefined} aria-label={label}>{inner}</Link>
              : <Link key={r.key} to={`/events?request=1&catalog=${r.c!.id}`} go={go} data-row={r.key} className="tl-row listed" aria-label={`${r.name}, ${countdown(r.starts_on)}, not requested. Request a seat`}>{inner}</Link>;
          })}
          {!shown.length && <p className="mute tl-empty">{windowRows.length ? "Nothing matches." : time === "past" ? "Nothing has happened yet." : "Nothing coming up."}</p>}
        </div>
      </section>

      {sheetId && <SideSheet id={sheetId} go={go} close={() => go(keepQuery())} />}
      {adding && canAdd && <AddEvent onDone={() => go(keepQuery())} onClose={() => go(keepQuery())} />}
    </>
  );
}

/** Add a listed event: name, dates, place, website, ticket price. The server checks who may and every field. */
function AddEvent({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const { actor, refresh } = useActor();
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [f, setF] = useState({ name: "", website: "", starts_on: "", ends_on: "", city: "", country: "", venue: "", price: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input")?.focus();
    document.body.classList.add("sheet-open");
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closeRef.current(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); closeRef.current(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); document.body.classList.remove("sheet-open"); };
  }, []);
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  const ready = f.name.trim() && f.starts_on && f.city.trim() && f.country.trim() && f.website.trim() && f.price !== "";
  const submit = async (ev: { preventDefault(): void }) => {
    ev.preventDefault();
    setBusy(true); setError("");
    const r = await send("POST", "/api/catalog", actor, { name: f.name, website: f.website, starts_on: f.starts_on, ends_on: f.ends_on || f.starts_on, city: f.city, country: f.country, venue: f.venue, price_dollars: Number(f.price) });
    setBusy(false);
    if (r.ok) { await refresh(); onDone(); } else setError(r.error);
  };
  return (
    <aside className="sheet" ref={ref} role="dialog" aria-label="Add an event" data-add>
      <div className="sheet-top">
        <h2 className="display">Add an event</h2>
        <span className="spacer" />
        <button className="sheet-x" type="button" data-close aria-label="Close" onClick={onClose}>&times;</button>
      </div>
      <form className="form addform" onSubmit={submit}>
        <label className="field"><span>Name</span><input className="input" value={f.name} onChange={set("name")} autoComplete="off" required /></label>
        <label className="field"><span>Website</span><input className="input" type="url" inputMode="url" placeholder="https://" value={f.website} onChange={set("website")} required /></label>
        <div className="two">
          <label className="field"><span>Starts</span><input className="input" type="date" value={f.starts_on} onChange={set("starts_on")} required /></label>
          <label className="field"><span>Ends</span><input className="input" type="date" value={f.ends_on} min={f.starts_on} onChange={set("ends_on")} /></label>
        </div>
        <div className="two">
          <label className="field"><span>City</span><input className="input" value={f.city} onChange={set("city")} autoComplete="off" required /></label>
          <label className="field"><span>Country</span><input className="input" value={f.country} onChange={set("country")} autoComplete="off" required /></label>
        </div>
        <label className="field"><span>Venue (optional)</span><input className="input" value={f.venue} onChange={set("venue")} autoComplete="off" /></label>
        <label className="field"><span>Ticket price, dollars</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={f.price} onChange={set("price")} required /></label>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="actions">
          <button className="btn" type="submit" disabled={busy || !ready}>{busy ? "Adding…" : "Add"}</button>
          <button className="btn line" type="button" onClick={onClose}>Not now</button>
        </div>
      </form>
    </aside>
  );
}
