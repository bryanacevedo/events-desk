/* The guest's own page (docs/HOSTED.md 6): one link, one column, the date first. It stands outside the desk: no sidebar, no acting-as choice, no write key.
   It reads and answers only through /api/rsvp/:token and shows only what that answers about the guest it names. */

import { useEffect, useState } from "react";
import type { PublicRsvp } from "./api";

type Load = { state: "loading" } | { state: "bad"; message: string } | { state: "ok"; v: PublicRsvp };

const tokenOf = () => decodeURIComponent(location.pathname.split("/")[2] ?? "");
const DAYS = (ymd: string) => {
  const d = new Date(`${ymd}T12:00:00`);
  return { weekday: d.toLocaleDateString("en-GB", { weekday: "long" }), dayMonth: d.toLocaleDateString("en-GB", { day: "numeric", month: "long" }), year: String(d.getFullYear()) };
};
const initialsOf = (name: string) => name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;

async function call(method: "GET" | "POST", body?: unknown): Promise<{ ok: true; v: PublicRsvp } | { ok: false; status: number; error: string }> {
  try {
    const r = await fetch(`/api/rsvp/${encodeURIComponent(tokenOf())}`, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, v: data as PublicRsvp } : { ok: false, status: r.status, error: (data as { error?: string }).error ?? "That did not go through. Try again." };
  } catch {
    return { ok: false, status: 0, error: "The page could not be reached. Check the connection and try again." };
  }
}

export function Rsvp() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [diet, setDiet] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    call("GET").then((r) => {
      if (r.ok) { setLoad({ state: "ok", v: r.v }); setDiet(r.v.guest.dietary); document.title = r.v.event.name; }
      else setLoad({ state: "bad", message: r.error });
    });
  }, []);

  if (load.state === "loading") return <main className="rv" data-ready="1" aria-busy="true" />;
  if (load.state === "bad") {
    const invalid = /not valid/i.test(load.message);
    return (
      <main className="rv rv-page" data-ready="1">
        <header className="rv-head plain"><h1 className="rv-date">{invalid ? "This link is not valid." : load.message}</h1></header>
        <div className="rv-body plain">
          {invalid && <p className="mute">Open the link in your invitation email again, or ask the person who invited you for a new one.</p>}
          <p className="rv-foot">Events Desk</p>
        </div>
      </main>
    );
  }

  const { event: e, guest: g, can_answer, list_open } = load.v;
  const d = DAYS(e.day), host = first(e.host_name || "the host");
  const answer = async (a: "yes" | "no") => {
    setBusy(true); setError("");
    const r = await call("POST", { answer: a, dietary: diet.trim() });
    setBusy(false);
    if (r.ok) { setLoad({ state: "ok", v: r.v }); setDiet(r.v.guest.dietary); } else setError(r.error);
  };
  const saveDiet = () => answer("yes");
  const dietField = (
    <label className="field"><span>Dietary needs<i>Optional</i></span><input className="input" type="text" name="diet" value={diet} maxLength={300} onChange={(ev) => setDiet(ev.target.value)} placeholder="Allergies, vegetarian, halal" autoComplete="off" /></label>
  );
  const s = g.status;
  const yes = s === "registered", wait = s === "waitlist", no = s === "declined";
  const shownAnswer = no ? "No" : yes || wait || s === "attended" || s === "no_show" ? "Yes" : "No answer yet";

  let body: React.ReactNode;
  if (!can_answer) {
    const organizer = /organizer/i.test(load.v.message ?? "");
    body = (
      <section className="rv-ans">
        <h2 className="status">{organizer ? load.v.message : "The list is closed."}</h2>
        {!organizer && (
          <dl className="rv-kept">
            <div><dt>Your answer</dt><dd>{shownAnswer}</dd></div>
            {g.dietary && <div><dt>Dietary needs</dt><dd>{g.dietary}</dd></div>}
          </dl>
        )}
        {!organizer && <p className="mute">To change anything, write to {host}.</p>}
      </section>
    );
  } else if (yes || wait) {
    body = (
      <section className="rv-ans">
        <h2 className="status">{wait ? "The table is full." : "You are on the list."}</h2>
        <p className="said">{wait ? `You are on the waitlist. ${host} will email you if a seat opens.` : "Change your answer any time before the event."}</p>
        <form className="rv-save" onSubmit={(ev) => { ev.preventDefault(); saveDiet(); }}>
          {dietField}
          <button className="btn line" type="submit" disabled={busy}>Save</button>
        </form>
        <div className="rv-answers solo"><button className="btn line" type="button" disabled={busy} onClick={() => answer("no")}>{wait ? "Take me off the waitlist" : "I can't come after all"}</button></div>
        {error && <p role="alert" className="error">{error}</p>}
      </section>
    );
  } else if (no) {
    body = (
      <section className="rv-ans">
        <h2 className="status">You said no.</h2>
        <p className="said">{host} knows not to expect you. Change your answer any time before the event.</p>
        {list_open && <div className="rv-answers solo"><button className="btn" type="button" disabled={busy} onClick={() => answer("yes")}>I can come after all</button></div>}
        {!list_open && load.v.message && <p className="mute">{load.v.message}</p>}
        {error && <p role="alert" className="error">{error}</p>}
      </section>
    );
  } else {
    body = (
      <section className="rv-ans">
        <h2>{first(g.first_name)}, will you come?</h2>
        {list_open ? dietField : load.v.message && <p className="mute">{load.v.message}</p>}
        <div className="rv-answers">
          {list_open && <button className="btn" type="button" disabled={busy} onClick={() => answer("yes")}>Yes, I will come</button>}
          <button className={`btn${list_open ? " line" : ""}`} type="button" disabled={busy} onClick={() => answer("no")}>No, I can't</button>
        </div>
        {error && <p role="alert" className="error">{error}</p>}
      </section>
    );
  }

  return (
    <main className="rv rv-page" data-ready="1">
      <header className="rv-head">
        <p className="rv-event">{e.name}</p>
        <h1 className="rv-date"><span>{d.weekday}</span><span>{d.dayMonth}</span><span className="rv-yr">{d.year}</span></h1>
        <dl className="rv-meta">
          {e.doors_at && <div><dt>Doors</dt><dd>{e.doors_at}</dd></div>}
          {(e.venue_name || e.address) && <div><dt>Place</dt><dd>{e.venue_name && <span>{e.venue_name}{e.address ? "," : ""}</span>}{e.address && <span>{e.venue_name ? " " : ""}{e.address}</span>}</dd></div>}
        </dl>
      </header>
      <div className="rv-body">
        {(e.welcome || e.host_name) && (
          <div className="rv-host">
            {e.host_name && <span className="rv-face" aria-hidden="true">{initialsOf(e.host_name)}</span>}
            <span>{e.welcome}{e.host_name && <span>{e.host_name}</span>}</span>
          </div>
        )}
        {body}
        <p className="rv-foot">Events Desk</p>
      </div>
    </main>
  );
}
