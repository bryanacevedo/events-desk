/* The design-lint gate: banned UI patterns ("the AI tells") fail the suite. Rules and rulings: BRYAN-DESIGN-INSTRUMENT.md, "Banned: the AI tells".
   Existing violations are listed in docs/DESIGN-LINT-BASELINE.txt for Bryan to review; only violations not in that file fail here.
   Run by hand: node scripts/design-lint.mjs */

import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script, shared with the command line
import { newViolations, show, MESSAGE } from "../scripts/design-lint.mjs";

describe("design lint", () => {
  it("no banned UI pattern beyond the baseline", () => {
    const fresh = (newViolations() as unknown[]).map((v) => show(v));
    expect(fresh, MESSAGE as string).toEqual([]);
  });
});
