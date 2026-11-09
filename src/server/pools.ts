/* Each credit vendor's pre-allocated pool: config/defaults.json says which vendors have one and over what period;
   a vendor_pools row overrides it (the demo seed writes sample values). A null allotment is unknown, never a guess. */

import type { Db } from "./db.ts";
import { defaultSettings } from "./approvals.ts";
import { CREDIT_VENDORS, type Pools } from "../shared/vendors.ts";

export async function readPools(db: Db): Promise<Pools> {
  const pools = { ...defaultSettings().pools } as Pools;
  const rows = await db.query<{ vendor: string; allotment: number | null; period: "month" | "year" }>("SELECT vendor, allotment, period FROM vendor_pools");
  for (const r of rows) if ((CREDIT_VENDORS as readonly string[]).includes(r.vendor)) pools[r.vendor as keyof Pools] = { allotment: r.allotment, period: r.period };
  return pools;
}

/** Sample allotments for the demo only. Real numbers come from the subscriptions. */
export const SAMPLE_POOLS: Pools = {
  Apollo: { allotment: 5000, period: "month" },
  ZeroBounce: { allotment: 10000, period: "year" },
};

export async function seedSamplePools(db: Db) {
  for (const [vendor, p] of Object.entries(SAMPLE_POOLS)) {
    await db.query("INSERT INTO vendor_pools (vendor, allotment, period) VALUES ($1, $2, $3) ON CONFLICT (vendor) DO UPDATE SET allotment = EXCLUDED.allotment, period = EXCLUDED.period", [vendor, p.allotment, p.period]);
  }
}
