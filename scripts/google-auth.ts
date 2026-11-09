/* One-time Google consent, run by the person whose Drive will hold the Sheets.

     node --env-file-if-exists=.env scripts/google-auth.ts --out ~/some-private-file

   Needs GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (a Desktop app client).
   Opens nothing by itself: it prints a Google link, you open it, and Google sends the
   browser back to a port on this machine only. The refresh token goes to the file you
   name (mode 600) and is never printed. Paste its contents into
   GOOGLE_OAUTH_REFRESH_TOKEN in .env, then delete the file. */

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { consentUrl, exchangeCode, pkcePair, saveSecret } from "../src/server/google-auth.ts";

const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1];
if (args.indexOf("--out") < 0 || !out || out.startsWith("--")) { console.error("Usage: node scripts/google-auth.ts --out <file for the refresh token>"); process.exit(1); }
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim(), clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
if (!clientId || !clientSecret) { console.error("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first (see docs/GOOGLE-SETUP.md)."); process.exit(1); }

const { verifier, challenge } = pkcePair();
const state = randomBytes(16).toString("hex");

const server = createServer();
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;

const code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Timed out after 5 minutes.")), 300_000);
  server.on("request", (req, res) => {
    const u = new URL(req.url ?? "/", redirectUri);
    if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
    const done = (status: number, message: string, err?: Error, c?: string) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(message);
      clearTimeout(timer);
      if (err) reject(err); else resolve(c!);
    };
    if (u.searchParams.get("state") !== state) return done(400, "State did not match. Close this tab and run the command again.", new Error("State mismatch."));
    if (u.searchParams.get("error")) return done(400, "Access was not granted.", new Error(`Google said: ${u.searchParams.get("error")}`));
    const c = u.searchParams.get("code");
    if (!c) return done(400, "No code. Close this tab and run the command again.", new Error("No code returned."));
    done(200, "Done. You can close this tab and go back to the terminal.", undefined, c);
  });
  console.log("Open this link in your browser and sign in with the Google account that should own the Sheets:\n");
  const link = consentUrl({ clientId, redirectUri, state, challenge });
  console.log(link);
  if (process.platform === "darwin") execFile("open", [link], () => {});
  console.log("\nWaiting for Google to send you back...");
}).finally(() => server.close());

const refresh = await exchangeCode({ clientId, clientSecret, code, verifier, redirectUri });
saveSecret(out, refresh);
console.log(`Saved the refresh token to ${out} (readable by you only). It was not printed. Put its contents in GOOGLE_OAUTH_REFRESH_TOKEN, then delete the file.`);
