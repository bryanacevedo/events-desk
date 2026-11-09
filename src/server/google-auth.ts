/* The pieces of the one-time Google consent flow that can be tested without a
   browser. scripts/google-auth.ts wires them to a loopback web server.
   The refresh token is written to a file the user names, mode 600, and is never
   printed. Scope is drive.file: files this app creates, nothing else in the Drive. */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { OAUTH_SCOPE } from "./sheets.ts";

export const pkcePair = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

export function consentUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string }) {
  const q = new URLSearchParams({
    client_id: o.clientId, redirect_uri: o.redirectUri, response_type: "code", scope: OAUTH_SCOPE,
    access_type: "offline", prompt: "consent", state: o.state, code_challenge: o.challenge, code_challenge_method: "S256",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function exchangeCode(o: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string; fetch?: typeof fetch }) {
  const res = await (o.fetch ?? fetch)("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: o.code, code_verifier: o.verifier, redirect_uri: o.redirectUri, client_id: o.clientId, client_secret: o.clientSecret }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google refused the code (${res.status}): ${String(body.error_description ?? body.error ?? "no detail").slice(0, 160)}`);
  if (typeof body.refresh_token !== "string" || !body.refresh_token) throw new Error("Google returned no refresh token. Remove this app from https://myaccount.google.com/permissions and run the consent again.");
  return body.refresh_token as string;
}

/** Creates the file readable by its owner only. Never overwrites an existing file. */
export function saveSecret(file: string, value: string) {
  if (existsSync(file)) throw new Error(`${file} already exists. Choose a new file name or delete it first.`);
  writeFileSync(file, `${value}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
}
