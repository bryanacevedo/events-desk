/* Shared set-up for the hosted tests: a dinner as a hosted plan with a host, guests added through the real code, and a clock. */

import type { Db } from "../src/server/db.ts";
import { setBudgetLine } from "../src/server/budget-lines.ts";
import { addPerson, createPlan } from "../src/server/plan.ts";
import { addGuest, logInvitation, patchHosted, type GuestInput, type HostedDeps } from "../src/server/hosted.ts";
import { answerRsvp } from "../src/server/rsvp.ts";
import { simulatedSender } from "../src/server/transactional.ts";
import { CAMILLE } from "./plan-helpers.ts";

export const DAY = "2027-06-10";
/** Twenty days before the dinner, at noon UTC. */
export const BEFORE = new Date("2027-05-21T12:00:00Z");
/** The evening of the dinner, Chicago time (mid-afternoon there). */
export const ON_THE_DAY = new Date("2027-06-10T22:00:00Z");
export const AFTER = new Date("2027-06-11T15:00:00Z");

export const depsAt = (at: Date, over: Partial<HostedDeps> = {}): HostedDeps & { sender: ReturnType<typeof simulatedSender> } => ({ now: () => at, sender: simulatedSender(), ...over }) as never;

let n = 0;
/** A hosted dinner in Chicago with Camille as its host, a line on the plan, and (by default) a capacity. */
export async function hostedDinner(db: Db, over: { capacity?: number | null; format?: string; headcount?: number | null; name?: string; country?: string; venue?: string } = {}) {
  const id = `evt_h${++n}_${Math.random().toString(36).slice(2, 6)}`;
  await createPlan(db, CAMILLE, {
    name: over.name ?? `Test Dinner ${n}`, venue: over.venue ?? "Union Pier Room, Chicago", country: over.country ?? "United States", starts_on: DAY, reason: "A dinner for the buyers we have not met.",
    hosted: { format: over.format ?? "dinner", headcount: over.headcount === undefined ? 1 : over.headcount },
  }, { id });
  await addPerson(db, CAMILLE, id, { person: CAMILLE, roles: ["host"] });
  await setBudgetLine(db, CAMILLE, id, { category: "dinners", label: "Dinner", planned_cents: 500_000 });
  await patchHosted(db, CAMILLE, id, { host_name: "Camille Laurent", host_email: "camille@orrery.example", doors_at: "18:30", address: "1 Pier Way, Chicago", welcome: "A small table and good food.", ...(over.capacity === null ? {} : { capacity: over.capacity ?? 4 }) });
  return id;
}

/** A guest with an email and a country that may be emailed, added by Camille. */
export const guest = (db: Db, id: string, name: string, over: GuestInput = {}) =>
  addGuest(db, CAMILLE, id, { name, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@acme.example`, company: "Acme", country: "US", owner: "Maya Ortiz", ...over });

export const invite = (db: Db, id: string, gid: string, at = BEFORE) => logInvitation(db, CAMILLE, id, gid, {}, { now: at });

export async function tokenOf(db: Db, gid: string) { return (await db.query<{ rsvp_token: string }>("SELECT rsvp_token FROM event_guests WHERE id = $1", [gid]))[0].rsvp_token; }
export async function statusOf(db: Db, gid: string) { return (await db.query<{ status: string }>("SELECT status FROM event_guests WHERE id = $1", [gid]))[0].status; }

/** Adds a guest, invites them and has them answer yes on their link. */
export async function yes(db: Db, deps: HostedDeps, id: string, name: string, over: GuestInput = {}) {
  const g = await guest(db, id, name, over);
  await invite(db, id, g.id);
  await answerRsvp(db, deps, await tokenOf(db, g.id), { answer: "yes" });
  return g.id;
}
