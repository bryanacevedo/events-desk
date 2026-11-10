/* A rep's day, across every event: who is waiting on them, who they are meeting and what to know first, and their free slots. Made to be read on a phone between meetings. */

import { useEffect, useState } from "react";
import { get, send } from "./api";
import { useActor } from "./App";
import { plural } from "./words";

interface Brief { person: string; title: string | null; company: string; tier: number | null; why: string | null; industry: string | null; employees: string | null; owner: string | null; deal: string | null; said: string | null; met_note: string | null }
interface Day {
  replies: { id: string; event: string; full_name: string | null; company: string; code: string | null; body: string | null; respond_by: string }[];
  meetings: { id: string; event: string; scheduled_at: string; full_name: string | null; company: string; location: string | null; brief: Brief | null }[];
  captures: { id: string; full_name: string | null; company: string | null; note: string; temperature: string }[];
  slots: { id: string; event: string; starts_at: string; location: string }[];
}
const time = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
const CODE: Record<string, string> = { interested: "Interested", meeting_request: "Wants a meeting", referral: "Referred us" };

export function MyDay() {
  const { actor } = useActor();
  const [d, setD] = useState<Day | null>(null), [busy, setBusy] = useState(false);
  const load = async () => setD(await get<Day>(`/api/motion/my-day?rep=${encodeURIComponent(actor)}`));
  useEffect(() => { load(); }, [actor]);
  if (!d) return null;
  const handled = async (id: string) => { setBusy(true); await send("POST", `/api/motion/replies/${id}/handled`, actor); await load(); setBusy(false); };
  const nothing = !d.replies.length && !d.meetings.length && !d.slots.length && !d.captures.length;
  return (
    <section className="myday" data-ready="1">
      <h1 className="display">My day</h1>
      {nothing && <p className="mute">Nothing waiting on {actor} right now. Replies routed to you, your meetings and your free slots show up here.</p>}

      {d.replies.length > 0 && <div className="m-sec"><h3>{plural(d.replies.length, "person", "people")} waiting on you</h3>
        <ul className="m-replies">{d.replies.map((r) => (
          <li key={r.id}>
            <div><b>{r.full_name ?? "Someone"}</b><span className="mute"> {r.company} · {r.event}</span></div>
            <span className="m-code">{CODE[r.code ?? ""] ?? "Replied"}</span>
            {r.body && <blockquote>{r.body}</blockquote>}
            <p className="small mute">Answer by {time(r.respond_by)}</p>
            <button className="btn small line" disabled={busy} onClick={() => handled(r.id)}>I have answered</button>
          </li>))}</ul></div>}

      {d.meetings.length > 0 && <div className="m-sec"><h3>Your meetings</h3>
        <div className="briefs">{d.meetings.map((m) => (
          <article key={m.id} className="brief-card">
            <header><b>{m.full_name ?? "Someone"}</b><span className="mute">{time(m.scheduled_at)}{m.location ? ` · ${m.location}` : ""}</span></header>
            {m.brief && <dl>
              <div><dt>Company</dt><dd>{m.brief.company}{m.brief.tier ? `, tier ${m.brief.tier}` : ""}</dd></div>
              {m.brief.title && <div><dt>Role</dt><dd>{m.brief.title}</dd></div>}
              {m.brief.why && <div><dt>Why they fit</dt><dd>{m.brief.why}</dd></div>}
              {(m.brief.industry || m.brief.employees) && <div><dt>Company size</dt><dd>{[m.brief.industry, m.brief.employees && `${m.brief.employees} people`].filter(Boolean).join(", ")}</dd></div>}
              {m.brief.deal && <div><dt>Open deal</dt><dd>{m.brief.deal}{m.brief.owner ? `, owned by ${m.brief.owner}` : ""}</dd></div>}
              {m.brief.said && <div><dt>They wrote</dt><dd>{m.brief.said}</dd></div>}
              {m.brief.met_note && <div><dt>Met at the event</dt><dd>{m.brief.met_note}</dd></div>}
            </dl>}
          </article>))}</div></div>}

      {d.slots.length > 0 && <div className="m-sec"><h3>{plural(d.slots.length, "free slot")}</h3><ul className="m-senders">{d.slots.slice(0, 12).map((s) => <li key={s.id}><span>{time(s.starts_at)}</span><span className="mute">{s.location} · {s.event}</span></li>)}</ul></div>}
      {d.captures.length > 0 && <div className="m-sec"><h3>People you met</h3><ul className="m-senders">{d.captures.map((c) => <li key={c.id}><span>{c.full_name ?? "Someone"}, {c.company}</span><span className="mute">{c.note}</span></li>)}</ul></div>}
    </section>
  );
}
