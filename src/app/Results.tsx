/* Results: every event whose sending is done, side by side, for leadership and GTM Engineering. The question it answers is the one
   brought to next year's seat decisions: which events paid, and which are worth going back to. One verdict across them, then each
   event as a tile ranked by pipeline per dollar, then what the desk has learned across events: who turns into meetings, accounts it
   passed on that later bought, and the ICP changes that follow (GTM decides those). Every figure is a scorecard the desk wrote. */

import { useEffect, useState, type CSSProperties } from "react";
import { get, send } from "./api";
import { Link, useActor } from "./App";
import { EventLogo } from "./EventLogo";
import { isGtm } from "../shared/roles";
import { money, num, shortDate } from "./words";

interface Row { id: string; name: string; starts_on: string; venue: string | null; website: string | null; final: boolean; window_days: number | null; cost_cents: number; pipeline_cents: number; won_cents: number; per_dollar: number | null; held: number; deals: number; scored: boolean; notes: { asked: number; written: number } }
interface Learning { table: { group_kind: string; group_value: string; people: number; held: number; rate: number | null; enough: boolean }[]; dropped_who_dealt: { domain: string; name: string; dropped: number; opportunities: number }[] | null; proposals: { id: string; kind: string; subject: string; evidence: string; status: string }[] }

const GROUPS: [string, string, (v: string) => string][] = [
  ["company_tier", "By company tier", (v) => (v === "unknown" ? "No tier" : `Tier ${v}`)],
  ["title_tier", "By title", (v) => (v === "unknown" ? "No title tier" : `Title tier ${v}`)],
  ["segment", "By segment", (v) => (v === "none" ? "No segment" : v[0].toUpperCase() + v.slice(1).replace(/_/g, " "))],
];
const times = (x: number) => `${x.toFixed(1)}x`;
const Arrow = () => <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;

export function Results({ go }: { go: (to: string) => void }) {
  const { actor } = useActor();
  const [rows, setRows] = useState<Row[] | null>(null), [learn, setLearn] = useState<Learning | null>(null), [busy, setBusy] = useState(false), [allPassed, setAllPassed] = useState(false);
  const load = async () => { setRows((await get<{ events: Row[] }>("/api/results"))?.events ?? []); setLearn(await get<Learning>("/api/motion/learning")); };
  useEffect(() => { load(); }, []);
  if (!rows) return null;

  const cost = rows.reduce((n, r) => n + r.cost_cents, 0), pipeline = rows.reduce((n, r) => n + r.pipeline_cents, 0), held = rows.reduce((n, r) => n + r.held, 0);
  const ranked = [...rows].sort((a, b) => (b.per_dollar ?? -1) - (a.per_dollar ?? -1));
  const best = Math.max(0.1, ...rows.map((r) => r.per_dollar ?? 0));
  const open = (learn?.proposals ?? []).filter((p) => p.status === "open");
  const decide = async (id: string, status: "accepted" | "rejected") => { setBusy(true); try { await send("POST", `/api/motion/learning/${id}`, actor, { status }); await load(); } finally { setBusy(false); } };

  return (
    <section className="results" data-ready="1">
      <header className="hero"><div><h1>Results</h1></div></header>

      {!rows.length ? <p className="md-clear">No event has finished sending yet. Results start fourteen days after an event ends.</p> : (
        <>
          <header className="md-hero rs-hero">
            <div className="md-hello">
              <p>{rows.length === 1 ? "One event" : `${rows.length} events`} done sending</p>
              <h2>{money(pipeline)} in pipeline for {money(cost)}</h2>
            </div>
            <div className="md-figs">
              <p><b>{cost ? times(pipeline / cost) : "None"}</b><span>pipeline per dollar</span></p>
              <p><b>{num(held)}</b><span>meetings held</span></p>
              <p><b>{money(rows.reduce((n, r) => n + r.won_cents, 0))}</b><span>won so far</span></p>
            </div>
          </header>

          <div className="rs-sec">
            <h3 className="rs-h">Event by event<span>by pipeline per dollar</span></h3>
            <ul className="ob-tray">{ranked.map((r, i) => (
              <li key={r.id} style={{ "--i": i } as CSSProperties}>
                <Link to={`/event/${r.id}#result`} go={go} className="ob-row rs-event">
                  <span className="ob-logo"><EventLogo name={r.name} website={r.website} size={30} /></span>
                  <span className="ob-who"><b>{r.name}</b><span>{[shortDate(r.starts_on), r.venue?.split(",").pop()?.trim(), r.notes.asked ? `${r.notes.written} of ${r.notes.asked} notes in` : null].filter(Boolean).join(" · ")}</span></span>
                  <span className={`rs-ratio${r.scored ? "" : " thin"}`}><i aria-hidden="true"><u style={{ "--w": (r.per_dollar ?? 0) / best } as CSSProperties} /></i><b>{r.per_dollar === null ? "None" : times(r.per_dollar)}</b></span>
                  <span className="rs-amount"><b>{money(r.pipeline_cents)}</b><span>for {money(r.cost_cents)}, {num(r.held)} held</span></span>
                  <span className="ob-end"><span className="ob-when">{r.final ? "Scored" : "So far"}</span><span className="ob-go">Open<Arrow /></span></span>
                </Link>
              </li>
            ))}</ul>
            {ranked.some((r) => !r.scored) && <p className="m-line">An event needs five held meetings before its ratio counts. Below that it is shown in grey.</p>}
          </div>
        </>
      )}

      {learn && learn.table.length > 0 && (
        <div className="rs-sec">
          <h3 className="rs-h">Who turns into meetings<span>everyone reached, across events</span></h3>
          <div className="brief rs-brief rs-three">{GROUPS.map(([kind, title, label]) => {
            const g = learn.table.filter((t) => t.group_kind === kind);
            if (!g.length) return null;
            const top = Math.max(0.01, ...g.map((t) => t.rate ?? 0));
            return (
              <div key={kind}>
                <h3>{title}</h3>
                <ul>{g.map((t) => (
                  <li key={t.group_value} className="brow"><span>{label(t.group_value)}</span><i aria-hidden="true"><u className="t1" style={{ width: t.enough ? `${Math.round(((t.rate ?? 0) / top) * 100)}%` : "0%" }} /></i><b>{t.enough ? `${Math.round((t.rate ?? 0) * 100)}%` : "Too few"}</b></li>
                ))}</ul>
              </div>
            );
          })}</div>
          <p className="m-line">The share of people reached who held a meeting. A group needs twenty people before it says anything.</p>
        </div>
      )}

      {learn?.dropped_who_dealt && learn.dropped_who_dealt.length > 0 && (
        <div className="rs-sec">
          <h3 className="rs-h">Passed on, then bought<span>{learn.dropped_who_dealt.length}</span></h3>
          <ul className="md-plain">{[...learn.dropped_who_dealt].sort((a, b) => b.dropped - a.dropped).slice(0, allPassed ? undefined : 6).map((d) => <li key={d.domain}><span>{d.name}</span><span className="mute">{d.dropped} {d.dropped === 1 ? "person" : "people"} dropped as low tier, {d.opportunities} {d.opportunities === 1 ? "deal" : "deals"} since</span></li>)}</ul>
          {learn.dropped_who_dealt.length > 6 && <button type="button" className="xmore" onClick={() => setAllPassed(!allPassed)}>{allPassed ? "Fewer" : `All ${learn.dropped_who_dealt.length}`}</button>}
        </div>
      )}

      {open.length > 0 && (
        <div className="rs-sec">
          <h3 className="rs-h">Suggested ICP changes<span>{isGtm(actor) ? "yours to decide" : "GTM Engineering decides"}</span></h3>
          {open.map((p) => (
            <article key={p.id} className="rs-review">
              <p className="rs-review-body">{p.subject}</p>
              <p className="rs-review-k">{p.evidence}</p>
              {isGtm(actor) && <div className="ob-acts"><button className="btn small" disabled={busy} onClick={() => decide(p.id, "accepted")}>Accept</button><button className="btn small line" disabled={busy} onClick={() => decide(p.id, "rejected")}>Leave it</button></div>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
