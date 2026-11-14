/* The assessment and the request to the organizer, in the Plan tab's audience area (docs/EVENT-PLAN.md section 9).
   The assessment reuses the debrief facts pattern: what a person is shown is a fact with the sentence it came from, and a person accepts it, edits it or leaves it out.
   The request is read only: the email as drafted from the fixed text, one button to copy it, and the dates the person says. The desk never sends it, and there is no mail link. */

import { useState, type ReactNode } from "react";
import { send, type AssessmentAnswer, type AssessmentData, type AssessmentQuestion, type OrganizerRequest } from "./api";
import { useActor } from "./App";
import { Editable, Form } from "./PlanEdit";
import { SOURCE_KINDS, SOURCE_KIND_WORDS } from "../shared/assessment";
import { shortDate } from "./words";

const answerWords = (q: AssessmentQuestion, a: AssessmentAnswer) => {
  if (a.answer === "unknown") return "Not known";
  if (q.type === "choice") return q.words[a.answer] ?? a.answer;
  if (q.type === "list") return a.answer.split(",").map((x) => q.words[x.trim()] ?? x.trim()).join(", ");
  return a.answer;
};
const dayOf = (iso: string | null) => (iso ? shortDate(iso.slice(0, 10)) : "");
const kindWords = (k: string) => SOURCE_KIND_WORDS[k as keyof typeof SOURCE_KIND_WORDS] ?? k;

/** Where an answer stands, in words: who proposed it and whether anyone has confirmed it. */
const standing = (a: AssessmentAnswer) => {
  const from = a.source_kind === "first_hand" ? "First hand" : kindWords(a.source_kind);
  return a.state === "confirmed" ? `${from}. Confirmed by ${a.confirmed_by}, ${dayOf(a.confirmed_at)}` : `${from}. ${a.proposed_by === "model" || a.proposed_by === "reuse" ? "Proposed" : `Entered by ${a.proposed_by}`}, not yet confirmed`;
};

function AnswerEditor({ id, q, a, hasSources, sources, done, saved }: { id: string; q: AssessmentQuestion; a: AssessmentAnswer | null; hasSources: boolean; sources: AssessmentData["sources"]; done: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const initial = a?.answer ?? (q.type === "choice" ? q.values[0] : "");
  const [value, setValue] = useState(initial);
  const [detail, setDetail] = useState(a?.detail ?? "");
  const [source, setSource] = useState(a?.source_id ?? "");
  const [quote, setQuote] = useState(a?.quote ?? "");
  const picked = value.split(",").map((x) => x.trim()).filter(Boolean);
  const toggle = (v: string) => setValue((picked.includes(v) ? picked.filter((x) => x !== v) : [...picked.filter((x) => x !== "unknown"), v]).join(","));
  const fromModel = a?.proposed_by === "model";
  const withSource = fromModel || (hasSources && source !== "");
  const ready = value.trim() !== "" && (!withSource || quote.trim() !== "" || !hasSources);
  return (
    <Form onCancel={done} saveWord="Confirm" ready={ready} onSave={async () => {
      const body: Record<string, unknown> = { answer: value.trim(), detail, confirm: true };
      if (fromModel) body.quote = quote;
      else if (source) { body.source_id = source; body.quote = quote; } else { body.source_kind = "first_hand"; body.source_id = null; body.quote = ""; }
      const r = await send("PUT", `/api/events/${id}/assessment/answers/${q.id}`, actor, body);
      if (r.ok) { await saved(); done(); }
      return r;
    }}>
      <p className="as-label">{q.label}</p>
      {q.type === "choice" && (
        <label className="field"><span>Answer</span><select className="input" value={value} onChange={(e) => setValue(e.target.value)}>{q.values.map((v) => <option key={v} value={v}>{q.words[v] ?? v}</option>)}</select></label>
      )}
      {q.type === "list" && (
        <fieldset className="as-checks"><legend>Answer</legend>
          {q.values.map((v) => <label key={v}><input type="checkbox" checked={picked.includes(v)} onChange={() => toggle(v)} />{q.words[v] ?? v}</label>)}
          <label><input type="checkbox" checked={value === "unknown"} onChange={() => setValue(value === "unknown" ? "" : "unknown")} />Not known</label>
        </fieldset>
      )}
      {q.type === "text" && <label className="field"><span>Answer</span><input className="input" value={value} maxLength={q.max} onChange={(e) => setValue(e.target.value)} autoComplete="off" /></label>}
      <label className="field"><span>Note</span><input className="input" value={detail} maxLength={300} onChange={(e) => setDetail(e.target.value)} autoComplete="off" /></label>
      {!fromModel && hasSources && (
        <label className="field"><span>Where it came from</span>
          <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">My own knowledge</option>
            {sources.map((s) => <option key={s.id} value={s.id}>{kindWords(s.source_kind)}{s.url ? `, ${new URL(s.url).host}` : ", pasted"}</option>)}
          </select>
        </label>
      )}
      {withSource && <label className="field"><span>The sentence, word for word</span><textarea className="input itext" rows={3} maxLength={400} value={quote} onChange={(e) => setQuote(e.target.value)} /></label>}
    </Form>
  );
}

function QuestionRow({ id, q, data, saved }: { id: string; q: AssessmentQuestion; data: AssessmentData; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const a = q.answer;
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const act = async (fn: () => ReturnType<typeof send>) => { setBusy(true); setError(""); const r = await fn(); setBusy(false); if (!r.ok) { setError(r.error); return; } await saved(); };
  if (editing) return <li className="as-row as-editing" aria-label={q.label}><AnswerEditor id={id} q={q} a={a} hasSources={data.sources.length > 0} sources={data.sources} done={() => setEditing(false)} saved={saved} /></li>;
  return (
    <li className="as-row" aria-label={q.label}>
      <span className="pl-what">
        <b>{q.label}</b>
        {a ? <span className="as-answer">{answerWords(q, a)}{a.detail ? `. ${a.detail}` : ""}</span> : <span>Not answered</span>}
        {a?.quote && <q className="as-quote">{a.quote}</q>}
        {a && <span>{standing(a)}</span>}
      </span>
      <span className="as-end">
        {a?.state === "proposed" && <button type="button" className="btn line small" disabled={busy} onClick={() => act(() => send("PUT", `/api/events/${id}/assessment/answers/${q.id}`, actor, { confirm: true }))} aria-label={`Accept the answer to ${q.label}`}>Accept</button>}
        <button type="button" className="btn line small" disabled={busy} onClick={() => setEditing(true)} aria-label={`${a ? "Edit" : "Answer"}: ${q.label}`}>{a ? "Edit" : "Answer"}</button>
        {a?.state === "proposed" && <button type="button" className="btn line small" disabled={busy} onClick={() => act(() => send("DELETE", `/api/events/${id}/assessment/answers/${q.id}`, actor))} aria-label={`Leave out the answer to ${q.label}`}>Leave out</button>}
      </span>
      {error && <p role="alert" className="error small as-err">{error}</p>}
    </li>
  );
}

function SourceForm({ id, done, saved }: { id: string; done: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [mode, setMode] = useState<"pasted" | "fetched">("pasted");
  const [kind, setKind] = useState("faq"), [text, setText] = useState(""), [url, setUrl] = useState("");
  return (
    <Form onCancel={done} saveWord="Add the source" ready={mode === "pasted" ? text.trim().length >= 20 : url.trim() !== ""} onSave={async () => {
      const r = await send("POST", `/api/events/${id}/assessment/sources`, actor, mode === "pasted" ? { input: "pasted", source_kind: kind, text } : { input: "fetched", source_kind: kind, url });
      if (r.ok) { await saved(); done(); }
      return r;
    }}>
      <div className="seg" role="group" aria-label="How to give the page">
        <button type="button" aria-pressed={mode === "pasted"} onClick={() => setMode("pasted")}>Paste the text</button>
        <button type="button" aria-pressed={mode === "fetched"} onClick={() => setMode("fetched")}>Read a web page</button>
      </div>
      <label className="field"><span>What it is</span><select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>{SOURCE_KINDS.map((k) => <option key={k} value={k}>{kindWords(k)}</option>)}</select></label>
      {mode === "pasted"
        ? <label className="field"><span>The text</span><textarea className="input itext" rows={6} maxLength={40000} value={text} onChange={(e) => setText(e.target.value)} /></label>
        : <label className="field"><span>Web address (https)</span><input className="input" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" /></label>}
    </Form>
  );
}

/** The assessment: seven questions, each with the sentence it came from; the sources; reuse; confirm. */
export function AssessmentBlock({ id, data, saved }: { id: string; data: AssessmentData; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [note, setNote] = useState("");
  const status = data.assessment?.status === "confirmed" ? `Confirmed by ${data.assessment.confirmed_by}, ${dayOf(data.assessment.confirmed_at)}` : `${data.progress.confirmed} of ${data.progress.total} confirmed`;
  const run = async (key: string, fn: () => ReturnType<typeof send>, after?: (d: unknown) => void) => {
    setBusy(key); setError(""); setNote("");
    const r = await fn();
    setBusy("");
    if (!r.ok) { setError(r.error); return; }
    after?.(r.data);
    await saved();
  };
  const readIt = (sid: string) => run(`read:${sid}`, () => send("POST", `/api/events/${id}/assessment/propose`, actor, { source_id: sid }), (d) => {
    const x = d as { kept: number; dropped: number; note: string | null };
    setNote(x.note ?? `${x.kept === 1 ? "1 answer proposed" : `${x.kept} answers proposed`}${x.dropped ? `, ${x.dropped} left out` : ""}`);
  });
  return (
    <div className="as">
      <dl className="pl-facts" aria-label="Assessment">
        <div><dt>Status</dt><dd>{status}</dd></div>
        <div><dt>Reads left</dt><dd>{data.reads_left} of {data.reads_cap}</dd></div>
      </dl>
      <ul className="pl-rows as-rows">{data.questions.map((q) => <QuestionRow key={q.id} id={id} q={q} data={data} saved={saved} />)}</ul>
      <div className="actions">
        {data.last_year && data.progress.confirmed < data.progress.total && <button type="button" className="btn line small" disabled={busy !== ""} onClick={() => run("reuse", () => send("POST", `/api/events/${id}/assessment/reuse`, actor))}>Reuse last year</button>}
        {data.assessment?.status !== "confirmed" && <button type="button" className="btn line small" disabled={busy !== "" || data.progress.confirmed < data.progress.total} onClick={() => run("confirm", () => send("POST", `/api/events/${id}/assessment/confirm`, actor))}>Confirm the assessment</button>}
      </div>
      {error && <p role="alert" className="error small">{error}</p>}
      {note && <p role="status" className="small">{note}</p>}
      <h3 className="pl-h3">Sources</h3>
      {data.sources.length > 0 && (
        <ul className="pl-rows" aria-label="Sources">{data.sources.map((s) => (
          <li className="pl-row" key={s.id}>
            <span className="pl-what"><b>{kindWords(s.source_kind)}</b><span>{s.url ? new URL(s.url).host : "Pasted"}, added by {s.added_by}</span></span>
            <span className="pl-mid">{s.chars.toLocaleString("en-US")} characters</span>
            <span className="pl-end"><button type="button" className="btn line small" disabled={busy !== "" || data.reads_left === 0} onClick={() => readIt(s.id)} aria-label={`Read the ${kindWords(s.source_kind)} for answers`}>{busy === `read:${s.id}` ? "Reading…" : "Read for answers"}</button></span>
          </li>
        ))}</ul>
      )}
      <Editable can label="Add a source" view={data.sources.length ? null : <p className="mute">No source yet.</p>} editor={(close) => <SourceForm id={id} done={close} saved={saved} />} />
    </div>
  );
}

const requestWords = (r: OrganizerRequest) => {
  switch (r.status) {
    case "drafted": return "Drafted";
    case "copied": return `Copied by ${r.copied_by}`;
    case "sent": return "Sent";
    case "will_share": return "Will share the list";
    case "will_not_share": return "Will not share";
    default: return "Received";
  }
};

function DatesForm({ id, r, done, saved }: { id: string; r: OrganizerRequest; done: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [sent, setSent] = useState(r.sent_on ?? ""), [expected, setExpected] = useState(r.expected_on ?? "");
  const [answer, setAnswer] = useState<"" | "will_share" | "will_not_share">(r.status === "will_share" ? "will_share" : r.status === "will_not_share" ? "will_not_share" : "");
  return (
    <Form onCancel={done} ready={sent !== ""} onSave={async () => {
      const body: Record<string, unknown> = { sent_on: sent || null, expected_on: expected || null };
      body.status = answer || "sent";
      const res = await send("PATCH", `/api/events/${id}/organizer-request/${r.id}`, actor, body);
      if (res.ok) { await saved(); done(); }
      return res;
    }}>
      <div className="pl-edit-grid">
        <label className="field"><span>Sent on</span><input className="input" type="date" value={sent} onChange={(e) => setSent(e.target.value)} /></label>
        <label className="field"><span>The organizer said</span>
          <select className="input" value={answer} onChange={(e) => setAnswer(e.target.value as typeof answer)}>
            <option value="">No answer yet</option><option value="will_share">It will share the list</option><option value="will_not_share">It will not share the list</option>
          </select>
        </label>
        <label className="field"><span>List expected on</span><input className="input" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></label>
      </div>
    </Form>
  );
}

/** The request to the organizer: the email, read only, with one button that copies it. Who copied it, when it was sent, when the list is expected and the follow-up are kept beside it. */
export function OrganizerBlock({ id, data, canDraft, saved }: { id: string; data: AssessmentData; canDraft: boolean; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const r = data.organizer_request;
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const draft = async (template: "ask_for_list" | "follow_up") => {
    setBusy(true); setError("");
    const x = await send("POST", `/api/events/${id}/organizer-request`, actor, { template });
    setBusy(false);
    if (!x.ok) { setError(x.error); return; }
    await saved();
  };
  const copy = async () => {
    if (!r) return;
    setBusy(true); setError("");
    try { await navigator.clipboard.writeText(`Subject: ${r.subject}\n\n${r.body}`); }
    catch { setBusy(false); setError("This browser would not copy it. Select the text and copy it yourself."); return; }
    const x = await send("POST", `/api/events/${id}/organizer-request/${r.id}/copied`, actor);
    setBusy(false);
    if (!x.ok) { setError(x.error); return; }
    await saved();
  };
  if (!r) {
    if (!data.request_offered && !canDraft) return <p className="mute">No request yet.</p>;
    return <div className="actions"><button type="button" className="btn line small" disabled={busy} onClick={() => draft("ask_for_list")}>Draft the request</button>{error && <p role="alert" className="error small">{error}</p>}</div>;
  }
  const closed = r.status === "received" || r.status === "will_not_share";
  const facts: [string, string][] = [["Status", requestWords(r)]];
  if (r.copied_by) facts.push(["Copied", `${r.copied_by}, ${dayOf(r.copied_at)}`]);
  if (r.sent_on) facts.push(["Sent", shortDate(r.sent_on)]);
  if (r.expected_on) facts.push(["List expected", shortDate(r.expected_on)]);
  if (r.follow_up_on && !closed) facts.push(["Follow up", shortDate(r.follow_up_on)]);
  const mail: ReactNode = (
    <div className="as-mail" aria-label="The email">
      <p className="as-mail-sub"><span>Subject</span><b>{r.subject}</b></p>
      <pre>{r.body}</pre>
    </div>
  );
  return (
    <div className="as">
      <dl className="pl-facts" aria-label="Request">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      {r.status !== "received" && mail}
      <div className="actions">
        {r.status !== "received" && r.status !== "will_not_share" && <button type="button" className="btn" disabled={busy} onClick={copy}>Copy email</button>}
        {r.sent_on && !closed && <button type="button" className="btn line small" disabled={busy} onClick={() => draft("follow_up")}>Draft the follow-up</button>}
      </div>
      {error && <p role="alert" className="error small">{error}</p>}
      {!closed && <Editable can label={r.sent_on ? "Change the dates" : "Say when you sent it"} view={null} editor={(close) => <DatesForm id={id} r={r} done={close} saved={saved} />} />}
    </div>
  );
}
