/* The talk on the Plan tab (docs/SPEAKING.md 5 and 9): the words, the dates, the slides, the two approvals as a name and a day, the status, and the one next step.
   A planner or the named speaker writes. A second person approves the abstract and the slides; the server says so in one sentence when the author tries. */

import { useEffect, useState } from "react";
import { get, send, type PlanInvolvement, type SpeakingData, type TalkItem } from "./api";
import { PEOPLE, useActor } from "./App";
import { Form } from "./PlanEdit";
import { dm } from "./words";

/** The talk's slides in one phrase: what a person would say. */
export function slidesWords(t: TalkItem): string {
  if (t.status === "declined") return t.declined_reason ? `Reason: ${t.declined_reason}` : "Declined";
  if (!t.slides_url) return "No slides yet";
  if (t.slides_sent_on) return `Sent to the organizer, ${dm(t.slides_sent_on)}`;
  if (t.slides_approved_at) return "Approved";
  return "Waiting for a second person";
}

type Act = "write" | "approve-abstract" | "submit" | "answer" | "slides-link" | "approve-slides" | "slides-sent" | null;
/** The server's `next` sentence says which step is open; each maps to the one action that does it. */
const ACTS: [string, Act, string][] = [
  ["Write the title", "write", "Write the words"],
  ["Needs a second person to approve the abstract", "approve-abstract", "Approve the abstract"],
  ["Submit it", "submit", "Mark as submitted"],
  ["Record the answer", "answer", "Record the answer"],
  ["Add the slides link", "slides-link", "Add the slides link"],
  ["Needs a second person to approve the slides", "approve-slides", "Approve the slides"],
  ["Send the slides to the organizer", "slides-sent", "Mark the slides sent"],
];
const actOf = (next: string) => ACTS.find(([s]) => next.startsWith(s));

function TalkEditor({ t, done, saved }: { t: TalkItem; done: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const frozen = t.status === "submitted" || t.status === "accepted" || t.status === "declined";
  const [f, setF] = useState({ title: t.title, abstract: t.abstract, speaker: t.speaker, slide_due_on: t.slide_due_on ?? "", rehearsal_on: t.rehearsal_on ?? "", slides_url: t.slides_url ?? "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const wordsChanged = f.title !== t.title || f.abstract !== t.abstract;
  const dirty = wordsChanged || f.speaker !== t.speaker || f.slide_due_on !== (t.slide_due_on ?? "") || f.rehearsal_on !== (t.rehearsal_on ?? "") || f.slides_url !== (t.slides_url ?? "");
  return (
    <Form onCancel={done} ready={dirty} onSave={async () => {
      const body: Record<string, string | null> = {};
      if (f.title !== t.title) body.title = f.title;
      if (f.abstract !== t.abstract) body.abstract = f.abstract;
      if (f.speaker !== t.speaker) body.speaker = f.speaker;
      if (f.slide_due_on !== (t.slide_due_on ?? "")) body.slide_due_on = f.slide_due_on || null;
      if (f.rehearsal_on !== (t.rehearsal_on ?? "")) body.rehearsal_on = f.rehearsal_on || null;
      if (f.slides_url !== (t.slides_url ?? "")) body.slides_url = f.slides_url || null;
      const r = await send("PATCH", `/api/talks/${t.id}`, actor, body);
      if (r.ok) { await saved(); done(); }
      return r;
    }}>
      <label className="field"><span>Title</span><input className="input" value={f.title} maxLength={200} readOnly={frozen} onChange={set("title")} autoComplete="off" /></label>
      <label className="field"><span>Abstract</span><textarea className="input itext" rows={6} maxLength={4000} readOnly={frozen} value={f.abstract} onChange={set("abstract")} /></label>
      <div className="pl-edit-grid">
        <label className="field"><span>Speaker</span><input className="input" list="talk-speakers" value={f.speaker} maxLength={80} readOnly={frozen} onChange={set("speaker")} autoComplete="off" /></label>
        <label className="field"><span>Slide deadline</span><input className="input" type="date" value={f.slide_due_on} onChange={set("slide_due_on")} /></label>
        <label className="field"><span>Rehearsal day</span><input className="input" type="date" value={f.rehearsal_on} onChange={set("rehearsal_on")} /></label>
        <label className="field"><span>Slides link</span><input className="input" type="url" inputMode="url" placeholder="https://" value={f.slides_url} readOnly={Boolean(t.slides_sent_on)} onChange={set("slides_url")} autoComplete="off" /></label>
      </div>
      <datalist id="talk-speakers">{PEOPLE.map((p) => <option key={p} value={p} />)}</datalist>
    </Form>
  );
}

function Answer({ t, saved, planner }: { t: TalkItem; saved: () => Promise<void>; planner: boolean }) {
  const { actor } = useActor();
  const [declining, setDeclining] = useState(false), [why, setWhy] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = async (path: string, body?: unknown) => { setBusy(true); setError(""); const r = await send("POST", `/api/talks/${t.id}/${path}`, actor, body); setBusy(false); if (!r.ok) { setError(r.error); return; } await saved(); };
  if (!planner) return <span className="mute">A planner records the answer</span>;
  if (declining) return <Form saveWord="Decline the talk" ready={why.trim().length >= 3} onCancel={() => setDeclining(false)} onSave={async () => { const r = await send("POST", `/api/talks/${t.id}/decline`, actor, { reason: why }); if (r.ok) await saved(); return r; }}>
    <label className="field"><span>Why it was declined</span><input className="input" value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} autoFocus autoComplete="off" /></label>
  </Form>;
  return (
    <span className="as-end">
      <button type="button" className="btn small" disabled={busy} onClick={() => run("accept")}>Accepted</button>
      <button type="button" className="btn line small" disabled={busy} onClick={() => setDeclining(true)}>Declined</button>
      {error && <p role="alert" className="error small as-err">{error}</p>}
    </span>
  );
}

/** The talk of one involvement. Before it has words, a planner can make them; after, it is the ledger. */
export function TalkBlock({ eventId, involvement, saved }: { eventId: string; involvement: PlanInvolvement; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [d, setD] = useState<SpeakingData | null>(null), [editing, setEditing] = useState(false), [answering, setAnswering] = useState(false), [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [why, setWhy] = useState("");
  const load = async () => setD(await get<SpeakingData>(`/api/events/${eventId}/speaking`));
  useEffect(() => { void load(); }, [eventId, actor]);
  const changed = async () => { await load(); await saved(); };
  if (!d) return null;
  const planner = d.can_write;
  const t = d.talks.find((x) => x.involvement_id === involvement.id);

  if (!t) {
    if (!planner) return <p className="mute">No words yet.</p>;
    return (
      <div className="pl-edit-row">
        <button type="button" className="btn line small" disabled={busy} onClick={async () => { setBusy(true); setError(""); const r = await send("POST", `/api/events/${eventId}/talks`, actor, { involvement_id: involvement.id }); setBusy(false); if (!r.ok) { setError(r.error); return; } await changed(); }}>Make the words</button>
        {error && <p role="alert" className="error small">{error}</p>}
      </div>
    );
  }

  const step = actOf(t.next);
  const act = async (path: string) => { setBusy(true); setError(""); const r = await send("POST", `/api/talks/${t.id}/${path}`, actor); setBusy(false); if (!r.ok) { setError(r.error); return; } await changed(); };
  const canDo = (a: Act) => (a === "write" || a === "slides-link" || a === "submit" ? t.can_write : planner);
  const button = step && step[1] && canDo(step[1]) ? (
    <button type="button" className="btn small" disabled={busy} onClick={() => {
      const a = step[1];
      if (a === "write" || a === "slides-link") setEditing(true);
      else if (a === "answer") setAnswering(true);
      else if (a) act(a);
    }}>{step[2]}</button>
  ) : null;
  const waiting = step && step[1] && !canDo(step[1]) ? <span className="mute">{t.next}</span> : null;
  const when = (name: string | null, at: string | null) => (name && at ? `Approved by ${name}, ${dm(at.slice(0, 10))}` : "");
  const abstractLine = t.abstract_approved_by ? when(t.abstract_approved_by, t.abstract_approved_at) : t.title && t.abstract ? "Waiting for a second person" : "Not written yet";
  const slidesLine = t.slides_approved_by ? when(t.slides_approved_by, t.slides_approved_at) : t.slides_url ? "Waiting for a second person" : "No slides yet";
  const waitingAbstract = !t.abstract_approved_by && Boolean(t.title && t.abstract);
  const waitingSlides = !t.slides_approved_by && Boolean(t.slides_url);

  const rows: [string, React.ReactNode, React.ReactNode?][] = [
    ["Title", t.title || <span className="mute">No title yet</span>],
    ["Abstract", t.abstract ? <span className="pl-said">{t.abstract}</span> : <span className="mute">No abstract yet</span>],
    ["Speaker", t.speaker ? <span>{t.speaker}</span> : <span className="mute">No speaker yet</span>],
    ["Slide deadline", t.slide_due_on ? <span className={t.slides_late ? "pl-strong" : ""}>{t.slide_due_words}</span> : <span className="mute">No date yet</span>],
    ["Rehearsal", t.rehearsal_on ? <span>{t.rehearsal_words}</span> : <span className="mute">No date yet</span>],
    ["Slides", t.slides_url ? <span><a href={t.slides_url} target="_blank" rel="noreferrer">{new URL(t.slides_url).host}</a>{t.slides_sent_on ? <span className="mute">, sent to the organizer {dm(t.slides_sent_on)}</span> : ""}</span> : <span className="mute">No slides yet</span>],
    ["Abstract approval", <span className={waitingAbstract ? "pl-strong" : t.abstract_approved_by ? "" : "mute"}>{abstractLine}</span>],
    ["Slides approval", <span className={waitingSlides ? "pl-strong" : t.slides_approved_by ? "" : "mute"}>{slidesLine}</span>],
  ];

  return (
    <div className="pl-talk">
      {editing ? <TalkEditor t={t} done={() => setEditing(false)} saved={changed} /> : (
        <dl className="sn-kv pl-kv">
          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          <div><dt>Status</dt><dd><b>{t.status_words}</b>{t.declined_reason ? <span className="mute">, {t.declined_reason}</span> : ""}</dd></div>
        </dl>
      )}
      {!editing && (
        <div className="pl-talk-acts">
          {answering ? <Answer t={t} planner={planner} saved={async () => { setAnswering(false); await changed(); }} /> : (
            <>
              {button}{waiting}
              {t.can_write && t.status !== "declined" && step?.[1] !== "write" && step?.[1] !== "slides-link" && <button type="button" className="btn line small" onClick={() => setEditing(true)}>Edit</button>}
              {planner && ["drafting", "approved_to_submit"].includes(t.status) && !declining && <button type="button" className="btn line small" onClick={() => setDeclining(true)}>Decline</button>}
            </>
          )}
        </div>
      )}
      {declining && (
        <Form saveWord="Decline the talk" ready={why.trim().length >= 3} onCancel={() => setDeclining(false)} onSave={async () => { const r = await send("POST", `/api/talks/${t.id}/decline`, actor, { reason: why }); if (r.ok) { setDeclining(false); await changed(); } return r; }}>
          <label className="field"><span>Why it is declined</span><input className="input" value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} autoFocus autoComplete="off" /></label>
        </Form>
      )}
      {error && <p role="alert" className="error small">{error}</p>}
    </div>
  );
}
