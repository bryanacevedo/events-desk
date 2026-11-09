/* Puts a delivered event on a Google Sheet and reads review decisions back.
   Delivery never depends on it: this runs after the stage move, and a Google
   failure is recorded on the event (sheet_error) and in the activity log, never
   thrown into the pipeline. Publishing again reuses the file that exists.

   After the upload, the Google-native layer (sheets-polish.ts) is applied. It is a finish,
   not a condition: when a batch of it is refused the Sheet still delivers with its link, and
   the activity log says which part was skipped. */

import type { Db } from "./db.ts";
import { logActivity, RuleError } from "./events.ts";
import { sheetUrl, type SheetPublisher } from "./sheets.ts";
import { polishWords, type SheetPlan } from "./sheets-polish.ts";
import { applyReviewGrid, buildDelivery, carryFromTabs, decisionsFromGrid, type Carried } from "./workbook.ts";
import { OLD_SHEET_ERROR } from "../shared/domain.ts";

export interface SheetState { sheet_url: string | null; sheet_error: string | null }

const inflight = new Set<string>();

async function state(db: Db, id: string): Promise<SheetState & { sheet_id: string | null; stage: string; name: string }> {
  const [e] = await db.query<SheetState & { sheet_id: string | null; stage: string; name: string }>("SELECT sheet_id, sheet_url, sheet_error, stage, name FROM events WHERE id = $1", [id]);
  if (!e) throw new RuleError("That event does not exist.");
  return e;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** The polish, as a finish that cannot fail delivery: a thrown error or a refused batch becomes one activity line. */
export async function polishSheet(db: Db, eventId: string, actor: string, pub: SheetPublisher, id: string, plan: SheetPlan) {
  let note = "";
  try { note = polishWords(await pub.polish(id, plan)); }
  catch (err) { note = `Sheet polish skipped: ${reason(err)}`; }
  if (note) await db.tx((q) => logActivity(q, eventId, actor, "sheet", note.slice(0, 300)));
  return note;
}

export async function publishSheet(db: Db, eventId: string, actor: string, pub: SheetPublisher): Promise<SheetState> {
  const e = await state(db, eventId);
  if (!pub.enabled) return { sheet_url: e.sheet_url, sheet_error: e.sheet_error };
  if (e.stage !== "delivered") throw new RuleError("The outreach list is not delivered yet.");
  if (e.sheet_url && !e.sheet_error) return { sheet_url: e.sheet_url, sheet_error: null };
  if (inflight.has(eventId)) throw new RuleError("The Google Sheet is already being published.");
  inflight.add(eventId);
  try {
    let id = e.sheet_id;
    let plan: SheetPlan | null = null;
    if (!id) {
      const built = await buildDelivery(db, eventId);
      plan = built.plan;
      id = (await pub.create(built.xlsx, `${e.name} outreach list`)).id;
      // Saved at once, so a failure while sharing never leads to a second file.
      await db.query("UPDATE events SET sheet_id = $2 WHERE id = $1", [eventId, id]);
    }
    await pub.share(id);
    const url = sheetUrl(id);
    await db.tx(async (q) => {
      await q("UPDATE events SET sheet_url = $2, sheet_error = NULL WHERE id = $1", [eventId, url]);
      await logActivity(q, eventId, actor, "sheet", "Published the outreach list to Google Sheets");
    });
    // Only a freshly uploaded file is polished: a retry that only shares again leaves the Sheet as people have it.
    if (plan) await polishSheet(db, eventId, actor, pub, id, plan);
    return { sheet_url: url, sheet_error: null };
  } catch (err) {
    const msg = reason(err);
    await db.tx(async (q) => {
      await q("UPDATE events SET sheet_error = $2 WHERE id = $1", [eventId, msg]);
      await logActivity(q, eventId, actor, "sheet", `Google Sheet failed, the download still works: ${msg}`);
    });
    return { sheet_url: null, sheet_error: msg };
  } finally {
    inflight.delete(eventId);
  }
}

/** Rebuilds a published Sheet with what the event holds now, keeping its link. Rebuilding replaces the whole file and people type into it, so it first reads everything they typed: Review decisions are
    applied, and Outreach status, Notes and the Meetings rows are written into the rebuilt workbook. Nothing is replaced until every read has come back. A failed read leaves the Sheet as it is and says so on
    the event. A Sheet with no contact id column (published before there was one) cannot be matched and is left alone until someone chooses `rebuild`. The Google layer runs again after. */
export async function refreshSheet(db: Db, eventId: string, actor: string, pub: SheetPublisher, opts: { rebuild?: boolean } = {}): Promise<SheetState & { left_alone?: boolean }> {
  const e = await state(db, eventId);
  if (!pub.enabled) return { sheet_url: e.sheet_url, sheet_error: e.sheet_error };
  if (e.stage !== "delivered") throw new RuleError("The outreach list is not delivered yet.");
  if (!e.sheet_id) return publishSheet(db, eventId, actor, pub);
  if (inflight.has(eventId)) throw new RuleError("The Google Sheet is already being published.");
  inflight.add(eventId);
  const leaveAlone = async (msg: string) => {
    await db.tx(async (q) => {
      await q("UPDATE events SET sheet_error = $2 WHERE id = $1", [eventId, msg]);
      if (msg !== e.sheet_error) await logActivity(q, eventId, actor, "sheet", `Google Sheet not refreshed, the download still works: ${msg}`);
    });
    return { sheet_url: e.sheet_url, sheet_error: msg, left_alone: true };
  };
  try {
    let carried: Carried | null = null;
    let review: string[][] | null = null;
    try {
      review = await pub.readReview(e.sheet_id);
      decisionsFromGrid(review);
      if (!opts.rebuild) {
        const [attendees, prospects, meetings] = await Promise.all([pub.readTab(e.sheet_id, "Attendees"), pub.readTab(e.sheet_id, "Prospects"), pub.readTab(e.sheet_id, "Meetings")]);
        carried = carryFromTabs(attendees, prospects, meetings);
        if (!carried) return await leaveAlone(OLD_SHEET_ERROR);
      }
    } catch (err) {
      // A person who chose to rebuild has already accepted losing what cannot be read.
      if (!opts.rebuild) return await leaveAlone(`Could not read the Google Sheet: ${reason(err)}`);
      review = null;
    }
    if (review) await applyReviewGrid(db, eventId, actor, review);
    const built = await buildDelivery(db, eventId, undefined, carried ?? undefined);
    await pub.update(e.sheet_id, built.xlsx);
    await db.tx(async (q) => {
      await q("UPDATE events SET sheet_error = NULL WHERE id = $1", [eventId]);
      await q("UPDATE events SET sheet_refreshed_at = now() WHERE parent_event_id = $1 AND merged_at IS NOT NULL AND sheet_refreshed_at IS NULL", [eventId]);
      await logActivity(q, eventId, actor, "sheet", "Refreshed the outreach list on Google Sheets");
    });
    await polishSheet(db, eventId, actor, pub, e.sheet_id, built.plan);
    return { sheet_url: e.sheet_url, sheet_error: null };
  } catch (err) {
    return leaveAlone(`Google Sheet failed: ${reason(err)}`);
  } finally {
    inflight.delete(eventId);
  }
}

/** Reads the Review tab from the event's Sheet and applies Drops through the same function as the file import. */
export async function syncReview(db: Db, eventId: string, actor: string, pub: SheetPublisher) {
  const e = await state(db, eventId);
  if (e.stage !== "delivered") throw new RuleError("The outreach list is not delivered yet.");
  if (!pub.enabled || !e.sheet_id) throw new RuleError("This outreach list has no Google Sheet. Import the downloaded file instead.");
  let grid: string[][];
  try { grid = await pub.readReview(e.sheet_id); }
  catch (err) { throw new RuleError(`Could not read the Google Sheet: ${reason(err)}`); }
  return applyReviewGrid(db, eventId, actor, grid);
}
