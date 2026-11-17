/* Choosing: next year's candidates, ranked by the printed rule; which events to repeat, from counts; and the team's target accounts (docs/CHOOSING.md section 11).
   For leadership, GTM Engineering and planners, the same people as Budget and Results. The ranking only orders a list: which to plan is the person's call.
   Status is a word in ink. Every figure is a count or a dollar amount with its kind beside it; there is no blended score. */

import { useEffect, useState, type ReactNode } from "react";
import type { Likely } from "../server/overlap";
import type { candidates } from "../server/ranking";
import type { repeatView } from "../server/repeat";
import { get, send } from "./api";
import { useActor } from "./App";
import { isGtm } from "../shared/roles";
import { ExpandRow, ShowMore } from "./Patterns";
import { Form } from "./PlanEdit";
import { CHOOSING_FAILED, NO_FILES } from "./access";
import { money, num, plural, shortDate } from "./words";
import { PageSkeleton, Empty } from "./Skeleton";

type Cands = Awaited<ReturnType<typeof candidates>>;
type Cand = Cands["candidates"][number];
type Repeat = Awaited<ReturnType<typeof repeatView>>;
type LastImport = { actor: string; row_count: number; added: number; updated: number; skipped: { row: number; why: string }[]; created_at: string };
type Targets = { total: number; by_source: Record<string, number>; last_import?: LastImport | null };

const SOURCE_WORDS: Record<string, string> = { upload: "Uploaded", manual: "Added by hand", crm: "From the CRM", market_desk: "From Market Desk" };
const KIND_WORDS: Record<string, string> = { page: "Named on a page", past: "On an earlier list", captured: "People already captured" };
const PAGE_WORDS: Record<string, string> = { speaker: "Speaker page", sponsor: "Sponsor page" };
const VS_WORDS: Record<string, string> = { above: "above the median", below: "below the median", same: "at the median" };
const GROUP_WORDS: Record<number, string> = { 1: "Last time below the median", 2: "Declined" };
const READING_WORDS: Record<string, string> = { passes: "Passes", no_clear_difference: "No clear difference", too_few: "Too few to say" };

const statusOf = (c: Cand) => (!c.event ? "No plan yet" : c.event.stage === "declined" || c.event.decline_reason ? "Declined" : c.event.plan_stage === "planning" ? "Planning" : "Approved");
const callWords = (d: { decision: string; reason: string | null }) => `${d.decision === "repeat" ? "Repeat" : "Drop"}${d.reason ? `: ${d.reason}` : ""}`;
const chance = (p: number) => (p < 0.0001 ? "under 0.0001" : p.toFixed(p < 0.01 ? 4 : 2));

/** A figure with its one-word label beneath, the way the rest of the desk lays figures out. */
function Fig({ n, w, mute = false }: { n: ReactNode; w: string; mute?: boolean }) {
  return <span className={`ch-fig${mute ? " thin" : ""}`}><b>{n}</b><span>{w}</span></span>;
}

/* ------------------------------------------------------------------ one candidate, opened */

function AddPage({ id, done }: { id: string; done: () => Promise<void> }) {
  const { actor } = useActor();
  const [open, setOpen] = useState(false), [kind, setKind] = useState("sponsor"), [text, setText] = useState(""), [file, setFile] = useState("");
  if (!open) return <div className="pl-edit-row"><button type="button" className="btn line small" onClick={() => setOpen(true)}>Add a page</button></div>;
  const read = async (f: File | undefined) => { if (!f) return; setText(await f.text()); setFile(f.name); };
  return (
    <Form saveWord="Add the page" ready={text.trim() !== ""} onCancel={() => { setOpen(false); setText(""); setFile(""); }} onSave={async () => {
      const r = await send("POST", `/api/choosing/${id}/pages`, actor, { kind, input: file ? "uploaded" : "pasted", filename: file || null, text });
      if (r.ok) { await done(); setOpen(false); setText(""); setFile(""); }
      return r;
    }}>
      <label className="field"><span>Kind of page</span>
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}><option value="sponsor">Sponsor page</option><option value="speaker">Speaker page</option></select>
      </label>
      <label className="field"><span>Paste the text of the page</span><textarea className="input itext" rows={5} value={text} onChange={(e) => { setText(e.target.value); setFile(""); }} /></label>
      <label className="btn line small ch-file">{file ? file : "Choose a file"}<input className="sr-only" type="file" accept=".txt,.csv,.html,.htm,text/plain,text/csv,text/html" aria-label="Choose a file" onChange={(e) => { void read(e.target.files?.[0]); e.target.value = ""; }} /></label>
    </Form>
  );
}

function RejectBox({ matchId, done, close }: { matchId: string; done: () => Promise<void>; close: () => void }) {
  const { actor } = useActor();
  const [why, setWhy] = useState("");
  return (
    <Form saveWord="Reject the match" ready={why.trim().length >= 3} onCancel={close} onSave={async () => {
      const r = await send("POST", `/api/choosing/matches/${matchId}/reject`, actor, { reason: why });
      if (r.ok) { await done(); close(); }
      return r;
    }}>
      <label className="field"><span>Why this match is wrong</span><textarea className="input itext" rows={2} maxLength={300} value={why} onChange={(e) => setWhy(e.target.value)} autoFocus /></label>
    </Form>
  );
}

function Pages({ id, likely, reload }: { id: string; likely: Likely; reload: () => Promise<void> }) {
  const { actor } = useActor();
  const [rejecting, setRejecting] = useState<string | null>(null), [error, setError] = useState("");
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => { setError(""); const r = await fn(); if (!r.ok) setError(r.error ?? ""); else await reload(); };
  return (
    <>
      {likely.pages.length > 0 && (
        <ul className="ch-pages">{likely.pages.map((pg) => (
          <li key={pg.id}>
            <div className="pl-row ch-page">
              <span className="pl-what"><b>{PAGE_WORDS[pg.kind] ?? pg.kind}</b><span>{[pg.filename ?? "Pasted", pg.added_by].join(", ")}</span></span>
              <span className="pl-end"><button type="button" className="btn line small" onClick={() => act(() => send("DELETE", `/api/choosing/pages/${pg.id}`, actor))} aria-label={`Remove the ${PAGE_WORDS[pg.kind]?.toLowerCase() ?? "page"} ${pg.filename ?? ""}`.trim()}>Remove</button></span>
            </div>
            <ul className="ch-matches">{pg.matches.map((m) => (
              <li key={m.id} className="ch-match">
                <span className="pl-what"><b>{m.name}</b><span className={m.status === "rejected" ? "ch-struck" : ""}>{m.quote}</span>{m.status === "rejected" && <span>Rejected: {m.rejected_reason}</span>}</span>
                <span className="pl-end">{m.status === "rejected"
                  ? <button type="button" className="btn line small" onClick={() => act(() => send("POST", `/api/choosing/matches/${m.id}/restore`, actor))} aria-label={`Restore ${m.name}`}>Restore</button>
                  : <button type="button" className="btn line small" onClick={() => setRejecting(rejecting === m.id ? null : m.id)} aria-label={`Reject ${m.name}`}>Reject</button>}</span>
                {rejecting === m.id && <div className="ch-reject"><RejectBox matchId={m.id} done={reload} close={() => setRejecting(null)} /></div>}
              </li>
            ))}</ul>
          </li>
        ))}</ul>
      )}
      {error && <p role="alert" className="error small">{error}</p>}
      <AddPage id={id} done={reload} />
    </>
  );
}

function CandidateBody({ c, reload, version }: { c: Cand; reload: () => Promise<void>; version: number }) {
  const [likely, setLikely] = useState<Likely | null>(null), [all, setAll] = useState(false);
  const load = async () => { setLikely(await get<Likely>(`/api/choosing/${c.catalog_id}/likely`)); };
  useEffect(() => { void load(); }, [c.catalog_id, version]);
  const again = async () => { await load(); await reload(); };
  const accounts = likely?.accounts ?? [];
  const shown = all ? accounts : accounts.slice(0, 8);
  return (
    <div className="ch-body">
      {c.reasons.length > 0 && <ul className="pl-rows ch-reasons" aria-label="Reasons">{c.reasons.map((r) => <li key={r} className="pl-row"><span className="pl-what"><b>{r}</b></span></li>)}</ul>}
      <h3 className="pl-h3">Target accounts likely there</h3>
      {likely && accounts.length === 0 && <p className="mute">None found yet.</p>}
      {shown.length > 0 && (
        <ul className="pl-rows">{shown.map((a) => (
          <li key={a.account_id} className="pl-row">
            <span className="pl-what"><b>{a.name}</b><span>{a.kinds.map((k) => k === "past" && a.past.length ? `On the ${a.past[0].name} list` : k === "captured" && a.captured ? `${num(a.captured.people)} ${a.captured.people === 1 ? "person" : "people"} already captured` : KIND_WORDS[k]).join(", ")}</span></span>
            <span className="pl-mid">{a.owner ?? "No owner"}</span>
            <span className="pl-end">{a.deal_stage ? a.deal_stage.replace(/_/g, " ") : ""}</span>
          </li>
        ))}</ul>
      )}
      {accounts.length > 8 && <ShowMore open={all} n={accounts.length} onClick={() => setAll(!all)} />}
      <h3 className="pl-h3">Pages</h3>
      {likely ? <Pages id={c.catalog_id} likely={likely} reload={again} /> : null}
      {likely && likely.pages.length === 0 && <p className="mute">No page added yet.</p>}
      {c.ours_last && <dl className="pl-figs" aria-label="Your call"><div><dd>{c.ours_last.decision === "repeat" ? "Repeat" : "Drop"}</dd><dt>{[c.ours_last.decided_by, c.ours_last.reason].filter(Boolean).join(": ")}</dt></div></dl>}
    </div>
  );
}

function CandidateRow({ c, rank, reload, version }: { c: Cand; rank: number; reload: () => Promise<void>; version: number }) {
  const [seen, setSeen] = useState(false);
  const status = statusOf(c), note = status === "Declined" && c.event?.decline_reason ? c.event.decline_reason : c.ours_last ? callWords(c.ours_last) : "";
  return (
    <ExpandRow className="ch-row" label={`${c.name}, number ${rank}`} onToggle={(o) => { if (o) setSeen(true); }} head={
      <>
        <span className="ch-rank">{rank}</span>
        <span className="ch-what"><b>{c.name}</b><span>{[shortDate(c.starts_on), c.city].filter(Boolean).join(" · ")}</span></span>
        <span className="ch-figs">
          <Fig n={num(c.likely.accounts)} w="target accounts" mute={c.likely.accounts === 0} />
          <Fig n={c.cost.cents ? money(c.cost.cents) : "None"} w={c.cost.cents ? c.cost.words : "cost not known"} mute={!c.cost.cents} />
          {c.past ? <Fig n={`${num(c.past.held)} held`} w={`${c.past.year}${c.vs_median ? `, ${VS_WORDS[c.vs_median]}` : ""}`} /> : <Fig n="None" w="no past edition" mute />}
        </span>
        <span className="ch-status"><b>{status}</b>{note && <span>{note}</span>}</span>
      </>
    }>
      {seen && <CandidateBody c={c} reload={reload} version={version} />}
    </ExpandRow>
  );
}

function Candidates({ data, reload, version }: { data: Cands; reload: () => Promise<void>; version: number }) {
  const [how, setHow] = useState(false);
  return (
    <div className="rs-sec">
      <h3 className="rs-h">Next year's candidates<span>{data.candidates.length}</span></h3>
      {data.candidates.length === 0 ? <p className="mute">No conference starts in the next year.</p> : (
        <>
          <button type="button" className="xmore ch-how" aria-expanded={how} onClick={() => setHow(!how)}>How this is ordered</button>
          {how && <ul className="ch-order">{data.how_ordered.map((l) => <li key={l}>{l}</li>)}</ul>}
          <div className="ch-list">
            {data.candidates.map((c, i) => (
              <div key={c.catalog_id}>
                {c.group !== (data.candidates[i - 1]?.group ?? 0) && GROUP_WORDS[c.group] && <h4 className="ch-group">{GROUP_WORDS[c.group]}</h4>}
                <CandidateRow c={c} rank={i + 1} reload={reload} version={version} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ which events to repeat */

function DecisionBox({ s, reload }: { s: Repeat["series"][number]; reload: () => Promise<void> }) {
  const { actor } = useActor();
  const [open, setOpen] = useState(false), [d, setD] = useState<"repeat" | "drop">("repeat"), [why, setWhy] = useState("");
  if (!open) return <div className="pl-edit-row"><button type="button" className="btn line small" onClick={() => setOpen(true)}>{s.current ? "Change the call" : "Repeat or drop"}</button></div>;
  return (
    <Form saveWord="Save" ready={d === "repeat" || why.trim().length >= 3} onCancel={() => { setOpen(false); setWhy(""); }} onSave={async () => {
      const r = await send("POST", "/api/choosing/repeat/decisions", actor, { series_key: s.series_key, decision: d, reason: why });
      if (r.ok) { await reload(); setOpen(false); setWhy(""); }
      return r;
    }}>
      <div className="seg" role="group" aria-label="Repeat or drop">
        {(["repeat", "drop"] as const).map((k) => <button key={k} type="button" aria-pressed={d === k} onClick={() => setD(k)}>{k === "repeat" ? "Repeat" : "Drop"}</button>)}
      </div>
      <label className="field"><span>{d === "drop" ? "Why drop it" : "Why repeat it, if you want to say"}</span><textarea className="input itext" rows={2} maxLength={300} value={why} onChange={(e) => setWhy(e.target.value)} /></label>
    </Form>
  );
}

function LinkSeries({ reload }: { reload: () => Promise<void> }) {
  const { actor } = useActor();
  const [open, setOpen] = useState(false), [name, setName] = useState(""), [same, setSame] = useState(""), [why, setWhy] = useState("");
  if (!open) return <div className="pl-edit-row"><button type="button" className="btn line small" onClick={() => setOpen(true)}>Link a renamed conference</button></div>;
  return (
    <Form saveWord="Link them" ready={name.trim() !== "" && same.trim() !== "" && why.trim() !== ""} onCancel={() => setOpen(false)} onSave={async () => {
      const r = await send("POST", "/api/choosing/series-links", actor, { name, same_as: same, reason: why });
      if (r.ok) { await reload(); setOpen(false); setName(""); setSame(""); setWhy(""); }
      return r;
    }}>
      <div className="pl-edit-grid">
        <label className="field"><span>Later name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="SaaStr Annual 2027" /></label>
        <label className="field"><span>Earlier name</span><input className="input" value={same} onChange={(e) => setSame(e.target.value)} placeholder="SaaStr AI Annual 2026" /></label>
      </div>
      <label className="field"><span>Why they are one conference</span><input className="input" value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} /></label>
    </Form>
  );
}

function Repeats({ data, lead, reload }: { data: Repeat; lead: boolean; reload: () => Promise<void> }) {
  const { actor } = useActor();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const passing = data.patterns.filter((p) => p.passes);
  const word = async () => { setBusy(true); setError(""); const r = await send("POST", "/api/choosing/repeat/word", actor); setBusy(false); if (!r.ok) setError(r.error); else await reload(); };
  const rule = data.rule;
  return (
    <div className="rs-sec">
      <h3 className="rs-h">Which events to repeat</h3>

      {data.series.length === 0 ? <p className="mute">No past event has a written scorecard yet.</p> : (
        <div className="ch-series">{data.series.map((s) => (
          <ExpandRow key={s.series_key} className="ch-srow" label={s.name} head={
            <>
              <span className="ch-what"><b>{s.name}</b><span>{s.words}</span></span>
              <span className="ch-status"><b>{s.current ? (s.current.decision === "repeat" ? "Repeat" : "Drop") : "No call yet"}</b>{s.current?.reason && <span>{s.current.reason}</span>}</span>
            </>
          }>
            <div className="ch-body">
              {s.editions.length > 0 && (
                <ul className="pl-rows">{s.editions.map((e) => (
                  <li key={e.id} className="pl-row">
                    <span className="pl-what"><b>{e.name}</b></span>
                    <span className="pl-mid">{e.goal !== null ? `${num(e.held)} of ${num(e.goal)} held` : `${num(e.held)} held, no goal`}</span>
                    <span className="pl-end">{[e.cost_cents ? money(e.cost_cents) : "", e.held_per_thousand !== null ? `${e.held_per_thousand} per $1,000` : ""].filter(Boolean).join(", ")}</span>
                  </li>
                ))}</ul>
              )}
              {s.current && <p className="mute">{s.current.decided_by}{s.current.reason ? `: ${s.current.reason}` : ""}</p>}
              {lead && <DecisionBox s={s} reload={reload} />}
            </div>
          </ExpandRow>
        ))}</div>
      )}
      <LinkSeries reload={reload} />

      {data.total > 0 && (
        <>
          <dl className="pl-figs ch-rule" aria-label="The rule">
            <div><dd>{num(data.total)}</dd><dt>past events with a goal</dt></div>
            {data.no_goal > 0 && <div><dd>{num(data.no_goal)}</dd><dt>had no goal</dt></div>}
            <div><dd>{num(data.pairs)}</dd><dt>groups compared</dt></div>
            {data.pairs > 0 && <div><dd>{chance(data.alpha_each ?? rule.alpha)}</dd><dt>chance of luck allowed each, {rule.alpha} split by the groups compared</dt></div>}
            <div><dd>{rule.min_events}</dd><dt>events needed each side</dt></div>
            <div><dd>{rule.min_goal_met}</dd><dt>met their goal to pass</dt></div>
          </dl>
          <div className="pl-bt ch-pt" role="table" aria-label="Patterns">
            <div className="pl-bt-row pl-bt-head" role="row"><span role="columnheader">Group</span><span role="columnheader">Met their goal</span><span role="columnheader">Elsewhere</span><span role="columnheader">Reading</span></div>
            {data.patterns.map((p) => (
              <div className="pl-bt-row" role="row" key={p.key}>
                <span role="rowheader"><b>{p.label}</b></span>
                <span role="cell" data-col="Met their goal">{p.k} of {p.n_in}</span>
                <span role="cell" data-col="Elsewhere">{p.k_out} of {p.n_out}</span>
                <span role="cell" data-col="Reading" className={p.passes ? "pl-strong" : ""}>{READING_WORDS[p.status]}{p.p !== null ? `, chance of luck ${chance(p.p)}` : ""}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {data.total === 0 && data.series.length > 0 && <p className="mute">No past event has a goal and a written scorecard yet.</p>}

      {passing.length > 0 && (
        <div className="ch-words">
          {passing.map((p) => {
            const w = data.wordings[p.key];
            return (
              <p key={p.key} className="ch-word"><span>{w.text}</span><span className="mute small">{w.by === "model" ? `Worded by ${w.model ?? "the model"}, checked against the counts` : "Worded by the desk's template, no model"}</span></p>
            );
          })}
          <div className="pl-edit-row"><button type="button" className="btn line small" disabled={busy} onClick={word}>{busy ? "Wording…" : "Word the patterns"}</button></div>
          {error && <p role="alert" className="error small">{error}</p>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ target accounts */

/** The last import, kept on the desk: what it added, updated and left out, and why, for whoever opens the page next. */
function LastImportResult({ last }: { last: LastImport }) {
  const why = new Map<string, number>();
  for (const s of last.skipped) why.set(s.why, (why.get(s.why) ?? 0) + 1);
  return (
    <div className="ch-last" aria-label="Last import">
      <p className="small mute">Last import: {last.actor}, {new Date(last.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, {plural(last.row_count, "row")}</p>
      <dl className="pl-figs"><div><dd>{num(last.added)}</dd><dt>added</dt></div><div><dd>{num(last.updated)}</dd><dt>updated</dt></div>{last.skipped.length > 0 && <div><dd>{num(last.skipped.length)}</dd><dt>skipped</dt></div>}</dl>
      {why.size > 0 && <ul className="reasons" aria-label="Rows skipped">{[...why].map(([w, n]) => <li key={w}><b>{num(n)}</b><span>{w}</span></li>)}</ul>}
    </div>
  );
}

function TargetAccounts({ data, reload }: { data: Targets; reload: () => Promise<void> }) {
  const { actor, sample } = useActor();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setError("");
    const r = await send<{ added: number; updated: number; skipped: unknown[] }>("POST", "/api/target-accounts/import", actor, { text: await f.text() });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    await reload();
  };
  const last = data.last_import;
  const sources = Object.entries(data.by_source).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rs-sec">
      <h3 className="rs-h">Target accounts</h3>
      {data.total === 0 ? <Empty what="The companies the team most wants to meet. Choosing matches them against each event." example="Lumen Ledger, lumenledger.example, owner Maya Ortiz." /> : (
        <dl className="pl-figs" aria-label="Target accounts">
          <div><dd>{num(data.total)}</dd><dt>target accounts{sources.length === 1 ? `, ${(SOURCE_WORDS[sources[0][0]] ?? sources[0][0]).toLowerCase()}` : ""}</dt></div>
          {sources.length > 1 && sources.map(([k, n]) => <div key={k}><dd>{num(n)}</dd><dt>{(SOURCE_WORDS[k] ?? k).toLowerCase()}</dt></div>)}
        </dl>
      )}
      <div className="pl-edit-row">
        <label className="btn line small" title={sample.publicDemo ? NO_FILES : undefined}>{busy ? "Reading the file…" : "Upload a CSV"}<input className="sr-only" type="file" accept=".csv,text/csv" aria-label="Upload a CSV of target accounts" disabled={busy} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} /></label>
      </div>
      {last && <LastImportResult last={last} />}
      {error && <p role="alert" className="error small">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ the page */

export function Choosing({ go: _go }: { go: (to: string) => void }) {
  const { actor, needs } = useActor();
  const [cands, setCands] = useState<Cands | null>(null), [rep, setRep] = useState<Repeat | null>(null), [targets, setTargets] = useState<Targets | null>(null);
  const [ready, setReady] = useState(false), [listVersion, setListVersion] = useState(0);
  const lead = Boolean(needs?.approvers.includes(actor)) || isGtm(actor);
  const loadCands = async () => { setCands(await get<Cands>("/api/choosing")); };
  const loadRep = async () => { setRep(await get<Repeat>("/api/choosing/repeat")); };
  const loadTargets = async () => { setTargets(await get<Targets>("/api/target-accounts")); };
  const loadAll = async () => { await Promise.all([loadCands(), loadRep(), loadTargets()]); setReady(true); };
  useEffect(() => { void loadAll(); }, [actor]);
  if (!ready) return <PageSkeleton />;
  return (
    <section className="choosing" data-ready="1">
      <header className="hero"><div><h1>Choosing</h1></div></header>
      {cands && <Candidates data={cands} version={listVersion} reload={async () => { await Promise.all([loadCands(), loadRep()]); }} />}
      {rep && <Repeats data={rep} lead={lead} reload={async () => { await Promise.all([loadRep(), loadCands()]); }} />}
      {targets && <TargetAccounts data={targets} reload={async () => { await Promise.all([loadTargets(), loadCands()]); setListVersion((v) => v + 1); }} />}
      {!cands && !rep && !targets && <p className="md-clear">{CHOOSING_FAILED}</p>}
    </section>
  );
}
