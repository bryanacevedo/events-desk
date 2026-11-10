/* Budget: tickets only. The year first (what is left, the bar, the key), then the four quarters, the
   by-event table with search and paging, and the split by team and region. Approvers set the budget.
   Everything here warns and never blocks. */

import { useEffect, useState } from "react";
import type { budgetView } from "../server/budget";
import { SideSheet } from "./SideSheet";
import { EventLogo } from "./EventLogo";
import { get, send } from "./api";
import { useActor } from "./App";
import { ExpandRow, Flag } from "./Patterns";
import { money, shortDate } from "./words";

type View = Awaited<ReturnType<typeof budgetView>>;
type Q = View["quarters"][number];
type Sums = Pick<Q, "budget_cents" | "spent" | "committed" | "waiting">;
const k = (cents: number) => (Math.abs(cents) >= 1_000_000 ? `$${(cents / 100_000).toFixed(0)}k` : money(cents));
const nowQuarter = (year: number) => { const d = new Date(); return d.getFullYear() === year ? Math.ceil((d.getMonth() + 1) / 3) : 0; };

/* One bar, one rounded shape. Spent, committed and waiting fill it up to the budget; whatever runs past the budget continues in orange. */
function Bar({ s, cap, tall = false, label }: { s: Sums; cap: number; tall?: boolean; label: string }) {
  const b = s.budget_cents, total = s.spent + s.committed + s.waiting;
  const pct = (n: number) => `${(Math.max(0, n) / cap) * 100}%`;
  const seg = (n: number) => ({ width: pct(n), minWidth: n > 0 ? 2 : 0 });
  const upTo = (n: number, used: number) => (b > 0 ? Math.max(0, Math.min(n, b - used)) : n);
  const spent = upTo(s.spent, 0), committed = upTo(s.committed, spent), waiting = upTo(s.waiting, spent + committed);
  return (
    <div className={`bbar${tall ? " tall" : ""}`} role="img" aria-label={label}>
      {b > 0 && <i className="track" style={{ width: pct(b) }} />}
      <div className="fill"><i className="spent" style={seg(spent)} /><i className="committed" style={seg(committed)} /><i className="waiting" style={seg(waiting)} /><i className="past" style={seg(b > 0 ? total - b : 0)} /></div>
    </div>
  );
}

const describe = (name: string, s: Sums) => `${name}: ${money(s.spent)} spent, ${money(s.committed)} committed, ${money(s.waiting)} waiting${s.budget_cents ? `, ${money(s.budget_cents)} budget` : ""}`;

/** What is left, or over. Shared by the year and each quarter. */
function Left({ left, big = false }: { left: number; big?: boolean }) {
  return (
    <p className={big ? "byear-lead" : "bq-left"}>
      {left < 0 ? <Flag cents={left} words="over" over /> : <span className="fig"><b>{money(left)}</b> left</span>}
    </p>
  );
}

function Quarter({ q, cap, now, set }: { q: Q; cap: number; now: boolean; set: boolean }) {
  return (
    <div className={`bq${now ? " now" : ""}`}>
      <p className="bq-h"><b className="display">Q{q.quarter}</b>{now && <span className="bq-now small">now</span>}<span className="spacer" />{set && <span className="mute small">{money(q.budget_cents)}</span>}</p>
      <Bar s={q} cap={cap} label={describe(`Q${q.quarter}`, q)} />
      {set && <Left left={q.left} />}
    </div>
  );
}

function SetBudget({ v, onDone, onClose }: { v: View; onDone: () => void; onClose: () => void }) {
  const { actor } = useActor();
  const [q, setQ] = useState(v.quarters.map((x) => String(x.budget_cents / 100)));
  const [error, setError] = useState("");
  const total = q.reduce((n, x) => n + (Number(x) || 0), 0);
  const save = async (ev: { preventDefault(): void }) => {
    ev.preventDefault();
    const r = await send("PUT", `/api/budget/${v.year}`, actor, { quarters: q.map(Number) });
    if (r.ok) onDone(); else setError(r.error);
  };
  return (
    <form className="form" onSubmit={save} aria-label={`Set the ${v.year} budget`} style={{ maxWidth: 720 }}>
      <div className="two4">
        {q.map((x, i) => <label className="field" key={i}><span>Q{i + 1}, dollars</span><input className="input" type="number" min="0" step="100" inputMode="numeric" value={x} onChange={(ev) => setQ(q.map((y, j) => (j === i ? ev.target.value : y)))} required /></label>)}
      </div>
      <p className="total">{v.year}: {money(total * 100)}</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions"><button className="btn" type="submit">Save</button><button className="textlink" type="button" onClick={onClose}>Cancel</button></div>
    </form>
  );
}


/** The current page with an event's side sheet open, or closed: the page stays and so does the reader's place on it. */
const withSheet = (id: string | null) => { const u = new URL(location.href); if (id) u.searchParams.set("event", id); else u.searchParams.delete("event"); return u.pathname + u.search + u.hash; };
export function Budget({ go, search }: { go: (to: string) => void; search: URLSearchParams }) {
  const { actor, needs } = useActor();
  const year = Number(search.get("year")) || new Date().getFullYear();
  const q = search.get("q") ?? "", page = Number(search.get("page")) || 1;
  const [v, setV] = useState<View | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(q);
  // Every filter in the address goes to the server, which does the filtering; the open sheet does not.
  const filters = ["quarter", "team", "region", "show", "sort"].map((k) => (search.get(k) ? `&${k}=${encodeURIComponent(search.get(k)!)}` : "")).join("");
  const load = () => get<View>(`/api/budget?year=${year}&q=${encodeURIComponent(q)}&page=${page}${filters}`).then((j) => setV(j));
  useEffect(() => { load(); }, [year, q, page, needs, filters]);
  useEffect(() => { setText(q); }, [q]);
  const to = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(search);
    for (const [key, val] of Object.entries(patch)) { if (val === null || val === "") p.delete(key); else p.set(key, val); }
    if (!("page" in patch)) p.delete("page");
    const s = p.toString();
    go(`/budget${s ? `?${s}` : ""}`);
  };
  useEffect(() => { if (text === q) return; const t = setTimeout(() => to({ q: text }), 250); return () => clearTimeout(t); }, [text]);
  const isApprover = Boolean(needs?.approvers.includes(actor));
  if (!v) return null;
  const t = v.totals;
  const years = [...new Set([...v.years, year, new Date().getFullYear()])].sort();
  const sum = (s: Sums) => s.spent + s.committed + s.waiting;
  // With a budget each bar is its own scale, so the track end says "the budget"; without one the quarters share a scale.
  const shared = Math.max(...v.quarters.map(sum), 1);
  const now = nowQuarter(year);

  return (
    <>
      <header className="hero" data-ready="1">
        <div><h1>Budget</h1></div>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="Year">{years.map((y) => <button key={y} type="button" aria-pressed={y === year} onClick={() => to({ year: String(y) })}>{y}</button>)}</div>
        {isApprover && !editing && <button className="btn line" type="button" onClick={() => setEditing(true)}>{v.set ? "Edit budget" : "Set budget"}</button>}
      </header>

      {editing && <SetBudget v={v} onDone={() => { setEditing(false); load(); }} onClose={() => setEditing(false)} />}

      <section className="bstrip" aria-label={`${year} ticket budget`}>
        <div className="byear">
          {v.set ? <Left left={t.left} big /> : <p className="byear-lead"><span className="fig mute"><b>No budget</b></span></p>}
          <Bar s={t} cap={Math.max(v.set ? t.budget_cents : 0, sum(t), 1)} tall label={describe(String(year), t)} />
          <ul className="bkey">
            <li><i className="spent" />Spent <b>{money(t.spent)}</b></li>
            <li><i className="committed" />Committed <b>{money(t.committed)}</b></li>
            <li><i className="waiting" />Waiting <b>{money(t.waiting)}</b></li>
            {v.set && <li><i className="budget" />Budget <b>{money(t.budget_cents)}</b></li>}
          </ul>
        </div>
        <div className="bq-row">{v.quarters.map((x) => <Quarter key={x.quarter} q={x} cap={v.set ? Math.max(x.budget_cents, sum(x), 1) : shared} now={x.quarter === now} set={v.set} />)}</div>
      </section>

      <section className="btable" aria-label="By event">
        <div className="grp"><h2 className="display">By event</h2><span className="grp-n">{v.total_events}</span></div>
        <div className="filters">
          <form className="search" onSubmit={(ev) => ev.preventDefault()} role="search">
            <label htmlFor="bq" className="sr-only">Find an event</label>
            <input id="bq" type="search" placeholder="Find an event" autoComplete="off" value={text} onChange={(ev) => setText(ev.target.value)} />
          </form>
          <div className="seg" role="group" aria-label="Quarter">
            {["", "1", "2", "3", "4"].map((k) => <button key={k} type="button" aria-pressed={(search.get("quarter") ?? "") === k} onClick={() => to({ quarter: k })}>{k ? `Q${k}` : "All"}</button>)}
          </div>
          <label className="filter"><span className="sr-only">Team</span>
            <select value={search.get("team") ?? ""} onChange={(ev) => to({ team: ev.target.value })}><option value="">Every team</option>{(v.teams ?? []).map((t) => <option key={t} value={t}>{t}</option>)}</select>
          </label>
          <label className="filter"><span className="sr-only">Region</span>
            <select value={search.get("region") ?? ""} onChange={(ev) => to({ region: ev.target.value })}><option value="">Every region</option>{(v.regions ?? []).map((t) => <option key={t} value={t}>{t}</option>)}</select>
          </label>
          <label className="filter"><span className="sr-only">Show</span>
            <select value={search.get("show") ?? ""} onChange={(ev) => to({ show: ev.target.value })}><option value="">Any spend</option><option value="waiting">Waiting on approval</option><option value="bought">Tickets bought</option></select>
          </label>
          <label className="filter"><span className="sr-only">Order</span>
            <select value={search.get("sort") ?? ""} onChange={(ev) => to({ sort: ev.target.value })}><option value="">By date</option><option value="size">Largest first</option></select>
          </label>
        </div>
        <ul className="ob-tray bud-rows">
          {(() => v.events.map((e, i) => {
            const gone = (e as { gone?: boolean }).gone, total = e.spent + e.committed + e.waiting;
            const row = (
              <>
                <span className="ob-face"><EventLogo name={e.name} website={(e as { website?: string | null }).website ?? null} size={36} /></span>
                <span className="ob-who"><b>{e.name}</b><span>{shortDate(e.starts_on)}</span></span>
                <span className="bud-q"><b>{e.seats}</b><span>{e.seats === 1 ? "seat" : "seats"}</span></span>
                {(() => { const qb = v.set ? v.quarters[e.quarter - 1]?.budget_cents ?? 0 : 0; if (!qb) return <span />; const share = total / qb; return (
                  <span className="bud-share" aria-label={`${Math.round(share * 100)}% of the Q${e.quarter} budget`}>
                    <span className="bud-share-bar" aria-hidden="true"><u style={{ width: `${Math.min(100, Math.max(share * 100, total ? 1.5 : 0))}%` }} className={share > 1 ? "over" : undefined} /></span>
                    <span className="bud-share-n"><b>{Math.round(share * 100)}%</b> of Q{e.quarter}</span>
                  </span>
                ); })()}
                <span className="bud-t"><b>{money(total)}</b><span>{e.waiting ? `${money(e.waiting)} waiting` : e.committed ? `${money(e.committed)} committed` : "tickets"}</span></span>
              </>
            );
            return <li key={e.event_id} style={{ "--i": i } as React.CSSProperties}>{gone ? <div className="ob-row bud-row ob-still">{row}</div> : <a href={withSheet(e.event_id)} className="ob-row bud-row" data-opens-sheet="" data-row={e.event_id} onClick={(ev) => { ev.preventDefault(); go(withSheet(e.event_id)); }}>{row}</a>}</li>;
          }))()}
        </ul>
        {!v.events.length && <p className="mute gap">{q || search.get("quarter") || search.get("team") || search.get("region") || search.get("show") ? "No event matches." : "Nothing yet."}</p>}
        {v.pages > 1 && (
          <div className="pager small"><button type="button" className="textlink" disabled={v.page <= 1} onClick={() => to({ page: String(v.page - 1) })}>Previous</button><span className="mute">{v.page} of {v.pages}</span><button type="button" className="textlink" disabled={v.page >= v.pages} onClick={() => to({ page: String(v.page + 1) })}>Next</button></div>
        )}
      </section>

      <div className="bsplit">
        {([["By team", v.by_team], ["By region", v.by_region]] as const).map(([title, rows]) => (
          <section key={title} aria-label={title}>
            <div className="grp"><h2 className="display">{title}</h2></div>
            {/* Each row carries its share of the biggest one, so the list reads as sizes before the figures are read. */}
            <div className="rows">{rows.map((r) => { const top = Math.max(1, ...rows.map((x) => x.spent + x.committed + x.waiting)); return <div className="srow share" key={r.name} style={{ "--s": (r.spent + r.committed + r.waiting) / top } as React.CSSProperties}><span>{r.name}</span><span>{k(r.spent + r.committed)}{r.waiting ? <span className="mute"> + {k(r.waiting)} waiting</span> : null}</span></div>; })}</div>
          </section>
        ))}
      </div>

      {v.log.length > 0 && (
        <ExpandRow className="blog" head={<span className="xrow-title">Changes <span className="mute">{v.log.length}</span></span>}>
          <ul>{v.log.map((l, i) => <li key={i} className="small"><b>{l.actor}</b> {l.detail}, {shortDate(l.created_at.slice(0, 10))}</li>)}</ul>
        </ExpandRow>
      )}
      {search.get("event") && <SideSheet id={search.get("event")!} go={go} close={() => go(withSheet(null))} lens="cost" />}
    </>
  );
}
