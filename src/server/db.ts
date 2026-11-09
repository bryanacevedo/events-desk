/* The one seam between the API and Postgres. Two drivers sit behind it:
   - PGlite: real Postgres compiled to WebAssembly, used by `make demo` so the
     project runs with nothing installed.
   - postgres.js: any Postgres over the network (Supabase, Neon, Docker, RDS),
     used whenever DATABASE_URL is set and by the Cloudflare deploy.
   Both get the same SQL. Rows come back with timestamps as ISO strings and
   dates as YYYY-MM-DD, so the API never sees a driver-specific type. */

export type Row = Record<string, unknown>;

export interface Db {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  /** Runs fn inside BEGIN/COMMIT; any throw rolls the whole thing back. */
  tx<T>(fn: (q: Db["query"]) => Promise<T>): Promise<T>;
  /** Runs a multi-statement script (migrations, seed) in one transaction. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/* Normalise driver output: Date -> ISO string, numeric strings -> numbers. */
const NUMERIC = new Set(["seat_count", "seat_price_cents", "seat_budget_cents", "n", "credits_cap", "llm_cap", "est_cents", "row_count", "companies", "people", "company_only", "amount", "tier", "credits", "llm"]);
export function clean<T>(rows: Row[]): T[] {
  return rows.map((r) => {
    const o: Row = {};
    for (const [k, v] of Object.entries(r)) {
      if (v instanceof Date) o[k] = k === "date" || k.endsWith("_date") ? v.toISOString().slice(0, 10) : v.toISOString();
      else if (NUMERIC.has(k) && v != null) o[k] = Number(v);
      else o[k] = v;
    }
    return o as T;
  });
}

export async function pglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  // A small host: Postgres keeps its caches short. Queries get slower, not wrong.
  const small = process.env.PUBLIC_DEMO === "1" ? { startParams: [...(PGlite as unknown as { defaultStartParams: string[] }).defaultStartParams, "-c", "shared_buffers=16MB", "-c", "temp_buffers=1MB", "-c", "work_mem=2MB", "-c", "maintenance_work_mem=8MB", "-c", "wal_buffers=1MB"] } : {};
  const pg = new PGlite(dataDir, small);
  await pg.exec("SET TIME ZONE 'UTC'");
  const query = async <T>(text: string, params: unknown[] = []) => clean<T>((await pg.query<Row>(text, params)).rows);
  return {
    query,
    tx: (fn) => pg.transaction(async (t) => fn(async <T>(text: string, params: unknown[] = []) => clean<T>((await t.query<Row>(text, params)).rows))),
    exec: async (sql) => { await pg.transaction(async (t) => { await t.exec(sql); }); },
    close: () => pg.close(),
  };
}

export async function postgresJs(url: string, opts: { max?: number } = {}): Promise<Db> {
  const { default: postgres } = await import("postgres");
  // prepare:false keeps it compatible with transaction-mode poolers (Supabase pooler, Hyperdrive).
  const sql = postgres(url, { prepare: false, max: opts.max ?? 5, connection: { TimeZone: "UTC" }, types: { date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x } } });
  const query = async <T>(text: string, params: unknown[] = []) => clean<T>(await sql.unsafe<Row[]>(text, params as never[]));
  return {
    query,
    tx: (fn) => sql.begin(async (t) => fn(async <T>(text: string, params: unknown[] = []) => clean<T>(await t.unsafe<Row[]>(text, params as never[])))) as Promise<never>,
    exec: async (script) => { await sql.begin(async (t) => { await t.unsafe(script); }); },
    close: () => sql.end({ timeout: 5 }),
  };
}

/* ------------------------------------------------------------- migrations */

/** Applies each migration once, in order, recording it in schema_migrations. */
export async function migrate(db: Db, files: { name: string; sql: string }[]) {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(f.name)) continue;
    await db.exec(`${f.sql}\nINSERT INTO schema_migrations (name) VALUES ('${f.name.replace(/'/g, "''")}');`);
  }
}
