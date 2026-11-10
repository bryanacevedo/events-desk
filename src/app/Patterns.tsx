/* Shared patterns from the Look and copy rule. A warning sits inside the data it qualifies, compact and
   in a set form ("$63,992 over Q4"), never a colored sentence under a row. A row with more to show
   opens itself with a quiet chevron, never a lone underlined word. */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { money } from "./words";

export function Chevron({ open = false, right = false }: { open?: boolean; right?: boolean }) {
  return (
    <svg className={`chev${open ? " open" : ""}${right ? " right" : ""}`} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
    </svg>
  );
}

/** A figure that qualifies the data beside it: `<Flag cents={-63992_00} words="over Q4" over />` reads "$63,992 over Q4". */
export function Flag({ cents, words, over = false, className = "" }: { cents: number; words: string; over?: boolean; className?: string }) {
  return <span className={`fig${over ? " over" : ""} ${className}`.trim()}><b>{money(Math.abs(cents))}</b> <span className="fig-w">{words}</span></span>;
}

/** A row that opens itself. `head` is the row and the control; `side` holds buttons and inputs that must not toggle it; children are what opens. */
export function ExpandRow({ head, side, children, className = "", label, defaultOpen = false }: { head: ReactNode; side?: ReactNode; children: ReactNode; className?: string; label?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  const onKey = (ev: KeyboardEvent) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setOpen(!open); } };
  return (
    <div className={`xrow${open ? " open" : ""} ${className}`.trim()}>
      <div className="xrow-head" role="button" tabIndex={0} aria-expanded={open} aria-controls={id} aria-label={label} onClick={() => setOpen(!open)} onKeyDown={onKey}>
        {head}
        <Chevron open={open} />
      </div>
      {side && <div className="xrow-side">{side}</div>}
      <div id={id} className="xrow-more" hidden={!open}>{children}</div>
    </div>
  );
}

/** Opens the outreach list in Google Sheets: a small sheet of cells that fills in row by row while a color sweeps across the button. */
export function SheetButton({ href, compact = false, label }: { href: string; compact?: boolean; label?: string }) {
  const cells = [[4, 5], [8.5, 5], [13, 5], [4, 9.5], [8.5, 9.5], [13, 9.5], [4, 14], [8.5, 14], [13, 14]];
  return (
    <a className={`sheetbtn${compact ? " compact" : ""}`} href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
      <span className="sb-tile" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 21 21">{cells.map(([x, y], i) => <rect key={i} x={x} y={y} width="3.6" height="3.1" rx="0.7" style={{ "--c": i } as React.CSSProperties} />)}</svg>
      </span>
      <span className="sb-word">{compact ? "Sheet" : "Open the sheet"}</span>
      <span className="sb-arrow" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3.5 10.5 10.5 3.5M5 3.5h5.5V9" /></svg></span>
    </a>
  );
}

/** Downloads a file: a small page whose lines write in one by one while a color sweeps across the button and the arrow drops. Same family as SheetButton. */
export function FileButton({ href, label }: { href: string; label: string }) {
  const lines = [[6, 8.5, 9], [6, 12, 9], [6, 15.5, 6]];
  return (
    <a className="filebtn" href={href} download>
      <span className="fb-tile" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 21 21" fill="none">
          <path className="fb-page" d="M4.5 3.2c0-.7.5-1.2 1.2-1.2h6.1l4.7 4.7v11.1c0 .7-.5 1.2-1.2 1.2H5.7c-.7 0-1.2-.5-1.2-1.2z" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          {lines.map(([x, y, w], i) => <rect key={i} className="fb-line" x={x + 0.5} y={y} width={w} height="1.7" rx="0.85" fill="currentColor" style={{ "--c": i } as React.CSSProperties} />)}
        </svg>
      </span>
      <span className="fb-word">{label}</span>
      <span className="fb-arrow" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 2.5v7.5M3.8 7.2 7 10.4l3.2-3.2M3 12h8" /></svg></span>
    </a>
  );
}

/** A choice that cannot be taken back, asked before it is made. Focus is held inside; Esc, the scrim and the quiet button close it.
    `confirm` is the word on the filled button, `cancel` on the quiet one; the body says exactly what will happen. */
export function ConfirmDialog({ title, confirm, cancel = "Go back", busy = false, error = "", onConfirm, onClose, children }: { title: string; confirm: string; cancel?: string; busy?: boolean; error?: string; onConfirm: () => void; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    const FOCUSABLE = "button:not([disabled])";
    box.current?.querySelector<HTMLElement>("[data-keep]")?.focus();
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === "Escape") { ev.preventDefault(); if (!busy) onClose(); return; }
      if (ev.key !== "Tab" || !box.current) return;
      const els = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("dlg-open");
    const back = document.activeElement as HTMLElement | null;
    return () => { document.removeEventListener("keydown", onKey); document.body.classList.remove("dlg-open"); back?.focus?.(); };
  }, [busy, onClose]);
  return createPortal(
    <div className="dlg-scrim" onMouseDown={(ev) => { if (ev.target === ev.currentTarget && !busy) onClose(); }}>
      <div className="dlg" ref={box} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`}>
        <h2 id={`${id}-t`} className="display">{title}</h2>
        <div id={`${id}-d`} className="dlg-body">{children}</div>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="actions">
          <button className="btn warm" type="button" disabled={busy} onClick={onConfirm}>{confirm}</button>
          <button className="btn line" type="button" data-keep disabled={busy} onClick={onClose}>{cancel}</button>
        </div>
      </div>
    </div>, document.body);
}

/** The rest of a list, behind one quiet control: "All 7" opens it, "Fewer" closes it. */
export function ShowMore({ open, n, onClick, noun }: { open: boolean; n: number; onClick: () => void; noun?: string }) {
  return <button type="button" className="xmore" aria-expanded={open} onClick={onClick}>{open ? "Fewer" : `All ${n}${noun ? ` ${noun}` : ""}`}<Chevron open={open} /></button>;
}
