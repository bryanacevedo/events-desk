/* The "I'm going" kit (docs/SPEAKING.md 8): what fires it, the photo's two sources, the six images at their exact sizes, the captions, who reads whose kit, and that nothing here
   talks to LinkedIn. */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import type { Db } from "../src/server/db.ts";
import { addInvolvement, createPlan, updateInvolvement } from "../src/server/plan.ts";
import { decideSeat, parseSeatRequest, requestSeat } from "../src/server/seats.ts";
import { askKit, captions, cardSvg, datesWords, kitImage, kitSheet, KIT_SIZES, listOffers, patchOffer, photoOf, postingCounts, putOrganizerKit, putPhoto, removePhoto, renderCard, sniff, useSlackPhoto, type CardInput } from "../src/server/social-kit.ts";
import { freshDb } from "./helpers.ts";

const CAMILLE = "Camille Laurent", DAN = "Dan Whitlock", MAYA = "Maya Ortiz";
let db: Db, eventId: string;
const png = (): Uint8Array => new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#336699"/></svg>').render().asPng());
const input: CardInput = { facts: { event: "Money20/20 USA 2026", dates: "18 to 21 October 2026", place: "Las Vegas", talk: "Billing without surprises", booth: "", hashtag: "#Money2020", role: "speaking" }, person: "Camille Laurent", photo: null, logo: null, color: null };
const as = (a: string) => ({ "x-actor": encodeURIComponent(a), "content-type": "application/json" });

beforeAll(async () => {
  db = await freshDb();
  eventId = (await createPlan(db, CAMILLE, { name: "Kit Summit", venue: "Lisbon", country: "Portugal", starts_on: "2027-03-01", ends_on: "2027-03-03", reason: "The buyers we sell to meet there." })).id;
}, 60_000);

describe("what fires a kit", () => {
  it("approving a seat offers the requester an attending kit, once", async () => {
    await db.query("INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents) VALUES ('cat_k', 'Seat Summit', 'Hall', 'Lisbon', 'Portugal', '2027-05-01', '2027-05-02', 'https://example.com', 1000)");
    const body = { catalog_id: "cat_k", team: "Sales", role: "SDR", goal: "new_pipeline", expected_meetings: 3, why_event: "Their buyers are the people we sell to.", why_you: "I run outreach for this region and know the buyers well." };
    const r = await requestSeat(db, MAYA, parseSeatRequest(MAYA, body));
    const [req] = await db.query<{ id: string; event_id: string }>("SELECT id, event_id FROM seat_requests ORDER BY created_at DESC LIMIT 1");
    await decideSeat(db, { requestId: req.id, actor: DAN, decision: "approve" });
    await decideSeat(db, { requestId: req.id, actor: DAN, decision: "approve" });
    const o = await db.query<any>("SELECT person, role, reason FROM kit_offers WHERE event_id = $1", [req.event_id]);
    expect(o).toEqual([{ person: MAYA, role: "attending", reason: "seat_approved" }]);
    expect(r).toBeDefined();
  });
  it("a declined seat offers nothing", async () => {
    const body = { catalog_id: "cat_k", team: "Sales", role: "SDR", goal: "new_pipeline", expected_meetings: 3, why_event: "Their buyers are the people we sell to.", why_you: "I run outreach for this region and know the buyers well." };
    await requestSeat(db, "Leo Marsh", parseSeatRequest("Leo Marsh", body));
    const [req] = await db.query<{ id: string }>("SELECT id FROM seat_requests WHERE requester = 'Leo Marsh'");
    await decideSeat(db, { requestId: req.id, actor: DAN, decision: "decline", reason: "No budget." });
    expect(await db.query("SELECT 1 FROM kit_offers WHERE person = 'Leo Marsh'")).toHaveLength(0);
  });
  it("confirming a sponsorship offers its maker a sponsoring kit; confirming a hosted event offers the host", async () => {
    const s = await addInvolvement(db, CAMILLE, eventId, { kind: "sponsorship", label: "Booth" });
    await updateInvolvement(db, CAMILLE, eventId, s.id, { status: "confirmed" });
    await updateInvolvement(db, CAMILLE, eventId, s.id, { status: "confirmed" });
    expect(await db.query<any>("SELECT person, role FROM kit_offers WHERE event_id = $1 AND role = 'sponsoring'", [eventId])).toEqual([{ person: CAMILLE, role: "sponsoring" }]);
    const d = await createPlan(db, CAMILLE, { name: "Kit Dinner", venue: "Lisbon", country: "Portugal", starts_on: "2027-03-02", reason: "Six customers at one table.", hosted: { format: "dinner", conference_event_id: eventId, headcount: 10 } });
    await db.query("INSERT INTO event_people (id, event_id, person, roles, added_by) VALUES ('ep_k', $1, $2, ARRAY['host'], $3)", [d.id, MAYA, CAMILLE]);
    const [h] = await db.query<{ id: string }>("SELECT id FROM involvements WHERE event_id = $1 AND kind = 'hosted'", [d.id]);
    await updateInvolvement(db, CAMILLE, d.id, h.id, { status: "confirmed" });
    expect(await db.query<any>("SELECT person, role FROM kit_offers WHERE event_id = $1", [d.id])).toEqual([{ person: MAYA, role: "hosting" }]);
  });
  it("a person can ask only for a role the event gives them", async () => {
    await expect(askKit(db, MAYA, eventId, "speaking")).rejects.toThrow(/does not give you/);
    await expect(askKit(db, MAYA, eventId, "astronaut")).rejects.toThrow(/Pick/);
  });
});

describe("the six images", () => {
  it("each renders as a PNG of exactly its pixel size", async () => {
    expect(KIT_SIZES.map((s) => [s.w, s.h])).toEqual([[1200, 627], [1080, 1350], [1584, 396], [1080, 1080], [1080, 1920], [600, 150]]);
    for (const s of KIT_SIZES) {
      const b = await renderCard(input, s.id);
      expect(b.subarray(1, 4).toString()).toBe("PNG");
      expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([s.w, s.h]);
    }
  }, 30_000);
  it("the drawing for a fixed input does not change (a snapshot of each size's SVG)", async () => {
    const hashes: Record<string, string> = {};
    for (const s of KIT_SIZES) hashes[s.id] = createHash("sha256").update(await cardSvg(input, s.id)).digest("hex").slice(0, 12);
    expect(Object.keys(hashes)).toHaveLength(6);
    expect(new Set(Object.values(hashes)).size).toBe(6);
    expect(hashes).toMatchSnapshot();
  });
  it("a photo and an organizer logo change the drawing; no photo draws initials", async () => {
    const plain = await cardSvg(input, "square");
    const withPhoto = await cardSvg({ ...input, photo: { mime: "image/png", bytes: png() } }, "square");
    const withLogo = await cardSvg({ ...input, logo: png(), color: "#112233" }, "square");
    expect(withPhoto).not.toBe(plain); expect(withLogo).not.toBe(plain);
    expect(plain).toContain("<path"); // initials are drawn as glyph paths
  });
  it("every role has its own line and two or more wordings, and an empty fact takes its sentence out", () => {
    const f = { event: "Kit Summit", dates: "1 to 3 March 2027", place: "Lisbon", talk: "", booth: "", hashtag: "", role: "attending" as const };
    for (const role of ["attending", "speaking", "sponsoring", "hosting"] as const) {
      const c = captions({ ...f, role });
      expect(c.length).toBeGreaterThanOrEqual(2);
      for (const text of c) { expect(text).not.toMatch(/\{|\}|undefined|null|—|!{1}\s*$/); expect(text).not.toMatch(/excited|thrilled|delighted/i); }
    }
    expect(captions({ ...f, role: "attending" }).join(" ")).not.toContain("Find me at");
    expect(captions({ ...f, role: "attending", booth: "Booth 2418" }).join(" ")).toContain("Find me at Booth 2418");
    expect(captions({ ...f, role: "speaking", talk: "Billing" })[0]).toContain('"Billing"');
    expect(datesWords("2027-03-01", "2027-03-03")).toBe("1 to 3 March 2027");
    expect(datesWords("2027-03-30", "2027-04-02")).toBe("30 March to 2 April 2027");
  });
});

describe("the photo", () => {
  it("is checked by its bytes and size, replaced by a new one and removed in one call", async () => {
    await expect(putPhoto(db, MAYA, new TextEncoder().encode("not an image at all"), "upload")).rejects.toThrow(/PNG or a JPEG/);
    await expect(putPhoto(db, MAYA, new Uint8Array(3 * 1024 * 1024).fill(1), "upload")).rejects.toThrow(/2 MB/);
    await putPhoto(db, MAYA, png(), "upload");
    expect(sniff((await photoOf(db, MAYA))!.bytes)).toBe("image/png");
    await removePhoto(db, MAYA);
    expect(await photoOf(db, MAYA)).toBeNull();
    expect(await db.query("SELECT 1 FROM kit_photos WHERE person = $1", [MAYA])).toHaveLength(0);
  });
  it("comes from Slack only when Slack is connected and knows the person, only on their tap, only from Slack's image hosts", async () => {
    await expect(useSlackPhoto(db, MAYA, undefined)).rejects.toThrow(/not connected/);
    const slack = (url: string) => ({ botToken: "x", userMap: { [MAYA]: "UMAYA" }, approvers: [], channel: "C", fetch: (async () => new Response(JSON.stringify({ ok: true, profile: { image_512: url, is_custom_image: true } }))) as typeof fetch });
    await expect(useSlackPhoto(db, "Nobody Known", slack("https://avatars.slack-edge.com/a.png") as never)).rejects.toThrow(/not connected/);
    await expect(useSlackPhoto(db, MAYA, slack("https://evil.example/a.png") as never, async () => png())).rejects.toThrow(/no photo/);
    await expect(useSlackPhoto(db, MAYA, slack("http://avatars.slack-edge.com/a.png") as never, async () => png())).rejects.toThrow(/no photo/);
    const r = await useSlackPhoto(db, MAYA, slack("https://avatars.slack-edge.com/a.png") as never, async () => png());
    expect(r.source).toBe("slack");
    expect((await photoOf(db, MAYA))!.source).toBe("slack");
    await removePhoto(db, MAYA);
  });
  it("is not read in the background: nothing but the person's tap calls users.profile.get", () => {
    const hits = walk("src").filter((f) => /users\.profile\.get/.test(readFileSync(f, "utf8")));
    expect(hits.map((f) => f.replace(/\\/g, "/"))).toEqual(["src/server/social-kit.ts"]);
  });
});

describe("who reads whose kit, and the post link", () => {
  it("a rep cannot read another person's kit or image; a planner can; the photo control shows only to its owner", async () => {
    const app = createApp(db, { demo: true });
    const offers = await listOffers(db, CAMILLE, eventId);
    const mine = offers.find((o) => o.person === CAMILLE)!;
    expect((await app.request(`/api/kit/${mine.id}`, { headers: as(MAYA) })).status).toBe(403);
    expect((await app.request(`/api/kit/${mine.id}/image/square`, { headers: as(MAYA) })).status).toBe(403);
    const ok = await app.request(`/api/kit/${mine.id}/image/square`, { headers: as(CAMILLE) });
    expect(ok.status).toBe(200); expect(ok.headers.get("content-type")).toBe("image/png"); expect(ok.headers.get("cache-control")).toContain("no-store");
    const seen = await kitSheet(db, DAN, mine.id, { slack: true });
    expect(seen.own).toBe(false); expect(seen.slack_available).toBe(false); expect(seen.images).toHaveLength(6);
    expect(await listOffers(db, MAYA)).not.toContainEqual(expect.objectContaining({ person: CAMILLE }));
  });
  it("a pasted post link is saved only when it is https on linkedin.com, and is never fetched", async () => {
    const mine = (await listOffers(db, CAMILLE, eventId)).find((o) => o.person === CAMILLE)!;
    for (const bad of ["https://evil.example/linkedin.com", "https://notlinkedin.com/p", "http://www.linkedin.com/p", "not a link"]) await expect(patchOffer(db, CAMILLE, mine.id, { post_url: bad })).rejects.toThrow(/linkedin\.com/);
    await expect(patchOffer(db, MAYA, mine.id, { post_url: "https://www.linkedin.com/posts/x" })).rejects.toThrow();
    await patchOffer(db, CAMILLE, mine.id, { post_url: "https://www.linkedin.com/posts/camille_x" });
    const c = await postingCounts(db, eventId);
    expect(c.posted).toBe(1);
  });
  it("the organizer's kit is a planner's, a PNG logo only, and a bad colour is refused", async () => {
    await expect(putOrganizerKit(db, MAYA, eventId, { color: "#112233" })).rejects.toThrow();
    await expect(putOrganizerKit(db, CAMILLE, eventId, { color: "green" })).rejects.toThrow(/hex/);
    await expect(putOrganizerKit(db, CAMILLE, eventId, { logo: new TextEncoder().encode("<svg onload=alert(1)></svg>") })).rejects.toThrow(/PNG/);
    await putOrganizerKit(db, CAMILLE, eventId, { logo: png(), color: "#112233", hashtag: "KitSummit" });
    const mine = (await listOffers(db, CAMILLE, eventId)).find((o) => o.person === CAMILLE)!;
    const b = await kitImage(db, CAMILLE, mine.id, "banner");
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([1584, 396]);
    expect((await kitSheet(db, CAMILLE, mine.id, { slack: false })).captions.join(" ")).toContain("#KitSummit");
  });
});

describe("nothing here talks to LinkedIn", () => {
  it("no source file requests a LinkedIn address, holds a LinkedIn credential, or names its posting API", () => {
    const files = walk("src");
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/w_member_social|ugcPosts|api\.linkedin\.com|registerUpload/);
      for (const m of src.matchAll(/(fetch|httpsRequest|request|get|post)\(\s*[`"'][^`"']*linkedin\.com/g)) throw new Error(`${f} requests ${m[0]}`);
    }
    expect(readFileSync("src/server/social-kit.ts", "utf8")).not.toMatch(/fetch\([^)]*linkedin/);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|mjs)$/.test(n) ? [p] : []; });
}
