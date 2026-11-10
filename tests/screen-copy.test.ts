/* The gate on screen text (Bryan, 2026-11-10, after the third correction): no explaining sentences on screens. Every sentence a
   screen can show must be in docs/SCREEN-COPY.txt. A new one fails here until it is added there, in a commit Bryan sees word for word.
   Before adding one, the question is whether the screen needs words at all: a figure, a field or nothing usually does it better. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script, shared with the command line
import { sentences } from "../scripts/screen-copy.mjs";

describe("screen text", () => {
  it("every sentence on a screen is one Bryan has seen", () => {
    const approved = new Set(readFileSync(new URL("../docs/SCREEN-COPY.txt", import.meta.url), "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
    const found = sentences() as Map<string, string>;
    const unapproved = [...found].filter(([t]) => !approved.has(t)).map(([t, at]) => `${at}  ${t}`);
    expect(unapproved, "New screen text. Cut it, or add it to docs/SCREEN-COPY.txt for Bryan to see").toEqual([]);
  });
});
