/* Request a seat: one person, their own seat. Pick an upcoming event from the catalog, or say yours
   is not listed and suggest it; the suggestion goes through the same approval. The server checks
   everything again. */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { GOAL_WORDS, send, type CatalogEntry, type Goal } from "./api";
import { useActor } from "./App";
import { money, shortDate, todayYmd } from "./words";

const MIN_WHY = 20;
const going = (c: CatalogEntry) => [c.going ? `${c.going} going` : "", c.waiting ? `${c.waiting} waiting` : ""].filter(Boolean).join(", ");
const range = (c: Pick<CatalogEntry, "starts_on" | "ends_on">) => (c.ends_on && c.ends_on !== c.starts_on ? `${shortDate(c.starts_on)} to ${shortDate(c.ends_on)}` : shortDate(c.starts_on));

function EventPicker({ catalog, value, onPick, onUnlisted }: { catalog: CatalogEntry[]; value: CatalogEntry | null; onPick: (c: CatalogEntry) => void; onUnlisted: () => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const today = todayYmd();
  const rows = useMemo(() => catalog.filter((c) => c.ends_on >= today && (!q.trim() || `${c.name} ${c.city} ${c.country}`.toLowerCase().includes(q.trim().toLowerCase()))), [catalog, q, today]);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => {
    const away = (ev: MouseEvent) => { if (box.current && !box.current.contains(ev.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, []);
  const pick = (c: CatalogEntry) => { onPick(c); setQ(""); setOpen(false); };
  const total = rows.length + 1;
  const onKey = (ev: React.KeyboardEvent) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); setOpen(true); setAt((at + 1) % total); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setAt((at + total - 1) % total); }
    else if (ev.key === "Enter" && open) { ev.preventDefault(); if (at < rows.length) pick(rows[at]); else { setOpen(false); onUnlisted(); } }
    else if (ev.key === "Escape") setOpen(false);
  };
  return (
    <div className="picker" ref={box}>
      <label className="field"><span>Event</span>
        <input className="input" role="combobox" aria-expanded={open} aria-controls="event-options" aria-autocomplete="list" autoComplete="off" placeholder={value ? `${value.name}` : "Search upcoming events"} value={q}
          onChange={(ev) => { setQ(ev.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={onKey} />
      </label>
      {open && (
        <ul className="options" id="event-options" role="listbox">
          {rows.slice(0, 40).map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === at} className={i === at ? "on" : undefined} onMouseDown={(ev) => { ev.preventDefault(); pick(c); }}>
              <span className="o-name">{c.name}</span>
              <span className="small mute">{[range(c), c.city, going(c)].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
          <li role="option" aria-selected={at === rows.length} className={`unlisted${at === rows.length ? " on" : ""}`} onMouseDown={(ev) => { ev.preventDefault(); setOpen(false); onUnlisted(); }}>My event isn't listed</li>
        </ul>
      )}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

/** A panel floating over the page, which stays where it was. Esc or a click outside closes it, unless something has been typed; the close control always does. */
function FloatingSheet({ title, canDismiss, onClose, children }: { title: string; canDismiss: boolean; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);
  const dismiss = useRef({ canDismiss, onClose });
  dismiss.current = { canDismiss, onClose };
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); if (dismiss.current.canDismiss) dismiss.current.onClose(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      const els = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length);
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; before?.focus?.(); };
  }, []);
  return createPortal(
    <div className="float-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && dismiss.current.canDismiss) dismiss.current.onClose(); }}>
      <aside className="float" ref={panel} role="dialog" aria-modal="true" aria-label={title}>
        <header className="float-h"><h2 className="display">{title}</h2><button className="sheet-x" type="button" aria-label="Close" onClick={onClose}>&times;</button></header>
        <div className="float-b">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

export function RequestSeats({ preselect, onDone, onClose }: { preselect?: string | null; onDone: () => void; onClose: () => void }) {
  const { actor, needs, refresh } = useActor();
  const catalog = needs?.catalog ?? [];
  const mine = needs?.requests.filter((r) => r.requester === actor).at(-1);
  const [chosen, setChosen] = useState<CatalogEntry | null>(null);
  const [unlisted, setUnlisted] = useState(false);
  const [s, setS] = useState({ name: "", website: "", starts_on: "", ends_on: "", city: "", country: "", price: "" });
  const [f, setF] = useState({ team: "", role: "", goal: "" as Goal | "", why_event: "", why_you: "", meetings: "", known: "", travel: "", decide_by: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (preselect && !chosen) { const c = catalog.find((x) => x.id === preselect); if (c) setChosen(c); } }, [preselect, catalog.length]);
  useEffect(() => { if (mine && !f.team && !f.role) setF((x) => ({ ...x, team: mine.team, role: mine.role })); }, [mine?.id]);
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  const sset = (k: keyof typeof s) => (ev: { target: { value: string } }) => setS({ ...s, [k]: ev.target.value });
  const teams = [...new Set((needs?.requests ?? []).map((r) => r.team))].sort();

  const ticket = unlisted ? Math.round(Number(s.price) * 100) || 0 : chosen?.seat_price_cents ?? 0;
  const travel = f.travel ? Math.round(Number(f.travel) * 100) || 0 : 0;
  const ready = (unlisted ? Boolean(s.name && s.starts_on && s.city && s.country && s.website && s.price !== "") : Boolean(chosen)) && f.team.trim() && f.role.trim() && f.goal && f.why_event.trim().length >= MIN_WHY && f.why_you.trim().length >= MIN_WHY && f.meetings !== "";
  const left = (v: string) => (v.trim().length >= MIN_WHY ? "" : `${MIN_WHY - v.trim().length} more characters`);

  const submit = async (ev: { preventDefault(): void }) => {
    ev.preventDefault();
    setBusy(true); setError("");
    const body: Record<string, unknown> = {
      team: f.team, role: f.role, goal: f.goal, why_event: f.why_event, why_you: f.why_you, expected_meetings: f.meetings === "" ? undefined : Number(f.meetings),
      known_accounts: f.known || undefined, travel_dollars: f.travel === "" ? undefined : Number(f.travel), decide_by: f.decide_by || undefined,
      ...(unlisted ? { suggestion: { name: s.name, website: s.website, starts_on: s.starts_on, ends_on: s.ends_on || s.starts_on, city: s.city, country: s.country, price_dollars: s.price === "" ? undefined : Number(s.price) } } : { catalog_id: chosen?.id }),
    };
    const r = await send("POST", "/api/seat-requests", actor, body);
    setBusy(false);
    if (r.ok) { await refresh(); onDone(); } else setError(r.error);
  };

  const typed = unlisted || Boolean(chosen && chosen.id !== preselect) || Boolean(f.goal || f.why_event || f.why_you || f.meetings || f.known || f.travel || f.decide_by);
  return (
    <FloatingSheet title="Request a seat" canDismiss={!typed && !busy} onClose={onClose}>
    <form className="form seatform" onSubmit={submit} aria-label="Request a seat">
      {!unlisted && <EventPicker catalog={catalog} value={chosen} onPick={setChosen} onUnlisted={() => { setUnlisted(true); setChosen(null); }} />}
      {!unlisted && chosen && (
        <p className="chosen"><b>{chosen.name}</b><span className="mute">{[range(chosen), [chosen.city, chosen.country].filter(Boolean).join(", "), `${money(chosen.seat_price_cents)}${chosen.price_is_estimate ? " estimate" : ""}`, going(chosen)].filter(Boolean).join(" · ")}</span></p>
      )}
      {unlisted && (
        <fieldset className="suggest">
          <legend>New event</legend>
          <label className="field"><span>Name</span><input className="input" value={s.name} onChange={sset("name")} autoComplete="off" required /></label>
          <label className="field"><span>Website</span><input className="input" type="url" inputMode="url" placeholder="https://" value={s.website} onChange={sset("website")} required /></label>
          <div className="two">
            <label className="field"><span>Starts</span><input className="input" type="date" value={s.starts_on} onChange={sset("starts_on")} required /></label>
            <label className="field"><span>Ends</span><input className="input" type="date" value={s.ends_on} min={s.starts_on} onChange={sset("ends_on")} /></label>
          </div>
          <div className="two">
            <label className="field"><span>City</span><input className="input" value={s.city} onChange={sset("city")} autoComplete="off" required /></label>
            <label className="field"><span>Country</span><input className="input" value={s.country} onChange={sset("country")} autoComplete="off" required /></label>
          </div>
          <label className="field"><span>Ticket price, dollars</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={s.price} onChange={sset("price")} required /></label>
          <button className="textlink" type="button" onClick={() => setUnlisted(false)}>Choose a listed event</button>
        </fieldset>
      )}

      <div className="two">
        <label className="field"><span>Team</span><input className="input" list="teams" value={f.team} onChange={set("team")} autoComplete="off" required /><datalist id="teams">{teams.map((t) => <option key={t} value={t} />)}</datalist></label>
        <label className="field"><span>Your role</span><input className="input" value={f.role} onChange={set("role")} autoComplete="off" required /></label>
      </div>
      <label className="field"><span>Main goal</span>
        <select className="input" value={f.goal} onChange={set("goal")} required><option value="" disabled>Choose one</option>{(Object.keys(GOAL_WORDS) as Goal[]).map((g) => <option key={g} value={g}>{GOAL_WORDS[g]}</option>)}</select>
      </label>
      <label className="field"><span>Why this event</span><textarea className="input itext" rows={3} value={f.why_event} onChange={set("why_event")} required /><small className="mute">{left(f.why_event)}</small></label>
      <label className="field"><span>Why you</span><textarea className="input itext" rows={3} value={f.why_you} onChange={set("why_you")} required /><small className="mute">{left(f.why_you)}</small></label>
      <div className="two">
        <label className="field"><span>Meetings you expect</span><input className="input" type="number" min="0" inputMode="numeric" value={f.meetings} onChange={set("meetings")} required /></label>
        <label className="field"><span>Travel per person, dollars (optional)</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={f.travel} onChange={set("travel")} /></label>
      </div>
      <label className="field"><span>Accounts you know will be there (optional)</span><input className="input" value={f.known} onChange={set("known")} autoComplete="off" /></label>
      <label className="field"><span>Decide by (optional)</span><input className="input" type="date" value={f.decide_by} onChange={set("decide_by")} /></label>
      {(chosen || (unlisted && ticket > 0)) && <p className="total">One ticket {money(ticket)}{travel ? ` plus travel ${money(travel)}` : ""}{travel ? `, ${money(ticket + travel)}` : ""}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button className="btn" type="submit" disabled={busy || !ready}>{busy ? "Sending…" : "Send for approval"}</button>
        <button className="textlink" type="button" onClick={onClose}>Not now</button>
      </div>
    </form>
    </FloatingSheet>
  );
}
