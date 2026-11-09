/* The ICP compile steps, opened from Settings after an upload:

     upload or paste a document  ->  see the cost and start the read  ->  confirm the rules against the document (the document with
     its quoted passages marked on the left, the rules in trays on the right, what it never says asked first)
     ->  test them on companies you already know  ->  publish as a version.

   Where you are is the five-part tracker from the event page. Every rule quotes the passage it came from; nothing is used for tiering until published. */

import { Chevron } from "./Patterns";
import { Icon } from "./icons";
import { useEffect, useState, type CSSProperties } from "react";
import type { getCompile, icpOverview, RuleLine } from "../server/icp";
import { get, send } from "./api";
import { useActor } from "./App";
import { plural } from "./words";

type Compile = Awaited<ReturnType<typeof getCompile>>;
type Overview = Awaited<ReturnType<typeof icpOverview>>;
type Go = (to: string) => void;

const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const cents = (c: number) => `${(c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}`;
const GROUPS: [RuleLine["group"], string][] = [["rules", "Who fits"], ["people", "Who we talk to"], ["lists", "Never contact, and customers"], ["examples", "Companies we know"]];
const STEPS = ["Upload", "Read", "Confirm", "Test", "Publish"];

/* --------------------------------------------------------------- the tracker */

/** The same five-part tracker as the event page: the step it is on lit, with one short caption under it. */
function IcpStages({ at, caption }: { at: number; caption?: string }) {
  return (
    <ol className="stages istages" aria-label="Step">
      {STEPS.map((label, i) => {
        const state = i < at ? "done" : i === at ? "now" : "next";
        return (
          <li key={label} className={state} aria-current={state === "now" ? "step" : undefined} style={{ "--s": i } as CSSProperties}>
            <span className="st-bar" aria-hidden="true"><i /></span>
            <span className="st-label">{state === "done" && <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3 7.4 2.7 2.7L11 4.4" /></svg>}{label}</span>
            {state === "now" && caption && <span className="st-who">{caption}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** The head of every step: the tracker, a short title on the left, one large figure with a plain label on the right. */
function Head({ at, caption, title, fig, label }: { at: number; caption?: string; title: string; fig?: string; label?: string }) {
  return (
    <header className="ihead" data-ready="1">
      <IcpStages at={at} caption={caption} />
      <div className="ihead-row">
        <h1 className="display">{title}</h1>
        {fig && <span className="ifig"><b>{fig}</b><span>{label}</span></span>}
      </div>
    </header>
  );
}

/** A titled tray of rows, the same container Settings and the Overview use. */
function Tray({ title, n, children }: { title: string; n?: number; children: React.ReactNode }) {
  return <div className="tray"><h3><b>{title}</b>{n !== undefined && <span>{n}</span>}</h3>{children}</div>;
}

/** The document, every quoted passage marked. */
function Doc({ c, parts }: { c: Compile; parts?: React.ReactNode[] }) {
  return (
    <section className="idoc" aria-label="Your document">
      <h3 className="small mute">{c.filename}, {c.uploaded_by}, {when(c.created_at)}</h3>
      <div className="idoc-text">{parts ?? c.document}</div>
    </section>
  );
}

/* ------------------------------------------------------------- one compile */

export function CompileFlow({ id, go }: { id: string; go: Go }) {
  const { actor } = useActor();
  const [c, setC] = useState<Compile | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async () => setC((await get<Compile>(`/api/icp/compiles/${id}`)) ?? null);
  useEffect(() => { load(); }, [id]);
  if (c === undefined) return null;
  const back = <button className="btn line small" type="button" onClick={() => go("/settings")}>Back to Settings</button>;
  if (c === null) return <div className="empty iempty" data-ready="1"><p>No such compile.</p>{back}</div>;

  const call = async (method: "POST" | "PATCH" | "PUT", path: string, body?: unknown) => {
    setBusy(true); setError("");
    const r = await send<Compile>(method as "POST", `/api/icp/compiles/${id}${path}`, actor, body);
    setBusy(false);
    if (r.ok) { setC(r.data); return r.data; }
    setError(r.error); return null;
  };
  const version = (c.base_version ?? 0) + 1;

  if (c.status === "published") {
    return (
      <>
        <Head at={5} title={`Version ${c.version} published`} />
        <div className="actions"><button className="btn" type="button" onClick={() => go("/settings")}>See the published ICP</button></div>
      </>
    );
  }
  if (c.status === "cancelled") return <div className="empty iempty" data-ready="1"><p>This draft was thrown away.</p>{back}</div>;

  if (c.status === "estimated" || c.status === "failed") {
    const left = c.llm_cap - c.llm_calls;
    return (
      <>
        <Head at={1} caption={c.filename} title="Read the document" fig={cents(c.estimate.cents)} label="at most" />
        {c.error && <p role="alert" className="error">{c.error}</p>}
        <div className="actions">
          <button className="btn" type="button" disabled={busy || left <= 0} onClick={() => call("POST", "/start", { accepted_cents: c.estimate.cents })}>{busy ? "Reading…" : "Read it"}</button>
          <button className="textlink" type="button" disabled={busy} onClick={async () => { await call("POST", "/cancel"); go("/settings"); }}>Cancel</button>
        </div>
        {error && <p role="alert" className="error">{error}</p>}
        <Doc c={c} />
      </>
    );
  }
  if (c.status === "drafted") return <Confirm c={c} version={version} busy={busy} error={error} call={call} go={go} />;
  return <Test c={c} version={version} busy={busy} error={error} call={call} go={go} />;
}

type Call = (method: "POST" | "PATCH" | "PUT", path: string, body?: unknown) => Promise<Compile | null>;
interface FlowProps { c: Compile; version: number; busy: boolean; error: string; call: Call; go: Go }

/* ------------------------------------------------------------- confirm: the drawn screen */

const GROUP_ICONS = [<Icon.target />, <Icon.people />, <Icon.check />, <Icon.grid />];

function Confirm({ c, version, busy, error, call, go }: FlowProps) {
  const lines = c.lines;
  const gaps = c.gaps;
  const spans = c.spans;
  // The document with the quoted passages marked, in order.
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const sp of spans) {
    if (sp.start > at) parts.push(c.document.slice(at, sp.start));
    parts.push(<mark key={sp.key} title={`Rule ${sp.n}`}>{c.document.slice(sp.start, sp.end)}</mark>);
    at = sp.end;
  }
  parts.push(c.document.slice(at));

  const edit = (e: unknown) => call("PATCH", "/draft", e);
  const numbered = new Map(lines.map((l, i) => [l.key, i + 1]));
  return (
    <>
      <Head at={2} caption={gaps.length ? `${gaps.length} to answer` : plural(lines.length, "rule")} title="Confirm the rules" fig={String(gaps.length || lines.length)} label={gaps.length ? "to answer" : lines.length === 1 ? "rule" : "rules"} />

      {c.notices.length > 0 && (
        <Tray title="Read as text, not as orders" n={c.notices.length}>
          {c.notices.map((n, i) => <div className="rrule plain" key={i}><q>{n}</q></div>)}
        </Tray>
      )}

      <div className="iconfirm-col">
        {gaps.length > 0 && (
          <Tray title="To answer" n={gaps.length}>
            {gaps.map((g) => (
              <div className="rrule gap" key={g.id}>
                <span className="k gap" aria-hidden="true">?</span>
                <div className="rbody">
                  <p className="what">{g.text}</p>
                  <p className="small mute">{g.ask}</p>
                  <GapForm gap={g} edit={edit} busy={busy} c={c} />
                </div>
              </div>
            ))}
          </Tray>
        )}

        <div className="folds">
          {GROUPS.map(([group, title], gi) => {
            const mine = lines.filter((l) => l.group === group);
            if (!mine.length) return null;
            const flagged = mine.filter((l) => l.unsupported).length;
            return (
              <details className="fold" key={group} open={flagged > 0}>
                <summary>{GROUP_ICONS[gi]}<span className="fold-t">{title}</span><span className="fold-peek">{flagged > 0 && <i>{flagged} not in your document</i>}{mine.length}</span><Chevron /></summary>
                <div className="frules">
                  {mine.map((l) => (
                    <div className={`rrule${l.unsupported ? " gap" : ""}`} key={l.key} title={l.quote ?? undefined}>
                      <span className={`k${l.unsupported ? " gap" : ""}`} aria-hidden="true">{l.unsupported ? "?" : numbered.get(l.key)}</span>
                      <div className="rbody"><p className="what">{l.what}</p></div>
                      <div className="racts">
                        {l.section === "size" && <SizeEdit c={c} edit={edit} busy={busy} />}
                        {l.section !== "size" && l.section !== "summary" && <button className="textlink" type="button" disabled={busy} onClick={() => edit({ op: "remove", section: l.section, id: l.id })}>Remove</button>}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            );
          })}
          {c.base_version !== null && c.diff && !c.diff.same && (
            <details className="fold">
              <summary><Icon.history /><span className="fold-t">Changes from version {c.base_version}</span><span className="fold-peek">{c.diff.changes.length}</span><Chevron /></summary>
              <div className="frules">{c.diff.changes.map((d, i) => <div className={`rrule plain dk-${d.kind}`} key={i}><span className="rkind">{d.kind}</span><p>{d.text}</p></div>)}</div>
            </details>
          )}
          <details className="fold">
            <summary><Icon.lists /><span className="fold-t">Your document</span><span className="fold-peek">{c.filename}</span><Chevron /></summary>
            <div className="fdoc"><Doc c={c} parts={parts} /></div>
          </details>
        </div>

        <div className="actions iconfirm">
          <button className="btn" type="button" disabled={busy || gaps.length > 0} onClick={() => call("POST", "/confirm")}>{busy ? "Saving…" : `Confirm ${plural(lines.length, "rule")}`}</button>
          <button className="textlink" type="button" disabled={busy} onClick={async () => { await call("POST", "/cancel"); go("/settings"); }}>Throw this draft away</button>
          {c.base_version !== null && c.diff?.same && <span className="small mute">Same as version {c.base_version}</span>}
        </div>
        {error && <p role="alert" className="error">{error}</p>}
      </div>
    </>
  );
}

function SizeEdit({ c, edit, busy }: { c: Compile; edit: (e: unknown) => Promise<Compile | null>; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [min, setMin] = useState(String(c.draft?.size?.min ?? 200));
  const [max, setMax] = useState(String(c.draft?.size?.max ?? 5000));
  if (!open) return <button className="textlink" type="button" onClick={() => setOpen(true)}>Change the range</button>;
  return (
    <span className="iinline">
      <label className="field"><span>Fewest employees</span><input className="input" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} /></label>
      <label className="field"><span>Most employees</span><input className="input" inputMode="numeric" value={max} onChange={(e) => setMax(e.target.value)} /></label>
      <div className="actions">
        <button className="btn small" type="button" disabled={busy} onClick={async () => { await edit({ op: "update", section: "size", id: "size", fields: { min: Number(min), max: Number(max) } }); setOpen(false); }}>Save range</button>
        <button className="textlink" type="button" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </span>
  );
}

/** One answer to one gap. Each kind asks for what it needs in plain text, and every one can be answered with "that is fine". */
function GapForm({ gap, edit, busy, c }: { gap: Compile["gaps"][number]; edit: (e: unknown) => Promise<Compile | null>; busy: boolean; c: Compile }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  void c;
  const answer = (answer: Record<string, unknown>) => edit({ op: "answer_gap", gap: gap.id, answer });
  const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (gap.kind === "unsupported") {
    const [, section, id] = gap.id.split(":");
    return <div className="actions iact"><button className="btn small line" type="button" disabled={busy} onClick={() => edit({ op: "resolve_unsupported", section, id, action: "keep" })}>Keep it as my rule</button><button className="textlink" type="button" disabled={busy} onClick={() => edit({ op: "resolve_unsupported", section, id, action: "remove" })}>Remove it</button></div>;
  }
  if (gap.kind === "employee_range") return (
    <div className="iinline">
      <label className="field"><span>Fewest employees</span><input className="input" inputMode="numeric" value={a} onChange={(e) => setA(e.target.value)} /></label>
      <label className="field"><span>Most employees</span><input className="input" inputMode="numeric" value={b} onChange={(e) => setB(e.target.value)} /></label>
      <div className="actions">
        <button className="btn small" type="button" disabled={busy || !a || !b} onClick={() => answer({ min: Number(a), max: Number(b) })}>Set the range</button>
        <button className="textlink" type="button" disabled={busy} onClick={() => answer({ accept: true })}>Size does not matter</button>
      </div>
    </div>
  );
  if (gap.kind === "region") return (
    <div className="iinline">
      <label className="field"><span>Countries, one per line</span><textarea className="input itext" rows={3} value={a} onChange={(e) => setA(e.target.value)} /></label>
      <div className="actions">
        <button className="btn small" type="button" disabled={busy || !a.trim()} onClick={() => answer({ served: lines(a) })}>Add a region rule</button>
        <button className="textlink" type="button" disabled={busy} onClick={() => answer({ accept: true })}>Any region is fine</button>
      </div>
    </div>
  );
  if (gap.kind === "counter_examples" || gap.kind === "examples") return (
    <div className="iinline">
      <label className="field"><span>One per line: company | tier | why</span><textarea className="input itext" rows={3} value={a} onChange={(e) => setA(e.target.value)} placeholder="Acme Studio | 3 | An agency that bills hours" /></label>
      <div className="actions">
        <button className="btn small" type="button" disabled={busy || !a.trim()} onClick={() => answer({ items: lines(a).map((l) => { const [company, tier, ...why] = l.split("|").map((x) => x.trim()); return { company, tier: Number(tier), why: why.join(" | ") }; }) })}>Add them</button>
        <button className="textlink" type="button" disabled={busy} onClick={() => answer({ accept: true })}>None is fine</button>
      </div>
    </div>
  );
  if (gap.kind === "personas") return (
    <div className="iinline">
      <label className="field"><span>One per line: function | titles, comma separated | primary or secondary</span><textarea className="input itext" rows={3} value={a} onChange={(e) => setA(e.target.value)} placeholder="Revenue leadership | VP Sales, CRO | primary" /></label>
      <div className="actions">
        <button className="btn small" type="button" disabled={busy || !a.trim()} onClick={() => answer({ items: lines(a).map((l) => { const [fn, titles, pr] = l.split("|").map((x) => x.trim()); return { function: fn, titles, priority: pr === "secondary" ? "secondary" : "primary" }; }) })}>Add them</button>
        <button className="textlink" type="button" disabled={busy} onClick={() => answer({ accept: true })}>None is fine</button>
      </div>
    </div>
  );
  if (gap.kind === "tier_definitions") return (
    <div className="iinline">
      <label className="field"><span>One per line: tier | what makes it</span><textarea className="input itext" rows={3} value={a} onChange={(e) => setA(e.target.value)} placeholder="1 | In range and a strong fit" /></label>
      <div className="actions">
        <button className="btn small" type="button" disabled={busy || !a.trim()} onClick={() => answer({ defs: lines(a).map((l) => { const [tier, ...text] = l.split("|").map((x) => x.trim()); return { tier: Number(tier), text: text.join(" | ") }; }) })}>Add them</button>
        <button className="textlink" type="button" disabled={busy} onClick={() => answer({ accept: true })}>Let the AI decide</button>
      </div>
    </div>
  );
  return (
    <div className="iinline">
      <label className="field"><span>One per line: name | strong, partial or weak | words that match, comma separated</span><textarea className="input itext" rows={3} value={a} onChange={(e) => setA(e.target.value)} /></label>
      <div className="actions">
        <button className="btn small" type="button" disabled={busy || !a.trim()} onClick={() => answer({ items: lines(a).map((l) => { const [name, stance, keywords] = l.split("|").map((x) => x.trim()); return { name, stance, keywords }; }) })}>Add them</button>
      </div>
    </div>
  );
}

/* -------------------------------------------------- test on companies you know, then publish */

const VIA = (v: string) => (v === "hard_rule" ? "by a rule" : v === "tier_definition" ? "by a tier definition" : `by ${v.replace(/_/g, " ")}`);

function Test({ c, version, busy, error, call }: FlowProps) {
  const { actor, demo } = useActor();
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [low, setLow] = useState(false);
  const [err, setErr] = useState("");
  const run = c.bench.run;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const loadSample = async () => { const j = await get<{ companies: unknown[] }>("/api/icp/sample-bench"); if (j) setText(JSON.stringify(j.companies)); else setErr("The sample set is only in the demo."); };
  void actor;
  const below = run ? run.accuracy < c.bench.min_accuracy : false;
  const right = run ? run.results.filter((r) => r.correct).length : 0;
  const set = c.bench.set.length;

  return (
    <>
      <Head
        at={run ? 4 : 3}
        caption={run ? `${right} of ${run.results.length} right` : set ? plural(set, "company", "companies") : "No companies yet"}
        title={run ? `Publish version ${version}` : "Test on known companies"}
        fig={run ? `${right} of ${run.results.length}` : set ? String(set) : undefined}
        label={run ? "right" : set === 1 ? "company" : "companies"}
      />

      <section className="ibench" aria-label="Companies you know">
        <label className="field"><span>One company per line: name, employees, industry, business model, expected tier, kind (won, lost or bad fit)</span><textarea className="input itext" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder={"name,employees,industry,business_model,expected_tier,kind\nAcme Cloud,900,Data platforms,B2B,1,won"} /></label>
        <div className="actions">
          <button className="btn line small" type="button" disabled={busy || !text.trim()} onClick={async () => { setErr(""); const j = (() => { try { return text.trim().startsWith("[") ? JSON.parse(text) : text; } catch { return text; } })(); await call("PUT", "/bench", { companies: j }); }}>{set ? "Replace the companies" : "Add the companies"}</button>
          {demo && <button className="textlink" type="button" onClick={loadSample}>Use the demo's companies</button>}
          {set > 0 && <span className="small mute">{`Up to ${plural(c.bench.estimate.model_calls_at_most, "AI call")}`}</span>}
        </div>
        {(err || error) && <p role="alert" className="error">{err || error}</p>}
        <div className="actions">
          <button className="btn" type="button" disabled={busy || set === 0} onClick={() => call("POST", "/bench/run")}>{busy ? "Testing…" : run ? "Test again" : "Run the test"}</button>
          <button className="textlink" type="button" disabled={busy} onClick={() => call("POST", "/reopen")}>Back to the rules</button>
        </div>
      </section>

      {run && (
        <section className="iresult" aria-label="Test results">
          <dl className="figs small">
            <div><dd>{pct(run.accuracy)}</dd><dt>right</dt></div>
            <div><dd>{pct(run.baseline_accuracy)}</dd><dt>size and words alone</dt></div>
            {run.tier3_as_tier1 > 0 && <div><dd>{run.tier3_as_tier1}</dd><dt>tier 3 called tier 1</dt></div>}
            {run.unknown > 0 && <div><dd>{run.unknown}</dd><dt>not placed</dt></div>}
          </dl>
          {!c.bench.fresh && <p className="error" role="status">The rules changed since this test. Test again before publishing.</p>}
          <Tray title="Each company" n={run.results.length}>
            <div className="tres head" aria-hidden="true"><span /><span>Company</span><span>Known</span><span>The rules say</span><span>Size and words</span><span /></div>
            {run.results.map((r) => (
              <div className={`tres${r.correct ? "" : " off"}`} key={r.name}>
                <i className="tres-mark" aria-hidden="true" />
                <span className="tres-name"><b>{r.name}</b><span className="small mute">{r.kind.replace("_", " ")}</span></span>
                <span><span className="small mute tres-head">Known </span>Tier {r.expected}</span>
                <span><span className="small mute tres-head">Rules </span>{r.got === null ? "Not placed" : `Tier ${r.got}`}<span className="small mute"> {VIA(r.via)}</span></span>
                <span className={r.baseline_correct ? "" : "mute"}><span className="small mute tres-head">Size and words </span>Tier {r.baseline}</span>
                <span className="racts">{!r.correct && <button className="textlink" type="button" disabled={busy} onClick={() => call("POST", "/bench/example", { name: r.name })}>Add as an example</button>}</span>
              </div>
            ))}
          </Tray>
          <div className="form ipub">
            <label className="field"><span>A line for the version history</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
            {below && <label className="check"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /><span>Publish although it got under {pct(c.bench.min_accuracy)} right</span></label>}
            <div className="actions">
              <button className="btn" type="button" disabled={busy || !c.bench.fresh || (below && !low)} onClick={() => call("POST", "/publish", { note, accept_low: low })}>Publish version {version}</button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
