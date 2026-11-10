/* A rep's day, across every event, made to be read on a phone between meetings. It opens like an event does: a tinted header with the day's
   three figures. Then the replies and the meetings as rows on a tray, each one opening in a side sheet with the whole of it. Everything else
   is folded at the bottom. */

import { useEffect, useState } from "react";
import { get } from "./api";
import { useActor } from "./App";
import { Icon } from "./icons";
import { MeetingRows, ObjectSheets, openObject, ReplyRows } from "./Objects";
import { Chevron } from "./Patterns";
import { PersonAvatar } from "./PersonAvatar";
import { eventHref, personHref, To } from "./To";
import { plural } from "./words";

interface Brief { person: string; title: string | null; company: string; tier: number | null; why: string | null; industry: string | null; employees: string | null; owner: string | null; deal: string | null; said: string | null; met_note: string | null }
interface Day {
  replies: { id: string; event_id: string; contact_id: string; connector?: string; thread_url?: string | null; event: string; website: string | null; brand_color: string | null; full_name: string | null; company: string; code: string | null; body: string | null; respond_by: string }[];
  meetings: { id: string; event_id: string; contact_id: string; event: string; website: string | null; brand_color: string | null; scheduled_at: string; full_name: string | null; company: string; location: string | null; brief: Brief | null }[];
  captures: { id: string; event_id: string; contact_id: string | null; event: string; full_name: string | null; company: string | null; note: string; temperature: string }[];
  slots: { id: string; event: string; starts_at: string; location: string }[];
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayKey = (d: Date) => d.toLocaleDateString("en-CA");
/** The most urgent replies show first; the rest are one press away, so thirteen replies still read at a glance. */
const SHOWN = 6;
const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

export function MyDay() {
  const { actor, needs } = useActor();
  // Seat requests still open for this person. Buying the ticket is the approvers' job, so an approval leaves this page.
  const mySeats = (needs?.requests ?? []).filter((r) => r.requester === actor && (r.status === "pending" || r.status === "declined"));
  const [d, setD] = useState<Day | null>(null), [allReplies, setAllReplies] = useState(false);
  const sheet = openObject();
  const load = async () => setD(await get<Day>(`/api/motion/my-day?rep=${encodeURIComponent(actor)}`));
  useEffect(() => { load(); }, [actor]);
  if (!d) return null;
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
          <h2 className="md-h">Answer these first<span>{d.replies.length}</span></h2>
          <ReplyRows rows={(allReplies ? d.replies : d.replies.slice(0, SHOWN))} open={sheet.reply} />
          {d.replies.length > SHOWN && <button type="button" className="xmore" onClick={() => setAllReplies(!allReplies)}>{allReplies ? "Fewer" : `All ${d.replies.length}`}<Chevron /></button>}
        </div>
      )}

      {d.meetings.length > 0 && (
        <div className="m-sec">
          <h2 className="md-h">Your meetings<span>{d.meetings.length}</span></h2>
          <MeetingRows rows={d.meetings} open={sheet.meeting} />
        </div>
      )}

      {!d.replies.length && !d.meetings.length && <p className="md-clear">Nothing waiting on you.</p>}

      {(d.slots.length > 0 || d.captures.length > 0 || mySeats.length > 0) && (
        <div className="folds">
          {d.slots.length > 0 && (
            <details className="fold">
              <summary><Icon.calendar /><span className="fold-t">Free slots</span><span className="fold-peek">{plural(d.slots.length, "slot")}<i>next {when(d.slots[0].starts_at)}</i></span><Chevron /></summary>
              <div className="sl-days">{[...new Set(d.slots.map((x) => dayKey(new Date(x.starts_at))))].map((day) => {
                const mine = d.slots.filter((x) => dayKey(new Date(x.starts_at)) === day);
                return (
                  <div key={day} className="sl-day">
                    <h4>{new Date(mine[0].starts_at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</h4>
                    <p className="sl-line"><span className="sl-rep">{mine[0].event}</span><span className="sl-times">{mine.map((x) => <span key={x.id}>{clock(x.starts_at)}</span>)}</span><span className="mute">{mine[0].location}</span></p>
                  </div>
                );
              })}</div>
            </details>
          )}
          {d.captures.length > 0 && (
            <details className="fold">
              <summary><Icon.people /><span className="fold-t">People you met</span><span className="fold-peek">{d.captures.length}</span><Chevron /></summary>
              <div className="sl-days">{[...new Set(d.captures.map((c) => c.event_id))].map((ev) => {
                const met = d.captures.filter((c) => c.event_id === ev);
                return (
                  <div key={ev} className="sl-day">
                    <h4><To to={eventHref(ev)}>{met[0].event}</To></h4>
                    <ul className="mc-list md-met">{met.map((c) => (
                      <li key={c.id}>
                        <PersonAvatar name={c.full_name ?? "Someone"} size={30} />
                        <span className="mt-who"><To to={c.contact_id ? personHref(c.event_id, c.contact_id, c.full_name) : null}><b>{c.full_name ?? "Someone"}</b></To><span>{c.company}</span></span>
                        <span className="md-note">{c.temperature === "hot" && <b className="md-hot">Hot</b>}{c.note}</span>
                      </li>
                    ))}</ul>
                  </div>
                );
              })}</div>
            </details>
          )}
          {mySeats.length > 0 && (
            <details className="fold">
              <summary><Icon.seats /><span className="fold-t">Your seat requests</span><span className="fold-peek">{`${mySeats.filter((r) => r.status === "pending").length} waiting`}</span><Chevron /></summary>
              <ul className="md-plain">{mySeats.map((r) => <li key={r.id}><span>{r.name}</span><span className="mute">{r.status === "pending" ? "Waiting on leadership" : `Declined${r.decline_reason ? `: ${r.decline_reason}` : ""}`}</span></li>)}</ul>
            </details>
          )}
        </div>
      )}
      <ObjectSheets changed={load} />
    </section>
  );
}
