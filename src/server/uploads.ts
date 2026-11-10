/* Stores one mapped list and moves the event to `mapped`, in one transaction.
   A file the code cannot map changes nothing and leaves the event at `approved`. */

import type { Db } from "./db.ts";
import { EVENT_COLS, logActivity, moveWithin, newId, RuleError } from "./events.ts";
import { mapColumns, normalize, type QualityReport } from "../shared/ingest.ts";
import { linkEventQuietly, pruneQuietly } from "./person-record.ts";
import { parseUpload, sniff } from "./xlsx-read.ts";

export const MAX_ROWS = 50_000;
export const TYPES = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel", csv: "text/csv; charset=utf-8", other: "application/octet-stream" } as const;

export const toBytes = (file: string | Uint8Array | ArrayBuffer) => (typeof file === "string" ? new TextEncoder().encode(file) : file instanceof Uint8Array ? file : new Uint8Array(file));

export async function ingestUpload(db: Db, eventId: string, actor: string, filename: string, file: string | Uint8Array | ArrayBuffer) {
  // POST /upload is the first list and replacing it. New registrations have their own way in.
  const [at] = await db.query<{ stage: string; parent_event_id: string | null }>("SELECT stage, parent_event_id FROM events WHERE id = $1", [eventId]);
  if (at?.parent_event_id) throw new RuleError("New registrations cannot take another attendee list.");
  if (at?.stage === "delivered") throw new RuleError("This outreach list is delivered. Add new registrations instead.");
  // Nothing is written until the whole file has been read and mapped.
  const bytes = toBytes(file);
  const parsed = await parseUpload(file);
  if (!parsed.rows.length) throw new RuleError("That file has no rows.");
  if (parsed.rows.length > MAX_ROWS) throw new RuleError(`That file has more than ${MAX_ROWS.toLocaleString("en-US")} rows.`);
  const { map, ignored, error, extras } = mapColumns(parsed);
  if (error) throw new RuleError(error);
  // Layer 0 runs here, in code, before any approval: every value in the file is a claim until something independent supports it.
  const data = normalize(parsed, map, extras);

  let replaced = false;
  const out = await db.tx(async (q) => {
    // A new list replaces the old one while nothing has been paid for. The uploader of the current list is the one who confirms its cost cards, so a
    // new upload moves that to the new uploader, and a card quoted for the old list is void: it is declined here and can never be confirmed.
    const [cur] = await q<{ stage: string }>("SELECT stage FROM events WHERE id = $1 FOR UPDATE", [eventId]);
    if (cur && ["mapped", "quoted"].includes(cur.stage) && (await q("SELECT 1 FROM uploads WHERE event_id = $1 LIMIT 1", [eventId])).length) {
      await q("UPDATE approvals SET status = 'declined', decided_by = $2, decided_at = now(), reason = $3 WHERE event_id = $1 AND status = 'pending' AND kind <> 'seats'", [eventId, actor, `Replaced: ${actor} uploaded a new list`]);
      await q("UPDATE cost_cards SET status = 'declined' WHERE event_id = $1 AND status = 'pending'", [eventId]);
      for (const t of ["review_cases", "contacts", "source_rows", "title_tiers", "companies"]) await q(`DELETE FROM ${t} WHERE event_id = $1`, [eventId]);
      // The old list goes with its file, so the event shows one list. upload_files cascades from uploads.
      await q("DELETE FROM uploads WHERE event_id = $1", [eventId]);
      await logActivity(q, eventId, actor, "reupload", `${actor} replaced the attendee list; any pending cost card was voided`);
      replaced = true;
    }
    const event = cur?.stage === "mapped" ? (await q<Awaited<ReturnType<typeof moveWithin>>>(`SELECT ${EVENT_COLS} FROM events WHERE id = $1`, [eventId]))[0]
      : await moveWithin(q, eventId, "mapped", actor, { detail: `Uploaded ${filename || "an attendee list"} with ${parsed.rows.length} rows` });
    const uploadId = newId("upl");
    await q(
      "INSERT INTO uploads (id, event_id, filename, mapping, ignored, row_count, uploaded_by, quality) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb)",
      [uploadId, eventId, filename, JSON.stringify(map), JSON.stringify(ignored), parsed.rows.length, actor, JSON.stringify(data.quality)],
    );
    // The file as received, so the first list can always be had back. A Uint8Array binds as bytea on PGlite and on postgres.js alike.
    await q("INSERT INTO upload_files (upload_id, event_id, content_type, bytes) VALUES ($1, $2, $3, $4)", [uploadId, eventId, TYPES[sniff(bytes)], bytes]);

    const companyIds = new Map(data.companies.map((c) => [c.key, newId("co")]));
    await q(
      `INSERT INTO companies (id, event_id, key, name, identity_evidence)
       SELECT id, $2, key, name, evidence FROM jsonb_to_recordset($1::jsonb) AS x(id text, key text, name text, evidence jsonb)`,
      [JSON.stringify(data.companies.map((c) => ({ ...c, id: companyIds.get(c.key) }))), eventId],
    );

    const rowIds = new Map(data.sourceRows.map((r) => [r.row_number, newId("row")]));
    await q(
      `INSERT INTO source_rows (id, event_id, upload_id, row_number, raw, kind, company_id, drop_reason, dropped_at, website, issues)
       SELECT id, $2, $3, row_number, raw, kind, company_id, drop_reason, CASE WHEN drop_reason IS NULL THEN NULL ELSE now() END, website, issues
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, row_number int, raw jsonb, kind text, company_id text, drop_reason text, website text, issues jsonb)`,
      [JSON.stringify(data.sourceRows.map((r) => ({
        id: rowIds.get(r.row_number), row_number: r.row_number, raw: r.raw, kind: r.kind,
        company_id: r.company_key ? companyIds.get(r.company_key) : null, drop_reason: r.drop_reason, website: r.website, issues: [...new Set(r.issues)],
      }))), eventId, uploadId],
    );
    await q(
      `INSERT INTO contacts (id, event_id, source_row_id, company_id, full_name, title, email, linkedin, drop_reason, dropped_at)
       SELECT id, $2, source_row_id, company_id, full_name, title, email, linkedin, drop_reason, CASE WHEN drop_reason IS NULL THEN NULL ELSE now() END
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, source_row_id text, company_id text, full_name text, title text, email text, linkedin text, drop_reason text)`,
      [JSON.stringify(data.contacts.map((c) => ({
        id: newId("con"), source_row_id: rowIds.get(c.row_number), company_id: c.company_key ? companyIds.get(c.company_key) : null,
        full_name: c.full_name, title: c.title, email: c.email, linkedin: c.linkedin, drop_reason: c.drop_reason,
      }))), eventId],
    );
    await logActivity(q, eventId, actor, "mapped", `Mapped ${Object.keys(map).length} columns, ignored ${ignored.length}. Attendee list quality: ${data.quality.verdict}`);
    // The event row is unchanged; the quality report rides along as one extra field.
    return { ...event, quality: data.quality };
  });
  // After the list is stored, in its own transaction and caught: the person record cannot fail an upload.
  if (replaced) await pruneQuietly(db);
  await linkEventQuietly(db, eventId);
  return out;
}

export interface ListSummary {
  /** The list quality report from Layer 0, or null for an event uploaded before it existed. */
  quality: QualityReport | null;
  upload: { filename: string; row_count: number; mapping: Record<string, number>; ignored: string[]; uploaded_by: string } | null;
  companies: number;
  people: number;
  company_only: number;
  dropped: { reason: string; n: number }[];
  priorities: { priority: string; n: number }[];
  sources: { source: string; n: number }[];
}

export async function listSummary(db: Db, eventId: string): Promise<ListSummary> {
  // The first list says who brought it and how it was mapped. Rows received is that list's rows plus each top-up's new rows.
  const [upload] = await db.query<ListSummary["upload"] & object>("SELECT filename, (SELECT sum(x.row_count)::int FROM uploads x WHERE x.event_id = $1) AS row_count, mapping, ignored, uploaded_by FROM uploads WHERE event_id = $1 ORDER BY created_at, id LIMIT 1", [eventId]);
  const [counts] = await db.query<{ companies: number; people: number; company_only: number }>(
    `SELECT (SELECT count(*)::int FROM companies WHERE event_id = $1) AS companies,
            (SELECT count(*)::int FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND source IS DISTINCT FROM 'onsite') AS people,
            (SELECT count(*)::int FROM source_rows WHERE event_id = $1 AND kind = 'company_only' AND dropped_at IS NULL) AS company_only`,
    [eventId],
  );
  // People are counted on contacts; rows with no person are counted on source rows. Someone met at the booth is not on the list, so
  // the list's count leaves them out and matches the outreach figure (43 to reach, not 43 plus three walk-ups).
  const dropped = await db.query<{ reason: string; n: number }>(
    `SELECT reason, sum(n)::int AS n FROM (
       SELECT drop_reason AS reason, count(*) AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NOT NULL GROUP BY 1
       UNION ALL
       SELECT drop_reason, count(*) FROM source_rows WHERE event_id = $1 AND dropped_at IS NOT NULL AND kind <> 'person' GROUP BY 1
     ) d GROUP BY reason ORDER BY n DESC, reason`,
    [eventId],
  );
  const priorities = await db.query<{ priority: string; n: number }>("SELECT priority, count(*)::int AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND priority IS NOT NULL GROUP BY 1 ORDER BY 1", [eventId]);
  const sources = await db.query<{ source: string; n: number }>("SELECT source, count(*)::int AS n FROM contacts WHERE event_id = $1 AND dropped_at IS NULL AND priority IS NOT NULL GROUP BY 1 ORDER BY 1", [eventId]);
  const [q] = await db.query<{ quality: QualityReport | null }>("SELECT quality FROM uploads WHERE event_id = $1 ORDER BY created_at, id LIMIT 1", [eventId]);
  return { upload: upload ?? null, quality: q?.quality ?? null, ...counts, dropped, priorities, sources };
}

/* ------------------------------------------------------------ the list block */

export interface UploadItem { id: string; filename: string; uploaded_by: string; created_at: string; row_count: number; has_file: boolean; file_rows: number | null; already_in: number | null; top_up_id: string | null }

/** Every list received for the event, oldest first: the first list and the new registrations merged into it. A replacement removes the list it replaces. */
export async function listUploads(db: Db, eventId: string): Promise<UploadItem[]> {
  return db.query<UploadItem>(
    `SELECT u.id, u.filename, u.uploaded_by, u.created_at, u.row_count, u.file_rows, u.already_in, u.top_up_id, EXISTS (SELECT 1 FROM upload_files f WHERE f.upload_id = u.id) AS has_file
     FROM uploads u WHERE u.event_id = $1 ORDER BY u.created_at, u.id`, [eventId]);
}

/** A name that is safe inside a Content-Disposition header: no path, no quotes, no control characters, no header breaks. */
export function safeFilename(name: string, fallback: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f"\\;]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 150);
  return base || fallback;
}

export function contentDisposition(name: string, fallback: string): string {
  const safe = safeFilename(name, fallback);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/%/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** The stored file for one upload of this event, or null: an upload id from another event is never matched. */
export async function uploadFile(db: Db, eventId: string, uploadId: string) {
  const [row] = await db.query<{ filename: string; content_type: string | null; bytes: Uint8Array | null }>(
    `SELECT u.filename, f.content_type, f.bytes FROM uploads u LEFT JOIN upload_files f ON f.upload_id = u.id WHERE u.id = $1 AND u.event_id = $2`, [uploadId, eventId]);
  if (!row) return { found: false as const };
  return { found: true as const, filename: row.filename, file: row.bytes ? { type: row.content_type ?? "application/octet-stream", bytes: new Uint8Array(row.bytes) } : null };
}

/** A cell that begins with = + - @ (or a tab or carriage return) would run as a formula in a spreadsheet. A leading apostrophe makes it text. */
export const neutralize = (v: string) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const csvCell = (v: string) => { const t = neutralize(v); return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

/** For an upload with no stored file: the rows as they were read, as a CSV. The raw column is jsonb, so the original column order and
    header spelling are not kept; columns come back in the order the database holds them. */
export async function rebuiltRows(db: Db, eventId: string, uploadId: string): Promise<{ filename: string; csv: string } | null> {
  const [u] = await db.query<{ filename: string }>("SELECT filename FROM uploads WHERE id = $1 AND event_id = $2", [uploadId, eventId]);
  if (!u) return null;
  const rows = await db.query<{ raw: Record<string, unknown> }>("SELECT raw FROM source_rows WHERE event_id = $1 AND upload_id = $2 ORDER BY row_number", [eventId, uploadId]);
  const cols: string[] = [];
  for (const r of rows) for (const k of Object.keys(r.raw ?? {})) if (!cols.includes(k)) cols.push(k);
  const text = (v: unknown) => (v == null ? "" : typeof v === "string" ? v : String(v));
  const lines = [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(text(r.raw?.[c]))).join(","))];
  return { filename: u.filename, csv: `${lines.join("\r\n")}\r\n` };
}
