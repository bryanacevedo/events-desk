/* With TEST_ALL_ON_POSTGRES every test makes a throwaway schema. They are dropped before and after each run, or thousands pile up and slow the database. */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { migrate, pglite } from "../src/server/db.ts";

async function dropAll(url: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const rows = await sql<{ nspname: string }[]>`SELECT nspname FROM pg_namespace WHERE nspname LIKE 't\\_%'`;
  for (const r of rows) await sql.unsafe(`DROP SCHEMA "${r.nspname}" CASCADE`);
  await sql.end();
}

/** Booting PGlite and applying every migration costs seconds, more on a busy machine, and 2,000 tests each did it inside their own 5 s budget. Do it once here, before any worker
    starts, and keep the data directory in a file; tests/helpers.ts starts each fresh database from it (about 0.15 s). Workers learn the path from the environment. */
async function buildTemplate(): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), "events-desk-pg-"));
  const file = join(dir, "migrated.tar");
  try {
    const db = await pglite();
    await migrate(db, readdirSync("migrations").filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(`migrations/${name}`, "utf8") })));
    writeFileSync(file, Buffer.from(await (await db.dump!()).arrayBuffer()));
    await db.close();
  } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  process.env.EVENTS_DESK_PG_TEMPLATE = file;
  return () => { delete process.env.EVENTS_DESK_PG_TEMPLATE; rmSync(dir, { recursive: true, force: true }); };
}

export default async function setup() {
  const url = process.env.TEST_ALL_ON_POSTGRES;
  if (url) { await dropAll(url); return () => dropAll(url); }
  return await buildTemplate();
}
