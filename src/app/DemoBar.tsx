/* The slim bar at the top of every screen of the sample desk: what this is, what happens to a change, and which day the sample was built around.
   It says what is true of this desk. The public demo takes changes (they live in the running copy and are shared with the next visitor, until it restarts)
   and refuses files; its refusal says "This public demo does not take files", so the bar uses the same words. Dismissed for the session with Hide. The static snapshot (decision 109) keeps its note on a wide screen, since it says the page is a snapshot; on a phone it can be hidden. */

import { useState } from "react";
import type { Sample } from "./App";

const KEY = "demo-bar-hidden";
const hidden = () => { try { return sessionStorage.getItem(KEY) === "1"; } catch { return false; } };

/** "Tue 24 Nov 2026", read as a calendar day with no time zone shift. */
export const sampleDayWords = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** The words, as a list of sentences, so a test reads them without drawing the bar. */
export function demoBarWords(sample: Sample): string[] {
  return [
    "A sample company with invented data.",
    sample.snapshot ? `This is a read-only snapshot. Nothing you change is saved, and files and searches inside a list are not in it.` : sample.publicDemo ? "A change is shared with the next visitor and is gone when the demo restarts. This public demo does not take files." : "A change is gone when the demo restarts.",
    sample.day && sample.snapshot ? `Today in the sample is ${sampleDayWords(sample.day)}.` : sample.day ? `Sample events are set around ${sampleDayWords(sample.day)}; days to go count from today.` : "Days to go count from today.",
  ];
}

export function DemoBar({ sample }: { sample: Sample }) {
  const [off, setOff] = useState(hidden);
  if (off && !sample.snapshot) return null;
  const snap = Boolean(sample.snapshot);
  const [who, change, day] = demoBarWords(sample);
  return (
    <div className={`demo-bar${snap ? " snap" : ""}${snap && off ? " off" : ""}`} role="note" aria-label="About this demo">
      <p><b>Sample.</b> {who} {change} {day}</p>
      <button type="button" onClick={() => { try { sessionStorage.setItem(KEY, "1"); } catch { /* private window */ } setOff(true); }}>Hide</button>
    </div>
  );
}
