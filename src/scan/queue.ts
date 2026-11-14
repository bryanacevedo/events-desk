/* The phone's own queue (docs/SCANNER.md 6). Every scan is written here with its id before anything else happens, so a scan survives a closed app and a dead signal.
   IndexedDB is the store; where it throws (a private window), a memory map stands in for the session and the app says its scans will not outlive the page. */

import type { ScanInput } from "../server/scans";
import type { ScanResult } from "../server/scans";

export interface QueueItem {
  id: string;
  event_id: string;
  rep: string;
  input: ScanInput;
  /** Shown while the server has not answered. */
  label: { name: string | null; company: string | null };
  saved_at: number;
  /** The server answered the scan. */
  sent: boolean;
  result?: ScanResult;
  /** A photo waits for its Blob; `total` is its size, `sent_bytes` how far the server has it. */
  photo?: { kind: "badge" | "card"; total: number; sent_bytes: number; read: boolean };
  /** Edits made after the scan synced (a confirm), sent as a confirm. */
  edit?: Record<string, string>;
  done_at?: number;
  /** What the desk last said about the scan: the fields a read found and the ones to check. */
  server?: { fields: Record<string, string>; uncertain: ("name" | "email" | "phone" | "title" | "company" | "country" | "linkedin")[] };
}

const DB = "events-desk-scanner", V = 1;
let dbp: Promise<IDBDatabase> | null = null;
const mem = { items: new Map<string, QueueItem>(), blobs: new Map<string, Blob>(), meta: new Map<string, unknown>() };
export let durable = true;

function open(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((resolve, reject) => {
    try {
      const r = indexedDB.open(DB, V);
      r.onupgradeneeded = () => { const d = r.result; d.createObjectStore("items", { keyPath: "id" }); d.createObjectStore("blobs"); d.createObjectStore("meta"); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    } catch (e) { reject(e); }
  });
  return dbp;
}
const wrap = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function tx<T>(store: "items" | "blobs" | "meta", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try { const d = await open(); return await wrap(fn(d.transaction(store, mode).objectStore(store))); }
  catch { durable = false; return undefined; }
}

export async function putItem(it: QueueItem) { mem.items.set(it.id, it); await tx("items", "readwrite", (s) => s.put(it)); }
export async function getItem(id: string): Promise<QueueItem | undefined> { return (await tx("items", "readonly", (s) => s.get(id) as IDBRequest<QueueItem>)) ?? mem.items.get(id); }
export async function allItems(eventId: string): Promise<QueueItem[]> {
  const got = (await tx("items", "readonly", (s) => s.getAll() as IDBRequest<QueueItem[]>)) ?? [...mem.items.values()];
  return got.filter((i) => i.event_id === eventId).sort((a, b) => b.saved_at - a.saved_at);
}
export async function putBlob(id: string, b: Blob) { mem.blobs.set(id, b); await tx("blobs", "readwrite", (s) => s.put(b, id)); }
export async function getBlob(id: string): Promise<Blob | undefined> { return (await tx("blobs", "readonly", (s) => s.get(id) as IDBRequest<Blob>)) ?? mem.blobs.get(id); }
export async function dropBlob(id: string) { mem.blobs.delete(id); await tx("blobs", "readwrite", (s) => s.delete(id)); }
export async function deleteItem(id: string) { mem.items.delete(id); await tx("items", "readwrite", (s) => s.delete(id)); await dropBlob(id); }
export async function putMeta(k: string, v: unknown) { mem.meta.set(k, v); await tx("meta", "readwrite", (s) => s.put(v, k)); }
export async function getMeta<T>(k: string): Promise<T | undefined> { return ((await tx("meta", "readonly", (s) => s.get(k))) as T | undefined) ?? (mem.meta.get(k) as T | undefined); }

/** What has not reached the desk: scans not answered, photos not complete or not read, edits not sent. */
export const waiting = (it: QueueItem) => !it.sent || Boolean(it.photo && (it.photo.sent_bytes < it.photo.total || !it.photo.read)) || Boolean(it.edit);
export const unsyncedCount = (items: QueueItem[]) => items.filter(waiting).length;

/** Cleared 7 days after they synced. */
export async function sweep(eventId: string, now = Date.now()) {
  for (const it of await allItems(eventId)) if (!waiting(it) && now - (it.done_at ?? it.saved_at) > 7 * 86_400_000) await deleteItem(it.id);
}

export const newScanId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 10)}`);
