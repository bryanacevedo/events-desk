/* A company's name as people write it. Attendee files arrive in capitals ("CEDARHOLLOW SYSTEMS") or lower case ("elmhaven cargo");
   the desk shows "Cedarhollow Systems" and "Elmhaven Cargo". Mixed-case names are someone's choice and are left alone, as are
   short acronyms and legal forms. The raw row keeps what was typed. */

const KEEP = new Set(["AI", "AB", "AG", "AS", "BV", "CO", "GMBH", "HQ", "IT", "LLC", "LLP", "LTD", "NV", "OY", "PLC", "SA", "SAS", "SE", "SL", "SPA", "SRL", "UK", "US", "USA"]);
const FORMS: Record<string, string> = { GMBH: "GmbH", LTD: "Ltd", CO: "Co", SPA: "SpA", SRL: "Srl", SAS: "SAS" };

export function companyDisplayName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  const letters = name.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4) return name;
  const upper = letters === letters.toUpperCase(), lower = letters === letters.toLowerCase();
  if (!upper && !lower) return name;
  return name.split(" ").map((w) => {
    const bare = w.replace(/[^A-Za-z]/g, "").toUpperCase();
    if (FORMS[bare]) return w.replace(/[A-Za-z]+/, FORMS[bare]);
    if (KEEP.has(bare) || (upper && bare.length <= 2)) return w.toUpperCase();
    return w.toLowerCase().replace(/(^|[-'&/(])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());
  }).join(" ");
}

/** A deal's name without the account it already sits under: "Frostworth Software platform pilot" at Frostworth Software reads
    "Platform pilot". Display only, first letter capitalised; the CRM's name is left as it is. */
export function dealDisplayName(name: string | null | undefined, account: string | null | undefined): string | null {
  if (!name) return null;
  let n = name.trim();
  if (account) {
    const a = account.trim().toLowerCase();
    if (n.toLowerCase().startsWith(a)) n = n.slice(a.length).replace(/^[\s:\-–|·,]+/, "");
  }
  if (!n) return null;
  return n[0].toUpperCase() + n.slice(1);
}
