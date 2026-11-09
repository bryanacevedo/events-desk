import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { consentUrl, exchangeCode, pkcePair, saveSecret } from "../src/server/google-auth.ts";
import { GOOGLE_SIGN_INS, LIVE_REQUIRED, resolveMode } from "../src/server/modes.ts";
import { publishSample, SAMPLE_TITLE } from "../src/server/publish-sample.ts";
import { googleOptionsFromEnv, googleSheetsClient, mockSheets, sheetsFor } from "../src/server/sheets.ts";

/** A fake Drive that keeps files by name and records every call. */
function fakeDrive() {
  const calls: { url: string; method: string; body: string }[] = [];
  const files = new Map<string, string>(); // id -> name
  const perms: { id: string; body: any }[] = [];
  const batches: any[][] = [];
  const fetchFn = (async (input: any, init: any = {}) => {
    const url = String(input), method = init.method ?? "GET";
    const text = init.body instanceof Uint8Array ? Buffer.from(init.body).toString("latin1") : String(init.body ?? "");
    calls.push({ url, method, body: text.length < 4000 ? text : "<binary>" });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (url === "https://oauth2.googleapis.com/token") {
      const f = new URLSearchParams(text);
      if (f.get("grant_type") !== "refresh_token" || f.get("refresh_token") !== "rt" || f.get("client_id") !== "cid" || f.get("client_secret") !== "sec") return json({ error: "invalid_grant" }, 400);
      return json({ access_token: "tok", expires_in: 3600 });
    }
    expect(init.headers.authorization).toBe("Bearer tok");
    if (url.includes("/upload/drive/v3/files") && method === "POST") {
      const name = JSON.parse(text.match(/\r\n\r\n(\{.*?\})\r\n--/s)![1]).name; const id = `f${files.size + 1}`; files.set(id, name); return json({ id });
    }
    if (url.includes("/upload/drive/v3/files/") && method === "PATCH") return json({ id: decodeURIComponent(url.split("/files/")[1].split("?")[0]) });
    if (url.startsWith("https://www.googleapis.com/drive/v3/files?q=")) {
      const q = decodeURIComponent(url.split("q=")[1].split("&")[0]);
      const hit = [...files].find(([, n]) => q.includes(`name = '${n}'`));
      return json({ files: hit ? [{ id: hit[0] }] : [] });
    }
    if (url.includes("/permissions")) { perms.push({ id: decodeURIComponent(url.split("/files/")[1].split("/")[0]), body: JSON.parse(text) }); return json({ id: "p" }); }
    if (url.startsWith("https://sheets.googleapis.com/")) {
      if (url.includes(":batchUpdate")) { batches.push(JSON.parse(text).requests); return json({ replies: [] }); }
      if (url.includes("fields=")) return json({ sheets: ["Summary", "Review", "Attendees", "Prospects", "Companies", "Other attendees", "Meetings", "Lists"].map((title, i) => ({ properties: { sheetId: i, title } })) });
      return json({ values: [["case_id"], ["x"]] });
    }
    return json({ error: { message: "unexpected" } }, 404);
  }) as typeof fetch;
  return { fetch: fetchFn, calls, files, perms, batches };
}
const oauth = { clientId: "cid", clientSecret: "sec", refreshToken: "rt" };

describe("OAuth user sign-in", () => {
  it("refreshes a token, creates the Sheet in the user's own Drive and shares only the listed addresses as writers", async () => {
    const d = fakeDrive();
    const { publisher } = googleSheetsClient({ oauth, shareEmails: ["Ana@Gmail.com", "bo@gmail.com"], fetch: d.fetch });
    const { id } = await publisher.create(new Uint8Array([1, 2, 3]), "T list");
    await publisher.share(id);
    const up = d.calls.find((c) => c.url.includes("/upload/"))!;
    expect(up.url).toContain("supportsAllDrives=true");
    expect(up.body).toContain('"name":"T list"');
    expect(up.body).toContain('"mimeType":"application/vnd.google-apps.spreadsheet"');
    expect(up.body).not.toContain("parents");
    expect(d.perms.map((p) => p.body)).toEqual([{ type: "user", role: "writer", emailAddress: "ana@gmail.com" }, { type: "user", role: "writer", emailAddress: "bo@gmail.com" }]);
    expect(JSON.stringify(d.perms)).not.toMatch(/anyone|domain/i);
    expect(await publisher.readReview(id)).toEqual([["case_id"], ["x"]]);
  });
  it("without GOOGLE_SHARE_EMAILS the file stays private: no permission call at all", async () => {
    const d = fakeDrive();
    const { publisher } = googleSheetsClient({ oauth, fetch: d.fetch });
    await publisher.share((await publisher.create(new Uint8Array([1]), "T")).id);
    expect(d.perms).toEqual([]);
  });
  it("sends no parent when no folder is given, and a parent when one is", async () => {
    const d = fakeDrive();
    await googleSheetsClient({ oauth, fetch: d.fetch }).publisher.create(new Uint8Array([1]), "A");
    await googleSheetsClient({ oauth, folderId: "fold", fetch: d.fetch }).publisher.create(new Uint8Array([1]), "B");
    const bodies = d.calls.filter((c) => c.url.includes("/upload/")).map((c) => c.body);
    expect(bodies[0]).not.toContain("parents");
    expect(bodies[1]).toContain('"parents":["fold"]');
  });
  it("refuses bad addresses, a missing token, and two sign-ins at once", () => {
    expect(() => googleSheetsClient({ oauth, shareEmails: ["not an email"] })).toThrow(/not an email address/);
    expect(() => googleSheetsClient({ oauth: { ...oauth, refreshToken: " " } })).toThrow(/needed/);
    expect(() => googleSheetsClient({ oauth, account: { client_email: "a@b.c", private_key: "-----BEGIN PRIVATE KEY-----" }, shareDomain: "example.com", folderId: "f" })).toThrow(/exactly one/i);
    expect(() => googleSheetsClient({})).toThrow(/exactly one/i);
  });
  it("picks the sign-in from the environment and refuses an ambiguous or empty one", () => {
    const o = { GOOGLE_OAUTH_CLIENT_ID: "cid", GOOGLE_OAUTH_CLIENT_SECRET: "sec", GOOGLE_OAUTH_REFRESH_TOKEN: "rt", GOOGLE_SHARE_EMAILS: "a@x.com, b@x.com" };
    expect(googleOptionsFromEnv(o).shareEmails).toEqual(["a@x.com", "b@x.com"]);
    expect(() => googleOptionsFromEnv({ ...o, GOOGLE_SERVICE_ACCOUNT_JSON: "{}", GOOGLE_DRIVE_FOLDER_ID: "f", GOOGLE_SHARE_DOMAIN: "example.com" })).toThrow(/Both Google sign-ins/);
    expect(() => googleOptionsFromEnv({})).toThrow(/needs either/);
    expect(() => googleOptionsFromEnv({ ...o, GOOGLE_SHARE_EMAILS: "a@x.com, nope" })).toThrow(/GOOGLE_SHARE_EMAILS/);
    expect(sheetsFor(false, o)).toBe(mockSheets);
    expect(sheetsFor(true, o).enabled).toBe(true);
  });
  it("live mode accepts either complete sign-in and refuses neither", () => {
    const base = { ...Object.fromEntries(LIVE_REQUIRED.map((k) => [k, "x"])), SLACK_USER_MAP: '{"Maya Ortiz":"U01ABC"}' };
    const set = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, "x"]));
    expect(resolveMode([], { ...base, ...set(GOOGLE_SIGN_INS.oauth), LIVE_SPEND: "1" }).liveSpend).toBe(true);
    expect(resolveMode([], { ...base, ...set(GOOGLE_SIGN_INS.service_account), LIVE_SPEND: "1" }).liveSpend).toBe(true);
    expect(() => resolveMode([], { ...base, LIVE_SPEND: "1" })).toThrow(/complete Google sign-in/);
    expect(() => resolveMode([], { ...base, GOOGLE_OAUTH_CLIENT_ID: "x", GOOGLE_OAUTH_CLIENT_SECRET: "x", LIVE_SPEND: "1" })).toThrow(/complete Google sign-in/);
  });
});

describe("publishing the sample", () => {
  it("creates the Sheet privately, then updates the same file so the link stays stable", async () => {
    const d = fakeDrive();
    const g = googleSheetsClient({ oauth, fetch: d.fetch });
    const first = await publishSample(g);
    expect(first).toMatchObject({ created: true, view: "private" });
    expect(d.files.get(first.id)).toBe(SAMPLE_TITLE);
    const second = await publishSample(g);
    expect(second).toMatchObject({ created: false, id: first.id, url: first.url });
    expect(d.files.size).toBe(1);
    expect(d.calls.some((c) => c.method === "PATCH")).toBe(true);
    expect(d.perms).toEqual([]);
    // The Google layer runs after the create and again after the update, from the plan written beside the sample.
    expect(d.batches.length).toBeGreaterThanOrEqual(6);
    expect(second.polish.failed).toEqual([]);
    expect(second.polish.applied).toEqual(expect.arrayContaining(["look", "controls", "views", "summary"]));
  });
  it("only --public-view makes it viewable by anyone, as a reader", async () => {
    const d = fakeDrive();
    await publishSample(googleSheetsClient({ oauth, fetch: d.fetch }), { publicView: true });
    expect(d.perms.map((p) => p.body)).toEqual([{ type: "anyone", role: "reader", allowFileDiscovery: false }]);
  });
  it("cannot be used on event data: the public option is not on the publisher, and no delivery code mentions it", () => {
    const g = googleSheetsClient({ oauth, fetch: fakeDrive().fetch });
    expect(Object.keys(g.publisher)).not.toContain("publicView");
    for (const f of ["sheet-delivery.ts", "app.ts", "pipeline.ts", "node.ts", "workbook.ts"]) {
      const src = readFileSync(`src/server/${f}`, "utf8");
      expect(src, f).not.toMatch(/publicView|"anyone"|publishSample/);
    }
    // The sample publisher takes no bytes and no path.
    expect(readFileSync("src/server/publish-sample.ts", "utf8")).toMatch(/SAMPLE_PATH/);
    expect(readFileSync("scripts/publish-sample.ts", "utf8")).toMatch(/Unknown argument/);
  });
});

describe("the consent helpers", () => {
  it("asks for drive.file only, offline, with PKCE", () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    const u = new URL(consentUrl({ clientId: "cid", redirectUri: "http://127.0.0.1:5000/callback", state: "s", challenge }));
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });
  it("exchanges the code and fails clearly with no refresh token", async () => {
    const ok = (async () => new Response(JSON.stringify({ refresh_token: "r1", access_token: "a" }))) as typeof fetch;
    expect(await exchangeCode({ clientId: "c", clientSecret: "s", code: "x", verifier: "v", redirectUri: "r", fetch: ok })).toBe("r1");
    const none = (async () => new Response(JSON.stringify({ access_token: "a" }))) as typeof fetch;
    await expect(exchangeCode({ clientId: "c", clientSecret: "s", code: "x", verifier: "v", redirectUri: "r", fetch: none })).rejects.toThrow(/no refresh token/);
    const bad = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    await expect(exchangeCode({ clientId: "c", clientSecret: "s", code: "x", verifier: "v", redirectUri: "r", fetch: bad })).rejects.toThrow(/invalid_grant/);
  });
  it("writes the secret to a file only the owner can read, never overwrites, and the script never prints it", () => {
    const file = join(mkdtempSync(join(tmpdir(), "gauth-")), "token");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    saveSecret(file, "super-secret");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe("super-secret");
    expect(() => saveSecret(file, "other")).toThrow(/already exists/);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
    const script = readFileSync("scripts/google-auth.ts", "utf8");
    expect(script).not.toMatch(/console\.\w+\(\s*refresh\b/);
  });
});
