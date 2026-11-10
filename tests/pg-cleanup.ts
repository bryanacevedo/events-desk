/* With TEST_ALL_ON_POSTGRES every test makes a throwaway schema. They are dropped before and after each run, or thousands pile up and slow the database. */

import postgres from "postgres";

async function dropAll(url: string) {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const rows = await sql<{ nspname: string }[]>`SELECT nspname FROM pg_namespace WHERE nspname LIKE 't\\_%'`;
  for (const r of rows) await sql.unsafe(`DROP SCHEMA "${r.nspname}" CASCADE`);
  await sql.end();
}

export default async function setup() {
  const url = process.env.TEST_ALL_ON_POSTGRES;
  if (!url) return;
  await dropAll(url);
  return () => dropAll(url);
}
