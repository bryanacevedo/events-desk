/* Writes a brand_color into each entry of samples/real-events.json: the dominant colored pixel of the
   organizer's favicon, read from Google's favicon service at view size. Nothing is saved but the hex.
   Grey, white and black pixels are ignored; a logo with no color at all gets null and the screen falls
   back to a Desk tint. A `hand` entry wins over the computed one, for the few icons that come out muddy.
   Usage: node scripts/brand-colors.ts [--dry] */

import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";

const file = new URL("../samples/real-events.json", import.meta.url);
const dry = process.argv.includes("--dry");
type Real = { name: string; organizer_url: string; brand_color?: string | null; brand_color_hand?: string | null };
const real: Real[] = JSON.parse(readFileSync(file, "utf8"));

const domain = (url: string) => new URL(url).hostname.replace(/^www\./, "");
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const hsl = (r: number, g: number, b: number) => {
  const R = r / 255, G = g / 255, B = b / 255, max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const h = d === 0 ? 0 : max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: h * 60, s, l };
};

/** The dominant colored pixel: pixels bucketed by hue (24 bins) and lightness (3), the fullest bucket averaged. */
function dominant(png: PNG): string | null {
  const bins = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < png.data.length; i += 4) {
    const [r, g, b, a] = [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
    if (a < 160) continue;
    const { h, s, l } = hsl(r, g, b);
    if (s < 0.3 || l < 0.12 || l > 0.9) continue;
    const key = `${Math.floor(h / 15)}:${Math.floor(l * 3)}`;
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++; bin.r += r; bin.g += g; bin.b += b; bins.set(key, bin);
  }
  const total = [...bins.values()].reduce((a, x) => a + x.n, 0);
  if (total < (png.width * png.height) / 40) return null;
  const best = [...bins.values()].sort((a, b) => b.n - a.n)[0];
  return hex(best.r / best.n, best.g / best.n, best.b / best.n);
}

for (const r of real) {
  let color: string | null = null, note = "";
  try {
    const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain(r.organizer_url))}&sz=128`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!res.ok || buf.length < 100) note = "no icon";
    else if (buf[0] !== 0x89 || buf[1] !== 0x50) note = "not png";
    else {
      const png = PNG.sync.read(buf);
      if (png.width < 24) note = "placeholder";
      else color = dominant(png) ?? (note = "no color", null);
    }
  } catch (e) { note = (e as Error).message; }
  const hand = r.brand_color_hand ?? null;
  r.brand_color = hand ?? color;
  console.log(`${(r.brand_color ?? "-").padEnd(8)} ${hand ? "hand " : color ? "auto " : "none "} ${r.name}${note ? `  (${note})` : ""}`);
}
if (!dry) writeFileSync(file, `${JSON.stringify(real, null, 2)}\n`);
