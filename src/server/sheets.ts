/* The seam to Google Sheets: put the delivered workbook where the team can open it
   by link, and read the Review tab back. Same pattern as the other providers.

   - mock:   used in the demo and whenever spend is off. It is disabled, calls nothing
             and returns no link, so the desk offers the file download instead.
   - google: live mode only, with one of two sign-ins.
             Service account: uploads to a folder in a Shared Drive and shares with one company
             domain as writers.
             OAuth user: a refresh token for one person's own Google account (scope drive.file,
             the narrowest that works). The file is created in that person's Drive and shared
             only with the addresses in GOOGLE_SHARE_EMAILS, as writers; with none it stays
             private to the owner.
             Neither ever shares with "anyone": the file holds personal contact data.

   `fetch` and the credentials are injected, so tests never touch the network. */

import { createSign } from "node:crypto";
import { polishRequests, SHEET_FIELDS, sheetRefs, type PolishResult, type SheetPlan } from "./sheets-polish.ts";

export interface SheetPublisher {
  name: string;
  /** False means the desk offers the download only. */
  enabled: boolean;
  /** Uploads the workbook and converts it to a Sheet. Returns its Drive file id. */
  create(xlsx: Uint8Array, title: string): Promise<{ id: string }>;
  /** Gives the company domain edit access. Safe to repeat. */
  share(id: string): Promise<void>;
  /** A file this process created earlier with this exact name, or null. Used to update in place. */
  find(title: string): Promise<{ id: string } | null>;
  /** Replaces the contents of a file this process created, keeping its link. */
  update(id: string, xlsx: Uint8Array): Promise<void>;
  /** The Review tab as text, one array per row, ragged like the Sheets API returns it. */
  readReview(id: string): Promise<string[][]>;
  /** Any tab as text, one array per row. A refresh reads what people typed before it replaces the file. */
  readTab(id: string, title: string): Promise<string[][]>;
  /** The Google-native layer (sheets-polish.ts), after create or update. Never throws for a refused batch: each is named in `failed`, and the caller logs it. */
  polish(id: string, plan: SheetPlan): Promise<PolishResult>;
}

export const mockSheets: SheetPublisher = {
  name: "sheets_mock", enabled: false,
  async create() { throw new Error("The mock Sheet publisher cannot create files."); },
  async share() { throw new Error("The mock Sheet publisher cannot share files."); },
  async find() { throw new Error("The mock Sheet publisher cannot search files."); },
  async update() { throw new Error("The mock Sheet publisher cannot update files."); },
  async readReview() { throw new Error("The mock Sheet publisher cannot read files."); },
  async readTab() { throw new Error("The mock Sheet publisher cannot read files."); },
  async polish() { throw new Error("The mock Sheet publisher cannot polish files."); },
};

/** The link is built from the id, never taken from a response. */
export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;

export class GoogleError extends Error {}

export interface ServiceAccount { client_email: string; private_key: string }

export function parseServiceAccount(json: string): ServiceAccount {
  let o: any;
  try { o = JSON.parse(json); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON."); }
  if (typeof o?.client_email !== "string" || typeof o?.private_key !== "string" || !o.client_email || !o.private_key.includes("PRIVATE KEY")) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON needs client_email and private_key.");
  }
  // A key pasted through an env file often keeps literal \n sequences.
  return { client_email: o.client_email, private_key: o.private_key.replace(/\\n/g, "\n") };
}

export interface OAuthUser { clientId: string; clientSecret: string; refreshToken: string }

export interface GoogleOptions {
  /** Exactly one of account or oauth. */
  account?: ServiceAccount;
  oauth?: OAuthUser;
  /** Required with a service account. Optional with OAuth (drive.file only sees folders this app made). */
  folderId?: string;
  /** Service account sharing: one plain domain, as writers. */
  shareDomain?: string;
  /** OAuth sharing: these addresses, as writers. Empty means private to the owner. */
  shareEmails?: string[];
  fetch?: typeof fetch;
  now?: () => number;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SA_SCOPE = "https://www.googleapis.com/auth/drive";
/** The narrowest scope that creates files and reads back the ones this app created. */
export const OAUTH_SCOPE = "https://www.googleapis.com/auth/drive.file";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SHEET = "application/vnd.google-apps.spreadsheet";
const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const EMAIL = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function parseEmails(raw: string | undefined): string[] {
  const list = (raw ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const e of list) if (!EMAIL.test(e)) throw new Error(`GOOGLE_SHARE_EMAILS has an entry that is not an email address: ${e.slice(0, 40)}`);
  return [...new Set(list)];
}

export interface GoogleSheets {
  publisher: SheetPublisher;
  /** View-only for anyone with the link. Not part of SheetPublisher on purpose: only the sample publisher may call it. */
  publicView(id: string): Promise<void>;
}

export function googleSheetsClient(o: GoogleOptions): GoogleSheets {
  if (!!o.account === !!o.oauth) throw new Error("Use exactly one Google sign-in: a service account or OAuth user credentials.");
  const domain = (o.shareDomain ?? "").trim().toLowerCase().replace(/^@/, "");
  const emails = (o.shareEmails ?? []).map((e) => e.trim().toLowerCase());
  const folder = (o.folderId ?? "").trim();
  if (o.account) {
    // A domain permission is the widest this module can ever grant. Refuse anything that is not a plain domain.
    if (!DOMAIN.test(domain)) throw new Error("GOOGLE_SHARE_DOMAIN must be a domain such as example.com.");
    if (!folder) throw new Error("GOOGLE_DRIVE_FOLDER_ID is empty.");
  } else {
    for (const e of emails) if (!EMAIL.test(e)) throw new Error(`GOOGLE_SHARE_EMAILS has an entry that is not an email address: ${e.slice(0, 40)}`);
    if (!o.oauth!.clientId.trim() || !o.oauth!.clientSecret.trim() || !o.oauth!.refreshToken.trim()) throw new Error("The OAuth client id, client secret and refresh token are all needed.");
  }
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  let token: { value: string; until: number } | null = null;

  async function bearer() {
    if (token && token.until > now() + 60_000) return token.value;
    let form: URLSearchParams;
    if (o.account) {
      const iat = Math.floor(now() / 1000);
      const unsigned = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iss: o.account.client_email, scope: SA_SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }))}`;
      const sig = createSign("RSA-SHA256").update(unsigned).sign(o.account.private_key);
      form = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64(sig)}` });
    } else {
      form = new URLSearchParams({ grant_type: "refresh_token", client_id: o.oauth!.clientId, client_secret: o.oauth!.clientSecret, refresh_token: o.oauth!.refreshToken });
    }
    const res = await doFetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof body.access_token !== "string") throw new GoogleError(`Google sign-in failed (${res.status}): ${String(body.error_description ?? body.error ?? "no token").slice(0, 160)}`);
    token = { value: body.access_token, until: now() + Number(body.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  async function call(url: string, init: RequestInit): Promise<any> {
    const res = await doFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${await bearer()}` } });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoogleError(`Google answered ${res.status}: ${String(body?.error?.message ?? "no detail").slice(0, 200)}`);
    return body;
  }

  function multipart(meta: object, xlsx: Uint8Array) {
    const boundary = `desk_${now()}_${Math.random().toString(36).slice(2)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${XLSX}\r\n\r\n`),
      Buffer.from(xlsx), Buffer.from(`\r\n--${boundary}--`),
    ]);
    return { headers: { "content-type": `multipart/related; boundary=${boundary}` }, body: new Uint8Array(body) };
  }
  const grant = (id: string, body: object) =>
    call(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/permissions?supportsAllDrives=true`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const publisher: SheetPublisher = {
    name: "sheets_google", enabled: true,
    async create(xlsx, title) {
      const meta: Record<string, unknown> = { name: title, mimeType: SHEET };
      if (folder) meta.parents = [folder];
      const f = await call("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id", { method: "POST", ...multipart(meta, xlsx) });
      if (typeof f.id !== "string" || !f.id) throw new GoogleError("Google created the file but returned no id.");
      return { id: f.id };
    },
    async update(id, xlsx) {
      // Converting on update replaces the whole Sheet and keeps its id, so the link stays the same.
      await call(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=multipart&supportsAllDrives=true&fields=id`, { method: "PATCH", ...multipart({ mimeType: SHEET }, xlsx) });
    },
    async find(title) {
      const q = [`name = '${title.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`, "trashed = false", `mimeType = '${SHEET}'`, ...(folder ? [`'${folder.replace(/'/g, "")}' in parents`] : [])].join(" and ");
      const extra = o.account ? "&includeItemsFromAllDrives=true&corpora=allDrives" : "";
      const r = await call(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id)")}&pageSize=1&supportsAllDrives=true${extra}`, { method: "GET" });
      const id = Array.isArray(r.files) ? r.files[0]?.id : null;
      return typeof id === "string" && id ? { id } : null;
    },
    async share(id) {
      // Writers, because reps edit the file. Never type "anyone".
      if (o.account) await grant(id, { type: "domain", role: "writer", domain, allowFileDiscovery: false });
      else for (const emailAddress of emails) await grant(id, { type: "user", role: "writer", emailAddress });
    },
    readReview(id) { return publisher.readTab(id, "Review"); },
    async readTab(id, title) {
      const r = await call(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${encodeURIComponent(title)}?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE`, { method: "GET" });
      return Array.isArray(r.values) ? r.values.map((row: unknown) => (Array.isArray(row) ? row.map((c) => String(c ?? "")) : [])) : [];
    },
    async polish(id, plan) {
      // The converted Sheet's tab ids are only known after the upload, so they are read first; the requests are then built from the plan and sent one named batch at a time.
      const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}`;
      const out: PolishResult = { applied: [], failed: [] };
      let batches;
      try { batches = polishRequests(plan, sheetRefs(await call(`${base}?fields=${encodeURIComponent(SHEET_FIELDS)}`, { method: "GET" }))); }
      catch (e) { out.failed.push({ name: "sheets", error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }); return out; }
      for (const b of batches) {
        try { await call(`${base}:batchUpdate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests: b.requests, includeSpreadsheetInResponse: false }) }); out.applied.push(b.name); }
        catch (e) { out.failed.push({ name: b.name, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) }); }
      }
      return out;
    },
  };
  return { publisher, publicView: (id) => grant(id, { type: "anyone", role: "reader", allowFileDiscovery: false }).then(() => undefined) };
}

export const googleSheets = (o: GoogleOptions): SheetPublisher => googleSheetsClient(o).publisher;

/** Which sign-in the environment describes. Two complete sets at once is refused as ambiguous. */
export function googleOptionsFromEnv(env: Record<string, string | undefined>, f?: typeof fetch): GoogleOptions {
  const has = (k: string) => !!env[k]?.trim();
  const sa = has("GOOGLE_SERVICE_ACCOUNT_JSON") && has("GOOGLE_DRIVE_FOLDER_ID") && has("GOOGLE_SHARE_DOMAIN");
  const oauth = has("GOOGLE_OAUTH_CLIENT_ID") && has("GOOGLE_OAUTH_CLIENT_SECRET") && has("GOOGLE_OAUTH_REFRESH_TOKEN");
  if (sa && oauth) throw new Error("Both Google sign-ins are set. Keep either the service account variables or the GOOGLE_OAUTH_ variables, not both.");
  if (oauth) return { oauth: { clientId: env.GOOGLE_OAUTH_CLIENT_ID!, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET!, refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN! }, shareEmails: parseEmails(env.GOOGLE_SHARE_EMAILS), folderId: env.GOOGLE_DRIVE_FOLDER_ID, fetch: f };
  if (sa) return { account: parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT_JSON!), folderId: env.GOOGLE_DRIVE_FOLDER_ID, shareDomain: env.GOOGLE_SHARE_DOMAIN, fetch: f };
  throw new Error("Google needs either GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_DRIVE_FOLDER_ID and GOOGLE_SHARE_DOMAIN, or GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REFRESH_TOKEN.");
}

/** The publisher for this process. Google only in live mode with a complete sign-in. */
export function sheetsFor(liveSpend: boolean, env: Record<string, string | undefined>, f?: typeof fetch): SheetPublisher {
  if (!liveSpend) return mockSheets;
  return googleSheets(googleOptionsFromEnv(env, f));
}
