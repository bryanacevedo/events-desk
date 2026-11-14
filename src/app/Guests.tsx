/* The Guests tab of a hosted event (docs/HOSTED.md 16): the list grouped by what each guest has said, the figures that decide the next move, and the one action that follows.
   Invitations are copied and logged here, never sent. Reminders show who they reach before they go. Status is the group's own word, in ink. The server decides who may write;
   the screen hides what a person cannot use. */

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { get, read, send, type GuestOut, type HostedPage, type ImportResult, type Invitation, type ReminderPreview, type ReminderSent } from "./api";
import { PEOPLE, useActor } from "./App";
import { Form } from "./PlanEdit";
import { useSheet } from "./SideSheet";
import { Upload } from "./Upload";
import { money, num, plural } from "./words";

type Page = HostedPage;
const day = (ymd: string) => new Date(`${ymd.slice(0, 10)}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const wholeDollars = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : String(Math.round(cents / 100)));
const wholeOrNull = (v: string) => (v.trim() === "" ? null : Math.round(Number(v)));
const LEAD_WORDS: Record<string, string> = { own_invites: "Each side keeps the guests it invited", by_account: "The side that owns the account keeps all its guests", partner_keeps_theirs: "The partner keeps theirs; ours stay ours" };

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly", ""); t.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(t); t.select();
      const ok = document.execCommand("copy"); t.remove(); return ok;
    } catch { return false; }
  }
}

const GROUPS: { key: GuestOut["status"]; title: string; note?: string }[] = [
  { key: "listed", title: "Listed" }, { key: "invited", title: "Invited", note: "not yet answered" }, { key: "waitlist", title: "Waitlist" },
  { key: "registered", title: "Registered" }, { key: "attended", title: "Attended" }, { key: "no_show", title: "No-show" }, { key: "declined", title: "Declined" },
];

/** A sheet that slides in over the page, the way every other sheet does: Esc, a click outside and the × close it, and focus stays inside. */
function HSheet({ label, close, children }: { label: string; close: () => void; children: ReactNode }) {
  const ref = useSheet(close);
  return createPortal(
    <aside className="sheet hg-sheet" ref={ref} role="dialog" aria-label={label} data-hsheet={label}>
      <div className="sheet-top"><h2 className="display">{label}</h2><span className="spacer" /><button className="sheet-x" type="button" data-close aria-label="Close" onClick={close}>&times;</button></div>
      {children}
    </aside>, document.body);
}

const Facts = ({ rows }: { rows: [string, ReactNode][] }) => <dl className="sheet-facts">{rows.filter(([, v]) => v !== "" && v !== null && v !== undefined && v !== false).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;

/* ------------------------------------------------------------------ the invitation: copy it, send it from your own mailbox, log that it went */

function InviteSheet({ eventId, queue, close, saved }: { eventId: string; queue: GuestOut[]; close: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [at, setAt] = useState(0), [text, setText] = useState<Invitation | null>(null), [refused, setRefused] = useState(""), [copied, setCopied] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const g = queue[at];
  useEffect(() => {
    setText(null); setRefused(""); setCopied(false); setError("");
    read<Invitation>(`/api/events/${eventId}/guests/${g.id}/invitation`).then((r) => { if (r.ok) setText(r.data); else setRefused(r.error); });
  }, [at]);
  const next = async () => { await saved(); if (at + 1 < queue.length) setAt(at + 1); else close(); };
  const log = async () => {
    setBusy(true); setError("");
    const r = await send("POST", `/api/events/${eventId}/guests/${g.id}/invitation`, actor, {});
    setBusy(false);
    if (r.ok) await next(); else setError(r.error);
  };
  return (
    <HSheet label="Invitation" close={close}>
      <Facts rows={[["Guest", g.name], ["Company", g.company], ["Owner", g.owner], ["Subject", text?.subject], ...(queue.length > 1 ? [["Invitation", `${at + 1} of ${queue.length}`] as [string, string]] : [])]} />
      {text && <p className="draft">{text.body}</p>}
      {refused && <p className="draft" role="status">{refused}</p>}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        {text && <button type="button" className="btn" onClick={async () => { setCopied(await copyText(text.body)); }}>{copied ? "Copied" : "Copy text"}</button>}
        {text && <button type="button" className="btn line" disabled={busy} onClick={log}>Log as sent</button>}
        {refused && <button type="button" className="btn line" onClick={next}>{at + 1 < queue.length ? "Next" : "Close"}</button>}
      </div>
    </HSheet>
  );
}

/* ------------------------------------------------------------------ one guest: seat, notes, owner, and the moves a host makes */

function GuestSheet({ eventId, g, page, close, saved, invite }: { eventId: string; g: GuestOut; page: Page; close: () => void; saved: () => Promise<void>; invite: (g: GuestOut) => void }) {
  const { actor } = useActor();
  const [f, setF] = useState({ owner: g.owner, seat: g.seat, notes: g.notes, dietary: g.dietary, country: g.country ?? "" });
  const [removing, setRemoving] = useState(false), [why, setWhy] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  const writer = page.can_write, owners = [...new Set([g.owner, ...PEOPLE])];
  const may = g.can_write && !page.event.webinar;
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => { setBusy(true); setError(""); const r = await fn(); setBusy(false); if (r.ok) { await saved(); return true; } setError(r.error ?? ""); return false; };
  const canInvite = may && (g.status === "listed" || g.status === "invited") && g.can_email;
  return (
    <HSheet label={g.name} close={close}>
      <Facts rows={[["Company", g.company], ["Title", g.title], ["Status", <b key="s">{g.status_word}</b>], ["Invited", g.invited_words], ["Email", g.can_write ? g.email : null], ["Email by the desk", !g.can_email && g.status !== "attended" ? g.email_block : null]]} />
      {g.can_write ? (
        <Form onCancel={close} saveWord="Save" ready={f.owner !== g.owner || f.seat !== g.seat || f.notes !== g.notes || f.dietary !== g.dietary || f.country !== (g.country ?? "")}
          onSave={async () => { const body: Record<string, string> = { seat: f.seat, notes: f.notes, dietary: f.dietary }; if (writer) { body.owner = f.owner; body.country = f.country; } const r = await send("PATCH", `/api/events/${eventId}/guests/${g.id}`, actor, body); if (r.ok) { await saved(); close(); } return r; }}>
          {writer && <label className="field"><span>Owner</span><select className="input" value={f.owner} onChange={set("owner")}>{owners.map((o) => <option key={o}>{o}</option>)}</select></label>}
          <label className="field"><span>Seat or table</span><input className="input" value={f.seat} maxLength={60} onChange={set("seat")} autoComplete="off" /></label>
          <label className="field"><span>Notes for the owner</span><textarea className="input itext" rows={3} maxLength={600} value={f.notes} onChange={set("notes")} /></label>
          <label className="field"><span>Dietary needs</span><input className="input" value={f.dietary} maxLength={300} onChange={set("dietary")} autoComplete="off" /></label>
          {writer && <label className="field"><span>Country</span><input className="input" value={f.country} maxLength={40} onChange={set("country")} autoComplete="off" /></label>}
        </Form>
      ) : <Facts rows={[["Owner", g.owner], ["Seat or table", g.seat], ["Dietary needs", g.dietary]]} />}
      {error && <p role="alert" className="error">{error}</p>}
      <div className="actions">
        {canInvite && <button type="button" className="btn" onClick={() => invite(g)}>{g.status === "invited" ? "Invite again" : "Invite"}</button>}
        {writer && g.status === "waitlist" && <button type="button" className="btn line" disabled={busy} onClick={async () => { if (await act(() => send("POST", `/api/events/${eventId}/guests/${g.id}/move`, actor, { to: "registered" }))) close(); }}>Move to registered</button>}
        {writer && !removing && <button type="button" className="btn line danger" onClick={() => setRemoving(true)}>Remove from the list</button>}
      </div>
      {writer && removing && (
        <form className="pl-edit" onSubmit={async (ev) => { ev.preventDefault(); if (await act(() => send("DELETE", `/api/events/${eventId}/guests/${g.id}`, actor, { reason: why }))) close(); }}>
          <label className="field"><span>Why they come off</span><input className="input" value={why} maxLength={200} onChange={(ev) => setWhy(ev.target.value)} autoFocus /></label>
          <div className="actions"><button className="btn small" type="submit" disabled={busy || !why.trim()}>Remove</button><button className="btn line small" type="button" onClick={() => setRemoving(false)}>Keep them</button></div>
        </form>
      )}
    </HSheet>
  );
}

/* ------------------------------------------------------------------ nominate a guest */

interface Suggestions { accounts: { id: string; name: string; country: string | null; owner: string | null; open_deal: string | null }[]; conference: { company_id: string; name: string; owner: string | null; owner_words: string; can_add_by: string | null }[] }

function NominateSheet({ eventId, page, close, saved }: { eventId: string; page: Page; close: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const writer = page.can_write;
  const [f, setF] = useState({ name: "", company: "", title: "", email: "", country: "", owner: actor });
  const [account, setAccount] = useState<string | null>(null), [conf, setConf] = useState(""), [sugg, setSugg] = useState<Suggestions | null>(null);
  useEffect(() => { get<Suggestions>(`/api/events/${eventId}/guests/suggestions`).then(setSugg); }, []);
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  const pickAccount = (a: Suggestions["accounts"][number]) => { setAccount(a.id); setConf(""); setF({ ...f, company: a.name, country: a.country ?? f.country, owner: writer && a.owner ? a.owner : f.owner }); };
  const pickConf = (c: Suggestions["conference"][number]) => { setAccount(null); setConf(c.name); setF({ ...f, company: c.name }); };
  const owners = [...new Set([actor, ...PEOPLE])];
  const shown = [...(sugg?.accounts ?? []).slice(0, 6).map((a) => ({ key: a.id, name: a.name, words: a.open_deal ? "Open deal" : a.owner ?? "", pick: () => pickAccount(a) })),
    ...(sugg?.conference ?? []).slice(0, 4).map((c) => ({ key: c.company_id, name: c.name, words: c.owner_words, pick: () => pickConf(c) }))];
  return (
    <HSheet label="Nominate a guest" close={close}>
      <Form onCancel={close} saveWord="Add to the list" ready={f.name.trim() !== ""}
        onSave={async () => {
          const body: Record<string, unknown> = { name: f.name, company: f.company, title: f.title, email: f.email || null, country: f.country || null, source: account ? "account" : "nomination" };
          if (writer) body.owner = f.owner;
          if (account) body.account_id = account;
          if (conf) body.conference_company = conf;
          const r = await send("POST", `/api/events/${eventId}/guests`, actor, body);
          if (r.ok) { await saved(); close(); }
          return r;
        }}>
        <label className="field"><span>Name</span><input className="input" value={f.name} maxLength={120} onChange={set("name")} autoComplete="off" autoFocus /></label>
        <label className="field"><span>Company</span><input className="input" value={f.company} maxLength={120} onChange={(ev) => { setAccount(null); setConf(""); set("company")(ev); }} autoComplete="off" /></label>
        <label className="field"><span>Title</span><input className="input" value={f.title} maxLength={120} onChange={set("title")} autoComplete="off" /></label>
        <label className="field"><span>Email</span><input className="input" type="email" value={f.email} onChange={set("email")} autoComplete="off" /></label>
        <label className="field"><span>Country</span><input className="input" value={f.country} maxLength={40} onChange={set("country")} autoComplete="off" /></label>
        {writer && <label className="field"><span>Owner</span><select className="input" value={f.owner} onChange={set("owner")}>{owners.map((o) => <option key={o}>{o}</option>)}</select></label>}
      </Form>
      {shown.length > 0 && (
        <section aria-label="Accounts to invite from">
          <h3 className="hg-h">Accounts to invite from</h3>
          <ul className="hg-sugg">{shown.map((s) => <li key={s.key}><button type="button" className="hg-pick" onClick={s.pick}><b>{s.name}</b><span>{s.words}</span></button></li>)}</ul>
        </section>
      )}
    </HSheet>
  );
}

/* ------------------------------------------------------------------ import registrants (Luma or Splash), the same upload pattern: the source is asked first */

const IMPORT_SOURCES = [{ value: "luma", label: "Luma" }, { value: "splash", label: "Splash" }];

function ImportSheet({ eventId, title, close, saved }: { eventId: string; title: string; close: () => void; saved: () => Promise<void> }) {
  const [done, setDone] = useState<ImportResult | null>(null);
  return (
    <HSheet label={title} close={close}>
      <Upload primary label="Choose the file" question="Where the file came from" path={`/api/events/${eventId}/guests/import`} accept=".csv,text/csv" sources={IMPORT_SOURCES} sourceHeader="x-source" onDone={(out) => { setDone(out as ImportResult); void saved(); }} />
      {done && (
        <section aria-label="What the file did">
          <dl className="figs small hg-figs">
            <div><dd>{num(done.rows)}</dd><dt>rows</dt></div>
            <div><dd>{num(done.added)}</dd><dt>added</dt></div>
            {done.moved_forward > 0 && <div><dd>{num(done.moved_forward)}</dd><dt>moved on</dt></div>}
            <div><dd>{num(done.already_there)}</dd><dt>already there</dt></div>
            {done.skipped_empty + done.skipped.length > 0 && <div><dd>{num(done.skipped_empty + done.skipped.length)}</dd><dt>skipped</dt></div>}
          </dl>
          {done.skipped.length > 0 && <ul className="hg-skipped">{done.skipped.slice(0, 6).map((s) => <li key={s.row}><span>Row {s.row}</span><span>{s.why}</span></li>)}</ul>}
          <div className="actions"><button type="button" className="btn line" onClick={close}>Done</button></div>
        </section>
      )}
    </HSheet>
  );
}

/* ------------------------------------------------------------------ the reminder: who it reaches and who it skips, then send */

const SKIP_WORDS: Record<string, string> = { not_registered: "not registered", no_email: "no email", country: "country", opted_out: "opted out", wrong_person: "wrong person" };

function ReminderSheet({ eventId, close, saved }: { eventId: string; close: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [kind, setKind] = useState<"reminder" | "logistics">("reminder"), [note, setNote] = useState("");
  const [p, setP] = useState<ReminderPreview | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [sent, setSent] = useState<ReminderSent | null>(null);
  useEffect(() => {
    const t = setTimeout(() => { read<ReminderPreview>(`/api/events/${eventId}/reminders?kind=${kind}&note=${encodeURIComponent(note)}`).then((r) => { if (r.ok) { setP(r.data); setError(""); } else setError(r.error); }); }, 200);
    return () => clearTimeout(t);
  }, [kind, note]);
  const go = async () => {
    setBusy(true); setError("");
    const r = await send<ReminderSent>("POST", `/api/events/${eventId}/reminders`, actor, { kind, note });
    setBusy(false);
    if (r.ok) { setSent(r.data); await saved(); } else setError(r.error);
  };
  const skips = Object.entries(p?.skipped ?? {}).filter(([, n]) => n > 0);
  return (
    <HSheet label="Send reminder" close={close}>
      {sent ? (
        <section aria-label="Sent">
          <dl className="figs small hg-figs">
            <div><dd>{num(sent.sent)}</dd><dt>sent</dt></div>
            {sent.failed > 0 && <div><dd>{num(sent.failed)}</dd><dt>failed</dt></div>}
            {sent.unknown > 0 && <div><dd>{num(sent.unknown)}</dd><dt>not confirmed</dt></div>}
          </dl>
          <div className="actions"><button type="button" className="btn line" onClick={close}>Done</button></div>
        </section>
      ) : (
        <>
          <div className="seg" role="tablist" aria-label="Kind of message">
            <button type="button" aria-pressed={kind === "reminder"} onClick={() => setKind("reminder")}>Reminder</button>
            <button type="button" aria-pressed={kind === "logistics"} onClick={() => setKind("logistics")}>Logistics</button>
          </div>
          {kind === "logistics" && <label className="field"><span>Note for the guests</span><textarea className="input itext" rows={3} maxLength={600} value={note} onChange={(ev) => setNote(ev.target.value)} /></label>}
          {p && (
            <>
              <dl className="figs small hg-figs">
                <div><dd>{num(p.count)}</dd><dt>will get it</dt></div>
                {skips.map(([k, n]) => <div key={k}><dd>{num(n)}</dd><dt>skipped, {SKIP_WORDS[k] ?? k}</dt></div>)}
              </dl>
              <Facts rows={[["Subject", p.subject], ["Last sent", p.last_run ? `${day(p.last_run.created_at)}, ${plural(p.last_run.sent_count, "person", "people")}` : null]]} />
              {p.example && <p className="draft">{p.example}</p>}
              {p.refusal && <p role="status" className="mute">{p.refusal}</p>}
            </>
          )}
          {error && <p role="alert" className="error">{error}</p>}
          <div className="actions"><button type="button" className="btn" disabled={busy || !p?.can_send} onClick={go}>{busy ? "Sending…" : p && p.count > 0 ? `Send to ${p.count}` : "Send"}</button></div>
        </>
      )}
    </HSheet>
  );
}

/* ------------------------------------------------------------------ editors for the event, the venue and the co-host */

function DetailsSheet({ eventId, page, close, saved }: { eventId: string; page: Page; close: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const s = page.settings;
  const [f, setF] = useState({ capacity: s.capacity === null ? "" : String(s.capacity), noshow: s.noshow_pct === null ? "" : String(s.noshow_pct), host: s.host_name, doors: s.doors_at ?? "", address: s.address, welcome: s.welcome, open: s.rsvp_open });
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  return (
    <HSheet label="Event details" close={close}>
      <Form onCancel={close} onSave={async () => {
        const r = await send("PATCH", `/api/events/${eventId}/hosted`, actor, { capacity: wholeOrNull(f.capacity), noshow_pct: wholeOrNull(f.noshow), host_name: f.host, doors_at: f.doors || null, address: f.address, welcome: f.welcome, rsvp_open: f.open });
        if (r.ok) { await saved(); close(); }
        return r;
      }}>
        <div className="two">
          <label className="field"><span>Places</span><input className="input" inputMode="numeric" value={f.capacity} onChange={set("capacity")} placeholder="No limit" /></label>
          <label className="field"><span>No-shows, percent</span><input className="input" inputMode="numeric" value={f.noshow} onChange={set("noshow")} placeholder={String(page.estimate.rate_pct)} /></label>
        </div>
        <div className="two">
          <label className="field"><span>Host</span><input className="input" value={f.host} maxLength={80} onChange={set("host")} autoComplete="off" /></label>
          <label className="field"><span>Doors</span><input className="input" type="time" value={f.doors} onChange={set("doors")} /></label>
        </div>
        <label className="field"><span>Address</span><input className="input" value={f.address} maxLength={300} onChange={set("address")} autoComplete="off" /></label>
        <label className="field"><span>Line the guest sees</span><input className="input" value={f.welcome} maxLength={300} onChange={set("welcome")} autoComplete="off" /></label>
        <label className="check"><input type="checkbox" checked={f.open} onChange={(ev) => setF({ ...f, open: ev.target.checked })} /><span>The list takes new yes answers</span></label>
      </Form>
    </HSheet>
  );
}

type Step = { id?: string; by_date: string; rule: string; fee: string; done: boolean };

function VenueSheet({ eventId, page, close, saved }: { eventId: string; page: Page; close: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const v = page.venue;
  const [f, setF] = useState({ name: v?.name ?? "", address: v?.address ?? "", min: wholeDollars(v?.minimum_spend_cents), headcount: v?.guarantee_headcount === null || v?.guarantee_headcount === undefined ? "" : String(v.guarantee_headcount), by: v?.guarantee_by ?? "", sent: Boolean(v?.guarantee_confirmed_on), note: v?.note ?? "" });
  const [steps, setSteps] = useState<Step[]>((v?.steps ?? []).map((s) => ({ id: s.id, by_date: s.by_date, rule: s.rule, fee: wholeDollars(s.fee_cents), done: s.done })));
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  const step = (i: number, patch: Partial<Step>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return (
    <HSheet label="Venue" close={close}>
      <Form onCancel={close} onSave={async () => {
        const body = {
          name: f.name, address: f.address, budget_line_id: v?.budget_line_id ?? null, minimum_spend_cents: f.min.trim() === "" ? null : Math.round(Number(f.min) * 100), guarantee_headcount: wholeOrNull(f.headcount),
          guarantee_by: f.by || null, guarantee_confirmed: f.sent, note: f.note,
          steps: steps.filter((s) => s.rule.trim() || s.by_date).map((s) => ({ id: s.id, by_date: s.by_date, rule: s.rule, fee_cents: s.fee.trim() === "" ? null : Math.round(Number(s.fee) * 100), done: s.done })),
        };
        const r = await send("PUT", `/api/events/${eventId}/venue`, actor, body);
        if (r.ok) { await saved(); close(); }
        return r;
      }}>
        <label className="field"><span>Venue</span><input className="input" value={f.name} maxLength={160} onChange={set("name")} autoComplete="off" autoFocus /></label>
        <label className="field"><span>Address</span><input className="input" value={f.address} maxLength={300} onChange={set("address")} autoComplete="off" /></label>
        <div className="two">
          <label className="field"><span>Minimum spend, dollars</span><input className="input" inputMode="decimal" value={f.min} onChange={set("min")} /></label>
          <label className="field"><span>Headcount guarantee</span><input className="input" inputMode="numeric" value={f.headcount} onChange={set("headcount")} /></label>
        </div>
        <label className="field"><span>Guarantee due</span><input className="input" type="date" value={f.by} onChange={set("by")} /></label>
        <label className="check"><input type="checkbox" checked={f.sent} onChange={(ev) => setF({ ...f, sent: ev.target.checked })} /><span>Guarantee sent to the venue</span></label>
        <fieldset className="hg-steps"><legend>Cancellation steps</legend>
          {steps.map((s, i) => (
            <div className="hg-step" key={s.id ?? i}>
              <input className="input" type="date" aria-label="Date" value={s.by_date} onChange={(ev) => step(i, { by_date: ev.target.value })} />
              <input className="input" aria-label="What happens" placeholder="What happens" maxLength={200} value={s.rule} onChange={(ev) => step(i, { rule: ev.target.value })} />
              <input className="input" aria-label="Fee in dollars" placeholder="Fee" inputMode="decimal" value={s.fee} onChange={(ev) => step(i, { fee: ev.target.value })} />
              <label className="check"><input type="checkbox" checked={s.done} onChange={(ev) => step(i, { done: ev.target.checked })} /><span>Done</span></label>
              <button type="button" className="btn line small" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn line small" onClick={() => setSteps([...steps, { by_date: "", rule: "", fee: "", done: false }])}>Add a step</button>
        </fieldset>
        <label className="field"><span>Note</span><textarea className="input itext" rows={2} maxLength={600} value={f.note} onChange={set("note")} /></label>
      </Form>
    </HSheet>
  );
}

function CohostSheet({ eventId, page, close, saved }: { eventId: string; page: Page; close: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const c = page.cohost;
  const [f, setF] = useState({ partner: c?.partner ?? "", share: String(c?.our_share_percent ?? 50), rule: c?.lead_rule ?? "own_invites", note: c?.note ?? "" });
  const set = (k: keyof typeof f) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  return (
    <HSheet label="Co-host" close={close}>
      <Form onCancel={close} ready={f.partner.trim() !== ""} onSave={async () => {
        const r = await send("PUT", `/api/events/${eventId}/cohosts`, actor, { partner: f.partner, our_share_percent: Number(f.share), lead_rule: f.rule, note: f.note });
        if (r.ok) { await saved(); close(); }
        return r;
      }}>
        <label className="field"><span>Partner</span><input className="input" value={f.partner} maxLength={120} onChange={set("partner")} autoComplete="off" autoFocus /></label>
        <label className="field"><span>Our share, percent</span><input className="input" inputMode="numeric" value={f.share} onChange={set("share")} /></label>
        <label className="field"><span>Who follows up</span><select className="input" value={f.rule} onChange={set("rule")}>{Object.entries(LEAD_WORDS).map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select></label>
        <label className="field"><span>Note</span><textarea className="input itext" rows={2} maxLength={600} value={f.note} onChange={set("note")} /></label>
      </Form>
    </HSheet>
  );
}

/* ------------------------------------------------------------------ the tab */

type Open = null | { kind: "invite"; queue: GuestOut[] } | { kind: "guest"; id: string } | { kind: "nominate" } | { kind: "import"; title: string } | { kind: "remind" } | { kind: "details" } | { kind: "venue" } | { kind: "cohost" };
const BASIS_WORDS: Record<string, string> = { default: "default", set: "set for this event", history: "from your events" };

export function Guests({ id, page, reload, go }: { id: string; page: Page; reload: () => Promise<void>; go: (to: string) => void }) {
  const [open, setOpen] = useState<Open>(null);
  const p = page, c = p.counts, ev = p.event, writer = p.can_write, webinar = ev.webinar, money_ = p.can_see_money;
  const batch = writer ? p.guests.filter((g) => g.status === "listed" && g.can_email).slice(0, 5) : [];
  const day0 = ev.day_began && !ev.closed_at;
  // The one action: the next invitations, then the reminder, then the door on the day.
  const primary: { word: string; run: () => void; to?: string } | null =
    webinar ? (writer ? { word: "Import registrants", run: () => setOpen({ kind: "import", title: "Import registrants" }) } : null)
    : day0 && p.can_check_in ? { word: "Check in", run: () => go(`/event/${id}#check-in`), to: `/event/${id}#check-in` }
    : writer && batch.length > 0 ? { word: batch.length === 1 ? `Invite ${batch[0].name.split(" ")[0]}` : `Invite the next ${batch.length}`, run: () => setOpen({ kind: "invite", queue: batch }) }
    : writer && c.registered > 0 && p.reminders.can_send && !ev.closed_at ? { word: "Send reminder", run: () => setOpen({ kind: "remind" }) }
    : writer && p.empty ? { word: "Nominate a guest", run: () => setOpen({ kind: "nominate" }) }
    : null;
  const secondary: { word: string; run: () => void }[] = webinar
    ? (writer ? [{ word: "Import attendance", run: () => setOpen({ kind: "import", title: "Import attendance" }) }] : [])
    : [
      ...(writer ? [{ word: "Import registrants", run: () => setOpen({ kind: "import", title: "Import registrants" }) }] : []),
      ...(!ev.closed_at ? [{ word: "Nominate a guest", run: () => setOpen({ kind: "nominate" }) }] : []),
      ...(writer && c.registered > 0 && !ev.closed_at ? [{ word: "Send reminder", run: () => setOpen({ kind: "remind" }) }] : []),
      ...(p.can_check_in && !ev.closed_at ? [{ word: "Check-in", run: () => go(`/event/${id}#check-in`) }] : []),
    ];
  const second = secondary.filter((s) => s.word !== primary?.word);
  const est = p.estimate, cap = c.capacity;
  const guest = open?.kind === "guest" ? p.guests.find((g) => g.id === open.id) : undefined;
  const venue = p.venue, cohost = p.cohost, canVenue = writer && money_;
  const nextDate = venue?.next_date ?? null;
  const edit = (k: Open) => <button type="button" className="btn line small" onClick={() => setOpen(k)}>Edit</button>;

  return (
    <section className="guests" aria-label="Guests" data-ready="1">
      <div className="g-top">
        <div className="actions">
          {primary && <button type="button" className="btn" data-next onClick={primary.run}>{primary.word}</button>}
          {second.map((s) => <button key={s.word} type="button" className="btn line" onClick={s.run}>{s.word}</button>)}
        </div>
      </div>

      {p.empty && <p className="empty">{p.empty_words}</p>}

      {!webinar && (
        <section className="sum" aria-label="Guests in figures">
          <div className="sum-g">
            <div className="sum-h"><h3>{`No-shows at ${est.rate_pct}%`}<span>{BASIS_WORDS[est.basis]}</span></h3>{writer && edit({ kind: "details" })}</div>
            <dl className="figs">
              <div><dt>expected to come</dt><dd>{est.expected_attending}{cap !== null && <i>of {cap}</i>}</dd></div>
              {est.confirm_to_fill !== null && <div><dt>confirm up to</dt><dd>{est.confirm_to_fill}</dd></div>}
            </dl>
          </div>
          {venue && (
            <div className="sum-g">
              <div className="sum-h"><h3>Venue</h3>{canVenue && edit({ kind: "venue" })}</div>
              <dl className="figs">
                {money_ && venue.minimum_spend_cents !== null && venue.minimum_spend_cents !== undefined && <div><dt>minimum spend</dt><dd>{money(venue.minimum_spend_cents)}</dd></div>}
                {venue.guarantee_headcount !== null && <div><dt>headcount guarantee</dt><dd>{venue.guarantee_headcount}</dd></div>}
                {nextDate && <div><dt>{nextDate.days_away < 0 ? `days late, ${day(nextDate.date)}` : nextDate.days_away === 0 ? "today" : `days until ${day(nextDate.date)}`}</dt><dd>{Math.abs(nextDate.days_away)}</dd></div>}
              </dl>
            </div>
          )}
          {!venue && canVenue && <div className="sum-g"><div className="sum-h"><h3>Venue</h3><button type="button" className="btn line small" onClick={() => setOpen({ kind: "venue" })}>Add</button></div></div>}
          {cohost ? (
            <div className="sum-g">
              <div className="sum-h"><h3>Co-host, {cohost.partner}</h3>{canVenue && edit({ kind: "cohost" })}</div>
              <dl className="figs">
                <div><dt>our share</dt><dd>{cohost.our_share_percent}%</dd></div>
                {money_ && cohost.our_share_cents !== undefined && <div><dt>our cost</dt><dd>{money(cohost.our_share_cents)}</dd></div>}
              </dl>
              <p className="sum-note">{cohost.lead_rule_words}</p>
            </div>
          ) : canVenue && <div className="sum-g"><div className="sum-h"><h3>Co-host</h3><button type="button" className="btn line small" onClick={() => setOpen({ kind: "cohost" })}>Add</button></div></div>}
        </section>
      )}

      {webinar && (
        <section className="sum" aria-label="Guests in figures">
          <div className="sum-g"><h3>Registrants</h3><dl className="figs"><div><dt>registered</dt><dd>{c.registered}</dd></div><div><dt>attended</dt><dd>{c.attended}</dd></div></dl></div>
        </section>
      )}

      {p.guests.length > 0 && (
        <section className="gb" aria-label="Guests">
          <div className="gb-h"><span>Guest</span><span>Company</span><span>Title</span><span>Owner</span><span>Dietary</span><span className="dt">Invited</span></div>
          <div className="gb-list">
            {GROUPS.map((gr) => {
              const rows = p.guests.filter((g) => g.status === gr.key);
              if (!rows.length) return null;
              const n = gr.key === "registered" && cap !== null ? `${rows.length} of ${cap}` : String(rows.length);
              return (
                <section className={`gb-g s-${gr.key}`} key={gr.key} aria-label={gr.title}>
                  <div className="gb-gh"><h3>{gr.title} <span>{n}</span></h3>{gr.note && <p>{gr.note}</p>}</div>
                  <ul>
                    {rows.map((g) => (
                      <li className="gb-r" key={g.id} onClick={() => setOpen({ kind: "guest", id: g.id })} data-g={g.id}>
                        <button type="button" className="nm" data-opens-sheet data-row={g.id} onClick={(e) => { e.stopPropagation(); setOpen({ kind: "guest", id: g.id }); }}>{g.name}</button>
                        <span className="org"><span className="co">{g.company}</span><span className="ti">{g.title}</span></span>
                        <span className="meta"><span className="own">{g.owner}</span><span className="nt">{g.dietary}</span></span>
                        {(() => {
                          const date = g.last_invitation ? day(g.last_invitation.sent_on) : g.invited_at ? day(g.invited_at) : "";
                          if (g.status === "listed" && g.can_write && g.can_email && !webinar) return <span className="dt"><button type="button" className="rowgo" onClick={(e) => { e.stopPropagation(); setOpen({ kind: "invite", queue: [g] }); }}>Invite</button></span>;
                          if (g.status === "attended" || g.status === "no_show") return <span className="dt">{g.seat}</span>;
                          return date ? <span className="dt d">{date}</span> : <span className="dt">{g.status === "listed" && !g.can_email ? "Not emailed" : ""}</span>;
                        })()}
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </section>
      )}

      {open?.kind === "invite" && <InviteSheet eventId={id} queue={open.queue} close={() => setOpen(null)} saved={reload} />}
      {open?.kind === "guest" && guest && <GuestSheet key={guest.id} eventId={id} g={guest} page={p} close={() => setOpen(null)} saved={reload} invite={(g) => setOpen({ kind: "invite", queue: [g] })} />}
      {open?.kind === "nominate" && <NominateSheet eventId={id} page={p} close={() => setOpen(null)} saved={reload} />}
      {open?.kind === "import" && <ImportSheet eventId={id} title={open.title} close={() => setOpen(null)} saved={reload} />}
      {open?.kind === "remind" && <ReminderSheet eventId={id} close={() => setOpen(null)} saved={reload} />}
      {open?.kind === "details" && <DetailsSheet eventId={id} page={p} close={() => setOpen(null)} saved={reload} />}
      {open?.kind === "venue" && <VenueSheet eventId={id} page={p} close={() => setOpen(null)} saved={reload} />}
      {open?.kind === "cohost" && <CohostSheet eventId={id} page={p} close={() => setOpen(null)} saved={reload} />}
    </section>
  );
}
