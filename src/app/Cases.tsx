/* The cases: data conflicts the pipeline could not settle alone. They come grouped by kind so forty clear
   quickly: a group opens to its rows, each row shows the two sides and its answers, one tap answers, and
   a group can take every suggested answer at once. Blocking kinds hold up the Outreach card and sit first.
   Options and their effects come from the server. */

import { companyDisplayName as co, dealDisplayName } from "../shared/names";
import { useEffect, useState } from "react";
import { send, type CaseOption, type ReviewCase } from "./api";
import { useActor } from "./App";
import { objectHref } from "./Objects";
import { caseWords, plural } from "./words";
import { PersonAvatar } from "./PersonAvatar";
import { Chevron } from "./Patterns";

export const normalizeOption = (o: ReviewCase["options"][number]): CaseOption => {
  if (typeof o === "string") return { value: o, label: o.replace(/_/g, " ") };
  const value = String(o.value ?? o.id ?? o.label ?? "");
  return { value, label: String(o.label ?? o.title ?? value.replace(/_/g, " ")), effect: o.effect ?? o.result ?? o.description };
};
export const openCases = (cases: ReviewCase[]) => cases.filter((c) => !c.decision);
const words = (k: string) => k.replace(/_/g, " ");


/** "Label: value" pairs, label over value, as many across as fit. */
function Pairs({ pairs }: { pairs: [string, string][] }) {
  return <dl className="kv">{pairs.map(([k, v], i) => <div key={`${k}${i}`} className={v.length > 40 || /^reply$/i.test(k) ? "wide" : ""}><dt>{/^reply$/i.test(k) ? "They wrote" : k}</dt><dd className={/^reply$/i.test(k) ? "said" : undefined}>{v}</dd></div>)}</dl>;
}

const pair = (line: string): [string, string] => { const at = line.indexOf(": "); return at < 0 ? ["", line] : [line.slice(0, at), line.slice(at + 2)]; };

/** Attendee-file fields that help answer a question about a company: where it is and who came from it. */
const USEFUL = /country|city|region|title|job|role|position|department|industry|company|employer|seniority/i;

/** The reason a case was raised, in a few words. The full sentence lives in the server's summary. */
const REASON: [RegExp, string][] = [[/Nothing we found backs up a tier/i, "No evidence for a tier"], [/checked its website and still could not tell/i, "Website checked, still unclear"],
  // A reply set aside for a person: why, as a label, not a sentence (the server's summary stays in the activity log).
  [/it says unsubscribe, the AI read it differently/i, "Says unsubscribe, read as something else"], [/may have been written by someone else/i, "Maybe not from them"],
  [/the Motion card ran out/i, "Not read: the card ran out"], [/answer could not be used/i, "Could not be read"], [/fits no category/i, "Fits no answer"]];
const reasonOf = (summary: string) => REASON.find(([re]) => re.test(summary))?.[1] ?? null;

/** The one long "what we know" line, taken apart by where each fact came from, and shown whole. */
function Known({ text }: { text: string }) {
  const WEB = "From its own website: ", FILE = "From the attendee file (unverified): ";
  const parts = text.split(/;\s+(?=From |Employees: |Industry: |Sells to: |Country: |Description: )/).map((p) => p.trim().replace(/;$/, "")).filter(Boolean);
  const web = parts.find((p) => p.startsWith(WEB))?.slice(WEB.length);
  const file = parts.filter((p) => p.startsWith(FILE)).map((p) => pair(p.slice(FILE.length))).filter(([k]) => USEFUL.test(k));
  const other = parts.filter((p) => !p.startsWith(WEB) && !p.startsWith(FILE)).map(pair);
  return (
    <div className="known">
      {other.length > 0 && <section><h4>Company data</h4><Pairs pairs={other} /></section>}
      {web && <section><h4>Its website says</h4><p>{web}</p></section>}
      {file.length > 0 && <section><h4>Attendee file, unverified</h4><Pairs pairs={file} /></section>}
    </div>
  );
}

/** Facts as the server sends them: a list of sides, a list of lines, or one object. Everything shows; nothing is cut. */
const keysOf = (o: unknown, skip: string[]) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o as object).filter((k) => !skip.includes(k)).length : 1);
/** How many fields a case shows: every field of every side, so one side with four fields counts four. */
const factCount = (facts: unknown, skip: string[]) => (Array.isArray(facts) ? facts.reduce((n: number, f) => n + keysOf(f, skip), 0) : facts && typeof facts === "object" ? keysOf(facts, skip) : 0);

function Facts({ facts, skip = [], company }: { facts: unknown; skip?: string[]; company?: string | null }) {
  const raw: Record<string, unknown>[] = Array.isArray(facts)
    ? facts.every((f) => f && typeof f === "object" && !Array.isArray(f)) ? (facts as Record<string, unknown>[]) : [{ "": facts.map(String).join("; ") }]
    : facts && typeof facts === "object" ? [facts as Record<string, unknown>] : facts ? [{ "": String(facts) }] : [];
  // The name already on the row is not repeated as a fact.
  const sides = raw.map((side) => Object.fromEntries(Object.entries(side).filter(([k]) => !skip.includes(k)))).filter((side) => Object.keys(side).length);
  if (!sides.length) return null;
  const text = (v: unknown) => v == null || v === "" ? "none" : Array.isArray(v) ? v.map(String).join(", ") : String(v);
  return (
    <div className="cfacts">
      {sides.map((side, i) => typeof side.what_we_know === "string"
        ? <Known key={i} text={side.what_we_know} />
        : <Pairs key={i} pairs={Object.entries(side).map(([k, v]) => [words(k), k === "deal" && typeof v === "string" ? dealDisplayName(v, company) ?? v : text(v)])} />)}
    </div>
  );
}

/** The website named on a case, shown beside the company instead of as a fact. */
const siteOf = (facts: unknown): string | null => {
  const first = Array.isArray(facts) ? facts[0] : facts;
  const w = first && typeof first === "object" ? (first as Record<string, unknown>).website : null;
  return typeof w === "string" && w && w !== "not known" ? w : null;
};

function CaseRow({ eventId, c, onDone }: { eventId: string; c: ReviewCase; onDone: () => void }) {
  const { actor } = useActor();
  const options = c.options.map(normalizeOption);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [domain, setDomain] = useState("");
  const [asking, setAsking] = useState(false);
  const answer = async (o: CaseOption, data?: Record<string, unknown>) => {
    setBusy(o.value); setError("");
    const r = await send("POST", `/api/events/${eventId}/cases/${c.id}`, actor, { decision: o.value, data });
    setBusy(null);
    if (r.ok) onDone(); else setError(r.error);
  };
  const { go } = useActor();
  const who = c.person?.full_name ? `${c.person.full_name}${c.company ? `, ${co(c.company)}` : ""}` : c.company ? co(c.company) : "";
  const site = who ? siteOf(c.facts) : null;
  return (
    <li className="crow" data-case={c.id}>
      <div className="cmain">
        <div className="min0">
          {who && <p className="cwho">{c.person?.id ? <a className="to" href={objectHref("person", c.person.id)} data-opens-sheet="" onClick={(ev) => { ev.preventDefault(); go(objectHref("person", c.person!.id)); }}>{who}</a> : who}{site && <span>{site}</span>}</p>}
          {/* The question is said once: by the fields when there are any, otherwise in a line. */}
          {reasonOf(c.summary) ? <p className="csum">{reasonOf(c.summary)}</p> : factCount(c.facts, [...(who ? ["company", "person"] : []), ...(site ? ["website"] : [])]) < 2 && <p className="csum">{c.summary.replace(/^Which tier is ".*?"\?\s*/, "")}</p>}
        </div>
        <Facts facts={c.facts} company={c.company} skip={[...(who ? ["company", "person"] : []), ...(site ? ["website"] : [])]} />
      </div>
      <div className="cacts" role="group" aria-label="Your answer">
        {options.map((o) => (
          <button key={o.value} type="button" className={`choice${o.value === c.suggested ? " sug" : ""}`} title={o.effect} disabled={busy !== null}
            onClick={() => (o.value === "supply_domain" ? setAsking(true) : answer(o))}>
            {busy === o.value ? "Saving…" : o.label}
          </button>
        ))}
        {asking && (
          <form className="cdomain" onSubmit={(ev) => { ev.preventDefault(); answer(options.find((o) => o.value === "supply_domain")!, { domain: domain.trim() }); }}>
            <label className="sr-only" htmlFor={`d-${c.id}`}>Website</label>
            <input id={`d-${c.id}`} className="input" placeholder="company.com" value={domain} onChange={(ev) => setDomain(ev.target.value)} autoFocus />
            <button className="btn small" type="submit" disabled={!domain.trim() || busy !== null}>Use it</button>
          </form>
        )}
        {error && <p role="alert" className="error small">{error}</p>}
      </div>
    </li>
  );
}

/** What a settled case did, in a word or two: the company's or person's fate, not the button that was pressed. */
function outcome(c: ReviewCase): string {
  const d = c.decision ?? "";
  if (d === "skipped") return c.kind === "owner_unreachable" ? "Stayed on the list" : "Dropped";
  if (/^tier_(\d)$/.test(d)) return `Tier ${d.slice(5)}`;
  const WORD: Record<string, string> = { drop: "Dropped", is_customer: "Dropped, a customer", same_company: "Dropped, listed already", inherit: "Dropped with its parent",
    not_customer: "Kept in research", different_company: "Kept in research", independent: "Kept in research", supply_domain: "Website added",
    keep: c.kind === "late_stage_deal" ? "Kept, owner goes first" : c.kind === "second_look_disagreement" ? "First tier kept" : "Kept", dismiss: "No change", include: "Stayed on the list", mine: "Left to the owner" };
  return WORD[d] ?? d.replace(/_/g, " ");
}

function Group({ eventId, kind, cases, openFirst, onChange }: { eventId: string; kind: string; cases: ReviewCase[]; openFirst: boolean; onChange: () => void }) {
  const { actor } = useActor();
  const [open, setOpen] = useState(openFirst);
  const [shown, setShown] = useState(12);
  const [taking, setTaking] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => { if (openFirst) setOpen(true); }, [openFirst]);
  const suggested = cases.filter((c) => c.suggested);
  const takeAll = async () => {
    setError("");
    for (const [i, c] of suggested.entries()) {
      setTaking(i + 1);
      const r = await send("POST", `/api/events/${eventId}/cases/${c.id}`, actor, { decision: c.suggested });
      if (!r.ok) { setError(r.error); break; }
    }
    setTaking(0);
    onChange();
  };
  const blocking = cases[0]?.blocking;
  // The bulk button names the answer it gives, when every suggestion is the same one.
  const same = suggested.length > 0 && suggested.every((c) => c.suggested === suggested[0].suggested);
  const answerWord = same ? suggested[0].options.map(normalizeOption).find((o) => o.value === suggested[0].suggested)?.label ?? null : null;
  return (
    <li className={`cgroup${blocking ? " blocking" : ""}`}>
      <div className="cghead">
        <button type="button" className="cgbtn" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="cgn">{cases.length}</span>
          <span className="cgname">{caseWords(kind)}</span>
          <span className="chevbtn" aria-hidden="true"><Chevron open={open} /></span>
        </button>
        {open && suggested.length > 1 && (
          <button className="btn line small" type="button" disabled={taking > 0} onClick={takeAll}>
            {taking ? `Saving ${taking} of ${suggested.length}…` : answerWord ? `All ${suggested.length}: ${answerWord}` : `Take each suggested answer (${suggested.length})`}
          </button>
        )}
      </div>
      {error && <p role="alert" className="error small">{error}</p>}
      {open && (
        <ul className="crows">
          {cases.slice(0, shown).map((c) => <CaseRow key={c.id} eventId={eventId} c={c} onDone={onChange} />)}
        </ul>
      )}
      {open && cases.length > shown && <button className="chevrow" type="button" onClick={() => setShown(shown + 24)}><Chevron />{Math.min(24, cases.length - shown)} more</button>}
    </li>
  );
}

/** Every open case on the event, grouped by kind, blocking kinds first. Settled ones fold away under one line. */
export function Cases({ eventId, cases, onChange, compact }: { eventId: string; cases: ReviewCase[]; onChange: () => void; compact?: boolean }) {
  const { actor } = useActor();
  const open = openCases(cases);
  const decided = cases.filter((c) => c.decision);
  const [showDecided, setShowDecided] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState("");
  if (!cases.length) return null;
  const groups = new Map<string, ReviewCase[]>();
  for (const c of open) groups.set(c.kind, [...(groups.get(c.kind) ?? []), c]);
  const ordered = [...groups.entries()].sort((a, b) => Number(Boolean(b[1][0].blocking)) - Number(Boolean(a[1][0].blocking)) || b[1].length - a[1].length);
  const blocking = open.filter((c) => c.blocking).length;
  const skip = async () => {
    setSkipping(true); setError("");
    const r = await send("POST", `/api/events/${eventId}/cases/skip`, actor);
    setSkipping(false);
    if (r.ok) onChange(); else setError(r.error);
  };

  if (compact) {
    // The side sheet's Run step already says how many cases come first; the line repeats nothing.
    if (open.length && blocking === open.length) return <span data-cases={open.length} />;
    return <p className="cases-line" data-cases={open.length}>{open.length ? `${plural(open.length, "case")} to settle${blocking ? `, ${blocking} before verifying contacts` : ""}.` : `${plural(decided.length, "case")} settled.`}</p>;
  }
  return (
    <section className="cases" aria-label="Cases" data-cases={open.length}>
      <div className="grp">
        <h2 className="display">{open.length ? `${open.length} to settle` : "Nothing to settle"}</h2>
        {blocking > 0 && blocking < open.length && <span className="mute small">{blocking} before verifying contacts</span>}
        {decided.length > 0 && <button className="chevrow" type="button" onClick={() => setShowDecided(!showDecided)} aria-expanded={showDecided}>{decided.length} settled<Chevron open={showDecided} /></button>}
      </div>
      {ordered.length > 0 && (
        <ul className="cgroups">
          {ordered.map(([kind, cs], i) => <Group key={kind} eventId={eventId} kind={kind} cases={cs} openFirst={i === 0} onChange={onChange} />)}
        </ul>
      )}
      {blocking > 0 && (
        <div className="actions cskip">
          <button className="btn line small" type="button" disabled={skipping} onClick={skip} title="Each company still open is dropped; nothing is spent on it.">{skipping ? "Skipping…" : `Skip the ${blocking === 1 ? "one" : blocking} left, drop them`}</button>
        </div>
      )}
      {error && <p role="alert" className="error small">{error}</p>}
      {showDecided && (
        <ul className="settled">
          {[...new Set(decided.map((c) => c.kind))].map((kind) => {
            const cs = decided.filter((c) => c.kind === kind);
            return (
              <li key={kind} className="st-group">
                <h4>{caseWords(kind)}<span>{cs.length}</span></h4>
                <ul>{cs.map((c) => {
                  const name = c.person?.full_name ?? c.company ?? c.summary.match(/"(.+?)"/)?.[1] ?? c.summary.match(/owns (.+?),/)?.[1] ?? caseWords(c.kind);
                  const by = !c.decided_by ? "" : /desk/i.test(c.decided_by) ? "Automatic" : c.decided_by.split(" ")[0];
                  return (
                    <li key={c.id}>
                      <span className="st-what">{name}</span>
                      <span className="st-answer">{outcome(c)}</span>
                      <span className="st-by">{c.decided_by && !/desk/i.test(c.decided_by) && <PersonAvatar name={c.decided_by} size={22} />}{by}</span>
                    </li>
                  );
                })}</ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
