/* Replies and meetings as things of their own. On a page they are rows on a tray, the same as the Overview's: a face, who, what they
   said, and when, with "Open" taking the place of the time on hover. A row opens a side sheet with the whole of it: the message in full,
   the clock, the thread, who they are, and every step so far. The sheet lives in the URL (?reply= or ?meeting=), so it survives a reload. */

import { useEffect, useState, type CSSProperties } from "react";
import { get, send } from "./api";
import { Link, useActor } from "./App";
import { EventLogo } from "./EventLogo";
import { PersonAvatar } from "./PersonAvatar";
import { useSheet } from "./SideSheet";
import { companyHref, eventHref, personHref, To } from "./To";

export const TOOL_NAME: Record<string, string> = { instantly: "Instantly", heyreach: "HeyReach", smartlead: "Smartlead", apollo: "Apollo" };
export const CODE_WORDS: Record<string, string> = { interested: "Interested", meeting_request: "Wants a meeting", referral: "Pointed us to someone", not_interested: "Not interested" };
const STATUS: Record<string, string> = { proposed: "Proposed", booked: "Booked", rescheduled: "Moved", held: "Held", no_show: "No-show", cancelled: "Cancelled" };

const dayKey = (d: Date) => d.toLocaleDateString("en-CA");
export const stamp = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** How soon a reply needs its answer, in the reader's own day. */
export function answerBy(iso: string): { text: string; soon: boolean } {
  const due = new Date(iso), now = new Date(), tomorrow = new Date(now.getTime() + 86_400_000);
  if (due < now) return { text: "Late", soon: true };
  if (dayKey(due) === dayKey(now)) return { text: "Answer today", soon: true };
  if (dayKey(due) === dayKey(tomorrow)) return { text: "Answer tomorrow", soon: false };
  return { text: `Answer by ${due.toLocaleDateString("en-GB", { weekday: "short" })}`, soon: false };
}

/** The current URL with one object open, or with none: the page underneath stays as it was. */
export function objectHref(kind: "reply" | "meeting" | null, id?: string) {
  const u = new URL(location.href);
  u.searchParams.delete("reply"); u.searchParams.delete("meeting");
  if (kind && id) u.searchParams.set(kind, id);
  return u.pathname + u.search + u.hash;
}
export const openObject = () => { const s = new URLSearchParams(location.search); return { reply: s.get("reply"), meeting: s.get("meeting") }; };

const Arrow = () => <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const Out = () => <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3h7v7M13 3 4 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>;

/* ------------------------------------------------------------------ rows */

export interface ReplyRowData { id: string; full_name: string | null; company: string | null; body: string | null; code: string | null; event?: string; website?: string | null; respond_by?: string | null }

/** One reply as a tile: face, who, their words on one line, and the clock. The whole tile opens the reply. */
export function ReplyRows({ rows, open, state }: { rows: ReplyRowData[]; open: string | null; state?: (r: ReplyRowData) => { text: string; soon: boolean } }) {
  const { go } = useActor();
  return (
    <ul className="ob-tray">{rows.map((r, i) => {
      const s = state ? state(r) : r.respond_by ? answerBy(r.respond_by) : { text: CODE_WORDS[r.code ?? ""] ?? "Replied", soon: false };
      return (
        <li key={r.id} style={{ "--i": i } as CSSProperties}>
          <Link to={objectHref("reply", r.id)} go={go} className={`ob-row${r.event ? " has-logo" : ""}${open === r.id ? " open" : ""}`} data-opens-sheet="" data-row={r.id} aria-label={`${r.full_name ?? "Someone"}, ${s.text}`}>
            <span className="ob-face"><PersonAvatar name={r.full_name ?? "Someone"} size={36} /></span>
            <span className="ob-who"><b>{r.full_name ?? "Someone"}</b><span>{r.company}</span></span>
            <span className="ob-said">{r.body ?? CODE_WORDS[r.code ?? ""] ?? "Replied"}</span>
            {r.event && <span className="ob-logo" title={r.event}><EventLogo name={r.event} website={r.website ?? null} size={24} /></span>}
            <span className="ob-end"><span className={`ob-when${s.soon ? " soon" : ""}`}>{s.text}</span><span className="ob-go">Open<Arrow /></span></span>
          </Link>
        </li>
      );
    })}</ul>
  );
}

export interface MeetingRowData { id: string; scheduled_at: string; full_name: string | null; company: string | null; status?: string; event?: string; website?: string | null; rep?: string | null; location?: string | null }

/** One meeting as a tile: the day large, the time, who, and where. The whole tile opens the meeting. */
export function MeetingRows({ rows, open, withRep }: { rows: MeetingRowData[]; open: string | null; withRep?: boolean }) {
  const { go } = useActor();
  return (
    <ul className="ob-tray">{rows.map((m, i) => {
      const at = new Date(m.scheduled_at);
      const done = m.status && !["booked", "rescheduled", "proposed"].includes(m.status);
      return (
        <li key={m.id} style={{ "--i": i } as CSSProperties}>
          <Link to={objectHref("meeting", m.id)} go={go} className={`ob-row ob-meet${m.event ? " has-logo" : ""}${open === m.id ? " open" : ""}`} data-opens-sheet="" data-row={m.id} aria-label={`${m.full_name ?? "Someone"}, ${stamp(m.scheduled_at)}`}>
            <span className="ob-day"><b>{at.getDate()}</b><span>{at.toLocaleDateString("en-GB", { month: "short" })}<br />{at.toLocaleDateString("en-GB", { weekday: "short" })}</span></span>
            <span className="ob-face"><PersonAvatar name={m.full_name ?? "Someone"} size={36} /></span>
            <span className="ob-who"><b>{m.full_name ?? "Someone"}</b><span>{[m.company, withRep && m.rep ? `with ${m.rep.split(" ")[0]}` : null, m.location].filter(Boolean).join(" · ")}</span></span>
            {m.event && <span className="ob-logo" title={m.event}><EventLogo name={m.event} website={m.website ?? null} size={24} /></span>}
            <span className="ob-end"><span className="ob-when">{done ? STATUS[m.status!] : clock(m.scheduled_at)}</span><span className="ob-go">Open<Arrow /></span></span>
          </Link>
        </li>
      );
    })}</ul>
  );
}

/* ------------------------------------------------------------------ sheets */

interface Step { kind: string; channel: string | null; at: string }
interface Who { full_name: string | null; title?: string | null; company: string | null; tier?: number | null; why?: string | null; industry?: string | null; employees?: string | null; owner?: string | null; deal?: string | null }
interface ReplyDetail extends Who {
  id: string; event_id: string; event: string; website: string | null; brand_color: string | null; contact_id: string | null;
  code: string | null; body: string | null; channel: string; connector: string; thread_url: string | null; received_at: string; respond_by: string | null; rep: string | null; handled_at: string | null;
  meeting: { id: string; status: string; scheduled_at: string; rep: string | null } | null; path: Step[];
}
interface Brief { title: string | null; company: string; tier: number | null; why: string | null; industry: string | null; employees: string | null; owner: string | null; deal: string | null; said: string | null; met_note: string | null }
interface MeetingDetail {
  id: string; event_id: string; event: string; website: string | null; brand_color: string | null; contact_id: string | null; full_name: string | null; company: string | null;
  status: string; scheduled_at: string; source: string; rep: string | null; location: string | null; brief: Brief | null;
  reply: { id: string; body: string | null; code: string | null; received_at: string } | null; path: Step[];
}

const via = (c: string | null) => (c === "linkedin" ? "on LinkedIn" : c === "email" ? "by email" : "");
function stepWords(s: Step) {
  if (s.kind === "sequence_add") return s.channel === "linkedin" ? "Added to the LinkedIn sequence" : s.channel === "email" ? "Added to the email sequence" : "Added to a sequence";
  if (s.kind === "send") return s.channel === "linkedin" ? "Messaged on LinkedIn" : "Emailed";
  if (s.kind.startsWith("reply_")) return `Replied: ${(CODE_WORDS[s.kind.slice(6)] ?? "replied").toLowerCase()}`;
  if (s.kind === "met_onsite" || s.kind === "badge_scan") return "Met at the event";
  if (s.kind.startsWith("meeting_")) return `Meeting ${(STATUS[s.kind.slice(8)] ?? s.kind.slice(8)).toLowerCase()}`;
  return s.kind.replace(/_/g, " ");
}

function Path({ steps }: { steps: Step[] }) {
  if (!steps.length) return null;
  return (
    <section className="ob-sec">
      <h3>So far</h3>
      <ol className="ob-path">{steps.map((s, i) => <li key={i} style={{ "--i": i } as CSSProperties}><time>{stamp(s.at)}</time><span>{stepWords(s)}</span></li>)}</ol>
    </section>
  );
}

function WhoFacts({ w, said, met }: { w: Who; said?: string | null; met?: string | null }) {
  const size = [w.industry, w.employees && `${w.employees} people`].filter(Boolean).join(", ");
  return (
    <section className="ob-sec">
      <h3>Who they are</h3>
      <dl className="sheet-facts">
        {w.title && <div><dt>Role</dt><dd>{w.title}</dd></div>}
        {w.company && <div><dt>Company</dt><dd>{w.company}{w.tier ? `, tier ${w.tier}` : ""}</dd></div>}
        {size && <div><dt>Size</dt><dd>{size}</dd></div>}
        {w.deal && <div><dt>Open deal</dt><dd>{w.deal}{w.owner ? `, owned by ${w.owner}` : ""}</dd></div>}
        {said && <div><dt>They wrote</dt><dd>{said}</dd></div>}
        {met && <div><dt>Met</dt><dd>{met}</dd></div>}
        {w.why && w.why.length > 30 && !/^employees:/i.test(w.why) && <div><dt>Why they fit</dt><dd>{w.why}</dd></div>}
      </dl>
    </section>
  );
}

function Shell({ label, close, event, children }: { label: string; close: () => void; event?: { id: string; name: string; website: string | null }; children?: React.ReactNode }) {
  const ref = useSheet(close);
  return (
    <aside className="sheet ob-sheet" ref={ref} role="dialog" aria-label={label}>
      <div className="sheet-top">
        {event && <To to={eventHref(event.id, "outreach")} className="ob-event"><EventLogo name={event.name} website={event.website} size={26} /><span>{event.name}</span></To>}
        <span className="spacer" />
        <button className="sheet-x" type="button" data-close aria-label="Close" onClick={close}>&times;</button>
      </div>
      {children}
    </aside>
  );
}

/** How much of the time to answer is gone, as a bar that fills when the sheet opens. */
function Clock({ from, by, done }: { from: string; by: string; done: string | null }) {
  const a = new Date(from).getTime(), b = new Date(by).getTime(), now = done ? new Date(done).getTime() : Date.now();
  const used = Math.min(1, Math.max(0.02, (now - a) / Math.max(1, b - a)));
  const s = answerBy(by);
  return (
    <div className={`ob-clock${s.soon && !done ? " soon" : ""}`}>
      <p><b>{done ? "Answered" : s.text}</b><span>{done ? stamp(done) : `by ${stamp(by)}`}</span></p>
      <span className="ob-bar"><i style={{ "--w": used } as CSSProperties} /></span>
    </div>
  );
}

export function ReplySheet({ id, close, changed }: { id: string; close: () => void; changed?: () => void }) {
  const { actor, go } = useActor();
  const [r, setR] = useState<ReplyDetail | null | "missing">(null), [busy, setBusy] = useState(false);
  const [slots, setSlots] = useState<{ id: string; rep: string; starts_at: string; meeting_id: string | null }[]>([]);
  const load = async () => setR((await get<ReplyDetail>(`/api/motion/replies/${id}`)) ?? "missing");
  useEffect(() => { setR(null); load(); }, [id]);
  useEffect(() => {
    if (!r || r === "missing" || r.meeting) return;
    get<{ slots: typeof slots }>(`/api/events/${r.event_id}/motion/roster`).then((x) => setSlots((x?.slots ?? []).filter((s) => !s.meeting_id && new Date(s.starts_at) > new Date()))).catch(() => setSlots([]));
  }, [r && r !== "missing" ? r.id : null]);
  if (r === "missing") return <Shell label="Reply" close={close}><p className="mute">That reply is no longer here.</p></Shell>;
  if (!r) return <Shell label="Reply" close={close} />;
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await load(); changed?.(); } finally { setBusy(false); } };
  const name = r.full_name ?? "Someone", first = name.split(" ")[0];
  const tool = TOOL_NAME[r.connector] ?? "the tool";

  return (
    <Shell label={`Reply from ${name}`} close={close} event={{ id: r.event_id, name: r.event, website: r.website }}>
      <header className="ob-head">
        <PersonAvatar name={name} size={56} />
        <div>
          <h2>{name}</h2>
          <p>{r.title ? `${r.title} at ` : ""}{r.company ? <To to={companyHref(r.event_id, r.company)}>{r.company}</To> : null}</p>
        </div>
      </header>

      <article className="ob-msg">
        <p className="ob-kicker"><b>{CODE_WORDS[r.code ?? ""] ?? "Replied"}</b><span>{stamp(r.received_at)} {via(r.channel)}</span></p>
        <p className="ob-body">{r.body ?? "No text came with this reply."}</p>
      </article>

      {r.respond_by && <Clock from={r.received_at} by={r.respond_by} done={r.handled_at} />}

      <div className="ob-acts">
        {r.thread_url && <a className="btn ob-reply" href={r.thread_url} target="_blank" rel="noopener noreferrer">Reply in {tool}<Out /></a>}
        {!r.handled_at && <button className="btn line" type="button" disabled={busy} onClick={() => act(() => send("POST", `/api/motion/replies/${r.id}/handled`, actor))}>Mark answered</button>}
      </div>

      {r.meeting ? (
        <Link to={objectHref("meeting", r.meeting.id)} go={go} className="ob-link" data-opens-sheet="">
          <span className="ob-link-k">Meeting</span><span>{stamp(r.meeting.scheduled_at)}{r.meeting.rep ? ` with ${r.meeting.rep.split(" ")[0]}` : ""}</span><span className="ob-link-s">{STATUS[r.meeting.status] ?? r.meeting.status}<Arrow /></span>
        </Link>
      ) : r.contact_id && slots.length > 0 && (
        <form className="ob-book" onSubmit={(e) => { e.preventDefault(); const sel = (e.currentTarget.elements.namedItem("slot") as HTMLSelectElement).value; act(() => send("POST", `/api/motion/slots/${sel}/book`, actor, { contact_id: r.contact_id })); }}>
          <label><span>Book {first} into a slot</span><select name="slot">{slots.slice(0, 40).map((x) => <option key={x.id} value={x.id}>{x.rep.split(" ")[0]}, {stamp(x.starts_at)}</option>)}</select></label>
          <button className="btn line" disabled={busy}>Book</button>
        </form>
      )}

      <WhoFacts w={r} />
      <Path steps={r.path} />
      {r.contact_id && <To to={personHref(r.event_id, r.contact_id, r.full_name)} className="btn line ob-record">Open {first}'s record</To>}
    </Shell>
  );
}

export function MeetingSheet({ id, close, changed }: { id: string; close: () => void; changed?: () => void }) {
  const { actor, go } = useActor();
  const [m, setM] = useState<MeetingDetail | null | "missing">(null), [busy, setBusy] = useState(false);
  const load = async () => setM((await get<MeetingDetail>(`/api/motion/meetings/${id}`)) ?? "missing");
  useEffect(() => { setM(null); load(); }, [id]);
  if (m === "missing") return <Shell label="Meeting" close={close}><p className="mute">That meeting is no longer here.</p></Shell>;
  if (!m) return <Shell label="Meeting" close={close} />;
  const name = m.full_name ?? "Someone", first = name.split(" ")[0], at = new Date(m.scheduled_at);
  const open = ["booked", "rescheduled", "proposed"].includes(m.status), started = at.getTime() <= Date.now() + 3_600_000;
  const days = Math.ceil((at.getTime() - Date.now()) / 86_400_000);
  const outcome = async (status: string) => { setBusy(true); try { await send("POST", `/api/motion/meetings/${m.id}/outcome`, actor, { status }); await load(); changed?.(); } finally { setBusy(false); } };

  return (
    <Shell label={`Meeting with ${name}`} close={close} event={{ id: m.event_id, name: m.event, website: m.website }}>
      <header className="ob-head ob-when-head">
        <span className="ob-day big"><b>{at.getDate()}</b><span>{at.toLocaleDateString("en-GB", { month: "short" })}<br />{at.toLocaleDateString("en-GB", { weekday: "short" })}</span></span>
        <div>
          <h2>{clock(m.scheduled_at)} with {name}</h2>
          <p>{m.company ? <To to={companyHref(m.event_id, m.company)}>{m.company}</To> : null}{[m.location, m.rep ? `with ${m.rep.split(" ")[0]}` : null].filter(Boolean).map((x) => ` · ${x}`).join("")}</p>
        </div>
      </header>

      <div className={`ob-state ${m.status}`}>
        <b>{STATUS[m.status] ?? m.status}</b>
        <span>{open ? (started ? "How did it go?" : days <= 1 ? "Tomorrow or sooner" : `In ${days} days`) : m.status === "held" ? "Counts toward the event's results" : "Does not count as held"}</span>
      </div>
      {open && started && (
        <div className="ob-acts">
          <button className="btn" type="button" disabled={busy} onClick={() => outcome("held")}>Held</button>
          <button className="btn line" type="button" disabled={busy} onClick={() => outcome("no_show")}>No-show</button>
          <button className="btn line" type="button" disabled={busy} onClick={() => outcome("cancelled")}>Cancelled</button>
        </div>
      )}

      {m.reply && (
        <Link to={objectHref("reply", m.reply.id)} go={go} className="ob-link ob-quote" data-opens-sheet="">
          <span className="ob-link-k">Their reply</span><span className="ob-said">{m.reply.body ?? CODE_WORDS[m.reply.code ?? ""] ?? "Replied"}</span><span className="ob-link-s">Open<Arrow /></span>
        </Link>
      )}

      {m.brief && <WhoFacts w={{ ...m.brief, full_name: m.full_name }} met={m.brief.met_note} />}
      <Path steps={m.path} />
      {m.contact_id && <To to={personHref(m.event_id, m.contact_id, m.full_name)} className="btn line ob-record">Open {first}'s record</To>}
    </Shell>
  );
}

/** Whichever object the URL names, over the page. */
export function ObjectSheets({ changed }: { changed?: () => void }) {
  const { go } = useActor();
  const { reply, meeting } = openObject();
  const close = () => go(objectHref(null));
  if (reply) return <ReplySheet id={reply} close={close} changed={changed} />;
  if (meeting) return <MeetingSheet id={meeting} close={close} changed={changed} />;
  return null;
}
