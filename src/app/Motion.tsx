/* Everything after the list is delivered, on one screen. It leads with where the event stands and the one thing to do next. The detail is a click away. */

import { useEffect, useState } from "react";
import { get, send } from "./api";
import { useActor } from "./App";
import { money, plural } from "./words";

interface Sender { address: string; role: "primary" | "spare"; daily_share: number; health: number | null }
interface Excluded { address: string; reason: string }
interface Sequence { id: string; name: string; channel: "email" | "linkedin"; priority: string; connector: string; state: string; launched_at: string | null; pause_reason: string | null; senders_needed: number | null; peak_daily: number | null; sender_status: "ok" | "short" | "not_visible" | null; sender_excluded: Excluded[]; enrolled: number; paused: number; removed: number; senders: Sender[]; timing_note: string | null; external_id: string | null; checklist_at: string | null }
interface Reply { id: string; channel: string; signal: string; code: string | null; doubtful: boolean; received_at: string; body: string | null; contact_id: string | null; full_name: string | null; company: string | null; owner?: string | null; respond_by?: string | null; handled_at?: string | null }
interface Meeting { id: string; status: string; scheduled_at: string; rep: string | null; source: string; full_name: string | null; company: string | null }
interface Capture { id: string; full_name: string | null; company: string | null; note: string; temperature: string; rep: string }
interface Funds { sourced: { n: number; cents: number }; influenced: { n: number; cents: number }; won: { n: number; cents: number }; available: boolean; stale: number }
interface Score { funnel: { kept: number; enrolled: number; sent: number; replied: number; booked: number; held: number }; logged_outside: number; held_all: number; cost: { tickets_cents: number; travel_cents: number; ai_cents: number; other_cents: number; dollars_cents: number }; cost_per_held_cents: number | null; influence: Funds; control: { available: boolean; met_accounts: number; met_with_pipeline: number; control_accounts: number; control_with_pipeline: number }; roi: { pipeline_per_dollar: number | null; won_per_dollar: number | null; cost_missing: string[] }; score: { held_per_thousand: number } | null; past: { held_per_thousand: number | null } }
interface Overview {
  motion: string; label: string; simulated: boolean; tools: Record<string, string>; poll_minutes: number; crm_connected: boolean; open_cases: number;
  connectors: { name: string; channels: string[]; simulated: boolean }[];
  card: { id: string; status: string; approval_id: string | null; llm_cap: number; credits_cap: number; est_cents: number; lines: { people: number; companies: number } } | null;
  sequences: Sequence[]; funnel: Score["funnel"] & { logged_outside: number; held_all: number } | null; owners: { status: string; n: number }[]; replies: Reply[]; meetings: Meeting[]; captures: Capture[]; unplaced: { id: string; body: string | null }[]; regions: { region: string; people: number; basis: string | null }[]; live_score: Score | null;
}

const CODE: Record<string, string> = { interested: "Interested", meeting_request: "Wants a meeting", referral: "Referred us", not_now: "Not now", not_interested: "Not interested", out_of_office: "Out of office", unsubscribe: "Unsubscribed", bounced: "Bounced", wrong_person: "Wrong person", departed: "Left the company", other: "Unclear" };
const REASON: Record<string, string> = { not_connected: "Not connected", health_unknown: "Health not reported", low_health: "Health too low", still_warming: "Still warming up", high_bounce: "Bounces too high", high_spam: "Spam too high", fully_booked: "Fully used elsewhere", domain_full: "Domain has enough", no_auth: "No SPF or DMARC", failed_placement: "Failed placement test", stale_placement: "Placement test too old", not_tested: "Placement not tested", warmup_off: "Warmup is off", burned: "Domain burned or resting", primary_domain: "Company's own domain", no_consent: "Rep has not agreed" };
const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const usd = (cents: number) => money(cents);

function Funnel({ f, simulated }: { f: NonNullable<Overview["funnel"]>; simulated: boolean }) {
  const steps: [number, string][] = [[f.kept, "On the list"], [f.enrolled, "In sequences"], [f.sent, "Reached"], [f.replied, "Replied"], [f.booked, "Booked"], [f.held, "Held"]];
  const top = Math.max(f.kept, 1);
  return (
    <div className="m-funnel" role="img" aria-label={steps.map(([n, l]) => `${l}: ${n}`).join(", ")}>
      {steps.map(([n, l]) => <div key={l}><b>{n.toLocaleString("en-US")}</b><span>{l}</span><i style={{ width: `${Math.max(2, (n / top) * 100)}%` }} /></div>)}
      {(f.logged_outside > 0 || simulated) && <p className="mute small">{f.logged_outside > 0 && <>{plural(f.logged_outside, "meeting")} came from outside the sequences, and are counted apart. </>}{simulated && "Sample activity from a simulator, not real people."}</p>}
    </div>
  );
}

function SequenceCard({ s, act, busy }: { s: Sequence; act: (m: "POST", p: string, b?: unknown) => void; busy: boolean }) {
  const [campaign, setCampaign] = useState("");
  const primary = s.senders.filter((x) => x.role === "primary"), spare = s.senders.filter((x) => x.role === "spare");
  const word = s.channel === "email" ? "inbox" : "LinkedIn account", words = s.channel === "email" ? "inboxes" : "LinkedIn accounts";
  return (
    <article className="m-seq">
      <header>
        <div><h4>{s.name.replace(/ [a-z0-9]{6}$/, "")}</h4><p className="mute small">{s.connector} · {plural(s.enrolled, "person", "people")} in{s.paused ? ` · ${s.paused} paused` : ""}</p></div>
        <span className={`m-state ${s.state}`}>{s.state}</span>
      </header>
      {s.sender_status && s.sender_status !== "not_visible" && (
        <dl className="m-size">
          <div><dd>{s.peak_daily ?? 0}</dd><dt>sends on the busiest day</dt></div>
          <div><dd>{s.senders_needed ?? 0}</dd><dt>{s.senders_needed === 1 ? word : words} needed</dt></div>
          <div><dd>{primary.length}<small>+{spare.length}</small></dd><dt>chosen, plus spares</dt></div>
        </dl>
      )}
      {s.sender_status === "short" && <p className="m-warn">Not enough healthy {words}. This sequence will not go out.</p>}
      {s.sender_status === "not_visible" && <p className="m-warn">This tool does not show its {words}, so the desk cannot vouch for them.</p>}
      {s.pause_reason && <p className="m-warn">{s.pause_reason}</p>}
      {s.timing_note && <p className="m-warn soft">{s.timing_note}</p>}
      {!s.external_id && (
        <form className="m-inline" onSubmit={(e) => { e.preventDefault(); act("POST", `/api/motion/sequences/${s.id}/campaign`, { external_id: campaign }); }}>
          <label>This tool's campaigns are made by a person. Paste this sequence's own campaign id<input value={campaign} onChange={(e) => setCampaign(e.target.value)} required /></label>
          <button className="btn small" disabled={busy}>Connect</button>
        </form>
      )}
      {s.external_id && s.state === "draft" && !s.checklist_at && (
        <div className="m-inline"><p className="small">Before launch: DKIM is set, one-click unsubscribe is on, and the sending tool's limits are right.</p><button className="btn small" disabled={busy} onClick={() => act("POST", `/api/motion/sequences/${s.id}/checklist`)}>Confirm</button></div>
      )}
      {s.senders.length > 0 && (
        <details className="m-more"><summary>Which {words}, and why</summary>
          <ul className="m-senders">{s.senders.map((x) => <li key={x.address}><span>{x.address}</span><span className="mute">{x.role === "spare" ? "spare" : `${x.daily_share} a day`}</span><b>{x.health === null ? "n/a" : Math.round(Number(x.health))}</b></li>)}</ul>
          {s.sender_excluded.length > 0 && <><h5>Left out</h5><ul className="m-senders">{s.sender_excluded.slice(0, 12).map((x) => <li key={x.address}><span>{x.address}</span><span className="mute">{REASON[x.reason] ?? x.reason}</span></li>)}</ul></>}
        </details>
      )}
    </article>
  );
}

const needsYou = (s: Sequence) => !s.external_id || (s.state === "draft" && !s.checklist_at) || s.sender_status === "short" || s.sender_status === "not_visible" || Boolean(s.pause_reason) || Boolean(s.timing_note);

/** One line per channel says whether sending is healthy. Only the sequences that need someone are open. */
function Sending({ sequences, act, busy }: { sequences: Sequence[]; act: (m: "POST", p: string, b?: unknown) => void; busy: boolean }) {
  const open = sequences.filter(needsYou), quiet = sequences.filter((s) => !needsYou(s));
  const line = (channel: "email" | "linkedin") => {
    const rows = sequences.filter((s) => s.channel === channel);
    if (!rows.length) return null;
    const live = rows.filter((s) => s.state === "active").length, people = rows.reduce((n, s) => n + s.enrolled, 0);
    const accounts = new Set(rows.flatMap((s) => s.senders.map((x) => x.address))), peak = rows.reduce((n, s) => n + (s.peak_daily ?? 0), 0);
    return (
      <div className="m-channel" key={channel}>
        <h4>{channel === "email" ? "Email" : "LinkedIn"}</h4>
        <dl className="m-size">
          <div><dd>{people}</dd><dt>people in sequence</dt></div>
          <div><dd>{peak}</dd><dt>sends on the busiest day</dt></div>
          <div><dd>{accounts.size}</dd><dt>healthy {channel === "email" ? "inboxes" : "accounts"} chosen</dt></div>
          <div><dd>{live}<small>/{rows.length}</small></dd><dt>sequences live</dt></div>
        </dl>
      </div>
    );
  };
  return (
    <section className="m-sec">
      <h3>Sending</h3>
      <div className="m-channels">{line("email")}{line("linkedin")}</div>
      {open.length > 0 && <div className="m-seqs">{open.map((s) => <SequenceCard key={s.id} s={s} busy={busy} act={act} />)}</div>}
      {quiet.length > 0 && <details className="m-more"><summary>{plural(quiet.length, "sequence")}, by priority and region</summary><div className="m-seqs">{quiet.map((s) => <SequenceCard key={s.id} s={s} busy={busy} act={act} />)}</div></details>}
    </section>
  );
}

function Roi({ s, eventId, act, busy }: { s: Score; eventId: string; act: (m: "POST", p: string, b?: unknown) => void; busy: boolean }) {
  const [category, setCategory] = useState(s.roi.cost_missing[0] ?? "sponsorship"), [amount, setAmount] = useState("");
  const i = s.influence;
  return (
    <section className="m-sec">
      <h3>Did it pay for itself?</h3>
      <dl className="m-roi">
        <div><dd>{s.held_all}</dd><dt>meetings held</dt></div>
        <div><dd>{s.cost_per_held_cents === null ? "n/a" : usd(s.cost_per_held_cents)}</dd><dt>per held meeting</dt></div>
        <div><dd>{i.available ? usd(i.sourced.cents + i.influenced.cents) : "Not available"}</dd><dt>pipeline credited</dt></div>
        <div><dd>{s.roi.pipeline_per_dollar === null ? "n/a" : `${s.roi.pipeline_per_dollar}x`}</dd><dt>pipeline per dollar</dt></div>
      </dl>
      {i.available && <ul className="m-split">
        <li><b>{usd(i.sourced.cents)}</b> sourced, {plural(i.sourced.n, "deal")} created within 30 days after a held meeting</li>
        <li><b>{usd(i.influenced.cents)}</b> influenced, {plural(i.influenced.n, "open deal")} that moved within 90 days after one</li>
        <li><b>{usd(i.won.cents)}</b> closed-won so far</li>
        {i.stale > 0 && <li className="mute">{plural(i.stale, "deal")} past its close date, worth a second look</li>}
      </ul>}
      {s.control.available && s.control.control_accounts > 0 && <p className="small mute">Comparison: {s.control.met_with_pipeline} of {s.control.met_accounts} accounts met have a deal, against {s.control.control_with_pipeline} of {s.control.control_accounts} nobody reached. A comparison, not proof of cause.</p>}
      <p className="small mute">Total cost {usd(s.cost.dollars_cents)}: tickets {usd(s.cost.tickets_cents)}, travel {usd(s.cost.travel_cents)}, AI {usd(s.cost.ai_cents)}, other {usd(s.cost.other_cents)}. Vendor credits are counted apart.{!s.score && " Fewer than 5 held meetings, so counts only and no score."}</p>
      {s.roi.cost_missing.length > 0 && (
        <form className="m-inline" onSubmit={(e) => { e.preventDefault(); act("POST", `/api/events/${eventId}/motion/costs`, { category, amount_cents: Math.round(Number(amount) * 100) }); setAmount(""); }}>
          <label>Not entered yet, so the total is low<select value={category} onChange={(e) => setCategory(e.target.value)}>{s.roi.cost_missing.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}</select></label>
          <label>US dollars<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
          <button className="btn small line" disabled={busy}>Add</button>
        </form>
      )}
    </section>
  );
}

export function Motion({ id, onChange }: { id: string; onChange: () => void }) {
  const { actor, demo } = useActor();
  const [o, setO] = useState<Overview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [note, setNote] = useState("");
  const [cap, setCap] = useState({ name: "", email: "", company: "", note: "" });
  const [slots, setSlots] = useState<{ roster: { rep: string }[]; slots: { id: string; rep: string; starts_at: string; location: string; meeting_id: string | null }[] }>({ roster: [], slots: [] });
  const [slot, setSlot] = useState({ rep: "", day: "", from: "09:00", to: "17:00", minutes: 30, location: "Booth" });
  const load = async () => {
    setO(await get<Overview>(`/api/events/${id}/motion`));
    const r = await get<typeof slots>(`/api/events/${id}/motion/roster`);
    if (r) { setSlots(r); setSlot((x) => (x.rep ? x : { ...x, rep: r.roster[0]?.rep ?? "" })); }
  };
  useEffect(() => { load(); }, [id]);
  const act = async (m: "POST", p: string, b?: unknown, say = "") => {
    setBusy(true); setError(""); setNote("");
    try {
      const r = await send<{ did?: string }>(m, p, actor, b);
      if (!r.ok) { setError(r.error); return; }
      setNote(r.data?.did ?? say); await load(); onChange();
    } finally { setBusy(false); }
  };
  if (!o) return null;
  const waiting = o.replies.filter((r) => r.doubtful).length;
  const start = o.motion === "none" && (!o.card || o.card.status === "declined");
  const pending = o.card?.status === "pending" ? o.card : null;
  const hot = o.replies.filter((r) => r.code === "interested" || r.code === "meeting_request");
  const roster = slots.roster.map((x) => x.rep), free = slots.slots.filter((x) => !x.meeting_id);
  const booked = new Set(o.meetings.map((m) => (m as Meeting & { contact_id?: string }).contact_id).filter(Boolean) as string[]);
  const headline = o.motion === "none" ? "This list is ready for outreach." : o.motion === "owners" ? "Account owners are deciding." : o.motion === "sequencing" ? "Sequences are being set up." : o.motion === "in_market" ? "This event is in market." : o.motion === "closing" ? "This event is closing out." : "This event is scored.";
  return (
    <section className="motion" aria-label="After delivery" data-ready="1">
      <header className="m-head">
        <div><h2>{headline}</h2>{o.simulated && <p className="m-sim">Simulated sequencer. Real connector code, stand-in tools.</p>}</div>
        {demo && !["closing", "scored"].includes(o.motion) && <button className="btn" disabled={busy} onClick={() => act("POST", `/api/demo/motion/${id}/advance`)}>{o.motion === "in_market" ? "Simulate replies and meetings" : "Take the next step"}</button>}
      </header>
      {note && <p className="m-note" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {start && !demo && <div className="m-do"><p>The desk will ask account owners first, then set up sequences. Nothing is sent until a person launches it.</p><button className="btn" disabled={busy} onClick={() => act("POST", `/api/events/${id}/motion/start`)}>Start outreach</button></div>}
      {pending && <div className="m-do"><p><b>Motion card.</b> At most {plural(pending.llm_cap, "AI call")} to read replies and debriefs, about {usd(pending.est_cents)}, for {plural(pending.lines.people, "person", "people")} at {plural(pending.lines.companies, "company", "companies")}.</p>{pending.approval_id && !demo && <p className="mute small">Waiting in Slack for the person who uploaded the list.</p>}</div>}

      {o.owners.length > 0 && <p className="m-line"><b>Account owners:</b> {o.owners.map((x) => `${x.n} ${x.status === "pending" ? "waiting" : x.status === "handed" ? "with the uploader" : x.status}`).join(", ")}</p>}
      {o.funnel && o.motion !== "none" && o.funnel.enrolled > 0 && <Funnel f={o.funnel} simulated={o.simulated} />}
      {waiting > 0 && <p className="m-line warn"><b>{plural(waiting, "reply", "replies")} need a person.</b> {o.open_cases > 0 && "They are in the cases above, and those people stay stopped until someone decides."}</p>}

      {o.sequences.length > 0 && <Sending sequences={o.sequences} busy={busy} act={act} />}

      {o.motion === "sequencing" && o.regions.some((r) => !r.basis) && <section className="m-sec"><h3>Who may we contact?</h3><p className="small mute">Anyone in a region with no recorded basis stays out. Your call, not legal advice.</p><ul className="m-regions">{o.regions.filter((r) => !r.basis).map((r) => <li key={r.region}><span>{r.region}</span><span className="mute">{plural(r.people, "person", "people")}</span><button className="btn small line" disabled={busy} onClick={() => act("POST", `/api/events/${id}/motion/legal-basis`, { region: r.region, basis: "Legitimate interest" })}>Record basis</button></li>)}</ul></section>}

      {hot.length > 0 && <section className="m-sec"><h3>Waiting on a rep</h3><ul className="m-replies">{hot.slice(0, 8).map((r) => (
        <li key={r.id}><div><b>{r.full_name ?? "Someone"}</b><span className="mute"> {r.company}</span></div><span className="m-code">{CODE[r.code ?? ""] ?? "Replied"}</span>{r.body && <blockquote>{r.body}</blockquote>}
          {free.length > 0 && r.contact_id && !booked.has(r.contact_id) && <form className="m-inline" onSubmit={(e) => { e.preventDefault(); const sel = (e.currentTarget.elements.namedItem("slot") as HTMLSelectElement).value; act("POST", `/api/motion/slots/${sel}/book`, { contact_id: r.contact_id }, "Booked. Everyone at that company is paused while the meeting stands."); }}>
            <label>Book a slot<select name="slot">{free.slice(0, 40).map((x) => <option key={x.id} value={x.id}>{x.rep}, {new Date(x.starts_at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC, {x.location}</option>)}</select></label>
            <button className="btn small" disabled={busy}>Book</button>
          </form>}
        </li>))}</ul></section>}

      {o.motion !== "none" && roster.length > 0 && <details className="m-more big"><summary>Meeting slots at the event{free.length ? `, ${free.length} free` : ""}</summary>
        <p className="small mute">Slots belong to people with an approved seat. One meeting per slot, and a rep's slots never overlap.</p>
        <form className="m-capture" onSubmit={(e) => { e.preventDefault(); act("POST", `/api/events/${id}/motion/slots`, slot, "Slots opened."); }}>
          <label>Who<select value={slot.rep} onChange={(e) => setSlot({ ...slot, rep: e.target.value })}>{roster.map((x) => <option key={x}>{x}</option>)}</select></label>
          <label>Day<input type="date" value={slot.day} onChange={(e) => setSlot({ ...slot, day: e.target.value })} required /></label>
          <label>From<input type="time" value={slot.from} onChange={(e) => setSlot({ ...slot, from: e.target.value })} /></label>
          <label>To<input type="time" value={slot.to} onChange={(e) => setSlot({ ...slot, to: e.target.value })} /></label>
          <label>Where<input value={slot.location} onChange={(e) => setSlot({ ...slot, location: e.target.value })} /></label>
          <button className="btn small" disabled={busy}>Open slots</button>
        </form>
      </details>}

      {o.live_score && <Roi s={o.live_score} eventId={id} busy={busy} act={act} />}

      {o.meetings.length > 0 && <details className="m-more big"><summary>{plural(o.meetings.length, "meeting")}</summary><ul className="m-senders">{o.meetings.slice(0, 30).map((m) => <li key={m.id}><span>{m.full_name ?? "Someone"}, {m.company}</span><span className="mute">{m.status.replace("_", " ")} · {when(m.scheduled_at)}</span></li>)}</ul></details>}

      {o.motion !== "none" && <details className="m-more big"><summary>Met someone at the event?</summary>
        <p className="small mute">They stop getting automated outreach right away, whether or not they were on the list.</p>
        <form className="m-capture" onSubmit={(e) => { e.preventDefault(); act("POST", `/api/events/${id}/motion/capture`, { full_name: cap.name, email: cap.email, company: cap.company, note: cap.note, met: true }, "Saved, and their outreach is stopped."); setCap({ name: "", email: "", company: "", note: "" }); }}>
          <label>Name<input value={cap.name} onChange={(e) => setCap({ ...cap, name: e.target.value })} /></label>
          <label>Email<input type="email" value={cap.email} onChange={(e) => setCap({ ...cap, email: e.target.value })} /></label>
          <label>Company<input value={cap.company} onChange={(e) => setCap({ ...cap, company: e.target.value })} /></label>
          <label>What did they say?<input value={cap.note} onChange={(e) => setCap({ ...cap, note: e.target.value })} /></label>
          <button className="btn small" disabled={busy}>Save</button>
        </form>
        {o.captures.length > 0 && <ul className="m-senders">{o.captures.slice(0, 10).map((c) => <li key={c.id}><span>{c.full_name ?? "Someone"}, {c.company}</span><span className="mute">{c.rep}</span></li>)}</ul>}
      </details>}
    </section>
  );
}
