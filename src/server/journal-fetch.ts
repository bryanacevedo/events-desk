/* A fetch that writes down what this desk asked CRM Desk to change, for the rehearsal (docs/SHARED-WORLD.md 14.2).
   Only calls that write are kept: anything but GET, except the two reads made with POST. A line holds the method, the path after /api/v1, the body, the status and the answer, as the other desks' journal lines do.
   The key and every header are never written. */

import { appendFileSync } from "node:fs";

const READS_BY_POST = new Set(["/contacts/contactability", "/accounts/lookup"]);

export interface JournalLine { actor: "events_desk"; method: string; path: string; body: unknown; status: number; answer: unknown }

export function writesOf(method: string, path: string): boolean {
  return method.toUpperCase() !== "GET" && !READS_BY_POST.has(path.split("?")[0]);
}

export function journalFetch(file: string, inner: typeof fetch = fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^.*\/api\/v1/, "") + url.search;
    const method = (init?.method ?? "GET").toUpperCase();
    if (writesOf(method, path)) {
      const text = await res.clone().text();
      const line: JournalLine = { actor: "events_desk", method, path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null, status: res.status, answer: text ? JSON.parse(text) : {} };
      appendFileSync(file, JSON.stringify(line) + "\n");
    }
    return res;
  }) as typeof fetch;
}
