/* Everything after the list is delivered, on the event page. Built from the page's own parts: the brief's bar rows, rows that open themselves, and the folds. Where the event stands is the header's timeline; this section never repeats it. It shows what a person needs to act on and leaves the rest a click away. */

import { useEffect, useState } from "react";
import { get, send } from "./api";
import { useActor } from "./App";
import { Chevron, ExpandRow } from "./Patterns";
import { Icon } from "./icons";
import { money, num, plural, shortDate } from "./words";

interface Sender { address: string; role: "primary" | "spare"; daily_share: number; health: number | null }
interface Sequence { id: string; name: string; channel: "email" | "linkedin"; priority: string; connector: string; state: string; pause_reason: string | null; senders_needed: number | null; peak_daily: number | null; sender_status: "ok" | "short" | "not_visible" | null; sender_excluded: { address: string; reason: string }[]; enrolled: number; paused: number; senders: Sender[]; timing_note: string | null; external_id: string | null; checklist_at: string | null }
interface Reply { id: string; code: string | null; doubtful: boolean; body: string | null; contact_id: string | null; full_name: string | null; company: string | null }
interface Meeting { id: string; contact_id?: string; status: string; scheduled_at: string; rep: string | null; full_name: string | null; company: string | null }
interface Score { held_all: number; logged_outside: number; cost: { dollars_cents: number }; cost_per_held_cents: number | null; influence: { available: boolean; sourced: { n: number; cents: number }; influenced: { n: number; cents: number }; won: { n: number; cents: number } }; control: { available: boolean; met_accounts: number; met_with_pipeline: number; control_accounts: number; control_with_pipeline: number }; roi: { pipeline_per_dollar: number | null; cost_missing: string[] } }
interface Overview {
  motion: string; capacity: { needed: number; healthy: number } | null;
  card: { status: string; llm_cap: number; est_cents: number } | null;
  sequences: Sequence[]; funnel: { kept: number; enrolled: number; sent: number; replied: number; booked: number; held: number } | null; owners: { status: string; n: number }[]; replies: Reply[]; meetings: Meeting[];
  captures: { id: string; full_name: string | null; company: string | null; rep: string }[]; regions: { region: string; people: number; basis: string | null }[]; live_score: Score | null;
  post_event: { window: "before" | "during" | "after" | "closed"; last_day: string; last_press: string; started_at: string | null; started_by: string | null; groups: Record<string, number> } | null;
}
type Act = (m: "POST", p: string, b?: unknown, say?: string) => void;

const CODE: Record<string, string> = { interested: "interested", meeting_request: "wants a meeting", referral: "pointed us to someone" };
const REASON: Record<string, string> = { not_connected: "Not connected", health_unknown: "Health not reported", low_health: "Health too low", still_warming: "Still warming up", high_bounce: "Bounces too high", high_spam: "Spam too high", fully_booked: "Used by other sequences", domain_full: "Domain has enough", no_auth: "Domain not set up to send", failed_placement: "Landing in spam", stale_placement: "Not tested lately", not_tested: "Not tested", warmup_off: "Warmup off", burned: "Domain resting", primary_domain: "Company's own domain", no_consent: "Rep has not agreed" };
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const STATE: Record<string, string> = { active: "Live", paused: "Paused", archived: "Ended", draft: "Draft" };

/** The brief's row: what it is, a thin bar for how much, the number. */
function Row({ label, n, of, tone = "t1", shown }: { label: string; n: number; of: number; tone?: string; shown?: string }) {
  return <li className="brow"><span>{label}</span><i aria-hidden="true"><u className={tone} style={{ width: `${of > 0 ? Math.min(100, (100 * n) / of) : 0}%` }} /></i><b>{shown ?? num(n)}</b></li>;
}

function Fold({ icon, title, peek, children }: { icon: React.ReactNode; title: string; peek?: React.ReactNode; children: React.ReactNode }) {
  return <details className="fold"><summary>{icon}<span className="fold-t">{title}</span><span className="fold-peek">{peek}</span><Chevron /></summary><div className="m-fold">{children}</div></details>;
}

function SequenceRow({ s, act, busy }: { s: Sequence; act: Act; busy: boolean }) {
  const [campaign, setCampaign] = useState("");
  const words = s.channel === "email" ? "inboxes" : "accounts";
  const primary = s.senders.filter((x) => x.role === "primary"), spare = s.senders.filter((x) => x.role === "spare");
  const short = s.sender_status === "short" ? Math.max(1, (s.senders_needed ?? 0) - primary.length) : 0;
  const side = !s.external_id
    ? <form className="m-act" onSubmit={(e) => { e.preventDefault(); act("POST", `/api/motion/sequences/${s.id}/campaign`, { external_id: campaign }); }}><input aria-label="Its campaign in the tool" placeholder="Campaign id" value={campaign} onChange={(e) => setCampaign(e.target.value)} required /><button className="btn small line" disabled={busy}>Connect</button></form>
    : s.state === "draft" && !s.checklist_at ? <button className="btn small line" disabled={busy} onClick={() => act("POST", `/api/motion/sequences/${s.id}/checklist`)}>Ready to launch</button> : null;
  return (
    <ExpandRow className="m-seq" label={s.name} side={side}
      head={<span className="m-seqhead"><span className="xrow-title">{s.name.replace(/ [a-z0-9]{6}$/, "")}</span><span className="mute">{STATE[s.state] ?? s.state}, {plural(s.enrolled, "person", "people")}</span>{short > 0 && <span className="fig over"><b>{short}</b> {words} short</span>}</span>}>
      <ul className="m-rows">
        {s.peak_daily !== null && <li><span>Sends on the busiest day</span><b>{num(s.peak_daily)}</b></li>}
        <li><span>Healthiest {words}, chosen</span><b>{primary.length}{spare.length ? ` and ${spare.length} spare` : ""}</b></li>
        {s.sender_status === "not_visible" && <li><span>This tool does not show its {words}</span><b>Not checked</b></li>}
        {s.pause_reason && <li><span>Paused</span><b className="m-text">{s.pause_reason}</b></li>}
        {s.timing_note && <li><span>Timing</span><b className="m-text">{s.timing_note}</b></li>}
        {s.external_id && s.state === "draft" && !s.checklist_at && <li><span>Before launch</span><b className="m-text">Sending domain signed, one-click unsubscribe on, the tool's limits set</b></li>}
      </ul>
      {s.senders.length > 0 && <ul className="m-rows">{s.senders.map((x) => <li key={x.address}><span>{x.address}</span><b>{x.role === "spare" ? "Spare" : `${x.daily_share} a day`}</b></li>)}</ul>}
      {s.sender_excluded.length > 0 && <ul className="m-rows mute">{s.sender_excluded.slice(0, 8).map((x) => <li key={x.address}><span>{x.address}</span><b>{REASON[x.reason] ?? x.reason}</b></li>)}</ul>}
    </ExpandRow>
  );
}

export function Motion({ id, onChange }: { id: string; onChange: () => void }) {
  const { actor, demo } = useActor();
  const [o, setO] = useState<Overview | null>(null);
  const [slots, setSlots] = useState<{ roster: { rep: string }[]; slots: { id: string; rep: string; starts_at: string; location: string; meeting_id: string | null }[] }>({ roster: [], slots: [] });
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [note, setNote] = useState("");
  const [cap, setCap] = useState({ name: "", email: "", company: "", note: "" });
  const [slot, setSlot] = useState({ rep: "", day: "", from: "09:00", to: "17:00", minutes: 30, location: "Booth" });
  const [cost, setCost] = useState({ category: "", amount: "" });
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

  return (
    <section className="motion" aria-label="Outreach" data-ready="1">
      <div className="m-head">
        <h2 className="display">Outreach</h2>
        {demo && !["closing", "scored"].includes(o.motion) && <button className="btn small" disabled={busy} onClick={() => act("POST", `/api/demo/motion/${id}/advance`)}>{o.motion === "in_market" ? "Simulate replies" : "Next step"}</button>}
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
        <ul className="m-rows m-wide" aria-label="Follow-up after the event">
          <li><span>Scanned at the booth</span><b>{num(g.scanned ?? 0)}</b></li>
          <li><span>Reached before, no reply</span><b>{num(g.reached ?? 0)}</b></li>
          <li><span>Not reached before</span><b>{num(g.not_reached ?? 0)}</b></li>
          {withRep > 0 && <li><span>With a rep, not sequenced</span><b>{num(withRep)}</b></li>}
          <li><span>The button works until</span><b>{shortDate(pe!.last_press)}</b></li>
        </ul>
      )}
      {pe?.started_at && <p className="m-line">Follow-up started by {pe.started_by ?? "someone"} on {when(pe.started_at)}</p>}

      {started && f && (
        <section className="brief" aria-label="Outreach in brief">
          <div>
            <h3>Outreach<span>{num(f.kept)}</span></h3>
            <ul>
              <Row label="In sequences" n={f.enrolled} of={f.kept} />
              <Row label="Reached" n={f.sent} of={f.kept} />
              <Row label="Replied" n={f.replied} of={f.kept} />
              <Row label="Meetings held" n={s?.held_all ?? f.held} of={f.kept} />
              {mine > 0 && <Row label="Kept by account owners" n={mine} of={f.kept} tone="t3" />}
            </ul>
          </div>
          {s && (
            <div>
              <h3>Did it pay for itself?<span>{s.roi.pipeline_per_dollar === null ? "" : `${s.roi.pipeline_per_dollar}x`}</span></h3>
              <ul>
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
            <div>{o.sequences.map((x) => <SequenceRow key={x.id} s={x} busy={busy} act={act} />)}</div>
          </Fold>
        )}
        {started && missingRegions.length > 0 && (
          <Fold icon={<Icon.pin />} title="Who we may contact" peek={<span className="fig over"><b>{missingRegions.length}</b> regions to confirm</span>}>
            <ul className="m-rows">{missingRegions.map((r) => <li key={r.region}><span className="m-cap">{r.region}, {plural(r.people, "person", "people")}</span><button className="btn small line" disabled={busy} onClick={() => act("POST", `/api/events/${id}/motion/legal-basis`, { region: r.region, basis: "Legitimate interest" })}>Confirm</button></li>)}</ul>
          </Fold>
        )}
        {o.meetings.length > 0 && (
          <Fold icon={<Icon.calendar />} title="Meetings" peek={<>{num(o.meetings.filter((m) => m.status === "held").length)} held<i>{num(o.meetings.length)} in all</i></>}>
            <ul className="m-rows">{o.meetings.slice(0, 40).map((m) => <li key={m.id}><span>{m.full_name ?? "Someone"}, {m.company}</span><b>{m.status === "no_show" ? "No-show" : m.status[0].toUpperCase() + m.status.slice(1)}, {when(m.scheduled_at)}</b></li>)}</ul>
          </Fold>
        )}
        {started && roster.length > 0 && (
          <Fold icon={<Icon.seats />} title="Meeting slots" peek={free.length ? <>{num(free.length)} free</> : "None open"}>
            <form className="m-form" onSubmit={(e) => { e.preventDefault(); act("POST", `/api/events/${id}/motion/slots`, slot, "Slots opened."); }}>
              <label>Who<select value={slot.rep} onChange={(e) => setSlot({ ...slot, rep: e.target.value })}>{roster.map((x) => <option key={x}>{x}</option>)}</select></label>
              <label>Day<input type="date" value={slot.day} onChange={(e) => setSlot({ ...slot, day: e.target.value })} required /></label>
              <label>From<input type="time" value={slot.from} onChange={(e) => setSlot({ ...slot, from: e.target.value })} /></label>
              <label>To<input type="time" value={slot.to} onChange={(e) => setSlot({ ...slot, to: e.target.value })} /></label>
              <label>Where<input value={slot.location} onChange={(e) => setSlot({ ...slot, location: e.target.value })} /></label>
              <button className="btn small" disabled={busy}>Open slots</button>
            </form>
          </Fold>
        )}
        {started && (
          <Fold icon={<Icon.people />} title="Met at the event" peek={o.captures.length ? num(o.captures.length) : undefined}>
            <form className="m-form" onSubmit={(e) => { e.preventDefault(); act("POST", `/api/events/${id}/motion/capture`, { full_name: cap.name, email: cap.email, company: cap.company, note: cap.note, met: true }, "Saved. Their outreach is stopped."); setCap({ name: "", email: "", company: "", note: "" }); }}>
              <label>Name<input value={cap.name} onChange={(e) => setCap({ ...cap, name: e.target.value })} /></label>
              <label>Email<input type="email" value={cap.email} onChange={(e) => setCap({ ...cap, email: e.target.value })} /></label>
              <label>Company<input value={cap.company} onChange={(e) => setCap({ ...cap, company: e.target.value })} /></label>
              <label>What they said<input value={cap.note} onChange={(e) => setCap({ ...cap, note: e.target.value })} /></label>
              <button className="btn small" disabled={busy}>Save</button>
            </form>
            {o.captures.length > 0 && <ul className="m-rows">{o.captures.slice(0, 12).map((c) => <li key={c.id}><span>{c.full_name ?? "Someone"}, {c.company}</span><b>{c.rep}</b></li>)}</ul>}
          </Fold>
        )}
      </div>
    </section>
  );
}
