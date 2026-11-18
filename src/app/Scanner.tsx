/* The Scanner tab of an event (docs/SCANNER.md 10, direction B: the ledger first). The page is the scans: figures by state, the median seconds per rep, the photo reads used, a ledger.
   Setup and the review of near matches each open in a side sheet. The one green button follows the state: Set up scanning, Copy scanner link, Review near matches. */

import { useCallback, useEffect, useState } from "react";
import { get, send } from "./api";
import { useActor } from "./App";
import { NOT_AVAILABLE } from "./access";
import { copyText, Facts, HSheet } from "./Guests";
import { Form } from "./PlanEdit";
import { METHOD_WORDS, STATE_WORDS, type ScanState } from "../shared/scan";
import { num, plural } from "./words";
import { BlockSkeleton } from "./Skeleton";

interface Cfg { qualifiers: { id: string; label: string }[]; notice: { text: string; version: number }; organizer: "swapcard" | null; organizer_ready: boolean; set_up: boolean; can_setup: boolean; setup_refs?: { event_ref: string; exhibitor_ref: string }; mine: number }
interface Row {
  id: string; rep: string; method: keyof typeof METHOD_WORDS; state: ScanState; state_detail: string; temperature: string; name: string | null; company: string | null; scanned_at: string; met: boolean; review: "open" | "same" | "different" | null; seconds: number | null; talk_title?: string | null;
}
interface Review { scan_id: string; rep: string; scan_name: string | null; scan_company: string | null; near_id: string; near_name: string | null; near_company: string | null; near_rep: string | null; why: string }
interface Page { scans: Row[]; counts: Record<string, number>; reviews: Review[]; seconds: { rep: string; n: number; median: number }[]; reads?: { used: number; cap: number }; all: boolean }

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: false });
const FILTERS = [["all", "All"], ["near", "Near match"], ["confirm", "To confirm"], ["lookup", "Waiting for lookup"], ["unplaced", "Not placed"]] as const;
type Filter = (typeof FILTERS)[number][0];
const stateWord = (r: Row) => (r.review === "open" ? "Near match" : r.review === "same" ? "Merged with another scan" : r.state === "failed" && /not know this badge/.test(r.state_detail) ? "Badge not found" : STATE_WORDS[r.state]);
const quiet = (r: Row) => r.review !== "open" && r.state === "placed";
const source = (r: Row) => ((r.method === "badge_code" || r.method === "badge_id" || r.method === "badge_photo") && r.temperature !== "hot" && !r.met ? "Badge scan" : "Conversation");

/** The scanner's address, before the list is delivered: the booth team can open it on a phone as soon as the event has a page. The full Scanner tab (scans, near matches) comes with the delivered list. */
export function ScannerLink({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}/scan/${id}`;
  return (
    <section className="actions" aria-label="Scanner link">
      <a href={link} className="btn line" target="_blank" rel="noopener noreferrer">Open the scanner</a>
      <button type="button" className="btn line" onClick={async () => { if (await copyText(link)) { setCopied(true); setTimeout(() => setCopied(false), 2000); } }}>{copied ? "Copied" : "Copy scanner link"}</button>
      <span className="small mute">Scans are kept on the phone and sent when it has signal.</span>
    </section>
  );
}

export function Scanner({ id, eventName }: { id: string; eventName: string }) {
  const { actor } = useActor();
  const [cfg, setCfg] = useState<Cfg | null>(null), [page, setPage] = useState<Page | null>(null), [filter, setFilter] = useState<Filter>("all"), [all, setAll] = useState(false);
  const [done, setDone] = useState(false), [sheet, setSheet] = useState<"setup" | "review" | null>(null), [copied, setCopied] = useState(false), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [c, p] = await Promise.all([get<Cfg>(`/api/events/${id}/scanner`), get<Page>(`/api/events/${id}/scans`)]);
    setCfg(c); setPage(p); setDone(true);
  }, [id]);
  useEffect(() => { void load(); }, [load, actor]);
  if (!cfg || !page) return <div className="empty" data-ready="1">{done ? NOT_AVAILABLE("The scanner") : <BlockSkeleton label="Loading the scanner." />}</div>;

  const link = `${location.origin}/scan/${id}`;
  const hasTalk = page.scans.some((r) => r.talk_title);
  const rows = page.scans.filter((r) => (filter === "all" ? true : filter === "near" ? r.review === "open" : filter === "confirm" ? r.state === "to_confirm" : filter === "lookup" ? r.state === "lookup_pending" : r.state === "failed" || r.state === "needs_fields"));
  const shown = all ? rows : rows.slice(0, 16);
  const reviews = page.reviews.length, waiting = page.counts.lookup_pending ?? 0, total = page.scans.length;
  const count = (f: Filter) => (f === "all" ? total : f === "near" ? reviews : f === "confirm" ? page.counts.to_confirm ?? 0 : f === "lookup" ? waiting : (page.counts.failed ?? 0) + (page.counts.needs_fields ?? 0));
  const copy = async () => { if (await copyText(link)) { setCopied(true); setTimeout(() => setCopied(false), 2000); } };
  const retry = async () => { setBusy(true); await send("POST", `/api/events/${id}/scans/resolve`, actor, {}); setBusy(false); await load(); };
  const csv = async () => {
    const r = await fetch(`/api/events/${id}/scans.csv`, { headers: { "x-actor": encodeURIComponent(actor) } });
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob()), a = document.createElement("a");
    a.href = url; a.download = `scans-${id}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  // One green button, by what the page is waiting for.
  const primary = !cfg.set_up && cfg.can_setup ? <button type="button" className="btn" onClick={() => setSheet("setup")}>Set up scanning</button>
    : reviews > 0 && page.all ? <button type="button" className="btn" onClick={() => setSheet("review")}>Review {plural(reviews, "near match", "near matches")}</button>
    : waiting > 0 && page.all ? <button type="button" className="btn" disabled={busy} onClick={retry}>Retry lookups</button>
    : <button type="button" className="btn" onClick={copy}>{copied ? "Copied" : "Copy scanner link"}</button>;

  return (
    <section className="sn" aria-label="Scanner" data-ready="1">
      <div className="sn-bar">
        <p className="sn-lede">{total === 0 ? "No scans yet" : <><b>{num(total)}</b> {total === 1 ? "scan" : "scans"}</>}</p>
        <div className="sn-actions">
          {cfg.can_setup && cfg.set_up && <button type="button" className="btn line" onClick={() => setSheet("setup")}>Setup</button>}
          {total > 0 && <button type="button" className="btn line" onClick={csv}>Export CSV</button>}
          {primary}
        </div>
      </div>

      {total === 0 ? (
        <div className="sn-empty">
          <img className="sn-qr" src={`/api/events/${id}/scanner/qr.png`} alt="Code that opens the scanner on a phone" width={170} height={170} />
          <div className="sn-facts">
            <p className="mute">Phone scanner</p><p className="sn-link">{link}</p>
            <dl className="sn-kv">
              <div><dt>Qualifier questions</dt><dd>{cfg.qualifiers.length || "None"}</dd></div>
              <div><dt>Notice</dt><dd>Version {cfg.notice.version}</dd></div>
              <div><dt>Organizer lookup</dt><dd>{cfg.organizer === "swapcard" ? "Swapcard" : "None"}</dd></div>
              <div><dt>Scans</dt><dd>None yet</dd></div>
            </dl>
          </div>
        </div>
      ) : (
        <>
          <div className="sn-figs">
            <div><h3>Scans by state</h3><dl className="figs small">
              <div><dd>{page.counts.placed ?? 0}</dd><dt>placed</dt></div>
              {(page.counts.to_confirm ?? 0) > 0 && <div><dd>{page.counts.to_confirm}</dd><dt>to confirm</dt></div>}
              {waiting > 0 && <div><dd>{waiting}</dd><dt>waiting for lookup</dt></div>}
              {(page.counts.failed ?? 0) + (page.counts.needs_fields ?? 0) > 0 && <div><dd>{(page.counts.failed ?? 0) + (page.counts.needs_fields ?? 0)}</dd><dt>not placed</dt></div>}
            </dl></div>
            {page.all && page.seconds.length > 0 && <div><h3>Median seconds per scan</h3><table className="sn-secs"><tbody>{page.seconds.map((s) => <tr key={s.rep}><th scope="row">{s.rep}</th>{s.n < 5 ? <td colSpan={2} className="mute">under five scans</td> : <><td>{s.median} s</td><td className="mute">{s.n} scans</td></>}</tr>)}</tbody></table></div>}
            {page.reads && <div><h3>Photo reads</h3><dl className="figs small"><div><dd>{page.reads.used}</dd><dt>of {page.reads.cap} used</dt></div></dl></div>}
          </div>
          <div className="seg filters" role="group" aria-label="Show">{FILTERS.filter(([k]) => k === "all" || count(k) > 0 || filter === k).map(([k, label]) => <button type="button" key={k} aria-pressed={filter === k} onClick={() => { setFilter(k); setAll(false); }}>{label}{k !== "all" && <span className="mute"> {count(k)}</span>}{k === "all" && <span className="mute"> {total}</span>}</button>)}</div>
          <div className="sn-scroll"><table className="sn-table">
            <thead><tr><th>Time</th><th>Person</th><th className="co">Company</th><th className="rep">Rep</th><th className="meth">Method</th><th className="src">Source</th>{hasTalk && <th className="co">From the session</th>}<th>Interest</th><th>State</th></tr></thead>
            <tbody>{shown.map((r) => (
              <tr key={r.id}>
                <td>{clock(r.scanned_at)}</td>
                <td className={r.name ? "who" : "mute"}>{r.name ?? "Not yet known"}</td>
                <td className="co mute">{r.company ?? ""}</td>
                <td className="rep">{r.rep}</td>
                <td className="meth mute">{METHOD_WORDS[r.method]}</td>
                <td className="src mute">{source(r)}</td>{hasTalk && <td className="co mute">{r.talk_title ?? ""}</td>}
                <td className={r.temperature === "hot" ? "strong" : ""}>{r.temperature[0].toUpperCase() + r.temperature.slice(1)}</td>
                <td className={quiet(r) ? "mute" : "strong"} title={r.state_detail || undefined}>{stateWord(r)}</td>
              </tr>))}</tbody>
          </table></div>
          <div className="sn-more"><span className="mute">{rows.length > shown.length ? `${shown.length} latest of ${rows.length}` : `${plural(rows.length, "scan")}`}</span>{rows.length > shown.length && <button type="button" className="btn line small" onClick={() => setAll(true)}>Show all {rows.length}</button>}</div>
        </>
      )}

      {sheet === "setup" && <SetupSheet id={id} eventName={eventName} cfg={cfg} link={link} close={() => setSheet(null)} saved={load} />}
      {sheet === "review" && <ReviewSheet id={id} reviews={page.reviews} close={() => setSheet(null)} saved={load} />}
    </section>
  );
}

function SetupSheet({ id, eventName, cfg, link, close, saved }: { id: string; eventName: string; cfg: Cfg; link: string; close: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [q, setQ] = useState<string[]>([0, 1, 2].map((i) => cfg.qualifiers[i]?.label ?? ""));
  const [notice, setNotice] = useState(cfg.notice.text), [org, setOrg] = useState<string>(cfg.organizer ?? ""), [evRef, setEvRef] = useState(cfg.setup_refs?.event_ref ?? ""), [exRef, setExRef] = useState(cfg.setup_refs?.exhibitor_ref ?? "");
  const changed = notice.trim() !== cfg.notice.text;
  return (
    <HSheet label={cfg.set_up ? "Scanner setup" : "Set up scanning"} close={close}>
      <p className="mute">{eventName}</p>
      <Form onCancel={close} saveWord={changed ? `Save as version ${cfg.notice.version + 1}` : "Save"} onSave={async () => {
        const r = await send("PUT", `/api/events/${id}/scanner/settings`, actor, { qualifiers: q.filter((x) => x.trim()).map((label) => ({ label })), notice_text: notice, organizer: org || null, organizer_event_ref: evRef, organizer_exhibitor_ref: exRef });
        if (r.ok) { await saved(); close(); }
        return r;
      }}>
        {q.map((v, i) => <label className="field" key={i}><span>Question {i + 1}{i > 0 ? " (optional)" : ""}</span><input className="input" value={v} maxLength={80} onChange={(e) => setQ(q.map((x, j) => (j === i ? e.target.value : x)))} placeholder={i === 0 ? "Buying this year?" : ""} autoComplete="off" /></label>)}
        <label className="field"><span>Notice, version {cfg.notice.version}</span><textarea className="input" rows={3} maxLength={400} value={notice} onChange={(e) => setNotice(e.target.value)} /></label>
        <label className="field"><span>Organizer lookup</span><select className="input" value={org} onChange={(e) => setOrg(e.target.value)}><option value="">None</option><option value="swapcard">Swapcard</option></select></label>
        {org === "swapcard" && (
          <>
            <label className="field"><span>Event id</span><input className="input" value={evRef} maxLength={200} onChange={(e) => setEvRef(e.target.value)} autoComplete="off" /></label>
            <label className="field"><span>Exhibitor id</span><input className="input" value={exRef} maxLength={200} onChange={(e) => setExRef(e.target.value)} autoComplete="off" /></label>
            <p className="mute">{cfg.organizer_ready ? "Key set." : "Key not set."} A lookup makes a connection on Swapcard&apos;s side, as if the badge was scanned in their app.</p>
          </>
        )}
      </Form>
      <Facts rows={[["Phone scanner", link]]} />
      <img className="sn-qr" src={`/api/events/${id}/scanner/qr.png`} alt="Code that opens the scanner on a phone" width={170} height={170} />
    </HSheet>
  );
}

function ReviewSheet({ id, reviews, close, saved }: { id: string; reviews: Review[]; close: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [busy, setBusy] = useState(""), [error, setError] = useState("");
  const decide = async (scan: string, decision: "same" | "different") => {
    setBusy(scan); setError("");
    const r = await send("POST", `/api/scans/${scan}/review`, actor, { decision });
    setBusy("");
    if (!r.ok) { setError(r.error ?? "Try again."); return; }
    await saved();
    if (reviews.length <= 1) close();
  };
  return (
    <HSheet label="Near matches" close={close}>
      {reviews.map((r) => (
        <section className="sn-review" key={r.scan_id} aria-label={`${r.scan_name} and ${r.near_name}`}>
          <p className="mute">{r.why}</p>
          <div className="sn-pair">
            <div><b>{r.scan_name ?? "Someone"}</b><span>{r.scan_company}</span><span className="mute">Scanned by {r.rep}</span></div>
            <div><b>{r.near_name ?? "Someone"}</b><span>{r.near_company}</span><span className="mute">{r.near_rep ? `Scanned by ${r.near_rep}` : "From the list"}</span></div>
          </div>
          <div className="sn-decide"><button type="button" className="btn line small" disabled={busy === r.scan_id} onClick={() => decide(r.scan_id, "same")}>Same person</button><button type="button" className="btn line small" disabled={busy === r.scan_id} onClick={() => decide(r.scan_id, "different")}>Different people</button></div>
        </section>
      ))}
      {error && <p role="alert" className="error small">{error}</p>}
      {reviews.length === 0 && <p className="mute">Nothing to review.</p>}
    </HSheet>
  );
}
