/* Speaking (docs/SPEAKING.md 6 and 9): the calls for papers across events, soonest closing first, and the talks under them. Calls and talks are the plan's own rows:
   a ledger, status as a word in ink, the closing day in the plan's due words. A planner adds, reads a page for proposals, makes a call into a talk or passes with a reason.
   The speaker sees the talks that name them. A proposal shows the sentence it came from and becomes a call only when a person adds it. */

import { useEffect, useState } from "react";
import { get, send, type CallItem, type CallProposal, type SpeakingData, type TalkItem } from "./api";
import { Link, useActor } from "./App";
import { Form } from "./PlanEdit";
import { slidesWords } from "./PlanTalk";
import type { EventRow } from "../shared/domain";
import { plural, shortDate } from "./words";

/** A closing word reads heavier as the day nears; a call that has closed reads "Closed". */
const urgent = (c: CallItem) => c.status === "open" && (c.is_closed || /^(Today|Tomorrow)$|^Due [A-Z][a-z]{2}$/.test(c.closing));
const host = (u: string) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } };

function AddCall({ events, done, saved }: { events: EventRow[]; done: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [f, setF] = useState({ event: events[0]?.id ?? "", title: "", url: "", closes_on: "", route: "editorial", notes: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Form saveWord="Save the call" onCancel={done} ready={Boolean(f.event && f.url.trim() && f.closes_on)} onSave={async () => {
      const r = await send("POST", `/api/events/${f.event}/calls`, actor, { title: f.title, url: f.url, closes_on: f.closes_on, route: f.route, notes: f.notes });
      if (r.ok) { await saved(); done(); }
      return r;
    }}>
      <div className="pl-edit-grid">
        <label className="field"><span>Event</span><select className="input" value={f.event} onChange={set("event")}>{events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
        <label className="field"><span>Title</span><input className="input" value={f.title} maxLength={160} onChange={set("title")} autoComplete="off" /></label>
        <label className="field"><span>Link to the call</span><input className="input" type="url" inputMode="url" placeholder="https://" value={f.url} onChange={set("url")} autoComplete="off" /></label>
        <label className="field"><span>Closing day</span><input className="input" type="date" value={f.closes_on} onChange={set("closes_on")} /></label>
        <label className="field"><span>Route</span><select className="input" value={f.route} onChange={set("route")}><option value="editorial">Editorial</option><option value="paid">Paid</option></select></label>
        <label className="field"><span>Notes</span><input className="input" value={f.notes} maxLength={600} onChange={set("notes")} autoComplete="off" /></label>
      </div>
    </Form>
  );
}

/** A page the person gives, read once for calls. What comes back is a list of proposals with the sentence each came from. Nothing is a call until it is added. */
function Propose({ events, done, saved }: { events: EventRow[]; done: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [event, setEvent] = useState(events[0]?.id ?? ""), [mode, setMode] = useState<"url" | "text">("url"), [value, setValue] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [found, setFound] = useState<{ proposals: CallProposal[]; dropped: number } | null>(null), [adding, setAdding] = useState("");
  const read = async () => {
    setBusy(true); setError(""); setFound(null);
    const r = await send<{ proposals: CallProposal[]; dropped: number }>("POST", `/api/events/${event}/calls/propose`, actor, mode === "url" ? { url: value.trim() } : { text: value });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setFound(r.data);
  };
  const add = async (p: CallProposal) => {
    setAdding(p.link + p.closes_on); setError("");
    const r = await send("POST", `/api/events/${event}/calls`, actor, { title: p.title, url: p.link, closes_on: p.closes_on, source: "model", source_url: p.source_url });
    setAdding("");
    if (!r.ok) { setError(r.error); return; }
    setFound((f) => (f ? { ...f, proposals: f.proposals.filter((x) => x !== p) } : f));
    await saved();
  };
  return (
    <div className="pl-edit">
      <div className="pl-edit-grid">
        <label className="field"><span>Event</span><select className="input" value={event} onChange={(e) => setEvent(e.target.value)}>{events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      </div>
      <div className="seg" role="group" aria-label="How to give the page">
        <button type="button" aria-pressed={mode === "url"} onClick={() => setMode("url")}>Page address</button>
        <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>Paste the text</button>
      </div>
      {mode === "url"
        ? <label className="field"><span>Page address</span><input className="input" type="url" inputMode="url" placeholder="https://" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" /></label>
        : <label className="field"><span>Page text</span><textarea className="input itext" rows={6} maxLength={40000} value={value} onChange={(e) => setValue(e.target.value)} /></label>}
      <div className="actions">
        <button type="button" className="btn small" disabled={busy || !value.trim() || !event} onClick={read}>{busy ? "Reading" : "Read the page"}</button>
        <button type="button" className="btn line small" onClick={done}>Close</button>
      </div>
      {error && <p role="alert" className="error small">{error}</p>}
      {found && (
        <ul className="pl-rows as-rows" aria-label="Proposals">
          {found.proposals.map((p) => (
            <li className="as-row" key={p.link + p.closes_on + p.title}>
              <span className="pl-what"><b>{p.title}</b><q className="as-quote">{p.quote}</q><span>Closes {shortDate(p.closes_on)}</span></span>
              <span className="as-end">
                <button type="button" className="btn line small" disabled={adding !== ""} onClick={() => add(p)} aria-label={`Add ${p.title} as a call`}>Add as a call</button>
                <button type="button" className="btn line small" onClick={() => setFound((f) => (f ? { ...f, proposals: f.proposals.filter((x) => x !== p) } : f))} aria-label={`Drop ${p.title}`}>Drop</button>
              </span>
            </li>
          ))}
          {found.proposals.length === 0 && <li className="pl-row"><span className="pl-what"><b>Nothing found</b></span></li>}
          {found.dropped > 0 && <li className="pl-row"><span className="pl-what"><span>{plural(found.dropped, "proposal")} left out</span></span></li>}
        </ul>
      )}
    </div>
  );
}

function CallRow({ c, talks, planner, saved }: { c: CallItem; talks: TalkItem[]; planner: boolean; saved: () => Promise<void> }) {
  const { actor, go } = useActor();
  const [passing, setPassing] = useState(false), [why, setWhy] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const talk = c.talk_id ? talks.find((t) => t.id === c.talk_id) : undefined;
  const make = async () => { setBusy(true); setError(""); const r = await send("POST", `/api/calls/${c.id}/talk`, actor); setBusy(false); if (!r.ok) { setError(r.error); return; } await saved(); };
  if (passing) return (
    <li className="as-row as-editing" aria-label={c.title}>
      <Form saveWord="Pass with this reason" ready={why.trim().length >= 3} onCancel={() => setPassing(false)} onSave={async () => { const r = await send("POST", `/api/calls/${c.id}/pass`, actor, { reason: why }); if (r.ok) { setPassing(false); await saved(); } return r; }}>
        <label className="field"><span>Why you are passing on {c.title}</span><input className="input" value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} autoFocus autoComplete="off" /></label>
      </Form>
    </li>
  );
  const word = c.status !== "open" ? c.closing : c.is_closed ? "Closed" : c.closing;
  return (
    <li className="as-row" aria-label={c.title}>
      <span className="pl-what">
        <b><Link to={`/event/${c.event_id}`} go={go}>{c.event_name}</Link></b>
        <span>{[c.title, c.route === "paid" ? "Paid" : "", talk ? (talk.title || "Talk without a title") : ""].filter(Boolean).join(", ")}</span>
        {c.status === "passed" && c.passed_reason && <span>Reason: {c.passed_reason}</span>}
      </span>
      <span className="as-end">
        <span className={urgent(c) ? "pl-strong" : "mute"}>{word}</span>
        <a className="btn line small" href={c.url} target="_blank" rel="noreferrer" aria-label={`Read the call, ${host(c.url)}`}>Read the call</a>
        {planner && c.status === "open" && !c.talk_id && <button type="button" className="btn line small" disabled={busy} onClick={make}>Make into a talk</button>}
        {planner && c.status === "open" && <button type="button" className="btn line small" disabled={busy} onClick={() => setPassing(true)}>Pass</button>}
      </span>
      {error && <p role="alert" className="error small as-err">{error}</p>}
    </li>
  );
}

function TalkRow({ t }: { t: TalkItem }) {
  const { go } = useActor();
  const slides = slidesWords(t);
  return (
    <li className="as-row" aria-label={t.title || "Talk"}>
      <span className="pl-what">
        <b><Link to={`/event/${t.event_id}`} go={go}>{t.title || "No title yet"}</Link></b>
        <span>{[t.event_name, t.speaker || "No speaker yet"].join(", ")}</span>
      </span>
      <span className="as-end as-stack">
        <span className={t.status === "drafting" || t.slides_late ? "pl-strong" : t.status === "declined" ? "mute" : ""}>{t.status_words}</span>
        <span className={t.slides_late || /Waiting/.test(slides) ? "pl-strong" : "mute"}>{t.slides_late ? `Slides late, ${t.slide_due_words}` : slides}</span>
      </span>
    </li>
  );
}

export function Speaking() {
  const { actor, needs, refresh } = useActor();
  const [d, setD] = useState<SpeakingData | null>(null), [open, setOpen] = useState<"add" | "propose" | null>(null);
  const load = async () => setD(await get<SpeakingData>("/api/speaking"));
  useEffect(() => { setD(null); void load(); }, [actor]);
  if (!d) return null;
  const planner = d.can_write;
  // A call hangs off an event that has a plan and is not over: candidate, confirmed or preparing.
  const events = (needs?.events ?? []).filter((e) => ["planning", "confirmed", "preparing"].includes((e as EventRow & { plan_stage?: string }).plan_stage ?? "") && e.stage !== "declined") as EventRow[];
  const live = d.calls.filter((c) => c.status !== "passed"), passed = d.calls.filter((c) => c.status === "passed");
  const saved = async () => { await load(); await refresh(); };
  const toggle = (k: "add" | "propose") => setOpen(open === k ? null : k);

  return (
    <section className="speaking" data-ready="1">
      <header className="hero"><div><h1>Speaking</h1></div>
        {planner && (
          <div className="actions">
            <button type="button" className="btn line small" aria-pressed={open === "propose"} onClick={() => toggle("propose")}>Propose from a page</button>
            <button type="button" className="btn small" aria-pressed={open === "add"} onClick={() => toggle("add")}>Add a call</button>
          </div>
        )}
      </header>

      {open === "add" && <div className="ask"><AddCall events={events} done={() => setOpen(null)} saved={saved} /></div>}
      {open === "propose" && <div className="ask"><Propose events={events} done={() => setOpen(null)} saved={saved} /></div>}

      {planner && (
        <section className="pl-sec" aria-label="Calls for papers"><h2>Calls for papers<span className="mute"> {live.filter((c) => c.status === "open").length} open</span></h2>
          <div className="pl-body">
            {live.length ? <ul className="pl-rows as-rows">{live.map((c) => <CallRow key={c.id} c={c} talks={d.talks} planner={planner} saved={saved} />)}</ul> : <p className="mute">No calls yet.</p>}
            {passed.length > 0 && <><h3 className="pl-h3">Passed</h3><ul className="pl-rows as-rows">{passed.map((c) => <CallRow key={c.id} c={c} talks={d.talks} planner={planner} saved={saved} />)}</ul></>}
          </div>
        </section>
      )}

      <section className="pl-sec" aria-label="Talks"><h2>Talks<span className="mute"> {d.talks.length}</span></h2>
        <div className="pl-body">
          {d.talks.length ? <ul className="pl-rows as-rows">{d.talks.map((t) => <TalkRow key={t.id} t={t} />)}</ul> : <p className="mute">No talks yet.</p>}
        </div>
      </section>
    </section>
  );
}
