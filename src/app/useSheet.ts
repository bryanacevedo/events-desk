/* The behaviour every side sheet shares, on its own so the pages that only need it do not pull in the sheet itself. */

import { useEffect, useRef } from "react";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** What every side sheet does: focus moves in and stays in, Esc and a click outside close it, and focus goes back to the row that opened it.
    Anything marked data-opens-sheet switches the sheet instead of closing it. */
export function useSheet(close: () => void) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;

  // Focus in on open, back to the card on close. A click on another card switches the sheet, so it is not "outside".
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const prevRow = prev?.getAttribute("data-row") ?? null;
    // Focus goes into the sheet itself, not onto its close button: a keyboard user starts inside it (Tab reaches the close), and
    // a mouse user does not see a focus ring on the close the moment the sheet opens.
    if (ref.current) { ref.current.setAttribute("tabindex", "-1"); ref.current.focus({ preventScroll: true }); }
    document.body.classList.add("sheet-open");
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest("[data-opens-sheet]")) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== "Tab" || !ref.current) return;
      const els = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length);
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && (document.activeElement === first || !ref.current.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !ref.current.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("sheet-open");
      // The card may have been redrawn while the sheet was open; find it again by its id.
      const back = prev && prev.isConnected ? prev : prevRow ? document.querySelector<HTMLElement>(`[data-row="${prevRow}"]`) : null;
      back?.focus();
    };
  }, []);
  return ref;
}
