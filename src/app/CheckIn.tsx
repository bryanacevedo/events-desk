/* Check-in at the door, on a phone (docs/HOSTED.md 11). Search first; the guests who are still expected, on the waitlist or who never answered sit in trays, and the people already in
   sit last. One primary action at a time: Check in for the guest the search found, Add a walk-in when nothing matches, Close the door once everyone expected is in. */

import { useState } from "react";
import { send, type GuestOut, type HostedPage } from "./api";
import { PEOPLE, useActor } from "./App";
import { ConfirmDialog } from "./Patterns";
import { PersonAvatar } from "./PersonAvatar";
import { initials } from "./words";

const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase() : "");
const seatOf = (g: GuestOut) => g.seat;

export function CheckIn({ id, page, reload, go }: { id: string; page: HostedPage; reload: () => Promise<void>; go: (to: string) => void }) {
  const { actor } = useActor();
  const [q, setQ] = useState(""), [open, setOpen] = useState<string | null>(null), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const [walk, setWalk] = useState({ name: "", company: "", owner: page.settings.host_name || actor, email: "", seat: "" });
  const [closing, setClosing] = useState(false);
  const { event: ev, counts: c, guests } = page;
  const closed = Boolean(ev.closed_at), cap = c.capacity;
  const searching = q.trim() !== "";

  const left = guests.filter((g) => g.status === "registered");
  const inn = guests.filter((g) => g.status === "attended").sort((a, b) => (b.checked_in_at ?? "").localeCompare(a.checked_in_at ?? ""));
  const room = cap === null ? null : cap - inn.length - (closed ? 0 : left.length);
  const found = searching ? guests.filter((g) => g.name.toLowerCase().includes(q.trim().toLowerCase()) || g.company.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => Number(a.status === "attended") - Number(b.status === "attended")) : null;
  const target = found?.find((g) => g.status !== "attended") ?? null;
  const addMode = found !== null && found.length === 0;

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(key); setError("");
    const r = await fn();
    setBusy("");
    if (!r.ok) { setError(r.error ?? ""); return false; }
    await reload();
    return true;
  };
  const checkIn = async (g: GuestOut) => { if (await run(g.id, () => send("POST", `/api/events/${id}/guests/${g.id}/check-in`, actor))) { setQ(""); setOpen(null); } };
  const undo = (g: GuestOut) => run(g.id, () => send("POST", `/api/events/${id}/guests/${g.id}/undo-check-in`, actor));
  const addWalkIn = async () => {
    const name = (walk.name || q).trim();
    if (!name) return;
    const ok = await run("walk", async () => {
      const r = await send<{ id: string }>("POST", `/api/events/${id}/walk-ins`, actor, { name, company: walk.company, owner: walk.owner, email: walk.email || null });
      if (r.ok && walk.seat.trim()) await send("PATCH", `/api/events/${id}/guests/${r.data.id}`, actor, { seat: walk.seat.trim() });
      return r;
    });
    if (ok) { setQ(""); setWalk({ ...walk, name: "", company: "", email: "", seat: "" }); }
  };
  const close = async () => { if (await run("close", () => send("POST", `/api/events/${id}/close-attendance`, actor))) setClosing(false); };
  const saveSeat = async (g: GuestOut, seat: string) => { if (seat !== g.seat) await run(`seat-${g.id}`, () => send("PATCH", `/api/events/${id}/guests/${g.id}`, actor, { seat })); };

  const row = (g: GuestOut) => {
    const isTarget = target?.id === g.id, more = isTarget || open === g.id, isIn = g.status === "attended";
    const quiet = isIn ? (closed ? null : <button type="button" className="textlink ci-q" disabled={busy === g.id} onClick={() => undo(g)}>Undo</button>)
      : isTarget ? <span /> : <button type="button" className="textlink ci-q" disabled={busy === g.id} onClick={() => checkIn(g)}>Check in</button>;
    return (
      <li className={`ci-row${isTarget ? " target decide-halo" : ""}`} key={g.id}>
        <span className="ci-face" aria-hidden="true">{initials(g.name)}</span>
        <button type="button" className="ci-who" aria-expanded={more} onClick={() => setOpen(open === g.id ? null : g.id)}><b>{g.name}</b><span>{g.company}</span></button>
        <span className="ci-end">{isIn && <span>{clock(g.checked_in_at)}</span>}<span>{isIn && g.status !== "attended" ? g.status_word : seatOf(g)}</span></span>
        {quiet ?? <span />}
        {more && (
          <div className="ci-more">
            <dl className="ci-facts">
              {found && <div><dt>Status</dt><dd><b>{g.status_word}</b></dd></div>}
              <div><dt>Owner</dt><dd>{g.owner}</dd></div>
              <div><dt>Seat or table</dt><dd>{g.can_write ? <input className="input" defaultValue={g.seat} maxLength={60} aria-label={`Seat or table for ${g.name}`} placeholder="Optional" onBlur={(ev) => saveSeat(g, ev.target.value.trim())} autoComplete="off" /> : g.seat || "None"}</dd></div>
            </dl>
            {isTarget && <button type="button" className="btn big" disabled={busy === g.id} onClick={() => checkIn(g)}>Check in</button>}
          </div>
        )}
      </li>
    );
  };
  const tray = (title: string, rows: GuestOut[]) => rows.length ? <section className="ci-tray" aria-label={title}><h3>{title}<span>{rows.length}</span></h3><ul>{rows.map(row)}</ul></section> : null;
  const pool = found ?? guests;
  const still = pool.filter((g) => g.status === "registered");
  const waiting = pool.filter((g) => g.status === "waitlist");
  const silent = pool.filter((g) => g.status === "listed" || g.status === "invited");
  const gone = pool.filter((g) => g.status === "no_show");
  const declined = found ? pool.filter((g) => g.status === "declined") : [];
  const isIn = pool.filter((g) => g.status === "attended");
  const allIn = !closed && !searching && left.length === 0 && guests.length > 0;

  return (
    <section className="ci" aria-label="Check-in" data-ready="1">
      <header className="ci-top">
        <button type="button" className="ci-back" aria-label="Back to the guests" onClick={() => go(`/event/${id}#guests`)}><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 4.5-5.5 5.5 5.5 5.5" /></svg></button>
        <div><b>{ev.name}</b><span>{cap === null ? "Check-in" : `Check-in, ${cap} seats`}</span></div>
        <PersonAvatar name={actor} size={32} />
      </header>
      <div className="ci-hero">
        <div className="ci-title"><p>{ev.name}{cap !== null ? `, ${cap} seats` : ""}</p><h1>Check-in</h1></div>
        <dl className="ci-figs" aria-live="polite">
          <div><dd>{inn.length}</dd><dt>in</dt></div>
          {room !== null ? <div><dd>{Math.abs(room)}</dd><dt>{room < 0 ? "over" : "room left"}</dt></div> : <div><dd>{left.length}</dd><dt>{closed ? "no-shows" : "still expected"}</dt></div>}
        </dl>
      </div>

      <div className="ci-find">
        <label className="search"><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="m13.2 13.2 3.3 3.3" /></svg>
          <span className="sr-only">Search by name</span>
          <input type="search" value={q} placeholder="Search by name" autoComplete="off" autoCapitalize="words" spellCheck={false}
            onChange={(e) => { setQ(e.target.value); setOpen(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { if (target) checkIn(target); else if (addMode) addWalkIn(); } if (e.key === "Escape") setQ(""); }} />
          {searching && <button type="button" className="ci-clear" aria-label="Clear the search" onClick={() => setQ("")}>&times;</button>}
        </label>
      </div>

      {error && <p role="alert" className="error">{error}</p>}
      {closed && <p className="ci-closed">{`Door closed ${clock(ev.closed_at)}`}</p>}
      {allIn && <div className="ci-find"><button type="button" className="btn big" onClick={() => setClosing(true)}>Close the door</button></div>}

      {addMode ? (
        <form className="ci-walk" autoComplete="off" onSubmit={(e) => { e.preventDefault(); addWalkIn(); }}>
          <h2>Not on the list</h2>
          <label className="field"><span>Name</span><input className="input" value={walk.name || q} onChange={(e) => setWalk({ ...walk, name: e.target.value })} /></label>
          <label className="field"><span>Company</span><input className="input" value={walk.company} onChange={(e) => setWalk({ ...walk, company: e.target.value })} /></label>
          <label className="field"><span>Owner</span><select className="input" value={walk.owner} onChange={(e) => setWalk({ ...walk, owner: e.target.value })}>{[...new Set([walk.owner, actor, ...PEOPLE])].map((o) => <option key={o}>{o}</option>)}</select></label>
          <label className="field"><span>Email</span><input className="input" type="email" value={walk.email} placeholder="Optional" onChange={(e) => setWalk({ ...walk, email: e.target.value })} /></label>
          {page.can_write && <label className="field"><span>Seat or table</span><input className="input" value={walk.seat} placeholder="Optional" onChange={(e) => setWalk({ ...walk, seat: e.target.value })} /></label>}
          <button type="submit" className="btn big" disabled={busy === "walk"}>Add a walk-in</button>
        </form>
      ) : (
        <div className="ci-cols">
          <div>{tray(closed ? "No-shows" : "Still expected", closed ? gone : still)}</div>
          <div>{tray("Waitlist", waiting)}{tray("Not answered", silent)}{tray("Declined", declined)}</div>
          <div>{tray("In", isIn)}</div>
        </div>
      )}
      {!allIn && !closed && !searching && left.length > 0 && <div className="ci-end-row"><button type="button" className="textlink" onClick={() => setClosing(true)}>Close the door</button></div>}
      {closing && (
        <ConfirmDialog title="Close the door?" confirm="Close the door" cancel="Keep it open" busy={busy === "close"} error={error} onConfirm={close} onClose={() => setClosing(false)}>
          <p>{left.length === 0 ? "Everyone expected is in." : `${left.length} still expected will be marked as no-shows.`}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
