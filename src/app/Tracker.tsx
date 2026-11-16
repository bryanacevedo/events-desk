/* The meeting goal tracker, a block in the Plan tab's Goal section (docs/CHOOSING.md section 5). Counts only, no money, for anyone who can read the event.
   The server writes the words line; the bar says what it measures on the bar, as the Results bars do. */

import { useEffect, useState } from "react";
import type { GoalTracker } from "../server/goal-tracker";
import { get } from "./api";
import { ShowMore } from "./Patterns";
import { num } from "./words";

const SHOWN = 5;

export function Tracker({ id, stamp }: { id: string; stamp?: unknown }) {
  const [t, setT] = useState<GoalTracker | null>(null), [all, setAll] = useState(false);
  useEffect(() => { let on = true; get<GoalTracker>(`/api/events/${id}/goal-tracker`).then((d) => { if (on) setT(d); }); return () => { on = false; }; }, [id, stamp]);
  if (!t || t.goal === null || t.goal === undefined || !t.words) return null;
  const counted = t.counted ?? 0, reps = t.by_rep ?? [];
  const shown = all ? reps : reps.slice(0, SHOWN);
  return (
    <div className="tr" aria-label="Meeting goal tracker">
      <p className="tr-words">{t.words}</p>
      <div className="rs-ratio" role="img" aria-label={`${counted} of ${t.goal} meetings`}><i aria-hidden="true"><u style={{ "--w": Math.min(1, counted / t.goal) } as React.CSSProperties} /></i><b>{num(counted)} of {num(t.goal)}</b></div>
      {(reps.length > 0 || (t.no_rep ?? 0) > 0) && (
        <ul className="tr-reps" aria-label="By rep">
          {shown.map((r) => (
            <li key={r.rep} className="tr-rep">
              <b>{r.rep}</b>
              <span>{num(r.held)} held</span>
              <span>{r.nothing_booked ? <span className="pl-strong">Nothing booked</span> : `${num(r.booked)} booked`}</span>
            </li>
          ))}
          {(t.no_rep ?? 0) > 0 && <li className="tr-rep"><b>No rep named</b><span /><span>{num(t.no_rep!)} counted</span></li>}
        </ul>
      )}
      {reps.length > SHOWN && <ShowMore open={all} n={reps.length} onClick={() => setAll(!all)} noun="people" />}
      {t.accounts && (
        <dl className="pl-figs tr-acc" aria-label="Accounts met"><div><dd>{num(t.accounts.actual)} of {num(t.accounts.goal)}</dd><dt>target accounts met, {t.accounts.caption}</dt></div></dl>
      )}
    </div>
  );
}
