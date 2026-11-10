/* One person, opened from a row of the people table: who they are, how the priority was made,
   and the address that was confirmed. Anything unsettled about the data is a case, not a flag here.
   A person still on the list can be opted out from here; that spans every event and has no undo, so it asks first. */

import { companyDisplayName as co } from "../shared/names";
import { useState } from "react";
import { FLAG_WORDS } from "../shared/tiers";
import { useActor } from "./App";
import { send, type PersonRow } from "./api";
import { ConfirmDialog } from "./Patterns";
import { dropWords } from "./words";
import { gateWords } from "../shared/gate-words";
import { companyHref, To } from "./To";

const GRID: Record<1 | 2 | 3, Record<1 | 2 | 3, "A" | "B" | "C">> = { 1: { 1: "A", 2: "B", 3: "C" }, 2: { 1: "B", 2: "C", 3: "C" }, 3: { 1: "C", 2: "C", 3: "C" } };

export function PriorityGrid({ company, title }: { company: 1 | 2 | 3 | null; title: 1 | 2 | 3 | null }) {
  return (
    <table className="mat" aria-label={`Priority grid: company tier down, title tier across.${company ? ` This person is company ${company}${title ? `, title ${title}` : ", no title"}.` : ""}`}>
      <thead><tr><th></th><th>T1</th><th>T2</th><th>T3</th></tr></thead>
      <tbody>
        {([1, 2, 3] as const).map((c) => (
          <tr key={c}><th>C{c}</th>{([1, 2, 3] as const).map((t) => {
            const p = GRID[c][t];
            const on = company === c && title === t;
            return <td key={t} className={on ? "on" : p === "C" ? "c" : undefined}>{p}</td>;
          })}</tr>
        ))}
      </tbody>
    </table>
  );
}

export function whyPriority(c: Pick<PersonRow, "company" | "company_tier" | "title" | "title_tier" | "priority">): string {
  if (!c.company_tier) return "Not tiered yet";
  // Short facts, not a sentence: the company's tier, the title's tier, and the priority they make.
  return [`Company tier ${c.company_tier}`, c.title_tier ? `Title tier ${c.title_tier}` : "No title tier"].join("  ·  ");
}

/** The quiet "Opt out" on the panel, its confirmation, and the call. `onDone` tells the list the person is now dropped. */
export function OptOut({ c, onDone }: { c: Pick<PersonRow, "full_name" | "email" | "company">; onDone: () => void }) {
  const { actor } = useActor();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const who = c.full_name ?? c.email ?? "this person";
  const run = async () => {
    setBusy(true); setError("");
    const body = { ...(c.email ? { email: c.email } : {}), ...(c.full_name && c.company ? { name: c.full_name, company: c.company } : {}) };
    const r = await send("POST", "/api/suppressions", actor, body);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setOpen(false);
    onDone();
  };
  return (
    <>
      <button className="btn line small" type="button" onClick={() => setOpen(true)}>Opt out</button>
      {open && (
        <ConfirmDialog title={`Opt out ${who}?`} confirm={busy ? "Opting out…" : "Opt out"} cancel="Keep them" busy={busy} error={error} onConfirm={run} onClose={() => { if (!busy) setOpen(false); }}>
          <p>{who} comes off every outreach list and is never looked up again, at every event.</p>
          <p className="mute">{c.email ? `By address, ${c.email}.` : `By name, at ${c.company ?? "their company"}.`} This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </>
  );
}

const REPLY: Record<string, string> = { interested: "interested", meeting_request: "wants a meeting", referral: "pointed to someone else", not_now: "not now", not_interested: "not interested", unsubscribe: "asked to stop", wrong_person: "wrong person", departed: "has left", out_of_office: "out of office", question: "asked a question" };
const PAUSE: Record<string, string> = { meeting: "a meeting is booked", inbound: "they replied", waiting_for_rep: "waiting on a rep", colleague_replied: "a colleague replied", met_onsite: "met at the event", out_of_office: "out of office" };

/** Where this person is in outreach, in one line: what happened last that matters most. */
function outreachWords(c: PersonRow, past = false): string {
  if (c.meeting === "held") return "Meeting held";
  if (c.meeting === "booked" || c.meeting === "rescheduled") return "Meeting booked";
  if (c.reply_code) return `Replied: ${REPLY[c.reply_code] ?? "replied"}`;
  const o = c.outreach;
  if (!o) return c.drop_reason || past ? "Not in outreach" : "Not in outreach yet";
  const by = o.channel === "linkedin" ? "on LinkedIn" : "by email";
  if (o.state === "enrolled") return `In a sequence ${by}`;
  if (o.state === "adding") return `Going into a sequence ${by}`;
  if (o.state === "paused") return `Paused ${by}: ${PAUSE[o.cause ?? ""] ?? "held for now"}`;
  return `Out of outreach: ${o.cause ? gateWords(o.cause) : "removed"}`;
}

export function Person({ c, eventId, past = false, onClose, onChange }: { c: PersonRow; eventId?: string; past?: boolean; onClose: () => void; onChange?: () => void }) {
  const [optedOut, setOptedOut] = useState(false);
  const notes = c.flags.filter((f) => f !== "not_reviewed");
  const canOptOut = !c.drop_reason && !optedOut && Boolean(c.email || (c.full_name && c.company));
  const dropped = optedOut ? "opted_out" : c.drop_reason;
  return (
    <article className="panel" aria-label={c.full_name ?? "Person"} data-person={c.id}>
      <button className="sheet-x panel-x" type="button" aria-label="Close" onClick={onClose}>&times;</button>
      <div className="col">
        <h2>{c.full_name ?? "No name on the row"}</h2>
        <p style={{ fontSize: 16 }}>{c.title ? co(c.title) : "No title"}{c.company ? <>, <To to={eventId ? companyHref(eventId, c.company) : null}>{co(c.company)}</To></> : ""}</p>
        {c.employer && c.employer !== c.company && <p className="mute">Vendor lists {co(c.employer)}</p>}
        {c.linkedin && <a className="mute to wrap-any" href={c.linkedin} target="_blank" rel="noopener noreferrer">{c.linkedin.replace(/^https?:\/\/(www\.)?/, "")}</a>}
        <div className="actions panel-acts">
          {canOptOut && <OptOut c={c} onDone={() => { setOptedOut(true); onChange?.(); }} />}
        </div>
      </div>
      <div className="col">
        <div className="grid-row">
          <PriorityGrid company={c.company_tier} title={c.title_tier} />
          <div className="col">
            <p className="lead">{c.priority ? `Priority ${c.priority}` : "No priority yet"}</p>
            <p>{whyPriority(c)}</p>
          </div>
        </div>
      </div>
      <div className="col">
        <p style={{ fontSize: 16 }}>{outreachWords(c, past)}</p>
        <dl className="kv person-kv">
          <div className="wide"><dt>Email</dt><dd className="wrap-any">{c.email ?? "None"}</dd></div>
          {c.last_verified_at && <div><dt>Verified</dt><dd>{new Date(c.last_verified_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</dd></div>}
          {c.seen_at > 1 && <div><dt>Events seen at</dt><dd>{c.seen_at}</dd></div>}
        </dl>
        {notes.map((f) => <p key={f} className="mute">{FLAG_WORDS[f] ?? f.replace(/_/g, " ")}.</p>)}
        {dropped && <p className={`dropnote${optedOut ? " fresh" : ""}`}><i aria-hidden="true" />{dropWords(dropped)}{optedOut ? ", at every event" : ""}.</p>}
      </div>
    </article>
  );
}
