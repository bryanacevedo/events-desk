/* The list upload. A list is never taken without saying where it came from: the choice comes first, and the file picker waits for it. */

import { useState } from "react";
import { send } from "./api";
import { useActor } from "./App";
import { LIST_SOURCES, LIST_SOURCE_WORDS, type ListSource } from "../shared/plan";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const fileType = (name: string) => (name.toLowerCase().endsWith(".xlsx") ? XLSX : "text/csv");

export function Upload({ label, path, accept, onDone, primary, small }: { label: string; path: string; accept: string; onDone: (data?: unknown) => void; primary?: boolean; small?: boolean }) {
  const { actor } = useActor();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<ListSource | "">("");
  const [note, setNote] = useState("");
  const ready = source !== "" && (source !== "other" || note.trim() !== "");
  const pick = async (file: File | undefined) => {
    if (!file || !ready) return;
    setBusy(true); setError("");
    const r = await send("POST", path, actor, undefined, { bytes: await file.arrayBuffer(), filename: file.name, type: fileType(file.name), headers: { "x-list-source": source, ...(note.trim() ? { "x-source-note": encodeURIComponent(note.trim()) } : {}) } });
    setBusy(false);
    if (r.ok) onDone(r.data); else setError(r.error);
  };
  return (
    <div className="actions up-source">
      <label className="field up-pick"><span>Where the list came from</span>
        <select className="input" value={source} onChange={(e) => setSource(e.target.value as ListSource | "")}>
          <option value="">Choose one</option>
          {LIST_SOURCES.map((k) => <option key={k} value={k}>{LIST_SOURCE_WORDS[k]}</option>)}
        </select>
      </label>
      {source === "other" && <label className="field up-pick"><span>Where from</span><input className="input" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} autoComplete="off" /></label>}
      <label className={`btn${primary ? "" : " line"}${small ? " small" : ""}${ready ? "" : " is-off"}`} aria-disabled={!ready}>{busy ? "Reading the file…" : label}<input className="sr-only" type="file" accept={accept} aria-label={label} onChange={(ev) => pick(ev.target.files?.[0])} disabled={busy || !ready} /></label>
      {error && <p role="alert" className="error">{error}</p>}
    </div>
  );
}
