/* The list upload. A list is never taken without saying where it came from: the choice comes first, and the file picker waits for it. */

import { useState } from "react";
import { send } from "./api";
import { useActor } from "./App";
import { LIST_SOURCES, LIST_SOURCE_WORDS } from "../shared/plan";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const fileType = (name: string) => (name.toLowerCase().endsWith(".xlsx") ? XLSX : "text/csv");

/** `sources` swaps the list-source choice for another set of choices (the hosted import asks Luma or Splash) sent under `sourceHeader`; the file waits for the choice either way. */
export function Upload({ label, path, accept, onDone, primary, small, question, sources, sourceHeader }: { label: string; path: string; accept: string; onDone: (data?: unknown) => void; primary?: boolean; small?: boolean; question?: string; sources?: { value: string; label: string }[]; sourceHeader?: string }) {
  const { actor } = useActor();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<string>("");
  const [note, setNote] = useState("");
  const ready = source !== "" && (sources || source !== "other" || note.trim() !== "");
  const pick = async (file: File | undefined) => {
    if (!file || !ready) return;
    setBusy(true); setError("");
    const r = await send("POST", path, actor, undefined, { bytes: await file.arrayBuffer(), filename: file.name, type: fileType(file.name), headers: { [sourceHeader ?? "x-list-source"]: source, ...(note.trim() ? { "x-source-note": encodeURIComponent(note.trim()) } : {}) } });
    setBusy(false);
    if (r.ok) onDone(r.data); else setError(r.error);
  };
  return (
    <div className="actions up-source">
      <label className="field up-pick"><span>{question ?? "Where the list came from"}</span>
        <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Choose one</option>
          {(sources ?? LIST_SOURCES.map((k) => ({ value: k, label: LIST_SOURCE_WORDS[k] }))).map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
      </label>
      {!sources && source === "other" && <label className="field up-pick"><span>Where from</span><input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} autoComplete="off" /></label>}
      <label className={`btn${primary ? "" : " line"}${small ? " small" : ""}${ready ? "" : " is-off"}`} aria-disabled={!ready}>{busy ? "Reading the file…" : label}<input className="sr-only" type="file" accept={accept} aria-label={label} onChange={(ev) => pick(ev.target.files?.[0])} disabled={busy || !ready} /></label>
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}
