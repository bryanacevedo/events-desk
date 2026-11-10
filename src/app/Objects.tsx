/* Replies and meetings as things of their own. On a page they are rows on a tray, the same as the Overview's: a face, who, what they
   said, and when, with "Open" taking the place of the time on hover. A row opens a side sheet with the whole of it: the message in full,
   the clock, the thread, who they are, and every step so far. The sheet lives in the URL (?reply= or ?meeting=), so it survives a reload. */

import { companyDisplayName as co, dealDisplayName } from "../shared/names";
import { isGtm } from "../shared/roles";
import { useEffect, useState, type CSSProperties } from "react";
import { get, send } from "./api";
import { Link, useActor } from "./App";
import { EventLogo } from "./EventLogo";
import { PersonAvatar } from "./PersonAvatar";
import { useSheet } from "./SideSheet";
import { companyHref, eventHref, personHref, To } from "./To";
import { OptOut, PriorityGrid, whyPriority } from "./Person";

export const TOOL_NAME: Record<string, string> = { instantly: "Instantly", heyreach: "HeyReach", smartlead: "Smartlead", apollo: "Apollo" };
export const CODE_WORDS: Record<string, string> = { interested: "Interested", meeting_request: "Wants a meeting", referral: "Pointed us to someone", not_interested: "Not interested", not_now: "Not now", question: "Asked a question", out_of_office: "Out of office", unsubscribe: "Opted out", wrong_person: "Wrong person", departed: "Left the company", bounced: "Bounced", other: "Needs a person" };
const STATUS: Record<string, string> = { proposed: "Proposed", booked: "Booked", rescheduled: "Moved", held: "Held", no_show: "No-show", cancelled: "Cancelled" };

const dayKey = (d: Date) => d.toLocaleDateString("en-CA");
export const stamp = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
/** A meeting's time where it happens, with the zone named ("13:00 PST"), and how far off it is in words a person uses. */
/** A meeting's day and time where it happens, for a line of text: "Wed 18 Nov, 09:00 JST". */
export const meetStamp = (iso: string, tz?: string | null) => { const t = meetTime(iso, tz); return `${t.weekday} ${t.day} ${t.month}, ${t.time}`; };

export function meetTime(iso: string, tz?: string | null) {
  const at = new Date(iso);
  let zone: string | undefined;
  try { zone = tz ? Intl.DateTimeFormat(undefined, { timeZone: tz }).resolvedOptions().timeZone : undefined; } catch { zone = undefined; }
  // The clock in 24 hours, the zone the way people say it (PST, EST, JST), and the day where the meeting is.
  const clockAt = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: zone });
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
  const time = `${clockAt} ${name}`.trim();
  const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: zone });
  // The meeting's day where it happens, counted from the reader's today: the same count Overview gives the event.
  const n = Math.round((Date.parse(ymd(at)) - Date.parse(new Date().toLocaleDateString("en-CA"))) / 86_400_000);
  const soon = n === 0 ? "Today" : n === 1 ? "Tomorrow" : n === -1 ? "Yesterday" : n > 1 ? `In ${n} days` : `${-n} days ago`;
  const part = (o: Intl.DateTimeFormatOptions) => at.toLocaleDateString("en-GB", { ...o, timeZone: zone });
  return { time, clock: clockAt, zone: name, soon, today: n === 0, past: n < 0, day: part({ day: "numeric" }), month: part({ month: "short" }), weekday: part({ weekday: "short" }) };
}

/** A slot's day where the event is, as a key, and as a heading that names the zone once for the times under it. */
export const dayIn = (iso: string, tz?: string) => { try { return new Date(iso).toLocaleDateString("en-CA", { timeZone: tz }); } catch { return iso.slice(0, 10); } };
export const headIn = (iso: string, tz?: string) => { const t = meetTime(iso, tz); try { return `${new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz })} · ${t.zone}`; } catch { return t.zone; } };

/** How soon a reply needs its answer, in the reader's own day. */
export function answerBy(iso: string): { text: string; soon: boolean } {
  const due = new Date(iso), now = new Date(), tomorrow = new Date(now.getTime() + 86_400_000);
  if (due < now) return { text: "Late", soon: true };
  if (dayKey(due) === dayKey(now)) return { text: "Answer today", soon: true };
  if (dayKey(due) === dayKey(tomorrow)) return { text: "Answer tomorrow", soon: false };
  return { text: `Answer by ${due.toLocaleDateString("en-GB", { weekday: "short" })}`, soon: false };
}

/** The current URL with one object open, or with none: the page underneath stays as it was. */
/** Every kind of object that opens as a sheet. A person and a company carry their event: `person=<contact id>`, `company=<event id>|<company id>`, `sequence=<event id>|<sequence id>`. */
export const KINDS = ["reply", "meeting", "deal", "notes", "sequence", "person", "company"] as const;
export type Kind = (typeof KINDS)[number];
const clearKinds = (u: URL) => { for (const k of KINDS) u.searchParams.delete(k); u.searchParams.delete("trail"); };

export function objectHref(kind: Kind | null, id?: string, fromSheet = false) {
  const u = new URL(location.href);
  const here = KINDS.find((k) => u.searchParams.get(k));
  const trail = (u.searchParams.get("trail") ?? "").split(",").filter(Boolean);
  clearKinds(u);
  if (kind && id) {
    u.searchParams.set(kind, id);
    if (fromSheet && here) { const next = [...trail, `${here}:${u.searchParams.get(here) ?? new URLSearchParams(location.search).get(here)}`]; u.searchParams.set("trail", next.join(",")); }
  }
  return u.pathname + u.search + u.hash;
}

/** The sheet this one was opened from, if any: its kind and the link back to it with the rest of the trail. */
function backHref(): { kind: string; to: string; id: string } | null {
  const s = new URLSearchParams(location.search);
  const trail = (s.get("trail") ?? "").split(",").filter(Boolean);
  const last = trail.pop();
  if (!last) return null;
  const [kind, ...rest] = last.split(":");
  const u = new URL(location.href);
  clearKinds(u); u.searchParams.delete("event");
  u.searchParams.set(kind, rest.join(":"));
  if (trail.length) u.searchParams.set("trail", trail.join(","));
  return { kind, to: u.pathname + u.search + u.hash, id: rest.join(":") };
}
const KIND_WORD: Record<string, string> = { reply: "Reply", meeting: "Meeting", deal: "Deal", notes: "Notes", event: "Event", sequence: "Sequence", person: "Person", company: "Company" };

/** A reply, meeting or deal opened from an event's sheet: over the same page, with the event sheet as the way back. */
export function fromEventSheet(kind: Kind, id: string, eventId: string) {
  const u = new URL(location.href);
  clearKinds(u); u.searchParams.delete("event");
  u.searchParams.set(kind, id); u.searchParams.set("trail", `event:${eventId}`);
  return u.pathname + u.search + u.hash;
}
export const openObject = () => { const s = new URLSearchParams(location.search); return Object.fromEntries(KINDS.map((k) => [k, s.get(k)])) as Record<Kind, string | null>; };

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
            <span className="ob-who"><b>{r.full_name ?? "Someone"}</b><span>{r.company ? co(r.company) : ""}</span></span>
            <span className="ob-said">{r.body ?? CODE_WORDS[r.code ?? ""] ?? "Replied"}</span>
            {r.event && <span className="ob-logo" title={r.event}><EventLogo name={r.event} website={r.website ?? null} size={24} /></span>}
            <span className="ob-end"><span className={`ob-when${s.soon ? " soon" : ""}`}>{s.text}</span><span className="ob-go">Open<Arrow /></span></span>
          </Link>
        </li>
      );
    })}</ul>
  );
}

export interface MeetingRowData { id: string; scheduled_at: string; full_name: string | null; company: string | null; status?: string; event?: string; website?: string | null; rep?: string | null; location?: string | null; timezone?: string | null }

/** One meeting as a tile: the day large, the time, who, and where. The whole tile opens the meeting. */
export function MeetingRows({ rows, open, withRep }: { rows: MeetingRowData[]; open: string | null; withRep?: boolean }) {
  const { go } = useActor();
  return (
    <ul className="ob-tray">{rows.map((m, i) => {
      const at = new Date(m.scheduled_at);
      const done = m.status && !["booked", "rescheduled", "proposed"].includes(m.status);
      const t = meetTime(m.scheduled_at, m.timezone);
      return (
        <li key={m.id} style={{ "--i": i } as CSSProperties}>
          <Link to={objectHref("meeting", m.id)} go={go} className={`ob-row ob-meet${m.event ? " has-logo" : ""}${open === m.id ? " open" : ""}`} data-opens-sheet="" data-row={m.id} aria-label={`${m.full_name ?? "Someone"}, ${stamp(m.scheduled_at)}`}>
            <span className="ob-day"><b>{t.day}</b><span>{t.month}<br />{t.weekday}</span></span>
            <span className="ob-face"><PersonAvatar name={m.full_name ?? "Someone"} size={36} /></span>
            <span className="ob-who"><b>{m.full_name ?? "Someone"}</b><span>{[m.company ? co(m.company) : null, withRep && m.rep ? `with ${m.rep.split(" ")[0]}` : null, m.location].filter(Boolean).join(" · ")}</span></span>
            {m.event && <span className="ob-logo" title={m.event}><EventLogo name={m.event} website={m.website ?? null} size={24} /></span>}
            <span className="ob-end">{done ? <span className="ob-when">{STATUS[m.status!]}</span> : <span className="ob-when ob-time"><b>{t.time}</b><span className={t.today ? "soon" : undefined}>{t.soon}</span></span>}<span className="ob-go">Open<Arrow /></span></span>
          </Link>
        </li>
      );
    })}</ul>
  );
}

export interface NoteRowData { id: string; event: string; website: string | null; held: number; last_day: string | null }

/** Notes the desk asked for after an event: the event, how many meetings they cover, and how long ago it ended. Each opens the notes. */
export function NoteRows({ rows, open }: { rows: NoteRowData[]; open: string | null }) {
  const { go } = useActor();
  return (
    <ul className="ob-tray">{rows.map((n, i) => {
      const ago = n.last_day ? Math.max(0, Math.round((Date.now() - new Date(`${n.last_day}T12:00:00Z`).getTime()) / 86_400_000)) : null;
      return (
        <li key={n.id} style={{ "--i": i } as CSSProperties}>
          <Link to={objectHref("notes", n.id)} go={go} className={`ob-row ob-note${open === n.id ? " open" : ""}`} data-opens-sheet="" data-row={n.id} aria-label={`Notes on ${n.event}`}>
            <span className="ob-face"><EventLogo name={n.event} website={n.website} size={36} /></span>
            <span className="ob-who"><b>{n.event}</b><span>{n.held === 1 ? "1 meeting held" : `${n.held} meetings held`}</span></span>
            <span className="ob-end"><span className="ob-when">{ago === null ? "" : ago === 0 ? "Ended today" : ago === 1 ? "Ended yesterday" : `Ended ${ago} days ago`}</span><span className="ob-go">Write<Arrow /></span></span>
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
  sequence_id?: string | null; step?: number | null; seq_channel?: string | null; seq_phase?: string | null; seq_audience?: string | null;
  meeting: { id: string; status: string; scheduled_at: string; rep: string | null } | null; path: Step[];
  account: Account | null;
}
interface Account { company_id: string; name: string; tier: number | null; industry: string | null; employees: string | null; owner: string | null; deal: string | null; website: string | null;
  others: { id: string; full_name: string | null; title: string | null; state: string }[] }
interface Brief { title: string | null; company: string; tier: number | null; why: string | null; industry: string | null; employees: string | null; owner: string | null; deal: string | null; said: string | null; met_note: string | null }
interface MeetingDetail {
  id: string; event_id: string; event: string; website: string | null; brand_color: string | null; contact_id: string | null; full_name: string | null; company: string | null;
  status: string; scheduled_at: string; source: string; rep: string | null; location: string | null; brief: Brief | null;
  reply: { id: string; body: string | null; code: string | null; received_at: string } | null; path: Step[];
  deals?: DealDetail[];
  account?: Account | null;
}
interface DealDetail { account_info?: Account | null; domain?: string | null; opportunity_id: string; event_id?: string; event?: string; website?: string | null; account: string | null; name: string | null; stage: string | null; amount_cents: number; kind: "sourced" | "influenced"; won: boolean; url?: string | null; meeting_id: string | null; meeting_at?: string | null;
  owner?: string | null; next_step?: string | null; close_date?: string | null; created_date?: string; stage_history?: { stage: string; at: string }[];
  meeting?: { id: string; scheduled_at: string; full_name: string | null; rep: string | null; status: string } | null }

const crmName = (url: string) => (url.includes("salesforce.") ? "Salesforce" : url.includes("hubspot.") ? "HubSpot" : "the CRM");
const dealWord = (d: DealDetail) => (d.won ? "Won" : d.kind === "sourced" ? "New pipeline" : "Moved forward");
const dollars = (c: number) => `$${Math.round(c / 100).toLocaleString("en-US")}`;

const via = (c: string | null) => (c === "linkedin" ? "on LinkedIn" : c === "email" ? "by email" : "");
function stepWords(s: Step) {
  if (s.kind === "sequence_add") return s.channel === "linkedin" ? "Added to the LinkedIn sequence" : s.channel === "email" ? "Added to the email sequence" : "Added to a sequence";
  if (s.kind === "send") return (s as { action?: string | null }).action === "invite" ? "Invited on LinkedIn" : s.channel === "linkedin" ? "Messaged on LinkedIn" : "Emailed";
  if (s.kind === "accepted") return "Accepted on LinkedIn";
  if (s.kind === "reply_bounced" || s.kind === "bounce") return "Email bounced";
  if (s.kind === "reply_unsubscribe" || s.kind === "unsubscribe") return "Opted out";
  if (s.kind === "reply_out_of_office") return "Out of office reply";
  if (s.kind.startsWith("reply_")) return `Replied: ${(CODE_WORDS[s.kind.slice(6)] ?? "replied").toLowerCase()}`;
  if (s.kind === "met_onsite") return "Met at the booth";
  if (s.kind === "badge_scan") return "Badge scanned at the booth";
  if (s.kind.startsWith("meeting_")) return `Meeting ${(STATUS[s.kind.slice(8)] ?? s.kind.slice(8)).toLowerCase()}`;
  return s.kind.replace(/_/g, " ");
}

/** A person's history at the event, in the event's own time zone, the same clock its meetings read in. */
function Path({ steps, tz }: { steps: Step[]; tz?: string | null }) {
  if (!steps.length) return null;
  const when = (at: string) => { if (!tz) return stamp(at); const t = meetTime(at, tz); return `${t.weekday} ${t.day} ${t.month}, ${t.time}`; };
  return (
    <section className="ob-sec">
      <h3>So far</h3>
      <ol className="ob-path">{steps.map((s, i) => <li key={i} style={{ "--i": i } as CSSProperties}><time>{when(s.at)}</time><span>{stepWords(s)}</span></li>)}</ol>
    </section>
  );
}

function WhoFacts({ w, said, met }: { w: Who; said?: string | null; met?: string | null }) {
  const why = w.why && w.why.length > 30 && !/^(employees:|from its own website)/i.test(w.why) ? w.why : null;
  if (!said && !met && !why) return null;
  return (
    <section className="ob-sec">
      <h3>Who they are</h3>
      <dl className="sheet-facts">
        {said && <div><dt>They wrote</dt><dd>{said}</dd></div>}
        {met && <div><dt>Booth note</dt><dd>{met}</dd></div>}
        {why && <div><dt>Why they fit</dt><dd>{why}</dd></div>}
      </dl>
    </section>
  );
}

const STATE: Record<string, string> = { meeting: "Meeting", replied: "Replied", met: "Met", reached: "Reached", listed: "On the list" };

/** The account a person belongs to: its fit and size, who owns it, any open deal, and everyone else there the team has dealt with. */
function AccountBlock({ a, eventId, named = false }: { a: Account; eventId: string; named?: boolean }) {
  const { go } = useActor();
  if (named && !a.tier && !a.employees && !a.industry && !a.owner && !a.deal && !a.others.length) return null;
  return (
    <section className="ob-sec">
      <h3>The account</h3>
      {!named && (
        <div className="ob-account">
          <EventLogo name={co(a.name)} website={a.website ? `https://${a.website}` : null} size={40} />
          <div><Link to={objectHref("company", `${eventId}|${a.company_id}`, true)} go={go} className="to" data-opens-sheet=""><b>{co(a.name)}</b></Link><span>{a.website}</span></div>
        </div>
      )}
      {(a.tier || a.employees) && (
        <div className="md-figs rs-figs ob-figs ob-account-figs">
          {a.tier && <p><b>Tier {a.tier}</b><span>fit</span></p>}
          {a.employees && <p><b>{Number(a.employees).toLocaleString("en-US")}</b><span>employees</span></p>}
        </div>
      )}
      {a.industry && <dl className="sheet-facts"><div><dt>Industry</dt><dd>{a.industry}</dd></div></dl>}
      {!named && (a.owner || a.deal) && (
        <dl className="sheet-facts">
          {a.owner && <div><dt>Owner</dt><dd>{a.owner}</dd></div>}
          {a.deal && <div><dt>Open deal</dt><dd>{dealDisplayName(a.deal, a.name)}</dd></div>}
        </dl>
      )}
      {a.others.length > 0 && (
        <ul className="ob-tray ob-people">{a.others.map((p, i) => (
          <li key={p.id} style={{ "--i": i } as CSSProperties}>
            <Link to={objectHref("person", p.id, true)} go={go} className="ob-row ob-person" data-opens-sheet="">
              <span className="ob-face"><PersonAvatar name={p.full_name ?? "Someone"} size={30} /></span>
              <span className="ob-who"><b>{p.full_name ?? "Someone"}</b><span>{p.title ? co(p.title) : ""}</span></span>
              <span className="ob-end"><span className="ob-when">{STATE[p.state] ?? p.state}</span><span className="ob-go">Open<Arrow /></span></span>
            </Link>
          </li>
        ))}</ul>
      )}
    </section>
  );
}

function Shell({ label, close, event, children }: { label: string; close: () => void; event?: { id: string; name: string; website: string | null }; children?: React.ReactNode }) {
  const ref = useSheet(close);
  const { go } = useActor();
  const back = backHref();
  // Which kind of sheet this is, from the address: named in its own color above the heading, the one cue that tells a deal from a meeting from a person.
  const kind = KINDS.find((k) => new URLSearchParams(location.search).get(k));
  return (
    <aside className="sheet ob-sheet" ref={ref} role="dialog" aria-label={label} data-kind={kind}>
      <div className="sheet-top">
        {back && <button type="button" className="ob-back" onClick={() => go(back.to)} aria-label={`Back to the ${KIND_WORD[back.kind]?.toLowerCase() ?? "last sheet"}`}><Arrow /><span>{KIND_WORD[back.kind] ?? "Back"}</span></button>}
        {event && <To to={eventHref(event.id, "outreach")} className="ob-event"><EventLogo name={event.name} website={event.website} size={26} /><span>{event.name}</span></To>}
        <span className="spacer" />
        <button className="sheet-x" type="button" data-close aria-label="Close" onClick={close}>&times;</button>
      </div>
      {kind && <p className="ob-kind">{KIND_WORD[kind]}</p>}
      {children}
    </aside>
  );
}

/** How much of the time to answer is gone, as a bar that fills when the sheet opens. */
function Clock({ from, by, done, tz }: { from: string; by: string; done: string | null; tz?: string | null }) {
  const a = new Date(from).getTime(), b = new Date(by).getTime(), now = done ? new Date(done).getTime() : Date.now();
  const used = Math.min(1, Math.max(0.02, (now - a) / Math.max(1, b - a)));
  const s = answerBy(by);
  return (
    <div className={`ob-clock${s.soon && !done ? " soon" : ""}`}>
      <p><b>{done ? "Answered" : s.text}</b><span>{done ? zStamp(done, tz) : s.text === "Late" ? `Due ${zStamp(by, tz)}` : `by ${zStamp(by, tz)}`}</span></p>
      {/* While there is time left, how much of it is gone; once late or answered, only the time. */}
      {!done && s.text !== "Late" && <span className="ob-bar" role="img" aria-label={`${Math.round(used * 100)}% of the time to answer gone`}><i style={{ "--w": used } as CSSProperties} /></span>}
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
          <p>{r.title ? `${co(r.title)} at ` : ""}{r.company ? (r.account ? <Link to={objectHref("company", `${r.event_id}|${r.account.company_id}`, true)} go={go} className="to" data-opens-sheet="">{co(r.company)}</Link> : co(r.company)) : null}</p>
        </div>
      </header>

      <article className="ob-msg">
        <p className="ob-kicker"><b>{CODE_WORDS[r.code ?? ""] ?? "Replied"}</b><span>{zStamp(r.received_at, (r as { timezone?: string | null }).timezone)} {via(r.channel)}</span></p>
        <p className="ob-body">{r.body ?? "No text came with this reply."}</p>
      </article>

      {r.respond_by && <Clock from={r.received_at} by={r.respond_by} done={r.handled_at} tz={(r as { timezone?: string | null }).timezone} />}

      {/* Someone who opted out, bounced or is out of office is not someone to answer. */}
      {!["unsubscribe", "bounced", "out_of_office"].includes(r.code ?? "") && (
        <div className="ob-acts">
          {r.thread_url && <a className="btn ob-reply" href={r.thread_url} target="_blank" rel="noopener noreferrer">Reply in {tool}<Out /></a>}
          {!r.handled_at && <button className="btn line" type="button" disabled={busy} onClick={() => act(() => send("POST", `/api/motion/replies/${r.id}/handled`, actor))}>Mark answered</button>}
        </div>
      )}

      {r.sequence_id && !(backHref()?.kind === "sequence" && backHref()?.id === `${r.event_id}|${r.sequence_id}`) && (
        <Link to={objectHref("sequence", `${r.event_id}|${r.sequence_id}`, true)} go={go} className="ob-link" data-opens-sheet="">
          <span className="ob-link-k">{r.seq_phase === "post" ? "Follow-up" : "Before"}</span><span><SeqName s={{ channel: r.seq_channel ?? "email", priority: r.seq_audience }} />{r.step ? `, step ${r.step}` : ""}</span><span className="ob-link-s">Sequence<Arrow /></span>
        </Link>
      )}
      {r.meeting ? (
        <Link to={objectHref("meeting", r.meeting.id, true)} go={go} className="ob-link" data-opens-sheet="">
          <span className="ob-link-k">Meeting</span><span>{meetStamp(r.meeting.scheduled_at, (r.meeting as { timezone?: string | null }).timezone)}{r.meeting.rep ? ` with ${r.meeting.rep.split(" ")[0]}` : ""}</span><span className="ob-link-s">{STATUS[r.meeting.status] ?? r.meeting.status}<Arrow /></span>
        </Link>
      ) : r.contact_id && slots.length > 0 && (
        <form className="ob-book" onSubmit={(e) => { e.preventDefault(); const sel = (e.currentTarget.elements.namedItem("slot") as HTMLSelectElement).value; act(() => send("POST", `/api/motion/slots/${sel}/book`, actor, { contact_id: r.contact_id })); }}>
          <label><span>Book {first} into a slot</span><select name="slot">{slots.slice(0, 40).map((x) => <option key={x.id} value={x.id}>{x.rep.split(" ")[0]}, {stamp(x.starts_at)}</option>)}</select></label>
          <button className="btn line" disabled={busy}>Book</button>
        </form>
      )}

      <WhoFacts w={r} />
      {r.account && <AccountBlock a={r.account} eventId={r.event_id} named />}
      <Path steps={r.path} tz={(r as { timezone?: string | null }).timezone} />
      {r.contact_id && !(backHref()?.kind === "person" && backHref()?.id === r.contact_id) && <Link to={objectHref("person", r.contact_id, true)} go={go} className="btn ob-record to" data-opens-sheet="">Open {first}'s record <Arrow /></Link>}
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
  const t = meetTime(m.scheduled_at, (m as { timezone?: string | null }).timezone);
  const outcome = async (status: string) => { setBusy(true); try { await send("POST", `/api/motion/meetings/${m.id}/outcome`, actor, { status }); await load(); changed?.(); } finally { setBusy(false); } };

  return (
    <Shell label={`Meeting with ${name}`} close={close} event={{ id: m.event_id, name: m.event, website: m.website }}>
      <header className="ob-head ob-when-head">
        <span className="ob-day big"><b>{t.day}</b><span>{t.month}<br />{t.weekday}</span></span>
        <div>
          <h2>{t.time} with {name}</h2>
          <p>{m.company ? (m.account ? <Link to={objectHref("company", `${m.event_id}|${m.account.company_id}`, true)} go={go} className="to" data-opens-sheet="">{co(m.company)}</Link> : co(m.company)) : null}</p>
        </div>
      </header>

      <div className="md-figs rs-figs ob-figs">
        <p><b>{STATUS[m.status] ?? m.status}</b><span>{open ? (started ? "how did it go?" : t.soon.toLowerCase()) : "status"}</span></p>
        <p><b>{m.location ?? (m.source === "onsite" ? "Booth" : "At the show")}</b><span>where</span></p>
        {m.rep && m.rep !== actor && <p><b>{m.rep.split(" ")[0]}</b><span>with</span></p>}
      </div>
      {open && started && (
        <div className="ob-acts">
          <button className="btn" type="button" disabled={busy} onClick={() => outcome("held")}>Held</button>
          <button className="btn line" type="button" disabled={busy} onClick={() => outcome("no_show")}>No-show</button>
          <button className="btn line" type="button" disabled={busy} onClick={() => outcome("cancelled")}>Cancelled</button>
        </div>
      )}

      {m.reply && (
        <Link to={objectHref("reply", m.reply.id, true)} go={go} className="ob-link ob-quote" data-opens-sheet="">
          <span className="ob-qmark" aria-hidden="true">&ldquo;</span><span className="ob-said" aria-label="Their reply">{m.reply.body ?? CODE_WORDS[m.reply.code ?? ""] ?? "Replied"}</span><span className="ob-link-s">Open<Arrow /></span>
        </Link>
      )}

      {(m.deals ?? []).length > 0 && (
        <section className="ob-sec">
          <h3>Deals it led to</h3>
          {(m.deals ?? []).map((d) => (
            <Link key={d.opportunity_id} to={objectHref("deal", `${m.event_id}|${d.opportunity_id}`, true)} go={go} className="ob-link" data-opens-sheet="">
              <span className="ob-link-k">{dealWord(d)}</span><span>{d.account ? co(d.account) : d.name}</span><span className="ob-link-s">{dollars(d.amount_cents)}<Arrow /></span>
            </Link>
          ))}
        </section>
      )}
      {m.brief && <WhoFacts w={{ ...m.brief, full_name: m.full_name }} met={m.brief.met_note} />}
      {m.account && <AccountBlock a={m.account} eventId={m.event_id} named />}
      <Path steps={m.path} tz={(m as { timezone?: string | null }).timezone} />
      {m.contact_id && !(backHref()?.kind === "person" && backHref()?.id === m.contact_id) && <Link to={objectHref("person", m.contact_id, true)} go={go} className="btn ob-record to" data-opens-sheet="">Open {first}'s record <Arrow /></Link>}
    </Shell>
  );
}

/** Whichever object the URL names, over the page. */
export function ObjectSheets({ changed }: { changed?: () => void }) {
  const { go } = useActor();
  const { reply, meeting, deal, notes, person, company, sequence } = openObject();
  const close = () => go(objectHref(null));
  if (sequence) return <SequenceSheet id={sequence} close={close} changed={changed} />;
  if (person) return <PersonSheet id={person} close={close} changed={changed} />;
  if (company) return <CompanySheet id={company} close={close} />;
  if (notes) return <NotesSheet id={notes} close={close} changed={changed} />;
  if (reply) return <ReplySheet id={reply} close={close} changed={changed} />;
  if (meeting) return <MeetingSheet id={meeting} close={close} changed={changed} />;
  if (deal) return <DealSheet id={deal} close={close} />;
  return null;
}

/** A credited deal: the amount, where it stands, the CRM, and the meeting it is credited to. Leadership's and GTM's. */
export function DealSheet({ id, close }: { id: string; close: () => void }) {
  const { go, actor, needs } = useActor();
  const lead = isGtm(actor) || Boolean(needs?.approvers.includes(actor));
  useEffect(() => { if (!lead) close(); }, [lead]);
  const [eventId, oid] = id.split("|");
  const [d, setD] = useState<DealDetail | null | "missing">(null);
  useEffect(() => { if (!lead) return; setD(null); get<DealDetail>(`/api/events/${eventId}/deals/${encodeURIComponent(oid ?? "")}`).then((x) => setD(x ?? "missing")); }, [id]);
  if (!lead) return null;
  if (d === "missing") return <Shell label="Deal" close={close}><p className="mute">That deal is no longer credited here.</p></Shell>;
  if (!d) return <Shell label="Deal" close={close} />;
  return (
    <Shell label={`Deal at ${d.account ?? "an account"}`} close={close} event={{ id: eventId, name: d.event ?? "", website: d.website ?? null }}>
      <header className="ob-head">
        <EventLogo name={d.account ? co(d.account) : "Account"} website={d.domain ? `https://${d.domain}` : null} size={56} />
        <div><h2>{d.account ? co(d.account) : "An account"}</h2>{dealDisplayName(d.name, d.account) && <p>{dealDisplayName(d.name, d.account)}</p>}</div>
      </header>
      <div className="md-figs rs-figs ob-figs">
        <p><b>{dollars(d.amount_cents)}</b><span>amount</span></p>
        {d.stage && <p><b>{d.stage}</b><span>stage</span></p>}
        <p><b>{dealWord(d)}</b><span>credit</span></p>
      </div>
      {d.url && <div className="ob-acts"><a className="btn ob-reply" href={d.url} target="_blank" rel="noopener noreferrer">Open in {crmName(d.url)}<Out /></a></div>}
      {(d.owner || d.close_date || d.next_step) && (
        <dl className="sheet-facts ob-deal-facts">
          {d.owner && <div><dt>Owner</dt><dd>{d.owner}</dd></div>}
          {d.close_date && <div><dt>Expected close</dt><dd>{new Date(d.close_date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</dd></div>}
          {d.next_step && <div><dt>Next step</dt><dd>{d.next_step}</dd></div>}
        </dl>
      )}
      {(() => {
        // How it moved, with our meeting in its place: the reason it is credited to this event, read at a glance.
        const steps = [
          ...(d.created_date ? [{ at: d.created_date, words: "Opened" }] : []),
          ...(d.stage_history ?? []).filter((h, i, all) => i === 0 || h.stage !== all[i - 1].stage).map((h) => ({ at: h.at, words: `Moved to ${h.stage}` })),
          ...(d.meeting ? [{ at: d.meeting.scheduled_at, words: `Meeting with ${d.meeting.full_name ?? "them"}`, ours: true }] : []),
        ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.words === "Opened" ? -1 : 0));
        return steps.length > 1 && (
          <section className="ob-sec">
            <h3>How it moved</h3>
            <ol className="ob-path">{steps.map((x, i) => <li key={i} className={"ours" in x ? "ours" : undefined} style={{ "--i": i } as CSSProperties}><time>{new Date(x.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</time><span>{x.words}</span></li>)}</ol>
          </section>
        );
      })()}
      {d.meeting && (
        <Link to={objectHref("meeting", d.meeting.id, true)} go={go} className="ob-link" data-opens-sheet="">
          <span className="ob-link-k">Credited to</span><span>{meetStamp(d.meeting.scheduled_at, (d.meeting as { timezone?: string | null }).timezone)}{d.meeting.full_name ? ` with ${d.meeting.full_name}` : ""}</span><span className="ob-link-s">{STATUS[d.meeting.status] ?? d.meeting.status}<Arrow /></span>
        </Link>
      )}
      {d.account_info && <AccountBlock a={d.account_info} eventId={d.event_id ?? ""} named />}
    </Shell>
  );
}

interface NotesDetail {
  id: string; event_id: string; event: string; website: string | null; author: string; status: string; body: string | null; last_day: string | null;
  met: { id: string; full_name: string | null; company: string; scheduled_at: string }[];
  walkups: { id: string; full_name: string | null; company: string | null; note: string }[];
}

/** The notes the desk asked a rep for after an event: who they met there, one tap each, then the box to write what they heard. */
function NotesSheet({ id, close, changed }: { id: string; close: () => void; changed?: () => void }) {
  const { actor, go } = useActor();
  const [n, setN] = useState<NotesDetail | null | "missing">(null);
  const [draft, setDraft] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setN(null); get<NotesDetail>(`/api/motion/debriefs/${id}`).then((x) => setN(x ?? "missing")); }, [id]);
  if (n === "missing") return <Shell label="Notes" close={close}><p className="mute">Those notes are not here.</p></Shell>;
  if (!n) return <Shell label="Notes" close={close} />;
  const mine = n.author === actor && n.status === "waiting";
  const save = async () => {
    setBusy(true); setError("");
    const r = await send("POST", `/api/motion/debriefs/${n.id}/answer`, actor, { body: draft });
    setBusy(false);
    if (r && (r as { error?: string }).error) { setError((r as { error: string }).error); return; }
    changed?.(); close();
  };
  return (
    <Shell label={`Notes on ${n.event}`} close={close} event={{ id: n.event_id, name: n.event, website: n.website }}>
      <header className="ob-head">
        <EventLogo name={n.event} website={n.website} size={56} />
        <div><h2>What you heard</h2><p>{n.event}{n.last_day ? `, ended ${shortDateOf(n.last_day)}` : ""}</p></div>
      </header>
      <div className="md-figs ob-figs">
        <p><b>{n.met.length}</b><span>{n.met.length === 1 ? "meeting held" : "meetings held"}</span></p>
        <p><b>{n.walkups.length}</b><span>met at the booth</span></p>
      </div>
      {(n.met.length > 0 || n.walkups.length > 0) && (
        <section className="ob-sec">
          <h3>Who you met</h3>
          <ul className="ob-tray ob-people">
            {n.met.map((m, i) => (
              <li key={m.id} style={{ "--i": i } as CSSProperties}>
                <Link to={objectHref("meeting", m.id, true)} go={go} className="ob-row ob-person" data-opens-sheet="">
                  <span className="ob-face"><PersonAvatar name={m.full_name ?? "Someone"} size={32} /></span>
                  <span className="ob-who"><b>{m.full_name ?? "Someone"}</b><span>{m.company ? co(m.company) : ""}</span></span>
                  <span className="ob-end"><span className="ob-when">{stamp(m.scheduled_at).split(",")[0]}</span><span className="ob-go">Open<Arrow /></span></span>
                </Link>
              </li>
            ))}
            {n.walkups.map((w, i) => (
              <li key={w.id} style={{ "--i": n.met.length + i } as CSSProperties}>
                <div className="ob-row ob-person ob-still">
                  <span className="ob-face"><PersonAvatar name={w.full_name ?? "Someone"} size={32} /></span>
                  <span className="ob-who"><b>{w.full_name ?? "Someone"}</b><span>{w.company ? co(w.company) : ""}</span></span>
                  <span className="ob-said ob-own">{w.note}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {mine ? (
        <form className="ob-notes" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <label className="sr-only" htmlFor="notes-body">Your notes</label>
          <textarea id="notes-body" rows={7} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Their pain, competitors, timing, budget, what to do next time" />
          <div className="actions"><button className="btn" type="submit" disabled={busy || !draft.trim()}>Send the notes</button>{error && <span className="error small">{error}</span>}</div>
        </form>
      ) : n.body ? <p className="ob-body">{n.body}</p> : null}
    </Shell>
  );
}
const shortDateOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/* ---------------------------------------------------- person, company, sequence */

interface MeetingLite { id: string; contact_id: string | null; full_name: string | null; status: string; scheduled_at: string; timezone: string | null; rep: string | null; source: string | null }
interface ReplyLite { id: string; contact_id: string | null; full_name: string | null; code: string | null; body: string | null; received_at: string; sequence_id: string | null; sequence: string | null; channel: string | null; phase: string | null; audience?: string | null; step: number | null }
const PHASE = (p: string | null) => (p === "post" ? "After the event" : "Before the event");
const CHANNEL = (c: string | null) => (c === "linkedin" ? "LinkedIn" : "Email");
const REGION_WORD: Record<string, string> = { americas: "Americas", emea: "EMEA", apac: "APAC", event: "Event's region" };

/** Meetings as links to their sheets: when, where it is, with whom, and how it went. `who` names the person when the list spans several. */
function MeetingLinks({ rows, who = false }: { rows: MeetingLite[]; who?: boolean }) {
  const { go } = useActor();
  if (!rows.length) return null;
  return (
    <section className="ob-sec">
      <h3>Meetings<span>{rows.length}</span></h3>
      {rows.map((m) => (
        <Link key={m.id} to={objectHref("meeting", m.id, true)} go={go} className="ob-link" data-opens-sheet="">
          <span className="ob-link-k">{m.source === "onsite" ? "Booth" : "Booked"}</span>
          <span>{meetStamp(m.scheduled_at, m.timezone)}{who && m.full_name ? ` · ${m.full_name}` : ""}{m.rep ? ` · with ${m.rep.split(" ")[0]}` : ""}</span>
          <span className="ob-link-s">{STATUS[m.status] ?? m.status}<Arrow /></span>
        </Link>
      ))}
    </section>
  );
}

/** Replies as quotes that open their sheets, each saying which sequence and step drew it when the desk knows. */
function ReplyLinks({ rows, who = false, title = "Replies" }: { rows: ReplyLite[]; who?: boolean; title?: string }) {
  const { go } = useActor();
  if (!rows.length) return null;
  return (
    <section className="ob-sec">
      <h3>{title}<span>{rows.length}</span></h3>
      {rows.map((r) => (
        <Link key={r.id} to={objectHref("reply", r.id, true)} go={go} className="ob-link ob-quote" data-opens-sheet="">
          <span className="ob-qmark" aria-hidden="true">&ldquo;</span>
          <span className="ob-said">{r.body ?? CODE_WORDS[r.code ?? ""] ?? "Replied"}
            <i className="ob-from">{[who ? r.full_name : null, CODE_WORDS[r.code ?? ""] ?? null, r.sequence_id ? `${seqTitle({ channel: r.channel ?? "email", priority: r.audience })}${r.step ? `, step ${r.step}` : ""}` : null].filter(Boolean).join(" · ")}</i>
          </span>
          <span className="ob-link-s">Open<Arrow /></span>
        </Link>
      ))}
    </section>
  );
}

interface PersonDetail {
  id: string; event_id: string; event: string; website: string | null; full_name: string | null; title: string | null; email: string | null; linkedin: string | null;
  priority: "A" | "B" | "C" | null; title_tier: 1 | 2 | 3 | null; source: "attendee" | "prospect"; drop_reason: string | null; employer: string | null;
  company_id: string | null; company: string | null; company_tier: 1 | 2 | 3 | null; domain: string | null; last_verified_at: string | null; seen_at: number; flags: string[];
  meetings: MeetingLite[]; replies: ReplyLite[]; path: Step[]; account: Account | null;
  sequences: { id: string; name: string; channel: string; phase: string; priority?: string | null; zone_group: string | null; state: string; cause: string | null; sent: number; last_step: number | null; accepted: boolean }[];
  met: { id: string; rep: string; note: string; temperature: string; captured_at: string }[];
  deals?: { opportunity_id: string; name: string | null; amount_cents: number; stage: string | null; kind: string; won: boolean }[];
}
const ENROLL: Record<string, string> = { adding: "Being added", enrolled: "In it", paused: "Paused", removed: "Taken out" };

/** A person as their own record: why they are on the list, everything that happened with them at this event, and their account. */
export function PersonSheet({ id, close, changed }: { id: string; close: () => void; changed?: () => void }) {
  const { go } = useActor();
  const [p, setP] = useState<PersonDetail | null | "missing">(null);
  const load = () => get<PersonDetail>(`/api/people/${id}`).then((x) => setP(x ?? "missing"));
  useEffect(() => { setP(null); load(); }, [id]);
  if (p === "missing") return <Shell label="Person" close={close}><p className="mute">That person is not on the list.</p></Shell>;
  if (!p) return <Shell label="Person" close={close} />;
  const name = p.full_name ?? "Someone", booth = p.met[0];
  return (
    <Shell label={name} close={close} event={{ id: p.event_id, name: p.event, website: p.website }}>
      <header className="ob-head">
        <PersonAvatar name={name} size={56} />
        <div>
          <h2>{name}</h2>
          <p><span className={`psrc ${p.source === "prospect" ? "prospect" : "attendee"}`}>{p.source === "prospect" ? "Prospect" : "Attendee"}</span>{p.title ? `${co(p.title)} at ` : ""}{p.company_id ? <Link to={objectHref("company", `${p.event_id}|${p.company_id}`, true)} go={go} className="to" data-opens-sheet="">{co(p.company ?? "")}</Link> : p.company ? co(p.company) : null}</p>
        </div>
      </header>
      {p.priority && (
        <div className="ob-priority">
          <PriorityGrid company={p.company_tier} title={p.title_tier} />
          <div><b>Priority {p.priority}</b><span>{whyPriority(p)}</span></div>
        </div>
      )}
      {p.met.length > 0 && (
        <section className="ob-sec">
          <h3>Met at the booth</h3>
          {p.met.map((m) => <article key={m.id} className="ob-booth"><p>{m.note || "No note"}</p><span>{m.rep.split(" ")[0]} · {new Date(m.captured_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span></article>)}
        </section>
      )}
      <MeetingLinks rows={p.meetings} />
      {(p.deals ?? []).length > 0 && (
        <section className="ob-sec">
          <h3>Deals<span>{p.deals!.length}</span></h3>
          {p.deals!.map((d) => (
            <Link key={d.opportunity_id} to={objectHref("deal", `${p.event_id}|${d.opportunity_id}`, true)} go={go} className="ob-link" data-opens-sheet="">
              <span className="ob-link-k">{d.won ? "Won" : d.kind === "sourced" ? "New pipeline" : "Moved forward"}</span><span>{dealDisplayName(d.name, p.company) ?? co(p.company ?? "")}{d.stage ? ` · ${d.stage}` : ""}</span><span className="ob-link-s">{dollars(d.amount_cents)}<Arrow /></span>
            </Link>
          ))}
        </section>
      )}
      <ReplyLinks rows={p.replies} />
      {p.sequences.length > 0 && (
        <section className="ob-sec">
          <h3>Sequences<span>{p.sequences.length}</span></h3>
          {p.sequences.map((s) => (
            <Link key={s.id} to={objectHref("sequence", `${p.event_id}|${s.id}`, true)} go={go} className="ob-link" data-opens-sheet="">
              <span className="ob-link-k">{s.phase === "post" ? "Follow-up" : "Before"}</span>
              <span><SeqName s={s} /></span>
              <span className="ob-link-s">{s.accepted ? "Accepted" : s.channel === "linkedin" && s.sent ? "Invited" : s.last_step ? `Step ${s.last_step}` : s.sent ? `${s.sent} sent` : ENROLL[s.state] ?? s.state}<Arrow /></span>
            </Link>
          ))}
        </section>
      )}
      <Path steps={p.path} tz={(p as { timezone?: string | null }).timezone} />
      <section className="ob-sec">
        <h3>Contact</h3>
        <dl className="sheet-facts">
          <div><dt>Email</dt><dd className="wrap-any">{p.email ?? "None"}</dd></div>
          {p.last_verified_at && <div><dt>Verified</dt><dd>{new Date(p.last_verified_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</dd></div>}
          {p.linkedin && <div><dt>LinkedIn</dt><dd><a className="to wrap-any" href={p.linkedin} target="_blank" rel="noopener noreferrer">{p.linkedin.replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, "")}</a></dd></div>}
          {p.employer && p.employer !== p.company && <div><dt>Vendor lists</dt><dd>{co(p.employer)}</dd></div>}
          {p.seen_at > 1 && <div><dt>Events</dt><dd>{p.seen_at}</dd></div>}
        </dl>
      </section>
      {!p.drop_reason && <div className="ob-acts"><OptOut c={{ full_name: p.full_name, email: p.email, company: p.company }} onDone={() => { load(); changed?.(); }} /></div>}
      {p.account && <AccountBlock a={p.account} eventId={p.event_id} named />}
    </Shell>
  );
}

interface CompanyDetail extends Account { tier_fact: string | null; country: string | null; meetings: MeetingLite[]; replies: ReplyLite[]; event: { name: string; website: string | null } | null;
  deals: { opportunity_id: string; name: string | null; amount_cents: number; stage: string | null; kind: string; won: boolean }[] }

/** A company on an event: its fit, who owns it, who from it is on the list, and who met us or wrote back. */
export function CompanySheet({ id, close }: { id: string; close: () => void }) {
  const { go } = useActor();
  const [eventId, cid] = id.split("|");
  const [c, setC] = useState<CompanyDetail | null | "missing">(null);
  useEffect(() => { setC(null); get<CompanyDetail>(`/api/events/${eventId}/companies/${cid}`).then((x) => setC(x ?? "missing")); }, [id]);
  if (c === "missing") return <Shell label="Company" close={close}><p className="mute">That company is not on this event.</p></Shell>;
  if (!c) return <Shell label="Company" close={close} />;
  return (
    <Shell label={co(c.name)} close={close} event={c.event ? { id: eventId, name: c.event.name, website: c.event.website } : undefined}>
      <header className="ob-head">
        <EventLogo name={co(c.name)} website={c.website ? `https://${c.website}` : null} size={56} />
        <div><h2>{co(c.name)}</h2>{c.website && <p>{c.website}</p>}</div>
      </header>
      {(c.tier || c.employees) && (
        <div className="md-figs rs-figs ob-figs">
          {c.tier && <p><b>Tier {c.tier}</b><span>fit</span></p>}
          {c.employees && <p><b>{Number(c.employees).toLocaleString("en-US")}</b><span>employees</span></p>}
        </div>
      )}
      {c.tier_fact && !/^employees:/i.test(c.tier_fact) && <p className="ob-why">{c.tier_fact}</p>}
      {c.deals.length > 0 && (
        <section className="ob-sec">
          <h3>Deals<span>{c.deals.length}</span></h3>
          {c.deals.map((d) => (
            <Link key={d.opportunity_id} to={objectHref("deal", `${eventId}|${d.opportunity_id}`, true)} go={go} className="ob-link" data-opens-sheet="">
              <span className="ob-link-k">{d.won ? "Won" : d.kind === "sourced" ? "New pipeline" : "Moved forward"}</span><span>{dealDisplayName(d.name, c.name) ?? co(c.name)}{d.stage ? ` · ${d.stage}` : ""}</span><span className="ob-link-s">{dollars(d.amount_cents)}<Arrow /></span>
            </Link>
          ))}
        </section>
      )}
      {(c.owner || c.deal || c.country || c.industry) && (
        <dl className="sheet-facts">
          {c.industry && <div><dt>Industry</dt><dd>{c.industry}</dd></div>}
          {c.owner && <div><dt>Owner</dt><dd>{c.owner}</dd></div>}
          {c.deal && !c.deals.length && <div><dt>Open deal</dt><dd>{dealDisplayName(c.deal, c.name)}</dd></div>}
          {c.country && <div><dt>Country</dt><dd>{c.country}</dd></div>}
        </dl>
      )}
      <MeetingLinks rows={c.meetings} who />
      <ReplyLinks rows={c.replies} who />
      {c.others.length > 0 && (
        <section className="ob-sec">
          <h3>On the list<span>{c.others.length}</span></h3>
          <ul className="ob-tray ob-people">{c.others.map((p, i) => (
            <li key={p.id} style={{ "--i": i } as CSSProperties}>
              <Link to={objectHref("person", p.id, true)} go={go} className="ob-row ob-person" data-opens-sheet="">
                <span className="ob-face"><PersonAvatar name={p.full_name ?? "Someone"} size={30} /></span>
                <span className="ob-who"><b>{p.full_name ?? "Someone"}</b><span>{p.title ? co(p.title) : ""}</span></span>
                <span className="ob-end"><span className="ob-when">{STATE[p.state] ?? p.state}</span><span className="ob-go">Open<Arrow /></span></span>
              </Link>
            </li>
          ))}</ul>
        </section>
      )}
    </Shell>
  );
}

interface SequenceDetailData {
  id: string; name: string; channel: "email" | "linkedin"; phase: "pre" | "post"; priority: string; zone_group: string | null; connector: string; state: string; launched_at: string | null;
  people: number; reached: number | null; replied: number | null; meetings: number; invites: number | null; accepted: number | null; messages_sent: number | null;
  event: { name: string; website: string | null; starts_on: string | null; last_day: string | null };
  who: { state: string; cause: string | null; n: number }[];
  steps: { step: number; sent: number; invites: number; replied: number; bounced: number; unsubscribed: number }[] | null;
  replies: { id: string; code: string | null; body: string | null; received_at: string; full_name: string | null; company: string | null; contact_id: string | null; step: number | null }[];
  cadence: { step: number; day: number; subject: string | null; body: string }[]; linkedin_messages: number | null;
  people_in: { contact_id: string; full_name: string | null; company: string | null; state: string; cause: string | null; last_step: number | null; sent: number; accepted: boolean }[];
  checklist_by?: string | null;
  senders: { sender: string; name: string | null; sends: number; bounces: number | null }[] | null;
  days: { day: string; n: number }[] | null;
  unplaced: { sends: number; replies: number };
}
const SEQ_STATE: Record<string, string> = { active: "Live", paused: "Paused", archived: "Ended", draft: "Draft" };
const TOOL: Record<string, string> = { instantly: "Instantly", heyreach: "HeyReach", smartlead: "Smartlead", apollo: "Apollo", gong: "Gong" };
const CAUSE: Record<string, string> = { not_interested: "said not interested", waiting_for_rep: "replied", out_of_office: "out of office", unsubscribe: "opted out", inbound: "replied", meeting: "a meeting was booked", met_onsite: "met at the event", owner: "kept by the owner", mine: "kept by the owner", bounced: "the email bounced", departed: "left the company", wrong_person: "wrong person", dropped_in_review: "dropped in review", event_started: "the event opened", event_closed: "the follow-up ended", colleague_replied: "a colleague replied" };

/** One sequence: what it did, step by step, and with whom. Opened from its row on the Outreach tab or from a person. */
export function SequenceSheet({ id, close }: { id: string; close: () => void; changed?: () => void }) {
  const { go } = useActor();
  const [eventId, sid] = id.split("|");
  const [s, setS] = useState<SequenceDetailData | null | "missing">(null);
  useEffect(() => { setS(null); get<SequenceDetailData>(`/api/events/${eventId}/sequences/${sid}`).then((x) => setS(x ?? "missing")); }, [id]);
  if (s === "missing") return <Shell label="Sequence" close={close}><p className="mute">That sequence is not on this event.</p></Shell>;
  if (!s) return <Shell label="Sequence" close={close} />;
  const tool = TOOL[s.connector] ?? s.connector;
  const fig = (v: number | null, label: string) => <p className={v === null ? "nr" : undefined}><b>{v === null ? "None" : v.toLocaleString("en-US")}</b><span>{v === null ? `${label}, not reported` : label}</span></p>;
  const topStep = Math.max(1, ...(s.steps ?? []).map((x) => x.sent));
  // A sequence that ran its course is not anyone taken out: only a reason about the person counts here.
  const removed = s.who.filter((w) => w.state === "removed" && !["event_started", "event_closed"].includes(w.cause ?? ""));
  return (
    <Shell label={`${CHANNEL(s.channel)} sequence`} close={close} event={{ id: eventId, name: s.event.name, website: s.event.website }}>
      <header className="ob-head ob-head-plain">
        <div><h2><SeqName s={s} /></h2><p>{PHASE(s.phase)} · {SEQ_STATE[s.state] ?? s.state}</p></div>
      </header>
      <div className="md-figs rs-figs ob-figs">
        <p><b>{s.people.toLocaleString("en-US")}</b><span>added</span></p>
        {s.channel === "linkedin" && s.invites !== null ? fig(s.invites, "invited") : fig(s.reached, "reached")}
        {s.channel === "linkedin" && s.accepted !== null && fig(s.accepted, "accepted")}
        {fig(s.replied, "replied")}
        <p><b>{s.meetings}</b><span>{s.meetings === 1 ? "meeting" : "meetings"}</span></p>
      </div>
      {s.cadence.length > 0 && (
        <section className="ob-sec">
          <h3>Cadence<span>{s.channel === "linkedin" ? s.cadence.length + 1 : s.cadence.length}</span></h3>
          <ol className="sq-cad">
            {s.cadence.map((c, i) => {
              const res = s.steps?.find((x) => x.step === c.step);
              const invite = s.channel === "linkedin" && i === 0;
              const fig = invite
                ? [s.invites !== null ? `${s.invites} sent` : "Not reported", s.accepted !== null ? `${s.accepted} accepted` : null]
                : res ? [`${res.sent} sent`, res.replied ? `${res.replied} replied` : null, res.bounced ? `${res.bounced} bounced` : null, res.unsubscribed ? `${res.unsubscribed} opted out` : null] : [s.steps ? "None sent" : "Not reported"];
              return (
                <li key={c.step}>
                  <span className="sq-cad-day"><b>Day {c.day}</b><span>{invite ? "Connection request" : s.channel === "linkedin" ? "Message" : `Email ${c.step}`}</span></span>
                  <span className="sq-cad-copy">{c.subject && <b>{c.subject.replace(/\{\{(\w+)\}\}/g, (_, k: string) => `[${k.replace(/_/g, " ")}]`)}</b>}<span>{c.body.replace(/\{\{(\w+)\}\}/g, (_, k: string) => `[${k.replace(/_/g, " ")}]`)}</span></span>
                  <span className="sq-cad-n">{fig.filter(Boolean).map((t) => <span key={t}>{t}</span>)}</span>
                </li>
              );
            })}
            {s.channel === "linkedin" && (
              <li>
                <span className="sq-cad-day"><b>On accept</b><span>Message</span></span>
                <span className="sq-cad-copy" />
                <span className="sq-cad-n"><span>{s.linkedin_messages === null ? "Not reported" : `${s.linkedin_messages} sent`}</span></span>
              </li>
            )}
          </ol>
        </section>
      )}
      <ReplyLinks title="Messages back" rows={s.replies.map((r) => ({ ...r, sequence_id: null, sequence: null, channel: s.channel, phase: s.phase }))} who />
      {s.people_in.length > 0 && (
        <section className="ob-sec">
          <h3>People<span>{s.people_in.length}</span></h3>
          <ul className="ob-tray ob-people">{s.people_in.slice(0, 60).map((x, i) => (
            <li key={x.contact_id} style={{ "--i": i } as CSSProperties}>
              <Link to={objectHref("person", x.contact_id, true)} go={go} className="ob-row ob-person" data-opens-sheet="">
                <span className="ob-face"><PersonAvatar name={x.full_name ?? "Someone"} size={30} /></span>
                <span className="ob-who"><b>{x.full_name ?? "Someone"}</b><span>{x.company ? co(x.company) : ""}</span></span>
                <span className="ob-end"><span className="ob-when">{x.state === "removed" && !["event_started", "event_closed"].includes(x.cause ?? "") ? (CAUSE[x.cause ?? ""] ? CAUSE[x.cause ?? ""][0].toUpperCase() + CAUSE[x.cause ?? ""].slice(1) : "Taken out") : x.accepted ? "Accepted" : s.channel === "linkedin" && x.sent ? "Invited" : x.last_step ? `Step ${x.last_step}` : x.sent ? "Sent" : ENROLL[x.state] ?? x.state}</span><span className="ob-go">Open<Arrow /></span></span>
              </Link>
            </li>
          ))}</ul>
        </section>
      )}
      {s.senders && s.senders.length > 0 && (
        <section className="ob-sec">
          <h3>{s.channel === "linkedin" ? "Accounts" : "Inboxes"}<span>{s.senders.length}</span></h3>
          <ul className="ob-tray ob-people">{s.senders.map((x, i) => (
            <li key={x.sender} style={{ "--i": i } as CSSProperties}>
              <div className="ob-row ob-person ob-still">
                <span className="ob-face"><PersonAvatar name={x.name ?? x.sender} size={30} /></span>
                <span className="ob-who"><b>{x.name ?? (s.channel === "linkedin" ? "LinkedIn account" : "Inbox")}</b><span className="wrap-any">{x.sender.replace(/^https:\/\/www\.linkedin\.com\/in\//, "linkedin.com/in/")}</span></span>
                <span className="sq-fig"><b>{x.sends}</b><span>{x.bounces ? `sent, ${x.bounces} bounced` : "sent"}</span></span>
              </div>
            </li>
          ))}</ul>
        </section>
      )}
      {removed.length > 0 && (
        <section className="ob-sec" data-out="">
          <h3>Taken out<span>{removed.reduce((n, w) => n + w.n, 0)}</span></h3>
          <ul className="sq-out">{removed.map((w) => <li key={w.cause ?? "none"}><span>{CAUSE[w.cause ?? ""] ? CAUSE[w.cause ?? ""][0].toUpperCase() + CAUSE[w.cause ?? ""].slice(1) : (w.cause ?? "No reason given").replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase())}</span><b>{w.n}</b></li>)}</ul>
        </section>
      )}
      <section className="ob-sec">
        <h3>Setup</h3>
        <dl className="sheet-facts">
          <div><dt>Tool</dt><dd>{tool}</dd></div>
          {s.launched_at && <div><dt>Started</dt><dd>{new Date(s.launched_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}{s.checklist_by ? `, ${s.checklist_by}` : ""}</dd></div>}
          <div><dt>In {tool}</dt><dd className="wrap-any">{s.name}</dd></div>
        </dl>
      </section>
    </Shell>
  );
}

const OLD_GROUP: Record<string, string> = { scanned: "scanned at booth", reached: "reached before", not_reached: "not reached before" };
/** A sequence by what it is: its channel and its audience (docs/SEQUENCES-VIEW.md §8). An older one, made per priority or group and region, says those instead. */
export function seqTitle(s: { channel: string; priority?: string | null; zone_group?: string | null }) {
  const channel = s.channel === "linkedin" ? "LinkedIn" : "Email", p = s.priority ?? "";
  const who = p === "attendees" || p === "prospects" ? p : OLD_GROUP[p] ?? (p.length === 1 ? `priority ${p}` : p.replace(/_/g, " "));
  const region = s.zone_group && s.zone_group !== "event" ? `, ${REGION_WORD[s.zone_group] ?? s.zone_group}` : "";
  return `${channel}${who ? `, ${who}` : ""}${region}`;
}

/** The same name as `seqTitle`, with the audience word in its accent: attendees green, prospects blue, as on every person row. */
export function SeqName({ s }: { s: { channel: string; priority?: string | null; zone_group?: string | null } }) {
  const title = seqTitle(s), [channel, ...rest] = title.split(", ");
  const p = s.priority ?? "";
  return <>{channel}{rest.length > 0 && <>, <span className={`aud${p === "attendees" || p === "prospects" ? ` ${p}` : ""}`}>{rest[0]}</span>{rest.length > 1 ? `, ${rest.slice(1).join(", ")}` : ""}</>}</>;
}
/** A time on a reply or its history, in the event's own zone when the desk knows it. */
const zStamp = (at: string, tz?: string | null) => { if (!tz) return stamp(at); const t = meetTime(at, tz); return `${t.weekday} ${t.day} ${t.month}, ${t.time}`; };
