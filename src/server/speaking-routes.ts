/* Speaking and the kit over HTTP (docs/SPEAKING.md 10). Same pattern as the plan's routes: a bad body is a 400 with one sentence, a refusal is a 403. */

import type { Context, Hono } from "hono";
import type { Db } from "./db.ts";
import { RuleError } from "./events.ts";
import { Forbidden } from "./seats.ts";
import { PlanInvalid, todayOf } from "./plan.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import type { SlackConfig } from "./slack.ts";
import { mockLlm, type Llm } from "./providers.ts";
import type { PageFetcher } from "./assessment.ts";
import { AssessmentInvalid } from "./assessment.ts";
import { acceptTalk, addCall, approveAbstract, approveSlides, createTalk, declineTalk, passCall, proposeCalls, saveTalk, slidesSent, speakingView, SpeakingInvalid, submitTalk } from "./talks.ts";
import { askKit, kitImage, kitSheet, KitInvalid, listOffers, patchOffer, putOrganizerKit, putPhoto, removePhoto, useSlackPhoto, type ImageFetcher } from "./social-kit.ts";
import { Invalid } from "./seats.ts";

type Cfg = { demo: boolean; publicDemo?: boolean; slack?: SlackConfig; lifecycle?: LifecycleDeps; llm?: Llm; fetchPage?: PageFetcher; fetchImage?: ImageFetcher };
type Body = Record<string, any>;

export function mountSpeaking(app: Hono<any>, db: Db, cfg: Cfg) {
  const body = async (c: Context): Promise<Body> => ((await c.req.json().catch(() => ({}))) ?? {}) as Body;
  const refuse = (msg: string, status: 400 | 403 | 404) => Response.json({ error: msg }, { status });
  const run = async <T>(fn: () => Promise<T>, status: 200 | 201 = 200) => {
    try { return Response.json(await fn(), { status }); }
    catch (e) {
      if (e instanceof SpeakingInvalid || e instanceof KitInvalid || e instanceof PlanInvalid || e instanceof Invalid || e instanceof AssessmentInvalid) return refuse(e.message, 400);
      if (e instanceof Forbidden) return refuse(e.message, 403);
      throw e;
    }
  };
  const actor = (c: Context): string => c.get("actor");
  const id = (c: Context) => c.req.param("id") as string;
  const today = () => todayOf(cfg.lifecycle);
  const slackReady = Boolean(cfg.slack?.botToken);

  app.get("/api/speaking", async (c) => c.json(await speakingView(db, actor(c), today())));
  app.get("/api/events/:id/speaking", async (c) => c.json(await speakingView(db, actor(c), today(), { eventId: id(c) })));
  app.post("/api/events/:id/calls", async (c) => { const b = await body(c); return run(() => addCall(db, actor(c), id(c), b), 201); });
  app.post("/api/events/:id/calls/propose", async (c) => {
    const b = await body(c);
    return run(() => proposeCalls(db, cfg.llm ?? mockLlm, actor(c), id(c), b, { fetchPage: cfg.demo && !cfg.fetchPage ? null : cfg.fetchPage }));
  });
  app.post("/api/calls/:id/pass", async (c) => { const b = await body(c); return run(() => passCall(db, actor(c), id(c), String(b.reason ?? ""))); });
  app.post("/api/calls/:id/talk", async (c) => {
    const [call] = await db.query<{ event_id: string }>("SELECT event_id FROM calls_for_papers WHERE id = $1", [id(c)]);
    if (!call) return refuse("That call does not exist.", 404);
    return run(() => createTalk(db, actor(c), call.event_id, { cfp_id: id(c) }), 201);
  });
  app.post("/api/events/:id/talks", async (c) => { const b = await body(c); return run(() => createTalk(db, actor(c), id(c), { involvement_id: b.involvement_id }), 201); });
  app.patch("/api/talks/:id", async (c) => { const b = await body(c); return run(() => saveTalk(db, actor(c), id(c), b)); });
  app.post("/api/talks/:id/approve-abstract", (c) => run(() => approveAbstract(db, actor(c), id(c))));
  app.post("/api/talks/:id/submit", (c) => run(() => submitTalk(db, actor(c), id(c), today())));
  app.post("/api/talks/:id/accept", (c) => run(() => acceptTalk(db, actor(c), id(c))));
  app.post("/api/talks/:id/decline", async (c) => { const b = await body(c); return run(() => declineTalk(db, actor(c), id(c), String(b.reason ?? ""))); });
  app.post("/api/talks/:id/approve-slides", (c) => run(() => approveSlides(db, actor(c), id(c))));
  app.post("/api/talks/:id/slides-sent", (c) => run(() => slidesSent(db, actor(c), id(c), today())));

  app.get("/api/kit/offers", async (c) => c.json({ offers: await listOffers(db, actor(c), c.req.query("event") || undefined), slack: slackReady }));
  app.post("/api/events/:id/kit", async (c) => { const b = await body(c); return run(() => askKit(db, actor(c), id(c), String(b.role ?? "")), 201); });
  // The photo is the person's own: the route name carries no person.
  app.put("/api/kit/photo", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return run(() => putPhoto(db, actor(c), bytes, "upload"));
  });
  app.delete("/api/kit/photo", (c) => run(() => removePhoto(db, actor(c))));
  app.post("/api/kit/photo/slack", (c) => run(() => useSlackPhoto(db, actor(c), cfg.slack, cfg.fetchImage)));
  app.put("/api/events/:id/organizer-kit", async (c) => {
    const b = await body(c);
    const logo = typeof b.logo_base64 === "string" && b.logo_base64 ? new Uint8Array(Buffer.from(b.logo_base64, "base64")) : null;
    return run(() => putOrganizerKit(db, actor(c), id(c), { logo, color: b.color, hashtag: b.hashtag, clear_logo: b.clear_logo === true }));
  });
  app.get("/api/kit/:id", async (c) => { try { return c.json(await kitSheet(db, actor(c), id(c), { slack: slackReady })); } catch (e) { if (e instanceof Forbidden) return refuse(e.message, 403); if (e instanceof RuleError) return refuse(e.message, 404); throw e; } });
  app.patch("/api/kit/:id", async (c) => { const b = await body(c); return run(() => patchOffer(db, actor(c), id(c), b)); });
  app.get("/api/kit/:id/image/:size", async (c) => {
    try {
      const png = await kitImage(db, actor(c), id(c), c.req.param("size") as string);
      const name = `${id(c)}-${c.req.param("size")}.png`;
      return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "cache-control": "private, no-store", ...(c.req.query("download") ? { "content-disposition": `attachment; filename="${name}"` } : {}) } });
    } catch (e) {
      if (e instanceof Forbidden) return refuse(e.message, 403);
      if (e instanceof KitInvalid || e instanceof RuleError) return refuse(e.message, 404);
      throw e;
    }
  });
}
