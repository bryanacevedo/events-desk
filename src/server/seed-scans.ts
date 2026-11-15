/* The demo's scanner (docs/SCANNER.md 17). Money20/20 USA 2026 holds a day's scans, written through the real ingest path: placed ones, a hot one with a promise, two reps on one person,
   a near match waiting for review, a card read to confirm, badge ids waiting for the organizer, and one the organizer did not know. Salesforce World Tour Tokyo is set up and has no scans yet.
   Fixed ids, so a second run changes nothing. Nothing here is a real person. */

import type { Db } from "./db.ts";
import type { LifecycleDeps } from "./lifecycle-deps.ts";
import { fakeOrganizer } from "./organizer-api.ts";
import { mockLlm, type Llm } from "./providers.ts";
import { ingestScan, putPhotoChunk, putSettings, readPhoto, type ScanInput } from "./scans.ts";

const CAMILLE = "Camille Laurent", MAYA = "Maya Ortiz", DAN = "Dan Whitlock";
export const SCAN_EVENT = "evt_money20-20-usa-2026", SCAN_EVENT_SETUP = "evt_salesforce-world-tour-tokyo-2026";
const NOTICE_V2 = "We keep your details to follow up on our conversation. Tell us if you would rather we did not.";

const vcard = (name: string, email: string, company: string, title: string) => `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nORG:${company}\nTITLE:${title}\nEMAIL:${email}\nEND:VCARD`;
// A one-pixel JPEG: the card's photo in the demo. The simulated reader cannot see, so it answers from what the seed hands it.
const PIXEL = Uint8Array.from(Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64"));

export async function seedScans(db: Db, deps: LifecycleDeps) {
  const [ev] = await db.query<{ starts_on: string }>("SELECT starts_on::text AS starts_on FROM events WHERE id = $1", [SCAN_EVENT]);
  if (!ev) return;
  const [done] = await db.query("SELECT 1 FROM scans WHERE event_id = $1 LIMIT 1", [SCAN_EVENT]);
  if (done) return;
  await putSettings(db, CAMILLE, SCAN_EVENT, { qualifiers: [{ label: "Buying this year?" }, { label: "Team of ten or more?" }], notice_text: NOTICE_V2, organizer: "swapcard", organizer_event_ref: "RXZlbnRfZGVtbw==", organizer_exhibitor_ref: "RXhoaWJpdG9yX2RlbW8=" });
  await putSettings(db, CAMILLE, SCAN_EVENT_SETUP, { qualifiers: [{ label: "Buying this year?" }, { label: "Evaluating this quarter?" }, { label: "Decides on the vendor?" }] });
  const at = (day: number, hhmm: string) => `${new Date(Date.parse(`${ev.starts_on}T00:00:00Z`) + day * 86_400_000).toISOString().slice(0, 10)}T${hhmm}:00Z`;
  let n = 0;
  const sid = () => `seed-m2020-${String(++n).padStart(3, "0")}-demo`;
  const put = (rep: string, over: Partial<ScanInput> & Pick<ScanInput, "method">, ext = {}) => ingestScan(db, deps, SCAN_EVENT, rep, { id: sid(), qualifiers: {}, notice_version: 2, seconds: 8 + (n % 7), ...over }, ext);
  const badge = (rep: string, name: string, email: string, company: string, title: string, when: string, over: Partial<ScanInput> = {}) => put(rep, { method: "badge_code", raw_payload: vcard(name, email, company, title), scanned_at: when, ...over });

  await badge(MAYA, "Henrik Solberg", "henrik.solberg@fjordbank.example", "Fjordbank", "Head of Treasury", at(0, "14:09"), { temperature: "hot", qualifiers: { q1: "yes", q2: "yes" }, note: "Moving payouts off a legacy processor before year end. Wants a number this week.", promise: "Send the payout pricing sheet", promise_owner: MAYA, next_step: "Send pricing", next_step_on: addDay(ev.starts_on, 3), marketing_consent: true });
  await badge(MAYA, "Sanne de Vries", "sanne.devries@poldercredit.example", "Polder Credit", "VP Operations", at(0, "13:47"), { temperature: "cold" });
  await badge(CAMILLE, "Sanne de Vries", "sanne.devries@poldercredit.example", "Polder Credit", "VP Operations", at(1, "10:12"), { temperature: "warm", note: "Came by the booth again with her CFO." });
  await badge(CAMILLE, "Claire Fontenot", "claire.fontenot@lumiere.example", "Lumiere Assurance", "Head of Payments", at(0, "13:29"), { temperature: "warm", qualifiers: { q1: "yes", q2: "no" } });
  await badge(DAN, "Rania Haddad", "rania.haddad@cedarremit.example", "Cedar Remit", "COO", at(0, "13:08"), { temperature: "hot", note: "Asked for a call with our head of risk.", promise: "Introduce her to our risk lead", promise_owner: DAN, next_step: "Introduce a colleague", next_step_on: addDay(ev.starts_on, 2) });
  await put(MAYA, { method: "typed", fields: { name: "Oliver Ashby", company: "Thornfield Treasury", email: "oliver.ashby@thornfield.example" }, scanned_at: at(0, "12:57"), temperature: "warm" });
  // A near match: two reps, a short form of the same name.
  await badge(MAYA, "Robert Kline", "robert.kline@orrery.example", "Orrery", "Head of Payments", at(0, "11:20"), { temperature: "warm" });
  await badge(CAMILLE, "Rob Kline", "rob.kline@orrery.example", "Orrery", "Payments", at(1, "09:41"), { temperature: "warm" });
  // A business card, read: two fields to check.
  const card = { id: sid(), method: "card_photo" as const, scanned_at: at(1, "11:35"), temperature: "hot" as const, qualifiers: { q1: "yes" as const }, notice_version: 2, seconds: 11 };
  await ingestScan(db, deps, SCAN_EVENT, MAYA, card);
  await putPhotoChunk(db, MAYA, card.id, { offset: 0, total: PIXEL.length, kind: "card" }, PIXEL);
  const reader: Llm = { ...mockLlm, read: (s, p, i) => mockLlm.read!(s, p, i, { fields: { name: "Aoife Brennan", company: "Quillon Treasury", title: "Head of Finance Operations", email: "aoife.brennan@quillon.example" }, confidence: { name: "high", company: "high", title: "low", email: "low" }, text: "Aoife Brennan Head of Finance Operations Quillon Treasury aoife.brennan@quillon.example" }) };
  await readPhoto(db, deps, reader, MAYA, card.id);
  // Badge ids: the organizer is not connected, so they wait; one the organizer says it does not know.
  await put(CAMILLE, { method: "badge_id", raw_payload: "48213-A7", scanned_at: at(1, "13:22"), temperature: "warm" });
  await put(DAN, { method: "badge_id", raw_payload: "48220-B2", scanned_at: at(1, "14:05"), temperature: "cold" });
  await put(CAMILLE, { method: "badge_id", raw_payload: "00000-XX", scanned_at: at(1, "13:40"), temperature: "warm" }, { organizer: fakeOrganizer({}) });
  // The session: Camille's scans are credited to her talk, the way a rep picks it on the scan screen.
  await db.query("UPDATE scans SET talk_id = 'tlk_seed_m2020' WHERE event_id = $1 AND rep = $2 AND EXISTS (SELECT 1 FROM talks WHERE id = 'tlk_seed_m2020')", [SCAN_EVENT, CAMILLE]);
}

const addDay = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
