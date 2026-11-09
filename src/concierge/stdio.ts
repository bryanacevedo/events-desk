/* Serves Concierge over stdio for any MCP client. Needs DATABASE_URL. */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { postgresJs } from "../server/db.ts";
import { createConcierge } from "./server.ts";

const url = process.env.DATABASE_URL;
if (!url) { console.error("Concierge over stdio needs DATABASE_URL. For the demo, use `make ask`."); process.exit(1); }
await createConcierge(await postgresJs(url)).connect(new StdioServerTransport());
