/* Luma and Splash registrants, and the target account list (docs/HOSTED.md 13, 14 and 21.17). An import is an upload: refused in the public demo, in the file-route size class, and it needs an actor and the write key.
   Headers are found by name, case-insensitive. A status the desk does not know is never guessed: the row is skipped with the value shown. An import never moves a guest backwards. */

import Papa from "papaparse";
import type { Db } from "./db.ts";
import { newId, RuleError } from "./events.ts";
import { hostedEvent, HostedInvalid, lockHosted, logGuest, newToken, nowOf, text, EMAIL_RE, type HostedDeps, type GuestRow, GUEST_COLS } from "./hosted.ts";
import { normalizeCountry } from "../shared/country-rules.ts";
import { importMove, type GuestStatus } from "../shared/rsvp.ts";

export const MAX_IMPORT_ROWS = 5000;
export type ImportSource = "luma" | "splash";
export interface ImportResult { source: ImportSource; rows: number; added: number; moved_forward: number; already_there: number; skipped_empty: number; skipped: { row: number; why: string }[]; by_status: Record<string, number> }

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, "_");
const STATUS_WORDS_IN: Record<string, GuestStatus> = {
  approved: "registered", registered: "registered", going: "registered", confirmed: "registered",
  declined: "declined", rejected: "declined", not_attending: "declined", "not attending": "declined", cancelled: "declined", canceled: "declined",
  pending: "waitlist", waitlist: "waitlist", waitlisted: "waitlist", pending_approval: "waitlist",
};
const yes = (v: string) => /^(yes|y|true|1|attended|checked.?in)$/i.test(v.trim());

function parse(csv: string) {
  const r = Papa.parse<Record<string, string>>(csv.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: norm });
  return r.data.filter((row) => row && typeof row === "object");
}

/** Reads one row to a status and a person, or a reason it is skipped. */
function readRow(source: ImportSource, row: Record<string, string>) {
  const get = (k: string) => (row[k] ?? "").toString().trim();
  const first = get("first_name"), last = get("last_name");
  const name = get("name") || [first, last].filter(Boolean).join(" ");
  const email = get("email").toLowerCase();
  if (!name && !email) return { skip: "empty" as const };
  if (email && !EMAIL_RE.test(email)) return { skip: `Not an email address: ${email.slice(0, 60)}` };
  let status: GuestStatus | null = null, why = "";
  if (source === "luma") {
    const raw = get("approval_status").toLowerCase();
    const ci = get("checked_in_at");
    if (ci) status = "attended";
    else if (!raw) status = "registered";
    else status = STATUS_WORDS_IN[raw] ?? STATUS_WORDS_IN[raw.replace(/\s+/g, "_")] ?? null;
    if (!status) why = `Unknown status: ${raw.slice(0, 40)}`;
  } else {
    const raw = get("status").toLowerCase();
    if (yes(get("attended"))) status = "attended";
    else if (!raw) { status = null; why = "No status"; }
    else status = STATUS_WORDS_IN[raw] ?? STATUS_WORDS_IN[raw.replace(/\s+/g, "_")] ?? null;
    if (!status && !why) why = `Unknown status: ${raw.slice(0, 40)}`;
  }
  if (!status) return { skip: why };
  const rawCountry = get("country");
  return { name: name.slice(0, 120), email: email || null, company: (get("company") || get("organization")).slice(0, 120), title: (get("title") || get("job_title")).slice(0, 120), country: rawCountry ? normalizeCountry(rawCountry) : null, status, checkedInAt: source === "luma" ? get("checked_in_at") : "", created: get("created_at") };
}

/** Imports Luma or Splash registrants for a hosted event (a webinar's attendance may come in a second import of the same shape). The owner is the importer. */
export async function importGuests(db: Db, deps: HostedDeps, actor: string, eventId: string, source: string, csv: string): Promise<ImportResult> {
  if (source !== "luma" && source !== "splash") throw new HostedInvalid("The source is luma or splash.");
  if (typeof csv !== "string" || !csv.trim()) throw new HostedInvalid("The file is empty.");
  const rows = parse(csv);
  if (!rows.length) throw new HostedInvalid("The file has no rows.");
  if (rows.length > MAX_IMPORT_ROWS) throw new HostedInvalid(`Import up to ${MAX_IMPORT_ROWS} rows at a time.`);
  const keys = new Set(Object.keys(rows[0]));
  const known = source === "luma" ? ["name", "first_name", "email", "approval_status"] : ["first_name", "email", "status", "attended"];
  if (!known.some((k) => keys.has(k))) throw new HostedInvalid(`This does not look like a ${source === "luma" ? "Luma" : "Splash"} export. Expected columns such as ${known.join(", ")}.`);
  const now = nowOf(deps);
  return db.tx(async (q) => {
    const ev = await hostedEvent(q, eventId);
    if (ev.stage === "declined") throw new RuleError("This event was declined, so its list is closed.");
    await lockHosted(q, eventId);
    const out: ImportResult = { source, rows: rows.length, added: 0, moved_forward: 0, already_there: 0, skipped_empty: 0, skipped: [], by_status: {} };
    for (const [i, raw] of rows.entries()) {
      const r = readRow(source, raw);
      if ("skip" in r) { if (r.skip === "empty") out.skipped_empty++; else out.skipped.push({ row: i + 2, why: r.skip! }); continue; }
      const existing = r.email
        ? (await q<GuestRow>(`SELECT ${GUEST_COLS} FROM event_guests WHERE event_id = $1 AND lower(email) = $2 AND removed_at IS NULL FOR UPDATE`, [eventId, r.email]))[0]
        : (await q<GuestRow>(`SELECT ${GUEST_COLS} FROM event_guests WHERE event_id = $1 AND lower(name) = lower($2) AND lower(company) = lower($3) AND removed_at IS NULL FOR UPDATE`, [eventId, r.name, r.company]))[0];
      const when = (r.checkedInAt && !Number.isNaN(Date.parse(r.checkedInAt)) ? new Date(r.checkedInAt) : now).toISOString();
      if (existing) {
        out.already_there++;
        if (importMove(existing.status, r.status)) {
          if (r.status === "attended") await q("UPDATE event_guests SET status = 'attended', prior_status = $2, checked_in_at = $3, checked_in_by = $4, waitlisted_at = NULL WHERE id = $1", [existing.id, existing.status === "attended" ? null : existing.status, when, actor]);
          else await q("UPDATE event_guests SET status = $2, rsvp_at = coalesce(rsvp_at, $3), waitlisted_at = CASE WHEN $2 = 'waitlist' THEN coalesce(waitlisted_at, $3::timestamptz) ELSE NULL END WHERE id = $1", [existing.id, r.status, now.toISOString()]);
          await logGuest(q, eventId, existing.id, "status", `Moved forward by an import: ${existing.status} to ${r.status}`, actor, now);
          out.moved_forward++;
        }
        continue;
      }
      const id = newId("gst");
      const created = r.created && !Number.isNaN(Date.parse(r.created)) ? new Date(r.created).toISOString() : now.toISOString();
      await q(
        `INSERT INTO event_guests (id, event_id, name, email, company, title, country, owner, side, source, status, rsvp_token, rsvp_at, waitlisted_at, checked_in_at, checked_in_by, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'us', $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [id, eventId, r.name, r.email, r.company, r.title, r.country, actor, source, r.status, newToken(), r.status === "listed" ? null : created, r.status === "waitlist" ? created : null, r.status === "attended" ? when : null, r.status === "attended" ? actor : null, actor, now.toISOString()]);
      out.added++; out.by_status[r.status] = (out.by_status[r.status] ?? 0) + 1;
    }
    await logGuest(q, eventId, null, "import", `${source} import: ${out.added} added, ${out.moved_forward} moved forward, ${out.already_there} already there, ${out.skipped.length + out.skipped_empty} skipped`, actor, now);
    return out;
  });
}

/* ------------------------------------------------------------------ target accounts */

export interface TargetInput { name?: string; domain?: string | null; country?: string | null; owner?: string | null; open_deal?: string | null; deal_stage?: string | null; source?: string }
const domainOf = (v: unknown) => { const s = text(v).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0]; return s || null; };

/** One target account, made or updated by name. */
export async function saveTargetAccount(q: Db["query"], actor: string, input: TargetInput, source: "upload" | "manual" = "manual") {
  const name = text(input.name).slice(0, 160);
  if (!name) throw new HostedInvalid("An account needs a name.");
  const raw = text(input.country);
  const country = raw ? normalizeCountry(raw) : null;
  if (raw && !country) throw new HostedInvalid("Give the country as a two-letter code, such as US.");
  const vals = [domainOf(input.domain), country, text(input.owner) || null, text(input.open_deal).slice(0, 160) || null, text(input.deal_stage).slice(0, 80) || null];
  const [have] = await q<{ id: string }>("SELECT id FROM target_accounts WHERE lower(name) = lower($1)", [name]);
  if (have) { await q("UPDATE target_accounts SET domain = coalesce($2, domain), country = coalesce($3, country), owner = coalesce($4, owner), open_deal = coalesce($5, open_deal), deal_stage = coalesce($6, deal_stage) WHERE id = $1", [have.id, ...vals]); return { id: have.id, created: false }; }
  const id = newId("tac");
  await q("INSERT INTO target_accounts (id, name, domain, country, owner, open_deal, deal_stage, source, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", [id, name, ...vals, source, actor]);
  return { id, created: true };
}

export const addTargetAccount = (db: Db, actor: string, input: TargetInput) => db.tx((q) => saveTargetAccount(q, actor, input, "manual"));

/** A CSV of `name, domain, country, owner, open_deal, deal_stage`. A row with no name is skipped and counted. */
export async function importTargetAccounts(db: Db, actor: string, csv: string) {
  if (typeof csv !== "string" || !csv.trim()) throw new HostedInvalid("The file is empty.");
  const rows = parse(csv);
  if (rows.length > MAX_IMPORT_ROWS) throw new HostedInvalid(`Import up to ${MAX_IMPORT_ROWS} rows at a time.`);
  if (rows.length && !("name" in rows[0])) throw new HostedInvalid("The file needs a name column.");
  return db.tx(async (q) => {
    const out = { rows: rows.length, added: 0, updated: 0, skipped: [] as { row: number; why: string }[] };
    for (const [i, r] of rows.entries()) {
      if (!text(r.name)) { out.skipped.push({ row: i + 2, why: "No name" }); continue; }
      try { const s = await saveTargetAccount(q, actor, r, "upload"); if (s.created) out.added++; else out.updated++; }
      catch (e) { if (e instanceof HostedInvalid) out.skipped.push({ row: i + 2, why: e.message }); else throw e; }
    }
    return out;
  });
}
