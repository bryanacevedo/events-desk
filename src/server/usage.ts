/* Usage, read only, from the real ledger (credit_ledger: reserved minus released). Vendor credits and AI dollars are never added or converted:
   each of Apollo and ZeroBounce is counted in its own credits against its own pre-allocated pool (null means unknown, so only
   what was used is shown), and only AI model calls (Anthropic) are dollars. AI dollars come from the tokens each call reported (src/server/ai-cost.ts); a call with no token count (a simulated run) is
   priced at the flat rate and counted apart. Nothing here is written, and nothing here is in the Budget, which is tickets only. */

import type { Db } from "./db.ts";
import { defaultSettings } from "./approvals.ts";
import { readPools } from "./pools.ts";
import { priceAi, realCalls, type AiPart } from "./ai-cost.ts";
import { aiWork, cardBreakdown, CREDIT_VENDORS, creditWork, vendorOf, type CreditVendor, type PoolPeriod } from "../shared/vendors.ts";

const NET = `coalesce(sum(CASE l.kind WHEN 'reserve' THEN l.amount WHEN 'release' THEN -l.amount ELSE 0 END), 0)::int`;

export interface UsageQuery { year?: number; month?: number; q?: string; page?: number; size?: number }
interface LedgerRow { event_id: string; note: string; step: string | null; unit: string; n: number }

/** Ledger rows of deleted events are read too (ledger_kept, notes already resolved), so a pool reads the same after an event is deleted. */
const ledger = (db: Db, from: string, to: string) => db.query<LedgerRow>(
  `SELECT l.event_id, coalesce((SELECT r.note FROM credit_ledger r WHERE r.id = l.reservation_id), l.note) AS note, l.step, l.unit, ${NET} AS n
   FROM (SELECT event_id, reservation_id, note, step, unit, kind, amount, created_at FROM credit_ledger
         UNION ALL SELECT event_id, reservation_id, note, step, unit, kind, amount, created_at FROM ledger_kept) l
   WHERE l.created_at >= $1 AND l.created_at < $2 GROUP BY 1, 2, 3, 4`, [from, to]);

/** What stored answers saved in a period, from reuse_log. Credits per vendor and model calls stay apart. Survives an event delete, like the ledger copy. */
async function savedIn(db: Db, from: string, to: string) {
  const rows = await db.query<{ vendor: string; step: string; unit: string; n: number }>("SELECT vendor, step, unit, sum(n)::int AS n FROM reuse_log WHERE created_at >= $1 AND created_at < $2 GROUP BY 1, 2, 3", [from, to]);
  const credits = new Map<CreditVendor, number>(CREDIT_VENDORS.map((v) => [v, 0]));
  let llm = 0;
  for (const r of rows) {
    if (r.unit === "llm") { llm += r.n; continue; }
    const v = vendorOf(r.vendor, r.step);
    if (v) credits.set(v, credits.get(v)! + r.n);
  }
  return { credits, llm };
}

/** Credits per vendor and what they went to, and AI calls per step, from ledger rows. */
function tally(rows: LedgerRow[]) {
  const credits = new Map<CreditVendor, Map<string, number>>(CREDIT_VENDORS.map((v) => [v, new Map()]));
  const ai = new Map<string, number>();
  for (const r of rows) {
    if (!r.n) continue;
    if (r.unit === "llm") { const w = aiWork(r.step ?? r.note); ai.set(w, (ai.get(w) ?? 0) + r.n); continue; }
    const v = vendorOf(r.note, r.step);
    if (!v) continue;
    const m = credits.get(v)!, w = creditWork(r.step, r.note);
    m.set(w, (m.get(w) ?? 0) + r.n);
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const parts = (m: Map<string, number>) => [...m.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
  return { credits, ai, sum, parts };
}

/** One event's use by vendor, and its AI calls. For the workbook Summary. */
export async function eventUse(db: Db, eventId: string) {
  // The parent and whatever its top-ups ran, stopped ones included: that money was spent on this event.
  const rows = await db.query<LedgerRow>(
    `SELECT l.event_id, coalesce((SELECT r.note FROM credit_ledger r WHERE r.id = l.reservation_id), l.note) AS note, l.step, l.unit, ${NET} AS n
     FROM credit_ledger l WHERE l.event_id = $1 OR l.event_id IN (SELECT id FROM events WHERE parent_event_id = $1) GROUP BY 1, 2, 3, 4`, [eventId]);
  const t = tally(rows);
  return { credits: CREDIT_VENDORS.map((v) => ({ vendor: v, credits: t.sum(t.credits.get(v)!) })).filter((x) => x.credits > 0), ai_calls: t.sum(t.ai) };
}

export async function usageView(db: Db, o: UsageQuery & { simulated: boolean }) {
  const s = defaultSettings();
  const pools = await readPools(db);
  const now = new Date();
  const year = o.year ?? now.getFullYear(), month = o.month ?? now.getMonth() + 1;
  const m0 = `${year}-${String(month).padStart(2, "0")}-01`, m1 = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const y0 = `${year}-01-01`, y1 = `${year + 1}-01-01`;
  const [monthRows, yearRows] = await Promise.all([ledger(db, m0, m1), ledger(db, y0, y1)]);
  const rowsFor = (p: PoolPeriod) => (p === "month" ? monthRows : yearRows);
  const [savedMonth, savedYear] = await Promise.all([savedIn(db, m0, m1), savedIn(db, y0, y1)]);

  const vendors = CREDIT_VENDORS.map((vendor) => {
    const pool = pools[vendor], t = tally(rowsFor(pool.period));
    const m = t.credits.get(vendor)!;
    return { vendor, used: t.sum(m), allotment: pool.allotment, period: pool.period, parts: t.parts(m), saved: (pool.period === "month" ? savedMonth : savedYear).credits.get(vendor)! };
  });

  const rate = s.llm_call_cents;
  const [realMonth, realYear] = await Promise.all([realCalls(db, m0, m1), realCalls(db, y0, y1)]);
  const priceOf = (rows: LedgerRow[], real: Awaited<ReturnType<typeof realCalls>>) => priceAi(rows.filter((r) => r.unit === "llm"), real, rate);
  const pm = priceOf(monthRows, realMonth), py = priceOf(yearRows, realYear);
  const total = (m: Map<string, AiPart>, f: (p: AiPart) => number) => [...m.values()].reduce((n, p) => n + f(p), 0);
  const byWork = new Map<string, number>();
  for (const p of pm.values()) byWork.set(aiWork(p.step), (byWork.get(aiWork(p.step)) ?? 0) + p.cents);
  const ai = {
    month_cents: Math.round(total(pm, (p) => p.cents) * 100) / 100, year_cents: Math.round(total(py, (p) => p.cents) * 100) / 100,
    // Saved calls are stored answers that were not bought again; what they would have cost is unknown, so they are valued at the flat rate.
    saved_cents: savedMonth.llm * rate,
    parts: [...byWork.entries()].map(([label, cents]) => ({ label, cents: Math.round(cents * 100) / 100 })).sort((a, b) => b.cents - a.cents),
    // How much of the month is measured: calls priced from reported tokens, and calls priced at the flat rate because they carry none.
    real_calls: total(pm, (p) => p.real_calls), flat_calls: total(pm, (p) => p.flat_calls), flat_cents_per_call: rate,
  };

  // One row per event: use by vendor against what its approved cards allow, and AI dollars the same way.
  const evRows = await db.query<{ event_id: string; name: string; starts_on: string }>(
    `SELECT e.id AS event_id, e.name, e.starts_on::text AS starts_on FROM events e
     WHERE e.parent_event_id IS NULL AND EXISTS (SELECT 1 FROM cost_cards k WHERE k.event_id = e.id AND k.status = 'approved') ORDER BY e.starts_on DESC, e.name`);
  // A top-up is not an event on this screen: what it spent shows on its parent's row, whether it merged or was stopped.
  const parentOf = new Map((await db.query<{ id: string; parent_event_id: string }>("SELECT id, parent_event_id FROM events WHERE parent_event_id IS NOT NULL")).map((r) => [r.id, r.parent_event_id]));
  const rollUp = (id: string) => parentOf.get(id) ?? id;
  const cards = await db.query<{ event_id: string; step_caps: any; lines: any; rates: any; llm_cap: number }>(
    "SELECT event_id, step_caps, lines, rates - 'credit_cents' AS rates, llm_cap FROM cost_cards WHERE status = 'approved'");
  const allRows = await ledger(db, "1970-01-01", "9999-01-01");
  const priceAll = priceAi(allRows.filter((r) => r.unit === "llm"), await realCalls(db, "1970-01-01", "9999-01-01"), rate);
  const aiCentsOf = (ids: Set<string> | string) => [...priceAll.values()].filter((p) => (typeof ids === "string" ? rollUp(p.event_id) === ids : ids.has(p.event_id))).reduce((n, p) => n + p.cents, 0);
  const needle = (o.q ?? "").trim().toLowerCase();
  const evAll = evRows.filter((r) => !needle || r.name.toLowerCase().includes(needle)).map((r) => {
    const t = tally(allRows.filter((x) => rollUp(x.event_id) === r.event_id));
    const cap = new Map<CreditVendor, number>(CREDIT_VENDORS.map((v) => [v, 0]));
    let aiCap = 0;
    for (const c of cards.filter((k) => rollUp(k.event_id) === r.event_id)) {
      const b = cardBreakdown(c);
      for (const x of b.credits) cap.set(x.vendor, cap.get(x.vendor)! + x.credits);
      aiCap += b.ai_cents;
    }
    return {
      ...r,
      credits: Object.fromEntries(CREDIT_VENDORS.map((v) => [v, { used: t.sum(t.credits.get(v)!), cap: cap.get(v)! }])) as Record<CreditVendor, { used: number; cap: number }>,
      ai: { cents: Math.round(aiCentsOf(r.event_id) * 100) / 100, cap_cents: aiCap },
    };
  });
  const size = Math.min(100, Math.max(5, o.size ?? 12)), pages = Math.max(1, Math.ceil(evAll.length / size)), page = Math.min(pages, Math.max(1, o.page ?? 1));

  // Per delivered person, over events that reached delivery: AI dollars and Apollo credits, kept apart.
  const [d] = await db.query<{ people: number }>("SELECT count(*)::int AS people FROM contacts c JOIN events e ON e.id = c.event_id WHERE e.stage = 'delivered' AND c.dropped_at IS NULL");
  const delivered = new Set((await db.query<{ id: string }>("SELECT id FROM events WHERE stage = 'delivered'")).map((r) => r.id));
  const dt = tally(allRows.filter((r) => delivered.has(r.event_id)));
  const one = (n: number) => Math.round(n * 10) / 10;

  const healthRaw = await db.query<{ vendor: string; attempts: number; failures: number }>(
    `SELECT vendor, count(*)::int AS attempts, count(*) FILTER (WHERE result ILIKE '%error%' OR result ILIKE '%fail%')::int AS failures FROM enrichment_attempts GROUP BY vendor`);
  const health = new Map<string, { vendor: string; attempts: number; failures: number }>();
  for (const h of healthRaw) {
    const name = vendorOf(h.vendor) ?? creditWork(null, h.vendor);
    const cur = health.get(name) ?? { vendor: name, attempts: 0, failures: 0 };
    cur.attempts += h.attempts; cur.failures += h.failures; health.set(name, cur);
  }

  return {
    simulated: o.simulated, year, month,
    vendors, ai,
    events: evAll.slice((page - 1) * size, page * size), total_events: evAll.length, page, pages,
    per_person: {
      people: d.people,
      ai_cents: d.people ? one(aiCentsOf(delivered) / d.people) : null,
      apollo_credits: d.people ? one(dt.sum(dt.credits.get("Apollo")!) / d.people) : null,
    },
    vendor_health: [...health.values()].sort((a, b) => b.attempts - a.attempts),
  };
}
