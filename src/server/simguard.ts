/* The simulation database guard (workday simulation, Revision 5). Off unless SIM_DB_GUARD=1, which the simulation runner sets.
   With it on, a database is refused unless its host is this laptop or one of SIM_ALLOWED_HOSTS (the Neon simulation
   projects) and its name is `neondb` or starts with SIM_DB_PREFIX (`sim_`), or is a local rehearsal or test one.
   With it off nothing changes: the public demo and every local run behave as before. */
export function simGuard(url: string, env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env): void {
  if (env.SIM_DB_GUARD !== "1") return;
  const u = new URL(url);
  const host = u.hostname, name = u.pathname.replace(/^\//, "");
  const allowed = (env.SIM_ALLOWED_HOSTS ?? "").split(",").filter(Boolean);
  const prefix = env.SIM_DB_PREFIX ?? "sim_";
  const local = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host);
  if (!local && !allowed.includes(host)) throw new Error(`Simulation guard: refusing host ${host}; it is not a simulation database.`);
  if (allowed.includes(host) && name !== "neondb" && !name.startsWith(prefix)) throw new Error(`Simulation guard: refusing database ${name}; simulation databases start with ${prefix}.`);
  if (local && !/^(p3|ev6p4|sim_|test|postgres$|events)/.test(name)) throw new Error(`Simulation guard: refusing local database ${name}.`);
}
