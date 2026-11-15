#!/usr/bin/env node
/* Re-vendors samples/lumen-world/ from the output of lumen-world's own slice command (docs/SHARED-WORLD.md 12.5 and 13.3).

   In a checked-out lumen-world at the tag:
     python -m lumen_world build RELEASE_DIR            (or use a built release)
     python -m lumen_world slice RELEASE_DIR events_desk SLICE_DIR
   Then here:
     node scripts/world-refresh.mjs SLICE_DIR --tag v1.3.0 --commit <full sha> [--release release/world-v1.3.0]

   Only the slice's public files are copied (never truth/, portraits or companies), each checked against the slice's own manifest first, and PIN.json is rewritten with
   the tag, the commit and the SHA-256 of every copied file. It is a copy so the desk runs without lumen-world. */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The public files Events Desk reads, in the order of its manifest. */
export const KEPT = [
  "clock.json", "events.csv", "seller.json", "team.csv",
  "events_extra.csv", "events_desk_clock.json", "events_desk_attendance.csv", "events_desk_guests.csv", "events_desk_targets.csv",
  "assessment_facts.json", "sponsorships.csv", "talks.csv",
];

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const slice = process.argv[2];
const tag = arg("tag"), commit = arg("commit"), release = arg("release") ?? (tag ? `release/world-${tag}` : undefined);
if (!slice || slice.startsWith("--") || !tag || !commit) { console.error("Usage: node scripts/world-refresh.mjs SLICE_DIR --tag v1.3.0 --commit <full sha> [--release release/world-v1.3.0]"); process.exit(2); }

const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "samples", "lumen-world");
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const manifest = JSON.parse(readFileSync(join(slice, "manifest.json"), "utf8"));
if (String(manifest.format_version) !== "1" || manifest.slice_of?.desk !== "events_desk") { console.error("That is not an events_desk slice of format 1."); process.exit(1); }

mkdirSync(dest, { recursive: true });
const files = {};
for (const f of KEPT) {
  const from = join(slice, "public", f), got = sha(from);
  if (manifest.sha256[`public/${f}`] !== got) { console.error(`${f} does not match the slice's manifest.`); process.exit(1); }
  copyFileSync(from, join(dest, f)); files[f] = got;
}
copyFileSync(join(slice, "manifest.json"), join(dest, "manifest.json"));
writeFileSync(join(dest, "PIN.json"), JSON.stringify({
  repository: "lumen-world", tag, commit, release, world_version: String(manifest.world_version),
  how: `python -m lumen_world slice ${release} events_desk OUT, then node scripts/world-refresh.mjs OUT --tag ${tag} --commit ${commit}. Public files only (no truth, portraits or companies). The manifest is the slice's own and lists more files than are kept here.`,
  files,
}, null, 2) + "\n");
console.log(`Vendored ${KEPT.length} files from ${tag} (${commit.slice(0, 7)}) into samples/lumen-world/.`);
