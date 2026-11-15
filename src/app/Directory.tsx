/* Get the attendee list (docs/DIRECTORY.md 10, direction C). One block on the event's front page: the four ways to get a list in order, with where each stands in words,
   what is waiting to be looked at, and Bring in. Each job opens in a side sheet: the reads to check, the extension, a screen recording, the organizer's email and a plain upload. */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { directoryPanel } from "../server/directory";
import { MAX_FRAMES_PER_RECORDING } from "../shared/directory";
import { get, read, send, type PlanData } from "./api";
import { Link, useActor } from "./App";
import { clock, isImage, takeFrames, CannotDecode, type TakenFrame } from "./frames";
import { Facts, HSheet } from "./Guests";
import { Chevron } from "./Patterns";
import { OrganizerBlock } from "./PlanAssessment";
import { Upload } from "./Upload";
import { num, plural } from "./words";

type Panel = Awaited<ReturnType<typeof directoryPanel>>;
type Read = Panel["to_check"][number];
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PLATFORM: Record<string, string> = { swapcard: "Swapcard", brella: "Brella", grip: "Grip", whova: "Whova", cvent: "Cvent", other: "the web" };
const ORGANIZER: Record<string, string> = { drafted: "Drafted, not sent", copied: "Copied, not yet sent", sent: "Sent, no answer", will_share: "Will share the list", will_not_share: "Will not share the list", received: "List received" };
const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

type Sheet = null | "extension" | "recording" | "organizer" | "upload" | { check: string };

/** The block on the event's front page. `onChange` reloads the event after a list comes in. `quiet` hides it when there is nothing here to show (an event past the first list). */
export function GetList({ eventId, quiet = false, onChange }: { eventId: string; quiet?: boolean; onChange: () => void }) {
  const [p, setP] = useState<Panel | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { actor } = useActor();
  const load = async () => { const d = await get<Panel>(`/api/events/${eventId}/directory`); if (d) setP(d); return d; };
  useEffect(() => { load(); }, [eventId]);
  if (!p) return null;
  const c = p.counts;
  const reads = c.staged + c.to_check + c.brought_in;
  if (quiet && !reads && !p.recordings.length) return null;

  const ext = p.sources.filter((s) => s.via === "extension");
  const extReads = ext.reduce((a, s) => a + s.n, 0);
  const rec = p.recordings[0];
  const upload = p.paths.upload.lists.find((u) => u.list_source !== "directory_extension" && u.list_source !== "screen_recording");
  const fromReads = p.paths.upload.lists.find((u) => u.list_source === "directory_extension" || u.list_source === "screen_recording");
  const bring = p.bring_in;

  const row = (n: number, title: string, state: ReactNode, strong: boolean, on: Sheet) => (
    <li key={n}>
      <button type="button" className="conn gs-row" onClick={() => setSheet(on)} aria-label={title}>
        <span className="pn">{n}</span>
        <span className="conn-who"><b>{title}</b><span className={strong ? "strong" : undefined}>{state}</span></span>
        <Chevron right />
      </button>
    </li>
  );
  const bringIn = async () => {
    setBusy(true); setError("");
    const r = await send("POST", `/api/events/${eventId}/directory/bring-in`, actor);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setArmed(false);
    await load(); onChange();
  };
  const close = () => { setSheet(null); load(); };

  return (
    <section className="gs" aria-label="Get the attendee list" data-ready="1">
      <div className="gh">
        <h2>Get the attendee list</h2>
        {armed
          ? <div className="actions"><button className="btn" type="button" disabled={busy} onClick={bringIn}>{busy ? "Bringing in…" : `Bring in ${plural(bring.count, "person", "people")}`}</button><button className="btn line" type="button" disabled={busy} onClick={() => setArmed(false)}>Cancel</button></div>
          : <button className="btn" type="button" disabled={!bring.count} title={bring.count ? undefined : bring.refusal ?? undefined} onClick={() => setArmed(true)}>Bring in {plural(bring.count, "person", "people")}</button>}
      </div>
      {armed && <p className="mute gs-will">{bring.will}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {!armed && reads > 0 && !bring.count && bring.refusal && <p className="mute" role="status">{bring.refusal}</p>}
      {reads > 0 && (
        <dl className="figs">
          <div><dd>{num(reads)}</dd><dt>read</dt></div>
          <div><dd>{num(c.staged)}</dd><dt>ready</dt></div>
          <div><dd>{num(c.to_check)}</dd><dt>to check</dt></div>
          {c.brought_in > 0 && <div><dd>{num(c.brought_in)}</dd><dt>brought in</dt></div>}
        </dl>
      )}
      <div className="scols">
        <div className="tray">
          <h3><b>Ways to get it, in order</b></h3>
          <ul className="gs-list">
            {row(1, "Web portal, with the browser extension", extReads ? `${num(extReads)} read from ${[...new Set(ext.map((s) => PLATFORM[s.platform] ?? s.platform))].join(", ")}` : "Nothing read yet", extReads > 0, "extension")}
            {row(2, "Screen recording, for an app with no website",
              !p.paths.recording.can_read ? (p.paths.recording.note ?? "Not available here")
                : rec ? `${num(rec.people)} found in ${rec.app_name}${rec.frames_failed ? `, ${plural(rec.frames_failed, "frame")} failed` : ""}${rec.state === "reading" ? ", reading" : ""}` : "No recording yet",
              Boolean(rec && p.paths.recording.can_read), "recording")}
            {row(3, "Request email to the organizer", p.paths.organizer.status ? ORGANIZER[p.paths.organizer.status] ?? p.paths.organizer.status : "Not asked", p.paths.organizer.status === "received", "organizer")}
            {row(4, "Plain upload", upload ? `${upload.filename}, ${plural(upload.row_count, "person", "people")}` : fromReads ? "No file" : "No file", Boolean(upload), "upload")}
          </ul>
        </div>
        {c.to_check > 0 && (
          <div className="tray">
            <h3><b>To check</b><span>{c.to_check}</span></h3>
            <ul className="gs-list">
              {p.to_check.slice(0, 8).map((r) => (
                <li key={r.id}>
                  <button type="button" className="conn gs-row gs-two" onClick={() => setSheet({ check: r.id })} aria-label={`Check ${r.full_name}`}>
                    <span className="conn-who"><b>{r.full_name}</b><span>{r.check_reason}</span></span>
                    <Chevron right />
                  </button>
                </li>
              ))}
              {p.to_check.length > 8 && <li><button type="button" className="conn gs-row gs-two" onClick={() => setSheet({ check: p.to_check[8].id })}><span className="conn-who"><b>{p.to_check.length - 8} more</b></span><Chevron right /></button></li>}
            </ul>
          </div>
        )}
      </div>
      <dl className="rule"><dt>Outreach</dt><dd>{p.rule}</dd></dl>

      {sheet === "extension" && <ExtensionSheet p={p} close={close} />}
      {sheet === "recording" && <RecordingSheet p={p} eventId={eventId} close={close} reload={load} openCheck={() => { const first = p.to_check[0]; setSheet(first ? { check: first.id } : null); }} />}
      {sheet === "organizer" && <OrganizerSheet eventId={eventId} close={close} />}
      {sheet === "upload" && <HSheet label="Plain upload" close={close}><p className="mute">{p.event.name}</p><Upload primary label="Add the attendee list" path={`/api/events/${eventId}/upload`} accept={`.csv,.xlsx,text/csv,${XLSX}`} onDone={() => { close(); onChange(); }} /></HSheet>}
      {sheet && typeof sheet === "object" && <ToCheckSheet eventId={eventId} startId={sheet.check} close={close} reload={load} />}
    </section>
  );
}

/* ------------------------------------------------------------------ the extension */

function ExtensionSheet({ p, close }: { p: Panel; close: () => void }) {
  const ext = p.sources.filter((s) => s.via === "extension");
  return (
    <HSheet label="Web portal" close={close}>
      <p className="mute">{p.event.name}</p>
      {ext.length > 0
        ? <Facts rows={ext.map((s) => [PLATFORM[s.platform] ?? s.platform, plural(s.n, "person", "people")])} />
        : <p className="mute" role="status">Nothing read yet</p>}
      <div className="actions"><Link to="/settings?section=extension" go={(to) => { close(); location.assign(to); }} className="btn">Set up the extension</Link></div>
    </HSheet>
  );
}

/* ------------------------------------------------------------------ organizer */

function OrganizerSheet({ eventId, close }: { eventId: string; close: () => void }) {
  const [plan, setPlan] = useState<PlanData | null>(null);
  const load = async () => { setPlan(await get<PlanData>(`/api/events/${eventId}/plan`)); };
  useEffect(() => { load(); }, [eventId]);
  return (
    <HSheet label="Request email to the organizer" close={close}>
      {plan ? <OrganizerBlock id={eventId} data={plan.assessment} canDraft={plan.can_plan} saved={load} /> : null}
    </HSheet>
  );
}

/* ------------------------------------------------------------------ to check */

function ToCheckSheet({ eventId, startId, close, reload }: { eventId: string; startId: string; close: () => void; reload: () => Promise<Panel | null> }) {
  const { actor } = useActor();
  const [list, setList] = useState<Read[] | null>(null);
  const [at, setAt] = useState(startId);
  const [name, setName] = useState(""), [title, setTitle] = useState(""), [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { get<Panel>(`/api/events/${eventId}/directory`).then((d) => setList(d?.to_check ?? [])); }, [eventId]);
  const cur = list?.find((r) => r.id === at) ?? null;
  useEffect(() => { if (cur) { setName(cur.full_name); setTitle(cur.title ?? ""); setCompany(cur.company ?? ""); setError(""); } }, [cur?.id]);
  useEffect(() => { if (list && !cur) { if (list.length) setAt(list[0].id); else close(); } }, [list, cur]);
  if (!list || !cur) return <HSheet label="To check" close={close}>{null}</HSheet>;
  const act = async (path: string, body?: unknown) => {
    setBusy(true); setError("");
    const r = await send("POST", `/api/events/${eventId}/directory/reads/${cur.id}/${path}`, actor, body ?? {});
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    const rest = list.filter((x) => x.id !== cur.id);
    setList(rest);
    await reload();
    if (!rest.length) close(); else setAt(rest[Math.min(list.indexOf(cur), rest.length - 1)].id);
  };
  const others = list.filter((r) => r.id !== cur.id);
  return (
    <HSheet label="To check" close={close}>
      <div className="gs-readas">
        <span className="mute">Read as</span>
        <b className="display">{cur.full_name}</b>
        <span>{cur.title ?? "No title"}</span>
        <span>{cur.company ?? "No company"}</span>
      </div>
      <Facts rows={[["Reason", <b key="r">{cur.check_reason}</b>], ["Source", sentence(cur.source_text)]]} />
      <form className="gs-form" onSubmit={(e) => { e.preventDefault(); void act("keep", { name, title, company }); }}>
        <label className="field"><span>Name</span><input className="input" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} autoComplete="off" /></label>
        <label className="field"><span>Title</span><input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} autoComplete="off" /></label>
        <label className="field"><span>Company</span><input className="input" value={company} maxLength={200} onChange={(e) => setCompany(e.target.value)} autoComplete="off" /></label>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="actions">
          <button className="btn" type="submit" disabled={busy || !name.trim()}>Keep</button>
          <button className="btn line" type="button" disabled={busy} onClick={() => act("dismiss")}>Dismiss</button>
        </div>
      </form>
      {others.length > 0 && (
        <section className="sheet-sec">
          <h3>{others.length} more to check</h3>
          <div className="tray">
            <ul className="gs-list">
              {others.map((r) => (
                <li key={r.id}><button type="button" className="conn gs-row gs-two" onClick={() => setAt(r.id)}><span className="conn-who"><b>{r.full_name}</b><span>{r.check_reason}</span></span><Chevron right /></button></li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </HSheet>
  );
}

/* ------------------------------------------------------------------ the screen recording */

type Phase = "pick" | "looking" | "reading" | "result";
interface Progress { at: number; total: number; found: number; toCheck: number }
interface Failed { n: number; at: number | null }

function RecordingSheet({ p, eventId, close, reload, openCheck }: { p: Panel; eventId: string; close: () => void; reload: () => Promise<Panel | null>; openCheck: () => void }) {
  const { actor } = useActor();
  const [files, setFiles] = useState<File[]>([]);
  const [app, setApp] = useState("");
  const [phase, setPhase] = useState<Phase>("pick");
  const [prog, setProg] = useState<Progress>({ at: 0, total: 0, found: 0, toCheck: 0 });
  const [look, setLook] = useState({ at: 0, total: 0 });
  const [failed, setFailed] = useState<Failed[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [finalCheck, setFinalCheck] = useState(0);
  const stop = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; stop.current = true; }, []);

  if (!p.paths.recording.can_read) {
    return <HSheet label="Read a screen recording" close={close}><p className="mute">{p.event.name}</p><p className="lead" role="status">{p.paths.recording.note}</p></HSheet>;
  }
  const video = files.length === 1 && !isImage(files[0]);
  const pickedWords = !files.length ? "" : video ? files[0].name : files.length === 1 ? files[0].name : `${files.length} screenshots`;
  const choose = (list: FileList | null) => {
    const all = [...(list ?? [])];
    setError("");
    if (!all.length) return;
    if (all.every(isImage)) { setFiles(all); return; }
    if (all.length === 1 && /^video\//.test(all[0].type)) { setFiles(all); return; }
    setFiles([]); setError("Choose one video, or screenshots of the list.");
  };

  const go = async () => {
    setError(""); setFailed([]); stop.current = false;
    const made = await send<{ id: string }>("POST", `/api/events/${eventId}/recordings`, actor, { app_name: app.trim() });
    if (!made.ok) { setError(made.error); return; }
    const rid = made.data.id;
    let frames: TakenFrame[] = [];
    try {
      if (video) {
        setPhase("looking");
        frames = await takeFrames(files[0], { onMoment: (at, total) => { if (alive.current) setLook({ at, total }); }, stopped: () => stop.current, max: MAX_FRAMES_PER_RECORDING });
      } else {
        frames = files.slice(0, MAX_FRAMES_PER_RECORDING).map((f, n) => ({ n, at: -1, blob: f }));
      }
    } catch (e) {
      if (!alive.current) return;
      setPhase("pick");
      setError(e instanceof CannotDecode ? "This browser cannot read that video. Take screenshots of the list and choose them instead." : "That file could not be read.");
      await send("POST", `/api/recordings/${rid}/finish`, actor);
      return;
    }
    if (!alive.current) return;
    if (!frames.length) { setPhase("pick"); setError("Nothing in that video looked like a list."); await send("POST", `/api/recordings/${rid}/finish`, actor); return; }
    setPhase("reading");
    const startCheck = p.counts.to_check;
    let found = 0, lastCheck = startCheck; const bad: Failed[] = [];
    for (const f of frames) {
      if (stop.current || !alive.current) break;
      setProg({ at: f.n + 1, total: frames.length, found, toCheck: 0 });
      const r = await send<{ state: string; found: number; to_check: number }>("POST", `/api/recordings/${rid}/frames`, actor, undefined, { bytes: await f.blob.arrayBuffer(), filename: "frame", type: f.blob.type || "image/jpeg", headers: { "x-frame": String(f.n) } });
      if (r.ok && r.data.state === "read") found += r.data.found;
      else bad.push({ n: f.n + 1, at: f.at >= 0 ? f.at : null });
      if (r.ok && typeof r.data.to_check === "number") lastCheck = r.data.to_check;
      if (!alive.current) return;
      setProg({ at: f.n + 1, total: frames.length, found, toCheck: Math.max(0, lastCheck - startCheck) });
      setFailed([...bad]);
    }
    const done = await send<{ message: string }>("POST", `/api/recordings/${rid}/finish`, actor);
    if (!alive.current) return;
    setMessage(done.ok ? done.data.message : done.error);
    const d = await reload();
    if (!alive.current) return;
    setFinalCheck(Math.max(0, (d?.counts.to_check ?? 0) - startCheck));
    setProg((x) => ({ ...x, found }));
    setPhase("result");
  };

  const previous = p.recordings;
  return (
    <HSheet label="Read a screen recording" close={close}>
      <p className="mute">{p.event.name}</p>
      {phase === "pick" && (
        <>
          <label className="field"><span>Video or screenshots</span>
            <span className="gs-file">
              <span className="gs-file-name">{pickedWords || "None chosen"}</span>
              <span className="btn line small gs-file-btn">{files.length ? "Change" : "Choose"}<input className="sr-only" type="file" accept="video/*,image/jpeg,image/png,image/webp" multiple onChange={(e) => choose(e.target.files)} aria-label="Video or screenshots" /></span>
            </span>
          </label>
          <label className="field"><span>App name</span><input className="input" value={app} maxLength={60} onChange={(e) => setApp(e.target.value)} autoComplete="off" /></label>
          <Facts rows={[["The video", "Stays on this computer"], ["The frames", "Sent one at a time, none kept"]]} />
          {error && <p role="alert" className="error">{error}</p>}
          <div className="actions">
            <button className="btn" type="button" disabled={!files.length || !app.trim()} onClick={go}>Read the recording</button>
            <button className="btn line" type="button" onClick={close}>Cancel</button>
          </div>
          {previous.length > 0 && (
            <section className="sheet-sec">
              <h3>Earlier recordings <span>{previous.length}</span></h3>
              <Facts rows={previous.map((r) => [r.app_name, `${num(r.people)} found, ${plural(r.frames_read, "frame")} read${r.frames_failed ? `, ${r.frames_failed} failed` : ""}`])} />
            </section>
          )}
        </>
      )}
      {phase === "looking" && (
        <>
          <dl className="figs"><div><dd>{look.total ? `${look.at} of ${look.total}` : "…"}</dd><dt>moments</dt></div></dl>
          <Facts rows={[["Recording", pickedWords], ["App", app]]} />
          <div className="actions"><button className="btn line" type="button" onClick={() => { stop.current = true; setPhase("pick"); }}>Stop</button></div>
        </>
      )}
      {phase === "reading" && (
        <>
          <dl className="figs"><div><dd>Frame {prog.at} of {prog.total}</dd></div></dl>
          <Frames total={prog.total} at={prog.at} failed={failed.map((f) => f.n)} />
          <Facts rows={[["Recording", pickedWords], ["App", app], ["People found", <b key="f">{num(prog.found)}</b>], ["To check", <b key="c">{num(prog.toCheck)}</b>]]} />
          <div className="actions"><button className="btn line" type="button" onClick={() => { stop.current = true; }}>Stop</button></div>
        </>
      )}
      {phase === "result" && (
        <>
          <dl className="figs">
            <div><dd>{prog.total}</dd><dt>frames</dt></div>
            <div><dd>{prog.total - failed.length}</dd><dt>read</dt></div>
            <div><dd>{failed.length}</dd><dt>failed</dt></div>
          </dl>
          <Frames total={prog.total} at={prog.at} failed={failed.map((f) => f.n)} />
          {failed.length > 0 && <Facts rows={failed.map((f) => [`Frame ${f.n}`, <span key="n">{f.at !== null && <span className="mute">At {clock(f.at)}</span>}<b>Not read</b></span>])} />}
          <Facts rows={[["People found", num(prog.found)], ["To check", <b key="c">{num(finalCheck)}</b>]]} />
          {message && <p className="mute" role="status">{message}</p>}
          <div className="actions">
            {finalCheck > 0 && <button className="btn" type="button" onClick={openCheck}>Check {plural(finalCheck, "read")}</button>}
            <button className={`btn${finalCheck > 0 ? " line" : ""}`} type="button" onClick={() => { setPhase("pick"); setFiles([]); }}>Read another recording</button>
          </div>
        </>
      )}
    </HSheet>
  );
}

/** One mark per frame: the ones read are filled, the ones not read are an empty outline. The shape is the data, as a signal's icon is. */
function Frames({ total, at, failed }: { total: number; at: number; failed: number[] }) {
  if (!total) return null;
  return (
    <div className="gs-frames" role="img" aria-label="Frames read">
      {Array.from({ length: total }, (_, i) => <i key={i} className={failed.includes(i + 1) ? "bad" : i < at ? "on" : ""} />)}
    </div>
  );
}
