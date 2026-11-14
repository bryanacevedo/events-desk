/* Sync while the app is open and online (docs/SCANNER.md 6). One scan at a time, in time order: the scan, then its photo in 256 KB pieces from where the server says it is, then the read, then an edit.
   An iPhone cannot do this in the background, so the app runs it on load, on coming back online, on returning to the page, every 30 seconds while something waits, and from the button.
   Every call goes up as the rep who made the scan, whoever the phone says it is now. Every write to the phone's queue changes a fresh copy of the item, so an edit saved during a sync is never overwritten. */

import { allItems, getBlob, getItem, putItem, waiting, type QueueItem } from "./queue";

const CHUNK = 256 * 1024;
export interface SyncOutcome { sent: number; failed: number; offline: boolean }
let running: Promise<SyncOutcome> | null = null;

const headers = (actor: string, extra: Record<string, string> = {}) => ({ "x-actor": encodeURIComponent(actor), ...extra });
async function call(method: string, path: string, actor: string, body?: BodyInit, extra: Record<string, string> = {}) {
  const r = await fetch(path, { method, headers: headers(actor, extra), body });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j: j as Record<string, any> };
}
/** The desk said no and will say no again (a bad scan, a scan id that is someone else's). Anything else (a server error, a sign-in or write-key problem, a missing page) is tried again later and the scan stays on the phone. */
const final = (status: number) => status === 400 || status === 409 || status === 413;

/** Changes the newest copy of an item. */
async function patch(id: string, fn: (it: QueueItem) => void): Promise<QueueItem | undefined> {
  const it = await getItem(id);
  if (!it) return undefined;
  fn(it);
  if (!waiting(it) && !it.done_at) it.done_at = Date.now();
  await putItem(it);
  return it;
}

async function one(start: QueueItem): Promise<void> {
  const id = start.id, rep = start.rep;
  let it = (await getItem(id)) ?? start;
  if (!it.sent) {
    const r = await call("POST", `/api/events/${it.event_id}/scans`, rep, JSON.stringify(it.input), { "content-type": "application/json" });
    if (!r.ok && !final(r.status)) throw new Error("retry");
    await patch(id, (x) => {
      x.sent = true;
      x.result = r.ok ? (r.j as QueueItem["result"]) : { id, state: "failed", state_detail: String(r.j.error ?? "The desk refused this scan."), person: null, repeat: false, review: null };
    });
  }
  it = (await getItem(id)) ?? it;
  if (it.photo && it.result?.state !== "failed") {
    const blob = await getBlob(id);
    if (blob) {
      while (true) {
        const cur = (await getItem(id))!;
        if (!cur.photo || cur.photo.sent_bytes >= cur.photo.total) break;
        const from = cur.photo.sent_bytes;
        const buf = await blob.slice(from, from + CHUNK).arrayBuffer();
        const r = await call("PUT", `/api/scans/${id}/photo?offset=${from}&total=${cur.photo.total}&kind=${cur.photo.kind}`, rep, buf, { "content-type": "application/octet-stream" });
        if (!r.ok) { if (!final(r.status)) throw new Error("retry"); await patch(id, (x) => { if (x.photo) { x.photo.sent_bytes = x.photo.total; x.photo.read = true; } }); break; }
        // The server's own count is the truth: a chunk it did not take leaves us where it is, and the next round resumes there.
        const held = Number(r.j.received);
        const next = Number.isFinite(held) ? held : from + buf.byteLength;
        await patch(id, (x) => { if (x.photo) x.photo.sent_bytes = next; });
        if (next === from) throw new Error("stalled");
      }
      const cur = (await getItem(id))!;
      if (cur.photo && cur.photo.sent_bytes >= cur.photo.total && !cur.photo.read) {
        const r = await call("POST", `/api/scans/${id}/read`, rep, "{}", { "content-type": "application/json" });
        if (!r.ok && !final(r.status)) throw new Error("retry");
        // The read placed the person or left a reason; ask the desk what the scan is now.
        const list = await call("GET", `/api/events/${it.event_id}/scans`, rep);
        const row = (list.j.scans as { id: string; state: string; state_detail: string; name: string | null; company: string | null; contact_id: string | null; review: string | null }[] | undefined)?.find((s) => s.id === id);
        await patch(id, (x) => {
          if (x.photo) x.photo.read = true;
          if (row) { x.result = { id, state: row.state as never, state_detail: row.state_detail, person: row.contact_id ? { id: row.contact_id, name: row.name, company: row.company } : null, repeat: false, review: row.review as never }; x.label = { name: row.name ?? x.label.name, company: row.company ?? x.label.company }; }
        });
      }
    }
  }
  it = (await getItem(id)) ?? it;
  if (it.edit) {
    const sentEdit = JSON.stringify(it.edit);
    const r = await call("POST", `/api/scans/${id}/confirm`, rep, sentEdit, { "content-type": "application/json" });
    if (!r.ok && !final(r.status)) throw new Error("retry");
    // An edit saved while this one was going stays; only the edit that went is cleared.
    await patch(id, (x) => { if (r.ok) x.result = r.j as QueueItem["result"]; if (JSON.stringify(x.edit) === sentEdit) delete x.edit; });
  }
  await patch(id, () => undefined);
}

/** One pass over everything waiting for this event. Overlapping calls share one pass. */
export function syncAll(eventId: string, actor: string): Promise<SyncOutcome> {
  if (running) return running;
  running = (async () => {
    const out: SyncOutcome = { sent: 0, failed: 0, offline: typeof navigator !== "undefined" && navigator.onLine === false };
    if (out.offline) return out;
    const items = (await allItems(eventId)).filter(waiting).sort((a, b) => a.saved_at - b.saved_at);
    for (const it of items) {
      try { await one(it); out.sent++; }
      catch { out.failed++; if (typeof navigator !== "undefined" && navigator.onLine === false) { out.offline = true; break; } }
    }
    // Anything still waiting on a badge lookup is tried again by the desk now.
    if (!out.offline) await call("POST", `/api/events/${eventId}/scans/resolve`, actor, "{}", { "content-type": "application/json" }).catch(() => undefined);
    return out;
  })().finally(() => { running = null; });
  return running;
}
