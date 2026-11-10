/* Seats: seat requests grouped by event, one row per person. Approvers decide each one; in demo mode
   through the same rules Slack uses, in a live setup in Slack. Filters (event, status, team, mine)
   live in the URL so a filtered view can be shared. Request a seat opens the form above the list. */

import { send, GOAL_WORDS, type SeatRequest } from "./api";
import { Link, useActor } from "./App";
import { EventBanner } from "./EventBanner";
import { ExpandRow, Flag } from "./Patterns";
import { PersonAvatar } from "./PersonAvatar";
import { RequestSeats } from "./RequestForm";
import { useRef, useState } from "react";
import { Icon } from "./icons";
import { firstName, money, shortDate } from "./words";

function Decide({ r, onDone }: { r: SeatRequest; onDone: () => void }) {
  const { actor, demo, needs } = useActor();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  if (!demo) return <p className="small mute">Decided in Slack.</p>;
  if (!needs?.approvers.includes(actor) || r.requester === actor) return null;
  const decide = async (decision: "approve" | "decline") => {
    setBusy(true);
    const x = await send("POST", `/api/seat-requests/${r.id}/decision`, actor, { decision, reason });
    setBusy(false);
    if (!x.ok) { setError(x.error); return; }
    // The row leaves where it was decided: it slides out and the gap closes, then the list redraws.
    const row = ref.current?.closest<HTMLElement>(".xrow");
    if (row && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      row.style.height = `${row.offsetHeight}px`; void row.offsetHeight;
      row.classList.add("leaving", decision === "approve" ? "yes" : "no");
      await new Promise((ok) => setTimeout(ok, 380));
    }
    onDone();
  };
  return (
    <div ref={ref} style={{ display: "grid", gap: 10 }}>
      {declining && <label className="field"><span>Why are you declining?</span><input className="input" value={reason} onChange={(ev) => setReason(ev.target.value)} autoFocus /></label>}
      {error && <p role="alert" className="error small">{error}</p>}
      <div className="actions">
        {!declining && <button className="btn small" type="button" disabled={busy} onClick={() => decide("approve")}>Approve</button>}
        {!declining && <button className="btn line small" type="button" disabled={busy} onClick={() => setDeclining(true)}>Decline</button>}
        {declining && <button className="btn small" type="button" disabled={busy || !reason.trim()} onClick={() => decide("decline")}>Send the decline</button>}
        {declining && <button className="textlink" type="button" onClick={() => { setDeclining(false); setError(""); }}>Back</button>}
      </div>
    </div>
  );
}

/** An approved seat: what the ticket cost. Approvers record it; Budget counts it as spent. */
function Ticket({ r, onDone }: { r: SeatRequest; onDone: () => void }) {
  const { actor, needs } = useActor();
  const [v, setV] = useState(r.ticket_cents !== null ? String(r.ticket_cents / 100) : "");
  const [error, setError] = useState("");
  const isApprover = Boolean(needs?.approvers.includes(actor));
  const save = async () => {
    const x = await send("PUT", `/api/seat-requests/${r.id}/ticket`, actor, { amount_dollars: Number(v) });
    if (x.ok) { setError(""); onDone(); } else setError(x.error);
  };
  if (!isApprover) return <p className="small mute">{r.ticket_cents !== null ? `Ticket ${money(r.ticket_cents)}` : "Ticket not bought"}</p>;
  return (
    <div className="tinput">
      <label className="sr-only" htmlFor={`t-${r.id}`}>Ticket cost for {r.requester}</label>
      <input id={`t-${r.id}`} className="input" type="number" min="0" step="1" inputMode="numeric" placeholder={String(Math.round(r.seat_price_cents / 100))} value={v} onChange={(ev) => setV(ev.target.value)} />
      <button className="btn line small" type="button" disabled={v === "" || (r.ticket_cents !== null && Number(v) * 100 === r.ticket_cents)} onClick={save}>{r.ticket_cents !== null ? "Update" : "Record ticket cost"}</button>
      {error && <p role="alert" className="error small">{error}</p>}
    </div>
  );
}

const STATUS_WORDS = { waiting: "Waiting", approved: "Approved", declined: "Declined", all: "All" } as const;
type StatusKey = keyof typeof STATUS_WORDS;

export function Seats({ go, search, requesting, preselect }: { go: (to: string) => void; search: URLSearchParams; requesting: boolean; preselect: string | null }) {
  const { needs, actor, refresh } = useActor();
  if (!needs) return null;
  const status = (search.get("status") as StatusKey) in STATUS_WORDS ? (search.get("status") as StatusKey) : "waiting";
  const eventId = search.get("event") ?? "", team = search.get("team") ?? "", mine = search.get("mine") === "1";
  const all = needs.requests;
  const keep = (r: SeatRequest, ignore?: string) =>
    (ignore === "status" || status === "all" || (status === "waiting" ? r.status === "pending" : r.status === status)) &&
    (ignore === "event" || !eventId || r.event_id === eventId) && (ignore === "team" || !team || r.team === team) && (!mine || r.requester === actor);
  const rows = all.filter((r) => keep(r));

  const to = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(search);
    p.delete("request"); p.delete("catalog");
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === "" || (k === "status" && v === "waiting")) p.delete(k); else p.set(k, v); }
    const q = p.toString();
    go(`/seats${q ? `?${q}` : ""}`);
  };
  const events = [...new Map(all.filter((r) => keep(r, "event")).map((r) => [r.event_id, r])).values()].sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  const teams = [...new Set(all.map((r) => r.team))].sort();
  const count = (k: StatusKey) => all.filter((r) => (k === "all" || (k === "waiting" ? r.status === "pending" : r.status === k)) && (!eventId || r.event_id === eventId) && (!team || r.team === team) && (!mine || r.requester === actor)).length;

  const groups = [...new Map(rows.map((r) => [r.event_id, r])).values()].sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.name.localeCompare(b.name));
  const waitingOn = (id: string) => all.filter((r) => r.event_id === id && r.status === "pending").length;
  // Every seat on an event costs the same, so what one approval would leave in the quarter is said once, on the event.
  const headroom = (id: string) => {
    const b = all.find((r) => r.event_id === id && r.status === "pending" && r.budget)?.budget;
    if (!b) return null;
    return b.left_after < 0 ? <Flag cents={b.left_after} words={`over Q${b.quarter} if approved`} over /> : <Flag cents={b.left_after} words={`left in Q${b.quarter} after one seat`} className="mute" />;
  };

  return (
    <>
      <header className="hero" data-ready="1">
        <div><h1>Seats</h1></div>
        <span className="spacer" />
        <Link to="/seats?request=1" go={go} className="btn phone-only">Request a seat</Link>
      </header>

      {requesting && <RequestSeats preselect={preselect} onDone={() => go(needs?.approvers.includes(actor) ? "/seats?mine=1&status=all" : "/my-day")} onClose={() => go("/seats")} />}

      <div className="filters" role="group" aria-label="Filter seat requests">
        <div className="seg" role="group" aria-label="Status">
          {(Object.keys(STATUS_WORDS) as StatusKey[]).map((k) => <button key={k} type="button" aria-pressed={status === k} onClick={() => to({ status: k })}>{STATUS_WORDS[k]} {count(k)}</button>)}
        </div>
        <label className="filter"><span className="sr-only">Event</span>
          <select value={eventId} onChange={(ev) => to({ event: ev.target.value })} aria-label="Event"><option value="">All events</option>{events.map((e) => <option key={e.event_id} value={e.event_id}>{e.name}</option>)}</select>
        </label>
        <label className="filter"><span className="sr-only">Team</span>
          <select value={team} onChange={(ev) => to({ team: ev.target.value })} aria-label="Team"><option value="">All teams</option>{teams.map((t) => <option key={t}>{t}</option>)}</select>
        </label>
        <label className="check"><input type="checkbox" checked={mine} onChange={(ev) => to({ mine: ev.target.checked ? "1" : null })} /><span>Mine</span></label>
      </div>

      <section className="seat-groups" aria-label="Seat requests">
        {groups.map((g) => {
          const mineRows = rows.filter((r) => r.event_id === g.event_id);
          return (
            <article className="seat-group" key={g.event_id} data-event={g.event_id}>
              <EventBanner name={g.name} website={g.website} brandColor={g.brand_color} startsOn={g.starts_on} place={g.venue.split(",").pop()?.trim()}
                going={g.approved_on_event} waiting={waitingOn(g.event_id)} to={`/event/${g.event_id}`} go={go}
                flag={headroom(g.event_id)} />
              {mineRows.map((r) => (
                <ExpandRow className="seat" key={r.id} label={`${r.requester}, why`}
                  head={<>
                    <PersonAvatar name={r.requester} size={32} />
                    <span className="seat-who"><b>{r.requester}</b><span className="small mute">{r.role}, {r.team}</span></span>
                    <span className="seat-stats">
                      <span className="st-goal"><b>{GOAL_WORDS[r.goal]}</b><i>Goal</i></span>
                      <span><b>{r.expected_meetings}</b><i>Meetings</i></span>
                      <span><b>{money(r.seat_price_cents)}</b><i>{r.price_is_estimate ? "Ticket est." : "Ticket"}</i></span>
                      <span>{r.travel_cents ? <><b>{money(r.travel_cents)}</b><i>Travel</i></> : null}</span>
                      <span>{r.decide_by ? <><b>{shortDate(r.decide_by)}</b><i>{r.decide_by < new Date().toISOString().slice(0, 10) && r.status === "pending" ? "Was due" : "Decide by"}</i></> : null}</span>
                    </span>
                  </>}
                  side={r.status === "pending" ? <Decide r={r} onDone={refresh} />
                    : r.status === "approved" ? <><p className="small ok">Approved by {r.decided_by}</p><Ticket r={r} onDone={refresh} /></>
                    : <p className="small mute">Declined by {r.decided_by}{r.decline_reason ? `: ${r.decline_reason}` : ""}</p>}>
                  <div className="why">
                    <section><h4><Icon.events />Why this event</h4><p>{r.why_event}</p></section>
                    <section><h4><Icon.people />Why {firstName(r.requester)}</h4><p>{r.why_you}</p></section>
                    {r.known_accounts && <section className="wide"><h4><Icon.seats />Known accounts</h4><ul>{r.known_accounts.split(/,\s*/).filter(Boolean).map((a) => <li key={a}>{a}</li>)}</ul></section>}
                  </div>
                </ExpandRow>
              ))}
            </article>
          );
        })}
        {!groups.length && <p className="mute gap">{all.length ? "Nothing matches." : "No seat requests."}</p>}
      </section>
    </>
  );
}
