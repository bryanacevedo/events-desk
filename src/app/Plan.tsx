/* The Plan tab: an event's reason, goal, the ways the team takes part, the budget in three columns, and who goes. The same plan in three views the person
   switches between and the desk remembers per person: One ledger (the whole plan as one document), By involvement (a section for each way of taking part,
   the totals beside it), and What needs me (what is open, then the plan folded). The one action sits in the stage line, never in a view.
   Money is leadership's and planners'. The server sends a rep no money; a section that would be empty for them is not drawn. */

import { useEffect, useState, type ReactNode } from "react";
import { get, send, type PlanBudgetCategory, type PlanData, type PlanInvolvement, type PlanPerson } from "./api";
import { useActor } from "./App";
import { Icon } from "./icons";
import { Fold } from "./Motion";
import { money, num, shortDate } from "./words";

type PV = "a" | "b" | "c";
const VIEW_WORDS: [PV, string][] = [["a", "One ledger"], ["b", "By involvement"], ["c", "What needs me"]];
const viewKey = (actor: string) => `plan-view:${actor}`;
const readView = (actor: string): PV => { try { const v = localStorage.getItem(viewKey(actor)); return v === "a" || v === "b" || v === "c" ? v : "b"; } catch { return "b"; } };
const saveView = (actor: string, v: PV) => { try { localStorage.setItem(viewKey(actor), v); } catch { /* private window */ } };

const KIND_WORDS: Record<string, string> = { passes: "Passes", sponsorship: "Sponsorship", talk: "Talk", hosted: "Hosted" };
const HOSTED_WORDS: Record<string, string> = { dinner: "Dinner", side_event: "Side event", roadshow_stop: "Roadshow stop", webinar: "Webinar", customer_event: "Customer event" };
const ROLE_WORDS: Record<string, string> = { attend: "Attend", host: "Host", speak: "Speak" };
const SEAT_WORDS: Record<string, string> = { approved: "Pass approved", pending: "Pass waiting", declined: "Pass declined" };
const PLAN_WORDS: Record<string, string> = { planning: "Planning", confirmed: "Confirmed", preparing: "Preparing", live: "Live", following_up: "Following up", judged: "Judged" };
/** Which way of taking part a budget category belongs under, in the By involvement view. */
const TRAY_OF: Record<string, PlanInvolvement["kind"]> = { passes: "passes", travel: "passes", sponsorship: "sponsorship", booth: "sponsorship", swag: "sponsorship", dinners: "hosted", other: "hosted" };

const dollars = (cents: number) => money(cents);

/** The money columns. Contracted reads "Not contracted" and actual "Not entered" until there is something to say; a total row closes a group of more than one. */
function Budget({ cats, total, aiCents }: { cats: PlanBudgetCategory[]; total?: { planned: number; contracted: number; actual: number }; aiCents?: number }) {
  if (!cats.length && !aiCents) return <p className="mute">No budget lines yet.</p>;
  return (
    <div className="pl-bt" role="table" aria-label="Budget">
      <div className="pl-bt-row pl-bt-head" role="row"><span role="columnheader">Line</span><span role="columnheader">Planned</span><span role="columnheader">Contracted</span><span role="columnheader">Actual</span></div>
      {cats.map((c) => (
        <div className="pl-bt-row" role="row" key={c.category}>
          <span role="rowheader"><b>{c.label}</b></span>
          <span role="cell" data-col="Planned">{dollars(c.planned_cents)}</span>
          <span role="cell" data-col="Contracted">{c.contracted_cents === null ? <i className="pl-nc">Not contracted</i> : dollars(c.contracted_cents)}</span>
          <span role="cell" data-col="Actual">{c.actual_cents === null ? <i className="pl-nc">Not entered</i> : dollars(c.actual_cents)}</span>
        </div>
      ))}
      {aiCents !== undefined && aiCents > 0 && (
        <div className="pl-bt-row" role="row"><span role="rowheader"><b>AI</b></span><span role="cell" data-col="Planned" /><span role="cell" data-col="Contracted" /><span role="cell" data-col="Actual">{dollars(aiCents)}</span></div>
      )}
      {total && (
        <div className="pl-bt-row pl-bt-total" role="row"><span role="rowheader"><b>Total</b></span><span role="cell" data-col="Planned">{dollars(total.planned)}</span><span role="cell" data-col="Contracted">{dollars(total.contracted)}</span><span role="cell" data-col="Actual">{dollars(total.actual)}</span></div>
      )}
    </div>
  );
}

const involvementFacts = (i: PlanInvolvement): string => {
  if (i.kind === "passes") return i.pass_count !== null ? `${i.pass_count} ${i.pass_count === 1 ? "pass" : "passes"}` : "";
  if (i.kind === "talk") return i.talk_title ? i.talk_title : "No title yet";
  if (i.kind === "hosted") return [HOSTED_WORDS[i.hosted_format ?? ""], i.headcount !== null ? `${i.headcount} guests` : ""].filter(Boolean).join(", ");
  return "";
};
const statusWord = (i: PlanInvolvement) => (i.status === "dropped" ? "Dropped" : i.status === "confirmed" ? "Confirmed" : "Planned");

function InvolvementRow({ i }: { i: PlanInvolvement }) {
  const speaker = i.kind === "talk" && !i.speaker ? "No speaker yet" : i.speaker;
  return (
    <li className="pl-row">
      <span className="pl-what"><b>{i.label || KIND_WORDS[i.kind]}</b><span>{[KIND_WORDS[i.kind], involvementFacts(i), i.kind === "talk" ? speaker : ""].filter(Boolean).join(", ")}</span></span>
      <span className="pl-end">{statusWord(i)}{i.dropped_reason ? `: ${i.dropped_reason}` : ""}</span>
    </li>
  );
}

function PersonRow({ p, withSeat = true }: { p: PlanPerson; withSeat?: boolean }) {
  return (
    <li className="pl-row">
      <span className="pl-what"><b>{p.person}</b><span>{p.team || "No team"}</span></span>
      <span className="pl-mid">{p.roles.map((r) => ROLE_WORDS[r] ?? r).join(", ")}</span>
      <span className={`pl-end${p.seat_status === "pending" ? " pl-strong" : ""}`}>{withSeat ? (p.seat_status ? SEAT_WORDS[p.seat_status] : "No pass") : ""}</span>
    </li>
  );
}

const Goal = ({ p }: { p: PlanData }) => {
  const g = p.goal;
  const items: [string, string][] = [];
  if (g.meetings_held !== null) items.push([num(g.meetings_held), "meetings held"]);
  if (g.accounts_met !== null) items.push([num(g.accounts_met), "target accounts met"]);
  if (g.pipeline_cents !== undefined && g.pipeline_cents !== null) items.push([dollars(g.pipeline_cents), "pipeline"]);
  if (!items.length) return <p className="mute">No goal was set.</p>;
  return <dl className="pl-figs" aria-label="Goal">{items.map(([n, w]) => <div key={w}><dd>{n}</dd><dt>{w}</dt></div>)}</dl>;
};

const StageFacts = ({ p }: { p: PlanData }) => (
  <dl className="pl-facts">
    <div><dt>Plan</dt><dd>{PLAN_WORDS[p.stage_line.plan_stage] ?? p.stage_line.plan_stage_label}</dd></div>
    <div><dt>List</dt><dd>{p.stage_line.list_stage_label}</dd></div>
    <div><dt>Waits on</dt><dd>{p.stage_line.waiting_on}</dd></div>
  </dl>
);

export function PlanTab({ id, listRows, onChange }: { id: string; listRows: number; onChange: () => void }) {
  const { actor, needs } = useActor();
  const [p, setP] = useState<PlanData | null>(null);
  const [view, setView] = useState<PV>(() => readView(actor));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const load = async () => setP(await get<PlanData>(`/api/events/${id}/plan`));
  useEffect(() => { load(); }, [id, actor]);
  useEffect(() => { setView(readView(actor)); }, [actor]);
  if (!p) return null;
  const pick = (v: PV) => { setView(v); saveView(actor, v); };
  const money_ = Boolean(p.budget);
  const isApprover = Boolean(needs?.approvers.includes(actor)) && actor !== p.approval.requested_by;
  const submitted = Boolean(p.approval.submitted_at);
  const planning = p.stage_line.plan_stage === "planning" && p.event.stage !== "declined";
  const act: { label: string; run: () => Promise<unknown> } | null =
    planning && !submitted && money_ ? { label: "Ask for approval", run: () => send("POST", `/api/events/${id}/plan/submit`, actor) }
    : planning && submitted && isApprover ? { label: "Approve the plan", run: () => send("POST", `/api/events/${id}/plan/decision`, actor, { decision: "approve" }) }
    : !planning && p.approval.over_budget && isApprover ? { label: "Approve again", run: () => send("POST", `/api/events/${id}/plan/decision`, actor, { decision: "approve" }) }
    : null;
  const go = async () => {
    if (!act) return;
    setBusy(true); setError("");
    const r = (await act.run()) as { ok: boolean; error?: string };
    setBusy(false);
    if (!r.ok) { setError(r.error ?? ""); return; }
    await load(); onChange();
  };

  const live = p.involvements.filter((i) => i.status !== "dropped");
  const b = p.budget;
  const total = b ? { planned: b.total_planned_cents, contracted: b.total_contracted_cents, actual: b.total_actual_cents } : undefined;
  const people = p.who_goes;

  /* The sections, written once and laid out three ways. */
  const reason = p.reason ? <p className="pl-said">{p.reason}</p> : <p className="mute">{p.reason_words ?? "No reason was written"}</p>;
  const taking = (
    <>
      {live.length ? <ul className="pl-rows">{live.map((i) => <InvolvementRow key={i.id} i={i} />)}</ul> : <p className="mute">Nothing planned yet.</p>}
      {p.side_events.length > 0 && <ul className="pl-rows pl-sub" aria-label="Side events">{p.side_events.map((s) => <li className="pl-row" key={s.id}><span className="pl-what"><b>{s.name}</b><span>{HOSTED_WORDS[s.hosted_format] ?? s.hosted_format}</span></span><span className="pl-end">{shortDate(s.starts_on)}</span></li>)}</ul>}
    </>
  );
  const budget = b ? <Budget cats={b.categories} total={b.categories.length > 1 ? total : undefined} aiCents={b.ai_actual_cents} /> : null;
  const who = people.length ? <ul className="pl-rows">{people.map((x) => <PersonRow key={x.id} p={x} />)}</ul> : <p className="mute">Nobody is going yet.</p>;
  const audience = (
    <ul className="pl-rows">
      <li className="pl-row"><span className="pl-what"><b>Attendee list</b></span><span className="pl-end">{listRows > 0 ? `${num(listRows)} rows` : "Not uploaded"}</span></li>
      <li className="pl-row"><span className="pl-what"><b>Assessment</b></span><span className="pl-end mute">None yet</span></li>
      <li className="pl-row"><span className="pl-what"><b>Request to the organizer</b></span><span className="pl-end mute">None yet</span></li>
    </ul>
  );
  const notes = p.notes.length > 0 && <ul className="pl-notes" aria-label="Needs a look">{p.notes.map((n) => <li key={n}>{n}</li>)}</ul>;

  const Sec = ({ title, children }: { title: string; children: ReactNode }) => <section className="pl-sec" aria-label={title}><h2>{title}</h2><div className="pl-body">{children}</div></section>;

  let body: ReactNode;
  if (view === "a") {
    body = (
      <div className="pl-ledger">
        <Sec title="Why we go">{reason}</Sec>
        <Sec title="Goal"><Goal p={p} /></Sec>
        <Sec title="Taking part">{taking}</Sec>
        {budget && <Sec title="Budget">{budget}</Sec>}
        <Sec title="Who goes">{who}</Sec>
        <Sec title="Audience">{audience}</Sec>
      </div>
    );
  } else if (view === "b") {
    const kinds = ["passes", "sponsorship", "talk", "hosted"] as const;
    const trayCats = (k: string) => (b ? b.categories.filter((c) => (TRAY_OF[c.category] ?? "") === k && live.some((i) => i.kind === k)) : []);
    const shown = new Set(kinds.flatMap((k) => trayCats(k).map((c) => c.category)));
    const otherCats = b ? b.categories.filter((c) => !shown.has(c.category)) : [];
    const loose = people.filter((x) => !live.some((i) => i.id === x.involvement_id && i.kind !== "passes"));
    body = (
      <div className="pl-cols">
        <div className="pl-main">
          <Sec title="Why we go">{reason}</Sec>
          {kinds.map((k) => live.filter((i) => i.kind === k).map((i) => (
            <Sec key={i.id} title={i.label || KIND_WORDS[k]}>
              <ul className="pl-rows"><InvolvementRow i={i} /></ul>
              {k === "passes" && people.length > 0 && <><h3 className="pl-h3">Who goes</h3><ul className="pl-rows">{loose.map((x) => <PersonRow key={x.id} p={x} />)}</ul></>}
              {k === "hosted" && people.length > 0 && <><h3 className="pl-h3">Who hosts</h3><ul className="pl-rows">{people.map((x) => <PersonRow key={x.id} p={x} withSeat={false} />)}</ul></>}
              {k !== "talk" && trayCats(k).length > 0 && <><h3 className="pl-h3">Budget</h3><Budget cats={trayCats(k)} total={trayCats(k).length > 1 ? { planned: trayCats(k).reduce((n, c) => n + c.planned_cents, 0), contracted: trayCats(k).reduce((n, c) => n + (c.contracted_cents ?? 0), 0), actual: trayCats(k).reduce((n, c) => n + (c.actual_cents ?? 0), 0) } : undefined} /></>}
            </Sec>
          )))}
          {!live.some((i) => i.kind === "passes" || i.kind === "hosted") && people.length > 0 && <Sec title="Who goes">{who}</Sec>}
          {p.side_events.length > 0 && <Sec title="Hosted events">{taking}</Sec>}
          {live.length === 0 && <Sec title="Taking part">{taking}</Sec>}
          <Sec title="Audience">{audience}</Sec>
          {b && otherCats.length > 0 && <Sec title="Other costs"><Budget cats={otherCats} aiCents={b.ai_actual_cents} /></Sec>}
        </div>
        <aside className="pl-rail" aria-label="The plan">
          <section><h2>Goal</h2><Goal p={p} /></section>
          {b && (
            <section><h2>Budget</h2>
              <dl className="pl-tot">
                <div><dt>Planned</dt><dd>{dollars(b.total_planned_cents)}</dd></div>
                <div><dt>Contracted</dt><dd>{dollars(b.total_contracted_cents)}</dd></div>
                <div><dt>Actual</dt><dd>{dollars(b.total_actual_cents)}</dd></div>
                {b.approved_budget_cents !== null && <div><dt>Approved</dt><dd>{dollars(b.approved_budget_cents)}</dd></div>}
              </dl>
            </section>
          )}
        </aside>
      </div>
    );
  } else {
    const open: string[] = [...p.notes];
    if (!p.reason) open.push("No reason was written");
    if (p.goal.meetings_held === null && p.goal.accounts_met === null && !(p.goal.pipeline_cents)) open.push("No goal was set");
    const waiting = people.filter((x) => x.seat_status === "pending").length;
    if (waiting) open.push(waiting === 1 ? "1 pass is waiting" : `${waiting} passes are waiting`);
    for (const i of live) if (i.kind === "talk" && !i.talk_title) open.push("The talk has no title yet");
    if (b && !b.lines.length) open.push("No budget lines yet");
    body = (
      <div className="pl-cols">
        <div className="pl-main">
          <section className="pl-sec" aria-label="Needs me now"><h2>Needs me now</h2><div className="pl-body">
            {open.length ? <ul className="pl-rows">{[...new Set(open)].map((t) => <li className="pl-row" key={t}><span className="pl-what"><b>{t}</b></span></li>)}</ul> : <p className="mute">Nothing is open.</p>}
          </div></section>
          <section className="pl-sec" aria-label="This week"><h2>This week</h2><div className="pl-body"><p className="mute">No deadlines yet.</p></div></section>
        </div>
        <div className="pl-main folds pl-folds">
          <Fold icon={<Icon.history />} title="Why we go" peek={p.reason ? p.reason.slice(0, 60) + (p.reason.length > 60 ? "..." : "") : "Not written"}>{reason}</Fold>
          <Fold icon={<Icon.target />} title="Goal" peek={p.result.words.length ? p.result.words.join(", ") : "No goal was set"}><Goal p={p} /></Fold>
          <Fold icon={<Icon.grid />} title="Taking part" peek={live.length ? live.map((i) => KIND_WORDS[i.kind]).join(", ") : "Nothing yet"}>{taking}</Fold>
          {b && <Fold icon={<Icon.cost />} title="Budget" peek={<>{dollars(b.total_planned_cents)} planned<i>{dollars(b.total_actual_cents)} actual</i></>}>{budget}</Fold>}
          <Fold icon={<Icon.people />} title="Who goes" peek={people.length ? `${people.length}` : "Nobody yet"}>{who}</Fold>
          <Fold icon={<Icon.lists />} title="Audience" peek={listRows > 0 ? `${num(listRows)} rows` : "List not uploaded"}>{audience}</Fold>
        </div>
      </div>
    );
  }

  return (
    <section className="plan-view" data-ready="1" data-plan-view={view}>
      <header className="pl-head">
        <StageFacts p={p} />
        <div className="pl-head-end">
          <div className="seg pl-switch" role="group" aria-label="Plan view">
            {VIEW_WORDS.map(([k, w]) => <button key={k} type="button" aria-pressed={view === k} onClick={() => pick(k)}>{w}</button>)}
          </div>
          {act && <button type="button" className="btn" disabled={busy} onClick={go}>{act.label}</button>}
        </div>
      </header>
      {error && <p role="alert" className="error small">{error}</p>}
      {view !== "c" && notes}
      {body}
    </section>
  );
}
