/* A hosted event over HTTP (docs/HOSTED.md 15 and 21). Who writes is decided here, once: planners, leads and GTM; the people on the event's list with the host role; and, for one guest,
   that guest's owner (the invitation, notes). Check-in is the same plus anyone on the event's people list. A rep who is not any of those reads the list (owner words only, no rsvp token) and
   may nominate a guest of their own. The public RSVP link is mounted here too and is the only /api write that takes no actor and no write key. */

import type { Context, Hono } from "hono";
import type { Db } from "./db.ts";
import { canPlan } from "./money.ts";
import { Forbidden, Invalid } from "./seats.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import {
  addGuest, canCheckInHosted, canWriteHosted, checkIn, closeAttendance, HostedInvalid, invitationText, logInvitation, moveGuest, ownsGuest, patchHosted, removeGuest, undoCheckIn, updateGuest, walkIn,
  type GuestInput, type HostedDeps, type HostedPatch,
} from "./hosted.ts";
import { conferenceOwnerGateFor, followUp, hostedView, myGuests, putCohost, putVenue, suggestions, type Flags, type VenueInput } from "./hosted-view.ts";
import { reminderPreview, sendReminder } from "./hosted-reminders.ts";
import { addTargetAccount, importGuests, importTargetAccounts, type TargetInput } from "./guest-import.ts";
import { mountRsvp } from "./rsvp.ts";
import { simulatedSender, type TransactionalSender } from "./transactional.ts";

type Cfg = { demo: boolean; lifecycle?: LifecycleDeps; /** The sender reminders go through. Absent in the demo, the simulated one; absent live, reminders are refused. */ transactional?: TransactionalSender };
type Body = Record<string, any>;
export const WRITER_REFUSAL = "The host, a planner or leadership does that.";
export const OWNER_REFUSAL = "Only the guest's owner, the host or a planner does that.";

export function mountHosted(app: Hono<any>, db: Db, cfg: Cfg) {
  const simulated = cfg.demo && !cfg.transactional ? simulatedSender() : null;
  const deps = (_c?: Context): HostedDeps => ({
    now: cfg.lifecycle?.now, notify: cfg.lifecycle?.notify, userMap: cfg.lifecycle?.userMap, appUrl: cfg.lifecycle?.appUrl ?? process.env.APP_URL,
    sender: cfg.transactional ?? simulated, live: !cfg.demo,
  });
  const body = async (c: Context): Promise<Body> => ((await c.req.json().catch(() => ({}))) ?? {}) as Body;
  const refuse = (msg: string, status: 400 | 403 | 404) => Response.json({ error: msg }, { status });
  const run = async <T>(fn: () => Promise<T>, status: 200 | 201 = 200) => {
    try { return Response.json(await fn(), { status }); }
    catch (e) {
      if (e instanceof HostedInvalid || e instanceof Invalid) return refuse(e.message, 400);
      if (e instanceof Forbidden) return refuse(e.message, 403);
      throw e;
    }
  };
  const actorOf = (c: Context): string => c.get("actor");
  const id = (c: Context) => c.req.param("id") as string;
  const gid = (c: Context) => c.req.param("gid") as string;
  const origin = (c: Context) => deps().appUrl || new URL(c.req.url).origin;
  const flagsOf = async (c: Context): Promise<Flags> => ({ money: canPlan(actorOf(c)), can_write: await canWriteHosted(db, actorOf(c), id(c)), can_check_in: await canCheckInHosted(db, actorOf(c), id(c)) });
  const writer = async (c: Context) => canWriteHosted(db, actorOf(c), id(c));

  mountRsvp(app, db, () => deps());

  app.get("/api/events/:id/hosted", (c) => run(async () => hostedView(db, deps(c), id(c), actorOf(c), await flagsOf(c))));
  app.patch("/api/events/:id/hosted", async (c) => {
    if (!(await writer(c))) return refuse(WRITER_REFUSAL, 403);
    const b = (await body(c)) as HostedPatch;
    return run(() => patchHosted(db, actorOf(c), id(c), b));
  });

  // Nominating is open to anyone: the nominator becomes the owner. Everything else on the list is the host's, a planner's or leadership's.
  app.post("/api/events/:id/guests", async (c) => {
    const b = (await body(c)) as GuestInput & { conference_company?: string };
    const actor = actorOf(c), w = await writer(c);
    const input: GuestInput = w ? b : { ...b, source: "nomination", nominated_by: actor, owner: actor, side: "us" };
    if (!w && b.owner && b.owner !== actor) return refuse("You nominate guests for yourself. The host or a planner assigns an owner.", 403);
    return run(async () => {
      // The owner-kept rule holds whenever the company is one the owner kept, however the guest was sent.
      for (const co of new Set([b.conference_company, b.company].map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean))) await conferenceOwnerGateFor(db, id(c), co, actor);
      return addGuest(db, actor, id(c), input, { at: deps().now?.() });
    }, 201);
  });
  app.patch("/api/events/:id/guests/:gid", async (c) => {
    const b = (await body(c)) as GuestInput;
    if (await writer(c)) return run(() => updateGuest(db, actorOf(c), id(c), gid(c), b));
    if (await ownsGuest(db, actorOf(c), id(c), gid(c))) return run(() => updateGuest(db, actorOf(c), id(c), gid(c), b, { ownerOnly: true }));
    return refuse(OWNER_REFUSAL, 403);
  });
  app.delete("/api/events/:id/guests/:gid", async (c) => {
    if (!(await writer(c))) return refuse(WRITER_REFUSAL, 403);
    const b = await body(c);
    return run(() => removeGuest(db, deps(c), actorOf(c), id(c), gid(c), String(b.reason ?? "")));
  });

  // The invitation: the text the host copies, and the log that it went. The desk sends nothing.
  const mayInvite = async (c: Context) => (await writer(c)) || (await ownsGuest(db, actorOf(c), id(c), gid(c)));
  app.get("/api/events/:id/guests/:gid/invitation", async (c) => {
    if (!(await mayInvite(c))) return refuse(OWNER_REFUSAL, 403);
    return run(() => invitationText(db, id(c), gid(c), origin(c)));
  });
  app.post("/api/events/:id/guests/:gid/invitation", async (c) => {
    if (!(await mayInvite(c))) return refuse(OWNER_REFUSAL, 403);
    const b = await body(c);
    return run(() => logInvitation(db, actorOf(c), id(c), gid(c), { sent_on: b.sent_on, mailbox: b.mailbox, sent_by: b.sent_by }, { now: deps().now?.() }), 201);
  });

  app.post("/api/events/:id/guests/:gid/check-in", async (c) => ((await canCheckInHosted(db, actorOf(c), id(c))) ? run(() => checkIn(db, deps(c), actorOf(c), id(c), gid(c))) : refuse("Check-in is for the people on this event's list.", 403)));
  app.post("/api/events/:id/guests/:gid/undo-check-in", async (c) => ((await canCheckInHosted(db, actorOf(c), id(c))) ? run(() => undoCheckIn(db, deps(c), actorOf(c), id(c), gid(c))) : refuse("Check-in is for the people on this event's list.", 403)));
  app.post("/api/events/:id/walk-ins", async (c) => {
    if (!(await canCheckInHosted(db, actorOf(c), id(c)))) return refuse("Check-in is for the people on this event's list.", 403);
    const b = (await body(c)) as GuestInput;
    return run(() => walkIn(db, deps(c), actorOf(c), id(c), b), 201);
  });
  app.post("/api/events/:id/guests/:gid/move", async (c) => {
    if (!(await writer(c))) return refuse(WRITER_REFUSAL, 403);
    const b = await body(c);
    return run(() => moveGuest(db, deps(c), actorOf(c), id(c), gid(c), String(b.to ?? ""), { reason: b.reason }));
  });

  app.get("/api/events/:id/reminders", async (c) => {
    if (!(await writer(c))) return refuse(WRITER_REFUSAL, 403);
    const kind = (c.req.query("kind") ?? "reminder") as "reminder" | "logistics";
    return run(() => reminderPreview(db, id(c), kind, { note: c.req.query("note") ?? "", origin: origin(c), live: !cfg.demo, hasSender: Boolean(cfg.transactional ?? simulated) }));
  });
  app.post("/api/events/:id/reminders", async (c) => {
    if (!(await writer(c))) return refuse(WRITER_REFUSAL, 403);
    const b = await body(c);
    return run(() => sendReminder(db, deps(c), actorOf(c), id(c), (b.kind ?? "reminder") as "reminder" | "logistics", { note: b.note, origin: origin(c) }), 201);
  });

  app.post("/api/events/:id/close-attendance", async (c) => ((await writer(c)) ? run(() => closeAttendance(db, deps(c), actorOf(c), id(c))) : refuse(WRITER_REFUSAL, 403)));
  app.get("/api/events/:id/follow-up", (c) => run(() => followUp(db, deps(c), id(c), { money: canPlan(actorOf(c)) })));

  app.put("/api/events/:id/venue", async (c) => {
    if (!(await writer(c))) return refuse(WRITER_REFUSAL, 403);
    const b = (await body(c)) as VenueInput;
    return run(() => putVenue(db, deps(c), actorOf(c), id(c), b));
  });
  app.put("/api/events/:id/cohosts", async (c) => {
    if (!(await writer(c))) return refuse(WRITER_REFUSAL, 403);
    const b = await body(c);
    return run(() => putCohost(db, actorOf(c), id(c), b));
  });

  // Imports are uploads: a CSV body (or JSON { text, source }), refused in the public demo by the app's middleware.
  const csvOf = async (c: Context): Promise<{ csv: string; source: string }> => {
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("json")) { const b = await body(c); return { csv: String(b.text ?? b.csv ?? ""), source: String(b.source ?? c.req.query("source") ?? "") }; }
    return { csv: await c.req.text(), source: c.req.query("source") ?? c.req.header("x-source") ?? "" };
  };
  app.post("/api/events/:id/guests/import", async (c) => {
    if (!(await writer(c))) return refuse(WRITER_REFUSAL, 403);
    const { csv, source } = await csvOf(c);
    return run(() => importGuests(db, deps(c), actorOf(c), id(c), source, csv));
  });
  app.get("/api/events/:id/guests/suggestions", (c) => run(() => suggestions(db, id(c), { money: canPlan(actorOf(c)) })));
  app.post("/api/target-accounts", async (c) => {
    if (!canPlan(actorOf(c))) return refuse("Target accounts are written by planners, leadership and GTM Engineering.", 403);
    const b = (await body(c)) as TargetInput;
    return run(() => addTargetAccount(db, actorOf(c), b), 201);
  });
  app.post("/api/target-accounts/import", async (c) => {
    if (!canPlan(actorOf(c))) return refuse("Target accounts are written by planners, leadership and GTM Engineering.", 403);
    const { csv } = await csvOf(c);
    return run(() => importTargetAccounts(db, actorOf(c), csv));
  });

  app.get("/api/hosted/mine", (c) => run(() => myGuests(db, actorOf(c), { money: canPlan(actorOf(c)) })));
}

