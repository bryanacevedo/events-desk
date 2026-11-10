/* A rep's day, across every event, made to be read on a phone between meetings. It opens like an event does: a tinted header with the day's
   three figures. Then the replies as cards with a face and the event's mark, the words they wrote largest. Then the meetings as an agenda,
   each one's prep a tap away. Everything else is folded at the bottom. */

import { useEffect, useState, type CSSProperties } from "react";
import { get, send } from "./api";
import { useActor } from "./App";
import { EventLogo } from "./EventLogo";
import { Icon } from "./icons";
import { Chevron } from "./Patterns";
import { PersonAvatar } from "./PersonAvatar";
import { plural } from "./words";

interface Brief { person: string; title: string | null; company: string; tier: number | null; why: string | null; industry: string | null; employees: string | null; owner: string | null; deal: string | null; said: string | null; met_note: string | null }
interface Day {
  replies: { id: string; event: string; website: string | null; brand_color: string | null; full_name: string | null; company: string; code: string | null; body: string | null; respond_by: string }[];
  meetings: { id: string; event: string; website: string | null; brand_color: string | null; scheduled_at: string; full_name: string | null; company: string; location: string | null; brief: Brief | null }[];
  captures: { id: string; full_name: string | null; company: string | null; note: string; temperature: string }[];
  slots: { id: string; event: string; starts_at: string; location: string }[];
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayKey = (d: Date) => d.toLocaleDateString("en-CA");
/** How soon a reply needs its answer, against the reader's own day. */
function answerBy(iso: string): { text: string; urgent: boolean } {
  const due = new Date(iso), now = new Date(), tomorrow = new Date(now.getTime() + 86_400_000);
  if (due < now) return { text: "Late", urgent: true };
  if (dayKey(due) === dayKey(now)) return { text: "Answer today", urgent: true };
  if (dayKey(due) === dayKey(tomorrow)) return { text: "Answer tomorrow", urgent: false };
  return { text: `Answer by ${due.toLocaleDateString("en-GB", { weekday: "short" })}`, urgent: false };
}
/** The most urgent replies get a card; the rest are one line each, so thirteen replies still read at a glance. */
const CARDS = 4;
const CODE: Record<string, string> = { interested: "is interested", meeting_request: "wants a meeting", referral: "pointed us to someone" };
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

export function MyDay() {
  const { actor, needs } = useActor();
  // Seat requests still open for this person. Buying the ticket is the approvers' job, so an approval leaves this page.
  const mySeats = (needs?.requests ?? []).filter((r) => r.requester === actor && (r.status === "pending" || r.status === "declined"));
  const [d, setD] = useState<Day | null>(null), [busy, setBusy] = useState(false);
  const load = async () => setD(await get<Day>(`/api/motion/my-day?rep=${encodeURIComponent(actor)}`));
  useEffect(() => { load(); }, [actor]);
  if (!d) return null;
  const handled = async (id: string) => { setBusy(true); await send("POST", `/api/motion/replies/${id}/handled`, actor); await load(); setBusy(false); };
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const figures: [number, string][] = [[d.replies.length, d.replies.length === 1 ? "reply to answer" : "replies to answer"], [d.meetings.length, d.meetings.length === 1 ? "meeting" : "meetings"], [d.captures.length, d.captures.length === 1 ? "person met" : "people met"]];

  return (
    <section className="myday" data-ready="1">
      <header className="md-hero">
        <div className="md-hello">
          <p>{today}</p>
          <h1>{greeting()}, {actor.split(" ")[0]}.</h1>
        </div>
        <div className="md-figs">{figures.map(([n, label]) => <p key={label} className={n ? "" : "zero"}><b>{n}</b><span>{label}</span></p>)}</div>
      </header>

      {d.replies.length > 0 && (
        <div className="m-sec">
          <h2 className="md-h">Answer these first</h2>
          <div className="md-cards">{d.replies.slice(0, CARDS).map((r) => {
            const by = answerBy(r.respond_by);
            return (
              <article key={r.id} className={`md-card${by.urgent ? " urgent" : ""}`} style={{ "--brand": r.brand_color ?? "#1F5D3F" } as CSSProperties}>
                <header>
                  <PersonAvatar name={r.full_name ?? "Someone"} size={40} />
                  <div><b>{r.full_name ?? "Someone"}</b><span>{r.company} · {CODE[r.code ?? ""] ?? "replied"}</span></div>
                  <EventLogo name={r.event} website={r.website} size={28} />
                </header>
                {r.body && <blockquote>{r.body}</blockquote>}
                <footer>
                  <span className="md-by"><i aria-hidden="true" />{by.text}</span>
                  <button className="btn small" disabled={busy} onClick={() => handled(r.id)}>Answered</button>
                </footer>
              </article>
            );
          })}</div>
          {d.replies.length > CARDS && (
            <div className="md-rest">
              <h3>{d.replies.length - CARDS} more</h3>
              <ul>{d.replies.slice(CARDS).map((r) => {
                const by = answerBy(r.respond_by);
                return (
                  <li key={r.id} className={by.urgent ? "urgent" : undefined}>
                    <PersonAvatar name={r.full_name ?? "Someone"} size={30} />
                    <span className="md-rest-who"><b>{r.full_name ?? "Someone"}</b><span>{r.company}</span></span>
                    <q>{r.body ?? (CODE[r.code ?? ""] ?? "replied")}</q>
                    <span className="md-by"><i aria-hidden="true" />{by.text}</span>
                    <button className="btn small line" disabled={busy} onClick={() => handled(r.id)}>Answered</button>
                  </li>
                );
              })}</ul>
            </div>
          )}
        </div>
      )}

      {d.meetings.length > 0 && (
        <div className="m-sec">
          <h2 className="md-h">Your meetings</h2>
          <ol className="md-agenda">{d.meetings.map((m) => {
            const at = new Date(m.scheduled_at);
            return (
              <li key={m.id}>
                <details className="md-meet" style={{ "--brand": m.brand_color ?? "#1F5D3F" } as CSSProperties}>
                  <summary>
                    <span className="md-day"><b>{at.getDate()}</b><span>{at.toLocaleDateString("en-GB", { month: "short" })}<br />{at.toLocaleDateString("en-GB", { weekday: "short" })}</span></span>
                    <span className="md-time">{clock(m.scheduled_at)}</span>
                    <PersonAvatar name={m.full_name ?? "Someone"} size={36} />
                    <span className="md-who"><b>{m.full_name ?? "Someone"}</b><span>{[m.company, m.location].filter(Boolean).join(" · ")}</span></span>
                    <span className="md-prep">Prep<Chevron /></span>
                  </summary>
                  {m.brief && <dl className="md-brief">
                    {m.brief.said && <div className="said"><dt>They wrote</dt><dd>“{m.brief.said}”</dd></div>}
                    {m.brief.title && <div><dt>Role</dt><dd>{m.brief.title}</dd></div>}
                    <div><dt>Company</dt><dd>{m.brief.company}{m.brief.tier ? `, tier ${m.brief.tier}` : ""}</dd></div>
                    {(m.brief.industry || m.brief.employees) && <div><dt>Size</dt><dd>{[m.brief.industry, m.brief.employees && `${m.brief.employees} people`].filter(Boolean).join(", ")}</dd></div>}
                    {m.brief.deal && <div><dt>Open deal</dt><dd>{m.brief.deal}{m.brief.owner ? `, owned by ${m.brief.owner}` : ""}</dd></div>}
                    {m.brief.met_note && <div><dt>Met at the event</dt><dd>{m.brief.met_note}</dd></div>}
                    {m.brief.why && m.brief.why.length > 30 && !/^employees:/i.test(m.brief.why) && <div><dt>Why they fit</dt><dd className="clamp2">{m.brief.why}</dd></div>}
                  </dl>}
                </details>
              </li>
            );
          })}</ol>
        </div>
      )}

      {!d.replies.length && !d.meetings.length && <p className="md-clear">Nothing waiting on you.</p>}

      {(d.slots.length > 0 || d.captures.length > 0 || mySeats.length > 0) && (
        <div className="folds">
          {d.slots.length > 0 && (
            <details className="fold">
              <summary><Icon.calendar /><span className="fold-t">Free slots</span><span className="fold-peek">{plural(d.slots.length, "slot")}<i>next {when(d.slots[0].starts_at)}</i></span><Chevron /></summary>
              <ul className="m-senders">{d.slots.slice(0, 12).map((s) => <li key={s.id}><span>{when(s.starts_at)}</span><b>{s.location} · {s.event}</b></li>)}</ul>
            </details>
          )}
          {d.captures.length > 0 && (
            <details className="fold">
              <summary><Icon.people /><span className="fold-t">People you met</span><span className="fold-peek">{d.captures.length}</span><Chevron /></summary>
              <ul className="m-senders">{d.captures.map((c) => <li key={c.id}><span>{c.full_name ?? "Someone"}{c.company ? `, ${c.company}` : ""}</span><b className="m-text">{c.note}</b></li>)}</ul>
            </details>
          )}
          {mySeats.length > 0 && (
            <details className="fold">
              <summary><Icon.seats /><span className="fold-t">Your seat requests</span><span className="fold-peek">{`${mySeats.filter((r) => r.status === "pending").length} waiting`}</span><Chevron /></summary>
              <ul className="m-senders">{mySeats.map((r) => <li key={r.id}><span>{r.name}</span><b>{r.status === "pending" ? "Waiting on leadership" : `Declined${r.decline_reason ? `: ${r.decline_reason}` : ""}`}</b></li>)}</ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
