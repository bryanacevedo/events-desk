/* Events Desk API. Writes need a display name and, when WRITE_KEY is set, the key. */

import { readFileSync } from "node:fs";
import { Hono } from "hono";
import type { Db } from "./db.ts";
import { createEvent, EVENT_COLS, moveEvent, RuleError } from "./events.ts";
import { spend, spendByStep } from "./ledger.ts";
import { withAiCents } from "./ai-cost.ts";
import { answerCase, listCases, skipOpenCases } from "./cases.ts";
import { requestOutreachCard, requestResearchCard } from "./research.ts";
import { listOptOuts, recordOptOut } from "./suppression.ts";
import { correctCompanyFirmo, retier, spreadFor, type RetierOptions } from "./tiering.ts";
import { cardRecipient, mountSlack, postApproval, type SlackConfig } from "./slack.ts";
import { refreshSheet, syncReview } from "./sheet-delivery.ts";
import { createTopUp, endTopUp, topUpsOf } from "./top-up.ts";
import { mockSheets, type SheetPublisher } from "./sheets.ts";
import { buildWorkbook, importReview, reviewContact } from "./workbook.ts";
import { cancelEvent, decideApproval, defaultSettings, patchSettings, requestCard } from "./approvals.ts";
import { overview } from "./overview.ts";
import { contentDisposition, ingestUpload, listSummary, listUploads, rebuiltRows, safeFilename, uploadFile } from "./uploads.ts";
import { deleteEvent } from "./delete-event.ts";
import { Forbidden } from "./seats.ts";
import { benchToExample, cancelCompile, confirmCompile, reopenCompile, editDraft, getCompile, icpOverview, publishCompile, runBench, saveDocument, setBench, startCompile, type Edit } from "./icp.ts";
import { mockLlm, type Crm, type Dns, type Llm } from "./providers.ts";
import type { Settings } from "../shared/cost.ts";
import { isGtm, SETTINGS_REFUSAL } from "../shared/roles.ts";
import { mountSettingsView } from "./settings-view.ts";
import { mountSeatRoutes } from "./seat-routes.ts";
import { mountBudgetRoutes } from "./budget-routes.ts";
import { mountEventViews } from "./event-views.ts";
import { validateRequest, type ActivityRow, type EventRow } from "../shared/domain.ts";

export interface AppConfig { writeKey?: string; demo: boolean; kick?: (eventId: string) => void; slack?: SlackConfig; sheets?: SheetPublisher; /** The model the ICP compile and test bench use. Defaults to the mock. */ llm?: Llm; /** The mail-server check used before the Research card. Defaults to the one for mock and simulated domains. */ dns?: Dns; /** The CRM an opt-out is queued for. */ crm?: Crm }
type Ctx = { Variables: { actor: string } };

const bad = (msg: string, status: 400 | 401 | 403 | 404 | 409 = 400) => Response.json({ error: msg }, { status });
/** The organizer's website, from the catalog entry the event came from. Screens read the logo domain from it. */
const WEBSITE = "(SELECT c.website FROM catalog_events c WHERE c.id = events.catalog_id) AS website, (SELECT c.brand_color FROM catalog_events c WHERE c.id = events.catalog_id) AS brand_color";

export function createApp(db: Db, cfg: AppConfig) {
  const app = new Hono<Ctx>();

  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET") {
      if (cfg.writeKey && c.req.header("x-write-key") !== cfg.writeKey) return bad("This desk needs the team write key to make changes.", 401);
      const actor = decodeURIComponent(c.req.header("x-actor") ?? "").trim();
      if (!actor) return bad("Say who you are before making changes.");
      c.set("actor", actor.slice(0, 60));
      // Settings and the ICP are GTM Engineering's. Acting as is not security; this keeps the desk honest until a real login.
      if (/^\/api\/(icp|settings)(\/|$)/.test(c.req.path) && !isGtm(c.get("actor"))) return bad(SETTINGS_REFUSAL, 403);
    }
    await next();
  });

  // Someone came off a delivered list, so its Sheet is rebuilt, keeping what people typed. It runs after the response. Several at once collapse into one more pass, and a failure shows beside the Sheet link.
  const refreshing = new Map<string, boolean>();
  const refreshAfterDrop = async (ids: string[], actor: string) => {
    const sheets = cfg.sheets;
    if (!sheets?.enabled || !ids.length) return;
    const live = await db.query<{ id: string }>("SELECT id FROM events WHERE id = ANY($1::text[]) AND stage = 'delivered' AND sheet_id IS NOT NULL", [ids]);
    for (const { id } of live) {
      if (refreshing.has(id)) { refreshing.set(id, true); continue; }
      refreshing.set(id, false);
      void (async () => {
        do {
          refreshing.set(id, false);
          try { await refreshSheet(db, id, actor, sheets); }
          catch (e) {
            console.error("sheet refresh", id, e);
            await db.query("UPDATE events SET sheet_error = $2 WHERE id = $1", [id, `Someone came off this list and the Sheet could not be rebuilt: ${(e as Error).message}`.slice(0, 300)]);
          }
        } while (refreshing.get(id));
        refreshing.delete(id);
      })();
    }
  };

  app.onError((err) => {
    if (err instanceof RuleError) return bad(err.message, 409);
    console.error(err);
    return bad("Something went wrong saving that. Reload and check before trying again.");
  });

  app.get("/api/health", (c) => c.json({ ok: true, demo: cfg.demo }));

  // The rules every new event starts from, read-only. The ICP screen shows them until uploading a document exists.
  app.get("/api/settings/defaults", (c) => c.json({ settings: defaultSettings() }));
  mountSettingsView(app, cfg, db);
  mountSeatRoutes(app, db, cfg);
  mountBudgetRoutes(app, db, cfg);
  mountEventViews(app, db);
  app.get("/api/overview", async (c) => c.json(await overview(db)));

  /* The ICP: one seller per install, one line of versions. A document is uploaded, a person sees the cost and starts the compile,
     confirms the draft, tests it on companies with known answers, and publishes. Nothing here is used for tiering until published. */
  const llm = cfg.llm ?? mockLlm;
  const callCents = async () => (defaultSettings().llm_call_cents);
  app.get("/api/icp", async (c) => c.json(await icpOverview(db)));
  app.post("/api/icp/documents", async (c) => {
    // Pasted text or an uploaded .txt or .md file. A word-processor file is not read: paste its text.
    const ct = c.req.header("content-type") ?? "";
    let filename = "pasted text", text = "";
    if (ct.includes("json")) { const b = await c.req.json<{ filename?: string; text?: string }>().catch(() => ({}) as { filename?: string; text?: string }); filename = String(b.filename ?? "pasted text"); text = String(b.text ?? ""); }
    else {
      filename = decodeURIComponent(c.req.header("x-filename") ?? "").slice(0, 200) || "upload";
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.length > 2_000_000) return bad("That file is too large.");
      if (bytes[0] === 0x50 && bytes[1] === 0x4b) return bad("That looks like a Word or zip file. Paste its text, or save it as .txt or .md.");
      text = new TextDecoder().decode(bytes);
    }
    return c.json(await saveDocument(db, c.get("actor"), filename, text, await callCents()), 201);
  });
  app.get("/api/icp/compiles/:id", async (c) => c.json(await getCompile(db, c.req.param("id"))));
  app.post("/api/icp/compiles/:id/start", async (c) => {
    const b = await c.req.json<{ accepted_cents?: number }>().catch(() => ({}) as { accepted_cents?: number });
    return c.json(await startCompile(db, c.req.param("id"), c.get("actor"), llm, Number(b.accepted_cents)));
  });
  app.patch("/api/icp/compiles/:id/draft", async (c) => {
    const edit = await c.req.json<Edit>().catch(() => null);
    if (!edit || typeof edit !== "object" || !("op" in edit)) return bad("Say what to change.");
    return c.json(await editDraft(db, c.req.param("id"), c.get("actor"), edit));
  });
  app.post("/api/icp/compiles/:id/confirm", async (c) => c.json(await confirmCompile(db, c.req.param("id"), c.get("actor"))));
  app.put("/api/icp/compiles/:id/bench", async (c) => {
    const b = await c.req.json<{ companies?: unknown }>().catch(() => ({}) as { companies?: unknown });
    return c.json(await setBench(db, c.req.param("id"), b.companies));
  });
  app.post("/api/icp/compiles/:id/bench/run", async (c) => c.json(await runBench(db, c.req.param("id"), c.get("actor"), llm)));
  app.post("/api/icp/compiles/:id/bench/example", async (c) => {
    const b = await c.req.json<{ name?: string; why?: string }>().catch(() => ({}) as { name?: string; why?: string });
    return c.json(await benchToExample(db, c.req.param("id"), c.get("actor"), String(b.name ?? ""), String(b.why ?? "")));
  });
  app.post("/api/icp/compiles/:id/publish", async (c) => {
    const b = await c.req.json<{ note?: string; accept_low?: boolean }>().catch(() => ({}) as { note?: string; accept_low?: boolean });
    return c.json((await publishCompile(db, c.req.param("id"), c.get("actor"), { note: b.note, accept_low: b.accept_low === true })).compile);
  });
  app.post("/api/icp/compiles/:id/reopen", async (c) => c.json(await reopenCompile(db, c.req.param("id"))));
  // The demo's own set of known companies, so the test step can be tried without typing one.
  if (cfg.demo) app.get("/api/icp/sample-bench", (c) => c.json({ companies: JSON.parse(readFileSync(new URL("../../samples/orrery-bench.json", import.meta.url), "utf8")) }));
  app.post("/api/icp/compiles/:id/cancel", async (c) => { await cancelCompile(db, c.req.param("id")); return c.json({ ok: true }); });

  app.get("/api/events", async (c) => {
    const events = await db.query<EventRow>(`SELECT ${EVENT_COLS}, catalog_id, (SELECT u.uploaded_by FROM uploads u WHERE u.event_id = events.id ORDER BY u.created_at, u.id LIMIT 1) AS uploaded_by, ${WEBSITE} FROM events WHERE parent_event_id IS NULL ORDER BY starts_on, name`);
    return c.json({ events, demo: cfg.demo });
  });

  app.get("/api/events/:id", async (c) => {
    const id = c.req.param("id");
    const [event] = await db.query<EventRow>(`SELECT ${EVENT_COLS}, sheet_url, sheet_error, catalog_id, ${WEBSITE} FROM events WHERE id = $1`, [id]);
    if (!event) return bad("That event does not exist.", 404);
    const activity = await db.query<ActivityRow>("SELECT * FROM activity_log WHERE event_id = $1 ORDER BY created_at DESC, id", [id]);
    const [settingsRow] = await db.query<{ settings: Settings }>("SELECT settings FROM event_settings WHERE event_id = $1", [id]);
    const cards = await db.query("SELECT id, kind, status, lines, inputs, credits_cap, llm_cap, est_cents, step_caps, rates - 'credit_cents' AS rates, created_at FROM cost_cards WHERE event_id = $1 ORDER BY created_at DESC", [id]);
    const [{ open }] = await db.query<{ open: number }>("SELECT count(*)::int AS open FROM review_cases WHERE event_id = $1 AND blocking AND status = 'open'", [id]);
    // `card` is the latest card, as before. Two-card events also list every card and what each step has used.
    return c.json({ event, activity, list: await listSummary(db, id), settings: settingsRow?.settings ?? null, card: cards[0] ?? null, cards, spend: await spend(db, id), spend_by_step: await withAiCents(db, id, await spendByStep(db, id), defaultSettings().llm_call_cents), open_cases: open, uploads: await listUploads(db, id), top_ups: await topUpsOf(db, id), spread: event.flow === "two_card" && ["ready_for_review", "finding_people", "flagging", "delivered"].includes(event.stage) ? await spreadFor(db.query, id, { ...defaultSettings(), ...settingsRow?.settings }) : null, icp_version: (await db.query<{ v: number | null }>("SELECT icp_version AS v FROM events WHERE id = $1", [id]))[0]?.v ?? null });
  });

  if (cfg.slack) mountSlack(app, db, cfg.slack, cfg.kick);

  // One route for every card. A single-card event gets its cost card. A two-card event gets the Research card from the mapped list, and the Outreach card once research is done.
  const quote = async (id: string, actor: string, flow: string, stage: string) => {
    // In live mode the card goes to the uploader on Slack. If they have no Slack user, refuse before any card is made.
    if (cfg.slack) await cardRecipient(db, cfg.slack, id);
    const event = flow === "two_card"
      ? stage === "ready_for_review" ? (await requestOutreachCard(db, id, actor), (await db.query<EventRow>(`SELECT ${EVENT_COLS} FROM events WHERE id = $1`, [id]))[0]) : await requestResearchCard(db, id, actor, cfg.dns)
      : await requestCard(db, id, actor);
    if (cfg.slack) {
      const [a] = await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending' AND kind IN ('card', 'research', 'outreach')", [id]);
      await postApproval(db, cfg.slack, a.id);
    }
    return event;
  };
  // A card Slack refused or never received has no button for anyone to press. The waiting card is posted again, as it is.
  app.post("/api/events/:id/card/resend", async (c) => {
    if (!cfg.slack) return bad("Cards go through Slack only in live mode.", 409);
    const [a] = await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending' AND kind IN ('card', 'research', 'outreach')", [c.req.param("id")]);
    if (!a) return bad("No card is waiting on this event.", 409);
    await postApproval(db, cfg.slack, a.id);
    return c.json({ ok: true });
  });

  app.post("/api/events/:id/quote", async (c) => {
    const id = c.req.param("id");
    const [ev] = await db.query<{ flow: string; stage: string }>("SELECT flow, stage FROM events WHERE id = $1", [id]);
    if (!ev) return bad("That event does not exist.", 404);
    return c.json(await quote(id, c.get("actor"), ev.flow, ev.stage));
  });

  // New registrations for a delivered event. The Run step opens at once; if the card cannot be made yet the top-up waits at `mapped` and the panel asks again.
  app.post("/api/events/:id/new-registrations", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > 20_000_000) return bad("That file is too large.");
    const out = await createTopUp(db, c.req.param("id"), c.get("actor"), decodeURIComponent(c.req.header("x-filename") ?? "").slice(0, 200), bytes);
    if (out.top_up_id) await quote(out.top_up_id, c.get("actor"), "two_card", "mapped").catch((e) => { if (!(e instanceof RuleError)) throw e; });
    return c.json(out, 201);
  });

  // Ends new registrations at any stage. What was spent stays recorded and shows in Usage under the event.
  app.post("/api/events/:id/discard", async (c) => {
    const { reason } = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
    return c.json(await endTopUp(db, c.req.param("id"), c.get("actor"), String(reason ?? "").trim() || "Discarded"));
  });

  app.patch("/api/events/:id/settings", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    return c.json(await patchSettings(db, c.req.param("id"), c.get("actor"), body));
  });

  app.post("/api/events/:id/cancel", async (c) => {
    const { reason } = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });
    return c.json(await cancelEvent(db, c.req.param("id"), c.get("actor"), String(reason ?? "")));
  });

  app.post("/api/events/:id/resume", async (c) => {
    const id = c.req.param("id");
    const [e] = await db.query<EventRow>(`SELECT ${EVENT_COLS} FROM events WHERE id = $1`, [id]);
    if (!e?.paused_from) return bad("This event is not paused.", 409);
    const row = await moveEvent(db, id, e.paused_from, c.get("actor"), { detail: "Resumed" });
    cfg.kick?.(id);
    return c.json(row);
  });

  // Review cases. The shape is what the Cases screen reads: id, kind, summary, facts, suggested, options, decision (null while open).
  app.get("/api/events/:id/cases", async (c) => c.json({ cases: await listCases(db, c.req.param("id")) }));

  // Registered before the :caseId route so "skip" is never read as an id.
  app.post("/api/events/:id/cases/skip", async (c) => {
    const skipped = await skipOpenCases(db, c.req.param("id"), c.get("actor"));
    return c.json({ skipped });
  });

  app.post("/api/events/:id/cases/:caseId", async (c) => {
    const b = await c.req.json<{ decision?: string; data?: Record<string, unknown> }>().catch(() => ({}) as { decision?: string; data?: Record<string, unknown> });
    if (typeof b.decision !== "string" || !b.decision) return bad("Choose an answer.");
    const result = await answerCase(db, c.req.param("id"), c.req.param("caseId"), c.get("actor"), b.decision, b.data ?? {});
    // A company settled by a person finishes its research at once; the Research card already covers it.
    if (!result.already_decided) cfg.kick?.(c.req.param("id"));
    if (!result.already_decided && b.decision === "drop") void refreshAfterDrop([c.req.param("id")], c.get("actor"));
    return c.json(result);
  });

  // The spread check before Approval 2: tier counts, and warnings with examples. A warning blocks nothing.
  // Opt-outs span events. Recording one takes the person off every list they are still on (drop reason opted_out) and stops the email loop for them.
  app.get("/api/suppressions", async (c) => c.json({ opt_outs: await listOptOuts(db) }));
  app.post("/api/suppressions", async (c) => {
    const b = await c.req.json<{ email?: string; name?: string; company?: string; reason?: string }>().catch(() => ({}) as { email?: string });
    const out = await recordOptOut(db, c.get("actor"), b, cfg.crm);
    void refreshAfterDrop(out.events, c.get("actor"));
    return c.json({ recorded: out.recorded, removed: out.removed }, 201);
  });

  app.get("/api/events/:id/spread", async (c) => {
    const id = c.req.param("id");
    const [ev] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE id = $1", [id]);
    if (!ev?.n) return bad("That event does not exist.", 404);
    const [s] = await db.query<{ settings: Settings }>("SELECT settings FROM event_settings WHERE event_id = $1", [id]);
    return c.json(await spreadFor(db.query, id, { ...defaultSettings(), ...s?.settings }));
  });

  // Re-tier before Approval 2, against the allowance on the Research card. `icp_version` moves the event to another published version and re-tiers everything a person has not set.
  app.post("/api/events/:id/retier", async (c) => {
    const b = await c.req.json<RetierOptions>().catch(() => ({}) as RetierOptions);
    const r = await retier(db, c.req.param("id"), c.get("actor"), { company_ids: Array.isArray(b.company_ids) ? b.company_ids.map(String) : undefined, scope: b.scope, icp_version: b.icp_version === undefined ? undefined : Number(b.icp_version) });
    if (r.requeued) cfg.kick?.(c.req.param("id"));
    return c.json(r);
  });

  // A person corrects a company's facts. The correction overwrites the cache for its domain and is never aged out.
  app.post("/api/events/:id/companies/:companyId/firmographics", async (c) => {
    const b = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    return c.json(await correctCompanyFirmo(db, c.req.param("id"), c.req.param("companyId"), c.get("actor"), b));
  });

  app.get("/api/events/:id/contacts", async (c) => {
    const id = c.req.param("id");
    const contacts = await db.query(
      `SELECT c.id, c.full_name, c.title, co.name AS company, co.tier AS company_tier, c.title_tier, c.email, c.priority, c.drop_reason, c.source, c.linkedin,
              coalesce((SELECT array_agg(f.flag ORDER BY f.flag) FROM review_flags f WHERE f.contact_id = c.id), '{}') AS flags
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.event_id = $1
       ORDER BY c.dropped_at IS NOT NULL, c.priority NULLS LAST, co.name NULLS LAST, c.full_name LIMIT 1000`, [id]);
    return c.json({ contacts });
  });

  // One person's Keep or Drop from the screen. Same gate and rule as importing the Review tab.
  app.post("/api/events/:id/contacts/:contactId/review", async (c) => {
    const b = await c.req.json<{ decision?: string }>().catch(() => ({}) as { decision?: string });
    if (b.decision !== "keep" && b.decision !== "drop") return bad("Choose keep or drop.");
    return c.json(await reviewContact(db, c.req.param("id"), c.get("actor"), c.req.param("contactId"), b.decision));
  });

  app.get("/api/events/:id/workbook", async (c) => {
    const data = await buildWorkbook(db, c.req.param("id"));
    return new Response(new Uint8Array(data), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "content-disposition": 'attachment; filename="events-desk-list.xlsx"' } });
  });

  /* The attendee list as received. Same access as the workbook above: the browser holds no write key, so a check on it could never pass here.
     Closing this and the other personal-data GET routes belongs to a real login. */
  app.get("/api/events/:id/uploads/:uploadId/file", async (c) => {
    const r = await uploadFile(db, c.req.param("id"), c.req.param("uploadId"));
    if (!r.found) return bad("That attendee list does not exist.", 404);
    if (!r.file) return bad("The original file was not kept for this list.", 404);
    return new Response(r.file.bytes, { headers: { "content-type": r.file.type, "content-disposition": contentDisposition(r.filename, "attendee-list"), "x-content-type-options": "nosniff", "cache-control": "no-store" } });
  });

  // For a list uploaded before files were kept: the rows as read, rebuilt as a CSV.
  app.get("/api/events/:id/uploads/:uploadId/rows", async (c) => {
    const r = await rebuiltRows(db, c.req.param("id"), c.req.param("uploadId"));
    if (!r) return bad("That attendee list does not exist.", 404);
    const name = `${safeFilename(r.filename, "attendee-list").replace(/\.(csv|xlsx|xls)$/i, "")}-rows.csv`;
    return new Response(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": contentDisposition(name, "attendee-list-rows.csv"), "x-content-type-options": "nosniff", "cache-control": "no-store" } });
  });

  app.post("/api/events/:id/review", async (c) => c.json(await importReview(db, c.req.param("id"), c.get("actor"), await c.req.arrayBuffer())));

  // The Google Sheet copy. Publishing is also tried automatically at delivery; this is the retry. On a Sheet that exists it rebuilds it, keeping what people typed. `rebuild` is the person's choice to replace one that cannot be matched.
  app.post("/api/events/:id/sheet", async (c) => {
    const sheets = cfg.sheets ?? mockSheets;
    if (!sheets.enabled) return bad("Google Sheet delivery is off in this mode. Download the file instead.", 409);
    const b = await c.req.json<{ rebuild?: boolean }>().catch(() => ({}) as { rebuild?: boolean });
    return c.json(await refreshSheet(db, c.req.param("id"), c.get("actor"), sheets, { rebuild: b.rebuild === true }));
  });

  app.post("/api/events/:id/review/sync", async (c) => c.json(await syncReview(db, c.req.param("id"), c.get("actor"), cfg.sheets ?? mockSheets)));

  app.get("/api/approvals", async (c) => {
    const approvals = await db.query(
      `SELECT a.id, a.kind, a.requested_by, a.created_at, e.id AS event_id, e.name, e.seat_count, e.seat_price_cents,
              k.credits_cap, k.llm_cap, k.est_cents, k.lines, k.step_caps, k.rates - 'credit_cents' AS rates
       FROM approvals a JOIN events e ON e.id = a.event_id LEFT JOIN cost_cards k ON k.id = a.card_id
       WHERE a.status = 'pending' ORDER BY a.created_at`,
    );
    return c.json({ approvals });
  });

  // The Slack-style panel. This route does not exist outside demo mode.
  if (cfg.demo) {
    app.post("/api/demo/approvals/:id", async (c) => {
      const b = await c.req.json<{ decision?: string; reason?: string }>().catch(() => ({}) as { decision?: string; reason?: string });
      if (b.decision !== "approve" && b.decision !== "decline") return bad("Choose approve or decline.");
      const result = await decideApproval(db, { approvalId: c.req.param("id"), actor: c.get("actor"), decision: b.decision, reason: b.reason });
      if (result.status === "approved" && !result.already_decided) cfg.kick?.(result.event_id);
      return c.json(result);
    });
  }

  app.post("/api/events/:id/upload", async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > 20_000_000) return bad("That file is too large.");
    const filename = decodeURIComponent(c.req.header("x-filename") ?? "").slice(0, 200);
    return c.json(await ingestUpload(db, c.req.param("id"), c.get("actor"), filename, bytes));
  });

  // Manual only, and only for GTM Engineering and the seat approvers, decided here and not on the screen. Nothing is ever deleted by itself.
  app.delete("/api/events/:id", async (c) => {
    try {
      if (!(await db.query("SELECT 1 FROM events WHERE id = $1", [c.req.param("id")])).length) return bad("That event does not exist.", 404);
      return c.json(await deleteEvent(db, c.get("actor"), c.req.param("id")));
    }
    catch (e) { if (e instanceof Forbidden) return bad(e.message, 403); throw e; }
  });

  app.post("/api/events", async (c) => {
    if (cfg.slack) return bad("Seat requests are made in the desk, under Seats.", 409);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
    const err = validateRequest(body);
    if (err) return bad(err);
    return c.json(await createEvent(db, c.get("actor"), body as never), 201);
  });

  return app;
}
