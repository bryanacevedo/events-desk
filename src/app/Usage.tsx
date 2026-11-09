/* Usage: read only, from the ledger. Each credit vendor is drawn as its own pool, in its own credits, with what is left as the headline
   and what was spent fanned out into the jobs it went to. AI stands apart as a bill in dollars. Credits never carry a dollar figure
   and are never added across vendors. The by-event table below keeps its search and paging. */

import { useEffect, useState } from "react";
import type { usageView } from "../server/usage";
import { CREDIT_VENDORS, type CreditVendor } from "../shared/vendors";
import { get } from "./api";
import { EventLogo } from "./EventLogo";
import { daysTo, shortDate } from "./words";

type View = Awaited<ReturnType<typeof usageView>>;
type VendorUse = View["vendors"][number];
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const n = (v: number) => v.toLocaleString("en-US");

/** The company behind each pool, for its logo. */
const SITES: Record<CreditVendor, string> = { Apollo: "https://apollo.io", ZeroBounce: "https://zerobounce.net" };

/** When the pool fills again: the first day after its month or year. */
function resets(period: "month" | "year", year: number, month: number) {
  const d = period === "month" ? new Date(month === 12 ? year + 1 : year, month % 12, 1) : new Date(year + 1, 0, 1);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  return { label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), days: daysTo(ymd) };
}

/** The headline figure: what is left, or what was used when the pool has no known size. Orange once a tenth or less remains. */
function headline(x: VendorUse) {
  if (x.allotment === null) return { num: n(x.used), word: "used", warn: false };
  const left = x.allotment - x.used;
  if (left < 0) return { num: n(-left), word: "over", warn: true };
  return { num: n(left), word: "left", warn: left <= x.allotment / 10 };
}

/** A single vendor's pool. The bar is its allotment; green is spent, sand is left. With several jobs, the spent slice fans out into blocks, one per job. */
function Pool({ x, year, month, big = false }: { x: VendorUse; year: number; month: number; big?: boolean }) {
  const h = headline(x);
  const r = resets(x.period, year, month);
  const pct = x.allotment ? Math.min(100, (x.used / x.allotment) * 100) : 0;
  const several = x.parts.length > 1;
  const figure = <p className="pool-left"><b>{h.num}</b> {h.word}{x.allotment !== null && h.word === "left" && <> of {n(x.allotment)}</>}{h.word === "over" && <> {n(x.allotment!)}</>}</p>;
  return (
    <article className={`pool${big ? " big" : ""}${h.warn ? " low" : ""}`} aria-label={x.vendor}>
      <header className="pool-h">
        <EventLogo name={x.vendor} website={SITES[x.vendor]} size={big ? 48 : 36} />
        <div className="pool-who">
          <h2 className="pool-n">{x.vendor}</h2>
          <p className="small mute">Resets {r.label}{r.days > 0 && <>, {r.days} {r.days === 1 ? "day" : "days"}</>}{x.saved > 0 && <> · {n(x.saved)} saved</>}</p>
        </div>
        {big && figure}
      </header>
      {!big && figure}
      {x.allotment !== null && (
        <div className="pool-bar" role="img" aria-label={`${n(x.used)} of ${n(x.allotment)} used`}>
          <i style={{ width: `${pct}%` }} />
          {x.used > 0 && <span className="pool-used" style={{ left: `${pct}%` }}>{n(x.used)} used</span>}
        </div>
      )}
      {several && x.allotment !== null && <div className="pool-fan" style={{ "--w": `${Math.max(pct, 0.6)}%` } as React.CSSProperties} aria-hidden="true" />}
      {several
        ? <ul className="pool-jobs">{x.parts.map((p, i) => <li key={p.label} className={`j${i}`} style={{ flexGrow: p.n }}><b>{n(p.n)}</b><span>{p.label}</span></li>)}</ul>
        : x.parts[0] && <p className="pool-job small">{x.allotment === null ? x.parts[0].label : `${n(x.parts[0].n)} ${x.parts[0].label.toLowerCase()}`}</p>}
    </article>
  );
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** AI is money, not a pool: a bill for the month, itemized, with the year's total on the foot. */
function Bill({ ai, year, month }: { ai: View["ai"]; year: number; month: number }) {
  return (
    <aside className="bill" aria-label="AI">
      <header className="pool-h">
        <EventLogo name="AI" website="https://anthropic.com" size={36} />
        <div className="pool-who"><h2 className="pool-n">AI</h2><p className="small mute">{MONTHS[month - 1]}</p></div>
        <p className="pool-left"><b>{usd(ai.month_cents)}</b></p>
      </header>
      <ul className="bill-lines">
        {ai.parts.map((p) => <li key={p.label}><span>{p.label}</span><i /><span>{usd(p.cents)}</span></li>)}
        {!ai.parts.length && <li className="mute"><span>No calls yet</span></li>}
      </ul>
      {(ai.real_calls > 0 || ai.flat_calls > 0) && (
        <p className="small mute">
          {ai.real_calls > 0 && `${n(ai.real_calls)} real ${ai.real_calls === 1 ? "call" : "calls"} priced from the tokens used. `}
          {ai.flat_calls > 0 && `${n(ai.flat_calls)} simulated or uncounted ${ai.flat_calls === 1 ? "call" : "calls"} at ${ai.flat_cents_per_call} cent${ai.flat_cents_per_call === 1 ? "" : "s"} each.`}
        </p>
      )}
      {ai.saved_cents > 0 && <p className="bill-saved small mute"><span>Saved</span><i /><span>{usd(ai.saved_cents)}</span></p>}
      <p className="bill-foot"><span>{year} so far</span><i /><span>{usd(ai.year_cents)}</span></p>
    </aside>
  );
}

export function Usage({ go, search }: { go: (to: string) => void; search: URLSearchParams }) {
  const q = search.get("q") ?? "", page = Number(search.get("page")) || 1;
  const [v, setV] = useState<View | null>(null);
  const [text, setText] = useState(q);
  useEffect(() => { get<View>(`/api/usage?q=${encodeURIComponent(q)}&page=${page}`).then(setV); }, [q, page]);
  useEffect(() => { setText(q); }, [q]);
  const to = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(search);
    for (const [key, val] of Object.entries(patch)) { if (val === null || val === "") p.delete(key); else p.set(key, val); }
    if (!("page" in patch)) p.delete("page");
    const s = p.toString();
    go(`/usage${s ? `?${s}` : ""}`);
  };
  useEffect(() => { if (text === q) return; const t = setTimeout(() => to({ q: text }), 250); return () => clearTimeout(t); }, [text]);
  if (!v) return null;

  // Apollo does several jobs and takes the whole width; the one-job vendors share a strip beside the AI bill.
  const [first, ...rest] = [...v.vendors].sort((a, b) => b.parts.length - a.parts.length);

  return (
    <>
      <header className="hero" data-ready="1"><div><h1>Usage</h1>{v.simulated && <p className="mute small">Simulated runs</p>}</div></header>

      <section className="pools" aria-label="Vendors and AI">
        {first && <Pool x={first} year={v.year} month={v.month} big />}
        <div className="pools-rest">
          {rest.map((x) => <Pool key={x.vendor} x={x} year={v.year} month={v.month} />)}
        </div>
        <Bill ai={v.ai} year={v.year} month={v.month} />
      </section>

      <section className="btable" aria-label="By event">
        <div className="grp"><h2 className="display">By event</h2><span className="mute small">{v.total_events}</span></div>
        <form className="search" onSubmit={(ev) => ev.preventDefault()} role="search">
          <label htmlFor="uq" className="sr-only">Find an event</label>
          <input id="uq" type="search" placeholder="Find an event" autoComplete="off" value={text} onChange={(ev) => setText(ev.target.value)} />
        </form>
        <div className="rows" role="table" aria-label="Use by event, by vendor, with AI in dollars">
          <div className="rrow urow head" role="row"><span role="columnheader">Event</span>{CREDIT_VENDORS.map((c) => <span role="columnheader" key={c}>{c}</span>)}<span role="columnheader">AI</span></div>
          {v.events.map((e) => (
            <div className="rrow urow" role="row" key={e.event_id}>
              <span role="cell" className="who-text"><p className="name"><a href={`/event/${e.event_id}`} onClick={(ev) => { ev.preventDefault(); go(`/event/${e.event_id}`); }}>{e.name}</a></p><p className="small mute">{shortDate(e.starts_on)}</p></span>
              {CREDIT_VENDORS.map((c) => {
                const u = e.credits[c];
                return <span role="cell" key={c} data-l={c}>{u.used === 0 && u.cap === 0 ? <span className="mute">·</span> : <>{n(u.used)}{u.cap > 0 && <span className="mute"> of {n(u.cap)}</span>}</>}</span>;
              })}
              <span role="cell" data-l="AI">{e.ai.cents === 0 && e.ai.cap_cents === 0 ? <span className="mute">·</span> : <>{usd(e.ai.cents)}{e.ai.cap_cents > 0 && <span className="mute"> of {usd(e.ai.cap_cents)}</span>}</>}</span>
            </div>
          ))}
          {!v.events.length && <p className="mute gap">{q ? "No event matches." : "None yet."}</p>}
        </div>
        {v.pages > 1 && (
          <div className="pager small"><button type="button" className="textlink" disabled={v.page <= 1} onClick={() => to({ page: String(v.page - 1) })}>Previous</button><span className="mute">{v.page} of {v.pages}</span><button type="button" className="textlink" disabled={v.page >= v.pages} onClick={() => to({ page: String(v.page + 1) })}>Next</button></div>
        )}
      </section>

      {v.vendor_health.length > 0 && (
        <section className="btable" aria-label="Lookups">
          <div className="grp"><h2 className="display">Lookups</h2></div>
          <div className="rows">{v.vendor_health.map((h) => <div className="srow" key={h.vendor}><span>{h.vendor}</span><span>{n(h.attempts)}{h.failures > 0 && <span className="mute"> · {n(h.failures)} failed</span>}</span></div>)}</div>
        </section>
      )}
    </>
  );
}
