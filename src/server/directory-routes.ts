/* The directory extension and the screen recording over HTTP (docs/DIRECTORY.md 5, 8, 9 and 13). The two capture routes take a Bearer key and nothing else; app.ts lets exactly those two past the actor middleware.
   Everything else here sits behind the normal write key and the acting name. */

import type { Context, Hono } from "hono";
import type { Db } from "./db.ts";
import { RuleError } from "./events.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { mockLlm, type Llm } from "./providers.ts";
import { defaultSettings } from "./approvals.ts";
import {
  authCapture, bringIn, captureAdd, captureEvents, createCaptureKey, createRecording, directoryPanel, DirectoryError, dismissRead, finishRecording, keepRead, listCaptureKeys, readFrame, recordingAbility, revokeCaptureKey,
} from "./directory.ts";

type Cfg = { publicDemo?: boolean; llm?: Llm; lifecycle?: LifecycleDeps };

export function mountDirectory(app: Hono<any>, db: Db, cfg: Cfg, hooks: { autoQuote: (eventId: string) => Promise<void> }) {
  const llm = cfg.llm ?? mockLlm;
  const now = () => cfg.lifecycle?.now?.() ?? new Date();
  const actorOf = (c: Context): string => c.get("actor");
  const id = (c: Context, k = "id") => c.req.param(k) as string;
  const run = async <T>(fn: () => Promise<T>, status: 200 | 201 = 200) => {
    try { return Response.json(await fn(), { status }); }
    catch (e) {
      if (e instanceof DirectoryError) return Response.json({ error: e.message }, { status: e.status });
      if (e instanceof RuleError) return Response.json({ error: e.message }, { status: 409 });
      throw e;
    }
  };
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, any>;
  // The key's owner is the actor for the rest of the request.
  const keyOf = async (c: Context) => { const key = await authCapture(db, c.req.header("authorization")); c.set("actor", key.owner); return key; };
  const blocked = () => defaultSettings().email_country_rules?.blocked ?? [];

  // The extension's two routes. The actor is the key's owner; there is no write key and no acting name.
  app.get("/api/capture/events", (c) => run(async () => { await keyOf(c); return { events: await captureEvents(db) }; }));
  app.post("/api/capture/people", (c) => run(async () => captureAdd(db, await keyOf(c), await body(c), now())));

  app.post("/api/capture-keys", (c) => run(async () => createCaptureKey(db, actorOf(c), (await body(c)).label), 201));
  app.get("/api/capture-keys", (c) => run(async () => ({ keys: actorOf(c) ? await listCaptureKeys(db, actorOf(c)) : [] })));
  app.delete("/api/capture-keys/:id", (c) => run(() => revokeCaptureKey(db, actorOf(c), id(c))));

  app.get("/api/events/:id/directory", (c) => run(() => directoryPanel(db, id(c), blocked(), recordingAbility(llm, cfg.publicDemo))));
  app.post("/api/events/:id/directory/reads/:rid/keep", (c) => run(async () => ({ read: await keepRead(db, id(c), id(c, "rid"), await body(c)) })));
  app.post("/api/events/:id/directory/reads/:rid/dismiss", (c) => run(() => dismissRead(db, id(c), id(c, "rid"))));
  app.post("/api/events/:id/directory/bring-in", (c) => run(async () => {
    const out = await bringIn(db, id(c), actorOf(c), now());
    await hooks.autoQuote(id(c));
    return out;
  }));

  app.post("/api/events/:id/recordings", (c) => run(async () => createRecording(db, llm, id(c), actorOf(c), (await body(c)).app_name), 201));
  app.post("/api/recordings/:rid/frames", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return run(() => readFrame(db, llm, actorOf(c), id(c, "rid"), Number(c.req.header("x-frame")), bytes, now()));
  });
  app.post("/api/recordings/:rid/finish", (c) => run(() => finishRecording(db, actorOf(c), id(c, "rid"))));
}
