/* One event, at every stage, built for the large case first. The stage decides what leads: the upload,
   the attendee list's shape, the Run step, the cases, or the outreach list with its sheet. Nothing renders
   unbounded: people and companies are searched, filtered and paged on the server, fifty at a time.
   The same StageBlock renders compact inside the side sheet. */

import { personHref } from "./To";
import { companyDisplayName as co, dealDisplayName } from "../shared/names";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { OLD_SHEET_ERROR, type EventRow, type Stage } from "../shared/domain";
import { AFTER, afterStep } from "./stages";
import { get, send, type Card, type CompanyRow, type EventPayload, type Page, type Pending, type PersonRow, type ReviewCase, type SeatRequest, type Spread, type TopUpCounts, type TopUpItem, type UploadItem } from "./api";
import { Link, useActor } from "./App";
import { objectHref, ObjectSheets } from "./Objects";
import { Cases, openCases } from "./Cases";
import { Motion } from "./Motion";
import { ResultView } from "./Result";
import { To } from "./To";
import { Chevron, FileButton, ShowMore, SheetButton } from "./Patterns";
import { isGtm } from "../shared/roles";
import { EventLogo } from "./EventLogo";
import { Icon, Mark } from "./icons";
import { STEPS, stepAt, waiting as waitingOn } from "./waiting";
import { PersonAvatar } from "./PersonAvatar";
import { canEnd, countdown, daysTo, dropWords, firstName, initials, isRunning, longDate, money, moneyFine, num, plural, stageSentence } from "./words";
import { cardBreakdown, creditWork } from "../shared/vendors";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const fileType = (name: string) => (name.toLowerCase().endsWith(".xlsx") ? XLSX : "text/csv");
/** Rows per page in the people and company tables: a page fits on a screen, and search, filters and pages do the rest. */
const PAGE = 12;
const CASE_STAGES: Stage[] = ["ready_for_review", "finding_people", "flagging", "delivered", "paused"];
const uploaderOf = (d: EventPayload) => d.list.upload?.uploaded_by ?? d.event.requested_by;
const pendingCard = (d: EventPayload) => (d.cards ?? (d.card ? [d.card] : [])).find((c) => c.status === "pending") ?? null;

// Vendor credits and AI dollars are never blended or converted: `cardBreakdown` gives each vendor's credits and the AI dollars apart.
// Credits used so far come by step from the ledger, so the Cost fold groups them by the work they paid for.
const byWork = (entries: [string, number][]) => { const m = new Map<string, number>(); for (const [step, n] of entries) if (n > 0) m.set(creditWork(step), (m.get(creditWork(step)) ?? 0) + n); return [...m.entries()]; };

export interface EventState { id: string; data: EventPayload | null; cases: ReviewCase[]; missing: boolean; load: () => Promise<void>; open: ReviewCase[]; rows: number; note: string }

export function useEvent(id: string): EventState {
  const [data, setData] = useState<EventPayload | null>(null);
  const [cases, setCases] = useState<ReviewCase[]>([]);
  const [missing, setMissing] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const load = async () => {
    const d = await get<EventPayload>(`/api/events/${id}`);
    if (!d) { setMissing(true); return; }
    setData(d);
    // Cases load after the page has what it needs to draw; the header never waits on them.
    if (CASE_STAGES.includes(d.event.stage)) get<{ cases: ReviewCase[] }>(`/api/events/${id}/cases`).then((k) => setCases(k?.cases ?? []));
  };
  useEffect(() => { setData(null); setCases([]); setMissing(false); load(); }, [id]);
  useEffect(() => {
    if (!data || !isRunning(data.event.stage)) return;
    timer.current = window.setTimeout(load, 1500);
    return () => clearTimeout(timer.current);
  }, [data]);

  const open = openCases(cases);
  const rows = data?.list.upload?.row_count ?? 0;
  let note = "";
  if (data) {
    const e = data.event, who = firstName(uploaderOf(data)), card = pendingCard(data);
    const MOTION_NOTE: Record<string, string> = { owners: "Account owners are deciding.", sequencing: "Sequences are being set up.", in_market: "In market.", follow_up: "Following up after the event.", closing: "Closing out.", scored: "Scored." };
    const k = e.stage === "delivered" ? afterStep(e) : null;
    if (k?.key === "follow_up" && !e.post_started_at) note = "The event is over. The follow-up is ready to start.";
    else if (k && MOTION_NOTE[k.key]) note = "";
    else if (e.stage === "delivered" && e.last_day && new Date().toISOString().slice(0, 10) > e.last_day) note = "";
    else if (e.stage === "delivered") note = `Outreach list ready. ${plural(data.list.people, "person", "people")} to reach${open.length ? `, ${open.length} to settle` : ""}.`;
    else if (e.stage === "quoted") note = `${card?.kind === "research" ? "Research card" : "Cost card"} waiting on ${who}.`;
    else if (e.stage === "ready_for_review") note = card ? `Companies researched. Waiting on ${who} to verify and find contacts.` : (data.open_cases ?? 0) > 0 ? `Research done. ${plural(data.open_cases ?? 0, "case")} to settle before verifying contacts.` : "Research done. Ready for the Outreach card.";
    else if (e.stage === "paused") { const why = data.activity.find((a) => a.kind === "stage" && /failing|Paused before/.test(a.detail))?.detail; note = why ? `Paused: ${why.replace(/\.$/, "")}.` : stageSentence(e, data.settings); }
    else note = stageSentence(e, data.settings);
  }
  return { id, data, cases, missing, load, open, rows, note };
}

/* ------------------------------------------------------------------ pieces */

/** Filter and page state kept in the URL, so a view can be shared. */
function useUrlState(keys: string[], defaults: Record<string, string>) {
  const read = () => { const p = new URLSearchParams(location.search); return Object.fromEntries(keys.map((k) => [k, p.get(k) ?? defaults[k] ?? ""])); };
  const [st, setSt] = useState<Record<string, string>>(read);
  // A link inside the page (a company named in a person's row) changes the address without remounting: read it again when it moves.
  const search = location.search;
  useEffect(() => { const next = read(); if (keys.some((k) => next[k] !== st[k])) setSt(next); }, [search]);
  const set = (patch: Record<string, string>) => {
    const next = { ...st, ...patch };
    setSt(next);
    const p = new URLSearchParams(location.search);
    for (const k of keys) { if (next[k] && next[k] !== (defaults[k] ?? "")) p.set(k, next[k]); else p.delete(k); }
    // The view (#people, #outreach) stays: a filter change must not send a reload back to another view.
    history.replaceState(null, "", `${location.pathname}${p.toString() ? `?${p}` : ""}${location.hash}`);
  };
  return [st, set] as const;
}

/** Numbers set as a line of type, each with its word. */
function Figures({ items, small }: { items: (readonly [number | string, string])[]; small?: boolean }) {
  return <dl className={`figs${small ? " small" : ""}`}>{items.map(([n, w]) => <div key={w}><dd>{typeof n === "number" ? num(n) : n}</dd><dt>{w}</dt></div>)}</dl>;
}

function Upload({ label, path, accept, onDone, primary, small }: { label: string; path: string; accept: string; onDone: (data?: unknown) => void; primary?: boolean; small?: boolean }) {
  const { actor } = useActor();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError("");
    const r = await send("POST", path, actor, undefined, { bytes: await file.arrayBuffer(), filename: file.name, type: fileType(file.name) });
    setBusy(false);
    if (r.ok) onDone(r.data); else setError(r.error);
  };
  return (
    <div className="actions">
      <label className={`btn${primary ? "" : " line"}${small ? " small" : ""}`}>{busy ? "Reading the file…" : label}<input className="sr-only" type="file" accept={accept} aria-label={label} onChange={(ev) => pick(ev.target.files?.[0])} disabled={busy} /></label>
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}

function EndEvent({ id, onDone }: { id: string; onDone: () => void }) {
  const { actor } = useActor();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  if (!open) return <button className="btn line small danger" type="button" onClick={() => setOpen(true)}>End this event</button>;
  return (
    <form className="form" onSubmit={async (ev) => { ev.preventDefault(); const r = await send("POST", `/api/events/${id}/cancel`, actor, { reason }); if (r.ok) onDone(); else setError(r.error); }}>
      <p className="display" style={{ fontSize: 22 }}>End this event?</p>
      <label className="field"><span>Why</span><input className="input" value={reason} onChange={(ev) => setReason(ev.target.value)} autoFocus required /></label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        <button className="btn warm" type="submit" disabled={!reason.trim()}>End it</button>
        <button className="btn line" type="button" onClick={() => setOpen(false)}>Keep it</button>
      </div>
    </form>
  );
}

/** A quiet action that asks once more before it does something that cannot be taken back. */
function Sure({ label, confirm, run }: { label: string; confirm: string; run: () => Promise<void> }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!sure) return <button className="btn line small" type="button" onClick={() => setSure(true)}>{label}</button>;
  return (
    <span className="sure">
      <button className="btn warm small" type="button" disabled={busy} onClick={async () => { setBusy(true); await run(); setBusy(false); setSure(false); }}>{confirm}</button>
      <button className="btn line small" type="button" disabled={busy} onClick={() => setSure(false)}>Keep it</button>
    </span>
  );
}

const newWords = (n: number, known: number) => `${num(n)} new, ${num(known)} already in`;

/** New registrations while they run: the top-up's own stage, inside the event's page. */
function TopUpPanel({ t, go, onEnd }: { t: TopUpItem; go: (to: string) => void; onEnd: () => void }) {
  const ev = useEvent(t.id);
  const { actor, refresh } = useActor();
  const [error, setError] = useState("");
  const closed = Boolean(ev.data?.event.merged_at || ev.data?.event.ended_at);
  useEffect(() => { if (closed) { onEnd(); refresh(); } }, [closed]);
  return (
    <section className="topup" aria-label="New registrations">
      <div className="topup-head">
        <p className="display">{newWords(t.new_rows ?? 0, t.already_in ?? 0)}</p>
        <Sure label="Discard" confirm="Discard" run={async () => { const r = await send("POST", `/api/events/${t.id}/discard`, actor); if (r.ok) { setError(""); onEnd(); refresh(); } else setError(r.error); }} />
      </div>
      {error && <p role="alert" className="error">{error}</p>}
      <StageBlock ev={ev} go={go} compact />
    </section>
  );
}

/** Every attendee list received, with the original to download. Replace shows while nothing has been paid for; at delivered, new registrations come in here. */
function AttendeeList({ d, go, onChange }: { d: EventPayload; go: (to: string) => void; onChange: () => void }) {
  const [counts, setCounts] = useState("");
  const uploads: UploadItem[] = d.uploads ?? [];
  if (!uploads.length) return null;
  const e = d.event;
  const canReplace = e.stage === "mapped" || e.stage === "quoted";
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const tops = d.top_ups ?? [];
  const running = tops.find((t) => !t.ended_at && !t.merged_at) ?? null;
  const rows = [
    ...uploads.map((u) => ({ key: u.id, filename: u.filename, who: u.uploaded_by, at: u.created_at, n: u.file_rows ?? u.row_count, fresh: u.top_up_id ? u.row_count : null, stopped: false, has_file: u.has_file, base: `/api/events/${e.id}/uploads/${u.id}`, first: !u.top_up_id })),
    ...tops.filter((t) => !t.merged_at && t.upload_id).map((t) => ({ key: t.id, filename: t.filename ?? "", who: t.uploaded_by ?? "", at: t.created_at, n: t.file_rows ?? 0, fresh: t.new_rows, stopped: Boolean(t.ended_at), has_file: t.has_file, base: `/api/events/${t.id}/uploads/${t.upload_id}`, first: false })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <section className="alist" aria-label="Attendee list">
      <div className="al-head">
        <h2 className="display">Attendee list</h2>
        {e.stage === "delivered" && !running && <Upload small label="Add new registrations" path={`/api/events/${e.id}/new-registrations`} accept={`.csv,.xlsx,text/csv,${XLSX}`} onDone={(out) => { const c = out as TopUpCounts; setCounts(c.top_up_id ? "" : newWords(c.new_rows, c.already_in)); onChange(); }} />}
      </div>
      {counts && !running && <p className="al-note" role="status">{counts}</p>}
      <ul>
        {rows.map((u) => (
          <li key={u.key}>
            <div className="al-main">
              <p className="al-name">{u.filename || "Attendee list"}</p>
              <p className="al-meta">{u.who}<i aria-hidden="true" />{day(u.at)}<i aria-hidden="true" />{plural(u.n, "attendee")}{u.fresh !== null && !u.stopped && <><i aria-hidden="true" />{num(u.fresh)} new</>}{u.stopped && <><i aria-hidden="true" />Stopped</>}{!u.has_file && <><i aria-hidden="true" />Rebuilt from the rows</>}</p>
            </div>
            <div className="al-side">
              {canReplace && u.first && <Upload small label="Replace" path={`/api/events/${e.id}/upload`} accept={`.csv,.xlsx,text/csv,${XLSX}`} onDone={onChange} />}
              {u.has_file
                ? <FileButton href={`${u.base}/file`} label="Download original" />
                : <FileButton href={`${u.base}/rows`} label="Download rows" />}
            </div>
          </li>
        ))}
      </ul>
      {running && <TopUpPanel key={running.id} t={running} go={go} onEnd={onChange} />}
    </section>
  );
}

/** A real confirmation: names the event, says it cannot be undone. Nothing is ever deleted by itself. */
function DeleteEvent({ e, hasSheet, go }: { e: EventRow; hasSheet: boolean; go: (to: string) => void }) {
  const { actor, refresh } = useActor();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dlg = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); setError(""); };
  useEffect(() => {
    if (!open) return;
    const FOCUSABLE = "button:not([disabled])";
    dlg.current?.querySelector<HTMLElement>("[data-keep]")?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") { ev.preventDefault(); close(); return; }
      if (ev.key !== "Tab" || !dlg.current) return;
      const els = [...dlg.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("dlg-open");
    const back = opener.current;
    return () => { document.removeEventListener("keydown", onKey); document.body.classList.remove("dlg-open"); back?.focus(); };
  }, [open]);
  const run = async () => {
    setBusy(true);
    const r = await send("DELETE", `/api/events/${e.id}`, actor);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    await refresh();
    go("/events");
  };
  return (
    <>
      <button ref={opener} className="btn line small danger" type="button" onClick={() => setOpen(true)}>Delete this event</button>
      {open && createPortal(
        <div className="dlg-scrim" onMouseDown={(ev) => { if (ev.target === ev.currentTarget && !busy) close(); }}>
          <div className="dlg" ref={dlg} role="alertdialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-d">
            <h2 id="dlg-t" className="display">Delete {e.name}?</h2>
            <div id="dlg-d" className="dlg-body">
              <p>This cannot be undone.</p>
              {hasSheet && <p className="mute">The Google Sheet stays in Drive.</p>}
            </div>
            {error && <p role="alert" className="error">{error}</p>}
            <div className="actions">
              <button className="btn warm" type="button" disabled={busy} onClick={run}>{busy ? "Deleting…" : "Delete"}</button>
              <button className="btn line" type="button" data-keep disabled={busy} onClick={close}>Keep it</button>
            </div>
          </div>
        </div>, document.body)}
    </>
  );
}

/** The Run step: the person who uploaded the attendee list confirms a paid step. Others read it. */
function RunStep({ d, card, onChange, onError, compact }: { d: EventPayload; card: Card; onChange: () => Promise<void>; onError: (m: string) => void; compact?: boolean }) {
  const { actor, demo, needs } = useActor();
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState("");
  const uploader = uploaderOf(d), mine = uploader === actor;
  const L = card.lines as unknown as Record<string, number>;
  const est = (card.lines as unknown as { estimate?: { credits: number; llm: number } }).estimate;
  const bd = cardBreakdown(card);
  const kind = card.kind ?? "card";
  const what: (readonly [number, string])[] = kind === "research"
    ? [[L.companies ?? 0, "companies"], [L.unresolved_companies ?? 0, "still to identify"], [L.reverse_lookup_rows ?? 0, "matched by email domain"], [L.contacts ?? 0, "people kept"]]
    : kind === "outreach"
      ? [[L.max_people ?? L.contacts ?? 0, "people at most"], [L.attendees_ab ?? 0, "attendees"], [L.discovered_people ?? 0, "found at companies"]]
      : [[L.contacts ?? 0, "people looked up"], [L.linkedin_credits ?? 0, "LinkedIn lookups"]];
  const decide = async (decision: "approve" | "decline") => {
    setBusy(true); onError("");
    const ap = await get<{ approvals: Pending[] }>("/api/approvals");
    const a = ap?.approvals.find((x) => x.event_id === d.event.id && x.kind !== "seats");
    const r = a ? await send("POST", `/api/demo/approvals/${a.id}`, actor, { decision, reason: reason.trim() || undefined }) : { ok: false as const, error: "Nothing is waiting to run on this event." };
    setBusy(false);
    if (r.ok) { setStopping(false); await onChange(); } else onError(r.error);
  };
  const verb = kind === "research" ? "Run research" : kind === "outreach" ? "Verify and find contacts" : "Run it";
  return (
    <section className={`run${compact ? " compact" : ""}`} aria-label="Review and run" data-run={kind}>
      <div className="runhead">
        <h2 className="display">{kind === "research" ? "Research" : kind === "outreach" ? "Verify and find contacts" : "The run"}</h2>
        {(isGtm(actor) || needs?.approvers.includes(actor)) && <p className="runmoney"><b>{money(bd.ai_cents)}</b><span className="mute">AI, estimated</span></p>}
      </div>
      <Figures items={what.filter(([n], i) => n > 0 || i === 0)} small />
      <dl className="caps">
        {bd.credits.map((c) => <div key={c.vendor}><dt>{c.vendor}</dt><dd>{num(c.credits)} credits</dd></div>)}
        {typeof card.llm_cap === "number" && <div><dt>AI calls</dt><dd>{num(card.llm_cap)}</dd></div>}
        {kind === "research" && (L.retier_companies ?? 0) > 0 && <div><dt>Second look at tiers</dt><dd>{plural(L.retier_companies, "company", "companies")}</dd></div>}
        {est && <div><dt>Likely</dt><dd>{num(est.credits)} credits{typeof est.llm === "number" ? `  ·  ${num(est.llm)} AI calls` : ""}</dd></div>}
      </dl>
      {mine && demo ? (
        stopping ? (
          <form className="actions" onSubmit={(ev) => { ev.preventDefault(); decide("decline"); }}>
            <label className="sr-only" htmlFor="stop-why">Why stop</label>
            <input id="stop-why" className="input" placeholder="Why" value={reason} onChange={(ev) => setReason(ev.target.value)} autoFocus required style={{ maxWidth: 320 }} />
            <button className="btn warm" type="submit" disabled={busy || !reason.trim()}>Stop</button>
            <button className="btn line" type="button" onClick={() => setStopping(false)}>Keep it</button>
          </form>
        ) : (
          <div className="actions">
            <button className="btn" type="button" disabled={busy} onClick={() => decide("approve")}>{busy ? "Starting…" : verb}</button>
            <button className="btn line" type="button" onClick={() => setStopping(true)}>Stop</button>
          </div>
        )
      ) : (
        <div className="actions">
          <p className="mute">Waiting on {firstName(uploader)} to run this.</p>
          {!demo && <button className="btn line" type="button" disabled={busy} onClick={() => void send("POST", `/api/events/${d.event.id}/card/resend`, actor)}>Send the card again</button>}
        </div>
      )}
    </section>
  );
}

function Progress({ d }: { d: EventPayload }) {
  const e = d.event, two = e.flow === "two_card";
  const step = two ? (e.stage === "researching" ? 1 : 2) : e.stage === "tiering" ? 1 : e.stage === "enriching" ? 2 : 3;
  const total = two ? 2 : 3;
  const prio = Object.fromEntries(d.list.priorities.map((p) => [p.priority, p.n]));
  const items: (readonly [number, string])[] = e.stage === "researching"
    ? [[d.list.companies, "companies"], [d.list.people, "people on the outreach list"]]
    : [[d.list.people, "people so far"], ...(["A", "B", "C"] as const).filter((p) => prio[p]).map((p) => [prio[p], p] as const)];
  return (
    <section className="progress" aria-live="polite" aria-label="Running">
      <div className="steps" aria-hidden="true">{Array.from({ length: total }, (_, i) => <i key={i} className={i + 1 < step ? "done" : i + 1 === step ? "now" : undefined} />)}</div>
      <Figures items={items} small />
    </section>
  );
}

/** Companies by tier, as one bar. Warnings come from the spread check and block nothing. */
function Tiers({ spread, compact }: { spread: Spread; compact?: boolean }) {
  const c = spread.counts;
  if (!c.total) return null;
  const w = (n: number) => `${(100 * n) / c.total}%`;
  return (
    <div className="tiers-bar" aria-label={`${c.total} companies: ${c.tier1} tier 1, ${c.tier2} tier 2, ${c.tier3} tier 3, ${c.unknown} with no tier`}>
      <div className="tbar" aria-hidden="true"><i className="t1" style={{ width: w(c.tier1) }} /><i className="t2" style={{ width: w(c.tier2) }} /><i className="t3" style={{ width: w(c.tier3) }} /><i className="tu" style={{ width: w(c.unknown) }} /></div>
      <ul className="tkey">
        {(() => {
          const note = (kind: string, text: string) => {
            const wn = !compact ? spread.warnings.find((x) => x.kind === kind) : undefined;
            return wn ? <span className="fig over" title={`${wn.text}${wn.examples.length ? ` ${wn.examples.map((x) => x.company).join(", ")}.` : ""}`}> {text}</span> : null;
          };
          return (
            <>
              <li>{num(c.total)} companies{note("small_list", "· small list")}</li>
              <li><i className="t1" />{num(c.tier1)} tier 1{note("tier1_share", `· ${Math.round((100 * c.tier1) / c.total)}%, high`)}{note("no_tier1", "· none")}</li>
              <li><i className="t2" />{num(c.tier2)} tier 2</li><li><i className="t3" />{num(c.tier3)} tier 3</li>
              {c.unknown > 0 && <li><i className="tu" />{num(c.unknown)} no tier{note("mostly_unknown", "· over half")}</li>}
            </>
          );
        })()}
      </ul>
    </div>
  );
}

/** The narrowing, in one bar: rows uploaded to people kept, by priority, with the drop reasons under it. */
/** One row of the brief: what it is, a thin bar for how much, the number. Every row on both sides uses this, so the columns line up. */
function BriefRow({ label, n, of, tone }: { label: string; n: number; of: number; tone: string }) {
  return <li className="brow"><span>{label}</span><i aria-hidden="true"><u className={tone} style={{ width: `${of > 0 ? (100 * n) / of : 0}%` }} /></i><b>{num(n)}</b></li>;
}

/** What was researched, and who did not make the outreach list and why. */
function ListBrief({ d }: { d: EventPayload }) {
  const [all, setAll] = useState(false);
  const c = d.spread?.counts;
  const tiers: [string, number, string][] = c ? [["Tier 1", c.tier1, "t1"], ["Tier 2", c.tier2, "t2"], ["Tier 3", c.tier3, "t3"], ...(c.unknown ? [["Unknown", c.unknown, "t0"] as [string, number, string]] : [])] : [];
  const reasons = all ? d.list.dropped : d.list.dropped.slice(0, 5);
  // Each reason as a share of everyone and every row left off, as the tiers are shares of the companies researched.
  const left = d.list.dropped.reduce((n, r) => n + r.n, 0);
  return (
    <section className="brief" aria-label="The list in brief">
      {c && c.total > 0 && (
        <div>
          <h3>Companies researched<span>{num(c.total)}</span></h3>
          <ul>{tiers.map(([label, n, tone]) => <BriefRow key={label} label={label} n={n} of={c.total} tone={tone} />)}</ul>
        </div>
      )}
      {d.list.dropped.length > 0 && (
        <div>
          <h3>Left off the list<span>{num(left)}</span></h3>
          <ul>{reasons.map((r) => <BriefRow key={r.reason} label={dropWords(r.reason)} n={r.n} of={left} tone="t3" />)}</ul>
          {d.list.dropped.length > 5 && <ShowMore open={all} n={d.list.dropped.length} noun="reasons" onClick={() => setAll(!all)} />}
        </div>
      )}
    </section>
  );
}

function Pager({ total, offset, limit, onPage }: { total: number; offset: number; limit: number; onPage: (o: number) => void }) {
  if (total <= limit) return null;
  const page = Math.floor(offset / limit) + 1, pages = Math.ceil(total / limit);
  return (
    <div className="pager">
      <button className="btn line small" type="button" disabled={offset === 0} onClick={() => onPage(Math.max(0, offset - limit))}>Previous</button>
      <span className="mute small">Page {page} of {pages}</span>
      <button className="btn line small" type="button" disabled={offset + limit >= total} onClick={() => onPage(offset + limit)}>Next</button>
    </div>
  );
}


/** Scrolls a person a link pointed at into view, once, after their row has drawn. */
function ArriveAt({ id }: { id: string }) {
  useEffect(() => {
    const t = setTimeout(() => document.querySelector(`li[data-person="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    return () => clearTimeout(t);
  }, [id]);
  return null;
}

/** The people on the list: searched, filtered and paged on the server. A row opens the person. */
function PeopleTable({ id, hasPriorities, reloadKey, past = false }: { id: string; hasPriorities: boolean; reloadKey: number; past?: boolean }) {
  const [f, setF] = useUrlState(["q", "p", "t", "s", "src", "page", "person"], { s: "kept" });
  const { go } = useActor();
  const [typed, setTyped] = useState(f.q);
  const [page, setPage] = useState<Page<PersonRow> | null>(null);
  // A link to a person (?person=…) opens their panel on arrival.
  const [open, setOpen] = useState<string | null>(f.person || null);
  // The person's sheet lives in the address: closing it closes the row's highlight, and an opt-out in it reloads the list.
  useEffect(() => { setOpen(f.person || null); }, [f.person]);
  // An opt-out from the panel changes the row under it; the list reloads once the panel closes, so the panel can first say what happened.
  const [stale, setStale] = useState(0);
  const dirty = useRef(false);
  const close = () => { setOpen(null); if (dirty.current) { dirty.current = false; setStale((n) => n + 1); } };
  const offset = (Math.max(1, Number(f.page) || 1) - 1) * PAGE;
  useEffect(() => { const t = setTimeout(() => { if (typed !== f.q) setF({ q: typed, page: "" }); }, 250); return () => clearTimeout(t); }, [typed]);
  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ q: f.q, priority: f.p, tier: f.t, status: f.s || "kept", source: f.src, offset: String(offset), limit: String(PAGE) });
    get<Page<PersonRow>>(`/api/events/${id}/people?${qs}`).then((p) => { if (live) setPage(p); });
    return () => { live = false; };
  }, [id, f.q, f.p, f.t, f.s, f.src, offset, reloadKey, stale]);
  const rows = page?.rows ?? [];
  return (
    <section className="plist" aria-label="People" data-people={page?.total ?? ""}>
      <div className="grp"><h2 className="display">People</h2>{page && <span className="grp-n">{num(page.total)}</span>}</div>
      <div className="filters">
        <label className="search"><span className="sr-only">Search people</span><input value={typed} onChange={(ev) => setTyped(ev.target.value)} placeholder="Name, title, company or email" /></label>
        {hasPriorities && (
          <div className="seg" role="group" aria-label="Priority">
            {[["", "All"], ["A", "A"], ["B", "B"], ["C", "C"]].map(([v, l]) => <button key={v} type="button" aria-pressed={f.p === v} onClick={() => setF({ p: v, page: "" })}>{l}</button>)}
          </div>
        )}
        <label className="filter"><span className="sr-only">Company tier</span>
          <select value={f.t} onChange={(ev) => setF({ t: ev.target.value, page: "" })}><option value="">Any tier</option><option value="1">Tier 1</option><option value="2">Tier 2</option><option value="3">Tier 3</option><option value="unknown">No tier</option></select>
        </label>
        <label className="filter"><span className="sr-only">Attendees or prospects</span>
          <select value={f.src} onChange={(ev) => setF({ src: ev.target.value, page: "" })}><option value="">Everyone</option><option value="attendee">Attendees</option><option value="prospect">Prospects</option></select>
        </label>
        <label className="filter"><span className="sr-only">Kept or dropped</span>
          <select value={f.s || "kept"} onChange={(ev) => setF({ s: ev.target.value, page: "" })}><option value="kept">Kept</option><option value="dropped">Dropped</option><option value="all">Kept and dropped</option></select>
        </label>
      </div>
      <ul className="prows">
        {rows.map((c) => (
          <li key={c.id} className={open === c.id ? "open" : undefined} data-person={c.id}>
            <button type="button" className={`prow${c.drop_reason ? " off" : ""}`} aria-expanded={open === c.id} data-opens-sheet="" onClick={() => { setOpen(c.id); go(objectHref("person", c.id)); }}>
              <span className={`av sm ${c.drop_reason ? "off" : c.priority === "A" ? "a" : c.priority === "C" ? "c" : c.priority === "B" ? "b" : "none"}`} aria-hidden="true">{initials(c.full_name)}</span>
              <span className="pname"><b>{c.full_name ?? "No name"}</b><span className="mute"><span className={`psrc ${c.source === "prospect" ? "prospect" : "attendee"}`}>{c.source === "prospect" ? "Prospect" : "Attendee"}</span>{c.title ? co(c.title) : "No title"}</span></span>
              <span className="pco"><span className={c.company_id ? "pco-link" : undefined} data-opens-sheet={c.company_id ? "" : undefined} onClick={c.company_id ? (ev) => { ev.stopPropagation(); go(objectHref("company", `${id}|${c.company_id}`)); } : undefined}>{c.company ? co(c.company) : "No company"}</span><span className="mute">{c.company_tier ? `Tier ${c.company_tier}` : "No tier"}</span></span>
              <span className="pprio" aria-label={c.priority ? `Priority ${c.priority}` : undefined}>{c.priority ?? ""}</span>
              <span className={`pmail${c.drop_reason ? " orange" : c.email ? "" : " mute"}`}>{c.drop_reason ? dropWords(c.drop_reason) : c.email ?? "No email"}</span>
            </button>
            {open === c.id && c.id === f.person && <ArriveAt id={c.id} />}
          </li>
        ))}
      </ul>
      <ObjectSheets changed={() => setStale((n) => n + 1)} />
      {page && <Pager total={page.total} offset={offset} limit={PAGE} onPage={(o) => setF({ page: String(o / PAGE + 1) })} />}
    </section>
  );
}

/** The companies, after research: tier, what was known, people. */
/** The delivered list, by person or by company: one table at a time, chosen with the same switch as the views. The choice stays in the link. */
function ListTables({ id, hasPriorities, reloadKey, past = false }: { id: string; hasPriorities: boolean; reloadKey: number; past?: boolean }) {
  const [f, setF] = useUrlState(["by"], {});
  const by = f.by === "companies" ? "companies" : "people";
  return (
    <>
      <div className="seg list-by" role="group" aria-label="List by">
        <button type="button" aria-pressed={by === "people"} onClick={() => setF({ by: "" })}>People</button>
        <button type="button" aria-pressed={by === "companies"} onClick={() => setF({ by: "companies" })}>Companies</button>
      </div>
      {by === "people" ? <PeopleTable id={id} hasPriorities={hasPriorities} reloadKey={reloadKey} past={past} /> : <CompaniesTable id={id} reloadKey={reloadKey} />}
    </>
  );
}

function CompaniesTable({ id, reloadKey }: { id: string; reloadKey: number }) {
  const [f, setF] = useUrlState(["cq", "ct", "cpage", "co"], {});
  const { go } = useActor();
  const [typed, setTyped] = useState(f.cq);
  useEffect(() => { setTyped(f.cq); }, [f.cq]);
  const [page, setPage] = useState<Page<CompanyRow> | null>(null);
  const offset = (Math.max(1, Number(f.cpage) || 1) - 1) * PAGE;
  useEffect(() => { const t = setTimeout(() => { if (typed !== f.cq) setF({ cq: typed, cpage: "" }); }, 250); return () => clearTimeout(t); }, [typed]);
  useEffect(() => {
    let live = true;
    get<Page<CompanyRow>>(`/api/events/${id}/companies?${new URLSearchParams({ q: f.cq, tier: f.ct, offset: String(offset), limit: String(PAGE) })}`).then((p) => { if (live) setPage(p); });
    return () => { live = false; };
  }, [id, f.cq, f.ct, offset, reloadKey]);
  const rows = page?.rows ?? [];
  const status = (r: CompanyRow) => r.tier ? `Tier ${r.tier}` : r.list_status === "excluded" ? dropWords("excluded_company") : r.list_status === "existing_customer" ? dropWords("existing_customer") : r.list_status ? r.list_status.replace(/_/g, " ") : !r.in_research ? "Not researched" : "No tier";
  return (
    <section className="plist" aria-label="Companies" data-companies={page?.total ?? ""}>
      <div className="grp"><h2 className="display">Companies</h2>{page && <span className="grp-n">{num(page.total)}</span>}</div>
      <div className="filters">
        <label className="search"><span className="sr-only">Search companies</span><input value={typed} onChange={(ev) => setTyped(ev.target.value)} placeholder="Company" /></label>
        <div className="seg" role="group" aria-label="Tier">
          {[["", "All"], ["1", "Tier 1"], ["2", "Tier 2"], ["3", "Tier 3"], ["unknown", "No tier"]].map(([v, l]) => <button key={v} type="button" aria-pressed={f.ct === v} onClick={() => setF({ ct: v, cpage: "" })}>{l}</button>)}
        </div>
      </div>
      <ul className="prows">
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" className={`prow corow${r.list_status || !r.in_research ? " off" : ""}`} data-opens-sheet="" onClick={() => go(objectHref("company", `${id}|${r.id}`))}>
              <EventLogo name={co(r.name)} website={r.primary_domain ? `https://${r.primary_domain}` : null} size={30} />
              <span className="pname"><b>{co(r.name)}</b><span className="mute">{[r.industry, r.employees ? `${num(Number(r.employees))} people` : null, r.country].filter(Boolean).join(", ") || r.primary_domain || ""}</span></span>
              <span className="pco"><span>{status(r)}</span>{r.tier && (tierBasis(r.tier_fact) ?? r.tier_fact) && <span className="mute">{tierBasis(r.tier_fact) ?? r.tier_fact}</span>}</span>
              <span className="pmail mute">{r.people === r.rows_total ? plural(r.people, "person", "people") : `${r.people} of ${r.rows_total} kept`}</span>
            </button>
          </li>
        ))}
      </ul>
      {page && <Pager total={page.total} offset={offset} limit={PAGE} onPage={(o) => setF({ cpage: String(o / PAGE + 1) })} />}
      <ObjectSheets />
    </section>
  );
}

function MappedStep({ d, onChange, onError, compact }: { d: EventPayload; onChange: () => void; onError: (m: string) => void; compact?: boolean }) {
  const { actor } = useActor();
  const s = d.settings!;
  const [n, setN] = useState(String(s.contacts_per_company));
  const [prospects, setProspects] = useState(s.add_prospects);
  const [busy, setBusy] = useState(false);
  const changed = Number(n) !== s.contacts_per_company || prospects !== s.add_prospects;
  const call = async (fn: () => Promise<{ ok: boolean; error?: string }>) => { setBusy(true); const r = await fn(); setBusy(false); if (r.ok) { onError(""); onChange(); } else onError(r.error ?? ""); };
  const two = d.event.flow === "two_card";
  // New registrations run on the event's own settings.
  const topUp = Boolean(d.event.parent_event_id);
  return (
    <section className="mapped" aria-label="Attendee list">
      <Figures items={[[d.list.upload?.row_count ?? 0, "rows"], [d.list.companies, "companies"], [d.list.people, "people named"], [d.list.company_only, "company only"]]} />
      {!compact && d.list.dropped.length > 0 && <ul className="reasons">{d.list.dropped.map((x) => <li key={x.reason}><b>{num(x.n)}</b><span>{dropWords(x.reason)}</span></li>)}</ul>}
      {!topUp && <div className="mapped-set">
        <label className="field"><span>People to look for per company</span><input className="input" type="number" min="1" max="25" inputMode="numeric" value={n} onChange={(ev) => setN(ev.target.value)} style={{ maxWidth: 120 }} /></label>
        <label className="check"><input type="checkbox" checked={prospects} onChange={(ev) => setProspects(ev.target.checked)} /><span>Add prospects</span></label>
      </div>}
      <div className="actions">
        {changed
          ? <button className="btn" type="button" disabled={busy} onClick={() => call(() => send("PATCH", `/api/events/${d.event.id}/settings`, actor, { contacts_per_company: Number(n), add_prospects: prospects }))}>Save</button>
          : <button className="btn" type="button" disabled={busy} onClick={() => call(() => send("POST", `/api/events/${d.event.id}/quote`, actor))}>{topUp ? "Review and run" : "Price the card"}</button>}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- the stage */

/** What leads at this stage. Compact inside the side sheet: the action and the numbers, no tables. */
export function StageBlock({ ev, go, compact }: { ev: EventState; go: (to: string) => void; compact?: boolean }) {
  const { actor, demo, needs, refresh } = useActor();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);
  // Decisions made on the Sheet's Review tab come in by themselves when the event is opened. A failure shows on the page.
  const synced = useRef<string | null>(null);
  const live = ev.data && !demo && !compact && ev.data.event.stage === "delivered" && ev.data.event.sheet_url ? ev.data.event.id : null;
  useEffect(() => {
    if (!live || synced.current === live) return;
    synced.current = live;
    send("POST", `/api/events/${live}/review/sync`, actor).then((r) => { if (r.ok) ev.load(); else setError(r.error ?? ""); });
  }, [live]);
  if (!ev.data) return null;
  const d = ev.data, e = d.event, stage: Stage = e.stage;
  const topUp = Boolean(e.parent_event_id);
  if (e.merged_at || e.ended_at) return null;
  const approver = Boolean(d.settings?.approvers.includes(actor) || needs?.approvers.includes(actor));
  const reload = async () => { await ev.load(); setReloads((k) => k + 1); refresh(); };
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => { setBusy(true); const r = await fn(); setBusy(false); if (r.ok) { setError(""); await reload(); } else setError(r.error ?? ""); };
  const card = pendingCard(d);
  const sheetUrl = e.sheet_url ?? null, sheetError = e.sheet_error ?? null;
  const blockingOpen = d.open_cases ?? 0;
  const asked = (needs?.requests ?? []).filter((r) => r.event_id === e.id && r.status === "pending");

  return (
    <>
      {stage === "requested" && (
        <section className="actions" aria-label="Seat requests">
          {asked.length > 0 && !compact && <span className="mute">{asked.map((r) => r.requester).join(", ")}</span>}
          {approver && <Link to="/seats" go={go} className="btn">Decide the seat requests</Link>}
        </section>
      )}

      {stage === "approved" && <Upload primary label="Add the attendee list" path={`/api/events/${e.id}/upload`} accept={`.csv,.xlsx,text/csv,${XLSX}`} onDone={reload} />}

      {stage === "mapped" && d.settings && <MappedStep d={d} onError={setError} onChange={reload} compact={compact} />}

      {stage === "quoted" && card && <RunStep d={d} card={card} onChange={reload} onError={setError} compact={compact} />}

      {isRunning(stage) && <Progress d={d} />}

      {stage === "paused" && (
        <section className="actions" aria-label="Resume">
          <button className="btn" type="button" disabled={busy} onClick={() => act(() => send("POST", `/api/events/${e.id}/resume`, actor))}>Resume</button>
          <span className="mute">{plural(d.list.people, "person", "people")} so far.</span>
        </section>
      )}

      {stage === "ready_for_review" && (
        <>
          {card ? <RunStep d={d} card={card} onChange={reload} onError={setError} compact={compact} /> : (
            <div className="actions">
              {compact && blockingOpen > 0
                ? <Link to={`/event/${e.id}`} go={go} className="btn">Settle the cases</Link>
                : <button className="btn" type="button" disabled={busy || blockingOpen > 0} title={blockingOpen > 0 ? `${plural(blockingOpen, "case")} to settle first` : undefined} onClick={() => act(() => send("POST", `/api/events/${e.id}/quote`, actor))}>Review the cost to verify and find contacts</button>}
            </div>
          )}
          <Cases eventId={e.id} cases={ev.cases} onChange={reload} compact={compact && !topUp} />
          {!topUp && !compact && d.spread && (
            <section aria-label="Companies by tier" className="tiers-sec">
              <div className="grp"><h2 className="display">{plural(d.spread.counts.total, "company", "companies")} researched</h2></div>
              <Tiers spread={d.spread} compact={compact} />
            </section>
          )}
          {!compact && <CompaniesTable id={e.id} reloadKey={reloads} />}
        </>
      )}

      {(stage === "finding_people" || stage === "flagging") && !compact && ev.cases.length > 0 && <Cases eventId={e.id} cases={ev.cases} onChange={reload} />}

      {stage === "delivered" && (
        <>
          <section className="delivered-lead" aria-label="Outreach list">
            <div className="reach">
              <p className="reach-n"><b>{num(d.list.people)}</b><span>{d.list.people === 1 ? "person to reach" : "people to reach"}</span></p>
              {d.list.priorities.map((p) => <p key={p.priority}><b>{num(p.n)}</b><span>Priority {p.priority}</span></p>)}
              {d.list.sources.map((x) => <p key={x.source}><b>{num(x.n)}</b><span>{x.source === "prospect" ? "Found at their companies" : "From the attendee list"}</span></p>)}
            </div>
            {sheetUrl ? (
              <div className="actions">
                <SheetButton href={sheetUrl} />
                {sheetError && !compact && (
                  <>
                    {sheetError === OLD_SHEET_ERROR
                      ? <Sure label="Rebuild the sheet" confirm="Rebuild" run={() => act(() => send("POST", `/api/events/${e.id}/sheet`, actor, { rebuild: true }))} />
                      : <button className="btn line" type="button" disabled={busy} onClick={() => act(() => send("POST", `/api/events/${e.id}/sheet`, actor))}>Try the sheet again</button>}
                    <a className="btn line" href={`/api/events/${e.id}/workbook`}>Download the file</a>
                    <span className="error small">{sheetError}</span>
                  </>
                )}
              </div>
            ) : sheetError ? (
              <div className="actions">
                <button className="btn" type="button" disabled={busy} onClick={() => act(() => send("POST", `/api/events/${e.id}/sheet`, actor))}>Try the sheet again</button>
                <a className="btn line" href={`/api/events/${e.id}/workbook`}>Download the file</a>
                <span className="error small">{sheetError}</span>
              </div>
            ) : (
              <div className="actions">
                <a className="btn line" href={`/api/events/${e.id}/workbook`}>Download the outreach file</a>
                {!demo && !compact && <button className="btn line" type="button" onClick={() => act(() => send("POST", `/api/events/${e.id}/sheet`, actor))}>Make the sheet</button>}
              </div>
            )}
          </section>
          {!compact && (
            <>
              <ListBrief d={d} />
              <Cases eventId={e.id} cases={ev.cases.filter((c) => c.kind !== "reply_doubtful")} onChange={reload} />
              <ListTables id={e.id} hasPriorities={d.list.priorities.length > 0} reloadKey={reloads} past={Boolean(e.last_day && new Date().toISOString().slice(0, 10) > e.last_day)} />
            </>
          )}
        </>
      )}

      {stage === "paused" && !compact && <PeopleTable id={e.id} hasPriorities={d.list.priorities.length > 0} reloadKey={reloads} />}

      {stage === "declined" && <p className="mute">{e.decline_reason ?? "Ended."}</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </>
  );
}

type View = "result" | "outreach" | "people" | "cost" | "details";
/* Result comes first once sending is done (Closing, Scored); before that the event has no result, and the tab is not there. */
const VIEWS: [View, string][] = [["result", "Result"], ["outreach", "Outreach"], ["people", "People"], ["cost", "Cost"], ["details", "Details"]];

/** A delivered event, one layer at a time: what needs someone now, on one line, then the work in motion, the list, and the event's details as views.
    The view is in the link (#outreach, #people, #details), so a Slack card can point straight at it. */
function DeliveredViews({ id, started, closed, views, onChange, counts = {} }: { id: string; started: boolean; closed: boolean; views: Partial<Record<View, React.ReactNode>>; onChange: () => void; counts?: Partial<Record<View, number>> }) {
  const shown = VIEWS.filter(([k]) => views[k] !== undefined);
  const { actor } = useActor();
  const fromHash = (): View | null => { const h = location.hash.slice(1); return shown.some(([k]) => k === h) ? (h as View) : null; };
  const [view, setView] = useState<View>(() => fromHash() ?? (closed ? "result" : started ? "outreach" : "people"));
  const [next, setNext] = useState<{ text: string; tab: View; action?: string } | null>(null);
  const [tabCounts, setTabCounts] = useState<Partial<Record<View, number>>>({});
  const [busy, setBusy] = useState(false);
  const loadNext = async () => { const r = await get<{ next: typeof next; counts?: Partial<Record<View, number>> }>(`/api/events/${id}/next`); setNext(r?.next ?? null); setTabCounts(r?.counts ?? {}); };
  // A link to another view of this same event (#outreach from Overview, a Slack card) switches the view without reloading the page.
  useEffect(() => { const on = () => { const v = fromHash(); if (v) setView(v); }; window.addEventListener("hashchange", on); window.addEventListener("popstate", on); return () => { window.removeEventListener("hashchange", on); window.removeEventListener("popstate", on); }; }, []);
  // Settling a case changes the counts: they reload whenever the page's own case counts move.
  useEffect(() => { loadNext(); }, [id, JSON.stringify(counts)]);
  // A view that appears once the page knows who is reading (Cost, for leadership) still opens from its link.
  useEffect(() => { const v = fromHash(); if (v && v !== view) setView(v); }, [shown.length]);
  const pick = (v: View) => { setView(v); history.replaceState(null, "", `${location.pathname}${location.search}#${v}`); };
  const go = async () => {
    if (!next) return;
    if (next.action === "post_event_start") { setBusy(true); await send("POST", `/api/events/${id}/motion/sequences`, actor); setBusy(false); await loadNext(); onChange(); }
    pick(next.tab);
  };
  return (
    <>
      {next?.action && (
        <div className="next-up" role="status">
          <p>{next.text}</p>
          {(next.action || view !== next.tab) && <button type="button" className="btn small" disabled={busy} onClick={go}>{next.action === "post_event_start" ? "Start the follow-up" : `Go to ${VIEWS.find(([k]) => k === next.tab)![1]}`}</button>}
        </div>
      )}
      <div className="seg views" role="tablist" aria-label="View">
        {shown.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={view === k} aria-pressed={view === k} onClick={() => pick(k)}>{label}{(tabCounts[k] ?? counts[k]) ? <span className="n" aria-label={`${tabCounts[k] ?? counts[k]} to decide`}>{tabCounts[k] ?? counts[k]}</span> : null}</button>)}
      </div>
      <div role="tabpanel" className="views-panel" aria-label={VIEWS.find(([k]) => k === view)![1]}>{views[view]}</div>
    </>
  );
}

/* ---------------------------------------------------------------- the page */

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

type Activity = EventPayload["activity"][number];
interface StoryLine { key: string; who: string | null; text: string; names?: string }

/** Which of the five steps a line of activity belongs to. */
const stepOf = (d: string) =>
  /seat|ticket/i.test(d) ? 0
    : /^(uploaded|mapped)|attendee list/i.test(d) ? 1
    : /outreach card|keeps failing|paused|people found|finding people/i.test(d) ? 3
    : /sheet|delivered|decisions/i.test(d) ? 4
    : 2;

/** System lines read as findings, without their internal labels. */
const clean = (d: string) => d.replace(/Outreach card/g, "Contacts card").replace(/\s*Nothing to warn about\.?$/, "").replace(/\.$/, "");

/** A step's activity as a person would tell it: ten approvals are one line, and the names sit on hover. */
function tell(rows: Activity[]): StoryLine[] {
  const lines: StoryLine[] = [];
  const once = new Set<string>();
  const group = (id: string, a: Activity, test: (r: Activity) => boolean, make: (same: Activity[]) => Omit<StoryLine, "key">) => {
    if (!once.has(id)) { once.add(id); lines.push({ key: a.id, ...make(rows.filter(test)) }); }
  };
  const approved = /^Approved .+'s seat$/, ticket = /^Recorded .+'s ticket at \$/, settled = /^settled: /i;
  for (const a of rows) {
    const human = a.actor !== "Events Desk" && a.actor !== "system";
    const who = human ? a.actor : null;
    const name = firstName(a.actor);
    if (a.detail === "Asked for a seat") group("ask", a, (r) => r.detail === "Asked for a seat", (same) => same.length > 1 ? { who: null, text: `${same.length} people asked for a seat`, names: same.map((r) => r.actor).join(", ") } : { who, text: `${name} asked for a seat` });
    else if (approved.test(a.detail)) group(`ok:${a.actor}`, a, (r) => r.actor === a.actor && approved.test(r.detail), (same) => ({ who, text: `${name} approved ${same.length === 1 ? same[0].detail.replace(/^Approved /, "") : `${same.length} seats`}`, names: same.map((r) => r.detail.replace(/^Approved |'s seat$/g, "")).join(", ") }));
    else if (ticket.test(a.detail)) group(`t:${a.actor}`, a, (r) => r.actor === a.actor && ticket.test(r.detail), (same) => {
      const sum = same.reduce((n, r) => n + Number(r.detail.split("$").pop()!.replace(/,/g, "")), 0);
      return { who, text: `${name} recorded ${plural(same.length, "ticket")}, $${sum.toLocaleString("en-US", sum % 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 0 })}`, names: same.map((r) => r.detail.replace(/^Recorded |'s ticket.*$/g, "")).join(", ") };
    });
    else if (settled.test(a.detail)) group(`s:${a.actor}`, a, (r) => r.actor === a.actor && settled.test(r.detail), (same) => ({ who, text: `${name} settled ${plural(same.length, "case")}` }));
    else {
      const t = clean(a.detail.startsWith(`${a.actor} `) ? a.detail.slice(a.actor.length + 1) : a.detail);
      lines.push({ key: a.id, who, text: human ? `${name} ${/^[A-Z][a-z]+ed\b/.test(t) ? t[0].toLowerCase() + t.slice(1) : t}` : t });
    }
  }
  return lines;
}

/* A history line that is really a set of counts ("Spread check: 87 tier 1, 133 tier 2, ...") is shown as a label and its figures.
   The labels the desk writes get the words a person would use. */
const LOG_LABEL: Record<string, string> = { "Spread check": "Tier mix", Identity: "Companies matched", "CRM check": "CRM check" };
function logFigures(text: string): { label: string; items: [string, string][] } | null {
  let t = text.trim();
  const mapped = t.match(/mapped (\d+) columns?, ignored (\d+)\.?\s*(?:Attendee list quality: (\w+))?/i);
  if (mapped) return { label: "Columns read", items: [[mapped[1], "used"], [mapped[2], "ignored"], ...(mapped[3] ? [["", `quality ${mapped[3]}`] as [string, string]] : [])] };
  const m = t.match(/^([A-Z][A-Za-z ]+): (.+)$/);
  if (!m) return null;
  const parts = m[2].replace(/\.\s*Nothing to warn about\.?$/i, "").replace(/\.$/, "").split(/,\s*/);
  const items = parts.map((x) => x.match(/^(\d[\d,]*)\s+(.+)$/)).filter(Boolean).map((x) => [x![1], x![2]] as [string, string]);
  if (!items.length || items.length !== parts.length) return null;
  return { label: LOG_LABEL[m[1]] ?? m[1], items };
}

/** The event told in the same five steps as the tracker at the top, oldest first. */
function Story({ activity, now }: { activity: Activity[]; now: number }) {
  const ordered = [...activity].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const steps = STEPS.map((label, i) => ({ label, i, rows: ordered.filter((a) => stepOf(a.detail) === i) })).filter((s) => s.rows.length);
  return (
    <ol className="story">
      {steps.map((s) => {
        const from = dayLabel(s.rows[0].created_at), to = dayLabel(s.rows[s.rows.length - 1].created_at);
        return (
          <li key={s.label} className={s.i === now ? "now" : ""}>
            <header><h4>{s.label}</h4><time>{from}{from !== to && ` to ${to}`}</time></header>
            <ul>
              {tell(s.rows).map((l) => (
                <li key={l.key} title={l.names}>
                  {l.who ? <PersonAvatar name={l.who} size={22} /> : <span className="story-sys" aria-hidden="true"><Mark size={16} /></span>}
                  {(() => { const f = logFigures(l.text); return f
                    ? <span className="story-figs"><span>{f.label}</span>{f.items.map(([n, w]) => <span key={w}>{n && <b>{n}</b>} {w}</span>)}</span>
                    : <span>{l.text}</span>; })()}
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

/** One line of a cost: what it is, a thin bar of used against the limit, and the figures. Credits stay credits, AI stays dollars. */
function Meter({ label, used, cap, unit, money: asMoney = false }: { label: string; used: number; cap: number; unit?: string; money?: boolean }) {
  const f = (n: number) => asMoney ? moneyFine(n) : num(n);
  return (
    <div className="meter">
      <span>{label}</span>
      <i aria-hidden="true"><u style={{ width: `${cap > 0 ? Math.min(100, (used / cap) * 100) : 0}%` }} /></i>
      <span className="meter-v"><b>{f(used)}</b> of {f(cap)}{unit ? ` ${unit}` : ""}</span>
    </div>
  );
}

/** After delivery the steps that built the list fold into one, and the same bar carries on. One timeline for the whole life of the event. */
/** Where the event is, readable from across the room: named steps, the one it is on lit, and who it is with. */
export function Stages({ e, approvers, cases }: { e: EventRow; approvers: string[]; cases: number }) {
  const ended = e.stage === "declined", paused = e.stage === "paused", running = isRunning(e.stage);
  const after = e.stage === "delivered";
  const step = after ? afterStep(e) : null;
  const at = ended ? -1 : step ? Math.max(0, AFTER.findIndex(([k]) => k === step.key)) : stepAt(e, cases);
  const labels = after ? AFTER.map(([, l]) => l) : [...STEPS, "Outreach"];
  const w = waitingOn(e, approvers);
  const caption = step ? step.caption ?? AFTER[at][2] : ended ? "" : e.stage === "ready_for_review" && cases > 0 ? plural(cases, "case") + " to settle" : paused ? "Paused" : running ? "Running now" : w.who ? `With ${w.who}` : "";
  return (
    <ol className={`stages${ended ? " ended" : ""}${paused ? " paused" : ""}${running ? " running" : ""}`} aria-label="Stage">
      {labels.map((label, i) => {
        const state = i < at || (after && e.motion === "scored") ? "done" : i === at ? "now" : "next";
        return (
          <li key={label} className={state} aria-current={state === "now" ? "step" : undefined} style={{ "--s": i } as React.CSSProperties}>
            <span className="st-bar" aria-hidden="true"><i /></span>
            <span className="st-label">{state === "done" && <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 7.4 2.7 2.7L11 4.4" /></svg>}{label}</span>
            {state === "now" && caption && <span className="st-who">{caption}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Who is going: the faces open everyone, with their role and team. Click outside or Esc closes it. */
function Going({ people, past = false }: { people: SeatRequest[]; past?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (ev: MouseEvent) => { if (!wrap.current?.contains(ev.target as Node)) setOpen(false); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", click); document.removeEventListener("keydown", key); };
  }, [open]);
  const names = people.map((p) => p.requester);
  const shown = 4, rest = names.length - shown;
  return (
    <div className="going-cell" ref={wrap}>
      <dt><Icon.people /><span className="sr-only">Who is going</span></dt>
      <dd>
        <span className="going-text"><b>{names.length} {past ? "went" : "going"}</b><span>{rest > 0 ? `${names.slice(0, shown).map(firstName).join(", ")} and ${rest} more` : names.map(firstName).join(", ")}</span></span>
        <button type="button" className={`going-btn${open ? " open" : ""}`} aria-expanded={open} aria-label={`See all ${names.length} people going`} onClick={() => setOpen(!open)}>
          {names.slice(0, shown).map((n) => <PersonAvatar key={n} name={n} size={36} />)}
          {rest > 0 && <span className="going-more">+{rest}</span>}
        </button>
      </dd>
      {open && (
        <div className="roster" role="dialog" aria-label="Everyone going">
          <p className="roster-h"><b>{names.length}</b> {past ? "went" : "going"}</p>
          <ul>
            {[...people].sort((a, b) => a.team.localeCompare(b.team) || a.requester.localeCompare(b.requester)).map((p) => (
              <li key={p.id}><PersonAvatar name={p.requester} size={38} /><span className="roster-who"><b>{p.requester}</b><span>{p.role}</span></span><span className="roster-team">{p.team}</span></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Event({ id, go }: { id: string; go: (to: string) => void }) {
  const ev = useEvent(id);
  const { actor, needs } = useActor();
  // New registrations are not an event. Anyone who lands on one is sent to the event they belong to.
  const parent = ev.data?.event.parent_event_id;
  useEffect(() => { if (parent) go(`/event/${parent}`); }, [parent]);
  if (ev.missing) return <div className="empty" data-ready="1">That event does not exist. <Link to="/events" go={go} className="to">Back to Events</Link></div>;
  if (!ev.data || parent) return null;
  const d = ev.data, e = d.event, stage: Stage = e.stage;
  const going = (needs?.requests ?? []).filter((r) => r.event_id === e.id && r.status === "approved");
  // The server decides; the screen only hides the control from people it would refuse, and while a run is going.
  // Company spend is leadership's and GTM Engineering's, as on Budget and Usage.
  const lead = isGtm(actor) || Boolean(needs?.approvers.includes(actor));
  const canDelete = lead && !isRunning(stage);
  const place = [e.venue, e.country && !(e.venue ?? "").includes(e.country) ? e.country : ""].filter(Boolean).join(", ");
  const placeParts = place.split(", ").filter(Boolean);
  const away = daysTo(e.starts_on);
  const dated = longDate(e.starts_on).split(", ");
  const weekday = dated[0], dayMonthYear = dated.slice(1).join(", ");
  const cards = d.cards ?? (d.card ? [d.card] : []);
  const used = (c: Card, step?: string) => (d.spend_by_step ?? []).filter((s) => s.card_id === c.id && (step ? s.step === step : s.unit === "llm")).reduce((n, s) => n + s.n, 0);
  const aiCents = d.settings?.llm_call_cents ?? 0;
  // AI spent is real dollars from the tokens each call reported; a call with none (a simulated run) counts at the flat rate. What a card allows stays an estimate at the flat rate.
  const usedCents = (c: Card) => (d.spend_by_step ?? []).filter((s) => s.card_id === c.id && s.unit === "llm").reduce((n, s) => n + (s.cents ?? s.n * aiCents), 0);
  const history = [...d.activity].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const facts = (
        <dl className="efacts">
          <div>
            <dt><Icon.calendar /><span className="sr-only">When</span></dt>
            <dd><b>{dayMonthYear}</b><span>{weekday}</span></dd>
          </div>
          {placeParts.length > 0 && (
            <div>
              <dt><Icon.pin /><span className="sr-only">Where</span></dt>
              <dd><b>{placeParts.slice(-2).join(", ")}</b>{placeParts.length > 2 && <span>{placeParts.slice(0, -2).join(", ")}</span>}</dd>
            </div>
          )}
          {going.length > 0 && <Going people={going} past={daysTo(e.starts_on) < 0} />}
        </dl>
  );
  const more = (
      <section className="more" aria-label="More">
        <div className="folds">
          <details className="fold">
            <summary>
              <Icon.history />
              <span className="fold-t">Event history</span>
              <span className="fold-peek">{history[0] ? <>{logFigures(history[0].detail)?.label ?? history[0].detail}<i>{dayLabel(history[0].created_at)}</i></> : "Nothing yet"}</span>
              <Chevron />
            </summary>
            <Story activity={d.activity} now={stage === "declined" ? -1 : stepAt(e, ev.open.length)} />
          </details>
        </div>
        {(canEnd(stage) || canDelete) && (
          <div className="foot">
            {canEnd(stage) && (isGtm(actor) || needs?.approvers.includes(actor)) && <EndEvent id={e.id} onDone={ev.load} />}
            {canDelete && <DeleteEvent e={e} hasSheet={Boolean(e.sheet_url)} go={go} />}
          </div>
        )}
      </section>
  );
  // In the order the work happens.
  const ORDER: Record<string, number> = { research: 0, outreach: 1, motion: 2 };
  // The data credits each card approved and what each step has used; they carry no dollar figure, so they sit under the money on the Cost tab.
  const creditCards = cards.length > 0 ? (
              <div className="costs">
                {[...cards].sort((a, b) => (ORDER[a.kind ?? ""] ?? 9) - (ORDER[b.kind ?? ""] ?? 9)).map((c) => {
                  const spentOn = byWork(Object.entries(c.step_caps ?? {}).map(([k]) => [k, used(c, k)]));
                  return (
                    <div className="costcard" key={c.id}>
                      <h4>{c.kind === "research" ? "Research companies" : c.kind === "outreach" ? "Verify and find contacts" : "Outreach"}</h4>
                      {byWork(Object.entries(c.step_caps ?? {}).map(([k, v]) => [k, v.credits ?? 0])).map(([work, cap]) => <Meter key={work} label={work} used={spentOn.find(([w]) => w === work)?.[1] ?? 0} cap={cap} unit="credits" />)}
                      {!c.step_caps && <Meter label="Vendor credits" used={d.spend.credits} cap={c.credits_cap} unit="credits" />}
                    </div>
                  );
                })}
              </div>
  ) : null;
  // A delivered event shows one layer at a time; before that there is one job to do, so the page stays whole.
  const delivered = stage === "delivered";
  const replyCases = ev.cases.filter((c) => c.kind === "reply_doubtful");
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb"><Link to="/events" go={go}>Events</Link><span>/</span><span>{e.name}</span></nav>
      <header className="event-head" data-ready="1" data-stage={stage}>
        <div className="ehero" style={{ "--brand": e.brand_color ?? "#1F5D3F" } as React.CSSProperties}>
          <EventLogo name={e.name} website={e.website} size={64} />
          <div className="ehero-text">
            <h1>{e.name}</h1>
            {ev.note && <p className="stage-note"><Icon.next />{ev.note}</p>}
          </div>
          {away >= 0
            ? <p className="ehero-count" aria-label={countdown(e.starts_on)}>{away === 0 ? <b>Today</b> : <><b>{away}</b><span>{away === 1 ? "day" : "days"} to go</span></>}</p>
            : null}
          <Stages e={e} approvers={needs?.approvers ?? []} cases={ev.open.length} />
        </div>
        {!delivered && facts}
      </header>
      {delivered ? (
        <DeliveredViews counts={{ outreach: openCases(replyCases).length, people: openCases(ev.cases).length - openCases(replyCases).length }} id={e.id} started={Boolean(e.motion && e.motion !== "none")} closed={["closing", "scored"].includes(e.motion ?? "")} onChange={ev.load} views={{
          ...(["closing", "scored"].includes(e.motion ?? "") ? { result: <ResultView id={e.id} name={e.name} onChange={ev.load} /> } : {}),
          outreach: <>{replyCases.length > 0 && <Cases eventId={e.id} cases={replyCases} onChange={ev.load} />}<Motion id={e.id} onChange={ev.load} /></>,
          people: <StageBlock ev={ev} go={go} />,
          ...(lead ? { cost: <CostView id={e.id} done={["closing", "scored"].includes(e.motion ?? "")}>{creditCards}</CostView> } : {}),
          details: <>{facts}<AttendeeList d={d} go={go} onChange={ev.load} />{more}</>,
        }} />
      ) : (
        <>
          <AttendeeList d={d} go={go} onChange={ev.load} />
          <StageBlock ev={ev} go={go} />
          {more}
        </>
      )}
    </>
  );
}

interface CostEntry { category: string; amount_cents: number; note: string; recorded_by: string; recorded_at: string }
interface EventCost { tickets_cents: number; tickets_bought: number; owed_seats: number; owed_cents: number; travel_cents: number; extras: CostEntry[]; ai_cents: number; total_cents: number; missing: string[] }
/** The costs a person enters, in the order a budget is usually read. */
const ENTERED: [string, string][] = [["sponsorship", "Sponsorship"], ["booth", "Booth"], ["dinners", "Dinners"], ["swag", "Swag"], ["tools", "Tools"], ["rep_time", "Rep time"], ["other", "Other"]];
const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Everything the event cost, as one ledger: what the desk knows on its own (tickets, travel, AI), then what a person enters, each line
    with its share of the total. Entered lines are filled in place, any time from the day the event exists. Leadership's and GTM's. */
function CostView({ id, done, children }: { id: string; done: boolean; children: React.ReactNode }) {
  const { actor } = useActor();
  const [c, setC] = useState<EventCost | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ amount: "", note: "" });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const load = () => get<EventCost>(`/api/events/${id}/cost`).then((x) => setC(x ?? null));
  useEffect(() => { load(); }, [id]);
  if (!c) return null;
  const total = Math.max(c.total_cents, 1);
  const entry = (k: string) => c.extras.find((x) => x.category === k);
  const open = (k: string) => { const e = entry(k); setDraft({ amount: e ? String(e.amount_cents / 100) : "", note: e?.note ?? "" }); setEditing(k); setError(""); };
  const save = async (k: string, cents: number, note: string) => {
    setBusy(true); setError("");
    const r = await send("POST", `/api/events/${id}/motion/costs`, actor, { category: k, amount_cents: cents, note });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setEditing(null); load();
  };
  const takeOff = async (k: string) => { setBusy(true); const r = await send("DELETE", `/api/events/${id}/costs/${k}`, actor); setBusy(false); if (!r.ok) { setError(r.error); return; } setEditing(null); load(); };
  // A line's share of the total: the bar and the figure that names it.
  const share = (n: number) => { const p = (n / total) * 100; return <span className="cl-share"><span className="cl-bar" aria-hidden="true"><u style={{ width: `${Math.max(p, n ? 1.5 : 0)}%` }} /></span><i>{n ? (p < 1 ? "<1%" : `${Math.round(p)}%`) : ""}</i></span>; };
  const fixed: [string, number, string][] = [
    ["Tickets", c.tickets_cents, c.tickets_bought === 1 ? "1 seat" : `${c.tickets_bought} seats`],
    ["Travel", c.travel_cents, "Seat requests"],
    ["AI", c.ai_cents, "Model calls"],
  ];
  return (
    <section className="cost-view" data-ready="1">
      <header className="md-hero rs-hero">
        <div className="md-hello"><h2><b>{money(c.total_cents)}</b><span>{done ? "spent" : "spent so far"}</span></h2></div>
        <div className="md-figs">
          {c.missing.length > 0 && <p><b>{c.missing.length}</b><span>{c.missing.length === 1 ? "line to enter" : "lines to enter"}</span></p>}
          {c.owed_seats > 0 && <p className="owed"><b>{money(c.owed_cents)}</b><span>{c.owed_seats === 1 ? "seat to buy" : "seats to buy"}</span></p>}
        </div>
      </header>

      <ul className="ob-tray cost-lines" aria-label="Cost by line">
        {fixed.map(([label, n, from], i) => (
          <li key={label} style={{ "--i": i } as React.CSSProperties}>
            <div className="ob-row cl-row ob-still">
              <span className="cl-what"><b>{label}</b><span>{from}</span></span>
              {share(n)}
              <span className="cl-end"><span className="cl-amt">{n && n < 100 ? moneyFine(n) : label === "AI" ? moneyFine(n) : money(n)}</span></span>
            </div>
          </li>
        ))}
        {ENTERED.map(([k, label], i) => {
          const e = entry(k);
          return (
            <li key={k} style={{ "--i": fixed.length + i } as React.CSSProperties}>
              {editing === k ? (
                <form className="ob-row cl-row cl-edit" onKeyDown={(ev) => { if (ev.key === "Escape") { ev.stopPropagation(); setEditing(null); } }} onSubmit={(ev) => { ev.preventDefault(); save(k, Math.round(Number(draft.amount.replace(/[$,\s]/g, "")) * 100), draft.note.trim()); }}>
                  <span className="cl-what"><b>{label}</b></span>
                  <label className="cl-in"><span className="sr-only">{label} amount in dollars</span><i aria-hidden="true">$</i><input autoFocus inputMode="decimal" value={draft.amount} onChange={(ev) => setDraft({ ...draft, amount: ev.target.value })} placeholder="0" /></label>
                  <label className="cl-note"><span className="sr-only">Vendor or invoice</span><input value={draft.note} onChange={(ev) => setDraft({ ...draft, note: ev.target.value })} placeholder="Vendor or invoice" /></label>
                  <span className="cl-act">
                    <button className="btn small" type="submit" disabled={busy || draft.amount.trim() === "" || Number.isNaN(Number(draft.amount.replace(/[$,\s]/g, "")))}>Save</button>
                    {e && <button className="btn line small" type="button" disabled={busy} onClick={() => takeOff(k)}>Remove</button>}
                    <button className="sheet-x cl-x" type="button" aria-label="Cancel" onClick={() => setEditing(null)}>&times;</button>
                  </span>
                </form>
              ) : (
                <div className={`ob-row cl-row${e ? "" : " cl-empty"}`} role="button" tabIndex={0} onClick={() => open(k)} onKeyDown={(ev) => { if (ev.key === "Enter") open(k); }} aria-label={`${label}: ${e ? (e.amount_cents ? money(e.amount_cents) : "none") : "not entered"}. Edit`}>
                  <span className="cl-what"><b>{label}</b><span>{e ? [e.note, `${/ Team$/.test(e.recorded_by) ? e.recorded_by : e.recorded_by.split(" ")[0]}, ${dayOf(e.recorded_at)}`].filter(Boolean).join(" · ") : k === "other" ? "Optional" : "Not entered"}</span></span>
                  {e && e.amount_cents ? share(e.amount_cents) : <span />}
                  {/* One right edge for every line: the amount, which "Edit" replaces on hover; or, with nothing entered, None and Add. */}
                  {e ? (
                    <span className="cl-end cl-swap">
                      <span className={`cl-amt${e.amount_cents ? "" : " none"}`}>{e.amount_cents ? money(e.amount_cents) : "None"}</span>
                      <span className="ob-go">Edit<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
                    </span>
                  ) : (
                    <span className="cl-end cl-add">
                      {k !== "other" && <button className="btn line small" type="button" disabled={busy} onClick={(ev) => { ev.stopPropagation(); save(k, 0, ""); }}>None</button>}
                      <span className="ob-go">Add<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
                    </span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p role="alert" className="error small">{error}</p>}
      {children && <div className="cost-credits"><h3 className="rs-h">Data credits</h3>{children}</div>}
    </section>
  );
}

/** What a company's tier rests on, in a few words: "by headcount" when the size decided it, "from its website" when its own site did.
    A longer reason is shown whole, on its own line. */
const headcountOnly = (fact: string) => /^employees:\s*[\d,]+\.?$/i.test(fact.trim());
const tierBasis = (fact: string | null) => !fact ? null : headcountOnly(fact) ? "by headcount" : /^from its own website/i.test(fact) ? "from its website" : null;

interface CompanyDetail {
  company_id: string; name: string; website: string | null; tier: number | null; industry: string | null; employees: string | null; country: string | null;
  owner: string | null; deal: string | null; tier_fact: string | null; list_status: string | null;
  others: { id: string; full_name: string | null; title: string | null; state: string }[];
}
const PERSON_STATE: Record<string, string> = { meeting: "Meeting", replied: "Replied", met: "Met", reached: "Reached", listed: "On the list" };

/** One company, opened from the list: its logo and site, its fit and size, why it got its tier, who owns it and any open deal,
    and everyone from it on this event with where they stand. A person opens their own panel. */
