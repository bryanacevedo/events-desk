/* Results: every event whose sending is done, side by side, for leadership and GTM Engineering. The question it answers is the one
   brought to next year's seat decisions: which events paid, and which are worth going back to. One verdict across them, then each
   event as a tile ranked by pipeline per dollar, then what the desk has learned across events: who turns into meetings, accounts it
   passed on that later bought, and the ICP changes that follow (GTM decides those). Every figure is a scorecard the desk wrote. */

import { useEffect, useState, type CSSProperties } from "react";
import { get, send } from "./api";
import { Link, useActor } from "./App";
import { EventLogo } from "./EventLogo";
import { SideSheet } from "./SideSheet";
import { isGtm } from "../shared/roles";
import { money, num, shortDate } from "./words";

interface Row { id: string; name: string; starts_on: string; venue: string | null; website: string | null; final: boolean; window_days: number | null; cost_cents: number; pipeline_cents: number; won_cents: number; per_dollar: number | null; held: number; deals: number; scored: boolean; costs_missing: number; notes: { asked: number; written: number } }
interface Learning { table: { group_kind: string; group_value: string; people: number; held: number; rate: number | null; enough: boolean }[]; dropped_who_dealt: { domain: string; name: string; dropped: number; opportunities: number }[] | null; proposals: { id: string; kind: string; subject: string; evidence: { people: number; held: number; rate: number | null; overall_rate: number }; edit: { verdict: "raise" | "lower" }; status: string }[] }

const GROUPS: [string, string, (v: string) => string][] = [
  ["company_tier", "By company tier", (v) => (v === "unknown" ? "No tier" : `Tier ${v} companies`)],
  ["title_tier", "By title", (v) => (v === "unknown" ? "No title tier" : `Tier ${v} titles`)],
  ["segment", "By segment", (v) => (v === "none" ? "No segment" : v[0].toUpperCase() + v.slice(1).replace(/_/g, " "))],
];
const times = (x: number) => `${x.toFixed(1)}x`;
/** The current page with an event's side sheet open, or closed: the page stays and so does the reader's place on it. */
const withSheet = (id: string | null) => { const u = new URL(location.href); if (id) u.searchParams.set("event", id); else u.searchParams.delete("event"); return u.pathname + u.search + u.hash; };

const Arrow = () => <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;

export function Results({ go }: { go: (to: string) => void }) {
  const { actor } = useActor();
  const [rows, setRows] = useState<Row[] | null>(null), [learn, setLearn] = useState<Learning | null>(null), [busy, setBusy] = useState(false);
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

      {!rows.length ? <p className="md-clear">No event has finished sending yet.</p> : (
        <>
          <header className="md-hero rs-hero">
            <div className="md-hello">
              <p>{rows.length === 1 ? "One finished event" : `${rows.length} finished events`}</p>
              <h2><b>{cost ? times(pipeline / cost) : "None"}</b><span>pipeline per dollar</span></h2>
            </div>
            <div className="md-figs">
              <p><b>{money(pipeline)}</b><span>pipeline</span></p>
              <p><b>{money(cost)}</b><span>cost</span></p>
              <p><b>{num(held)}</b><span>meetings held</span></p>
              <p><b>{money(rows.reduce((n, r) => n + r.won_cents, 0))}</b><span>won</span></p>
            </div>
          </header>

          <div className="rs-sec">
            <h3 className="rs-h">Events</h3>
            <ul className="ob-tray">{ranked.map((r, i) => (
              <li key={r.id} style={{ "--i": i } as CSSProperties}>
                <Link to={withSheet(r.id)} go={go} className="ob-row rs-event" data-opens-sheet="" data-row={r.id}>
                  <span className="ob-logo"><EventLogo name={r.name} website={r.website} size={30} /></span>
                  <span className="ob-who"><b>{r.name}</b><span>{[shortDate(r.starts_on), r.venue?.split(",").pop()?.trim(), r.notes.asked ? `${r.notes.written} of ${r.notes.asked} notes` : null, r.costs_missing ? `${r.costs_missing} ${r.costs_missing === 1 ? "cost" : "costs"} to enter` : null].filter(Boolean).join(" · ")}</span></span>
                  <span className={`rs-fig${r.scored ? "" : " thin"}`}><b>{r.per_dollar === null ? "None" : times(r.per_dollar)}</b><span>{r.held < 5 ? "per dollar, under 5 meetings" : "per dollar"}</span></span>
                  <span className="rs-fig"><b>{money(r.pipeline_cents)}</b><span>pipeline</span></span>
                  <span className="ob-end"><span className="ob-when">{r.final ? "Scored" : "Closing"}</span><span className="ob-go">Open<Arrow /></span></span>
                </Link>
              </li>
            ))}</ul>
          </div>
        </>
      )}

      {learn && learn.table.length > 0 && (
        <div className="rs-sec">
          <h3 className="rs-h">Who turns into meetings</h3>
          <div className="brief rs-brief rs-three">{GROUPS.map(([kind, title, label]) => {
            // The value for every group, highest first. No verdict word: there is no meeting goal per group to judge it against.
            const g = learn.table.filter((t) => t.group_kind === kind).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0));
            if (!g.length) return null;
            // One scale for every group, so 7% always draws shorter than 11% wherever the two sit.
            const top = Math.max(0.01, ...learn.table.map((t) => t.rate ?? 0));
            return (
              <div key={kind}>
                <h3>{title}</h3>
                <ul>{g.map((t) => (
                  <li key={t.group_value} className="brow" title={`${t.held} of ${t.people} held a meeting`}><span>{label(t.group_value)}</span><i aria-hidden="true"><u className="t1" style={{ width: `${Math.round(((t.rate ?? 0) / top) * 100)}%` }} /></i><b>{t.held} of {t.people}</b></li>
                ))}</ul>
              </div>
            );
          })}</div>
        </div>
      )}

      {new URLSearchParams(location.search).get("event") && <SideSheet id={new URLSearchParams(location.search).get("event")!} go={go} close={() => go(withSheet(null))} />}
      {open.length > 0 && (
        <div className="rs-sec">
          <h3 className="rs-h">Suggested ICP changes<span>{isGtm(actor) ? "yours to decide" : "GTM Engineering decides"}</span></h3>
          {open.map((p) => (
            <article key={p.id} className="rs-review">
              {(() => { const g = GROUPS.find(([k]) => k === p.kind), label = g ? g[2](p.subject) : p.subject, e = p.evidence; return <>
                <p className="rs-review-body">{p.edit.verdict === "raise" ? "Raise" : "Lower"} {label}</p>
                <div className="md-figs rs-figs"><p><b>{e.rate !== null ? `${Math.round(e.rate * 100)}%` : "None"}</b><span>{e.held} of {e.people} held a meeting</span></p><p><b>{Math.round(e.overall_rate * 100)}%</b><span>everyone</span></p></div>
              </>; })()}
              {isGtm(actor) && <div className="ob-acts"><button className="btn small" disabled={busy} onClick={() => decide(p.id, "accepted")}>Accept</button><button className="btn small line" disabled={busy} onClick={() => decide(p.id, "rejected")}>Leave it</button></div>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
