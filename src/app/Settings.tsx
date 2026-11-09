/* Settings. Only GTM Team opens it; anyone else gets one line. A second-level nav, one section at a
   time: the ICP (upload a new version, past versions) and seven read-only views of the rules, limits,
   connections and roles as they stand in config. The ICP compile steps open only after an upload; they live in Icp.tsx. */

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { isGtm, SETTINGS_REFUSAL } from "../shared/roles";
import type { icpOverview } from "../server/icp";
import type { settingsView } from "../server/settings-view";
import { get, send } from "./api";
import { Link, useActor } from "./App";
import { EventLogo } from "./EventLogo";
import { CompileFlow } from "./Icp";
import { Icon } from "./icons";
import { Chevron, ConfirmDialog } from "./Patterns";
import { PersonAvatar } from "./PersonAvatar";
import { plural } from "./words";

type Overview = Awaited<ReturnType<typeof icpOverview>>;
type Go = (to: string) => void;
const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

type View = ReturnType<typeof settingsView>;
const SECTIONS = [
  ["icp", "ICP", <Icon.target />], ["scoring", "Scoring", <Icon.grid />], ["titles", "Titles and people", <Icon.people />], ["lists", "Lists", <Icon.lists />],
  ["data", "Data rules", <Icon.check />], ["spend", "Spend limits", <Icon.cost />], ["connections", "Connections", <Icon.plug />], ["team", "Team and access", <Icon.seats />],
] as const;
type Section = (typeof SECTIONS)[number][0];

export function Settings({ go, compileId, section }: { go: Go; compileId: string | null; section: string | null }) {
  const { actor } = useActor();
  if (!isGtm(actor)) return <><header className="hero" data-ready="1"><div><h1>Settings</h1></div></header><p className="mute" role="status">{SETTINGS_REFUSAL}</p></>;
  if (compileId) return <CompileFlow id={compileId} go={go} />;
  const cur: Section = SECTIONS.some(([k]) => k === section) ? (section as Section) : "icp";
  return (
    <>
      <header className="hero" data-ready="1"><div><h1>Settings</h1></div></header>
      <div className="settings">
        <nav className="snav" aria-label="Settings sections" style={{ "--at": SECTIONS.findIndex(([k]) => k === cur) } as CSSProperties}>
          {SECTIONS.map(([k, label, icon]) => <Link key={k} to={k === "icp" ? "/settings" : `/settings?section=${k}`} go={go} aria-current={cur === k ? "page" : undefined}><span className="ico">{icon}</span>{label}</Link>)}
        </nav>
        <div className="sbody" key={cur}>{cur === "icp" ? <IcpSection go={go} /> : <ViewSection which={cur} />}</div>
      </div>
    </>
  );
}

/** A titled tray of rows, the same container the Overview uses. */
function Tray({ title, n, wide = false, children }: { title: string; n?: number; wide?: boolean; children: ReactNode }) {
  return <div className={`tray${wide ? " wide" : ""}`}><h3><b>{title}</b>{n !== undefined && <span>{n}</span>}</h3>{children}</div>;
}

/** One word per line. A long list folds into two columns so it stays level with the short ones beside it. */
function WordList({ words }: { words: string[] }) {
  const rows = Math.ceil(words.length / 2);
  const two = words.length > 6;
  return <ul className={`wordlist${two ? " two" : ""}`} style={two ? ({ "--rows": rows } as CSSProperties) : undefined}>{words.map((w, i) => <li key={w} className={two && i === rows ? "top" : ""}>{w}</li>)}</ul>;
}

/** One setting: what it is on the left, its value on the right. */
function Row({ label, value }: { label: string; value: ReactNode }) {
  return <div className="setrow"><span>{label}</span><b>{value}</b></div>;
}

const STATUS = (s: string) => (s === "estimated" ? "To read" : s === "drafted" ? "To confirm" : s === "confirmed" ? "To test" : s);

function IcpSection({ go }: { go: Go }) {
  const { actor } = useActor();
  const [o, setO] = useState<Overview | null | undefined>(undefined);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { get<Overview>("/api/icp").then((j) => setO(j ?? null)); }, []);
  if (o === undefined) return null;
  const cur = o?.current ?? null;

  const submit = async (filename: string, body: string) => {
    setBusy(true); setError("");
    const r = await send<{ compile_id: string }>("POST", "/api/icp/documents", actor, { filename, text: body });
    setBusy(false);
    if (r.ok) go(`/settings?compile=${r.data.compile_id}`); else setError(r.error);
  };
  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    if (/\.(docx?|pdf|odt)$/i.test(f.name)) { setError("Save the document as .txt or .md, or paste its text."); return; }
    await submit(f.name, await f.text());
  };

  const icp = cur?.icp;
  const strong = icp?.segments.filter((s) => s.stance === "strong").map((s) => s.name) ?? [];
  const buyer = icp?.personas.filter((p) => p.priority === "primary").flatMap((p) => p.titles).slice(0, 4) ?? [];
  const facts: [string, string][] = icp ? [
    ["Company size", icp.size ? `${icp.size.min.toLocaleString("en-US")} to ${icp.size.max.toLocaleString("en-US")} employees` : "Any"],
    ["Verticals", strong.length ? strong.join(", ") : "Not stated"],
    ["Buyer", buyer.length ? buyer.join(", ") : "Not stated"],
    ["Never contact", plural(icp.lists.excluded.length, "name")],
  ] : [];

  return (
    <section className="sstack" aria-label="ICP">
      <div className="icphero" data-ready="1">
        <div className="icphero-top">
          <div>
            <h2 className="display">{cur ? `Version ${cur.version}` : "No ICP yet"}</h2>
            {cur && <p>{when(cur.published_at)}, {cur.published_by}{cur.document ? `, ${cur.document.filename}` : ""}</p>}
          </div>
          <div className="actions">
            <label className="btn">{busy ? "Saving…" : cur ? "Upload a new version" : "Upload the ICP"}<input className="sr-only" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" onChange={(e) => pickFile(e.target.files?.[0])} disabled={busy} /></label>
            <button className="btn line" type="button" onClick={() => setPasting(!pasting)} aria-expanded={pasting}>Paste text</button>
          </div>
        </div>
        {cur && <p className="icphero-sum">{icp!.summary || "No summary in the document."}</p>}
        {facts.length > 0 && <dl className="kv">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
      </div>

      {pasting && (
        <div className="form spaste">
          <label className="field"><span>Text</span><textarea className="input itext" rows={8} value={text} onChange={(e) => setText(e.target.value)} /></label>
          <div className="actions"><button className="btn" type="button" disabled={busy || !text.trim()} onClick={() => submit("pasted text", text)}>Read it</button><button className="textlink" type="button" onClick={() => setPasting(false)}>Cancel</button></div>
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}

      {(o?.open.length ?? 0) > 0 && (
        <Tray title="In progress" n={o!.open.length}>
          {o!.open.map((c) => <Link key={c.id} to={`/settings?compile=${c.id}`} go={go} className="setrow go"><span>{c.filename}</span><b>{STATUS(c.status)}<Chevron right /></b></Link>)}
        </Tray>
      )}

      {o && o.versions.length > 1 && (
        <div className="folds">
          <details className="fold">
            <summary><Icon.history /><span className="fold-t">Past versions</span><span className="fold-peek">{o.versions.length}</span><Chevron /></summary>
            <ul className="vers">
              {o.versions.map((v) => <li key={v.version}><b>Version {v.version}</b><span>{when(v.published_at)}, {v.published_by}{v.note ? `. ${v.note}` : ""}</span>{v.bench_accuracy !== null && <i>{Math.round(v.bench_accuracy * 100)}% right</i>}</li>)}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const onOff = (b: boolean) => (b ? "On" : "Off");
/** "claude-opus-5-5" reads as "Claude Opus 5.5". Anything else is shown as it is. */
const modelName = (id: string) => { const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)$/); return m ? `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id; };

const SITES: Record<string, string> = { Apollo: "https://apollo.io", ZeroBounce: "https://zerobounce.net", Anthropic: "https://anthropic.com", Google: "https://google.com", Slack: "https://slack.com" };
const CREDITS = ["Apollo", "ZeroBounce"];

function Names({ names, none }: { names: string[]; none: string }) {
  if (!names.length) return <p className="sempty">{none}</p>;
  return <ul className="names">{names.map((n) => <li key={n}><EventLogo name={n} size={26} /><span>{n}</span></li>)}</ul>;
}

/* ------------------------------------------------------------------ opt-outs
   The third tray under Lists. An opt-out spans every event and cannot be undone, so adding one asks first. Anyone who can open Settings can add. */

interface OptOutRow { id: string; email: string | null; name: string | null; company: string | null; reason: string; created_by: string | null; created_at: string }
const SEARCH_FROM = 8;
const optOutWho = (o: OptOutRow) => o.email ?? `${o.name ?? "Someone"} at ${o.company ?? "a company"}`;

function OptOuts({ rows, onAdded }: { rows: OptOutRow[]; onAdded: () => Promise<void> }) {
  const { actor } = useActor();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [by, setBy] = useState<"email" | "name">("email");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [reason, setReason] = useState("");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((o) => `${optOutWho(o)} ${o.reason} ${o.created_by ?? ""}`.toLowerCase().includes(needle)) : rows;
  const who = by === "email" ? email.trim() : `${name.trim()} at ${company.trim()}`;
  const ready = by === "email" ? /\S+@\S+\.\S+/.test(email.trim()) : Boolean(name.trim() && company.trim());
  const run = async () => {
    setBusy(true); setError("");
    const body = by === "email" ? { email: email.trim(), reason } : { name: name.trim(), company: company.trim(), reason };
    const r = await send("POST", "/api/suppressions", actor, body);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    setAsking(false); setAdding(false); setEmail(""); setName(""); setCompany(""); setReason("");
    await onAdded();
  };
  return (
    <div className="optouts">
      {rows.length >= SEARCH_FROM && <label className="search oo-search"><span className="sr-only">Search opt-outs</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, address or reason" /></label>}
      {rows.length === 0 ? <p className="sempty">Nobody</p> : shown.length === 0 ? <p className="sempty">Nobody matches</p> : (
        <ul className="oo-list">
          {shown.map((o) => (
            <li key={o.id}>
              <b className="wrap-any">{optOutWho(o)}</b>
              {o.reason && <span className="oo-why">{o.reason}</span>}
              <span className="oo-meta">{o.created_by ? `${o.created_by}, ` : ""}{when(o.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="oo-add">
        <button type="button" className="xmore" aria-expanded={adding} onClick={() => setAdding(!adding)}>Add someone<Chevron open={adding} /></button>
        {adding && (
          <div className="oo-form">
            <div className="seg" role="group" aria-label="Opt out by">
              <button type="button" aria-pressed={by === "email"} onClick={() => setBy("email")}>Email</button>
              <button type="button" aria-pressed={by === "name"} onClick={() => setBy("name")}>Name at a company</button>
            </div>
            {by === "email"
              ? <label className="field"><span>Email</span><input className="input" type="email" inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
              : <>
                <label className="field"><span>Name</span><input className="input" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></label>
                <label className="field"><span>Company</span><input className="input" autoComplete="off" value={company} onChange={(e) => setCompany(e.target.value)} /></label>
              </>}
            <label className="field"><span>Reason, if any</span><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
            <div className="actions">
              <button className="btn small" type="button" disabled={!ready} onClick={() => setAsking(true)}>Opt out</button>
              <button className="textlink" type="button" onClick={() => setAdding(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
      {asking && (
        <ConfirmDialog title={`Opt out ${who}?`} confirm={busy ? "Opting out…" : "Opt out"} cancel="Keep them" busy={busy} error={error} onConfirm={run} onClose={() => { if (!busy) { setAsking(false); setError(""); } }}>
          <p>{who} comes off every outreach list and is never looked up again, at every event.</p>
          <p className="mute">This cannot be undone.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ViewSection({ which }: { which: Exclude<Section, "icp"> }) {
  const [v, setV] = useState<View | null | undefined>(undefined);
  const [optOuts, setOptOuts] = useState<OptOutRow[] | null>(null);
  const loadOptOuts = async () => { const j = await get<{ opt_outs: OptOutRow[] }>("/api/suppressions"); setOptOuts(j?.opt_outs ?? []); };
  useEffect(() => { get<View>("/api/settings/view").then((j) => setV(j ?? null)); }, []);
  useEffect(() => { if (which === "lists") loadOptOuts(); }, [which]);
  if (v === undefined || (which === "lists" && optOuts === null)) return null;
  if (v === null) return <p className="mute">Could not load.</p>;
  const title = SECTIONS.find(([k]) => k === which)![1];
  let body: ReactNode = null;

  if (which === "scoring") {
    const s = v.scoring;
    body = (
      <div className="scols">
        <div className="matrix" role="table" aria-label="Priority by company tier and title tier">
          <div className="mrow head" role="row"><span role="columnheader" /><span role="columnheader">Title 1</span><span role="columnheader">Title 2</span><span role="columnheader">Title 3</span><span role="columnheader">No title</span></div>
          {s.matrix.map((m) => (
            <div className="mrow" role="row" key={m.company_tier}>
              <span role="rowheader">Company tier {m.company_tier}</span>
              {[...m.by_title, m.no_title].map((p, i) => <i role="cell" key={i} className={`p${p}`}>{p}</i>)}
            </div>
          ))}
        </div>
        <Tray title="Limits">
          <Row label="People at a tier 1 company" value={`Up to ${s.quota_tier1}`} />
          <Row label="People at a tier 2 company" value={`Up to ${s.quota_tier2}`} />
          <Row label="Warn when tier 1 share is above" value={pct(s.tier1_share_warning)} />
          <Row label="Small attendee list" value={`Under ${s.small_list_companies} companies`} />
        </Tray>
      </div>
    );
  } else if (which === "titles") {
    const t = v.titles;
    const tiers = ["1", "2", "3"] as const;
    body = (
      <div className="words">
        {tiers.map((n) => <Tray key={n} title={`Tier ${n} titles`} n={t.keywords[n].length} wide={t.keywords[n].length > 6}><WordList words={t.keywords[n]} /></Tray>)}
        <Tray title="Buyers" n={t.buyer_titles.length} wide><WordList words={t.buyer_titles} /></Tray>
        <Tray title="At each company" wide>
          <Row label="People to look for" value={t.contacts_per_company} />
          <Row label="Add prospects" value={onOff(t.add_prospects)} />
        </Tray>
      </div>
    );
  } else if (which === "lists") {
    body = (
      <div className="scols three">
        <Tray title="Never contact" n={v.lists.never_contact.length}><Names names={v.lists.never_contact} none="Nobody" /></Tray>
        <Tray title="Existing customers" n={v.lists.customers.length}><Names names={v.lists.customers} none="None" /></Tray>
        <Tray title="Opted out" n={optOuts!.length}><OptOuts rows={optOuts!} onAdded={loadOptOuts} /></Tray>
      </div>
    );
  } else if (which === "data") {
    const d = v.data_rules;
    body = (
      <div className="scols">
        <Tray title="Emails">
          <Row label="To make the list" value={d.email_rule} />
          <Row label="Domains that accept any address" value={d.catch_all} />
          <Row label="Guess addresses from a pattern" value={onOff(d.pattern_guessing)} />
          <Row label="Candidates tried per person" value={d.candidates_per_person} />
        </Tray>
        <Tray title="How long data stays good">
          <Row label="Person record" value={`${d.freshness_days} days`} />
          <Row label="Email check" value={`${d.verification_reuse_days} days`} />
          <Row label="Company data" value={`${d.firmographics_cache_days} days`} />
        </Tray>
      </div>
    );
  } else if (which === "spend") {
    const s = v.spend;
    body = (
      <div className="scols">
        <Tray title="AI">
          <Row label="Cost of one call" value={`${s.llm_call_cents} cent${s.llm_call_cents === 1 ? "" : "s"}`} />
          <Row label="Calls to tier a company" value={s.tier_calls_per_company} />
          <Row label="Calls to read its website" value={s.website_read_calls} />
          {s.models.map((m) => <Row key={m.step} label={m.step} value={modelName(m.model)} />)}
        </Tray>
        <div className="sstack tight">
          <Tray title="Runs">
            <Row label="Companies that can be re-tiered" value={pct(s.retier_share)} />
            <Row label="Rows allowed in a real run" value={s.real_run_row_limit.toLocaleString("en-US")} />
          </Tray>
          <Tray title="Concierge">
            <Row label="Questions" value={s.agent_question_limit} />
            <Row label="AI calls per question" value={s.calls_per_question} />
          </Tray>
        </div>
      </div>
    );
  } else if (which === "connections") {
    const all = v.connections;
    const conn = (names: (c: (typeof all)[number]) => boolean) => all.filter(names).map((c) => (
      <div className="conn" key={c.name}>
        <EventLogo name={c.name} website={SITES[c.name]} size={34} />
        <span className="conn-who"><b>{c.name}</b>{c.pool && <span>{c.pool.allotment === null ? "Pool not set" : `${c.pool.allotment.toLocaleString("en-US")} credits a ${c.pool.period}`}</span>}</span>
        <span className={`conn-state ${c.state.replace(" ", "-")}`}><i aria-hidden="true" />{c.state === "simulated" ? "Simulated" : c.state === "connected" ? "Connected" : "Not connected"}</span>
      </div>
    ));
    body = (
      <div className="scols">
        <Tray title="Data vendors">{conn((c) => CREDITS.includes(c.name))}</Tray>
        <Tray title="AI and delivery">{conn((c) => !CREDITS.includes(c.name))}</Tray>
      </div>
    );
  } else {
    const t = v.team;
    const person = (name: string, sub?: string) => <div className="conn" key={name}><PersonAvatar name={name} size={34} /><span className="conn-who"><b>{name}</b>{sub && <span>{sub}</span>}</span></div>;
    body = (
      <div className="scols">
        <div className="sstack tight">
          <Tray title="Approve seats" n={t.approvers.length}>{t.approvers.map((n) => person(n))}</Tray>
          <Tray title="GTM Engineering" n={t.gtm.length}>{t.gtm.map((n) => person(n))}</Tray>
        </div>
        <div className="sstack tight">
          <Tray title="Roles">{t.personas.map((p) => person(p.name, p.role))}</Tray>
          <Tray title="Slack users" n={t.slack_users.length}>{t.slack_users.length ? t.slack_users.map((u) => person(u.name)) : <p className="sempty">Not mapped</p>}</Tray>
        </div>
      </div>
    );
  }
  return <section aria-label={title} className="sstack" data-ready="1">{body}</section>;
}
