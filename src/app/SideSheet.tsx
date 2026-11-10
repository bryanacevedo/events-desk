/* The side sheet, shared by Overview and Events. It stays on the page it was opened from: the event is in
   the URL (?event=id), so a card click opens or switches it and closing returns to the same page.
   Closes on a click outside, Esc and the close control. Focus moves in, stays in, and goes back to the card. */

import { SheetButton } from "./Patterns";
import { useEffect, useRef, type CSSProperties } from "react";
import { StageBlock, Stages, useEvent } from "./Event";
import { useActor } from "./App";
import { EventLogo } from "./EventLogo";
import { PersonAvatar } from "./PersonAvatar";
import { city, countdown, daysTo, plural, shortDate } from "./words";
import { deliveredWords } from "./stages";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function SideSheet({ id, go, close }: { id: string; go: (to: string) => void; close: () => void }) {
  const ev = useEvent(id);
  const { needs } = useActor();
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;

  // Focus in on open, back to the card on close. A click on another card switches the sheet, so it is not "outside".
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const prevRow = prev?.getAttribute("data-row") ?? null;
    ref.current?.querySelector<HTMLElement>("[data-close]")?.focus();
    document.body.classList.add("sheet-open");
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest("[data-opens-sheet]")) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const els = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length);
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("sheet-open");
      // The card may have been redrawn while the sheet was open; find it again by its id.
      const back = prev && prev.isConnected ? prev : prevRow ? document.querySelector<HTMLElement>(`[data-row="${prevRow}"]`) : null;
      back?.focus();
    };
  }, []);

  const top = (
    <div className="sheet-top">
      <span className="spacer" />
      <button className="sheet-x" type="button" data-close aria-label="Close" onClick={close}>&times;</button>
    </div>
  );
  if (ev.missing) return <aside className="sheet" ref={ref} role="dialog" aria-label="Event">{top}<p className="mute">That event does not exist.</p></aside>;
  if (!ev.data) return <aside className="sheet" ref={ref} role="dialog" aria-label="Event">{top}</aside>;

  const { event: e, list } = ev.data;
  const going = (needs?.requests ?? []).filter((r) => r.event_id === id && r.status === "approved");
  const waiting = (needs?.requests ?? []).filter((r) => r.event_id === id && r.status === "pending").length;
  const names = going.map((r) => r.requester);
  const prio = Object.fromEntries(list.priorities.map((p) => [p.priority, p.n]));
  const where = [city(e.venue), e.country && !e.venue.includes(e.country) ? e.country : ""].filter(Boolean).join(", ");
  const away = daysTo(e.starts_on);

  // A small version of the event's own header: who it is, where it stands, the one thing to do, and a few quiet facts. The rest is a click away.
  return (
    <aside className="sheet" ref={ref} role="dialog" aria-label={e.name} data-sheet={id}>
      {top}
      <header className="ehero mini" style={{ "--brand": e.brand_color ?? "#1F5D3F" } as CSSProperties}>
        <EventLogo name={e.name} website={e.website} size={48} />
        <div className="ehero-text">
          <h2>{e.name}</h2>
          <p className="mute">{[shortDate(e.starts_on), where].filter(Boolean).join(" · ")}</p>
        </div>
        <p className="ehero-count" aria-label={countdown(e.starts_on)}>{away === 0 ? <b>Today</b> : <><b>{Math.abs(away)}</b><span>{Math.abs(away) === 1 ? "day" : "days"} {away > 0 ? "to go" : "ago"}</span></>}</p>
        <Stages e={e} approvers={needs?.approvers ?? []} cases={ev.open.length} />
      </header>

      {ev.note && <p className="sheet-next">{ev.note}</p>}
      {e.stage === "delivered"
        ? e.sheet_url && <div className="actions"><SheetButton href={e.sheet_url} /></div>
        : <StageBlock ev={ev} go={go} compact />}

      <dl className="sheet-facts">
        {(going.length > 0 || waiting > 0) && (
          <div>
            <dt>Going</dt>
            <dd>
              {names.length > 0 && <span className="faces">{names.slice(0, 6).map((n) => <PersonAvatar key={n} name={n} size={26} />)}</span>}
              <span>{going.length ? `${going.length} going` : "Nobody yet"}{waiting > 0 ? `, ${waiting} waiting` : ""}</span>
            </dd>
          </div>
        )}
        {list.upload && <div><dt>Attendees</dt><dd>{list.upload.row_count.toLocaleString("en-US")} rows, {plural(list.companies, "company", "companies")}</dd></div>}
        {e.stage === "delivered" && <div><dt>Outreach</dt><dd>{deliveredWords(e).words}, {plural(list.people, "person", "people")} ({prio.A ?? 0} A, {prio.B ?? 0} B, {prio.C ?? 0} C)</dd></div>}
      </dl>

      <button className="btn line sheet-open-full" type="button" onClick={() => go(`/event/${id}`)}>Open the full page</button>
    </aside>
  );
}
