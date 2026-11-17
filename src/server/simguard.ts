/* The simulation database guard (workday simulation, Revision 5). Off unless SIM_DB_GUARD=1, which the simulation runner sets.
   With it on, a database is refused unless its host is this laptop or one of SIM_ALLOWED_HOSTS (the Neon simulation
   projects) and its name is `neondb` or starts with SIM_DB_PREFIX (`sim_`), or is a local rehearsal or test one.
   A URL with several hosts, a second `@`, or a host, hostaddr, database, dbname, service or options in its query is refused,
   because the driver would read those differently from this check; so is a PG* environment variable that would override the URL.
   With it off nothing changes: the public demo and every local run behave as before. */
const OVERRIDES = ["host", "hostaddr", "database", "dbname", "service", "options", "port"];
const LOCAL_DB = /^(p3t?_|s3b?_|sim_|test_|ev6p4_)[a-z0-9_]*$|^postgres$/;

export function simGuard(url: string, env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env): void {
  if (env.SIM_DB_GUARD !== "1") return;
  const afterScheme = url.replace(/^[a-z]+:\/\//i, "");
  const authority = afterScheme.split(/[/?]/, 1)[0];
  if ((authority.match(/@/g) ?? []).length > 1 || authority.includes(",")) throw new Error("Simulation guard: one host only and no second '@' in the URL.");
  const u = new URL(url);
  for (const k of u.searchParams.keys()) if (OVERRIDES.includes(k.toLowerCase())) throw new Error("Simulation guard: the URL carries a host, database or option override.");
  if (["PGHOST", "PGHOSTADDR", "PGDATABASE", "PGSERVICE", "PGOPTIONS"].some((v) => env[v])) throw new Error("Simulation guard: a PG* environment variable would override the URL.");
  const host = u.hostname, name = u.pathname.replace(/^\//, "");
  const allowed = (env.SIM_ALLOWED_HOSTS ?? "").split(",").filter(Boolean);
  const prefix = env.SIM_DB_PREFIX ?? "sim_";
  const local = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);
  if (!local && !allowed.includes(host)) throw new Error(`Simulation guard: refusing host ${host}; it is not a simulation database.`);
  if (allowed.includes(host) && name !== "neondb" && !name.startsWith(prefix)) throw new Error(`Simulation guard: refusing database ${name}; simulation databases start with ${prefix}.`);
  if (local && !LOCAL_DB.test(name)) throw new Error(`Simulation guard: refusing local database ${name}.`);
}
