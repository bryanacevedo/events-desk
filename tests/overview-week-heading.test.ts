import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WeekA, WeekB } from "../src/app/Overview.tsx";
import type { DeadlineRow } from "../src/app/api.ts";

/* The Overview week block says "This week" once. When every open deadline is in the "This week" group, the group
   label is the same words as the section heading, so it is not drawn, and a lone column fills the row. */
const row = (n: number, group: DeadlineRow["group"]) => ({ kind: "deliverable", ref_id: `d${n}`, event_id: `e${n}`, event_name: `Event ${n}`, label: `Task ${n}`, owner: "Maya", due_on: "2026-11-20", due_words: "Fri", group }) as unknown as DeadlineRow;
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);
const props = (rows: DeadlineRow[]) => ({ rows, go: () => {}, logos: new Map<string, string | null>() });
const count = (s: string, w: string) => s.split(w).length - 1;

describe("Overview week block, no duplicated heading", () => {
  const only = [row(1, "week"), row(2, "week"), row(3, "week")];
  it("layout B: one heading, one full-width column, no tray header", () => {
    const h = html(createElement(WeekB, props(only)));
    expect(count(h, "This week")).toBe(2); // the section aria-label and the single h2
    expect(h).toContain('<h2 class="display">This week</h2>');
    expect(h).not.toContain("<h3");
    expect(h).toContain("wk-cols one");
  });
  it("layout B: with late work there are two columns and the tray headers stay", () => {
    const h = html(createElement(WeekB, props([row(1, "late"), row(2, "today"), row(3, "week")])));
    expect(h).not.toContain("wk-cols one");
    expect(h).toContain("<h3><b>Late</b>");
    expect(h).toContain("<h3><b>This week</b>");
  });
  it("layout B: late work alone is also one full-width column", () => {
    expect(html(createElement(WeekB, props([row(1, "late")])))).toContain("wk-cols one");
  });
  it("layout A: the group label is dropped when it would repeat the heading, kept otherwise", () => {
    const a = html(createElement(WeekA, props(only)));
    expect(a).toContain("led-g week solo");
    expect(a).not.toContain("led-gh");
    expect(html(createElement(WeekA, props([row(1, "late"), row(2, "week")])))).toContain("led-gh");
  });
});
