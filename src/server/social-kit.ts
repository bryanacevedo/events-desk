/* The "I'm going" kit (docs/SPEAKING.md 8): the person's photo, the organizer's kit, the captions (templates, no model) and the images (Satori to SVG, Resvg to PNG).
   Nothing here posts, and nothing here asks LinkedIn for anything. Rendered images are drawn when asked for and kept nowhere. */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import type { Db } from "./db.ts";
import { logActivity, newId, RuleError } from "./events.ts";
import { canPlan } from "./money.ts";
import { Forbidden } from "./seats.ts";
import { slackCall, type SlackConfig } from "./slack.ts";
import { KIT_ROLES, offerKit, type KitRole } from "./kit-offers.ts";

export class KitInvalid extends Error {}

export const KIT_SIZES = [
  { id: "post_landscape", w: 1200, h: 627, label: "LinkedIn post, landscape" },
  { id: "post_portrait", w: 1080, h: 1350, label: "LinkedIn post, 4:5" },
  { id: "banner", w: 1584, h: 396, label: "LinkedIn banner" },
  { id: "square", w: 1080, h: 1080, label: "Square" },
  { id: "story", w: 1080, h: 1920, label: "Story, 9:16" },
  { id: "signature", w: 600, h: 150, label: "Email signature" },
] as const;
export type KitSizeId = (typeof KIT_SIZES)[number]["id"];

const PHOTO_MAX = 2 * 1024 * 1024, LOGO_MAX = 500 * 1024;
export const ROLE_LINE: Record<KitRole, string> = { attending: "I'm going to", speaking: "I'm speaking at", sponsoring: "We're sponsoring", hosting: "I'm hosting at" };

const clean = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n) : "");

/* ------------------------------------------------------------------ bytes */

export function sniff(bytes: Uint8Array): "image/png" | "image/jpeg" | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  return null;
}
const dataUri = (mime: string, b: Uint8Array) => `data:${mime};base64,${Buffer.from(b).toString("base64")}`;

/* ------------------------------------------------------------------ the person's photo */

export async function putPhoto(db: Db, actor: string, bytes: Uint8Array, source: "upload" | "slack") {
  if (bytes.length > PHOTO_MAX) throw new KitInvalid("Use a photo of 2 MB or less.");
  const mime = sniff(bytes);
  if (!mime) throw new KitInvalid("Use a PNG or a JPEG.");
  await db.query("INSERT INTO kit_photos (person, bytes, mime, source) VALUES ($1, $2, $3, $4) ON CONFLICT (person) DO UPDATE SET bytes = $2, mime = $3, source = $4, created_at = now()", [actor, Buffer.from(bytes), mime, source]);
  return { source };
}
export async function removePhoto(db: Db, actor: string) { await db.query("DELETE FROM kit_photos WHERE person = $1", [actor]); return { removed: true }; }
export async function photoOf(db: Db, person: string) {
  const [p] = await db.query<{ bytes: Uint8Array; mime: string; source: string }>("SELECT bytes, mime, source FROM kit_photos WHERE person = $1", [person]);
  return p ?? null;
}

const SLACK_IMAGE_HOSTS = /^(?:[a-z0-9-]+\.)*(?:slack-edge\.com|gravatar\.com|slack-imgs\.com)$/i;
export type ImageFetcher = (url: string) => Promise<Uint8Array>;
const fetchImage: ImageFetcher = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!r.ok) throw new KitInvalid("Slack would not give the photo.");
  const b = new Uint8Array(await r.arrayBuffer());
  return b;
};

/** The person's own Slack picture, only when Slack is connected and knows them, only when they ask. The address must be https on Slack's image hosts. */
export async function useSlackPhoto(db: Db, actor: string, cfg: SlackConfig | undefined, get: ImageFetcher = fetchImage) {
  const id = cfg?.userMap?.[actor];
  if (!cfg || !cfg.botToken || !id) throw new KitInvalid("Slack is not connected for you, so upload a photo instead.");
  const j = (await slackCall(cfg, "users.profile.get", { user: id })) as { ok: boolean; profile?: { image_512?: string; image_original?: string; is_custom_image?: boolean } };
  const url = j.profile?.image_512 ?? j.profile?.image_original;
  if (!j.ok || !url) throw new KitInvalid("Slack gave no photo for you.");
  let u: URL;
  try { u = new URL(url); } catch { throw new KitInvalid("Slack gave no photo for you."); }
  if (u.protocol !== "https:" || !SLACK_IMAGE_HOSTS.test(u.hostname)) throw new KitInvalid("Slack gave no photo for you.");
  const bytes = await get(url);
  await putPhoto(db, actor, bytes, "slack");
  return { source: "slack", custom: j.profile?.is_custom_image !== false };
}

/* ------------------------------------------------------------------ the organizer's kit */

export async function putOrganizerKit(db: Db, actor: string, eventId: string, b: { logo?: Uint8Array | null; color?: unknown; hashtag?: unknown; clear_logo?: boolean }) {
  if (!canPlan(actor)) throw new Forbidden("The organizer's kit is saved by the field marketer, leadership and GTM Engineering.");
  const color = clean(b.color, 7);
  if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) throw new KitInvalid("Give the colour as six hex digits, like #1F5D3F.");
  const tag = clean(b.hashtag, 60).replace(/\s+/g, "");
  if (b.logo) {
    if (b.logo.length > LOGO_MAX) throw new KitInvalid("Use a logo of 500 KB or less.");
    if (sniff(b.logo) !== "image/png") throw new KitInvalid("The logo must be a PNG.");
  }
  await db.tx(async (q) => {
    const [e] = await q("SELECT 1 FROM events WHERE id = $1", [eventId]);
    if (!e) throw new RuleError("That event does not exist.");
    const [old] = await q<{ logo: Uint8Array | null }>("SELECT logo FROM organizer_kits WHERE event_id = $1", [eventId]);
    const logo = b.logo ? Buffer.from(b.logo) : b.clear_logo ? null : old?.logo ?? null;
    await q(`INSERT INTO organizer_kits (event_id, logo, logo_mime, color, hashtag, updated_by) VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (event_id) DO UPDATE SET logo = $2, logo_mime = $3, color = $4, hashtag = $5, updated_by = $6, updated_at = now()`,
      [eventId, logo, logo ? "image/png" : null, color || null, tag, actor]);
    await logActivity(q, eventId, actor, "kit", "Saved the organizer's kit");
  });
  return { saved: true };
}

/* ------------------------------------------------------------------ the words */

export interface KitFacts { event: string; dates: string; place: string; talk: string; booth: string; hashtag: string; role: KitRole }

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function datesWords(start: string, end: string | null): string {
  const [y1, m1, d1] = start.split("-").map(Number);
  if (!end || end === start) return `${d1} ${MONTHS[m1 - 1]} ${y1}`;
  const [y2, m2, d2] = end.split("-").map(Number);
  if (y1 === y2 && m1 === m2) return `${d1} to ${d2} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 === y2) return `${d1} ${MONTHS[m1 - 1]} to ${d2} ${MONTHS[m2 - 1]} ${y1}`;
  return `${d1} ${MONTHS[m1 - 1]} ${y1} to ${d2} ${MONTHS[m2 - 1]} ${y2}`;
}

/** Two or three wordings per role. A fact with no value takes its own sentence out; nothing is left as a blank. Written as templates: no model touches the words. */
export function captions(f: KitFacts): string[] {
  const at = f.place ? `${f.event} in ${f.place}` : f.event;
  const when = f.dates;
  const tag = f.hashtag ? `\n\n${f.hashtag}` : "";
  const join = (parts: (string | false | "")[]) => parts.filter(Boolean).join(" ") + tag;
  switch (f.role) {
    case "attending": return [
      join([`I'll be at ${at}, ${when}.`, "If you are going too, say hello and tell me what you are working on."]),
      join([`${f.event} is ${when}${f.place ? ` in ${f.place}` : ""}, and I am going.`, "I have time for a coffee. Message me."]),
      join([`Going to ${f.event} (${when}).`, f.booth && `Find me at ${f.booth}.`, "Who else is there?"]),
    ];
    case "speaking": return [
      join([f.talk ? `I'm speaking at ${at}: "${f.talk}".` : `I'm speaking at ${at}.`, `${when}.`, "Come to the session, or find me after it."]),
      join([f.talk ? `"${f.talk}" is on the agenda at ${f.event}, ${when}.` : `I'm on the agenda at ${f.event}, ${when}.`, "I would like to hear what you want covered."]),
    ];
    case "sponsoring": return [
      join([`We are sponsoring ${at}, ${when}.`, f.booth && `Stop by ${f.booth}.`, "Book a time with me before the week fills up."]),
      join([`${f.event} is ${when}, and we will have a booth.`, f.booth && `It is ${f.booth}.`, "Message me if you want to meet there."]),
    ];
    case "hosting": return [
      join([`I'm hosting a dinner during ${f.event}${f.place ? ` in ${f.place}` : ""}, ${when}.`, "A small table, no pitch. Message me if you would like a seat."]),
      join([`During ${f.event} I am hosting people for an evening.`, `${when}.`, "If you will be in town, tell me and I will send the details."]),
    ];
  }
}

/* ------------------------------------------------------------------ rendering */

const require_ = createRequire(import.meta.url);
let fonts: { name: string; data: Buffer; weight: 400 | 600; style: "normal" }[] | null = null;
function loadFonts() {
  if (fonts) return fonts;
  const f = (n: string) => readFileSync(require_.resolve(`@fontsource/ibm-plex-sans/files/ibm-plex-sans-${n}-normal.woff`));
  fonts = [
    { name: "Plex", data: f("latin-400"), weight: 400, style: "normal" }, { name: "Plex", data: f("latin-600"), weight: 600, style: "normal" },
    { name: "Plex", data: f("latin-ext-400"), weight: 400, style: "normal" }, { name: "Plex", data: f("latin-ext-600"), weight: 600, style: "normal" },
  ];
  return fonts;
}

export interface CardInput { facts: KitFacts; person: string; photo: { mime: string; bytes: Uint8Array } | null; logo: Uint8Array | null; color: string | null }
type Node = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): Node => ({ type, props: { style: { display: "flex", ...style }, children, ...extra } });
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join("");

function tree(c: CardInput, w: number, h_: number): Node {
  const ground = c.color ?? "#1F5D3F", ink = "#FFFFFF", soft = "rgba(255,255,255,0.78)";
  const wide = w / h_ >= 2.5, tall = h_ / w > 1.2, tiny = w <= 600;
  const u = tiny ? 1 : wide ? 0.62 : w > h_ ? 0.66 : 1;
  const px = (n: number) => Math.round(n * u);
  const photoSize = px(wide ? 190 : tall ? 300 : 220);
  const avatar = c.photo
    ? h("img", { width: photoSize, height: photoSize, borderRadius: photoSize, objectFit: "cover" }, undefined, { src: `data:${c.photo.mime};base64,${Buffer.from(c.photo.bytes).toString("base64")}`, width: photoSize, height: photoSize })
    : h("div", { width: photoSize, height: photoSize, borderRadius: photoSize, background: "rgba(255,255,255,0.16)", color: ink, alignItems: "center", justifyContent: "center", fontSize: Math.round(photoSize * 0.38), fontWeight: 600 }, initials(c.person));
  const logo = c.logo ? h("img", { height: px(wide ? 70 : 84), objectFit: "contain" }, undefined, { src: dataUri("image/png", c.logo), height: px(wide ? 70 : 84) }) : null;
  const f = c.facts;
  const sub = [f.dates, f.place].filter(Boolean).join("  ·  ");
  const detail = f.role === "speaking" && f.talk ? `"${f.talk}"` : f.booth ? f.booth : "";
  const text = h("div", { flexDirection: "column", flex: 1, justifyContent: "center" }, [
    h("div", { fontSize: px(wide ? 30 : 36), color: soft, fontWeight: 400, marginBottom: px(10) }, ROLE_LINE[f.role]),
    h("div", { fontSize: px(wide ? 88 : tall ? 96 : 84), color: ink, fontWeight: 600, lineHeight: 1.05, letterSpacing: -1, maxWidth: wide ? px(900) : w - 2 * px(72) }, f.event),
    h("div", { fontSize: px(wide ? 28 : 36), color: soft, fontWeight: 400, marginTop: px(16) }, sub),
    ...(detail ? [h("div", { fontSize: px(wide ? 26 : 34), color: ink, fontWeight: 400, marginTop: px(14) }, detail)] : []),
  ]);
  const who = h("div", { flexDirection: tall || !wide ? "row" : "row", alignItems: "center", marginTop: wide ? 0 : px(40) }, [
    avatar,
    h("div", { flexDirection: "column", marginLeft: px(24) }, [
      h("div", { fontSize: px(wide ? 34 : 44), color: ink, fontWeight: 600 }, c.person),
      ...(f.hashtag ? [h("div", { fontSize: px(wide ? 24 : 30), color: soft, fontWeight: 400, marginTop: px(6) }, f.hashtag)] : []),
    ]),
  ]);
  if (tiny) {
    return h("div", { boxSizing: "border-box", width: w, height: h_, background: ground, alignItems: "center", padding: "0 24px", fontFamily: "Plex" }, [
      h("div", { flexDirection: "column", flex: 1 }, [h("div", { fontSize: 15, color: soft }, ROLE_LINE[f.role]), h("div", { fontSize: 27, fontWeight: 600, color: ink, lineHeight: 1.1 }, f.event), h("div", { fontSize: 15, color: soft, marginTop: 4 }, [f.dates, c.person].filter(Boolean).join("  ·  "))]),
    ]);
  }
  const pad = px(wide ? 56 : 72);
  if (wide) {
    return h("div", { boxSizing: "border-box", width: w, height: h_, background: ground, fontFamily: "Plex", alignItems: "center", justifyContent: "space-between", padding: `0 ${pad}px` }, [text, ...(logo ? [h("div", { marginRight: px(36) }, logo)] : []), who]);
  }
  return h("div", { boxSizing: "border-box", width: w, height: h_, background: ground, fontFamily: "Plex", flexDirection: "column", justifyContent: "space-between", padding: `${pad}px` }, [
    h("div", { height: px(90), alignItems: "center" }, logo ?? ""),
    text,
    who,
  ]);
}

export async function renderCard(c: CardInput, sizeId: KitSizeId): Promise<Buffer> {
  const s = KIT_SIZES.find((x) => x.id === sizeId);
  if (!s) throw new KitInvalid("That size does not exist.");
  const svg = await satori(tree(c, s.w, s.h) as never, { width: s.w, height: s.h, fonts: loadFonts() });
  // No resource directory and no system fonts: the SVG holds everything it draws, as data.
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: s.w }, font: { loadSystemFonts: false } }).render().asPng());
}

/* ------------------------------------------------------------------ the person's kit */

interface OfferRow { id: string; event_id: string; person: string; role: KitRole; reason: string; status: string; caption: number; post_url: string | null; posted_at: string | null }
const OFFER_COLS = "id, event_id, person, role, reason, status, caption, post_url, posted_at::text AS posted_at";

async function offerFor(db: Db, actor: string, offerId: string) {
  const [o] = await db.query<OfferRow>(`SELECT ${OFFER_COLS} FROM kit_offers WHERE id = $1`, [offerId]);
  if (!o) throw new RuleError("That kit does not exist.");
  if (o.person !== actor && !canPlan(actor)) throw new Forbidden("A kit is the person's own.");
  return o;
}

export async function listOffers(db: Db, actor: string, eventId?: string) {
  const lead = canPlan(actor);
  const where = [lead ? "true" : "o.person = $1"], args: unknown[] = lead ? [] : [actor];
  if (eventId) { args.push(eventId); where.push(`o.event_id = $${args.length}`); }
  return db.query<OfferRow & { event_name: string; has_photo: boolean }>(
    `SELECT ${OFFER_COLS.split(", ").map((x) => (x.includes("::") ? x.replace(/^(\w+)/, "o.$1") : "o." + x)).join(", ")}, e.name AS event_name, EXISTS (SELECT 1 FROM kit_photos p WHERE p.person = o.person) AS has_photo
     FROM kit_offers o JOIN events e ON e.id = o.event_id WHERE ${where.join(" AND ")} AND o.status = 'offered' ORDER BY o.created_at DESC`, args);
}

async function factsFor(db: Db, o: OfferRow): Promise<{ facts: KitFacts; logo: Uint8Array | null; color: string | null }> {
  const [e] = await db.query<{ name: string; venue: string; starts_on: string; ends_on: string | null }>("SELECT name, venue, starts_on::text AS starts_on, ends_on::text AS ends_on FROM events WHERE id = $1", [o.event_id]);
  const [k] = await db.query<{ logo: Uint8Array | null; color: string | null; hashtag: string }>("SELECT logo, color, hashtag FROM organizer_kits WHERE event_id = $1", [o.event_id]);
  const [t] = o.role === "speaking" ? await db.query<{ title: string }>("SELECT title FROM talks WHERE event_id = $1 AND speaker = $2 AND status = 'accepted' ORDER BY created_at LIMIT 1", [o.event_id, o.person]) : [];
  const hashtag = k?.hashtag ? (k.hashtag.startsWith("#") ? k.hashtag : `#${k.hashtag}`) : "";
  return { facts: { event: e.name, dates: datesWords(e.starts_on, e.ends_on), place: e.venue, talk: t?.title ?? "", booth: "", hashtag, role: o.role }, logo: k?.logo ?? null, color: k?.color ?? null };
}

export async function kitSheet(db: Db, actor: string, offerId: string, opts: { slack: boolean }) {
  const o = await offerFor(db, actor, offerId);
  const { facts } = await factsFor(db, o);
  const photo = await db.query<{ source: string }>("SELECT source FROM kit_photos WHERE person = $1", [o.person]);
  const own = o.person === actor;
  return {
    id: o.id, event_id: o.event_id, role: o.role, person: o.person, own, post_url: o.post_url, caption_index: o.caption,
    captions: captions(facts), role_line: ROLE_LINE[o.role],
    photo: own ? (photo[0]?.source ?? null) : null, slack_available: own && opts.slack,
    images: KIT_SIZES.map((s) => ({ id: s.id, w: s.w, h: s.h, label: s.label, url: `/api/kit/${o.id}/image/${s.id}` })),
  };
}

export async function kitImage(db: Db, actor: string, offerId: string, size: string) {
  const o = await offerFor(db, actor, offerId);
  const { facts, logo, color } = await factsFor(db, o);
  const ph = await photoOf(db, o.person);
  return renderCard({ facts, person: o.person, photo: ph ? { mime: ph.mime, bytes: ph.bytes } : null, logo, color }, size as KitSizeId);
}

export async function patchOffer(db: Db, actor: string, offerId: string, b: { post_url?: unknown; dismiss?: unknown; caption?: unknown }) {
  const o = await offerFor(db, actor, offerId);
  if (o.person !== actor) throw new Forbidden("Only the person changes their own kit.");
  if (b.post_url !== undefined) {
    const raw = clean(b.post_url, 500);
    let u: URL | null = null;
    try { u = new URL(raw); } catch { /* not an address */ }
    if (!u || u.protocol !== "https:" || !(u.hostname === "linkedin.com" || u.hostname.endsWith(".linkedin.com")) || u.username || u.password) throw new KitInvalid("Paste the link to your post from linkedin.com.");
    await db.query("UPDATE kit_offers SET post_url = $2, posted_at = now() WHERE id = $1", [offerId, u.toString()]);
  }
  if (b.caption !== undefined && Number.isInteger(b.caption) && (b.caption as number) >= 0 && (b.caption as number) < 3) await db.query("UPDATE kit_offers SET caption = $2 WHERE id = $1", [offerId, b.caption]);
  if (b.dismiss === true) await db.query("UPDATE kit_offers SET status = 'dismissed' WHERE id = $1", [offerId]);
  return { id: offerId };
}

/** The roles an event gives a person, from what the desk already holds. */
export async function rolesFor(db: Db, eventId: string, person: string): Promise<KitRole[]> {
  const roles: KitRole[] = [];
  const seat = await db.query("SELECT 1 FROM who_goes WHERE event_id = $1 AND person = $2 LIMIT 1", [eventId, person]);
  if (seat.length) roles.push("attending");
  if ((await db.query("SELECT 1 FROM talks WHERE event_id = $1 AND speaker = $2 AND status = 'accepted' LIMIT 1", [eventId, person])).length) roles.push("speaking");
  if ((await db.query("SELECT 1 FROM event_people WHERE event_id = $1 AND person = $2 AND removed_at IS NULL AND 'host' = ANY(roles) LIMIT 1", [eventId, person])).length) roles.push("hosting");
  if ((await db.query("SELECT 1 FROM involvements WHERE event_id = $1 AND kind = 'sponsorship' AND status = 'confirmed' AND created_by = $2 LIMIT 1", [eventId, person])).length) roles.push("sponsoring");
  return roles;
}

export async function askKit(db: Db, actor: string, eventId: string, role: string) {
  if (!(KIT_ROLES as readonly string[]).includes(role)) throw new KitInvalid("Pick attending, speaking, sponsoring or hosting.");
  if (!(await rolesFor(db, eventId, actor)).includes(role as KitRole)) throw new RuleError("The event does not give you that role yet.");
  return db.tx(async (q) => {
    await q("UPDATE kit_offers SET status = 'offered' WHERE event_id = $1 AND person = $2 AND role = $3 AND status = 'dismissed'", [eventId, actor, role]);
    await offerKit(q, { eventId, person: actor, role: role as KitRole, reason: "asked", actor });
    const [o] = await q<{ id: string }>("SELECT id FROM kit_offers WHERE event_id = $1 AND person = $2 AND role = $3", [eventId, actor, role]);
    return { id: o.id };
  });
}

/** Posters and the meetings they held, counted from the desk's own rows. Not a finding: nobody is made to post, and who posts is not random. */
export async function postingCounts(db: Db, eventId: string) {
  const rows = await db.query<{ person: string; posted: boolean; held: number }>(
    `SELECT o.person, bool_or(o.post_url IS NOT NULL) AS posted, (SELECT count(*)::int FROM meetings m WHERE m.event_id = o.event_id AND m.rep = o.person AND m.status = 'held') AS held
     FROM kit_offers o WHERE o.event_id = $1 GROUP BY o.person, o.event_id`, [eventId]);
  const p = rows.filter((r) => r.posted), n = rows.filter((r) => !r.posted);
  return { people: rows.length, posted: p.length, meetings_posters: p.reduce((a, r) => a + r.held, 0), not_posted: n.length, meetings_others: n.reduce((a, r) => a + r.held, 0) };
}
