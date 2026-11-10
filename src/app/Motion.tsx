/* Everything after the list is delivered, on the event page. Built from the page's own parts: the brief's bar rows, rows that open themselves, and the folds. Where the event stands is the header's timeline; this section never repeats it. It shows what a person needs to act on and leaves the rest a click away. */

import { useEffect, useState } from "react";
import { get, send } from "./api";
import { useActor } from "./App";
import { Chevron, ExpandRow } from "./Patterns";
import { Icon } from "./icons";
import { PersonAvatar } from "./PersonAvatar";
import { companyHref, personHref, To } from "./To";
import { CODE_WORDS, dayIn, headIn, MeetingRows, meetTime, objectHref, ObjectSheets, openObject, ReplyRows, SeqName } from "./Objects";
import { money, num, plural, shortDate } from "./words";
import { isGtm } from "../shared/roles";

interface Sender { address: string; role: "primary" | "spare"; daily_share: number; health: number | null }
interface Sequence { id: string; name: string; channel: "email" | "linkedin"; priority: string; phase?: "pre" | "post"; zone_group?: string; adding?: number; connector: string; state: string; pause_reason: string | null; senders_needed: number | null; peak_daily: number | null; sender_status: "ok" | "short" | "not_visible" | null; sender_excluded: { address: string; reason: string }[]; enrolled: number; paused: number; senders: Sender[]; timing_note: string | null; external_id: string | null; checklist_at: string | null }
interface Reply { id: string; signal?: string; connector?: string; thread_url?: string | null; code: string | null; doubtful: boolean; waiting?: boolean; body: string | null; contact_id: string | null; full_name: string | null; company: string | null }
interface Meeting { id: string; contact_id?: string; from_reply?: boolean; status: string; scheduled_at: string; rep: string | null; full_name: string | null; company: string | null }
interface Score { held_all: number; logged_outside: number; cost: { dollars_cents: number }; cost_per_held_cents: number | null; influence: { available: boolean; sourced: { n: number; cents: number }; influenced: { n: number; cents: number }; won: { n: number; cents: number } }; control: { available: boolean; met_accounts: number; met_with_pipeline: number; control_accounts: number; control_with_pipeline: number }; roi: { pipeline_per_dollar: number | null; cost_missing: string[] } }
interface Overview {
  motion: string; capacity: { needed: number; healthy: number } | null;
  card: { status: string; llm_cap: number | null; est_cents: number | null } | null;
  sequences: Sequence[]; funnel: { kept: number; enrolled: number; sent: number; replied: number; booked: number; held: number; held_all?: number } | null; owners: { status: string; n: number }[]; replies: Reply[]; meetings: Meeting[];
  captures: { id: string; contact_id?: string | null; full_name: string | null; company: string | null; rep: string; temperature?: string }[]; regions: { region: string; people: number; basis: string | null }[]; live_score: Score | null;
  post_event: { window: "before" | "during" | "after" | "closed"; last_day: string; last_press: string | null; started_at: string | null; started_by: string | null; groups: Record<string, number> } | null;
}
type Act = (m: "POST", p: string, b?: unknown, say?: string) => void;

const TOOL_NAME: Record<string, string> = { instantly: "Instantly", heyreach: "HeyReach", smartlead: "Smartlead", apollo: "Apollo" };
const CODE: Record<string, string> = { interested: "interested", meeting_request: "wants a meeting", referral: "pointed us to someone" };
const REASON: Record<string, string> = { not_connected: "Not connected", health_unknown: "Health not reported", low_health: "Health too low", still_warming: "Still warming up", high_bounce: "Bounces too high", high_spam: "Spam too high", fully_booked: "Used by other sequences", domain_full: "Domain has enough", no_auth: "Domain not set up to send", failed_placement: "Landing in spam", stale_placement: "Not tested lately", not_tested: "Not tested", warmup_off: "Warmup off", burned: "Domain resting", primary_domain: "Company's own domain", no_consent: "Rep has not agreed" };
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
/** Who goes into the follow-up: only the people the desk did not hear from (docs/SEQUENCES-VIEW.md §8). A badge scan is a rep's, like anyone met. */
const FOLLOW_UP = [["reached", "Reached before, no reply"], ["not_reached", "Not reached before"]] as const;
/** Meeting and slot times in the reader's own clock. */
const shortWhen = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const addDay = (ymd: string) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

/** Opens one of the page's folds by its title and brings it into view: a figure that names a fold leads to it. */
const openFold = (title: string) => {
  const d = [...document.querySelectorAll<HTMLDetailsElement>("section.motion details.fold")].find((x) => x.querySelector(".fold-t")?.textContent === title);
  if (d) { d.open = true; d.scrollIntoView({ behavior: "smooth", block: "start" }); }
};
/** The meetings behind each funnel row, by the same rules as the funnel (migrations/0041 event_funnel). */
const MEET_VIEWS = {
  reply: ["Booked from a reply", (m: Meeting) => Boolean(m.from_reply) && ["booked", "held", "no_show", "rescheduled"].includes(m.status)],
  booth: ["Met at the booth", (m: Meeting) => m.status === "held" && !m.from_reply],
  held: ["Meetings held", (m: Meeting) => m.status === "held"],
} as const;
const STATE: Record<string, string> = { active: "Live", paused: "Paused", archived: "Ended", draft: "Draft" };

/** The brief's row: what it is, a thin bar for how much, the number. */
function Row({ label, n, of, tone = "t1", shown, onOpen: given }: { label: string; n: number; of: number; tone?: string; shown?: string; onOpen?: () => void }) {
  // A row with nothing behind it leads nowhere: no arrow, no click.
  const onOpen = n > 0 ? given : undefined;
  return <li className={`brow${onOpen ? " opens" : ""}`} onClick={onOpen} role={onOpen ? "button" : undefined} tabIndex={onOpen ? 0 : undefined} onKeyDown={onOpen ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } } : undefined}><span>{label}</span><i aria-hidden="true"><u className={tone} style={{ width: `${of > 0 ? Math.min(100, (100 * n) / of) : 0}%` }} /></i><b>{shown ?? num(n)}</b></li>;
}

export function Fold({ icon, title, peek, children }: { icon: React.ReactNode; title: string; peek?: React.ReactNode; children: React.ReactNode }) {
  return <details className="fold"><summary>{icon}<span className="fold-t">{title}</span><span className="fold-peek">{peek}</span><Chevron /></summary><div className="m-fold">{children}</div></details>;
}

const peopleIn = (s: Sequence) => s.enrolled + s.paused + (s.adding ?? 0);

/** One region's sequence, opened from its cell: its state, its sending accounts, and what it still needs before it goes out. */
function SequenceDetail({ s, act, busy }: { s: Sequence; act: Act; busy: boolean }) {
  const [campaign, setCampaign] = useState("");
  const words = s.channel === "email" ? "inboxes" : "accounts";
  const primary = s.senders.filter((x) => x.role === "primary"), spare = s.senders.filter((x) => x.role === "spare");
  const short = s.sender_status === "short" ? Math.max(1, (s.senders_needed ?? 0) - primary.length) : 0;
  const action = !s.external_id
    ? <form className="m-act" onSubmit={(e) => { e.preventDefault(); act("POST", `/api/motion/sequences/${s.id}/campaign`, { external_id: campaign }); }}><input aria-label="Its campaign in the tool" placeholder="Campaign id" value={campaign} onChange={(e) => setCampaign(e.target.value)} required /><button className="btn small line" disabled={busy}>Connect</button></form>
    : s.state === "draft" && !s.checklist_at ? <button className="btn small line" disabled={busy} onClick={() => act("POST", `/api/motion/sequences/${s.id}/checklist`)}>Ready to launch</button> : null;
  return (
    <div className="sq-detail">
      <header>
        <b><SeqName s={s} /></b>
        <span className="mute">{STATE[s.state] ?? s.state} · {plural(peopleIn(s), "person", "people")}{s.peak_daily !== null ? ` · ${num(s.peak_daily)} on the busiest day` : ""}</span>
        {short > 0 && <span className="fig over"><b>{short}</b> {words} short</span>}
        {action}
      </header>
      {(s.pause_reason || s.timing_note) && <p className="mute small">{s.pause_reason ?? s.timing_note}</p>}
      {s.senders.length > 0 && <p className="sq-senders"><span className="mute">{primary.length} {words}{spare.length ? `, ${spare.length} spare` : ""}:</span> {s.senders.map((x) => `${x.address.replace(/^https:\/\/www\.linkedin\.com\/in\//, "")}${x.role === "spare" ? " (spare)" : ` (${x.daily_share} a day)`}`).join(", ")}</p>}
    </div>
  );
}


export function Motion({ id, onChange }: { id: string; onChange: () => void }) {
  const { actor, demo, needs } = useActor();
  // What the event cost and returned is leadership's and GTM Engineering's view, as on Budget.
  const lead = isGtm(actor) || Boolean(needs?.approvers.includes(actor));
  const [o, setO] = useState<Overview | null>(null);
  const [slots, setSlots] = useState<{ roster: { rep: string }[]; timezone?: string; slots: { id: string; rep: string; starts_at: string; location: string; meeting_id: string | null }[] }>({ roster: [], slots: [] });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [note, setNote] = useState("");
  const [cap, setCap] = useState({ name: "", email: "", company: "", note: "", hot: false });
  const [slot, setSlot] = useState({ rep: "", day: "", from: "09:00", to: "17:00", minutes: 30, location: "Booth" });
  const [cost, setCost] = useState({ category: "", amount: "" });
  const [slotForm, setSlotForm] = useState(false), [capForm, setCapForm] = useState(false);
  // Which meetings a funnel row asked for: the Meetings fold shows only those until "All meetings".
  const [meetView, setMeetView] = useState<keyof typeof MEET_VIEWS | null>(null);
  const showMeetings = (v: keyof typeof MEET_VIEWS) => { setMeetView(v); requestAnimationFrame(() => openFold("Meetings")); };
  const [seqs, setSeqs] = useState<SeqList | null>(null);
  const load = async () => {
    // The tab and its sequences arrive together, so the Sequences fold never shows empty while its rows load.
    const [ov, sq] = await Promise.all([get<Overview>(`/api/events/${id}/motion`), get<SeqList>(`/api/events/${id}/sequences`)]);
    setSeqs(sq); setO(ov);
    const r = await get<typeof slots>(`/api/events/${id}/motion/roster`);
    if (r) { setSlots(r); setSlot((x) => (x.rep ? x : { ...x, rep: r.roster[0]?.rep ?? "" })); }
  };
  useEffect(() => { load(); }, [id]);
  const act: Act = async (m, p, b, say = "") => {
    setBusy(true); setError(""); setNote("");
    try {
      const r = await send<{ did?: string }>(m, p, actor, b);
      if (!r.ok) { setError(r.error); return; }
      setNote(r.data?.did ?? say); await load(); onChange();
    } finally { setBusy(false); }
  };
  if (!o) return null;
  const f = o.funnel, s = o.live_score, started = o.motion !== "none";
  const free = slots.slots.filter((x) => !x.meeting_id), roster = slots.roster.map((x) => x.rep);
  const booked = new Set(o.meetings.map((m) => m.contact_id).filter(Boolean) as string[]);
  // Waiting on a rep means waiting: a reply a rep has answered, or someone with a meeting booked, is not. Same rule as Overview.
  const hot = o.replies.filter((r) => r.waiting && (r.code === "interested" || r.code === "meeting_request" || r.code === "referral") && !(r.contact_id && booked.has(r.contact_id)));
  const sheet = openObject();
  const mine = o.owners.find((x) => x.status === "mine")?.n ?? 0;
  const missingRegions = o.regions.filter((r) => !r.basis);
  const live = o.sequences.filter((x) => x.state === "active").length;
  const short = o.sequences.filter((x) => x.sender_status === "short").length;
  const pipeline = s ? s.influence.sourced.cents + s.influence.influenced.cents : 0;
  const top = s ? Math.max(s.cost.dollars_cents, pipeline, 1) : 1;
  // After the event: the follow-up, by what happened there. A rep has the people who met someone, were hot at the booth, or replied.
  const pe = o.post_event, g = pe?.groups ?? {};
  const canFollowUp = Boolean(pe && pe.window === "after" && !pe.started_at && ["sequencing", "in_market"].includes(o.motion));
  const withRep = (g.met ?? 0) + (g.hot ?? 0) + (g.replied ?? 0) + (g.scanned ?? 0);
  const followUp = FOLLOW_UP.reduce((n, [k]) => n + (g[k] ?? 0), 0);

  return (
    <section className="motion" aria-label="Outreach" data-ready="1">
      <h2 className="sr-only">Outreach</h2>
      {((demo && !canFollowUp && !["closing", "scored"].includes(o.motion)) || (!demo && !started && (!o.card || o.card.status === "declined")) || canFollowUp) && <div className="m-head">
        {demo && !canFollowUp && !["closing", "scored"].includes(o.motion) && <button className="btn line small" disabled={busy} onClick={() => act("POST", `/api/demo/motion/${id}/advance`)}>{o.motion === "in_market" ? "Simulate replies" : "Next step"}</button>}
        {!demo && !started && (!o.card || o.card.status === "declined") && <button className="btn small" disabled={busy} onClick={() => act("POST", `/api/events/${id}/motion/start`)}>Start outreach</button>}
        {canFollowUp && <button className="btn small" disabled={busy} onClick={() => act("POST", `/api/events/${id}/motion/sequences`, undefined, "The follow-up is set up. Each sequence waits for its launch checklist.")}>Start the follow-up</button>}
      </div>}
      {note && <p className="m-note" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {(o.card?.status === "pending" || (!started && o.capacity)) && (
        <ul className="m-rows m-wide">
          {o.card?.status === "pending" && <li><span>Reading replies, waiting on the uploader</span><b>{o.card.llm_cap !== null ? <>Up to {plural(o.card.llm_cap, "AI call")}{o.card.est_cents !== null ? `, about ${money(o.card.est_cents)}` : ""}</> : "Waiting"}</b></li>}
          {!started && o.capacity && <li><span>Healthy inboxes</span><b>{o.capacity.healthy < o.capacity.needed ? <span className="fig over"><b>{o.capacity.needed - o.capacity.healthy}</b> short of {o.capacity.needed}</span> : `${o.capacity.healthy} for ${o.capacity.needed} needed`}</b></li>}
        </ul>
      )}

      {pe && started && pe.window === "during" && <p className="m-line">Follow-up from {shortDate(addDay(pe.last_day))}</p>}
      {canFollowUp && (
        <section className="brief" aria-label="Follow-up after the event">
          <div>
            <h3>After the event<span>{num(followUp + withRep)}</span></h3>
            <ul>
              {FOLLOW_UP.filter(([k]) => (g[k] ?? 0) > 0).map(([k, label]) => <Row key={k} label={label} n={g[k]!} of={followUp + withRep} />)}
              {withRep > 0 && <Row label="With a rep, not sequenced" n={withRep} of={followUp + withRep} tone="t3" />}
            </ul>
            {pe!.last_press && <p className="m-line">Start by {shortDate(pe!.last_press)}</p>}
          </div>
        </section>
      )}
      {seqs && <Started seqs={seqs} followUp={pe?.started_at ? { at: pe.started_at, by: pe.started_by } : null} />}

      {started && f && (
        <section className="brief" aria-label="Outreach in brief">
          <div>
            <h3>People<span>{num(f.kept)}</span></h3>
            <ul>
              <Row label="In sequences" n={f.enrolled} of={f.kept} onOpen={() => openFold("Sequences")} />
              <Row label="Reached" n={f.sent} of={f.kept} />
              <Row label="Replied" n={f.replied} of={f.kept} onOpen={hot.length ? () => document.querySelector(".m-replies")?.scrollIntoView({ behavior: "smooth", block: "start" }) : () => openFold("Replies")} />
              {/* Where meetings came from, then every meeting held: the same total as every other screen. */}
              <Row label="Booked from a reply" onOpen={() => showMeetings("reply")} n={f.booked} of={f.kept} />
              {(f.held_all ?? f.held) > f.held && <Row label="Met at the booth" n={(f.held_all ?? f.held) - f.held} of={f.kept} onOpen={() => showMeetings("booth")} />}
              <Row label="Meetings held" n={f.held_all ?? f.held} of={f.kept} onOpen={() => showMeetings("held")} />
              {mine > 0 && <Row label="Held back by account owners" n={mine} of={f.kept} tone="t3" />}
            </ul>
          </div>
        </section>
      )}

      {hot.length > 0 && (
        <div className="m-group m-replies">
          <h3>Waiting on a rep<span className="mute">{hot.length}</span></h3>
          <ReplyRows rows={hot.slice(0, 40)} open={sheet.reply} state={(r) => ({ text: CODE_WORDS[r.code ?? ""] ?? "Replied", soon: r.code === "meeting_request" })} />
        </div>
      )}

      <div className="folds">
        {o.sequences.length > 0 && (
          <Fold icon={<Icon.lists />} title="Sequences" peek={<>{short > 0 && <span className="fig over"><b>{short}</b> short of inboxes</span>}<i>{live} of {o.sequences.length} live</i></>}>
            {seqs ? <SequenceLanes list={seqs} eventId={id} /> : null}
            {o.sequences.filter((x) => x.state === "draft" && (!x.external_id || !x.checklist_at)).map((x) => <SequenceDetail key={x.id} s={x} act={act} busy={busy} />)}
          </Fold>
        )}
        {started && missingRegions.length > 0 && (
          <Fold icon={<Icon.pin />} title="Who we may contact" peek={<span className="fig over"><b>{missingRegions.length}</b> regions to confirm</span>}>
            <div className="rg-tiles">{missingRegions.map((r) => (
              <div key={r.region} className="rg-tile">
                <span className="rg-name">{r.region === "unknown" ? "Region unknown" : r.region[0].toUpperCase() + r.region.slice(1)}</span>
                <b>{num(r.people)}</b><span className="mute">{r.people === 1 ? "person" : "people"}</span>
                <button className="btn small line" disabled={busy} onClick={() => act("POST", `/api/events/${id}/motion/legal-basis`, { region: r.region, basis: "Legitimate interest" })}>Confirm</button>
              </div>
            ))}</div>
          </Fold>
        )}
        {o.replies.some((r) => (r.signal ?? "reply") === "reply") && <RepliesFold replies={o.replies.filter((r) => (r.signal ?? "reply") === "reply")} open={sheet.reply} />}
        {o.meetings.length > 0 && (
          <Fold icon={<Icon.calendar />} title="Meetings" peek={<>{num(o.meetings.filter((m) => m.status === "held").length)} held<i>{num(o.meetings.filter((m) => ["booked", "rescheduled"].includes(m.status)).length)} coming up</i></>}>
            {meetView ? (() => {
              const [title, test] = MEET_VIEWS[meetView], rows = o.meetings.filter(test);
              return (
                <div className="mt-col mt-only">
                  <h4>{title}<span>{rows.length}</span><button type="button" className="btn line small" onClick={() => setMeetView(null)}>All meetings</button></h4>
                  {rows.length ? <MeetingRows rows={rows.slice(0, 40)} open={sheet.meeting} withRep /> : <p className="mute">None.</p>}
                </div>
              );
            })() : (
            <div className="mt-cols">
              {([["Coming up", (m: Meeting) => ["booked", "rescheduled"].includes(m.status)], ["Held", (m: Meeting) => m.status === "held"], ["Did not happen", (m: Meeting) => ["no_show", "cancelled"].includes(m.status)]] as const).map(([title, test]) => {
                const rows = o.meetings.filter(test);
                if (!rows.length) return null;
                return (
                  <div key={title} className="mt-col">
                    <h4>{title}<span>{rows.length}</span></h4>
                    <MeetingRows rows={rows.slice(0, 20)} open={sheet.meeting} withRep />
                  </div>
                );
              })}
            </div>
            )}
          </Fold>
        )}
        {started && roster.length > 0 && (
          <Fold icon={<Icon.seats />} title="Meeting slots" peek={free.length ? <>{num(free.length)} free</> : "None open"}>
            {free.length > 0 ? (
              <div className="sl-days">{[...new Set(free.map((x) => dayIn(x.starts_at, slots.timezone)))].map((day) => (
                <div key={day} className="sl-day">
                  <h4>{headIn(free.find((x) => dayIn(x.starts_at, slots.timezone) === day)!.starts_at, slots.timezone)}</h4>
                  {[...new Set(free.filter((x) => dayIn(x.starts_at, slots.timezone) === day).map((x) => x.rep))].map((rep) => {
                    const mine = free.filter((x) => dayIn(x.starts_at, slots.timezone) === day && x.rep === rep);
                    return <p key={rep} className="sl-line"><span className="sl-rep"><PersonAvatar name={rep} size={24} />{rep}</span><span className="sl-times">{mine.map((x) => <span key={x.id}>{meetTime(x.starts_at, slots.timezone).clock}</span>)}</span><span className="mute">{mine[0].location}</span></p>;
                  })}
                </div>
              ))}</div>
            ) : <p className="mute">No free slots.</p>}
            {slotForm ? (
              <form className="m-form" onSubmit={(e) => { e.preventDefault(); act("POST", `/api/events/${id}/motion/slots`, slot, "Slots opened."); setSlotForm(false); }}>
                <label>Who<select value={slot.rep} onChange={(e) => setSlot({ ...slot, rep: e.target.value })}>{roster.map((x) => <option key={x}>{x}</option>)}</select></label>
                <label>Day<input type="date" value={slot.day} onChange={(e) => setSlot({ ...slot, day: e.target.value })} required /></label>
                <label>From<input type="time" value={slot.from} onChange={(e) => setSlot({ ...slot, from: e.target.value })} /></label>
                <label>To<input type="time" value={slot.to} onChange={(e) => setSlot({ ...slot, to: e.target.value })} /></label>
                <label>Where<input value={slot.location} onChange={(e) => setSlot({ ...slot, location: e.target.value })} /></label>
                <button className="btn small" disabled={busy}>Open slots</button>
              </form>
            ) : <button type="button" className="btn small line" onClick={() => setSlotForm(true)}>Open slots</button>}
          </Fold>
        )}
        {started && (
          <Fold icon={<Icon.people />} title="Met at the booth" peek={o.captures.length ? num(o.captures.length) : undefined}>
            {o.captures.length > 0 && <ul className="mc-list">{o.captures.slice(0, 24).map((c) => (
              <li key={c.id} className={c.temperature === "hot" ? "hot" : undefined}>
                <PersonAvatar name={c.full_name ?? "Someone"} size={30} />
                <span className="mt-who"><To to={c.contact_id ? personHref(id, c.contact_id, c.full_name) : null}><b>{c.full_name ?? "Someone"}</b></To><span>{c.company ? <To to={companyHref(id, c.company)}>{c.company}</To> : "Company not given"}</span></span>
                <span className="mc-rep">{c.temperature === "hot" && <b className="md-hot">Hot</b>}met by {c.rep.split(" ")[0]}</span>
              </li>
            ))}</ul>}
            {capForm ? (
              <form className="m-form" onSubmit={(e) => { e.preventDefault(); act("POST", `/api/events/${id}/motion/capture`, { full_name: cap.name, email: cap.email, company: cap.company, note: cap.note, met: true, temperature: cap.hot ? "hot" : "warm" }, cap.hot ? "Saved. Their outreach is stopped, and a task for today is in the CRM." : "Saved. Their outreach is stopped."); setCap({ name: "", email: "", company: "", note: "", hot: false }); setCapForm(false); }}>
                <label>Name<input value={cap.name} onChange={(e) => setCap({ ...cap, name: e.target.value })} /></label>
                <label>Email<input type="email" value={cap.email} onChange={(e) => setCap({ ...cap, email: e.target.value })} /></label>
                <label>Company<input value={cap.company} onChange={(e) => setCap({ ...cap, company: e.target.value })} /></label>
                <label>What they said<input value={cap.note} onChange={(e) => setCap({ ...cap, note: e.target.value })} /></label>
                <label className="check"><input type="checkbox" checked={cap.hot} onChange={(e) => setCap({ ...cap, hot: e.target.checked })} /><span>Hot, follow up today</span></label>
                <button className="btn small" disabled={busy}>Save</button>
              </form>
            ) : <button type="button" className="btn small line" onClick={() => setCapForm(true)}>Log someone you met</button>}
          </Fold>
        )}
      </div>
      <ObjectSheets changed={() => { load(); onChange(); }} />
    </section>
  );
}

/** Every reply the event drew, answered or not, by what it said: on a finished event this is where the replies live (Waiting on a rep is empty by then). */
function RepliesFold({ replies, open }: { replies: Reply[]; open: string | null }) {
  const [code, setCode] = useState("");
  const codes = [...new Set(replies.map((r) => r.code ?? ""))].sort((a, b) => replies.filter((r) => (r.code ?? "") === b).length - replies.filter((r) => (r.code ?? "") === a).length);
  const shown = code ? replies.filter((r) => (r.code ?? "") === code) : replies;
  const word = (c: string) => CODE_WORDS[c] ?? (c ? c.replace(/_/g, " ") : "Not read yet");
  // The same split the funnel makes: a person who answered, against an automatic or closing answer. The list shows every one.
  const AUTO = ["out_of_office", "bounced", "unsubscribe", "wrong_person", "departed"];
  const real = new Set(replies.filter((r) => !AUTO.includes(r.code ?? "")).map((r) => r.contact_id ?? r.id)).size, auto = replies.filter((r) => AUTO.includes(r.code ?? "")).length;
  return (
    <Fold icon={<Icon.reply />} title="Replies" peek={<>{auto > 0 && <>{num(auto)} other</>}<i>{num(real)} replied</i></>}>
      {codes.length > 1 && (
        <div className="seg rp-codes" role="group" aria-label="What they said">
          <button type="button" aria-pressed={!code} onClick={() => setCode("")}>All<span>{replies.length}</span></button>
          {codes.map((c) => <button key={c} type="button" aria-pressed={code === c} onClick={() => setCode(c)}>{word(c)}<span>{replies.filter((r) => (r.code ?? "") === c).length}</span></button>)}
        </div>
      )}
      <ReplyRows rows={shown.slice(0, 50)} open={open} state={(r) => ({ text: word(r.code ?? ""), soon: false })} />
    </Fold>
  );
}

interface SeqRowData { id: string; name: string; channel: "email" | "linkedin"; phase: "pre" | "post"; priority: string; zone_group: string | null; connector: string; state: string; launched_at: string | null; checklist_by: string | null; people: number; reached: number | null; replied: number | null; meetings: number; invites: number | null; accepted: number | null }
interface SeqList { sequences: SeqRowData[]; starts_on: string | null; last_day: string | null }
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000);

/** One row saying when a half of the outreach started and who started it: the person on the left, the day on the right edge. */
function StartedRow({ title, by, day, rel }: { title: string; by: string; day: string; rel: string }) {
  return (
    <div className="ob-row ob-still">
      <span className="ob-face"><PersonAvatar name={by} size={36} /></span>
      <span className="ob-who"><b>{title}</b><span>{by}</span></span>
      <span className="m-started-at"><b>{shortDate(day)}</b><span>{rel}</span></span>
    </div>
  );
}

/** Pre-event and follow-up sequences, each with when it started and who started it. Pre-event: whoever cleared the first launched sequence's checklist. */
function Started({ seqs, followUp }: { seqs: SeqList; followUp: { at: string; by: string | null } | null }) {
  const pre = seqs.sequences.filter((s) => s.phase === "pre" && s.launched_at).sort((a, b) => a.launched_at!.localeCompare(b.launched_at!))[0];
  if (!pre && !followUp) return null;
  const before = pre && seqs.starts_on ? daysBetween(pre.launched_at!, seqs.starts_on) : null;
  const after = followUp && seqs.last_day ? daysBetween(seqs.last_day, followUp.at) : null;
  return (
    <div className="ob-tray m-started" aria-label="When the sequences started">
      {pre && <StartedRow title="Pre-event sequences started" by={pre.checklist_by ?? "Events Desk"} day={pre.launched_at!.slice(0, 10)} rel={before === null ? "" : before <= 0 ? "On the first day" : before === 1 ? "1 day before the event" : `${before} days before the event`} />}
      {followUp && <StartedRow title="Follow-up sequences started" by={followUp.by ?? "Events Desk"} day={followUp.at.slice(0, 10)} rel={after === null ? "" : after <= 0 ? "Last day of the event" : after === 1 ? "1 day after the event" : `${after} days after the event`} />}
    </div>
  );
}

const SEQ_STATE_WORD: Record<string, string> = { active: "Live", paused: "Paused", archived: "Ended", draft: "Draft" };

/** The sequences, before the event and after it, one row each: what it is, how many are in it, how many it reached and how many replied. A row opens the sequence. */
function SequenceLanes({ list, eventId }: { list: SeqList; eventId: string }) {
  const { go } = useActor();
  const shown = list.sequences.filter((s) => s.people > 0 || s.state !== "draft" || (s.reached ?? 0) > 0);
  // Both halves always show; an empty one says what happened or when it will.
  const today = new Date().toISOString().slice(0, 10);
  const halves = (["pre", "post"] as const).map((ph) => [ph, shown.filter((s) => s.phase === ph)] as const);
  const empty = (ph: "pre" | "post") => ph === "pre"
    ? (list.starts_on && today >= list.starts_on ? "None before the event" : "None yet")
    : (list.last_day && today <= list.last_day ? `From ${shortDate(new Date(Date.parse(`${list.last_day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10))}` : "Not started");
  return (
    <div className="sq-lanes">
      {halves.map(([ph, rows]) => (
        <section key={ph} className="sq-lane" aria-label={ph === "pre" ? "Before the event" : "After the event"}>
          <h4>{ph === "pre" ? "Before the event" : "After the event"}{rows.length > 0 && <span>{rows.length}</span>}</h4>
          {!rows.length && <p className="sq-empty">{empty(ph)}</p>}
          {rows.length > 0 && <ul className="ob-tray">{rows.map((s, i) => {
            const reach = s.channel === "linkedin" && s.invites !== null ? s.invites : s.reached;
            return (
              <li key={s.id} style={{ "--i": i } as React.CSSProperties}>
                <a href={objectHref("sequence", `${eventId}|${s.id}`)} className="ob-row sq-row" data-opens-sheet="" onClick={(ev) => { ev.preventDefault(); go(objectHref("sequence", `${eventId}|${s.id}`)); }}>
                  <span className="ob-who"><b><SeqName s={s} /></b><span>{SEQ_STATE_WORD[s.state] ?? s.state}</span></span>
                  <span className="sq-fig"><b>{num(s.people)}</b><span>added</span></span>
                  <span className="sq-fig"><b>{reach === null ? "None" : num(reach)}</b><span>{reach === null ? "not reported" : s.channel === "linkedin" && s.invites !== null ? "invited" : "reached"}</span></span>
                  <span className="sq-fig"><b>{s.replied === null ? "None" : num(s.replied)}</b><span>{s.replied === null ? "not reported" : "replied"}</span></span>
                </a>
              </li>
            );
          })}</ul>}
        </section>
      ))}
    </div>
  );
}

