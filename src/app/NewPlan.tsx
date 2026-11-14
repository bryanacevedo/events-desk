/* A new plan: pick a listed conference, or name one that is not listed, or start a hosted event; say why and how the team takes part. The server checks
   everything again. It makes the plan and its ways of taking part, then opens the plan. */

import { useEffect, useRef, useState } from "react";
import { send } from "./api";
import { useActor } from "./App";
import { HOSTED_FORMATS } from "../shared/plan";
import { shortDate, todayYmd } from "./words";

const HOSTED_WORDS: Record<string, string> = { dinner: "Dinner", side_event: "Side event", roadshow_stop: "Roadshow stop", webinar: "Webinar", customer_event: "Customer event" };
const NOT_LISTED = "__new";

export function NewPlan({ onDone, onClose }: { onDone: (id: string) => void; onClose: () => void }) {
  const { actor, needs, refresh } = useActor();
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [hosted, setHosted] = useState(false);
  const [f, setF] = useState({ pick: "", name: "", starts_on: "", ends_on: "", city: "", country: "", venue: "", price: "", format: "dinner", headcount: "", reason: "", passes: "", sponsorship: false, talk: false });
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("select, input")?.focus();
    document.body.classList.add("sheet-open");
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) closeRef.current(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); closeRef.current(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); document.body.classList.remove("sheet-open"); };
  }, []);
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  const today = todayYmd();
  const open = (needs?.catalog ?? []).filter((c) => !c.event_id && c.ends_on >= today).sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  const unlisted = f.pick === NOT_LISTED;
  const typed = hosted || unlisted;
  const ready = Boolean(f.reason.trim()) && (hosted ? f.name.trim() && f.starts_on && f.format : unlisted ? f.name.trim() && f.starts_on && f.city.trim() && f.country.trim() : f.pick) && (hosted || f.passes !== "" || f.sponsorship || f.talk);

  const submit = async (ev: { preventDefault(): void }) => {
    ev.preventDefault();
    setBusy(true); setError("");
    const dollars = f.price === "" ? undefined : Math.round(Number(f.price) * 100);
    const body: Record<string, unknown> = hosted
      ? { name: f.name, starts_on: f.starts_on, ends_on: f.ends_on || undefined, city: f.city, country: f.country, venue: f.venue, reason: f.reason, hosted: { format: f.format, headcount: f.headcount === "" ? null : Number(f.headcount) } }
      : unlisted
        ? { name: f.name, starts_on: f.starts_on, ends_on: f.ends_on || undefined, city: f.city, country: f.country, venue: f.venue, seat_price_cents: dollars, reason: f.reason }
        : { catalog_id: f.pick, seat_price_cents: dollars, reason: f.reason };
    const made = await send<{ id: string }>("POST", "/api/plans", actor, body);
    if (!made.ok) { setBusy(false); setError(made.error); return; }
    const id = made.data.id;
    const ways: Record<string, unknown>[] = hosted ? [] : [
      ...(f.passes !== "" ? [{ kind: "passes", pass_count: Number(f.passes) }] : []),
      ...(f.sponsorship ? [{ kind: "sponsorship" }] : []),
      ...(f.talk ? [{ kind: "talk", talk_title: "", speaker: "" }] : []),
    ];
    for (const w of ways) {
      const r = await send("POST", `/api/events/${id}/involvements`, actor, w);
      if (!r.ok) { setBusy(false); setError(`The plan was made, but ${r.error} Add the rest on the plan.`); await refresh(); onDone(id); return; }
    }
    setBusy(false);
    await refresh();
    onDone(id);
  };

  return (
    <aside className="sheet" ref={ref} role="dialog" aria-label="New plan" data-add>
      <div className="sheet-top">
        <h2 className="display">New plan</h2>
        <span className="spacer" />
        <button className="sheet-x" type="button" data-close aria-label="Close" onClick={onClose}>&times;</button>
      </div>
      <form className="form addform" onSubmit={submit}>
        <div className="seg" role="group" aria-label="Kind of event">
          <button type="button" aria-pressed={!hosted} onClick={() => setHosted(false)}>Conference</button>
          <button type="button" aria-pressed={hosted} onClick={() => setHosted(true)}>Hosted event</button>
        </div>
        {!hosted && (
          <label className="field"><span>Event</span>
            <select className="input" value={f.pick} onChange={set("pick")} required>
              <option value="">Choose a listed event</option>
              {open.map((c) => <option key={c.id} value={c.id}>{c.name}, {shortDate(c.starts_on)}, {c.city}</option>)}
              <option value={NOT_LISTED}>My event is not listed</option>
            </select>
          </label>
        )}
        {hosted && (
          <label className="field"><span>Format</span>
            <select className="input" value={f.format} onChange={set("format")}>{HOSTED_FORMATS.map((k) => <option key={k} value={k}>{HOSTED_WORDS[k]}</option>)}</select>
          </label>
        )}
        {typed && (
          <>
            <label className="field"><span>Name</span><input className="input" value={f.name} onChange={set("name")} autoComplete="off" required /></label>
            <div className="two">
              <label className="field"><span>Starts</span><input className="input" type="date" value={f.starts_on} onChange={set("starts_on")} required /></label>
              <label className="field"><span>Ends</span><input className="input" type="date" value={f.ends_on} min={f.starts_on} onChange={set("ends_on")} /></label>
            </div>
            <div className="two">
              <label className="field"><span>City</span><input className="input" value={f.city} onChange={set("city")} autoComplete="off" required={!hosted} /></label>
              <label className="field"><span>Country</span><input className="input" value={f.country} onChange={set("country")} autoComplete="off" required={!hosted} /></label>
            </div>
            <label className="field"><span>Venue (optional)</span><input className="input" value={f.venue} onChange={set("venue")} autoComplete="off" /></label>
          </>
        )}
        {hosted && <label className="field"><span>Guests expected (optional)</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={f.headcount} onChange={set("headcount")} /></label>}
        <label className="field"><span>Why we go</span><textarea className="input itext" rows={4} maxLength={1200} value={f.reason} onChange={set("reason")} required /></label>
        {!hosted && (
          <>
            <div className="two">
              <label className="field"><span>Passes</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={f.passes} onChange={set("passes")} placeholder="None" /></label>
              <label className="field"><span>Price per pass, dollars</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={f.price} onChange={set("price")} placeholder={f.pick && !unlisted ? "Listed price" : "0"} /></label>
            </div>
            <div className="pl-checks" role="group" aria-label="Also">
              <label><input type="checkbox" checked={f.sponsorship} onChange={(e) => setF({ ...f, sponsorship: e.target.checked })} /> Sponsorship</label>
              <label><input type="checkbox" checked={f.talk} onChange={(e) => setF({ ...f, talk: e.target.checked })} /> Talk</label>
            </div>
          </>
        )}
        {error && <p role="alert" className="error">{error}</p>}
        <div className="actions">
          <button className="btn" type="submit" disabled={busy || !ready}>{busy ? "Making…" : "Make the plan"}</button>
          <button className="btn line" type="button" onClick={onClose}>Not now</button>
        </div>
      </form>
    </aside>
  );
}
