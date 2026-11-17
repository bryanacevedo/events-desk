/* The docs gate: fails when README, PROJECT-STATUS or the decisions drift from the code.
   Run by hand: node scripts/docs-check.mjs   (or make docs-check). Also run by tests/docs-check.test.ts.
   checkDocs(root) returns a list of problems, empty when the docs agree with the code. */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const read = (root, rel) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : "");

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

/* 1. No test count in the README. A count there goes stale on the next commit; the suite's own run is the truth. */
function checkTestCount(root) {
  const readme = read(root, "README.md");
  const found = readme.match(/\b\d[\d,]*\s+(?:tests?|passed|skipped)\b|\b(?:passed|skipped)\s+\d/gi);
  return found ? [`README.md states a test count (${found.join("; ")}). Remove it: the README carries no test numbers.`] : [];
}

/* 2. A migration range in the README or PROJECT-STATUS equals the migrations folder. */
function checkMigrations(root) {
  const dir = join(root, "migrations");
  if (!existsSync(dir)) return [];
  const nums = readdirSync(dir).map((f) => f.match(/^(\d{4})_.*\.sql$/)?.[1]).filter(Boolean).sort();
  if (!nums.length) return [];
  const first = nums[0], last = nums[nums.length - 1];
  const problems = [];
  const readme = read(root, "README.md");
  if (!/migrations\s+\d{4}\s+to\s+\d{4}/i.test(readme)) problems.push(`README.md must state the migration range (migrations ${first} to ${last}).`);
  for (const rel of ["README.md", "PROJECT-STATUS.md"]) {
    const text = read(root, rel);
    for (const m of text.matchAll(/migrations\s+(\d{4})\s+to\s+(\d{4})/gi)) {
      if (m[1] !== first || m[2] !== last) problems.push(`${rel} says migrations ${m[1]} to ${m[2]}; the folder holds ${first} to ${last}.`);
    }
  }
  return problems;
}

/* 3. Every environment variable the code reads is in the README or .env.example, or in the allowlist with a reason. */
function checkEnv(root) {
  const files = [...walk(join(root, "src")), ...walk(join(root, "scripts"))];
  const used = new Set();
  const re = /\b(?:process\.)?env(?:\.|\[\s*["'`])([A-Z][A-Z0-9_]{2,})\b/g;
  for (const f of files) for (const m of readFileSync(f, "utf8").matchAll(re)) used.add(m[1]);
  const docs = read(root, "README.md") + "\n" + read(root, ".env.example");
  let allow = {};
  try { allow = JSON.parse(read(root, "scripts/docs-env-allowlist.json") || "{}"); } catch { return ["scripts/docs-env-allowlist.json is not valid JSON."]; }
  const problems = [];
  for (const [k, why] of Object.entries(allow)) if (typeof why !== "string" || why.trim().length < 8) problems.push(`Allowlist entry ${k} needs a written reason.`);
  for (const v of [...used].sort()) {
    if (new RegExp(`\\b${v}\\b`).test(docs) || allow[v]) continue;
    problems.push(`Environment variable ${v} is read by the code but is in neither README.md nor .env.example (or add it to scripts/docs-env-allowlist.json with a reason).`);
  }
  return problems;
}

/* 4. The highest decision number equals the count PROJECT-STATUS states ("Decisions: ... 1 to N"). */
function checkDecisions(root) {
  const nums = [...read(root, "docs/DECISIONS.md").matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
  if (!nums.length) return ["docs/DECISIONS.md has no numbered decisions."];
  const top = Math.max(...nums);
  const stated = read(root, "PROJECT-STATUS.md").match(/\*\*Decisions:\*\*[^\n]*?\b1 to (\d+)/);
  if (!stated) return ["PROJECT-STATUS.md must state the decisions on record: '**Decisions:** `docs/DECISIONS.md`, 1 to N'."];
  return Number(stated[1]) === top ? [] : [`PROJECT-STATUS.md says decisions 1 to ${stated[1]}; docs/DECISIONS.md ends at ${top}.`];
}

/* 5. PROJECT-STATUS 'Updated' is not more than 1 day older than the last commit that touched code. */
function lastCodeCommitDate(root) {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", "src", "scripts", "migrations", "tests", "package.json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^\d{4}-\d\d-\d\d$/.test(out) ? out : null;
  } catch { return null; }
}
const dayNumber = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);

function checkUpdated(root, codeDate) {
  const m = read(root, "PROJECT-STATUS.md").match(/\*\*Updated:\*\*\s*(\d{4}-\d\d-\d\d)/);
  if (!m) return ["PROJECT-STATUS.md must carry '**Updated:** YYYY-MM-DD'."];
  const code = codeDate === undefined ? lastCodeCommitDate(root) : codeDate;
  if (!code) return []; // no git history (a shallow or exported copy): skipped
  return dayNumber(code) - dayNumber(m[1]) > 1 ? [`PROJECT-STATUS.md was updated ${m[1]}; code last changed ${code}. Update it in the same commit as the behaviour.`] : [];
}

/* 6. No line says a push deploys by itself: deploys here are manual. */
function checkDeployClaims(root) {
  const bad = /redeploys? (?:on every push|by itself)|rebuilt from the seed on every push|auto-?deploys? on (?:every )?push/i;
  const problems = [];
  for (const rel of ["README.md", "PROJECT-STATUS.md", "render.yaml"]) {
    read(root, rel).split("\n").forEach((line, i) => { if (bad.test(line)) problems.push(`${rel}:${i + 1} claims a push deploys by itself. Deploys are manual.`); });
  }
  return problems;
}

export function checkDocs(root, opts = {}) {
  return [
    ...checkTestCount(root),
    ...checkMigrations(root),
    ...checkEnv(root),
    ...checkDecisions(root),
    ...checkUpdated(root, opts.codeDate),
    ...checkDeployClaims(root),
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const problems = checkDocs(root);
  if (problems.length) {
    console.error("docs-check failed:\n- " + problems.join("\n- "));
    process.exit(1);
  }
  console.log("docs-check: README, PROJECT-STATUS and decisions agree with the code.");
}
