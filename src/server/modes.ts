/* Decides whether this process may spend real money. `--demo` always wins: an
   exported DATABASE_URL, vendor key or model key can never make a demo touch a
   real database or spend a real credit. Live spend needs every key, a real
   database, the signed Slack route and an approver list, or it refuses to start. */

export interface Mode {
  demo: boolean;
  liveSpend: boolean;
  databaseUrl?: string;
}

export const LIVE_REQUIRED = [
  "DATABASE_URL", "SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "SLACK_APPROVALS_CHANNEL", "APPROVER_SLACK_IDS",
  "SLACK_USER_MAP", "ANTHROPIC_API_KEY", "APOLLO_API_KEY", "ZEROBOUNCE_API_KEY",
] as const;

/** Delivery to a Google Sheet needs one complete sign-in: a service account, or an OAuth user. */
export const GOOGLE_SIGN_INS = {
  service_account: ["GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_DRIVE_FOLDER_ID", "GOOGLE_SHARE_DOMAIN"],
  oauth: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_OAUTH_REFRESH_TOKEN"],
} as const;

/** SLACK_USER_MAP is JSON: {"Maya Ortiz": "U01ABC", ...}. A cost card is confirmed by the person who uploaded the list, and in live mode the Slack user is the proof of who that is. */
export function parseUserMap(raw: string | undefined): Record<string, string> {
  let j: unknown;
  try { j = JSON.parse(raw ?? ""); } catch { throw new Error("it is not valid JSON."); }
  if (!j || typeof j !== "object" || Array.isArray(j) || !Object.keys(j).length) throw new Error('it must be a JSON object such as {"Maya Ortiz": "U01ABC"}.');
  for (const [name, id] of Object.entries(j)) if (!name.trim() || typeof id !== "string" || !/^[UW][A-Z0-9]{2,}$/.test(id)) throw new Error(`"${name}" needs a Slack user ID such as U01ABC.`);
  return j as Record<string, string>;
}
const userMapError = (raw: string | undefined) => { try { parseUserMap(raw); return ""; } catch (e) { return (e as Error).message; } };

export function resolveMode(argv: string[], env: Record<string, string | undefined>): Mode {
  if (argv.includes("--demo")) return { demo: true, liveSpend: false };
  const liveSpend = env.LIVE_SPEND === "1";
  if (liveSpend) {
    const missing = LIVE_REQUIRED.filter((k) => !env[k]?.trim());
    if (missing.length) throw new Error(`LIVE_SPEND=1 needs ${missing.join(", ")}. Refusing to start.`);
    const bad = userMapError(env.SLACK_USER_MAP);
    if (bad) throw new Error(`LIVE_SPEND=1 needs SLACK_USER_MAP: ${bad} Refusing to start.`);
    if (!Object.values(GOOGLE_SIGN_INS).some((keys) => keys.every((k) => env[k]?.trim()))) {
      throw new Error(`LIVE_SPEND=1 needs a complete Google sign-in: ${GOOGLE_SIGN_INS.service_account.join(", ")} or ${GOOGLE_SIGN_INS.oauth.join(", ")}. Refusing to start.`);
    }
  }
  return { demo: false, liveSpend, databaseUrl: env.DATABASE_URL };
}
