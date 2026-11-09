/* The Summary's perspective, written by a model from a packet of facts that code builds.

   This file holds the pure parts: the fact packet, the prompt, and the record stored on the event. The call itself is in perspective-run.ts.

   The packet carries event-level facts only, the same ones `perspective(d)` composes from: seat goals, who is going, ticket counts, the tier mix,
   top industries and countries, the comparison with other delivered lists, customers, open deals and net new accounts. Beside it go the seat requesters' own
   words. No attendee name, email, title or raw value from the attendee file is in it, and the account owners' names are left out too.

   A number in the packet is named so that its kind is clear to the check: `_pct` is a percentage, `_usd` is dollars, anything else is a count. */

import { createHash } from "node:crypto";
import { GOALS } from "./seats.ts";
import { fill } from "./prompts.ts";
import { allowedFrom, collapse, PARTS, type Allowed, type Part } from "./perspective-check.ts";
import type { Data } from "./workbook.ts";

export interface SeatWords { by: string; role: string; text: string }
export interface Packet { facts: Record<string, unknown>; words: SeatWords[]; proper: string[] }

const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);
const wordsOf = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The most common values, with their share of those that have a value. */
function tally(xs: (string | null | undefined)[], max = 3) {
  const m = new Map<string, number>();
  let known = 0;
  for (const x of xs) if (x) { m.set(x, (m.get(x) ?? 0) + 1); known++; }
  return { known, top: [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([name, n]) => ({ name, n, share_pct: pct(n, known) })) };
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** The seat request words are untrusted. A fence marker inside them is made harmless, and so is the template's own placeholder syntax. */
export const defang = (s: string) => collapse(s).replaceAll("<<<", "‹‹‹").replaceAll(">>>", "›››").replaceAll("{{", "{ {").replaceAll("}}", "} }");

export function buildPacket(d: Data): Packet {
  const approved = d.seats.filter((s) => s.status === "approved"), waiting = d.seats.filter((s) => s.status === "pending");
  const missing: string[] = [];
  const proper: string[] = [d.e.name];
  const facts: Record<string, unknown> = { event: { name: d.e.name } };

  // Why this event.
  if (!d.seats.length) {
    facts.seat_requests = { total: 0 };
    missing.push("No seat requests are on file for this event, so nobody has said why it matters.");
  } else {
    const goals = tally(d.seats.map((s) => GOALS[s.goal as keyof typeof GOALS] ?? wordsOf(s.goal)), 5);
    const known = [...new Set(d.seats.flatMap((s) => (s.known_accounts ?? "").split(/[,;]/).map((x) => x.trim()).filter(Boolean)))].slice(0, 12);
    const meetings = d.seats.reduce((n, s) => n + (s.expected_meetings || 0), 0);
    for (const s of approved) proper.push(s.requester, s.team);
    proper.push(...known);
    facts.seat_requests = {
      total: d.seats.length, approved: approved.length, waiting: waiting.length,
      goals: goals.top.map((g) => ({ goal: g.name, requests: g.n })),
      going: approved.map((s) => ({ name: s.requester, team: s.team, role: s.role })),
      ...(meetings ? { meetings_expected: meetings } : {}),
      ...(known.length ? { known_accounts: known } : {}),
    };
    if (!approved.length) missing.push("No seat is approved yet, so nobody is confirmed as going.");
  }
  facts.tickets = { seats_approved: approved.length, seat_price_usd: Math.round(d.e.seat_price_cents / 100), bought: d.tickets.n, recorded_usd: Math.round(d.tickets.cents / 100) };
  const words: SeatWords[] = [...approved, ...waiting].slice(0, 2).map((s) => ({ by: s.requester, role: s.role, text: defang(s.why_event) }));
  for (const s of [...approved, ...waiting].slice(0, 2)) proper.push(s.requester);

  // The list.
  const companies = d.companies, tiered = companies.filter((c) => c.tier !== null);
  const t = (n: number) => companies.filter((c) => c.tier === n).length;
  const industry = tally(companies.map((c) => c.firmo?.industry)), region = tally(companies.map((c) => c.firmo?.country));
  const a = d.people.filter((p) => p.priority === "A").length, att = d.people.filter((p) => p.source === "attendee").length, onList = companies.filter((c) => c.n > 0);
  facts.list = {
    attendee_list: { rows: d.funnel.uploaded, companies: companies.length, people: d.attendee_people },
    tiers: tiered.length
      ? { companies_tiered: tiered.length, companies_untiered: companies.length - tiered.length, tier1: t(1), tier1_pct: pct(t(1), tiered.length), tier2: t(2), tier2_pct: pct(t(2), tiered.length), tier3: t(3), tier3_pct: pct(t(3), tiered.length) }
      : { companies_tiered: 0 },
    ...(industry.known ? { industries: { with_a_known_industry: industry.known, top: industry.top.map((x) => ({ industry: x.name, share_pct: x.share_pct })) } } : {}),
    ...(region.known ? { countries: { with_a_known_country: region.known, top: region.top.map((x) => ({ country: x.name, share_pct: x.share_pct })) } } : {}),
    outreach_list: { people: d.people.length, companies: onList.length, priority_a: a, priority_b: d.people.length - a, from_attendee_list: att, found_at_attending_companies: d.people.length - att },
  };
  if (!tiered.length) missing.push("Nothing on the attendee list has been tiered against the ideal customer.");
  if (!industry.known) missing.push("No company has a known industry.");
  if (!region.known) missing.push("No company has a known country.");
  if (d.program.length && tiered.length) {
    const others = d.program.map((p) => pct(p.tier1, p.tiered));
    facts.other_delivered_lists = {
      count: d.program.length, this_event_tier1_pct: pct(t(1), tiered.length),
      ...(d.program.length === 1 ? { name: d.program[0].name, tier1_pct: others[0] } : { median_tier1_pct: Math.round(median(others)), lowest_tier1_pct: Math.min(...others), highest_tier1_pct: Math.max(...others) }),
    };
    if (d.program.length === 1) proper.push(d.program[0].name);
  } else missing.push("There is no other delivered list to compare with.");

  // Where we stand.
  const crm = companies.some((c) => c.heat !== null || c.account_owner || c.account_type);
  if (!crm) {
    facts.crm = { connected: false };
    missing.push("No CRM answered, so owner, deal, heat and account type are blank everywhere.");
  } else {
    const customers = companies.filter((c) => c.list_status === "existing_customer" || c.account_type === "customer"), still = customers.filter((c) => c.n > 0);
    const deals = onList.filter((c) => c.deal_name), stages = tally(deals.map((c) => c.deal_stage), 4);
    const hot = onList.filter((c) => c.heat === "hot").length, warm = onList.filter((c) => c.heat === "warm").length;
    const owned = onList.filter((c) => c.account_owner).length;
    const fresh = onList.filter((c) => !c.account_owner && !c.deal_name && c.account_type !== "customer" && c.account_type !== "partner");
    facts.crm = {
      connected: true,
      accounts_on_outreach_list: onList.length,
      customers_on_attendee_list: customers.length, customers_still_on_outreach_list: still.length,
      with_an_open_deal: deals.length,
      ...(stages.known ? { deal_stages: stages.top.map((x) => ({ stage: x.name, share_pct: x.share_pct })) } : {}),
      heat: { hot, warm, cold_or_unknown: onList.length - hot - warm },
      with_an_owner: owned,
      net_new: { accounts: fresh.length, share_pct: pct(fresh.length, onList.length) },
    };
  }
  facts.not_on_file = missing;
  return { facts, words, proper };
}

/** Fingerprint of everything the model was shown. The stored text is used only while this still matches. */
export const packetHash = (p: Packet) => createHash("sha256").update(JSON.stringify({ facts: p.facts, words: p.words })).digest("hex").slice(0, 16);

/** What the check allows, derived from the same packet the model was shown. */
export function allowedOf(p: Packet): Allowed {
  return allowedFrom(p.facts, p.words.map((w) => w.text), p.words.flatMap((w) => [w.by, w.role]), p.proper);
}

export function promptOf(p: Packet): string {
  const safe = (s: string) => s.replaceAll("{{", "{ {").replaceAll("}}", "} }");
  const words = p.words.length
    ? p.words.map((w, i) => `<<<SEAT ${i + 1}: ${safe(w.by)}, ${safe(w.role)}\n${w.text}\nSEAT>>>`).join("\n")
    : "(none: no seat request has words on file)";
  return fill("perspective", { words, facts: safe(JSON.stringify(p.facts, null, 1)) });
}

/* ------------------------------------------------------------------ stored */

export type By = "model" | "fallback" | "simulated";
export interface StoredBlock { by: By; text: string | null; note: string | null }
export interface StoredPerspective { version: 1; model: string; made_at: string; packet_hash: string; blocks: Record<Part, StoredBlock> }

export const PART_TITLES: Record<Part, string> = { why: "Why this event", list: "The list", stand: "Where we stand" };

/** A stored record read back from the database, or null when it is not one (an old row, a hand edit). */
export function storedOf(v: unknown): StoredPerspective | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<StoredPerspective>;
  if (s.version !== 1 || typeof s.packet_hash !== "string" || !s.blocks || typeof s.model !== "string") return null;
  for (const p of PARTS) {
    const b = s.blocks[p];
    if (!b || !["model", "fallback", "simulated"].includes(b.by)) return null;
  }
  return s as StoredPerspective;
}
