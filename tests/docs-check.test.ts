/* The docs gate (scripts/docs-check.mjs): passes on this repository, and each check fails on a broken copy.
   Run by hand: make docs-check */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script, shared with the command line
import { checkDocs } from "../scripts/docs-check.mjs";

const check = checkDocs as (root: string, opts?: { codeDate?: string | null }) => string[];
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A small repository that passes every check. `over` replaces or adds files. */
function fixture(over: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "docs-check-"));
  dirs.push(root);
  const files: Record<string, string> = {
    "README.md": "# Fixture\n\nRun `npm run migrate` (migrations 0001 to 0003). Set `API_KEY`.\n",
    ".env.example": "API_KEY=\n",
    "PROJECT-STATUS.md": "# Status\n\n**Updated:** 2026-11-17. **Decisions:** `docs/DECISIONS.md`, 1 to 2.\n",
    "docs/DECISIONS.md": "## 1. First (2026-11-01)\n\nText.\n\n## 2. Second (2026-11-02)\n\nText.\n",
    "migrations/0001_a.sql": "select 1;\n",
    "migrations/0002_b.sql": "select 1;\n",
    "migrations/0003_c.sql": "select 1;\n",
    "src/a.ts": "export const k = process.env.API_KEY;\n",
    "scripts/docs-env-allowlist.json": "{}\n",
    ...over,
  };
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}
const opts = { codeDate: "2026-11-17" };

describe("docs gate", () => {
  it("passes on this repository", () => {
    expect(check(resolve(__dirname, ".."))).toEqual([]);
  });

  it("passes on the fixture", () => {
    expect(check(fixture(), opts)).toEqual([]);
  });

  it("fails when the README carries a test count", () => {
    const r = check(fixture({ "README.md": "Migrations 0001 to 0003. API_KEY. 1,158 passed and 12 skipped.\n" }), opts);
    expect(r.join("\n")).toMatch(/test count/);
  });

  it("fails when the README migration range differs from the folder, or is missing", () => {
    expect(check(fixture({ "README.md": "migrations 0001 to 0002. API_KEY\n" }), opts).join("\n")).toMatch(/0001 to 0002.*0001 to 0003/);
    expect(check(fixture({ "README.md": "API_KEY\n" }), opts).join("\n")).toMatch(/migration range/);
  });

  it("fails when the code reads an environment variable nobody documented", () => {
    const r = check(fixture({ "src/b.ts": "export const x = process.env.NEW_THING;\n" }), opts);
    expect(r.join("\n")).toMatch(/NEW_THING/);
  });

  it("accepts an undocumented variable only with a written reason", () => {
    const code = { "src/b.ts": "export const x = process.env.NEW_THING;\n" };
    expect(check(fixture({ ...code, "scripts/docs-env-allowlist.json": '{"NEW_THING":"A system variable set by the host."}' }), opts)).toEqual([]);
    expect(check(fixture({ ...code, "scripts/docs-env-allowlist.json": '{"NEW_THING":""}' }), opts).join("\n")).toMatch(/needs a written reason/);
  });

  it("fails when the decision count in PROJECT-STATUS is not the highest decision", () => {
    const r = check(fixture({ "docs/DECISIONS.md": "## 1. A (2026-11-01)\n\nx\n\n## 2. B (2026-11-02)\n\nx\n\n## 3. C (2026-11-03)\n\nx\n" }), opts);
    expect(r.join("\n")).toMatch(/1 to 2.*ends at 3/);
  });

  it("fails when PROJECT-STATUS is more than a day older than the last code commit", () => {
    expect(check(fixture(), { codeDate: "2026-11-18" })).toEqual([]);
    expect(check(fixture(), { codeDate: "2026-11-19" }).join("\n")).toMatch(/code last changed 2026-11-19/);
  });

  it("skips the date check when there is no git history", () => {
    expect(check(fixture(), { codeDate: null })).toEqual([]);
    expect(check(fixture())).toEqual([]); // a temp folder is not a git repository
  });

  it("fails when a line says a push deploys by itself", () => {
    const r = check(fixture({ "PROJECT-STATUS.md": "**Updated:** 2026-11-17. **Decisions:** 1 to 2.\n\nRender redeploys on every push to main.\n" }), opts);
    expect(r.join("\n")).toMatch(/deploys by itself/);
  });
});
