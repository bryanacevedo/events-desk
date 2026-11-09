/* The demo's year: the real events in samples/real-events.json, each with seat requests from a
   roster of fictional staff. The event names, dates, cities and venues are real; every person,
   request, attendee list and company is made up. Built through the real code paths, like seed.ts,
   so the demo cannot show a state the product could not reach. Opt-in: seed(db, { real: true }). */

import { readFileSync } from "node:fs";
import type { Db } from "./db.ts";
import { decideApproval } from "./approvals.ts";
import { answerCase, listCases } from "./cases.ts";
import { requestOutreachCard, requestResearchCard } from "./research.ts";
import { processEvent } from "./pipeline.ts";
import { PauseSignal } from "./paid.ts";
import { moveEvent } from "./events.ts";
import { mockVendors } from "./providers.ts";
import { simDeps } from "./sim-vendors.ts";
import { decideSeat, requestSeat, type Goal } from "./seats.ts";
import { ingestUpload } from "./uploads.ts";
import { createTopUp } from "./top-up.ts";
import { recordTicket, setBudget } from "./budget.ts";
import type { Settings } from "../shared/cost.ts";
import { vendorWords } from "../shared/vendors.ts";

const DAN = "Dan Whitlock";
export const ROSTER: { name: string; team: string; role: string }[] = [
  { name: "Maya Ortiz", team: "Outbound", role: "SDR" },
  { name: "Priya Nair", team: "Outbound", role: "SDR" },
  { name: "Tomas Berg", team: "Outbound", role: "SDR" },
  { name: "Camille Laurent", team: "Field Marketing", role: "Field marketer" },
  { name: "Jonas Weber", team: "Field Marketing", role: "Events manager" },
  { name: "Ana Duarte", team: "Partnerships", role: "Partner manager" },
  { name: "Lucia Mendez", team: "Partnerships", role: "Alliances lead" },
  { name: "Leo Marsh", team: "Account Executives", role: "Enterprise AE" },
  { name: "Sofia Reyes", team: "Account Executives", role: "Mid-market AE" },
  { name: "Kenji Mori", team: "Account Executives", role: "AE, APAC" },
  { name: "Rafael Costa", team: "Account Executives", role: "AE, LATAM" },
  { name: "Hannah Cole", team: "Customer Success", role: "CSM" },
  { name: "Marcus Bell", team: "Customer Success", role: "CS lead" },
  { name: "Ibrahim Yusuf", team: "Solutions", role: "Solutions engineer" },
  { name: "Elena Petrova", team: "Solutions", role: "Solutions architect" },
  { name: "Grace Okafor", team: "Product Marketing", role: "Product marketer" },
  { name: "Zoe Hartley", team: "Marketing", role: "Content lead" },
  { name: "Noah Fischer", team: "Sales Leadership", role: "Regional sales director" },
  { name: "Owen Park", team: "Product", role: "Product manager" },
];

interface Real { name: string; organizer_url: string; source_url: string; start: string; end: string; city: string; country: string; venue: string; size: "flagship" | "regional" | "small"; theme: string; list_price_usd: number | null; confidence: string; brand_color?: string | null }
// Every event runs the two-card flow. "quoted": the Research card waits on the uploader. "review": research runs in the background at boot and
// ends with its cases open, before the Outreach card. "outreach": cases settled, the Outreach card waits on the uploader.
type Upto = "none" | "requested" | "approved" | "mapped" | "quoted" | "review" | "outreach" | "delivered" | "paused" | "declined";
// What each event is doing today, 8 Nov 2026, by its place in the file. [state, approved seats, waiting seats, attendee rows, uploader]
const PLAN: Record<number, [Upto, number, number, number?, string?]> = {
  0: ["delivered", 10, 0, 120], 1: ["delivered", 3, 0, 60, "Priya Nair"], 2: ["delivered", 12, 0, 130], 3: ["delivered", 10, 0, 110, "Tomas Berg"], 4: ["delivered", 10, 0, 100],
  5: ["delivered", 11, 0, 120, "Priya Nair"], 7: ["declined", 0, 2], 9: ["declined", 0, 1],
  10: ["delivered", 14, 0, 200], // about 200 rows
  11: ["delivered", 2, 0, 40, "Tomas Berg"], 12: ["delivered", 4, 0, 70], 13: ["delivered", 15, 0, 140, "Priya Nair"],
  14: ["delivered", 1, 0, 25], // about 25 rows
  15: ["review", 13, 0, 0], // the flagship: the whole of attendees-large.csv, research done, its cases open
  16: ["approved", 2, 0], 17: ["mapped", 4, 0, 45], 18: ["quoted", 10, 0, 120], 19: ["requested", 0, 2],
  20: ["paused", 12, 0, 140], 21: ["outreach", 10, 0, 100], 22: ["requested", 0, 6], 23: ["approved", 10, 2], 25: ["requested", 0, 3],
  27: ["approved", 4, 0], 28: ["mapped", 10, 0, 100], 29: ["requested", 0, 5], 31: ["approved", 3, 0], 32: ["mapped", 10, 0, 100],
  34: ["requested", 0, 2], 36: ["approved", 4, 0], 37: ["requested", 0, 6], 39: ["declined", 0, 3],
};
/** The event in the demo with new registrations waiting at Review cost and run. */
const TOP_UP_AT = 14;
const ESTIMATE = { flagship: 199500, regional: 99500, small: 49500 };
const GOALS: Goal[] = ["new_pipeline", "new_pipeline", "existing_customers", "partners", "speaking_sponsoring", "market_learning"];
const slug = (s: string) => `evt_${s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`.slice(0, 48);
const hash = (s: string) => [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);

const WHY_EVENT: Record<Goal, (r: Real) => string> = {
  new_pipeline: (r) => `Buyers in ${r.theme.toLowerCase()} on our target list gather at ${r.name.split(":")[0]}, and it puts us in the room with the ones we have not reached.`,
  existing_customers: (r) => `Several customers will be in ${r.city} for this, and a meeting there is worth more than another call.`,
  partners: (r) => `Our partners in ${r.country} run their pipeline through this event, and it is the one week we can plan joint accounts together.`,
  speaking_sponsoring: (r) => `The ${r.theme.toLowerCase()} audience is the one we want to be known to, and the speaker route here is open to us.`,
  market_learning: (r) => `We are weighing a push in ${r.country}, and ${r.name.split(":")[0]} is the quickest way to hear what buyers there ask for.`,
};
const WHY_YOU = (p: { role: string; team: string }, r: Real) => `I cover ${r.country === "United States" ? "North America" : r.country} accounts as ${/^[AEIOU]/i.test(p.role) ? "an" : "a"} ${p.role.toLowerCase()} on ${p.team}, and I will book the meetings before we fly.`;

const failingVendors = (s: Settings) => {
  const v = mockVendors(s);
  return { ...v, finders: v.finders.map((f) => ({ ...f, find: async () => { throw new Error("The finder is down"); } })) };
};
let cached: string[] | null = null;
const windowCsv = (start: number, count: number) => {
  cached ??= readFileSync(new URL("../../samples/attendees-large.csv", import.meta.url), "utf8").split(/\r?\n/);
  const body = cached.length - 3, from = start % Math.max(1, body - count);
  return [...cached.slice(0, 3), ...cached.slice(3 + from, 3 + from + count)].join("\n") + "\n";
};

export async function seedReal(db: Db) {
  const real: Real[] = JSON.parse(readFileSync(new URL("../../samples/real-events.json", import.meta.url), "utf8"));
  const pending = async (id: string) => (await db.query<{ id: string }>("SELECT id FROM approvals WHERE event_id = $1 AND status = 'pending'", [id]))[0].id;
  let cursor = 0;
  let topUp: { id: string; from: number; rows: number } | null = null;
  const deps = simDeps();
  // Only when set: delivered events get this link as their outreach list's Google Sheet. Nothing is hard-coded.
  const sheetUrl = process.env.SAMPLE_SHEET_URL?.trim() || null;
  for (const [i, r] of real.entries()) {
    const cid = `cat_${slug(r.name).slice(4)}`;
    const price = r.list_price_usd ? r.list_price_usd * 100 : ESTIMATE[r.size];
    await db.query(
      `INSERT INTO catalog_events (id, name, venue, city, country, starts_on, ends_on, website, seat_price_cents, price_is_estimate, source, confidence, source_url, size, brand_color)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'listed', $11, $12, $13, $14)`,
      [cid, r.name, r.venue ?? "", r.city, r.country, r.start, r.end, r.organizer_url, price, r.list_price_usd === null, r.confidence, r.source_url, r.size, r.brand_color ?? null]);
    const plan = PLAN[i];
    if (!plan || plan[0] === "none") continue;
    const [upto, approved, waiting, rows, uploader = "Maya Ortiz"] = plan;
    const total = approved + waiting;
    const id = slug(r.name);
    // A person asks once per event. People are dealt from the roster, a different start for each event, and the uploader always asks.
    const askers = new Set<string>(approved ? [uploader] : []);
    for (let k = 0; askers.size < Math.max(total, askers.size) && k < ROSTER.length * 2; k++) askers.add(ROSTER[(hash(r.name) + k * 7) % ROSTER.length].name);
    const people = [...askers].slice(0, Math.max(total, approved ? 1 : 0)).map((n) => ROSTER.find((p) => p.name === n)!);
    const made: { id: string; who: string }[] = [];
    for (const [k, p] of people.entries()) {
      const goal = GOALS[(hash(r.name + p.name)) % GOALS.length];
      const x = await requestSeat(db, p.name, {
        catalog_id: cid, suggestion: null, team: p.team, role: p.role, goal, why_event: WHY_EVENT[goal](r), why_you: WHY_YOU(p, r),
        expected_meetings: r.size === "flagship" ? 6 + (hash(p.name + r.name) % 9) : r.size === "regional" ? 4 + (hash(p.name + r.name) % 4) : 2 + (hash(p.name + r.name) % 3),
        known_accounts: k % 3 === 0 ? "Pinefold, Larkspur Freight, Brightwater" : null, travel_cents: k % 4 === 0 ? 120000 + (hash(p.name) % 8) * 15000 : null,
        decide_by: k % 5 === 0 ? new Date(Date.parse(r.start) - 21 * 86_400_000).toISOString().slice(0, 10) : null,
      }, { id, flow: "two_card", today: "2000-01-01" });
      made.push({ id: x.id, who: p.name });
    }
    if (upto === "declined") { for (const m of made) await decideSeat(db, { requestId: m.id, actor: DAN, decision: "decline", reason: "Not a priority this quarter" }); continue; }
    for (const m of made.slice(0, approved)) await decideSeat(db, { requestId: m.id, actor: DAN, decision: "approve" });
    if (upto === "requested" || upto === "approved") continue;
    // Attendee lists are windows of the large registration export, so numbers differ from event to event.
    const big = i === 15;
    const n = rows ?? 0;
    await ingestUpload(db, id, uploader, `${id.slice(4)}-registrations.csv`, big ? readFileSync(new URL("../../samples/attendees-large.csv", import.meta.url), "utf8") : windowCsv(cursor, n));
    if (i === TOP_UP_AT) topUp = { id, from: cursor, rows: n };
    cursor += n;
    if (upto === "mapped") continue;
    await requestResearchCard(db, id, uploader);
    if (upto === "quoted") continue;
    await decideApproval(db, { approvalId: await pending(id), actor: uploader, decision: "approve" });
    // The flagship's research is the slow part. It is left approved here; the server's boot kick runs it in the background and it ends with its cases open.
    if (upto === "review") continue;
    await processEvent(db, id, deps);
    for (const c of await listCases(db, id)) if (!c.decision) await answerCase(db, id, c.id, DAN, c.suggested ?? c.options[0].value as string);
    await processEvent(db, id, deps);
    await requestOutreachCard(db, id, uploader);
    if (upto === "outreach") continue;
    await decideApproval(db, { approvalId: await pending(id), actor: uploader, decision: "approve" });
    // Delivered events are left with the Outreach card approved; the boot kick finds the people in the background. The paused one runs here against vendors that fail.
    if (upto === "paused") {
      // The finders fail on every person until the run pauses itself. A pause raised while a miss is being closed escapes the run; the event is paused here all the same.
      try { await processEvent(db, id, { ...deps, vendorsFor: failingVendors }); }
      catch (e) { if (!(e instanceof PauseSignal)) throw e; await moveEvent(db, id, "paused", "Events Desk", { detail: `${vendorWords(e.message)} keeps failing` }); }
    }
    else if (sheetUrl) await db.query("UPDATE events SET sheet_url = $2 WHERE id = $1", [id, sheetUrl]);
  }
  // New registrations waiting to run on one delivered event: the rows it already has, then people it does not. Everyone in the file is fictional, from the same export as the other lists.
  if (topUp) {
    await processEvent(db, topUp.id, deps);
    const late = windowCsv(cursor, 12).split("\n").slice(3).join("\n");
    const made = await createTopUp(db, topUp.id, "Maya Ortiz", `${topUp.id.slice(4)}-late-registrations.csv`, windowCsv(topUp.from, topUp.rows) + late);
    if (made.top_up_id) await requestResearchCard(db, made.top_up_id, "Maya Ortiz");
  }
  // One suggestion waiting, so the Seats screen shows a new event next to the listed ones.
  const p = ROSTER[0];
  await requestSeat(db, p.name, {
    catalog_id: null, suggestion: { name: "Orrery customer dinner, Lisbon", website: "https://orrery.example.com/dinner", starts_on: "2026-12-03", ends_on: "2026-12-03", city: "Lisbon", country: "Portugal", price_cents: 18000 },
    team: p.team, role: p.role, goal: "existing_customers", why_event: "Four customers are in Lisbon for Web Summit and a dinner the week after is the cheapest way to see them together.",
    why_you: "I run the account plans for three of them and would host.", expected_meetings: 4, known_accounts: "Pinefold", travel_cents: null, decide_by: null,
  });
  // Tickets already bought: every seat at a past event, and half of those in the next six weeks, some at an early-bird price.
  const seats = await db.query<{ id: string; starts_on: string; price: number }>(
    `SELECT r.id, e.starts_on::text AS starts_on, e.seat_price_cents AS price FROM seat_requests r JOIN events e ON e.id = r.event_id WHERE r.status = 'approved' AND e.stage <> 'declined' ORDER BY r.id`);
  const today = "2026-11-08", soon = "2026-12-20";
  for (const [k, x] of seats.entries()) {
    if (x.starts_on < today || (x.starts_on < soon && k % 2 === 0)) await recordTicket(db, DAN, x.id, (x.price * (hash(x.id) % 4 === 0 ? 0.9 : 1)) / 100);
  }
  await setBudget(db, DAN, 2026, [70000, 85000, 75000, 70000]);
  await setBudget(db, DAN, 2027, [45000, 55000, 40000, 30000]);
}
