/* make ask Q="how many priority A contacts are there?"
   Boots the sample events in a throwaway database and asks the mock model. */

import { readdirSync, readFileSync } from "node:fs";
import { askConcierge, connectConcierge } from "../src/concierge/agent.ts";
import { migrate, pglite } from "../src/server/db.ts";
import { mockLlm } from "../src/server/providers.ts";
import { seed } from "../src/server/seed.ts";

const db = await pglite();
await migrate(db, readdirSync("migrations").filter((f) => f.endsWith(".sql")).map((name) => ({ name, sql: readFileSync(`migrations/${name}`, "utf8") })));
await seed(db);
const client = await connectConcierge(db);
console.log(await askConcierge(db, client, mockLlm, "evt_quarry", process.argv[2] || "How many priority A contacts are there?"));
await client.close();
await db.close();
