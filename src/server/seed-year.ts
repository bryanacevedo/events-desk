/* A year of fictional events for a company that attends events all year round: flagship trade
   shows with many seats, regional summits, small field dinners and roadshows, across North
   America, Latin America, Europe and APAC. Every name, venue and person is made up.

   Everything is built through the real code paths, like seed.ts, so the demo cannot show a state
   the product could not reach. Lists are windows of samples/attendees-large.csv so delivered
   numbers differ from event to event. Opt-in: seed(db, { year: true }); the demo server passes it. */

import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { cancelEvent, decideApproval, requestCard } from "./approvals.ts";
import { createEvent } from "./events.ts";
import { processEvent } from "./pipeline.ts";
import { mockLlm, mockVendors } from "./providers.ts";
import type { Settings } from "../shared/cost.ts";
import { ingestUpload } from "./uploads.ts";

const MAYA = "Maya Ortiz";
const DAN = "Dan Whitlock";

type Upto = "requested" | "approved" | "mapped" | "quoted" | "delivered" | "declined" | "paused";
interface YearEvent { id: string; name: string; venue: string; country: string; on: string; seats: number; price: number; upto: Upto; rows?: [number, number]; reason?: string }

// [start row, row count] windows into the large registration export; windows do not overlap.
export const YEAR: YearEvent[] = [
  { id: "evt_y01", name: "Frostline Fintech Forum", venue: "Hudson Yards Hall, New York", country: "United States", on: "2026-01-12", seats: 12, price: 189000, upto: "delivered", rows: [0, 90] },
  { id: "evt_y02", name: "Andes Commerce Summit", venue: "Costanera Pavilion, Buenos Aires", country: "Argentina", on: "2026-01-27", seats: 6, price: 115000, upto: "delivered", rows: [90, 60] },
  { id: "evt_y03", name: "Northgate Logistics Expo", venue: "Messe Süd, Hamburg", country: "Germany", on: "2026-02-10", seats: 24, price: 229000, upto: "delivered", rows: [150, 140] },
  { id: "evt_y04", name: "Riverbend Field Dinner", venue: "The Larder, Austin", country: "United States", on: "2026-02-24", seats: 3, price: 42000, upto: "delivered", rows: [290, 20] },
  { id: "evt_y05", name: "Pacific Rim Payments Week", venue: "Marina Bay Convention Hall, Singapore", country: "Singapore", on: "2026-03-09", seats: 18, price: 245000, upto: "delivered", rows: [310, 120] },
  { id: "evt_y06", name: "Cordillera Growth Days", venue: "Centro Cultural del Norte, Bogotá", country: "Colombia", on: "2026-03-25", seats: 5, price: 98000, upto: "delivered", rows: [430, 45] },
  { id: "evt_y07", name: "Lowland SaaS Summit", venue: "Zuidas Hall 7, Amsterdam", country: "Netherlands", on: "2026-04-07", seats: 10, price: 169000, upto: "delivered", rows: [475, 80] },
  { id: "evt_y08", name: "Harbourfront Revenue Roadshow", venue: "Roundhouse Hall, Toronto", country: "Canada", on: "2026-04-21", seats: 4, price: 65000, upto: "declined", reason: "Sales kickoff moved to the same week" },
  { id: "evt_y09", name: "Sunbelt Commerce Live", venue: "Bayfront Convention Center, Miami", country: "United States", on: "2026-05-05", seats: 14, price: 199000, upto: "delivered", rows: [555, 100] },
  { id: "evt_y10", name: "Thames Data Forum", venue: "Royal Docks Hall West, London", country: "United Kingdom", on: "2026-05-19", seats: 16, price: 215000, upto: "delivered", rows: [655, 110] },
  { id: "evt_y11", name: "Meseta Payments Forum", venue: "Recinto Norte, Madrid", country: "Spain", on: "2026-06-02", seats: 8, price: 145000, upto: "delivered", rows: [765, 60] },
  { id: "evt_y12", name: "Cascadia Field Dinner", venue: "Pike Street Room, Seattle", country: "United States", on: "2026-06-16", seats: 3, price: 45000, upto: "delivered", rows: [825, 18] },
  { id: "evt_y13", name: "Bosphorus Trade Days", venue: "Golden Horn Congress Hall, Istanbul", country: "Türkiye", on: "2026-06-30", seats: 6, price: 120000, upto: "declined", reason: "No local partner in time" },
  { id: "evt_y14", name: "Monsoon Growth Summit", venue: "Palace Grounds Hall, Bengaluru", country: "India", on: "2026-07-14", seats: 10, price: 135000, upto: "delivered", rows: [843, 80] },
  { id: "evt_y15", name: "Prairie Supply Chain Expo", venue: "Lakeshore Hall East, Chicago", country: "United States", on: "2026-08-04", seats: 20, price: 210000, upto: "delivered", rows: [923, 130] },
  { id: "evt_y16", name: "Paulista Revenue Summit", venue: "Pavilhão Norte, São Paulo", country: "Brazil", on: "2026-08-25", seats: 9, price: 125000, upto: "delivered", rows: [1053, 70] },
  { id: "evt_y17", name: "Baltic Fintech Days", venue: "Kista Expo Hall, Stockholm", country: "Sweden", on: "2026-09-08", seats: 7, price: 160000, upto: "delivered", rows: [1123, 55] },
  { id: "evt_y18", name: "Lakeside Field Dinner", venue: "Union Pier Room, Chicago", country: "United States", on: "2026-09-22", seats: 2, price: 38000, upto: "delivered", rows: [1178, 16] },
  { id: "evt_y19", name: "Southern Cross Commerce Expo", venue: "Darling Quay Exhibition Centre, Sydney", country: "Australia", on: "2026-10-06", seats: 15, price: 230000, upto: "delivered", rows: [1194, 105] },
  { id: "evt_y20", name: "Seine Payments Forum", venue: "Palais de la Porte, Paris", country: "France", on: "2026-10-20", seats: 8, price: 175000, upto: "delivered", rows: [1299, 65] },
  { id: "evt_y21", name: "Pacífico Logistics Summit", venue: "Centro Chapultepec, Mexico City", country: "Mexico", on: "2026-11-03", seats: 9, price: 110000, upto: "delivered", rows: [1364, 70] },
  // From here on the dates are after today, 8 Nov 2026.
  { id: "evt_y22", name: "Capitol Revenue Roadshow", venue: "Eastern Market Hall, Washington", country: "United States", on: "2026-11-19", seats: 4, price: 70000, upto: "approved" },
  { id: "evt_y23", name: "Tatra Commerce Days", venue: "Vistula Congress Rooms, Warsaw", country: "Poland", on: "2026-12-01", seats: 6, price: 105000, upto: "mapped", rows: [1434, 50] },
  { id: "evt_y24", name: "Golden Gate Field Dinner", venue: "Ferry Building Room, San Francisco", country: "United States", on: "2026-12-10", seats: 3, price: 52000, upto: "quoted", rows: [1484, 22] },
  { id: "evt_y25", name: "Lion City Fintech Forum", venue: "Suntec Hall 4, Singapore", country: "Singapore", on: "2026-12-15", seats: 10, price: 235000, upto: "paused", rows: [1506, 60] },
  { id: "evt_y26", name: "Northern Lights SaaS Summit", venue: "Spektrum Foyer, Oslo", country: "Norway", on: "2027-01-13", seats: 6, price: 155000, upto: "requested" },
  { id: "evt_y27", name: "Caribbean Payments Forum", venue: "Malecón Convention Hall, Santo Domingo", country: "Dominican Republic", on: "2027-01-20", seats: 4, price: 90000, upto: "approved" },
  { id: "evt_y28", name: "Great Lakes Logistics Expo", venue: "Riverfront Hall, Detroit", country: "United States", on: "2027-01-27", seats: 12, price: 180000, upto: "requested" },
  { id: "evt_y29", name: "Rhine Commerce Summit", venue: "Rheinhallen, Cologne", country: "Germany", on: "2027-02-03", seats: 8, price: 140000, upto: "mapped", rows: [1566, 40] },
  { id: "evt_y30", name: "Emerald Isle Growth Days", venue: "Docklands Hall, Dublin", country: "Ireland", on: "2027-02-17", seats: 5, price: 115000, upto: "quoted", rows: [1606, 30] },
  { id: "evt_y31", name: "Cherry Blossom Data Forum", venue: "Odaiba Exhibition Hall, Tokyo", country: "Japan", on: "2027-03-03", seats: 10, price: 260000, upto: "requested" },
  { id: "evt_y32", name: "Gulf Coast Field Dinner", venue: "Bayou Room, Houston", country: "United States", on: "2027-03-10", seats: 3, price: 48000, upto: "approved" },
  { id: "evt_y33", name: "Catalan Payments Week", venue: "Montjuïc Hall, Barcelona", country: "Spain", on: "2027-04-07", seats: 14, price: 200000, upto: "requested" },
  { id: "evt_y34", name: "Río de la Plata Commerce Expo", venue: "Puerto Madero Pavilion, Buenos Aires", country: "Argentina", on: "2027-04-20", seats: 7, price: 105000, upto: "approved" },
  { id: "evt_y35", name: "Rockies Supply Chain Summit", venue: "Platte River Hall, Denver", country: "United States", on: "2027-05-11", seats: 9, price: 170000, upto: "requested" },
  { id: "evt_y36", name: "Java Sea Fintech Days", venue: "Senayan Hall, Jakarta", country: "Indonesia", on: "2027-05-26", seats: 6, price: 130000, upto: "requested" },
  { id: "evt_y37", name: "Midsummer Revenue Summit", venue: "Töölö Expo Hall, Helsinki", country: "Finland", on: "2027-06-09", seats: 8, price: 165000, upto: "approved" },
  { id: "evt_y38", name: "Alpine Commerce Forum", venue: "Seefeld Lake Hall, Zürich", country: "Switzerland", on: "2027-06-23", seats: 10, price: 240000, upto: "requested" },
];

let cachedLines: string[] | null = null;
/** A CSV with the export's title, note and header lines and one window of its rows. */
function windowCsv(start: number, count: number) {
  cachedLines ??= readFileSync(new URL("../../samples/attendees-large.csv", import.meta.url), "utf8").split(/\r?\n/);
  const head = cachedLines.slice(0, 3);
  return [...head, ...cachedLines.slice(3 + start, 3 + start + count)].join("\n") + "\n";
}

/** Vendors whose email finders always fail, so the pipeline's own rule pauses the event. */
const failingVendors = (s: Settings) => {
  const v = mockVendors(s);
  return { ...v, finders: v.finders.map((f) => ({ ...f, find: async () => { throw new Error("The finder is down"); } })) };
};

export async function seedYear(db: Db, opts: { run?: boolean } = {}) {
  const pending = async (id: string) => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
  for (const y of YEAR) {
    await createEvent(db, MAYA, { name: y.name, venue: y.venue, country: y.country, starts_on: y.on, seat_count: y.seats, seat_price_cents: y.price, flow: "single_card" }, y.id);
    if (y.upto === "requested") continue;
    if (y.upto === "declined") { await cancelEvent(db, y.id, DAN, y.reason ?? "Ended"); continue; }
    await decideApproval(db, { approvalId: await pending(y.id), actor: DAN, decision: "approve" });
    if (y.upto === "approved") continue;
    const [start, count] = y.rows!;
    await ingestUpload(db, y.id, MAYA, `${y.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-registrations.csv`, windowCsv(start, count));
    if (y.upto === "mapped") continue;
    await requestCard(db, y.id, MAYA);
    if (y.upto === "quoted") continue;
    await decideApproval(db, { approvalId: await pending(y.id), actor: MAYA, decision: "approve" });
    // Delivered events are left with their card approved; the server's boot kick runs them in the background,
    // which keeps boot under a few seconds. The paused one runs here, against vendors that fail, so the
    // pipeline's own rule pauses it before the server starts kicking.
    if (y.upto === "paused" || opts.run) await processEvent(db, y.id, { llm: mockLlm, vendorsFor: y.upto === "paused" ? failingVendors : mockVendors });
  }
}
