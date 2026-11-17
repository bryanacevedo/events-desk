/* What stands where a page will be while it loads: the page's own shape in grey, never a blank screen and never the word "Loading" alone.
   The words stay for a screen reader. The grey bars are still under reduced motion; otherwise a slow light wash crosses them. */

import { LOADING } from "./access";

/** A page: a heading bar, a line under it, and `rows` list rows. */
export function PageSkeleton({ rows = 6, label = LOADING }: { rows?: number; label?: string }) {
  return (
    <div className="sk" role="status" aria-busy="true" aria-live="polite" data-skeleton="page">
      <span className="sr-only">{label}</span>
      <div className="sk-bar sk-h" aria-hidden="true" />
      <div className="sk-bar sk-sub" aria-hidden="true" />
      <div className="sk-rows" aria-hidden="true">{Array.from({ length: rows }, (_, i) => <div key={i} className="sk-row"><i className="sk-bar sk-dot" /><span className="sk-bar sk-line" style={{ width: `${62 - (i % 3) * 14}%` }} /><span className="sk-bar sk-end" /></div>)}</div>
    </div>
  );
}

/** A block inside a page that has its own read still coming: a few grey rows in the space it will fill. */
export function BlockSkeleton({ rows = 3, label = LOADING }: { rows?: number; label?: string }) {
  return (
    <div className="sk sk-block" role="status" aria-busy="true" aria-live="polite" data-skeleton="block">
      <span className="sr-only">{label}</span>
      <div className="sk-rows" aria-hidden="true">{Array.from({ length: rows }, (_, i) => <div key={i} className="sk-row"><span className="sk-bar sk-line" style={{ width: `${70 - (i % 3) * 16}%` }} /></div>)}</div>
    </div>
  );
}

/** An empty place says what goes here and shows one line of what it looks like once something does. The example is marked as one. */
export function Empty({ what, example, className = "" }: { what: string; example: string; className?: string }) {
  return (
    <div className={`empty-ex ${className}`.trim()}>
      <p className="mute">{what}</p>
      <p className="ex"><b>Example</b> {example}</p>
    </div>
  );
}
