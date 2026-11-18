/* Waiting on you (decision 115): seat requests, plans and abstracts that wait on this person, across events, each linking to the item. The seat part is the fallback for deciding a seat request when Slack is not connected (decision 103). A plain list of what this person
   may decide, with the facts, and Approve and Decline. It calls the route that runs the same decideSeat Slack runs, so a decision here
   and a decision in Slack are the same decision, and a request already decided cannot be decided again. */

import { useEffect, useState } from "react";
import { ApproveSeat } from "./Seats";
import { get, send, GOAL_WORDS, type SeatRequest } from "./api";
import { Link, useActor } from "./App";
import { money, shortDate } from "./words";
import { BlockSkeleton } from "./Skeleton";

interface Res { requests: SeatRequest[]; slack: boolean }
interface Waits { seats: unknown[]; plans: { event_id: string; event: string; starts_on: string; who: string; asked_on: string }[]; abstracts: { event_id: string; event: string; starts_on: string; talk_id: string; title: string; who: string }[]; total: number }

function Row({ r, onDone }: { r: SeatRequest; onDone: () => void }) {
  const { actor } = useActor();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [approving, setApproving] = useState(false);
  const decide = async (decision: "approve" | "decline", note = reason) => {
    setBusy(true);
    const x = await send("POST", `/api/seat-decisions/${r.id}`, actor, { decision, reason: note });
    setBusy(false);
    setApproving(false);
    if (!x.ok) { setError(x.error); if (/^Already /.test(x.error)) onDone(); return; }
    onDone();
  };
  return (
    <article className="seat-group" data-request={r.id} style={{ display: "grid", gap: 8, padding: "12px 0" }}>
      {approving && <ApproveSeat r={r} busy={busy} error={error} onApprove={(note) => decide("approve", note)} onClose={() => { setApproving(false); setError(""); }} />}
      <h3 style={{ margin: 0 }}>{r.requester}, {r.role}, {r.team}</h3>
      <p className="small mute" style={{ margin: 0 }}>
        Seat at {r.name}, {shortDate(r.starts_on)}. {r.price_is_estimate ? "Ticket est." : "Ticket"} {money(r.seat_price_cents)}{r.travel_cents ? `, travel ${money(r.travel_cents)}` : ""}.
        {" "}Goal: {GOAL_WORDS[r.goal]}, {r.expected_meetings} meetings.{r.decide_by ? ` Decide by ${shortDate(r.decide_by)}.` : ""}
        {r.budget ? ` ${r.budget.left_after < 0 ? `Over Q${r.budget.quarter}: ${money(r.budget.left_after)}` : `Q${r.budget.quarter} left: ${money(r.budget.left_after)}`}` : ""}
      </p>
      <p style={{ margin: 0 }}><b>Why this event:</b> {r.why_event}</p>
      <p style={{ margin: 0 }}><b>Why {r.requester.split(" ")[0]}:</b> {r.why_you}</p>
      {r.known_accounts && <p style={{ margin: 0 }}><b>Known accounts:</b> {r.known_accounts}</p>}
      {declining && <label className="field"><span>Why are you declining?</span><input className="input" value={reason} onChange={(ev) => setReason(ev.target.value)} autoFocus /></label>}
      {error && <p role="alert" className="error small">{error}</p>}
      <div className="actions">
        {!declining && <button className="btn small" type="button" disabled={busy} onClick={() => { setError(""); setApproving(true); }}>Approve</button>}
        {!declining && <button className="btn line small" type="button" disabled={busy} onClick={() => setDeclining(true)}>Decline</button>}
        {declining && <button className="btn small" type="button" disabled={busy || !reason.trim()} onClick={() => decide("decline")}>Send the decline</button>}
        {declining && <button className="textlink" type="button" onClick={() => { setDeclining(false); setError(""); }}>Back</button>}
      </div>
    </article>
  );
}

export function SeatDecisions() {
  const { actor, refresh, go } = useActor();
  const [res, setRes] = useState<Res | null | undefined>(undefined), [w, setW] = useState<Waits | null | undefined>(undefined);
  const only = new URLSearchParams(location.search).get("request");
  const load = async () => { setRes(await get<Res>("/api/seat-decisions")); setW(await get<Waits>("/api/waiting")); };
  useEffect(() => { void load(); }, [actor]);
  const done = () => { void load(); void refresh(); };
  const seats = (res?.requests ?? []).filter((r) => !only || r.id === only);
  const hidden = (res?.requests.length ?? 0) - seats.length;
  const loading = res === undefined || w === undefined;
  const none = !loading && !seats.length && !hidden && !w?.plans.length && !w?.abstracts.length;
  return (
    <>
      <header className="hero" data-ready="1"><div><h1>Waiting on you</h1></div></header>
      {loading && <BlockSkeleton />}
      {!loading && (
        <>
          {res?.slack && <p className="small mute">Also in Slack</p>}
          {seats.length > 0 && <section className="pl-sec" aria-label="Seat requests"><h2>Seat requests<span className="mute"> {res!.requests.length}</span></h2>
            <div className="pl-body">{seats.map((r) => <Row key={r.id} r={r} onDone={done} />)}</div></section>}
          {hidden > 0 && <p className="small"><Link to="/seat-decisions" go={go}>{`All ${res!.requests.length} seat requests`}</Link></p>}
          {(w?.plans.length ?? 0) > 0 && <section className="pl-sec" aria-label="Plans"><h2>Plans<span className="mute"> {w!.plans.length}</span></h2>
            <div className="pl-body"><ul className="pl-rows">{w!.plans.map((p) => (
              <li className="pl-row" key={p.event_id}><span className="pl-what"><b><Link to={`/event/${p.event_id}#plan`} go={go}>{p.event}</Link></b><span>Asked by {p.who}, {shortDate(p.asked_on)}</span></span><span className="pl-end">{shortDate(p.starts_on)}</span></li>
            ))}</ul></div></section>}
          {(w?.abstracts.length ?? 0) > 0 && <section className="pl-sec" aria-label="Abstracts"><h2>Abstracts<span className="mute"> {w!.abstracts.length}</span></h2>
            <div className="pl-body"><ul className="pl-rows">{w!.abstracts.map((a) => (
              <li className="pl-row" key={a.talk_id}><span className="pl-what"><b><Link to={`/event/${a.event_id}#plan`} go={go}>{a.title || "Untitled talk"}</Link></b><span>{a.event}, written by {a.who}</span></span><span className="pl-end">{a.starts_on ? shortDate(a.starts_on) : ""}</span></li>
            ))}</ul></div></section>}
          {none && <p className="mute gap">Nothing is waiting on you.</p>}
        </>
      )}
    </>
  );
}
