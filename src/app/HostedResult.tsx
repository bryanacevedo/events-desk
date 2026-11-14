/* The Result tab of a hosted event (docs/HOSTED.md 12): who came, what it cost per guest who came, and the two groups the owners follow up. Waitlist and no answer sit apart, followed up as neither.
   Closing attendance is the one action while the day has passed and the list is still open. Money is leadership's and planners'; the server sends everyone else none. */

import { useEffect, useState } from "react";
import { get, send, type HostedFollowUp } from "./api";
import { useActor } from "./App";
import { copyText } from "./Guests";
import { ConfirmDialog } from "./Patterns";
import { money, num } from "./words";

type Row = HostedFollowUp["attended"]["guests"][number];

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className="btn line small" onClick={async () => { if (await copyText(text)) { setDone(true); setTimeout(() => setDone(false), 1400); } }}>{done ? "Copied" : "Copy text"}</button>;
}

function Group({ title, g, partner }: { title: string; g: { count: number; guests: Row[] }; partner: boolean }) {
  if (!g.count) return null;
  return (
    <section className="hr-group" aria-label={title}>
      <h2 className="md-h">{title}<span>{g.count}</span></h2>
      <ul className="hr-rows">
        {g.guests.map((x) => (
          <li className="hr-row" key={x.id}>
            <span className="hr-who"><b>{x.name}</b><span>{[x.company, x.title].filter(Boolean).join(", ")}</span></span>
            <span className="hr-owner">{x.owner}{partner && x.follows_up === "partner" ? ", partner follows up" : ""}</span>
            <span className="hr-note">{x.notes}</span>
            <span className="hr-act">{x.text && x.follows_up === "us" && <CopyButton text={x.text} />}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const Apart = ({ title, rows }: { title: string; rows: Row[] }) => rows.length ? (
  <section className="hr-group" aria-label={title}>
    <h2 className="md-h">{title}<span>{rows.length}</span></h2>
    <ul className="hr-rows plain">{rows.map((x) => <li className="hr-row" key={x.id}><span className="hr-who"><b>{x.name}</b><span>{x.company}</span></span><span className="hr-owner">{x.owner}</span></li>)}</ul>
  </section>
) : null;

export function HostedResult({ id, canWrite, dayBegan, webinar, onChange }: { id: string; canWrite: boolean; dayBegan: boolean; webinar: boolean; onChange: () => void }) {
  const { actor } = useActor();
  const [f, setF] = useState<HostedFollowUp | null>(null), [closing, setClosing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const load = async () => setF(await get<HostedFollowUp>(`/api/events/${id}/follow-up`));
  useEffect(() => { load(); }, [id, actor]);
  if (!f) return null;
  const a = f.attendance, partner = Boolean(f.cohost);
  const cost = "cost" in f ? f.cost : undefined;
  const close = async () => {
    setBusy(true); setError("");
    const r = await send("POST", `/api/events/${id}/close-attendance`, actor);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setClosing(false); await load(); onChange();
  };
  const canClose = !f.closed && dayBegan && canWrite && !webinar;
  return (
    <section className="result hr" aria-label="What the event returned" data-ready="1">
      <header className="md-hero rs-hero">
        <div className="md-hello"><p>{f.closed ? "Attendance closed" : "So far"}</p><h2><b>{num(a.came)}</b><span>{a.came === 1 ? "guest came" : "guests came"}</span></h2></div>
        <div className="md-figs">
          <p><b>{num(a.said_yes)}</b><span>said yes</span></p>
          {f.closed && <p><b>{num(f.no_show.count)}</b><span>did not come</span></p>}
          {a.walk_ins > 0 && <p><b>{num(a.walk_ins)}</b><span>{a.walk_ins === 1 ? "walk-in" : "walk-ins"}</span></p>}
          {cost && <p><b>{cost.per_attendee_cents === null ? "None" : money(cost.per_attendee_cents)}</b><span>per guest who came</span></p>}
          {cost && <p><b>{money(cost.total_cents)}</b><span>cost</span></p>}
          {cost && f.cohost && "our_share_cents" in f.cohost && f.cohost.our_share_cents !== undefined && <p><b>{money(f.cohost.our_share_cents)}</b><span>our share</span></p>}
        </div>
      </header>

      {canClose && <div className="actions"><button type="button" className="btn" onClick={() => setClosing(true)}>Close attendance</button></div>}

      {f.closed && <Group title="Came" g={f.attended} partner={partner} />}
      {f.closed && <Group title="Did not come" g={f.no_show} partner={partner} />}
      {!f.closed && webinar && <Group title="Attended" g={f.attended} partner={partner} />}
      <Apart title="Did not answer" rows={f.did_not_answer.guests} />
      <Apart title="Waitlist" rows={f.waitlist.guests} />

      {closing && (
        <ConfirmDialog title="Close attendance?" confirm="Close attendance" cancel="Not yet" busy={busy} error={error} onConfirm={close} onClose={() => setClosing(false)}>
          <p>{f.registered_pending} still registered will be marked as no-shows.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
