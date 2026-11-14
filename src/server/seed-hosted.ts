/* The demo's hosted dinners, written through the same code the routes use (docs/HOSTED.md 17 and 21.2, 21.3, 21.21). Every date the code checks is an explicit clock, so a seed made on any day reads the same:
   - Golden Gate Field Dinner is the dinner run from list to reminder: target accounts uploaded, 22 guests listed, eleven invited from the host's mailbox, five registered, one waitlisted at capacity 5 and the
     capacity then raised to 10 (raising it promotes nobody), two declined, three unanswered, one reminder to the registered, a venue with a minimum spend and a guarantee in 13 days.
   - Riverbend, Cascadia and Lakeside are closed with attended and no-show, which gives the open dinner the team's own history.
   - Capitol Revenue Roadshow is at the door on the demo's day: registered guests, one checked in, one walk-in.
   The Orrery customer dinner in Lisbon is seeded by seed-real.ts. A dinner past its day has its seed-year cost; these seeds add no money of their own. */

import type { Db } from "./db.ts";
import { addGuest, checkIn, closeAttendance, logInvitation, patchHosted, updateGuest, walkIn, type GuestInput, type HostedDeps } from "./hosted.ts";
import { importTargetAccounts } from "./guest-import.ts";
import { putCohost, putVenue } from "./hosted-view.ts";
import { sendReminder } from "./hosted-reminders.ts";
import { answerRsvp } from "./rsvp.ts";
import { simulatedSender } from "./transactional.ts";
import { seedHosted, YEAR } from "./seed-year.ts";
import { addDays } from "../shared/motion.ts";

const MAYA = "Maya Ortiz", PRIYA = "Priya Natarajan", LEO = "Leo Marsh";
export const GOLDEN_GATE = "evt_y24", LAKESIDE = "evt_y18", RIVERBEND = "evt_y04", CASCADIA = "evt_y12", CAPITOL = "evt_y22";
/** Fixed ids so restampDemoPlan can find the dated rows. */
export const GG_STEP_FREE = "vcs_seed_gg_free", GG_STEP_FEE = "vcs_seed_gg_fee";

const at = (ymd: string, hour = 12, minute = 0) => new Date(`${ymd}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
const clock = (when: Date): HostedDeps & { sender: ReturnType<typeof simulatedSender> } => ({ now: () => when, sender: simulatedSender() });
const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");

const FIRST = ["Ana", "Ben", "Cara", "Dev", "Elif", "Finn", "Gia", "Hugo", "Iris", "Jon", "Kira", "Luca", "Mina", "Noor", "Omar", "Pia", "Quinn", "Rosa", "Sam", "Tess", "Uma", "Vik", "Wen", "Xan", "Yara", "Zed"];
const LAST = ["Ruiz", "Cole", "Fox", "Patel", "Yilmaz", "Berg", "Rossi", "Silva", "Novak", "Hart", "Ito", "Marin", "Cho", "Haas", "Aziz", "Lund", "Reed", "Costa", "Lowe", "Quist", "Dunn", "Rao", "Zhou", "Bell", "Khan", "Moss"];
const COMPANIES = ["Acme Payments", "Brightwater Bank", "Cinder Logistics", "Delphi Commerce", "Estuary Fintech", "Foxglove Retail", "Granite Freight", "Harbor Health", "Ibex Insurance", "Juniper Cloud", "Kestrel Ledger", "Lumen Billing", "Marlow Foods", "Northwind SaaS", "Osprey Telecom", "Pylon Energy", "Quarry Mining", "Redwood Media", "Sable Fintech", "Tern Travel", "Umber Retail", "Vesper Data"];
const TITLES = ["VP Revenue", "Head of Partnerships", "Chief Revenue Officer", "Director of Sales", "Head of Revenue Operations", "VP Marketing"];

/** A pool of people for one event: unique names and emails within it, offset so two dinners do not share a person. */
function people(n: number, offset: number, country = "US"): GuestInput[] {
  return Array.from({ length: n }, (_, i) => {
    const k = offset + i, name = `${FIRST[k % FIRST.length]} ${LAST[(k * 7 + 3) % LAST.length]}`, company = COMPANIES[k % COMPANIES.length];
    return { name, company, title: TITLES[k % TITLES.length], country, email: `${slug(name)}@${slug(company).split(".")[0]}.example`, owner: [MAYA, PRIYA, LEO][k % 3] };
  });
}

async function answer(db: Db, deps: HostedDeps, gid: string, a: "yes" | "no", extra: { dietary?: string; note?: string } = {}) {
  const [{ rsvp_token }] = await db.query<{ rsvp_token: string }>("SELECT rsvp_token FROM event_guests WHERE id = $1", [gid]);
  await answerRsvp(db, deps, rsvp_token, { answer: a, ...extra });
}

async function hostThe(db: Db, id: string, host: string, over: Record<string, unknown> = {}) {
  await patchHosted(db, host, id, { host_name: host, host_email: `${slug(host).split(".")[0]}@orrery.example`, doors_at: "18:30", ...over });
}

/** One past dinner: guests listed, invited, answered, some checked in on the day, attendance closed the day after, owners' notes written. `came` of the `yes` guests are in the room. */
async function closedDinner(db: Db, id: string, on: string, o: { offset: number; capacity: number; yes: number; came: number; declined: number; walkIns?: number; cohost?: { partner: string; share: number; rule: string } }) {
  await hostThe(db, id, MAYA, { capacity: o.capacity, address: "See the venue", welcome: "A small table and good food." });
  const list = people(o.yes + o.declined + 2, o.offset);
  const ids: string[] = [];
  for (const [i, p] of list.entries()) ids.push((await addGuest(db, MAYA, id, { ...p, source: i % 4 === 0 ? "nomination" : "account" }, { at: at(addDays(on, -30)) })).id);
  for (const [i, gid] of ids.entries()) {
    if (i >= o.yes + o.declined) continue;
    await logInvitation(db, MAYA, id, gid, { sent_on: addDays(on, -21 + (i % 4)) }, { now: at(addDays(on, -21 + (i % 4))) });
  }
  for (const [i, gid] of ids.entries()) {
    const when = clock(at(addDays(on, -14 + (i % 5)), 9 + (i % 8), i));
    if (i < o.yes) await answer(db, when, gid, "yes", i % 5 === 0 ? { dietary: "Vegetarian" } : {});
    else if (i < o.yes + o.declined) await answer(db, when, gid, "no", { note: "Travelling that week." });
  }
  const door = clock(at(on, 22));
  for (const gid of ids.slice(0, o.came)) await checkIn(db, door, MAYA, id, gid);
  for (let w = 0; w < (o.walkIns ?? 0); w++) await walkIn(db, door, MAYA, id, { name: `Walker ${w + 1} ${LAST[(o.offset + w) % LAST.length]}`, company: COMPANIES[(o.offset + w + 5) % COMPANIES.length] });
  await updateGuest(db, MAYA, id, ids[0], { notes: "Wants a follow-up call about a pilot in the new year." });
  if (o.came > 1) await updateGuest(db, MAYA, id, ids[1], { notes: "Asked for an introduction to their payments lead." });
  if (o.yes > o.came) await updateGuest(db, MAYA, id, ids[o.yes - 1], { notes: "Sent word on the day: a flight was cancelled." });
  if (o.cohost) await putCohost(db, MAYA, id, { partner: o.cohost.partner, our_share_percent: o.cohost.share, lead_rule: o.cohost.rule, note: "Costs shared by the agreed percent." });
  await closeAttendance(db, clock(at(addDays(on, 1), 15)), MAYA, id);
}

/** The Golden Gate dinner, run from the list to the reminder. */
async function goldenGate(db: Db, today: string) {
  const id = GOLDEN_GATE, on = "2026-12-10";
  await importTargetAccounts(db, "Camille Laurent", [
    "name,domain,country,owner,open_deal,deal_stage",
    ...COMPANIES.slice(0, 14).map((c, i) => `${c},${slug(c).split(".")[0]}.example,US,${[MAYA, PRIYA, LEO][i % 3]},${i % 3 === 0 ? `${c} expansion` : ""},${i % 3 === 0 ? "Proposal" : ""}`),
  ].join("\n"));
  const accounts = await db.query<{ id: string; name: string }>("SELECT id, name FROM target_accounts ORDER BY lower(name)");
  const acct = new Map(accounts.map((a) => [a.name, a.id]));
  await hostThe(db, id, MAYA, { capacity: 5, address: "1 Ferry Building, San Francisco", welcome: "Ten seats at one table, no slides, good wine." });
  // Twenty-two guests: sixteen from accounts and deals, six nominated by AEs. Two of the unanswered are in countries the desk does not email, one has no country: the host writes those by hand.
  const list = people(22, 40).map((p, i): GuestInput => ({ ...p, source: i < 16 ? (i % 3 === 0 ? "deal" : "account") : "nomination", ...(i < 14 ? { account_id: acct.get(COMPANIES[i % 14])!, company: COMPANIES[i % 14], owner: undefined } : {}) }));
  list[19].country = "DE"; list[20].country = "SE"; list[21].country = null;
  const ids: string[] = [];
  for (const [i, g] of list.entries()) ids.push((await addGuest(db, i < 16 ? MAYA : (g.owner as string), id, { ...g, nominated_by: i >= 16 ? (g.owner as string) : undefined }, { at: at(addDays(on, -30)) })).id);
  // Eleven invited by the host from their own mailbox (logged, never sent by the desk).
  for (const [i, gid] of ids.slice(0, 11).entries()) await logInvitation(db, MAYA, id, gid, { sent_on: addDays(on, -24 + (i % 6)), mailbox: "maya@orrery.example" }, { now: at(addDays(on, -24 + (i % 6)), 10, i) });
  // Five yes, then a sixth yes at capacity 5: the waitlist. Two decline. Three have not answered.
  for (const [i, gid] of ids.slice(0, 6).entries()) await answer(db, clock(at(addDays(on, -18 + i), 11, i)), gid, "yes", i === 1 ? { dietary: "No shellfish" } : i === 4 ? { dietary: "Vegetarian" } : {});
  for (const gid of ids.slice(6, 8)) await answer(db, clock(at(addDays(on, -16), 14)), gid, "no", { note: "Cannot make it." });
  // Capacity rises to 10 afterwards. Raising it promotes nobody: the host moves the waitlisted guest in.
  await patchHosted(db, MAYA, id, { capacity: 10 });
  // One reminder, to the registered only.
  await sendReminder(db, clock(at(addDays(on, -9), 9)), MAYA, id, "reminder", { origin: "https://events-desk.example" });
  // The venue sits on the dinner's budget line: a minimum spend, a guarantee in 13 days, and two cancellation steps.
  const [line] = await db.query<{ id: string }>("SELECT id FROM budget_lines WHERE event_id = $1 AND category = 'dinners' ORDER BY id LIMIT 1", [id]);
  await putVenue(db, clock(at(today)), MAYA, id, {
    name: "Ferry Building Room", address: "1 Ferry Building, San Francisco", budget_line_id: line.id, minimum_spend_cents: 400_000, guarantee_headcount: 10, guarantee_by: addDays(today, 13), note: "Private room, seated, one menu.",
    steps: [{ id: GG_STEP_FREE, by_date: addDays(today, 5), rule: "Free cancellation ends", fee_cents: 0 }, { id: GG_STEP_FEE, by_date: addDays(today, 13), rule: "Half the minimum spend is owed after this", fee_cents: 200_000 }],
  });
}

/** The roadshow stop on the demo's day: registered guests, one checked in, one walk-in. Its date is moved to the demo's day by restampDemoPlan. */
async function capitol(db: Db, today: string) {
  const id = CAPITOL, on = "2026-11-19";
  await hostThe(db, id, MAYA, { capacity: 12, address: "225 Eastern Market, Washington", doors_at: "17:00", welcome: "A short evening for the buyers in Washington." });
  const list = people(14, 80);
  const ids: string[] = [];
  for (const [i, p] of list.entries()) ids.push((await addGuest(db, MAYA, id, { ...p, source: i % 3 === 0 ? "nomination" : "account" }, { at: at(addDays(on, -25)) })).id);
  for (const [i, gid] of ids.slice(0, 12).entries()) await logInvitation(db, MAYA, id, gid, { sent_on: addDays(on, -20 + (i % 5)) }, { now: at(addDays(on, -20 + (i % 5)), 10, i) });
  for (const [i, gid] of ids.slice(0, 10).entries()) await answer(db, clock(at(addDays(on, -12 + (i % 6)), 9 + (i % 7), i)), gid, "yes", i % 4 === 0 ? { dietary: "Vegetarian" } : {});
  await answer(db, clock(at(addDays(on, -10), 15)), ids[10], "no", { note: "A client visit that evening." });
  await checkIn(db, clock(at(today, 17, 20)), MAYA, id, ids[0]);
  await walkIn(db, clock(at(today, 17, 40)), MAYA, id, { name: "Wanda Walker", company: "Quarry Mining", title: "VP Sales" });
}

/** Creates the five hosted dinners and the roadshow stop from the year seed that the demo does not otherwise carry, then fills them. Skips an event that is already there. */
export async function seedHostedYear(db: Db, today: string) {
  for (const y of YEAR.filter((x) => [RIVERBEND, CASCADIA, LAKESIDE, CAPITOL, GOLDEN_GATE].includes(x.id))) {
    const [have] = await db.query("SELECT 1 FROM events WHERE id = $1", [y.id]);
    if (!have) await seedHosted(db, y, today);
  }
  await closedDinner(db, RIVERBEND, "2026-02-24", { offset: 0, capacity: 8, yes: 7, came: 6, declined: 1 });
  await closedDinner(db, CASCADIA, "2026-06-16", { offset: 10, capacity: 10, yes: 8, came: 6, declined: 2 });
  await closedDinner(db, LAKESIDE, "2026-09-22", { offset: 20, capacity: 8, yes: 8, came: 7, declined: 1, walkIns: 1, cohost: { partner: "Lakeline Partners", share: 50, rule: "own_invites" } });
  await goldenGate(db, today);
  await capitol(db, today);
}
