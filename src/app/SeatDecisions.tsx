/* Seat decisions: the fallback for deciding a seat request when Slack is not connected (decision 103). A plain list of what this person
   may decide, with the facts, and Approve and Decline. It calls the route that runs the same decideSeat Slack runs, so a decision here
   and a decision in Slack are the same decision, and a request already decided cannot be decided again. */

import { useEffect, useState } from "react";
import { get, send, GOAL_WORDS, type SeatRequest } from "./api";
import { useActor } from "./App";
import { LOADING } from "./access";
import { money, shortDate } from "./words";

interface Res { requests: SeatRequest[]; slack: boolean }

function Row({ r, onDone }: { r: SeatRequest; onDone: () => void }) {
  const { actor } = useActor();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "approve" | "decline") => {
    setBusy(true);
    const x = await send("POST", `/api/seat-decisions/${r.id}`, actor, { decision, reason });
    setBusy(false);
    if (!x.ok) { setError(x.error); if (/^Already /.test(x.error)) onDone(); return; }
    onDone();
  };
  return (
    <article className="seat-group" data-request={r.id} style={{ display: "grid", gap: 8, padding: "12px 0" }}>
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
        {!declining && <button className="btn small" type="button" disabled={busy} onClick={() => decide("approve")}>Approve</button>}
        {!declining && <button className="btn line small" type="button" disabled={busy} onClick={() => setDeclining(true)}>Decline</button>}
        {declining && <button className="btn small" type="button" disabled={busy || !reason.trim()} onClick={() => decide("decline")}>Send the decline</button>}
        {declining && <button className="textlink" type="button" onClick={() => { setDeclining(false); setError(""); }}>Back</button>}
      </div>
    </article>
  );
}

export function SeatDecisions() {
  const { actor, refresh } = useActor();
  const [res, setRes] = useState<Res | null | undefined>(undefined);
  const load = () => get<Res>("/api/seat-decisions").then(setRes);
  useEffect(() => { void load(); }, [actor]);
  const done = () => { void load(); void refresh(); };
  return (
    <>
      <header className="hero" data-ready="1"><div><h1>Seat decisions</h1></div></header>
      {res === undefined && <p className="mute">{LOADING}</p>}
      {res === null && <p className="md-clear">Seats are for leadership and GTM Engineering.</p>}
      {res && <>
        {res.slack && <p className="small mute">Also in Slack</p>}
        {res.requests.map((r) => <Row key={r.id} r={r} onDone={done} />)}
        {!res.requests.length && <p className="mute gap">No seat requests.</p>}
      </>}
    </>
  );
}
