/* Editing the plan in place (docs/EVENT-PLAN.md section 9): the reason, the goal, the budget lines, who goes, the ways of taking part, and the decline.
   Each editor opens where the thing is read, saves with one button, and closes. The server decides who may write; the screen only hides what a rep cannot use. */

import { useState, type ReactNode } from "react";
import { send, type PlanData } from "./api";
import { useActor } from "./App";
import { BUDGET_CATEGORIES, BUDGET_WORDS, PERSON_ROLES } from "../shared/plan";

const ROLE_WORDS: Record<string, string> = { attend: "Attend", host: "Host", speak: "Speak" };
const KIND_CHOICES: [string, string][] = [["passes", "Passes"], ["sponsorship", "Sponsorship"], ["talk", "Talk"]];
const wholeDollars = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : String(Math.round(cents / 100)));
const toCents = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));

/** A view with a button that swaps it for its editor. Nothing is drawn for a person who cannot edit. */
export function Editable({ can, label, view, editor }: { can: boolean; label: string; view: ReactNode; editor: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  if (open && can) return <>{editor(() => setOpen(false))}</>;
  return (
    <>
      {view}
      {can && <div className="pl-edit-row"><button type="button" className="btn line small" onClick={() => setOpen(true)}>{label}</button></div>}
    </>
  );
}

/** One editor's save and cancel, and its one sentence of error. */
function Form({ onSave, onCancel, saveWord = "Save", children, ready = true }: { onSave: () => Promise<{ ok: boolean; error?: string } | { ok: true } | { ok: false; error: string }>; onCancel: () => void; saveWord?: string; children: ReactNode; ready?: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submit = async (ev: { preventDefault(): void }) => {
    ev.preventDefault();
    setBusy(true); setError("");
    const r = (await onSave()) as { ok: boolean; error?: string };
    setBusy(false);
    if (!r.ok) setError(r.error ?? "That did not go through. Try again.");
  };
  return (
    <form className="pl-edit" onSubmit={submit}>
      {children}
      {error && <p role="alert" className="error small">{error}</p>}
      <div className="actions"><button type="submit" className="btn small" disabled={busy || !ready}>{busy ? "Saving…" : saveWord}</button><button type="button" className="btn line small" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

export function ReasonEditor({ id, value, done, saved }: { id: string; value: string; done: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [v, setV] = useState(value);
  return (
    <Form onCancel={done} ready={v.trim() !== value.trim()} onSave={async () => { const r = await send("PATCH", `/api/events/${id}/plan`, actor, { reason: v }); if (r.ok) { await saved(); done(); } return r; }}>
      <label className="field"><span>Why we go</span><textarea className="input itext" rows={4} maxLength={1200} value={v} onChange={(e) => setV(e.target.value)} /></label>
    </Form>
  );
}

export function GoalEditor({ id, goal, withPipeline, done, saved }: { id: string; goal: PlanData["goal"]; withPipeline: boolean; done: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [m, setM] = useState(goal.meetings_held === null ? "" : String(goal.meetings_held));
  const [a, setA] = useState(goal.accounts_met === null ? "" : String(goal.accounts_met));
  const [p, setP] = useState(wholeDollars(goal.pipeline_cents));
  const count = (v: string) => (v.trim() === "" ? null : Number(v));
  return (
    <Form onCancel={done} onSave={async () => {
      const body: Record<string, number | null> = { goal_meetings_held: count(m), goal_accounts_met: count(a) };
      if (withPipeline) body.goal_pipeline_cents = toCents(p);
      const r = await send("PATCH", `/api/events/${id}/plan`, actor, body);
      if (r.ok) { await saved(); done(); }
      return r;
    }}>
      <div className="pl-edit-grid">
        <label className="field"><span>Meetings held</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={m} onChange={(e) => setM(e.target.value)} /></label>
        <label className="field"><span>Target accounts met</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={a} onChange={(e) => setA(e.target.value)} /></label>
        {withPipeline && <label className="field"><span>Pipeline, dollars</span><input className="input" type="number" min="0" step="1000" inputMode="numeric" value={p} onChange={(e) => setP(e.target.value)} /></label>}
      </div>
    </Form>
  );
}

type Line = NonNullable<PlanData["budget"]>["lines"][number];

function LineRow({ id, line, saved }: { id: string; line: Line | null; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [f, setF] = useState({ category: line?.category ?? "passes", label: line?.label ?? "", planned: wholeDollars(line?.planned_cents), contracted: wholeDollars(line?.contracted_cents) });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const dirty = !line || f.category !== line.category || f.label !== line.label || f.planned !== wholeDollars(line.planned_cents) || f.contracted !== wholeDollars(line.contracted_cents);
  const body = () => ({ category: f.category, label: f.label, planned_cents: toCents(f.planned) ?? 0, contracted_cents: toCents(f.contracted) });
  const save = async () => {
    setBusy(true); setError("");
    const r = line ? await send("PUT", `/api/events/${id}/budget-lines/${line.id}`, actor, body()) : await send("POST", `/api/events/${id}/budget-lines`, actor, body());
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    if (!line) setF({ category: "passes", label: "", planned: "", contracted: "" });
    await saved();
  };
  const remove = async () => {
    if (!line) return;
    setBusy(true); setError("");
    const r = await send("DELETE", `/api/events/${id}/budget-lines/${line.id}`, actor);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    await saved();
  };
  const name = line ? `${BUDGET_WORDS[line.category as keyof typeof BUDGET_WORDS] ?? line.category}${line.label ? `, ${line.label}` : ""}` : "New line";
  return (
    <li className="pl-line" aria-label={name}>
      <label className="field"><span>Line</span><select className="input" value={f.category} onChange={set("category")}>{BUDGET_CATEGORIES.map((c) => <option key={c} value={c}>{BUDGET_WORDS[c]}</option>)}</select></label>
      <label className="field"><span>Note</span><input className="input" value={f.label} maxLength={120} onChange={set("label")} autoComplete="off" /></label>
      <label className="field"><span>Planned, dollars</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={f.planned} onChange={set("planned")} /></label>
      <label className="field"><span>Contracted, dollars</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={f.contracted} onChange={set("contracted")} placeholder="Not contracted" /></label>
      <div className="actions pl-line-end">
        <button type="button" className="btn line small" disabled={busy || !dirty || f.planned === ""} onClick={save}>{line ? "Save line" : "Add line"}</button>
        {line && <button type="button" className="btn line small" disabled={busy} onClick={remove}>Remove</button>}
      </div>
      {error && <p role="alert" className="error small pl-line-err">{error}</p>}
    </li>
  );
}

/** Each line saves by itself, so a change is never lost to a Cancel; the closing button only closes. */
export function LinesEditor({ id, lines, done, saved }: { id: string; lines: Line[]; done: () => void; saved: () => Promise<void> }) {
  return (
    <div className="pl-edit">
      <ul className="pl-lines" aria-label="Budget lines">
        {lines.map((l) => <LineRow key={l.id} id={id} line={l} saved={saved} />)}
        <LineRow key={`new-${lines.length}`} id={id} line={null} saved={saved} />
      </ul>
      <div className="actions"><button type="button" className="btn line small" onClick={done}>Done</button></div>
    </div>
  );
}

export function PersonEditor({ id, hosted, done, saved }: { id: string; hosted: boolean; done: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [f, setF] = useState({ person: "", team: "", role_title: "", role: hosted ? "host" : "attend" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const needsPass = !hosted && f.role === "attend";
  const ready = f.person.trim() !== "" && (!needsPass || (f.team.trim() !== "" && f.role_title.trim() !== ""));
  return (
    <Form saveWord="Add person" ready={ready} onCancel={done} onSave={async () => {
      const r = await send("POST", `/api/events/${id}/people`, actor, { person: f.person, team: f.team, role_title: f.role_title, roles: [f.role], needs_pass: needsPass });
      if (r.ok) { await saved(); done(); }
      return r;
    }}>
      <div className="pl-edit-grid">
        <label className="field"><span>Name</span><input className="input" value={f.person} onChange={set("person")} autoComplete="off" /></label>
        <label className="field"><span>Team</span><input className="input" value={f.team} onChange={set("team")} autoComplete="off" /></label>
        <label className="field"><span>Job</span><input className="input" value={f.role_title} onChange={set("role_title")} autoComplete="off" /></label>
        {!hosted && <label className="field"><span>Part</span><select className="input" value={f.role} onChange={set("role")}>{PERSON_ROLES.map((r) => <option key={r} value={r}>{ROLE_WORDS[r]}</option>)}</select></label>}
      </div>
    </Form>
  );
}

export function InvolvementEditor({ id, have, done, saved }: { id: string; have: string[]; done: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const choices = KIND_CHOICES.filter(([k]) => !have.includes(k) || k === "talk");
  const [kind, setKind] = useState(choices[0]?.[0] ?? "passes");
  const [count, setCount] = useState("");
  const [label, setLabel] = useState("");
  if (!choices.length) return <p className="mute">Every way of taking part is on the plan.</p>;
  return (
    <Form saveWord="Add" ready={kind !== "passes" || count !== ""} onCancel={done} onSave={async () => {
      const r = await send("POST", `/api/events/${id}/involvements`, actor, { kind, label, ...(kind === "passes" ? { pass_count: Number(count) } : {}), ...(kind === "talk" ? { talk_title: "", speaker: "" } : {}) });
      if (r.ok) { await saved(); done(); }
      return r;
    }}>
      <div className="pl-edit-grid">
        <label className="field"><span>Way of taking part</span><select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>{choices.map(([k, w]) => <option key={k} value={k}>{w}</option>)}</select></label>
        {kind === "passes" && <label className="field"><span>How many passes</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} /></label>}
        <label className="field"><span>Note</span><input className="input" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} autoComplete="off" /></label>
      </div>
    </Form>
  );
}

/** The approver's second choice. It asks for the reason the server demands, and nothing else. */
export function DeclineBox({ id, saved }: { id: string; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [open, setOpen] = useState(false), [why, setWhy] = useState("");
  if (!open) return <button type="button" className="btn line" onClick={() => setOpen(true)}>Decline</button>;
  return (
    <Form saveWord="Decline the plan" ready={why.trim().length >= 3} onCancel={() => { setOpen(false); setWhy(""); }} onSave={async () => {
      const r = await send("POST", `/api/events/${id}/plan/decision`, actor, { decision: "decline", reason: why });
      if (r.ok) await saved();
      return r;
    }}>
      <label className="field"><span>Why it is declined</span><textarea className="input itext" rows={3} maxLength={300} value={why} onChange={(e) => setWhy(e.target.value)} autoFocus /></label>
    </Form>
  );
}
