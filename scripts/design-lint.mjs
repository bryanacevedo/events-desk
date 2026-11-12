/* Design lint: fails on the UI patterns Bryan has banned by name ("Banned: the AI tells" in BRYAN-DESIGN-INSTRUMENT.md, T4).
   Plain Node, no dependencies, identical in every Desk repo.

   Rules
     pill            a status, date, count, badge, chip, tag or pill class with a fully rounded corner and a background or tint
     dot             a small (10px or less) round coloured shape: a ::before or ::after, or a class containing "dot"
     warm-warning    amber, orange or brown text or background (hue 20 to 50, saturation over 40%) on late, over, overdue, warn, warning, due or alert
     text-link-cta   an anchor or link styled as a link whose text starts "Open the", "See all", "View all", "View more", "Show all", "Go to", "Learn more"
     allow-reason    a `design-lint: allow` comment with no reason after it

   Exempt a line with the comment `design-lint: allow <reason>` (CSS or TSX), on the rule or tag, or on the line above it. The reason is required.

   docs/DESIGN-LINT-BASELINE.txt lists the violations that existed when the gate was added (file, rule, snippet; no line numbers, so edits do not break it).
   Only violations not in the baseline fail. Run:
     node scripts/design-lint.mjs                    new violations only (exit 1 if any)
     node scripts/design-lint.mjs --all              every violation with line numbers
     node scripts/design-lint.mjs --write-baseline   rewrite the baseline from today's code (Bryan reviews the diff) */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "docs/DESIGN-LINT-BASELINE.txt");
const SCAN_DIRS = ["web/src", "src/app"];
const SCAN_FILES = ["index.html", "web/index.html"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".claude", ".venv", ".data"]);
const EXTS = new Set([".css", ".tsx", ".ts", ".jsx", ".html"]);
const ALLOW_RE = /design-lint:\s*allow\b(.*)/;

export const MESSAGE =
  "Banned UI pattern (see BRYAN-DESIGN-INSTRUMENT.md, Banned: the AI tells). Fix it, or add `design-lint: allow <reason>` if Bryan approved it.";

// ---------- files ----------
function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.has(e.name.slice(e.name.lastIndexOf(".")))) out.push(p);
  }
}
function sourceFiles() {
  const out = [];
  for (const d of SCAN_DIRS) if (existsSync(join(ROOT, d))) walk(join(ROOT, d), out);
  for (const f of SCAN_FILES) if (existsSync(join(ROOT, f))) out.push(join(ROOT, f));
  return out.sort();
}

// ---------- helpers ----------
const blank = (s) => s.replace(/[^\n]/g, " ");
const lineAt = (text, idx) => text.slice(0, idx).split("\n").length;
const squash = (s, n = 140) => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "..." : t; };

function allowedLines(raw, out, file) {
  const ok = new Set(), above = new Set();
  raw.split("\n").forEach((l, i) => {
    const m = l.match(ALLOW_RE);
    if (!m) return;
    if (!m[1].replace(/\*\/|-->|\*\/\}|\}/g, "").trim()) out.push({ file, line: i + 1, rule: "allow-reason", snippet: squash(l) });
    else { ok.add(i + 1); if (/^\s*(\/\*|\/\/|\{\s*\/\*|<!--)/.test(l)) above.add(i + 1); }
  });
  return { ok, above };
}
// Allowed by a comment on any line of the rule or tag, or by a comment on its own line just above it.
const isAllowed = (ok, from, to) => { if (ok.above.has(from - 1)) return true; for (let l = from; l <= to; l++) if (ok.ok.has(l)) return true; return false; };

function words(selector) {
  return new Set(selector.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

// ---------- colour ----------
const NAMED_WARM = new Set(["orange", "darkorange", "chocolate", "sienna", "saddlebrown", "peru", "sandybrown", "brown", "burlywood", "tan", "goldenrod", "darkgoldenrod", "coral"]);
function hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return { h: 0, s: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: s * 100 };
}
const isWarm = ({ h, s }) => h >= 20 && h <= 50 && s > 40;
function literalColors(v) {
  const found = [];
  for (const m of v.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/gi)) {
    let x = m[1]; if (x.length <= 4) x = [...x].map((c) => c + c).join("");
    found.push(hsl(parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)));
  }
  for (const m of v.matchAll(/rgba?\(\s*([\d.]+)%?[\s,]+([\d.]+)%?[\s,]+([\d.]+)/gi)) found.push(hsl(+m[1], +m[2], +m[3]));
  for (const m of v.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%/gi)) found.push({ h: ((+m[1] % 360) + 360) % 360, s: +m[2] });
  for (const m of v.toLowerCase().matchAll(/(?<![\w-])([a-z]+)(?![\w-(])/g)) if (NAMED_WARM.has(m[1])) found.push({ h: 30, s: 100, named: m[1] });
  return found;
}
function resolveColors(v, vars, depth = 0) {
  if (depth > 6) return [];
  const out = literalColors(v.replace(/var\([^)]*\)/g, " "));
  for (const m of v.matchAll(/var\(\s*(--[\w-]+)\s*(?:,([^)]*))?\)/g)) {
    const defs = vars.get(m[1]);
    if (defs) for (const d of defs) out.push(...resolveColors(d, vars, depth + 1));
    else if (m[2]) out.push(...resolveColors(m[2], vars, depth + 1));
  }
  return out;
}

// ---------- CSS ----------
function parseCss(text) {
  // Returns leaf blocks: { selector, line, endLine, decls: Map(prop -> value) } and the custom properties.
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  const blocks = [], stack = [];
  let buf = "", bufStart = 0, paren = 0;
  const addDecl = (frame, s) => {
    const i = s.indexOf(":");
    if (i < 0 || !frame) return;
    frame.decls.set(s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim());
  };
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "(") paren++; else if (c === ")") paren = Math.max(0, paren - 1);
    if (paren === 0 && c === "{") {
      const lead = buf.length - buf.trimStart().length;
      stack.push({ selector: buf.trim(), start: bufStart + lead, decls: new Map(), at: buf.trim().startsWith("@") });
      buf = ""; bufStart = i + 1;
    } else if (paren === 0 && c === "}") {
      if (buf.trim()) addDecl(stack[stack.length - 1], buf);
      const f = stack.pop();
      if (f && !f.at && f.decls.size) {
        const parents = stack.filter((p) => !p.at).map((p) => p.selector);
        blocks.push({ selector: [...parents, f.selector].join(" "), line: lineAt(clean, f.start), endLine: lineAt(clean, i), decls: f.decls });
      }
      buf = ""; bufStart = i + 1;
    } else if (paren === 0 && c === ";") {
      if (stack.length && buf.trim()) addDecl(stack[stack.length - 1], buf);
      buf = ""; bufStart = i + 1;
    } else {
      if (!buf.trim()) bufStart = i;
      buf += c;
    }
  }
  return blocks;
}

function cssOf(file, raw) {
  if (!file.endsWith(".html")) return file.endsWith(".css") ? raw : "";
  // Only the <style> contents, everything else blanked so line numbers hold.
  let out = "", last = 0;
  for (const m of raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const s = m.index + m[0].indexOf(m[1]);
    out += blank(raw.slice(last, s)) + m[1]; last = s + m[1].length;
  }
  return out + blank(raw.slice(last));
}

const PILL_WORDS = new Set(["status", "statuses", "date", "dates", "count", "counts", "badge", "badges", "chip", "chips", "tag", "tags", "pill", "pills"]);
const PILL_EXEMPT = /avatar|logo|mark|toggle|switch|radio|checkbox/i;
const DOT_EXEMPT = /toggle|switch|radio|checkbox/i;
const WARM_WORDS = new Set(["late", "over", "overdue", "warn", "warning", "due", "alert"]);
const hasFill = (d) => ["background", "background-color"].some((p) => d.has(p) && !/^(none|transparent|inherit|initial|unset|0 0)$/i.test(d.get(p).trim()));
const px = (v) => {
  const m = v && v.trim().match(/^(-?[\d.]+)(px|rem|em)?$/i);
  return m ? (m[2] && m[2].toLowerCase() !== "px" ? +m[1] * 16 : +m[1]) : null;
};
function radiusOf(d) {
  const v = d.get("border-radius"); if (!v) return null;
  const first = v.split(/[\s/]+/)[0];
  const m = first.match(/^([\d.]+)(%|px|rem|em)?$/i);
  if (!m) return null;
  return m[2] === "%" ? { pct: +m[1] } : { px: m[2] && m[2] !== "px" ? +m[1] * 16 : +m[1] };
}

function lintCss(sheets, vars, allowFor, out, shapes) {
  // Group the rules by exact selector, in load order, so a shape split over two rules
  // (.dot { width; height } then .dot { border-radius }) reads as one, and a later rule (or sheet) overrides an earlier one.
  const groups = new Map();
  for (const { file, raw } of sheets) for (const b of parseCss(cssOf(file, raw))) {
    const ok = allowFor(file);
    const parts = b.selector.split(/,(?![^(]*\))/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
    for (const part of parts) {
      const g = groups.get(part) ?? { file, part, line: b.line, decls: new Map(), allowed: false };
      for (const [k, v] of b.decls) g.decls.set(k, v);
      if (isAllowed(ok, b.line, b.endLine)) g.allowed = true;
      groups.set(part, g);
    }
  }
  const all = [...groups.values()];
  const radiusVal = (v) => (v ? v.replace(/var\(\s*(--[\w-]+)[^)]*\)/g, (m, n) => (vars.get(n) ?? [m])[0]) : v);
  for (const g of all) {
    if (g.allowed) continue;
    const { part, decls: d, file } = g;
    if (d.has("border-radius")) d.set("border-radius", radiusVal(d.get("border-radius")));
    const r = radiusOf(d);
    const w = px(d.get("width")), h = px(d.get("height"));
    const ws = words(part);
    // A compound modifier of the same shape (.tdot.t1 { background }) can supply the fill.
    const filled = hasFill(d) || all.some((o) => !o.allowed && o.part.startsWith(part + ".") && hasFill(o.decls));
    // 1. pill
    if (r && filled && [...ws].some((x) => PILL_WORDS.has(x)) && !PILL_EXEMPT.test(part)) {
      const square = w != null && h != null && w === h;
      if ((r.px != null && r.px >= 999) || (r.pct != null && r.pct >= 50 && !square))
        out.push({ file, line: g.line, rule: "pill", snippet: squash(`${part} { border-radius: ${d.get("border-radius")} }`) });
    }
    // 2. dot
    const small = w != null && h != null && w <= 10 && h <= 10 && w > 0 && h > 0;
    const round = r && ((r.pct != null && r.pct >= 50) || (r.px != null && w != null && r.px >= w / 2));
    const dotty = /::?(before|after)\s*$/.test(part) || /\.[\w-]*dot[\w-]*/i.test(part);
    // A round dot-named shape with no fill in CSS may get its colour inline in the markup (style={{ background }}).
    if (small && round && !filled && /^\.[\w-]*dot[\w-]*$/i.test(part) && !DOT_EXEMPT.test(part)) shapes.set(part.slice(1), { w, file });
    if (small && round && dotty && filled && !DOT_EXEMPT.test(part))
      out.push({ file, line: g.line, rule: "dot", snippet: squash(`${part} { ${w}px by ${h}px; border-radius: ${d.get("border-radius")} }`) });
    // 3. warm-warning
    if ([...ws].some((x) => WARM_WORDS.has(x))) {
      for (const p of ["color", "background", "background-color"]) {
        if (!d.has(p)) continue;
        if (resolveColors(d.get(p), vars).some(isWarm)) { out.push({ file, line: g.line, rule: "warm-warning", snippet: squash(`${part} { ${p}: ${d.get(p)} }`) }); break; }
      }
    }
  }
}

// ---------- TSX / HTML ----------
const CTA = /^(open the|see all|view all|view more|show all|go to|learn more)\b/i;
function lintMarkup(file, raw, ok, out, shapes) {
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/^(\s*)\/\/.*$/gm, (m) => blank(m));
  // Dot shapes coloured inline: <span className="tdot" style={{ background: ... }} />
  for (const m of src.matchAll(/<\w+\s[^<>]*?(?:className|class)=["']([^"']*)["'][^<>]*?style=\{\{([^}]*)\}\}/g)) {
    const cls = m[1].split(/\s+/).find((c) => shapes.has(c));
    if (!cls || !/\bbackground(-?[cC]olor)?\s*:/.test(m[2])) continue;
    const line = lineAt(src, m.index);
    if (isAllowed(ok, line, line + m[0].split("\n").length - 1)) continue;
    out.push({ file, line, rule: "dot", snippet: squash(`<... className="${m[1]}" style={{ ${m[2].trim()} }}> (${shapes.get(cls).w}px round)`) });
  }
  for (const m of src.matchAll(/<(a|button|[A-Z]\w*Link|Link)(?=[\s>])/g)) {
    // Opening tag: scan to the closing > outside braces and quotes.
    let i = m.index + m[0].length, depth = 0, q = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === q && src[i - 1] !== "\\") q = null; continue; }
      if (c === '"' || c === "'" || c === "`") q = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth <= 0) break;
    }
    if (src[i - 1] === "/") continue; // self-closing: no text
    const open = src.slice(m.index, i + 1);
    const cls = open.match(/\b(?:className|class)\s*=\s*(\{[^]*?\}(?=\s|\/?>)|"[^"]*"|'[^']*')/);
    if (!cls || !/link/i.test(cls[1])) continue;
    const end = src.indexOf("</", i);
    let body = src.slice(i + 1, end < 0 ? i + 400 : end);
    body = body.replace(/\{\s*" "\s*\}/g, " ").replace(/^(\s*<[A-Z]\w*[^>]*\/>)+/, "").trim();
    const lit = body.match(/^\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\}/);
    const text = (lit ? lit[1] ?? lit[2] ?? lit[3] : body.split(/[<{]/)[0]).trim();
    if (!CTA.test(text)) continue;
    const line = lineAt(src, m.index), endLine = lineAt(src, i);
    if (isAllowed(ok, line, endLine)) continue;
    out.push({ file, line, rule: "text-link-cta", snippet: squash(`<${m[1]} ${cls[0]}> ${text}`) });
  }
}

// ---------- run ----------
// CSS load order: the order of `import "./x.css"` in the entry file, so a later sheet overrides an earlier one.
function loadOrder(files) {
  const order = [];
  for (const { rel, raw } of files) if (/(^|\/)main\.[tj]sx?$/.test(rel))
    for (const m of raw.matchAll(/import\s+["']\.\/([^"']+\.css)["']/g)) order.push(m[1]);
  const css = files.filter((x) => x.f.endsWith(".css") || x.f.endsWith(".html"));
  const rank = (x) => { const i = order.findIndex((o) => x.rel.endsWith(o)); return i < 0 ? -1 : i; };
  return css.sort((a, b) => rank(a) - rank(b) || a.rel.localeCompare(b.rel));
}

export function violations() {
  const files = sourceFiles().map((f) => ({ f, rel: relative(ROOT, f), raw: readFileSync(f, "utf8") }));
  const out = [], allow = new Map();
  for (const { rel, raw } of files) allow.set(rel, allowedLines(raw, out, rel));
  const sheets = loadOrder(files).map((x) => ({ file: x.rel, raw: x.raw }));
  // Custom properties: every definition in a sheet counts, but a later sheet that redefines a name replaces the earlier sheet's.
  const vars = new Map(), owner = new Map();
  for (const { file, raw } of sheets)
    for (const b of parseCss(cssOf(file, raw))) for (const [k, v] of b.decls) if (k.startsWith("--")) {
      if (owner.get(k) !== file) { vars.set(k, []); owner.set(k, file); }
      vars.get(k).push(v);
    }
  const shapes = new Map();
  lintCss(sheets, vars, (file) => allow.get(file), out, shapes);
  for (const { f, rel, raw } of files) if (!f.endsWith(".css")) lintMarkup(rel, raw, allow.get(rel), out, shapes);
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

const key = (v) => `${v.file}\t${v.rule}\t${v.snippet}`;
export const show = (v) => `${v.file}:${v.line}\t${v.rule}\t${v.snippet}`;

export function newViolations() {
  const budget = new Map();
  if (existsSync(BASELINE))
    for (const l of readFileSync(BASELINE, "utf8").split("\n")) {
      if (!l.trim() || l.startsWith("#")) continue;
      budget.set(l, (budget.get(l) ?? 0) + 1);
    }
  return violations().filter((v) => {
    const n = budget.get(key(v)) ?? 0;
    if (n > 0) { budget.set(key(v), n - 1); return false; }
    return true;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = process.argv[2];
  if (arg === "--write-baseline") {
    const all = violations();
    mkdirSync(dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, all.map(key).sort().join("\n") + (all.length ? "\n" : ""));
    console.log(`${all.length} violations written to docs/DESIGN-LINT-BASELINE.txt`);
  } else if (arg === "--all") {
    const all = violations();
    for (const v of all) console.log(show(v));
    console.error(`${all.length} violations in total`);
  } else {
    const fresh = newViolations();
    for (const v of fresh) console.log(show(v));
    if (fresh.length) { console.error(`\n${fresh.length} new. ${MESSAGE}`); process.exit(1); }
  }
}
