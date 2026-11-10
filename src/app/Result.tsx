/* What an event returned, once its sending is done (Closing, then Scored). It takes the funnel's place at the top of the Outreach view.
   One verdict first, then in the order a person asks: why we believe it (met against not met), how the pipeline grew, which deals and
   which meeting each came from, and what the team learned. Money is leadership's and GTM's, as on Budget; everyone sees the meetings,
   the comparison and the learning. Nothing here is computed on the page: it is the scorecard the desk wrote, or its live reading. */

import { useEffect, useState, type CSSProperties } from "react";
import { get, send } from "./api";
import { Link, useActor } from "./App";
import { Icon } from "./icons";
import { Fold } from "./Motion";
import { ObjectSheets } from "./Objects";
import { isGtm } from "../shared/roles";
import { objectHref, stamp } from "./Objects";
import { PersonAvatar } from "./PersonAvatar";
import { money, num, shortDate } from "./words";

interface Deal { opportunity_id: string; account: string | null; name: string | null; stage: string | null; amount_cents: number; kind: "sourced" | "influenced"; won: boolean; meeting_id: string | null; met: string | null; meeting_at: string | null }
export interface Metrics {
  funnel: { kept: number; sent: number; replied: number; booked: number }; held_all: number;
  cost: { dollars_cents: number }; cost_per_held_cents: number | null;
  influence: { available: boolean; pipeline_cents: number; sourced: { n: number; cents: number }; influenced: { n: number; cents: number }; won: { n: number; cents: number }; deals?: Deal[] };
  control: { available: boolean; basis?: "holdout" | "untouched"; met_accounts: number; met_with_pipeline: number; control_accounts: number; control_with_pipeline: number };
  roi: { pipeline_per_dollar: number | null; cost_missing: string[] };
  score: { held_per_thousand: number; pipeline_per_dollar: number | null } | null;
  past: { pipeline_per_dollar: number | null };
}
export interface Debrief { id: string; author: string; status: string; body: string | null; prompted_at?: string; answered_at: string | null; facts: { theme: string; fact: string; quote: string; account: string | null }[] }

const WINDOWS = [30, 60, 90, 180, 365];
const MIN_HELD = 5;
const THEME: Record<string, string> = { pain: "Their pain", competitor: "Competitors", timing: "Timing", budget: "Budget", product_gap: "What we lack", relationship: "Relationships", general: "Also heard" };
const addDays = (ymd: string, d: number) => { const x = new Date(`${ymd}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const times = (x: number) => `${x.toFixed(1)}x`;

/** Which reading leads: the latest written scorecard once the event is scored, its live reading while it closes. */
export function pickMetrics(motion: string, live: Metrics | null, scorecards: { window_days: number; metrics: Metrics }[]) {
  const written = [...scorecards].sort((a, b) => a.window_days - b.window_days), latest = written.at(-1);
  const m = motion === "scored" && latest ? latest.metrics : live ?? latest?.metrics ?? null;
  return { m, written, latest };
}

export function Result({ eventId, eventName, motion, lastDay, live, scorecards, debriefs, lead, onChange }: {
  eventId: string; eventName: string; motion: string; lastDay: string | null; live: Metrics | null;
  scorecards: { window_days: number; metrics: Metrics }[]; debriefs: Debrief[]; lead: boolean; onChange: () => void;
}) {
  const { actor, go } = useActor();
  const [busy, setBusy] = useState(false), [draft, setDraft] = useState("");
  const { m, latest } = pickMetrics(motion, live, scorecards);
  if (!m) return null;
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); onChange(); } finally { setBusy(false); } };
  const ratio = m.roi.pipeline_per_dollar, thin = m.held_all < MIN_HELD;
  const deals = m.influence.deals ?? [];
  const daysAfter = lastDay ? Math.max(0, Math.round((Date.now() - Date.parse(`${lastDay}T12:00:00Z`)) / 86_400_000)) : null;
  const kicker = motion === "scored" && latest ? `Scored, day ${latest.window_days}` : daysAfter !== null ? `So far, day ${daysAfter}` : "So far";
  const mine = debriefs.find((d) => d.author === actor && d.status === "waiting");
  const sentMine = debriefs.find((d) => d.author === actor && d.status === "answered");
  const toReview = lead ? debriefs.filter((d) => d.status === "answered") : [];
  const facts = debriefs.flatMap((d) => d.facts.map((f) => ({ ...f, author: d.author })));
  const themes = [...new Set(facts.map((f) => f.theme))];

  return (
    <section className="result" aria-label="What the event returned">
      {/* One verdict. Leadership: the multiple, set large, with what it is made of under it. Everyone else: meetings held. */}
      <header className="md-hero rs-hero">
        <div className="md-hello">
          <p>{kicker}</p>
          {lead && m.influence.available
            ? <h2><b className={thin ? "thin" : undefined}>{ratio === null ? "None" : times(ratio)}</b><span>{money(m.influence.pipeline_cents)} in pipeline for {money(m.cost.dollars_cents)}{thin ? ", too few meetings to rank" : ""}</span></h2>
            : <h2><b>{num(m.held_all)}</b><span>{m.held_all === 1 ? "meeting held" : "meetings held"}</span></h2>}
        </div>
        <div className="md-figs">
          {lead ? <><p><b>{num(m.held_all)}</b><span>{m.held_all === 1 ? "meeting held" : "meetings held"}</span></p><p><b>{num(deals.length)}</b><span>{deals.length === 1 ? "deal" : "deals"}</span></p></>
            : <><p><b>{num(m.funnel.sent)}</b><span>reached</span></p><p><b>{num(m.funnel.replied)}</b><span>{m.funnel.replied === 1 ? "reply" : "replies"}</span></p></>}
        </div>
      </header>

      {lead && deals.length > 0 && (
        <div className="rs-sec">
          <h3 className="rs-h">The deals<span>{deals.length}</span></h3>
          <ul className="ob-tray">{deals.map((d, i) => {
            const row = (
              <>
                <span className="ob-face"><PersonAvatar name={d.met ?? d.account ?? "Account"} size={36} /></span>
                <span className="ob-who"><b>{d.account ?? "An account"}</b><span>{[d.name, d.stage].filter(Boolean).join(" · ")}</span></span>
                <span className="rs-amount"><b>{money(d.amount_cents)}</b><span>{d.won ? "Won" : d.kind === "sourced" ? "New pipeline" : "Moved forward"}</span></span>
                <span className="ob-end"><span className="ob-when">{d.met ? `Met ${d.met.split(" ")[0]}${d.meeting_at ? `, ${stamp(d.meeting_at).split(",")[0]}` : ""}` : "Met"}</span>{d.meeting_id && <span className="ob-go">Open<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></span>}</span>
              </>
            );
            return <li key={d.opportunity_id} style={{ "--i": i } as CSSProperties}>{d.meeting_id ? <Link to={objectHref("meeting", d.meeting_id)} go={go} className="ob-row rs-deal" data-opens-sheet="">{row}</Link> : <div className="ob-row rs-deal">{row}</div>}</li>;
          })}</ul>
        </div>
      )}

      <div className="rs-sec">
        <h3 className="rs-h">What we learned</h3>
        {themes.length > 0 ? (
          <div className="rs-learned">{themes.map((t) => (
            <section key={t}>
              <h4>{THEME[t] ?? t}</h4>
              <ul>{facts.filter((f) => f.theme === t).map((f, i) => (
                <li key={i}><p>{f.fact}</p>{f.quote && <q>{f.quote}</q>}<span>{[f.author.split(" ")[0], f.account].filter(Boolean).join(" · ")}</span></li>
              ))}</ul>
            </section>
          ))}</div>
        ) : !mine && !toReview.length && <p className="m-line">{sentMine ? "Your notes are with leadership to review. Once accepted, they show here." : "Nothing written yet. Each rep who held a meeting is asked how it went, a few days after the event."}</p>}

        {debriefs.length > 0 && (
          <ul className="rs-notes" aria-label="Who has written">{debriefs.map((d) => {
            const days = d.prompted_at ? Math.max(0, Math.round((Date.now() - Date.parse(d.prompted_at)) / 86_400_000)) : null;
            const state = d.status === "accepted" ? "Accepted" : d.status === "rejected" ? "Left out" : d.status === "answered" ? "Written, waiting for review" : `Not written${days !== null ? `, asked ${days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`}` : ""}`;
            return <li key={d.id} className={d.status === "waiting" ? "owed" : undefined}><PersonAvatar name={d.author} size={26} /><b>{d.author}</b><span>{state}</span></li>;
          })}</ul>
        )}

        {toReview.map((d) => (
          <article key={d.id} className="rs-review">
            <p className="rs-review-k"><b>{d.author}</b> wrote{d.answered_at ? ` on ${shortDate(d.answered_at.slice(0, 10))}` : ""}. Accepted notes join what we learned.</p>
            <p className="rs-review-body">{d.body}</p>
            <div className="ob-acts">
              <button className="btn small" disabled={busy} onClick={() => act(() => send("POST", `/api/motion/debriefs/${d.id}/review`, actor, { status: "accepted" }))}>Accept</button>
              <button className="btn small line" disabled={busy} onClick={() => act(() => send("POST", `/api/motion/debriefs/${d.id}/review`, actor, { status: "rejected" }))}>Leave it out</button>
            </div>
          </article>
        ))}

        {mine && (
          <form className="rs-write" onSubmit={(e) => { e.preventDefault(); act(() => send("POST", `/api/motion/debriefs/${mine.id}/answer`, actor, { body: draft })); setDraft(""); }}>
            <label><span>How was {eventName}? A few lines is plenty: who mattered, what they said, what you would do differently.</span>
              <textarea className="input" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} required /></label>
            <button className="btn small" disabled={busy || !draft.trim()}>Send</button>
          </form>
        )}
      </div>
    </section>
  );
}

/** For leadership, in a fold below: why the verdict holds. Met against not met, where the pipeline came from, how it moved, and the costs still to enter. */
export function ResultEvidence({ eventId, motion, lastDay, live, scorecards, onChange }: { eventId: string; motion: string; lastDay: string | null; live: Metrics | null; scorecards: { window_days: number; metrics: Metrics }[]; onChange: () => void }) {
  const { actor } = useActor();
  const [busy, setBusy] = useState(false), [cost, setCost] = useState({ category: "", amount: "" });
  const { m, written } = pickMetrics(motion, live, scorecards);
  if (!m) return null;
  const c = m.control, pipeline = Math.max(m.influence.pipeline_cents, 1);
  const values = written.map((w) => w.metrics.influence.pipeline_cents), still = values.length > 1 && values.every((v) => v === values[0]);
  const next = lastDay ? WINDOWS.find((w) => !written.some((x) => x.window_days === w)) : undefined;
  const add = async () => { setBusy(true); try { await send("POST", `/api/events/${eventId}/motion/costs`, actor, { category: cost.category || m.roi.cost_missing[0], amount_cents: Math.round(Number(cost.amount) * 100) }); setCost({ category: "", amount: "" }); onChange(); } finally { setBusy(false); } };
  const top = Math.max(1, ...values);
  const credits = Object.values((m.cost as { credits_by_step?: Record<string, number> }).credits_by_step ?? {}).reduce((n, x) => n + x, 0);
  return (
    <div className="rs-evidence">
      <div className="brief">
        {c.available && (
          <div>
            <h3>Accounts with pipeline</h3>
            <ul>
              <li className="brow"><span>Ones we met</span><i aria-hidden="true"><u className="t1" style={{ width: `${pct(c.met_with_pipeline, c.met_accounts)}%` }} /></i><b>{pct(c.met_with_pipeline, c.met_accounts)}%</b></li>
              <li className="brow"><span>{c.basis === "holdout" ? "Ones held out at random" : "Ones on the list we never reached"}</span><i aria-hidden="true"><u className="t3" style={{ width: `${pct(c.control_with_pipeline, c.control_accounts)}%` }} /></i><b>{pct(c.control_with_pipeline, c.control_accounts)}%</b></li>
            </ul>
          </div>
        )}
        {m.influence.available && (
          <div>
            <h3>Where the pipeline came from</h3>
            <ul className="money">
              <li className="brow"><span>New after a meeting</span><i aria-hidden="true"><u className="t1" style={{ width: `${pct(m.influence.sourced.cents, pipeline)}%` }} /></i><b>{money(m.influence.sourced.cents)}</b></li>
              <li className="brow"><span>Moved forward</span><i aria-hidden="true"><u className="t2" style={{ width: `${pct(m.influence.influenced.cents, pipeline)}%` }} /></i><b>{money(m.influence.influenced.cents)}</b></li>
              <li className="brow"><span>Won</span><i aria-hidden="true"><u className="t1" style={{ width: `${pct(m.influence.won.cents, pipeline)}%` }} /></i><b>{money(m.influence.won.cents)}</b></li>
            </ul>
          </div>
        )}
      </div>

      {written.length > 0 && (still
        ? <p className="rs-line">Unchanged since day {written[0].window_days}.{next && lastDay ? ` Next reading, day ${next}, on ${shortDate(addDays(lastDay, next))}.` : ""}</p>
        : (
          <ol className="rs-steps">{WINDOWS.map((w, i) => {
            const s = written.find((x) => x.window_days === w);
            return (
              <li key={w} className={s ? "done" : undefined} style={{ "--i": i, "--h": s ? s.metrics.influence.pipeline_cents / top : 0 } as CSSProperties}>
                <span className="rs-bar"><i /></span>
                <b>{s ? money(s.metrics.influence.pipeline_cents) : lastDay ? shortDate(addDays(lastDay, w)) : "Later"}</b>
                <span>Day {w}</span>
              </li>
            );
          })}</ol>
        ))}

      <dl className="sheet-facts rs-cost">
        <div><dt>Cost</dt><dd>{money(m.cost.dollars_cents)}{m.cost_per_held_cents !== null ? `, ${money(m.cost_per_held_cents)} per meeting held` : ""}{credits > 0 ? `, plus ${num(credits)} prepaid data credits` : ""}</dd></div>
        {m.roi.cost_missing.length > 0 && (
          <div><dt>Not entered</dt><dd>
            <form className="m-act" onSubmit={(e) => { e.preventDefault(); add(); }}>
              <select aria-label="Cost" value={cost.category || m.roi.cost_missing[0]} onChange={(e) => setCost({ ...cost, category: e.target.value })}>{m.roi.cost_missing.map((x) => <option key={x} value={x}>{x === "rep_time" ? "Rep time" : x[0].toUpperCase() + x.slice(1)}</option>)}</select>
              <input aria-label="US dollars" inputMode="decimal" placeholder="$" value={cost.amount} onChange={(e) => setCost({ ...cost, amount: e.target.value })} required />
              <button className="btn small line" disabled={busy}>Add</button>
            </form>
          </dd></div>
        )}
      </dl>
    </div>
  );
}

/** The Result tab of a finished event: the verdict, the deals, what we learned, and for leadership how we know, folded below. */
export function ResultView({ id, name, onChange }: { id: string; name: string; onChange: () => void }) {
  const { actor, needs } = useActor();
  const lead = isGtm(actor) || Boolean(needs?.approvers.includes(actor));
  const [o, setO] = useState<{ motion: string; live_score: Metrics | null; scorecards: { window_days: number; metrics: Metrics }[]; debriefs: Debrief[]; post_event: { last_day: string } | null } | null>(null);
  const load = async () => setO(await get(`/api/events/${id}/motion`));
  useEffect(() => { load(); }, [id]);
  if (!o) return null;
  const changed = () => { load(); onChange(); };
  const lastDay = o.post_event?.last_day ?? null;
  const c = pickMetrics(o.motion, o.live_score, o.scorecards ?? []).m?.control;
  return (
    <section className="result-view" data-ready="1">
      <Result eventId={id} eventName={name} motion={o.motion} lastDay={lastDay} live={o.live_score} scorecards={o.scorecards ?? []} debriefs={o.debriefs ?? []} lead={lead} onChange={changed} />
      {lead && (
        <div className="folds">
          <Fold icon={<Icon.cost />} title="How we know" peek={c?.available ? <>{pct(c.met_with_pipeline, c.met_accounts)}% of met accounts have pipeline<i>{pct(c.control_with_pipeline, c.control_accounts)}% of the rest</i></> : undefined}>
            <ResultEvidence eventId={id} motion={o.motion} lastDay={lastDay} live={o.live_score} scorecards={o.scorecards ?? []} onChange={changed} />
          </Fold>
        </div>
      )}
      <ObjectSheets changed={changed} />
    </section>
  );
}
