/* The demo's directory (docs/DIRECTORY.md 4 and 9). Money20/20 USA 2026, the browse-only example event, holds thirty reads the extension made from a Swapcard directory, most of them
   staged and three waiting on a check, each with the source sentence and terms note the server builds. Salesforce World Tour Tokyo 2026 holds one finished screen recording of an app
   called Brella with a few reads. The reads are written straight into the tables, because the event is past the stage that takes a list; the sentences come from the same functions
   the routes use. Fixed ids, so a second run changes nothing. Every person and company here is invented. */

import type { Db } from "./db.ts";
import { termsOf } from "./directory.ts";
import { addDays } from "../shared/motion.ts";
import { dedupeKey, extensionSource, judgeRead, recordingSource } from "../shared/directory.ts";

export const DIRECTORY_EVENT = "evt_money20-20-usa-2026", RECORDING_EVENT = "evt_salesforce-world-tour-tokyo-2026", SEED_RECORDING = "rec_seed_brella";
const MAYA = "Maya Okafor", CAMILLE = "Camille Laurent";

type Row = [name: string, title: string, company: string, location: string];
/** [name, title, company, place]. Staged unless judgeRead says otherwise; the last three are the ones the rule holds back, each for a different reason. */
const SWAPCARD: Row[] = [
  ["Lena Hartwell", "Head of Payments", "Orrery", "London, United Kingdom"],
  ["Marcus Odell", "VP Treasury", "Fjordbank", "Oslo, Norway"],
  ["Priya Raman", "Director of Payment Operations", "Quillon Treasury", "Singapore"],
  ["Tomas Villeda", "Chief Financial Officer", "Cedar Remit", "Mexico City, Mexico"],
  ["Hana Kowalczyk", "Head of Fraud and Risk", "Polder Credit", "Amsterdam, Netherlands"],
  ["Elias Brandt", "Senior Product Manager, Cards", "Lumiere Assurance", "Paris, France"],
  ["Noor Haddad", "Chief Operating Officer", "Thornfield Treasury", "Dubai, United Arab Emirates"],
  ["Grace Whitfield", "Payments Architect", "Brightwater Pay", "Austin, United States"],
  ["Oskar Lindqvist", "Head of Partnerships", "Nordlys Payments", "Stockholm, Sweden"],
  ["Camila Restrepo", "Director of Treasury Operations", "Andean Settle", "Bogota, Colombia"],
  ["Yusuf Demir", "VP Engineering, Payouts", "Marmara Finance", "Istanbul, Turkey"],
  ["Sofia Marchetti", "Head of Merchant Acquiring", "Tevere Bank", "Milan, Italy"],
  ["Daniel Okafor", "Chief Technology Officer", "Lagos Ledger", "Lagos, Nigeria"],
  ["Ingrid Solheim", "Treasury Manager", "Skerry Marine", "Bergen, Norway"],
  ["Rafael Quintero", "Director of Digital Banking", "Banco Altiplano", "Santo Domingo, Dominican Republic"],
  ["Mei-Ling Chao", "Head of Cross-Border Payments", "Harbourline", "Hong Kong"],
  ["Jonah Pritchard", "Controller", "Pinecrest Logistics", "Denver, United States"],
  ["Aisha Rahman", "Senior Director, Risk Technology", "Meridian Card Services", "Toronto, Canada"],
  ["Viktor Novak", "Head of Payments Strategy", "Vltava Bank", "Prague, Czechia"],
  ["Tessa Lindgren", "VP Finance Operations", "Copperfield Retail", "Chicago, United States"],
  ["Samuel Adeyemi", "Product Lead, Wallets", "Kora Mobile", "Nairobi, Kenya"],
  ["Beatriz Almeida", "Head of Treasury", "Lusitana Seguros", "Lisbon, Portugal"],
  ["Connor Mulligan", "Payments Engineering Manager", "Greenhill Markets", "Dublin, Ireland"],
  ["Ayesha Siddiqui", "Chief Product Officer", "Crescent Pay", "Karachi, Pakistan"],
  ["Pieter Vandermeer", "Director of Merchant Services", "Dijkhuis Commerce", "Rotterdam, Netherlands"],
  ["Katarina Jovanovic", "Head of Compliance Technology", "Danube Clearing", "Belgrade, Serbia"],
  ["Luis Ferreyra", "Head of Payouts", "Pampa Marketplace", "Buenos Aires, Argentina"],
  // Held back: one word for a name, no title or company, a digit in the name.
  ["Priyanka", "Head of Payments", "Orrery", "London, United Kingdom"],
  ["Tomas Ekberg", "", "", "Gothenburg, Sweden"],
  ["Dana Hollis 2", "Treasury Analyst", "Brightwater Pay", "Austin, United States"],
];

/** [name, title, company, place, low]. A recording read of Brella; the one marked low is held back because the model said the name was hard to read. */
const BRELLA: [...Row, boolean][] = [
  ["Isabel Cordero", "Head of Enterprise Sales", "Cielo Cloud", "Madrid, Spain", false],
  ["Mateo Fontaine", "Director of Platform Partnerships", "Rhone Systems", "Lyon, France", false],
  ["Nadia Petrova", "VP Customer Success", "Baltic Data", "Tallinn, Estonia", false],
  ["Gavin Thornley", "Chief Revenue Officer", "Ashgrove Software", "Manchester, United Kingdom", false],
  ["Rei Yamashiro", "Solutions Architect", "Kitsune Cloud", "Tokyo, Japan", true],
];
/** Frames of the recording: the state each ended in and how many reads it gave. Five were read, one failed, so the panel shows a stretch to record again. */
const FRAMES: [state: "read" | "failed", found: number][] = [["read", 2], ["read", 1], ["failed", 0], ["read", 1], ["read", 0], ["read", 1]];

export async function seedDirectory(db: Db, opts: { today?: string } | string = {}) {
  const today = typeof opts === "string" ? opts : opts.today ?? new Date().toISOString().slice(0, 10);
  const [m2020] = await db.query<{ name: string }>("SELECT name FROM events WHERE id = $1", [DIRECTORY_EVENT]);
  const [tokyo] = await db.query<{ name: string }>("SELECT name FROM events WHERE id = $1", [RECORDING_EVENT]);
  const on = addDays(today, -1);
  const put = (id: string, eventId: string, r: { row: Row; via: "extension" | "recording"; platform: string; by: string; source: string; terms: string; url: string | null; recording: string | null; low?: boolean }) => {
    const [name, title, company, location] = r.row;
    const j = judgeRead({ name, title, company }, { name: r.low });
    return db.query(
      `INSERT INTO directory_reads (id, event_id, dedupe_key, full_name, title, company, location, profile_url, via, platform, read_by, read_on, source_text, terms_note, state, check_reason, recording_id)
       VALUES ($1, $2, $3, $4, nullif($5, ''), nullif($6, ''), nullif($7, ''), $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) ON CONFLICT DO NOTHING`,
      [id, eventId, dedupeKey({ name, company, profile_url: r.url }), name, title, company, location, r.url, r.via, r.platform, r.by, on, r.source, r.terms, j.state, j.reason, r.recording]);
  };
  if (m2020) {
    const terms = await termsOf(db.query, DIRECTORY_EVENT);
    const source = extensionSource({ platform: "swapcard", eventName: m2020.name, by: MAYA, on });
    for (const [n, row] of SWAPCARD.entries()) {
      // Two of the held-back reads carry no profile link, so the panel shows both kinds of key.
      const url = n < SWAPCARD.length - 2 ? `https://app.swapcard.com/event/money20-20-usa-2026/person/${String(7000 + n * 13).padStart(6, "0")}` : null;
      await put(`dr_seed_m2020_${String(n + 1).padStart(2, "0")}`, DIRECTORY_EVENT, { row, via: "extension", platform: "swapcard", by: MAYA, source, terms, url, recording: null });
    }
  }
  if (tokyo) {
    const [done] = await db.query("SELECT 1 FROM recordings WHERE id = $1", [SEED_RECORDING]);
    if (!done) {
      await db.query("INSERT INTO recordings (id, event_id, app_name, uploaded_by, frames_sent, frames_read, frames_failed, people, state) VALUES ($1, $2, 'Brella', $3, $4, $5, $6, 0, 'done')",
        [SEED_RECORDING, RECORDING_EVENT, CAMILLE, FRAMES.length, FRAMES.filter((f) => f[0] === "read").length, FRAMES.filter((f) => f[0] === "failed").length]);
      for (const [n, [state, found]] of FRAMES.entries()) await db.query("INSERT INTO recording_frames (recording_id, n, state, found) VALUES ($1, $2, $3, $4)", [SEED_RECORDING, n, state, found]);
    }
    const terms = await termsOf(db.query, RECORDING_EVENT);
    const source = recordingSource({ app: "Brella", eventName: tokyo.name, by: CAMILLE, on });
    for (const [n, [name, title, company, location, low]] of BRELLA.entries()) {
      await put(`dr_seed_tokyo_${n + 1}`, RECORDING_EVENT, { row: [name, title, company, location], via: "recording", platform: "Brella", by: CAMILLE, source, terms, url: null, recording: SEED_RECORDING, low });
    }
    await db.query("UPDATE recordings SET people = (SELECT count(*)::int FROM directory_reads WHERE recording_id = $1) WHERE id = $1", [SEED_RECORDING]);
  }
}
