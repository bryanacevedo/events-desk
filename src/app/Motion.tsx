/* Everything after the list is delivered, on the event page. Built from the page's own parts: the brief's bar rows, rows that open themselves, and the folds. Where the event stands is the header's timeline; this section never repeats it. It shows what a person needs to act on and leaves the rest a click away. */

import { useEffect, useState } from "react";
import { get, send } from "./api";
import { useActor } from "./App";
import { Chevron, ExpandRow } from "./Patterns";
import { Icon } from "./icons";
import { PersonAvatar } from "./PersonAvatar";
import { money, num, plural, shortDate } from "./words";
import { isGtm } from "../shared/roles";

interface Sender { address: string; role: "primary" | "spare"; daily_share: number; health: number | null }
interface Sequence { id: string; name: string; channel: "email" | "linkedin"; priority: string; phase?: "pre" | "post"; zone_group?: string; adding?: number; connector: string; state: string; pause_reason: string | null; senders_needed: number | null; peak_daily: number | null; sender_status: "ok" | "short" | "not_visible" | null; sender_excluded: { address: string; reason: string }[]; enrolled: number; paused: number; senders: Sender[]; timing_note: string | null; external_id: string | null; checklist_at: string | null }
interface Reply { id: string; code: string | null; doubtful: boolean; body: string | null; contact_id: string | null; full_name: string | null; company: string | null }
interface Meeting { id: string; contact_id?: string; status: string; scheduled_at: string; rep: string | null; full_name: string | null; company: string | null }
interface Score { held_all: number; logged_outside: number; cost: { dollars_cents: number }; cost_per_held_cents: number | null; influence: { available: boolean; sourced: { n: number; cents: number }; influenced: { n: number; cents: number }; won: { n: number; cents: number } }; control: { available: boolean; met_accounts: number; met_with_pipeline: number; control_accounts: number; control_with_pipeline: number }; roi: { pipeline_per_dollar: number | null; cost_missing: string[] } }
interface Overview {
  motion: string; capacity: { needed: number; healthy: number } | null;
  card: { status: string; llm_cap: number; est_cents: number } | null;
  sequences: Sequence[]; funnel: { kept: number; enrolled: number; sent: number; replied: number; booked: number; held: number } | null; owners: { status: string; n: number }[]; replies: Reply[]; meetings: Meeting[];
  captures: { id: string; full_name: string | null; company: string | null; rep: string; temperature?: string }[]; regions: { region: string; people: number; basis: string | null }[]; live_score: Score | null;
  post_event: { window: "before" | "during" | "after" | "closed"; last_day: string; last_press: string | null; started_at: string | null; started_by: string | null; groups: Record<string, number> } | null;
}
type Act = (m: "POST", p: string, b?: unknown, say?: string) => void;

const CODE: Record<string, string> = { interested: "interested", meeting_request: "wants a meeting", referral: "pointed us to someone" };
const REASON: Record<string, string> = { not_connected: "Not connected", health_unknown: "Health not reported", low_health: "Health too low", still_warming: "Still warming up", high_bounce: "Bounces too high", high_spam: "Spam too high", fully_booked: "Used by other sequences", domain_full: "Domain has enough", no_auth: "Domain not set up to send", failed_placement: "Landing in spam", stale_placement: "Not tested lately", not_tested: "Not tested", warmup_off: "Warmup off", burned: "Domain resting", primary_domain: "Company's own domain", no_consent: "Rep has not agreed" };
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const FOLLOW_UP = [["scanned", "Scanned at the booth"], ["reached", "Reached before, no reply"], ["not_reached", "Not reached before"]] as const;
/** Meeting and slot times in the reader's own clock. */
const shortWhen = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const clockOf = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const STATE: Record<string, string> = { active: "Live", paused: "Paused", archived: "Ended", draft: "Draft" };

/** The brief's row: what it is, a thin bar for how much, the number. */
function Row({ label, n, of, tone = "t1", shown }: { label: string; n: number; of: number; tone?: string; shown?: string }) {
  return <li className="brow"><span>{label}</span><i aria-hidden="true"><u className={tone} style={{ width: `${of > 0 ? Math.min(100, (100 * n) / of) : 0}%` }} /></i><b>{shown ?? num(n)}</b></li>;
}

function Fold({ icon, title, peek, children }: { icon: React.ReactNode; title: string; peek?: React.ReactNode; children: React.ReactNode }) {
  return <details className="fold"><summary>{icon}<span className="fold-t">{title}</span><span className="fold-peek">{peek}</span><Chevron /></summary><div className="m-fold">{children}</div></details>;
}

const REGION: Record<string, string> = { americas: "Americas", emea: "EMEA", apac: "APAC", event: "Event's region" };
const GROUP_WORDS: Record<string, string> = { scanned: "Scanned at the booth", reached: "Reached before", not_reached: "Not reached before" };
const GROUP_ORDER = ["scanned", "reached", "not_reached"];
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
        <b>{REGION[s.zone_group ?? "event"] ?? s.zone_group}</b>
        <span className="mute">{STATE[s.state] ?? s.state} · {plural(peopleIn(s), "person", "people")}{s.peak_daily !== null ? ` · ${num(s.peak_daily)} on the busiest day` : ""}</span>
        {short > 0 && <span className="fig over"><b>{short}</b> {words} short</span>}
        {action}
      </header>
      {(s.pause_reason || s.timing_note) && <p className="mute small">{s.pause_reason ?? s.timing_note}</p>}
      {s.senders.length > 0 && <p className="sq-senders"><span className="mute">{primary.length} {words}{spare.length ? `, ${spare.length} spare` : ""}:</span> {s.senders.map((x) => `${x.address.replace(/^https:\/\/www\.linkedin\.com\/in\//, "")}${x.role === "spare" ? " (spare)" : ` (${x.daily_share} a day)`}`).join(", ")}</p>}
    </div>
  );
}

/** The sequences as a grid: who (rows, by what happened or by priority) by channel (columns). Each cell is a count and a state; regions and inboxes open from it. */
function SequenceGrid({ sequences, act, busy }: { sequences: Sequence[]; act: Act; busy: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const shown = sequences.filter((s) => peopleIn(s) > 0 || s.state === "draft");
  const phases = (["pre", "post"] as const).filter((p) => shown.some((s) => (s.phase ?? "pre") === p));
  const channels = (["email", "linkedin"] as const).filter((c) => shown.some((s) => s.channel === c));
  return (
    <div className="sq">
      {phases.map((phase) => {
        const mine = shown.filter((s) => (s.phase ?? "pre") === phase);
        const groups = [...new Set(mine.map((s) => s.priority))].sort((a, b) => (GROUP_ORDER.indexOf(a) + 1 || 99) - (GROUP_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
        return (
          <div key={phase} className="sq-phase">
            {phases.length > 1 && <h4>{phase === "pre" ? "Before the event" : "After the event"}</h4>}
            <div className="sq-grid" style={{ gridTemplateColumns: `minmax(120px, 1fr) repeat(${channels.length}, minmax(0, 1.2fr))` }}>
              <span />
              {channels.map((c) => <span key={c} className="sq-col">{c === "email" ? "Email" : "LinkedIn"}</span>)}
              {groups.map((g) => (
                <div key={g} className="sq-row" style={{ display: "contents" }}>
                  <span className="sq-label">{GROUP_WORDS[g] ?? `Priority ${g}`}</span>
                  {channels.map((c) => {
                    const cell = mine.filter((s) => s.priority === g && s.channel === c);
                    const key = `${phase}|${g}|${c}`;
                    if (!cell.length) return <span key={c} className="sq-cell empty">None</span>;
                    const people = cell.reduce((n, s) => n + peopleIn(s), 0);
                    const states = [...new Set(cell.map((s) => STATE[s.state] ?? s.state))];
                    const toCheck = cell.filter((s) => s.state === "draft" && !s.checklist_at).length;
                    const short = cell.some((s) => s.sender_status === "short");
                    return (
                      <button key={c} type="button" className={`sq-cell${open === key ? " on" : ""}`} aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                        <b>{num(people)}</b>
                        <span>{toCheck ? `${toCheck} to check` : states.join(", ")}{short ? " · short of inboxes" : ""}</span>
                        <i>{cell.map((s) => REGION[s.zone_group ?? "event"] ?? s.zone_group).join(" · ")}</i>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            {mine.filter((s) => open === `${phase}|${s.priority}|${s.channel}`).map((s) => <SequenceDetail key={s.id} s={s} act={act} busy={busy} />)}
          </div>
        );
      })}
    </div>
  );
}

export function Motion({ id, onChange }: { id: string; onChange: () => void }) {
  const { actor, demo, needs } = useActor();
  // What the event cost and returned is leadership's and GTM Engineering's view, as on Budget.
  const lead = isGtm(actor) || Boolean(needs?.approvers.includes(actor));
  const [o, setO] = useState<Overview | null>(null);
  const [slots, setSlots] = useState<{ roster: { rep: string }[]; slots: { id: string; rep: string; starts_at: string; location: string; meeting_id: string | null }[] }>({ roster: [], slots: [] });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [note, setNote] = useState("");
  const [cap, setCap] = useState({ name: "", email: "", company: "", note: "", hot: false });
  const [slot, setSlot] = useState({ rep: "", day: "", from: "09:00", to: "17:00", minutes: 30, location: "Booth" });
  const [cost, setCost] = useState({ category: "", amount: "" });
  const [slotForm, setSlotForm] = useState(false), [capForm, setCapForm] = useState(false);
  const load = async () => {
    setO(await get<Overview>(`/api/events/${id}/motion`));
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
  const hot = o.replies.filter((r) => r.code === "interested" || r.code === "meeting_request" || r.code === "referral");
  const free = slots.slots.filter((x) => !x.meeting_id), roster = slots.roster.map((x) => x.rep);
  const booked = new Set(o.meetings.map((m) => m.contact_id).filter(Boolean) as string[]);
  const doubtful = o.replies.filter((r) => r.doubtful).length;
  const mine = o.owners.find((x) => x.status === "mine")?.n ?? 0;
  const missingRegions = o.regions.filter((r) => !r.basis);
  const live = o.sequences.filter((x) => x.state === "active").length;
  const short = o.sequences.filter((x) => x.sender_status === "short").length;
  const pipeline = s ? s.influence.sourced.cents + s.influence.influenced.cents : 0;
  const top = s ? Math.max(s.cost.dollars_cents, pipeline, 1) : 1;
  // After the event: the follow-up, by what happened there. A rep has the people who met someone, were hot at the booth, or replied.
  const pe = o.post_event, g = pe?.groups ?? {};
  const canFollowUp = Boolean(pe && pe.window === "after" && !pe.started_at && ["sequencing", "in_market"].includes(o.motion));
  const withRep = (g.met ?? 0) + (g.hot ?? 0) + (g.replied ?? 0);
  const followUp = FOLLOW_UP.reduce((n, [k]) => n + (g[k] ?? 0), 0);

  return (
    <section className="motion" aria-label="Outreach" data-ready="1">
      <div className="m-head">
        <h2 className="sr-only">Outreach</h2>
        {demo && !canFollowUp && !["closing", "scored"].includes(o.motion) && <button className="btn small" disabled={busy} onClick={() => act("POST", `/api/demo/motion/${id}/advance`)}>{o.motion === "in_market" ? "Simulate replies" : "Next step"}</button>}
        {!demo && !started && (!o.card || o.card.status === "declined") && <button className="btn small" disabled={busy} onClick={() => act("POST", `/api/events/${id}/motion/start`)}>Start outreach</button>}
        {canFollowUp && <button className="btn small" disabled={busy} onClick={() => act("POST", `/api/events/${id}/motion/sequences`, undefined, "The follow-up is set up. Each sequence waits for its launch checklist.")}>Start the follow-up</button>}
      </div>
      {note && <p className="m-note" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {(o.card?.status === "pending" || (!started && o.capacity)) && (
        <ul className="m-rows m-wide">
          {o.card?.status === "pending" && <li><span>Reading replies, waiting on the uploader</span><b>Up to {plural(o.card.llm_cap, "AI call")}, about {money(o.card.est_cents)}</b></li>}
          {!started && o.capacity && <li><span>Healthy inboxes</span><b>{o.capacity.healthy < o.capacity.needed ? <span className="fig over"><b>{o.capacity.needed - o.capacity.healthy}</b> short of {o.capacity.needed}</span> : `${o.capacity.healthy} for ${o.capacity.needed} needed`}</b></li>}
        </ul>
      )}

      {pe && started && pe.window === "during" && <p className="m-line">The event is on. The follow-up can start the day after it ends, {shortDate(pe.last_day)}.</p>}
      {canFollowUp && (
        <section className="brief" aria-label="Follow-up after the event">
          <div>
            <h3>After the event<span>{num(followUp + withRep)}</span></h3>
            <ul>
              {FOLLOW_UP.filter(([k]) => (g[k] ?? 0) > 0).map(([k, label]) => <Row key={k} label={label} n={g[k]!} of={followUp + withRep} />)}
              {withRep > 0 && <Row label="With a rep, not sequenced" n={withRep} of={followUp + withRep} tone="t3" />}
            </ul>
            {pe!.last_press && <p className="m-line">Each group gets its own message. The button works until {shortDate(pe!.last_press)}.</p>}
          </div>
        </section>
      )}
      {pe?.started_at && <p className="m-line">Follow-up started by {pe.started_by ?? "someone"} on {shortDate(pe.started_at.slice(0, 10))}</p>}

      {started && f && (
        <section className="brief" aria-label="Outreach in brief">
          <div>
            <h3>People<span>{num(f.kept)}</span></h3>
            <ul>
              <Row label="In sequences" n={f.enrolled} of={f.kept} />
              <Row label="Reached" n={f.sent} of={f.kept} />
              <Row label="Replied" n={f.replied} of={f.kept} />
              <Row label="Meetings booked" n={o.meetings.filter((m) => ["booked", "rescheduled", "held", "no_show"].includes(m.status)).length} of={f.kept} />
              <Row label="Meetings held" n={s?.held_all ?? f.held} of={f.kept} />
              {mine > 0 && <Row label="Kept by account owners" n={mine} of={f.kept} tone="t3" />}
            </ul>
          </div>
          {s && lead && (
            <div>
              <h3>Did it pay for itself?<span>{s.roi.pipeline_per_dollar === null ? "" : `${s.roi.pipeline_per_dollar}x`}</span></h3>
              <ul className="money">
                <Row label="Cost" n={s.cost.dollars_cents} of={top} tone="t3" shown={money(s.cost.dollars_cents)} />
                {s.influence.available && <>
                  <Row label="New pipeline" n={s.influence.sourced.cents} of={top} shown={money(s.influence.sourced.cents)} />
                  <Row label="Pipeline it moved" n={s.influence.influenced.cents} of={top} tone="t2" shown={money(s.influence.influenced.cents)} />
                  <Row label="Won" n={s.influence.won.cents} of={top} shown={money(s.influence.won.cents)} />
                </>}
                {s.cost_per_held_cents !== null && <li className="brow"><span>Per meeting held</span><i aria-hidden="true" /><b>{money(s.cost_per_held_cents)}</b></li>}
              </ul>
              {s.roi.cost_missing.length > 0 && (
                <form className="m-act" onSubmit={(e) => { e.preventDefault(); act("POST", `/api/events/${id}/motion/costs`, { category: cost.category || s.roi.cost_missing[0], amount_cents: Math.round(Number(cost.amount) * 100) }); setCost({ category: "", amount: "" }); }}>
                  <span className="fig over"><b>{s.roi.cost_missing.length}</b> costs to add</span>
                  <select aria-label="Cost" value={cost.category || s.roi.cost_missing[0]} onChange={(e) => setCost({ ...cost, category: e.target.value })}>{s.roi.cost_missing.map((c) => <option key={c} value={c}>{c === "rep_time" ? "Rep time" : c[0].toUpperCase() + c.slice(1)}</option>)}</select>
                  <input aria-label="US dollars" inputMode="decimal" placeholder="$" value={cost.amount} onChange={(e) => setCost({ ...cost, amount: e.target.value })} required />
                  <button className="btn small line" disabled={busy}>Add</button>
                </form>
              )}
            </div>
          )}
        </section>
      )}

      {doubtful > 0 && <p className="m-line"><span className="fig over"><b>{doubtful}</b> {doubtful === 1 ? "reply" : "replies"} to read</span> in the cases above</p>}

      {hot.length > 0 && (
        <div className="m-group">
          <h3>Waiting on a rep</h3>
          {hot.slice(0, 10).map((r) => (
            <div key={r.id} className="xrow m-reply">
              <div className="m-who"><span className="xrow-title">{r.full_name ?? "Someone"}</span><span className="mute">{r.company}, {CODE[r.code ?? ""] ?? "replied"}</span>{r.body && <q>{r.body}</q>}</div>
              {free.length > 0 && r.contact_id && !booked.has(r.contact_id) && (
                <form className="m-act xrow-side" onSubmit={(e) => { e.preventDefault(); const sel = (e.currentTarget.elements.namedItem("slot") as HTMLSelectElement).value; act("POST", `/api/motion/slots/${sel}/book`, { contact_id: r.contact_id }, "Booked."); }}>
                  <select name="slot" aria-label="Slot">{free.slice(0, 40).map((x) => <option key={x.id} value={x.id}>{x.rep}, {when(x.starts_at)}</option>)}</select>
                  <button className="btn small" disabled={busy}>Book</button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="folds">
        {o.sequences.length > 0 && (
          <Fold icon={<Icon.lists />} title="Sequences" peek={<>{short > 0 && <span className="fig over"><b>{short}</b> short of inboxes</span>}<i>{live} of {o.sequences.length} live</i></>}>
            <SequenceGrid sequences={o.sequences} busy={busy} act={act} />
          </Fold>
        )}
        {started && missingRegions.length > 0 && (
          <Fold icon={<Icon.pin />} title="Who we may contact" peek={<span className="fig over"><b>{missingRegions.length}</b> regions to confirm</span>}>
            <p className="mute small">Nobody in these regions is contacted until someone records the basis for it.</p>
            <div className="rg-tiles">{missingRegions.map((r) => (
              <div key={r.region} className="rg-tile">
                <span className="rg-name">{r.region === "unknown" ? "Region unknown" : r.region[0].toUpperCase() + r.region.slice(1)}</span>
                <b>{num(r.people)}</b><span className="mute">{r.people === 1 ? "person" : "people"}</span>
                <button className="btn small line" disabled={busy} onClick={() => act("POST", `/api/events/${id}/motion/legal-basis`, { region: r.region, basis: "Legitimate interest" })}>Confirm</button>
              </div>
            ))}</div>
          </Fold>
        )}
        {o.meetings.length > 0 && (
          <Fold icon={<Icon.calendar />} title="Meetings" peek={<>{num(o.meetings.filter((m) => m.status === "held").length)} held<i>{num(o.meetings.filter((m) => ["booked", "rescheduled"].includes(m.status)).length)} coming up</i></>}>
            <div className="mt-cols">
              {([["Coming up", (m: Meeting) => ["booked", "rescheduled"].includes(m.status)], ["Held", (m: Meeting) => m.status === "held"], ["Did not happen", (m: Meeting) => ["no_show", "cancelled"].includes(m.status)]] as const).map(([title, test]) => {
                const rows = o.meetings.filter(test);
                if (!rows.length) return null;
                return (
                  <div key={title} className="mt-col">
                    <h4>{title}<span>{rows.length}</span></h4>
                    <ul>{rows.slice(0, 20).map((m) => (
                      <li key={m.id}>
                        <PersonAvatar name={m.full_name ?? "Someone"} size={30} />
                        <span className="mt-who"><b>{m.full_name ?? "Someone"}</b><span>{m.company}{m.rep ? ` · with ${m.rep.split(" ")[0]}` : ""}</span></span>
                        <span className="mt-when">{shortWhen(m.scheduled_at)}{m.status === "no_show" ? " · no-show" : m.status === "cancelled" ? " · cancelled" : ""}</span>
                      </li>
                    ))}</ul>
                  </div>
                );
              })}
            </div>
          </Fold>
        )}
        {started && roster.length > 0 && (
          <Fold icon={<Icon.seats />} title="Meeting slots" peek={free.length ? <>{num(free.length)} free</> : "None open"}>
            {free.length > 0 ? (
              <div className="sl-days">{[...new Set(free.map((x) => x.starts_at.slice(0, 10)))].map((day) => (
                <div key={day} className="sl-day">
                  <h4>{new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</h4>
                  {[...new Set(free.filter((x) => x.starts_at.startsWith(day)).map((x) => x.rep))].map((rep) => {
                    const mine = free.filter((x) => x.starts_at.startsWith(day) && x.rep === rep);
                    return <p key={rep} className="sl-line"><span className="sl-rep"><PersonAvatar name={rep} size={24} />{rep}</span><span className="sl-times">{mine.map((x) => <span key={x.id}>{clockOf(x.starts_at)}</span>)}</span><span className="mute">{mine[0].location}</span></p>;
                  })}
                </div>
              ))}</div>
            ) : <p className="mute">No free slots. Open some for the reps going.</p>}
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
          <Fold icon={<Icon.people />} title="Met at the event" peek={o.captures.length ? num(o.captures.length) : undefined}>
            {o.captures.length > 0 && <ul className="mc-list">{o.captures.slice(0, 24).map((c) => (
              <li key={c.id} className={c.temperature === "hot" ? "hot" : undefined}>
                <PersonAvatar name={c.full_name ?? "Someone"} size={30} />
                <span className="mt-who"><b>{c.full_name ?? "Someone"}</b><span>{c.company ?? "Company not given"}</span></span>
                <span className="mc-rep">{c.temperature === "hot" && <i aria-hidden="true" />}{c.temperature === "hot" ? "Hot · " : ""}met by {c.rep.split(" ")[0]}</span>
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
    </section>
  );
}
