/* The scanner on a phone (docs/SCANNER.md 8 and 10, direction A: camera first, a sheet after the scan, Today in a sheet). Its own page, like the RSVP link: no desk chrome.
   Everything it does works with no signal: the scan is saved on the phone first and sent when the app is open and online. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PERSONAS } from "../shared/roles";
import { classifyPayload, csvRow, CSV_HEAD, DEFAULT_NOTICE, METHOD_WORDS, placeable, STATE_WORDS, type Fields, type FieldName, type Method } from "../shared/scan";
import { makeDecoder, warm, type Decoder } from "./decode";
import { allItems, durable, getItem, getMeta, newScanId, putBlob, putItem, putMeta, sweep, unsyncedCount, waiting, type QueueItem } from "./queue";
import { syncAll } from "./sync";
import "./scan.css";

const PEOPLE = PERSONAS.map((p) => p.name);
const NEXT_STEPS = ["Nothing yet", "Send a note", "Call", "Book a meeting", "Send pricing", "Introduce a colleague"];

interface Cfg { event: { id: string; name: string; starts_on: string; ends_on: string; zone: string }; qualifiers: { id: string; label: string }[]; notice: { text: string; version: number }; promise_owners: string[]; organizer_ready?: boolean; talks?: { id: string; title: string }[] }
const fallbackCfg = (id: string): Cfg => ({ event: { id, name: "Scanner", starts_on: "", ends_on: "", zone: "UTC" }, qualifiers: [], notice: { text: DEFAULT_NOTICE, version: 1 }, promise_owners: [] });

interface Draft {
  id: string; method: Method; raw: string; fields: Fields; uncertain: FieldName[]; photo?: Blob; openedAt: number; scannedAt: number;
  /** Set when an item is being confirmed after it synced. */
  confirm?: QueueItem;
}

const normEmailLike = (e?: string) => Boolean(e && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.trim()));
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
// The scanner keeps its own person ("scan-actor"): choosing who is scanning on a phone must not change who the desk app is acting as. It starts from the desk's person until one is chosen here.
const storedActor = () => { try { const a = localStorage.getItem("scan-actor") ?? localStorage.getItem("actor"); return a && PEOPLE.includes(a) ? a : PEOPLE[0]; } catch { return PEOPLE[0]; } };
const hourIn = (zone: string, at = new Date()) => { try { return Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: zone }).format(at)); } catch { return at.getHours(); } };
const dayIn = (zone: string, at = new Date()) => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(at); } catch { return at.toISOString().slice(0, 10); } };

export function ScanApp() {
  const eventId = location.pathname.split("/")[2] ?? "";
  const [actor, setActorState] = useState(storedActor);
  const [cfg, setCfg] = useState<Cfg>(() => fallbackCfg(eventId));
  const [cfgNote, setCfgNote] = useState("");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [mode, setMode] = useState<"scan" | "today">("scan");
  const [method, setMethod] = useState<"code" | "photo" | "card" | "type">("code");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState("");
  const actorRef = useRef(actor);
  actorRef.current = actor;
  const setActor = (a: string) => { setActorState(a); try { localStorage.setItem("scan-actor", a); } catch { /* private window */ } };

  const reload = useCallback(async () => setItems(await allItems(eventId)), [eventId]);

  // The event's settings: from the desk when online, from the phone's copy when not.
  useEffect(() => {
    (async () => {
      const saved = await getMeta<Cfg>(`config:${eventId}`);
      if (saved) setCfg(saved);
      try {
        const r = await fetch(`/api/events/${eventId}/scanner`, { headers: { "x-actor": encodeURIComponent(actorRef.current) } });
        if (r.ok) {
          const j = (await r.json()) as Cfg;
          // The accepted talks of this event, for "From the session". Kept in the phone's copy so the choice is there with no signal.
          if (!j.talks) {
            const sp = await fetch(`/api/events/${eventId}/speaking`, { headers: { "x-actor": encodeURIComponent(actorRef.current) } }).catch(() => null);
            if (sp?.ok) j.talks = ((await sp.json()) as { talks: { id: string; title: string; status: string }[] }).talks.filter((t) => t.status === "accepted" && t.title).map((t) => ({ id: t.id, title: t.title }));
          }
          setCfg(j); setCfgNote(""); await putMeta(`config:${eventId}`, j);
        }
        else if (!saved) setCfgNote("This event could not be found.");
      } catch { if (!saved) setCfgNote("No signal and nothing saved yet: typing works, with the standard notice."); }
    })();
    void sweep(eventId).then(reload);
  }, [eventId, reload]);

  const sync = useCallback(async () => {
    setSyncing(true);
    const out = await syncAll(eventId, actorRef.current);
    await refreshFromDesk(eventId, actorRef.current);
    await reload();
    setSyncing(false);
    setLastSync(out.offline ? "No signal. The scans are safe on this phone." : out.failed ? "Some scans did not go. They will be tried again." : "");
  }, [eventId, reload]);

  useEffect(() => {
    const on = () => { setOnline(true); void sync(); }, off = () => setOnline(false), vis = () => { if (document.visibilityState === "visible") void sync(); };
    addEventListener("online", on); addEventListener("offline", off); document.addEventListener("visibilitychange", vis);
    void sync();
    const t = setInterval(() => { if (navigator.onLine) void allItems(eventId).then((it) => { if (it.some(waiting)) void sync(); }); }, 30_000);
    return () => { removeEventListener("online", on); removeEventListener("offline", off); document.removeEventListener("visibilitychange", vis); clearInterval(t); };
  }, [sync, eventId]);

  // The shell and the decoder are kept for the next time there is no signal.
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/scan-sw.js", { scope: "/scan/" }).catch(() => undefined);
    void warm();
    const link = document.createElement("link"); link.rel = "manifest"; link.href = `/scan/${eventId}/manifest.webmanifest`; document.head.appendChild(link);
    document.title = "Scanner";
    return () => link.remove();
  }, [eventId]);

  const unsynced = unsyncedCount(items);
  const atEnd = hourIn(cfg.event.zone) >= 18 || Boolean(cfg.event.ends_on && dayIn(cfg.event.zone) > cfg.event.ends_on);
  const toConfirm = items.filter((i) => i.result?.state === "to_confirm").length;
  const open = (d: Omit<Draft, "openedAt" | "scannedAt" | "uncertain"> & Partial<Pick<Draft, "uncertain">>) => setDraft({ uncertain: [], ...d, openedAt: Date.now(), scannedAt: Date.now() });

  return (
    <div className="sc" data-ready="1">
      <header className="sc-top">
        <div className="ev"><b>{cfg.event.name}</b><span><b className="strong">{online ? "Online" : "Offline"}</b><span><b className="strong">{unsynced}</b> unsynced</span></span></div>
        <button type="button" className="textlink" onClick={() => void sync()} disabled={!online || syncing}>{syncing ? "Syncing" : "Sync"}</button>
      </header>
      {mode === "scan" && !draft && <Camera method={method} setMethod={setMethod} cfg={cfg} cfgNote={cfgNote} onCode={(raw) => {
        const c = classifyPayload(raw);
        if (!c) return false;
        if (c.kind === "id") open({ id: newScanId(), method: "badge_id", raw: c.id, fields: {} });
        else open({ id: newScanId(), method: "badge_code", raw, fields: c.fields });
        return true;
      }} atEnd={atEnd && unsynced > 0} unsynced={unsynced} online={online} syncing={syncing} sync={() => void sync()} onPhoto={(b, kind) => open({ id: newScanId(), method: kind === "card" ? "card_photo" : "badge_photo", raw: "", fields: {}, photo: b })} onType={() => open({ id: newScanId(), method: "typed", raw: "", fields: {} })} onToday={() => setMode("today")} />}
      {mode === "today" && !draft && <Today actor={actor} setActor={setActor} cfg={cfg} items={items} unsynced={unsynced} toConfirm={toConfirm} online={online} syncing={syncing} lastSync={lastSync} sync={() => void sync()} close={() => setMode("scan")}
        confirm={(it) => open({ id: it.id, method: it.input.method, raw: it.input.raw_payload ?? "", fields: { ...(it.server?.fields ?? {}), ...(it.input.fields as Fields | undefined) }, uncertain: it.server?.uncertain ?? [], confirm: it })}
        retake={(kind) => { setMode("scan"); setMethod(kind); }} />}
      {draft && <Sheet key={draft.id} draft={draft} cfg={cfg} actor={actor} unsynced={unsynced} onClose={() => { setDraft(null); }} onSaved={async () => { setDraft(null); setMode("scan"); await reload(); void sync(); }} />}
      {!durable && <div className="sc-notice" style={{ padding: "0 16px 12px" }}>This browser will not keep scans after the page closes. Sync before you leave.</div>}
    </div>
  );
}

/** What the desk now says about this phone's scans: the fields a read found, what to check, where each one stands. */
async function refreshFromDesk(eventId: string, actor: string) {
  try {
    const r = await fetch(`/api/events/${eventId}/scans`, { headers: { "x-actor": encodeURIComponent(actor) } });
    if (!r.ok) return;
    const rows = ((await r.json()) as { scans: { id: string; state: string; state_detail: string; fields: Fields; uncertain: FieldName[]; name: string | null; company: string | null; contact_id: string | null; review: string | null }[] }).scans;
    for (const s of rows) {
      // The newest copy of the item is changed, so an edit saved meanwhile is kept.
      const it = await getItem(s.id);
      if (!it || !it.sent) continue;
      it.server = { fields: s.fields, uncertain: s.uncertain };
      it.result = { id: s.id, state: s.state as never, state_detail: s.state_detail, person: s.contact_id ? { id: s.contact_id, name: s.name, company: s.company } : null, repeat: false, review: s.review as never };
      it.label = { name: s.name ?? s.fields.name ?? it.label.name, company: s.company ?? s.fields.company ?? it.label.company };
      await putItem(it);
    }
  } catch { /* offline: the phone's own copy stands */ }
}

/* ------------------------------------------------------------------ the camera */

function Camera(p: { atEnd: boolean; unsynced: number; online: boolean; syncing: boolean; sync: () => void; method: "code" | "photo" | "card" | "type"; setMethod: (m: "code" | "photo" | "card" | "type") => void; cfg: Cfg; cfgNote: string; onCode: (raw: string) => boolean; onPhoto: (b: Blob, kind: "badge" | "card") => void; onType: () => void; onToday: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"starting" | "on" | "blocked" | "frozen">("starting");
  const [kind, setKind] = useState("");
  const stream = useRef<MediaStream | null>(null);
  const decoder = useRef<Decoder | null>(null);
  const last = useRef({ text: "", at: 0 });
  const { method, onCode } = p;
  // A badge code can be typed when the camera cannot read it (week 2, J13): always on offer in Code mode, open at once when the camera is not there.
  const [typing, setTyping] = useState(false), [typed, setTyped] = useState(""), [notRead, setNotRead] = useState(false);
  const submitTyped = () => { const t = typed.trim(); if (!t) return; if (onCode(t)) { setTyped(""); setNotRead(false); } else setNotRead(true); };

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera API");
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (dead) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s;
        const v = video.current!;
        v.srcObject = s; v.setAttribute("playsinline", "true"); v.muted = true;
        await v.play().catch(() => undefined);
        setState("on");
        // A home-screen web app on iPhone can open the camera and show nothing. Four seconds with no frame says so.
        setTimeout(() => { if (!dead && v.videoWidth === 0) setState("frozen"); }, 4000);
      } catch { if (!dead) setState("blocked"); }
    })();
    return () => { dead = true; stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  }, []);

  useEffect(() => {
    if (method !== "code" || state !== "on") return;
    let stop = false, busy = false;
    (async () => { decoder.current ??= await makeDecoder(); setKind(decoder.current.kind); (window as unknown as { __decoder?: string }).__decoder = decoder.current.kind; })();
    const t = setInterval(async () => {
      const v = video.current, d = decoder.current;
      if (stop || busy || !v || !d || v.videoWidth === 0) return;
      busy = true;
      try {
        const text = await d.decode(v);
        if (text && !(text === last.current.text && Date.now() - last.current.at < 3000)) { last.current = { text, at: Date.now() }; if (onCode(text)) navigator.vibrate?.(30); }
      } catch { /* a frame that fails is the next frame's problem */ } finally { busy = false; }
    }, 250);
    return () => { stop = true; clearInterval(t); };
  }, [method, state, onCode]);
  useEffect(() => () => decoder.current?.close(), []);

  const shutter = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const scale = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight)), c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((b) => { if (b) p.onPhoto(b, method === "card" ? "card" : "badge"); }, "image/jpeg", 0.85);
  };
  const pick = (f: File | undefined) => { if (f) p.onPhoto(f, method === "card" ? "card" : "badge"); };
  const photo = method === "photo" || method === "card";

  return (
    <>
      <div className="sc-cam" data-decoder={kind}>
        <video ref={video} autoPlay playsInline muted aria-label="Camera" />
        {state === "on" && method === "code" && <><div className="sc-frame" /><div className="sc-hint">Aim at the code</div></>}
        {state === "on" && photo && <div className="sc-hint" style={{ top: "auto", bottom: 16 }}>{method === "card" ? "Fill the frame with the card, then take it" : "Show the badge face, then take it"}</div>}
        {state === "on" && method === "type" && <div className="sc-hint">Typing needs no camera</div>}
        {state === "starting" && <div className="sc-dark"><p>Opening the camera</p></div>}
        {(state === "blocked" || state === "frozen") && (
          <div className="sc-dark">
            <p>{state === "blocked" ? "The camera is not available here." : "The camera opened but shows nothing. This happens in some home-screen web apps."}</p>
            <p>Open this page in Safari to scan codes, or take a photo with the phone's camera, or type the person.</p>
            <label className="textlink" style={{ cursor: "pointer" }}>Take a photo<input type="file" accept="image/*" capture="environment" className="sc-hidden" onChange={(e) => pick(e.target.files?.[0])} /></label>
          </div>
        )}
        {p.cfgNote && <div className="sc-hint" style={{ top: 12 }}>{p.cfgNote}</div>}
      </div>
      <div className="sc-foot">
        {p.atEnd && <div className="sc-end"><span>The day is over. {p.unsynced} {p.unsynced === 1 ? "scan is" : "scans are"} only on this phone.</span><button type="button" className="btn big" onClick={p.sync} disabled={!p.online || p.syncing}>{p.syncing ? "Syncing" : "Sync now"}</button></div>}
        {method === "code" && (typing || state === "blocked" || state === "frozen") && (
          <form className="sc-codebox" onSubmit={(e) => { e.preventDefault(); submitTyped(); }}>
            <input className="sc-input" aria-label="Badge code" value={typed} onChange={(e) => { setTyped(e.target.value); setNotRead(false); }} placeholder="Badge code" autoComplete="off" autoCapitalize="off" spellCheck={false} />
            <button type="submit" className="textlink" disabled={!typed.trim()}>Use the code</button>
            {notRead && <p className="sc-notice" role="alert">That is not a badge code this desk can read.</p>}
          </form>
        )}
        <div className="sc-methods" role="group" aria-label="How to scan">
          {([["code", "Code"], ["photo", "Photo"], ["card", "Card"], ["type", "Type"]] as const).map(([k, label]) => (
            <button type="button" key={k} aria-pressed={method === k} onClick={() => { p.setMethod(k); if (k === "type") p.onType(); }}>{label}</button>
          ))}
        </div>
        <div className="sc-bar">
          <button type="button" className="textlink" onClick={p.onToday}>Today</button>
          {method === "code" && state === "on" && !typing && <button type="button" className="textlink" onClick={() => setTyping(true)}>Type the code</button>}
          {photo && <button type="button" className="sc-shutter" aria-label="Take the photo" onClick={shutter} disabled={state !== "on"} />}
        </div>
        <p className="sc-notice">{p.cfg.notice.text}</p>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ the one screen after a scan */

function Sheet({ draft, cfg, actor, unsynced, onClose, onSaved }: { draft: Draft; cfg: Cfg; actor: string; unsynced: number; onClose: () => void; onSaved: () => Promise<void> }) {
  const confirming = Boolean(draft.confirm);
  const [f, setF] = useState<Fields>(draft.fields);
  const [edit, setEdit] = useState(false);
  const [heat, setHeat] = useState<"hot" | "warm" | "cold">(draft.confirm?.input.temperature as never ?? "warm");
  const [q, setQ] = useState<Record<string, "yes" | "no">>({});
  const [note, setNote] = useState(""), [promise, setPromise] = useState(""), [owner, setOwner] = useState(actor);
  const [step, setStep] = useState(NEXT_STEPS[0]), [on, setOn] = useState("");
  const [consent, setConsent] = useState(false), [error, setError] = useState(""), [busy, setBusy] = useState(false), [asking, setAsking] = useState(false);
  // "From the session": none the first time, then the last choice on this phone, as long as that talk is still one of the event's.
  const talks = cfg.talks ?? [];
  const [talk, setTalkState] = useState(() => { try { const t = localStorage.getItem(`scan-talk:${cfg.event.id}`) ?? ""; return talks.some((x) => x.id === t) ? t : ""; } catch { return ""; } });
  const setTalk = (t: string) => { setTalkState(t); try { localStorage.setItem(`scan-talk:${cfg.event.id}`, t); } catch { /* private window */ } };
  const photoOnly = Boolean(draft.photo) && !confirming;
  const wasChanged = useMemo(() => JSON.stringify(f) !== JSON.stringify(draft.fields) || note || promise, [f, draft.fields, note, promise]);

  const owners = [...new Set([actor, ...cfg.promise_owners])];
  const open: FieldName[] = confirming ? (["name", "company", "title", "email", "phone"] as FieldName[]).filter((k) => draft.uncertain.includes(k) || !f[k] || edit)
    : draft.method === "typed" ? ["name", "company", "email"] : edit ? ["name", "company", "title", "email", "phone"] : draft.uncertain;
  const LABEL: Record<FieldName, string> = { name: "Name", company: "Company", title: "Title", email: "Email", phone: "Phone", country: "Country", linkedin: "LinkedIn" };
  const heading = f.name || (draft.method === "badge_id" ? `Badge ${draft.raw.slice(0, 24)}` : draft.method === "typed" ? "New person" : draft.photo ? (draft.method === "card_photo" ? "Business card" : "Badge photo") : "Someone");
  const sub = f.company ?? (draft.method === "badge_id" ? "Looked up when this phone syncs" : photoOnly ? "Read when this phone syncs" : "");

  const save = async () => {
    setError("");
    const fields: Fields = {}; for (const k of Object.keys(f) as FieldName[]) if (f[k]?.trim()) fields[k] = f[k]!.trim();
    if (confirming) {
      const it = (await getItem(draft.confirm!.id)) ?? draft.confirm!;
      const changed: Record<string, string> = {};
      for (const k of Object.keys(fields) as FieldName[]) if (fields[k] !== (it.server?.fields?.[k] ?? "")) changed[k] = fields[k]!;
      it.edit = { ...changed, ...(Object.keys(changed).length ? {} : { name: fields.name ?? it.label.name ?? "" }) };
      if (!it.edit.name) delete it.edit.name;
      await putItem(it); await onSaved(); return;
    }
    if (draft.method === "typed" && !placeable(fields)) { setError("Give an email, or a name and a company."); return; }
    setBusy(true);
    const now = Date.now();
    const input = {
      id: draft.id, method: draft.method, raw_payload: draft.raw, fields, temperature: heat, qualifiers: q, note, promise, promise_owner: promise.trim() ? owner : null,
      next_step: step === NEXT_STEPS[0] ? "" : step, next_step_on: on || null, marketing_consent: consent, notice_version: cfg.notice.version, scanned_at: new Date(draft.scannedAt).toISOString(),
      seconds: Math.round((now - draft.openedAt) / 1000), ...(talk ? { talk_id: talk } : {}), device: /iPhone|iPad/.test(navigator.userAgent) ? "iOS" : /Android/.test(navigator.userAgent) ? "Android" : "web",
    };
    const item: QueueItem = { id: draft.id, event_id: cfg.event.id, rep: actor, input, label: { name: fields.name ?? null, company: fields.company ?? null }, saved_at: draft.scannedAt, sent: false };
    if (draft.photo) { await putBlob(draft.id, draft.photo); item.photo = { kind: draft.method === "card_photo" ? "card" : "badge", total: draft.photo.size, sent_bytes: 0, read: false }; }
    await putItem(item);
    setBusy(false);
    await onSaved();
  };

  return (
    <section className="sc-sheet" aria-label={confirming ? "Check this scan" : "This scan"}>
      <div className="sc-sheet-head"><span>{confirming ? "To confirm" : `${METHOD_WORDS[draft.method]}, ${clock(draft.scannedAt)}`}</span>
        <button type="button" className="textlink icon" aria-label="Close" onClick={() => (wasChanged ? setAsking(true) : onClose())}><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m4 4 12 12M16 4 4 16" /></svg></button></div>
      <div className="sc-body">
        <div className="sc-person"><div><h3>{heading}</h3>{sub && <p>{sub}</p>}</div>{!confirming && draft.method !== "typed" && !photoOnly && <button type="button" className="textlink" onClick={() => setEdit(!edit)}>{edit ? "Done" : "Edit"}</button>}{photoOnly && <button type="button" className="textlink" onClick={() => setEdit(!edit)}>{edit ? "Done" : "Type it now"}</button>}</div>
        {(photoOnly && !edit ? [] : open).map((k) => (
          <label className="sc-field" key={k}><span>{LABEL[k]}{draft.uncertain.includes(k) && <b className="check">check</b>}</span>
            <input className="sc-input" value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} inputMode={k === "email" ? "email" : k === "phone" ? "tel" : "text"} autoCapitalize={k === "email" ? "none" : "words"} autoComplete="off" autoCorrect="off" /></label>
        ))}
        {!confirming && (
          <>
            <div className="sc-heat" role="group" aria-label="Interest">{(["hot", "warm", "cold"] as const).map((h) => <button type="button" key={h} aria-pressed={heat === h} onClick={() => setHeat(h)}>{h[0].toUpperCase() + h.slice(1)}</button>)}</div>
            {talks.length > 0 && <label className="sc-field"><span>From the session</span><select className="sc-input" value={talk} onChange={(e) => setTalk(e.target.value)}><option value="">None</option>{talks.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>}
            {cfg.qualifiers.length > 0 && <div className="sc-quals">{cfg.qualifiers.map((x) => (
              <div className="sc-qrow" key={x.id}><span>{x.label}</span>
                <div className="sc-seg" role="group" aria-label={x.label}>{(["yes", "no"] as const).map((a) => <button type="button" key={a} aria-pressed={q[x.id] === a} onClick={() => setQ({ ...q, [x.id]: q[x.id] === a ? undefined as never : a })}>{a === "yes" ? "Yes" : "No"}</button>)}</div></div>))}</div>}
            <label className="sc-field"><span>Note</span><textarea className="sc-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Say it or type it" maxLength={4000} /></label>
            <label className="sc-field"><span>What we promised them</span><textarea className="sc-input" value={promise} onChange={(e) => setPromise(e.target.value)} maxLength={1000} /></label>
            {promise.trim() && <label className="sc-field"><span>Who sends it</span><select className="sc-input" value={owner} onChange={(e) => setOwner(e.target.value)}>{owners.map((o) => <option key={o}>{o}</option>)}</select></label>}
            <div className="sc-two">
              <label className="sc-field"><span>Next step</span><select className="sc-input" value={step} onChange={(e) => setStep(e.target.value)}>{NEXT_STEPS.map((s) => <option key={s}>{s}</option>)}</select></label>
              <label className="sc-field"><span>By</span><input className="sc-input" type="date" value={on} onChange={(e) => setOn(e.target.value)} /></label>
            </div>
            <label className="sc-consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>Agreed to marketing email</span></label>
          </>
        )}
        {!confirming && !photoOnly && draft.method !== "badge_id" && !normEmailLike(f.email) && (open.length > 0 || draft.method === "badge_code") && <p className="notice">No email, no CRM task.</p>}
        {error && <p className="sc-error" role="alert">{error}</p>}
      </div>
      <div className="sc-dock"><button type="button" className="btn big" disabled={busy} onClick={() => void save()}>{confirming ? "Confirm" : "Save"}</button><p className="notice">{cfg.notice.text}{unsynced ? "" : ""}</p></div>
      {asking && <div className="sc-modal" role="dialog" aria-label="Discard this scan"><div><p>Throw this scan away?</p><button type="button" className="btn big quiet" onClick={() => setAsking(false)}>Keep it</button><button type="button" className="textlink" onClick={onClose}>Throw it away</button></div></div>}
    </section>
  );
}

/* ------------------------------------------------------------------ Today */

function Today(p: { actor: string; setActor: (a: string) => void; cfg: Cfg; items: QueueItem[]; unsynced: number; toConfirm: number; online: boolean; syncing: boolean; lastSync: string; sync: () => void; close: () => void; confirm: (it: QueueItem) => void; retake: (kind: "photo" | "type") => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const zone = p.cfg.event.zone, atEnd = hourIn(zone) >= 18 || (p.cfg.event.ends_on && dayIn(zone) > p.cfg.event.ends_on);
  const photos = p.items.filter((i) => i.photo && i.photo.sent_bytes < i.photo.total).length;
  const groups: { title: string; rows: QueueItem[] }[] = [
    { title: "Unsynced", rows: p.items.filter((i) => waiting(i) && i.result?.state !== "to_confirm") },
    { title: "To confirm", rows: p.items.filter((i) => i.result?.state === "to_confirm") },
    { title: "Waiting for lookup", rows: p.items.filter((i) => !waiting(i) && i.result?.state === "lookup_pending") },
    { title: "Not placed", rows: p.items.filter((i) => !waiting(i) && (i.result?.state === "failed" || i.result?.state === "needs_fields")) },
    { title: "Placed", rows: p.items.filter((i) => !waiting(i) && i.result?.state === "placed") },
  ].filter((g) => g.rows.length);
  const heat = (i: QueueItem) => ((i.input.temperature as string) ?? "warm").replace(/^./, (c) => c.toUpperCase());
  const who = (i: QueueItem) => i.label.name ?? (i.input.method === "badge_id" ? `Badge ${(i.input.raw_payload ?? "").slice(0, 16)}` : METHOD_WORDS[i.input.method]);
  const subline = (i: QueueItem) => i.label.company ?? (i.photo && !i.result?.person ? "Read at sync" : i.input.method === "badge_id" && !i.result?.person ? "Looked up at sync" : "");
  const stateWord = (i: QueueItem) => (waiting(i) ? "Unsynced" : i.result ? STATE_WORDS[i.result.state] : "");

  const exportCsv = () => {
    const lines = [csvRow(CSV_HEAD)];
    for (const i of [...p.items].reverse()) {
      const f = { ...(i.server?.fields ?? {}), ...((i.input.fields as Fields | undefined) ?? {}) } as Fields;
      lines.push(csvRow([new Date(i.saved_at).toISOString(), i.rep, METHOD_WORDS[i.input.method], f.name ?? i.label.name ?? "", f.email ?? "", f.company ?? i.label.company ?? "", f.title ?? "", f.phone ?? "", f.country ?? "", i.input.temperature ?? "warm",
        p.cfg.qualifiers.filter((x) => (i.input.qualifiers as Record<string, string> | undefined)?.[x.id]).map((x) => `${x.label}: ${(i.input.qualifiers as Record<string, string>)[x.id]}`).join("; "), i.input.note ?? "", i.input.promise ?? "", i.input.promise_owner ?? "", i.input.next_step ?? "", i.input.next_step_on ?? "",
        i.input.marketing_consent ? "Yes" : "No", waiting(i) ? "Unsynced" : i.result ? STATE_WORDS[i.result.state] : "", i.id]));
    }
    const url = URL.createObjectURL(new Blob([lines.join("\r\n") + "\r\n"], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = `scans-${p.cfg.event.id}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  return (
    <section className="sc-sheet" aria-label="Today">
      <div className="sc-sheet-head"><h2>Today</h2><button type="button" className="textlink icon" aria-label="Close" onClick={p.close}><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m4 4 12 12M16 4 4 16" /></svg></button></div>
      <div className="sc-body">
        <dl className="sc-figs"><div><dd>{p.items.length}</dd><dt>scans</dt></div><div><dd>{p.unsynced}</dd><dt>unsynced</dt></div><div><dd>{p.toConfirm}</dd><dt>to confirm</dt></div></dl>
        {p.unsynced > 0 && <div className="sc-wait"><span><b>Waiting on this phone:</b> {p.items.filter(waiting).length} scan{p.items.filter(waiting).length === 1 ? "" : "s"}{photos ? `, ${photos} photo${photos === 1 ? "" : "s"}` : ""}</span><span className="mute" style={{ color: "var(--mute)", fontSize: 13 }}>{atEnd ? "The day is over. " : ""}Syncs only while this page stays open{p.online ? "" : " and the phone has signal"}.</span></div>}
        {p.lastSync && <p className="notice">{p.lastSync}</p>}
        {groups.length === 0 && <div className="sc-empty"><b style={{ color: "var(--ink)" }}>No scans yet</b></div>}
        {groups.map((g) => (
          <div className="sc-group" key={g.title}><h3>{g.title}<span style={{ fontWeight: 400, color: "var(--mute)" }}>{g.rows.length}</span></h3>
            {g.rows.map((i) => (
              <div key={i.id}>
                <button type="button" className="sc-row" aria-expanded={open === i.id} onClick={() => (i.result?.state === "to_confirm" ? p.confirm(i) : setOpen(open === i.id ? null : i.id))}>
                  <span className="who"><b>{who(i)}</b><span>{subline(i)}</span></span>
                  <span className="end"><span>{clock(i.saved_at)} · {heat(i)}</span>{stateWord(i) && (waiting(i) || i.result?.state !== "placed" ? <b>{stateWord(i)}</b> : <span>{stateWord(i)}</span>)}</span>
                </button>
                {open === i.id && i.result && (i.result.state === "failed" || i.result.state === "needs_fields" || i.result.state === "lookup_pending") && (
                  <div style={{ padding: "8px 0 12px", display: "grid", gap: 8 }}>
                    <p className="notice">{i.result.state_detail || STATE_WORDS[i.result.state]}</p>
                    {i.result.state !== "lookup_pending" && <div style={{ display: "flex", gap: 8 }}><button type="button" className="textlink" onClick={() => p.retake("photo")}>Photograph it</button><button type="button" className="textlink" onClick={() => p.retake("type")}>Type it</button></div>}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        <div className="sc-actor"><span>Scanning as</span><select className="sc-input" value={p.actor} aria-label="Scanning as" onChange={(e) => p.setActor(e.target.value)}>{PEOPLE.map((n) => <option key={n}>{n}</option>)}</select></div>
        <div><button type="button" className="textlink" onClick={exportCsv} disabled={!p.items.length}>Export CSV</button></div>
      </div>
      {p.unsynced > 0 && <div className="sc-dock"><button type="button" className="btn big" onClick={p.sync} disabled={!p.online || p.syncing}>{p.syncing ? "Syncing" : "Sync now"}</button></div>}
    </section>
  );
}
