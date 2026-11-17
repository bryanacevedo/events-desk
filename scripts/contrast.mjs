/* Text contrast, measured: every CSS rule that sets a text colour, against its own solid background when it has one and otherwise against the two grounds
   the app draws on (white and the well grey). A pair under 4.5:1 is listed; a rule whose text is under 13 px is held to 7:1 when --strict is given.
   Run: node scripts/contrast.mjs [--strict] [file.css ...]. Exit 1 when a pair fails. Semi-transparent colours are blended over the ground. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const css = (files.length ? files : ["src/app/styles.css", "src/scan/scan.css"]).map((f) => readFileSync(new URL(f.startsWith("/") ? `file://${f}` : `../${f}`, import.meta.url), "utf8")).join("\n");
const strict = process.argv.includes("--strict");

const vars = {};
for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
const resolve = (v) => { let out = v.trim(), n = 0; while (/var\(/.test(out) && n++ < 6) out = out.replace(/var\((--[\w-]+)(?:,[^)]*)?\)/g, (_, k) => vars[k] ?? "#000"); return out; };

function parse(v) {
  v = resolve(v);
  let m = v.match(/^#([0-9a-f]{3,8})$/i);
  if (m) { let h = m[1]; if (h.length <= 4) h = [...h].map((c) => c + c).join(""); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }; }
  m = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}
const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const grounds = [["white", parse("#FFFFFF")], ["well", parse(vars["--well"] ?? "#F4F6F4")]];
// Light text with no background of its own sits on a dark parent (the green bands, the ink header, the scanner). Which one is not visible here, so it passes when it reads on either dark.
const darks = [["green", parse(vars["--green"] ?? "#1F5D3F")], ["ink", parse(vars["--ink"] ?? "#15231B")]];
const fails = [];
let checked = 0;
for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1].trim().replace(/\s+/g, " "), body = m[2];
  if (sel.startsWith("@") || /::?(placeholder|disabled)|:disabled|\.is-off/.test(sel)) continue;
  const col = body.match(/(?:^|;|\s)color\s*:\s*([^;]+)/);
  if (!col) continue;
  const fg = parse(col[1]);
  if (!fg) continue;
  const bgm = body.match(/background(?:-color)?\s*:\s*([^;]+)/);
  const own = bgm ? parse(bgm[1].split(/\s+(?:url|no-repeat|linear)/)[0].trim()) : null;
  const size = body.match(/font(?:-size)?\s*:\s*(?:\d{3}\s+)?(\d+(?:\.\d+)?)px/);
  const px = size ? +size[1] : 15;
  const need = strict && px < 13 ? 7 : 4.5;
  const onDark = !(own && own.a === 1) && lum(over(fg, { r: 255, g: 255, b: 255 })) > 0.25;
  if (onDark) { const best = Math.max(...darks.map(([, g]) => ratio(over(fg, g), g))); checked++; if (best < need) fails.push(`${best.toFixed(2)}:1 (needs ${need})  ${sel}  color ${col[1].trim()} on a dark ground`); continue; }
  for (const [name, g] of own && own.a === 1 ? [["own", own]] : grounds) {
    const bg = own && own.a < 1 ? over(own, g) : g;
    const r = ratio(over(fg, bg), bg);
    checked++;
    if (r < need) fails.push(`${r.toFixed(2)}:1 (needs ${need})  ${sel}  color ${col[1].trim()} on ${name}${px < 13 ? `  ${px}px` : ""}`);
  }
}
const seen = new Set();
const out = fails.filter((f) => !seen.has(f) && seen.add(f));
console.log(`${checked} pairs checked, ${out.length} under the line`);
for (const f of out) console.log("  " + f);
process.exit(out.length ? 1 : 0);
