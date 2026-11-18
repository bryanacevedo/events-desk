/* Sponsorship on the Plan tab: the package, the deliverables by due date, and what was promised against what arrived. Rows edit in place, the way the budget lines do.
   A planner changes anything. The person a deliverable is assigned to marks their own done. Prices are leadership's and planners', and the server sends a rep none. */

import { useRef, useState, type ReactNode } from "react";
import { send, type PlanData, type PlanDeliverable, type PlanPromise } from "./api";
import { PEOPLE, useActor } from "./App";
import { Editable, Form } from "./PlanEdit";
import { DELIVERABLE_KINDS, PROMISE_ITEMS } from "../shared/plan";
import { money, shortDate } from "./words";

const KIND_WORDS: Record<string, string> = { logo_copy: "Logo and copy", booth_graphics: "Booth graphics", staff_badges: "Staff badges", sponsor_session: "Sponsor session or side event", freight: "Freight", electrical: "Electrical", internet: "Internet", lead_retrieval: "Lead retrieval", other: "Other" };
const ITEM_WORDS: Record<string, string> = { passes: "Passes", booth: "Booth", talk: "Talk", logo: "Logo", lead_retrieval: "Lead retrieval", attendee_list: "Attendee list", meeting_rooms: "Meeting rooms", side_event: "Side event", other: "Other" };
const wholeDollars = (cents: number | null | undefined) => (cents === null || cents === undefined ? "" : String(Math.round(cents / 100)));
const toCents = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));
const dateOrNull = (v: string) => (v.trim() === "" ? null : v);
const day = (ymd: string) => shortDate(ymd);
const numStr = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

type Pkg = NonNullable<PlanData["sponsorship"]>;

function PackageEditor({ id, pkg, done, saved }: { id: string; pkg: Pkg; done: () => void; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [f, setF] = useState({ tier: pkg.tier_name, price: wholeDollars(pkg.price_cents), signed: pkg.contract_signed_on ?? "", deposit: wholeDollars(pkg.deposit_cents), depositDue: pkg.deposit_due_on ?? "", depositPaid: pkg.deposit_paid_on ?? "", balanceDue: pkg.balance_due_on ?? "", balancePaid: pkg.balance_paid_on ?? "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Form onCancel={done} onSave={async () => {
      const r = await send("PUT", `/api/events/${id}/sponsorships/${pkg.involvement_id}`, actor, {
        tier: f.tier, price_cents: toCents(f.price) ?? 0, contract_signed_on: dateOrNull(f.signed), deposit_cents: toCents(f.deposit),
        deposit_due_on: dateOrNull(f.depositDue), deposit_paid_on: dateOrNull(f.depositPaid), balance_due_on: dateOrNull(f.balanceDue), balance_paid_on: dateOrNull(f.balancePaid),
      });
      if (r.ok) { await saved(); done(); }
      return r;
    }}>
      <div className="pl-edit-grid">
        <label className="field"><span>Tier</span><input className="input" value={f.tier} maxLength={60} onChange={set("tier")} autoComplete="off" /></label>
        <label className="field"><span>Price, dollars</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={f.price} onChange={set("price")} /></label>
        <label className="field"><span>Contract signed</span><input className="input" type="date" value={f.signed} onChange={set("signed")} /></label>
        <label className="field"><span>Deposit, dollars</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={f.deposit} onChange={set("deposit")} /></label>
        <label className="field"><span>Deposit due</span><input className="input" type="date" value={f.depositDue} onChange={set("depositDue")} /></label>
        <label className="field"><span>Deposit paid</span><input className="input" type="date" value={f.depositPaid} onChange={set("depositPaid")} /></label>
        <label className="field"><span>Balance due</span><input className="input" type="date" value={f.balanceDue} onChange={set("balanceDue")} /></label>
        <label className="field"><span>Balance paid</span><input className="input" type="date" value={f.balancePaid} onChange={set("balancePaid")} /></label>
      </div>
    </Form>
  );
}

function Package({ pkg }: { pkg: Pkg }) {
  const facts: [string, string][] = [
    ["Tier", pkg.tier_name || "No tier yet"],
    ...(pkg.price_cents !== undefined ? [["Price", money(pkg.price_cents)] as [string, string]] : []),
    ["Contract", pkg.contract_signed_on ? `Signed ${day(pkg.contract_signed_on)}` : "Not signed"],
    ["Deposit", pkg.deposit_paid_on ? `Paid ${day(pkg.deposit_paid_on)}` : pkg.deposit_due_on ? `Due ${day(pkg.deposit_due_on)}` : "No date yet"],
    ["Balance", pkg.balance_paid_on ? `Paid ${day(pkg.balance_paid_on)}` : pkg.balance_due_on ? `Due ${day(pkg.balance_due_on)}` : "No date yet"],
  ];
  return <dl className="pl-facts">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

/** One deliverable as a row: what, who, when. Done reads as a word. The owner (or a planner) marks it done in place. */
function DeliverableLine({ id, d, planner, saved }: { id: string; d: PlanDeliverable; planner: boolean; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const mine = d.owner !== "" && d.owner === actor;
  const toggle = async () => {
    setBusy(true); setError("");
    const r = await send("PATCH", `/api/events/${id}/deliverables/${d.id}`, actor, { done: !d.done });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    await saved();
  };
  return (
    <li className="pl-row" aria-label={d.label}>
      <span className="pl-what"><b>{d.label}</b><span>{d.owner || "No owner yet"}</span></span>
      <span className={`pl-end${d.group === "late" || d.group === "today" ? " pl-strong" : ""}`}>
        {d.due_words}
        {!d.done && (mine || planner) && <button type="button" className="btn line small pl-inline" disabled={busy} onClick={toggle} aria-label={`Mark ${d.label} done`}>Mark done</button>}
        {d.done && planner && <button type="button" className="btn line small pl-inline" disabled={busy} onClick={toggle} aria-label={`Reopen ${d.label}`}>Reopen</button>}
      </span>
      {error && <p role="alert" className="error small pl-line-err">{error}</p>}
    </li>
  );
}

function DeliverableEdit({ id, d, saved }: { id: string; d: PlanDeliverable | null; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [f, setF] = useState({ kind: d?.kind ?? "other", label: d?.label ?? "", owner: d?.owner ?? "", due: d?.due_on ?? "" });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const dirty = !d || f.label !== d.label || f.owner !== d.owner || f.due !== (d.due_on ?? "");
  const save = async () => {
    setBusy(true); setError("");
    const body = { kind: f.kind, label: f.label, owner: f.owner, due_on: dateOrNull(f.due) };
    const r = d ? await send("PATCH", `/api/events/${id}/deliverables/${d.id}`, actor, body) : await send("POST", `/api/events/${id}/deliverables`, actor, body);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    if (!d) setF({ kind: "other", label: "", owner: "", due: "" });
    await saved();
  };
  return (
    <li className={`pl-line${d ? " pl-nokind" : ""}`} aria-label={d ? d.label : "New deliverable"}>
      {!d && <label className="field"><span>Kind</span><select className="input" value={f.kind} onChange={set("kind")}>{DELIVERABLE_KINDS.map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}</select></label>}
      <label className="field"><span>Deliverable</span><input className="input" value={f.label} maxLength={120} onChange={set("label")} autoComplete="off" /></label>
      <label className="field"><span>Owner</span><input className="input" list="deliverable-owners" value={f.owner} maxLength={80} onChange={set("owner")} autoComplete="off" /></label>
      <label className="field"><span>Due</span><input className="input" type="date" value={f.due} onChange={set("due")} /></label>
      <div className="actions pl-line-end"><button type="button" className="btn line small" disabled={busy || !dirty || f.label.trim() === ""} onClick={save}>{d ? "Save deliverable" : "Add deliverable"}</button></div>
      {error && <p role="alert" className="error small pl-line-err">{error}</p>}
    </li>
  );
}

function PromiseEdit({ id, pr, saved }: { id: string; pr: PlanPromise | null; saved: () => Promise<void> }) {
  const { actor } = useActor();
  const [f, setF] = useState({ item: pr?.item ?? "attendee_list", label: pr?.label ?? "", promised: numStr(pr?.promised_qty), received: numStr(pr?.received_qty), on: pr?.received_on ?? "" });
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true); setError("");
    const body = { item: f.item, label: f.label, promised_qty: f.promised === "" ? null : Number(f.promised), received_qty: f.received === "" ? null : Number(f.received), received_on: dateOrNull(f.on) };
    const r = pr ? await send("PATCH", `/api/events/${id}/promises/${pr.id}`, actor, body) : await send("POST", `/api/events/${id}/promises`, actor, body);
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    if (!pr) setF({ item: "attendee_list", label: "", promised: "", received: "", on: "" });
    await saved();
  };
  return (
    <li className="pl-line" aria-label={pr ? pr.label : "New promise"}>
      <label className="field"><span>Item</span><select className="input" value={f.item} onChange={set("item")}>{PROMISE_ITEMS.map((k) => <option key={k} value={k}>{ITEM_WORDS[k]}</option>)}</select></label>
      <label className="field"><span>Promised</span><input className="input" value={f.label} maxLength={120} onChange={set("label")} autoComplete="off" /></label>
      <label className="field"><span>How many</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={f.promised} onChange={set("promised")} placeholder="Not counted" /></label>
      <label className="field"><span>Received</span><input className="input" type="number" min="0" step="1" inputMode="numeric" value={f.received} onChange={set("received")} /></label>
      <label className="field"><span>Arrived on</span><input className="input" type="date" value={f.on} onChange={set("on")} /></label>
      <div className="actions pl-line-end"><button type="button" className="btn line small" disabled={busy || f.label.trim() === ""} onClick={save}>{pr ? "Save promise" : "Add promise"}</button></div>
      {error && <p role="alert" className="error small pl-line-err">{error}</p>}
    </li>
  );
}

/** The rows keep the order they had when the editor opened, so saving a due date does not make a row jump. The owner offers the team's names. */
function DeliverablesEditor({ id, items, saved, done }: { id: string; items: PlanDeliverable[]; saved: () => Promise<void>; done: ReactNode }) {
  const order = useRef(items.map((d) => d.id));
  const rank = (d: PlanDeliverable) => { const i = order.current.indexOf(d.id); if (i >= 0) return i; order.current.push(d.id); return order.current.length - 1; };
  const rows = [...items].sort((a, b) => rank(a) - rank(b));
  return (
    <div className="pl-edit">
      <ul className="pl-lines" aria-label="Deliverables">{rows.map((d) => <DeliverableEdit key={d.id} id={id} d={d} saved={saved} />)}<DeliverableEdit key={`new-${items.length}`} id={id} d={null} saved={saved} /></ul>
      <datalist id="deliverable-owners">{PEOPLE.map((p) => <option key={p} value={p} />)}</datalist>
      {done}
    </div>
  );
}

/** The whole sponsorship section. */
export function SponsorBlock({ id, p, canEdit, saved }: { id: string; p: PlanData; canEdit: boolean; saved: () => Promise<void> }) {
  const pkg = p.sponsorship;
  if (!pkg) return <p className="mute">No package yet.</p>;
  const finish = (close: () => void) => <div className="actions"><button type="button" className="btn line small" onClick={close}>Done</button></div>;
  return (
    <>
      <Editable can={canEdit} label="Edit the package" view={<Package pkg={pkg} />} editor={(close) => <PackageEditor id={id} pkg={pkg} done={close} saved={saved} />} />
      <h3 className="pl-h3">Deliverables</h3>
      <Editable can={canEdit} label="Edit deliverables"
        view={p.deliverables.length ? <ul className="pl-rows">{p.deliverables.map((d) => <DeliverableLine key={d.id} id={id} d={d} planner={canEdit} saved={saved} />)}</ul> : <p className="mute">No deliverables yet.</p>}
        editor={(close) => <DeliverablesEditor id={id} items={p.deliverables} saved={saved} done={finish(close)} />} />
      <h3 className="pl-h3">Promised and received</h3>
      <Editable can={canEdit} label="Edit promises"
        view={p.promises.length ? <ul className="pl-rows">{p.promises.map((x) => <li className="pl-row" key={x.id}><span className="pl-what"><b>{x.words}</b></span></li>)}</ul> : <p className="mute">Nothing promised yet.</p>}
        editor={(close) => <div className="pl-edit"><ul className="pl-lines" aria-label="Promises">{p.promises.map((x) => <PromiseEdit key={x.id} id={id} pr={x} saved={saved} />)}<PromiseEdit key={`new-${p.promises.length}`} id={id} pr={null} saved={saved} /></ul>{finish(close)}</div>} />
    </>
  );
}
