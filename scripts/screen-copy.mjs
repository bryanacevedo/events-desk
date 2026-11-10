/* Every sentence a screen can show: text of five or more words in src/app, in JSX or in a string, and any text that strings two or
   more values together with words (data written as a sentence). Bryan, 2026-11-10: explaining text
   on screens reads as machine-made. tests/screen-copy.test.ts fails on any sentence not in docs/SCREEN-COPY.txt, so a new one ships
   only by being added there, where the diff shows it word for word. Run: node scripts/screen-copy.mjs [--write] */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const DIR = join(ROOT, "src/app");
const OUT = join(ROOT, "docs/SCREEN-COPY.txt");

export function sentences() {
  const found = new Map();
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".tsx")).sort()) {
    const src = readFileSync(join(DIR, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:"'`])\/\/.*$/gm, (m, a) => a + m.slice(a.length).replace(/[^\n]/g, " "));
    const add = (raw, at) => {
      const t = raw.replace(/\$\{[^}]*\}/g, "#").replace(/\{[^{}]*\}/g, "#").replace(/\s+/g, " ").trim();
      const words = t.split(" ").filter((w) => /[A-Za-z]{2,}/.test(w));
      const dataSentence = (t.match(/#/g) ?? []).length >= 2 && words.length >= 2;
      if ((words.length < 5 && !dataSentence) || /className|=>|import |\bconst\b|[;{}<>=&|]|\?\.|"|\bas Record\b|^[a-z-]+ [a-z-]+ [a-z-]+ [a-z-]+ [a-z-]+$/.test(t) || /^[,)\].]/.test(t)) return;
      const line = src.slice(0, at).split("\n").length;
      if (!found.has(t)) found.set(t, `${f}:${line}`);
    };
    // Text between JSX tags.
    for (const m of src.matchAll(/>([^<>]{12,})</g)) add(m[1], m.index);
    // String and template literals.
    for (const m of src.matchAll(/"([^"\n]{20,})"|`([^`]{20,})`/g)) add(m[1] ?? m[2], m.index);
  }
  return found;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const all = sentences();
  if (process.argv.includes("--write")) { writeFileSync(OUT, [...all.keys()].sort().join("\n") + "\n"); console.log(`${all.size} sentences written to docs/SCREEN-COPY.txt`); }
  else for (const [t, at] of all) console.log(`${at}\t${t}`);
}
