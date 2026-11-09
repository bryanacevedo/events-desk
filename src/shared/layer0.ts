/* Layer 0: distrust the input. Every value from an uploaded file is a claim, and
   this file is the code-only part of checking it. Nothing here calls a vendor or a
   model, so it can run before any approval. The rules follow the table in
   docs/TIERING-AND-ENRICHMENT.md, "Layer 0".

   The rule for every check is the same: act only when certain. A doubtful value is
   left alone and judged later, in Research. */

export const ascii = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ø/gi, "o").replace(/ł/gi, "l").replace(/ß/g, "ss").replace(/æ/gi, "ae").replace(/đ/gi, "d").replace(/ı/g, "i");
const words = (s: string) => ascii(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
/** Tokens in sorted order, so "Reddy Karthik" and "Karthik Reddy" are one person. */
export const nameSet = (s: string) => words(s).sort().join(" ");

/* ------------------------------------------------------------ configured lists */

/** Domains no real company uses. A work address here is a stand-in, so it is discarded and the row goes on. */
export const PLACEHOLDER_DOMAINS = [
  "test.com", "company.com", "none.com", "asdf.com", "example.com", "example.org", "example.net", "domain.com", "email.com",
  "yourcompany.com", "yourdomain.com", "sample.com", "noemail.com", "nomail.com", "nodomain.com", "na.com", "abc.com", "xyz.com",
  "tbd.com", "mydomain.com", "website.com", "companyname.com", "localhost",
];

export const FREE_WEBMAIL = [
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.es", "yahoo.fr", "yahoo.com.br", "ymail.com", "hotmail.com", "hotmail.co.uk",
  "hotmail.es", "hotmail.fr", "outlook.com", "outlook.es", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com", "zoho.com", "yandex.com", "yandex.ru", "mail.ru", "qq.com",
  "163.com", "126.com", "hey.com", "fastmail.com", "tutanota.com", "orange.fr", "free.fr", "wanadoo.fr", "t-online.de", "libero.it", "bol.com.br",
  "uol.com.br", "terra.com.br", "rediffmail.com", "naver.com",
];

/** Values that mean "nothing here" whatever field they are in. Compared after lowercasing and stripping punctuation. */
const FILLER = new Set([
  "", "na", "n a", "nan", "none", "null", "nil", "undefined", "unknown", "tbd", "tba", "no", "nothing", "not applicable", "no company", "no email",
  "no aplica", "ninguno", "ninguna", "sin empresa", "n d", "xx", "test", "testing", "asdf", "n/a", "pending", "empty", "blank", "dummy",
]);
const DASHES = /^[\s\-\u2013\u2014_.,;:?*#/\\|]*$/;

const flat = (t: string) => ascii(t).toLowerCase().replace(/[.\-_/]+/g, " ").replace(/\s+/g, " ").trim();
export const isFiller = (raw: string) => DASHES.test(raw.trim()) || FILLER.has(flat(raw));
/** Names are stricter: "Na" and "No" are real surnames, so only a dash or an unmistakable placeholder blanks a name. */
const NAME_FILLER = new Set(["none", "null", "nil", "nan", "undefined", "unknown", "tbd", "tba", "test", "testing", "n a", "n d", "asdf"]);
export const isNameFiller = (raw: string) => DASHES.test(raw.trim()) || NAME_FILLER.has(flat(raw));

/** Names of people who are not at a company. Dropped as not_a_company. */
const NOT_A_COMPANY = new Set([
  "student", "students", "estudiante", "etudiant", "studentin", "press", "prensa", "presse", "imprensa", "media", "journalist", "reporter", "blogger",
  "self employed", "selfemployed", "self employed consultant", "freelance", "freelancer", "free lance", "independent", "independent consultant", "independiente",
  "own business", "my own business", "my business", "autonomo", "autonomo a", "trabajador independiente", "independant", "independante", "selbststandig",
  "selbstandig", "zelfstandig", "unemployed", "retired", "jubilado", "private", "personal", "individual", "home", "myself", "me", "n a freelance",
]);
const INSTITUTION = new Set(["university", "universidad", "universite", "universitat", "universita", "universidade", "hochschule", "politecnico", "politecnica", "universiteit"]);
const PRESS = new Set(["courier", "gazette", "weekly", "magazine", "revista", "radio", "newspaper", "daily", "herald", "tribune", "zeitung", "periodico", "noticias"]);
/** Titles that, with a matching company, say the person is a student, a journalist or self-employed. */
const OUTSIDE_TITLE = /\b(students?|phd|candidate|undergraduate|postgraduate|graduate student|journalists?|reporters?|correspondents?|columnists?|bloggers?|editors?|writers?|photographers?|freelanc\w*|estudiante|periodista|presse|etudiant)\b/i;

/* ------------------------------------------------------------------ titles */

const HEAD = new Set(("manager director officer engineer analyst specialist representative rep executive assistant head vp svp evp avp vice president founder cofounder ceo cfo cto coo cmo cro cso chief " +
  "consultant coordinator supervisor administrator recruiter designer accountant scientist counsel lead partner associate agent developer architect advisor adviser owner controller paralegal intern " +
  "strategist planner buyer clerk technician receptionist secretary auditor operator programmer researcher trainer professor lawyer attorney " +
  "gerente directora jefe jefa ejecutivo ejecutiva responsable analista asistente coordinador coordinadora ingeniero ingeniera contador contadora abogado abogada " +
  "diretor diretora assistente engenheiro charge directeur directrice comptable fondateur fondatrice pdg leiter leiterin geschaftsfuhrer berater sachbearbeiter ingenieur " +
  "socio propietario presidente vicepresidente administrativo administrativa").split(" "));
const FUNCTION = new Set(("sales marketing revenue operations growth business development product customer success support channel partnerships partnership commercial regional global senior junior sr jr " +
  "staff principal general managing account key inside outside field enterprise strategic technical digital data software hr human resources people talent acquisition finance financial legal security " +
  "quality research procurement supply chain logistics warehouse payroll it ux qa devops graphic creative content brand communications community demand generation enablement solutions " +
  "of and de del la el los las y e et der die und the for to in at ventas cuentas clave comercial recursos humanos almacen almacén almoxarifado vendas contas comercial " +
  "ventes compte marketing leiter vertrieb corporate culture first impressions customer service executive operaciones operacoes").split(" "));

/** True when every word is a title word and at least one is a head word ("Senior Channel Manager"). A company named "Partners Group" is not: plurals are not head words. */
export function looksLikeTitle(raw: string) {
  const w = words(raw);
  if (!w.length || w.length > 8) return false;
  return w.every((x) => HEAD.has(x) || FUNCTION.has(x)) && w.some((x) => HEAD.has(x));
}

/* ----------------------------------------------------------- junk and filler */

const KEY_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const KEY_SUBSTRINGS = (() => {
  const out = new Set<string>();
  for (const r of KEY_ROWS) for (const s of [r, [...r].reverse().join("")]) for (let i = 0; i < s.length; i++) for (let j = i + 3; j <= s.length; j++) out.add(s.slice(i, j));
  return out;
})();

/** One word of keyboard mashing: a letter repeated, or a run along a keyboard row. Needs three letters, so "Ng" and "Li" are safe. */
export function isMashToken(tok: string) {
  const t = ascii(tok).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (t.length < 3) return false;
  if (/^(.)\1{2,}$/.test(t)) return true;
  return KEY_SUBSTRINGS.has(t);
}

/** Short all-capital names are real: KPMG, HSBC, DHL, AAA. They are never treated as junk, whatever letters they hold. */
export const isShortCaps = (raw: string) => /^[A-Z]{2,5}$/.test(raw.trim());

/** Certain keyboard mashing: every word is mash, and the value is not a short all-capital name. */
export function isMash(raw: string) {
  const v = raw.trim();
  if (!v || isShortCaps(v)) return false;
  const toks = v.split(/[\s,;/&+-]+/).filter(Boolean);
  const letters = toks.filter((t) => /[\p{L}]/u.test(t));
  return letters.length > 0 && letters.every(isMashToken);
}

/* ------------------------------------------------------------------- emails */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const emailDomain = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();
export const registrable = (host: string) => {
  const h = host.toLowerCase().replace(/^www\./, "");
  const p = h.split(".");
  // Two-part public suffixes such as co.uk and com.br keep three labels.
  if (p.length >= 3 && p[p.length - 1].length === 2 && ["co", "com", "org", "net", "gov", "ac", "edu"].includes(p[p.length - 2])) return p.slice(-3).join(".");
  return p.slice(-2).join(".");
};
export const isPlaceholderDomain = (d: string) => { const r = registrable(d); return PLACEHOLDER_DOMAINS.includes(r) || PLACEHOLDER_DOMAINS.includes(d.toLowerCase()); };
export const isFreeWebmail = (d: string) => FREE_WEBMAIL.includes(d.toLowerCase());

/** Damerau-Levenshtein distance (adjacent swaps count as one edit), enough for typos like gmial.com. Three rolling rows, so it allocates once. */
export function editDistance(a: string, b: string): number {
  const n = a.length, m = b.length;
  if (!n) return m;
  if (!m) return n;
  let p2 = new Array<number>(m + 1).fill(0), p1 = Array.from({ length: m + 1 }, (_, j) => j), cur = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const bj = b.charCodeAt(j - 1);
      let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + (ai === bj ? 0 : 1));
      if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bj) v = Math.min(v, p2[j - 2] + 1);
      cur[j] = v;
    }
    [p2, p1, cur] = [p1, cur, p2];
  }
  return p1[m];
}
/** A mistyped free-mail domain: one edit from a known one, and not itself on the list. */
export const isWebmailTypo = (d: string) => { const x = d.toLowerCase(); return !isFreeWebmail(x) && x.length >= 8 && FREE_WEBMAIL.some((w) => w.length >= 8 && editDistance(x, w) === 1); };

export type EmailKind = "ok" | "invalid" | "filler" | "placeholder" | "free_webmail" | "webmail_typo";
export function classifyEmail(raw: string): { email: string | null; kind: EmailKind } {
  const v = raw.trim().toLowerCase();
  if (!v) return { email: null, kind: "ok" };
  if (isFiller(v)) return { email: null, kind: "filler" };
  if (!EMAIL.test(v)) return { email: null, kind: "invalid" };
  const d = emailDomain(v);
  if (isPlaceholderDomain(d)) return { email: null, kind: "placeholder" };
  if (isFreeWebmail(d)) return { email: v, kind: "free_webmail" };
  if (isWebmailTypo(d)) return { email: v, kind: "webmail_typo" };
  return { email: v, kind: "ok" };
}

/** A local part that is a stand-in on a real domain. Flagged only: the design says such an address is never trusted and is verified in full. */
export const fakeLocalPart = (email: string) => /^(test|testing|asdf|xx+|x|tbd|na|n\/a|none|noemail|no-email|nomail|noreply|no-reply|registration|info|admin|hello|contact|sales|office|events?)$/i.test(email.split("@")[0]);

/* ----------------------------------------------------------------- websites */

/** The site's domain when the field holds a real website, or null for filler, placeholders and webmail. */
export function cleanWebsite(raw: string): { domain: string | null; filler: boolean } {
  const v = raw.trim();
  if (!v) return { domain: null, filler: false };
  if (isFiller(v) || /^(https?:\/\/)?(www\.?)?$/i.test(v) || /^\.?(com|net|org)$/i.test(v)) return { domain: null, filler: true };
  let host: string;
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).hostname.toLowerCase(); } catch { return { domain: null, filler: true }; }
  host = host.replace(/^www\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || !/[a-z]{2,}$/.test(host)) return { domain: null, filler: true };
  if (isPlaceholderDomain(host) || isFreeWebmail(host) || /(^|\.)(linkedin|facebook|instagram|twitter|x)\.com$/.test(host)) return { domain: null, filler: true };
  return { domain: host, filler: false };
}

/* ---------------------------------------------------------------- name rules */

/** Does a company name look like the domain label? "Flintbay Works" and flintbay.example. */
export function resemblesDomain(companyKey: string, domain: string) {
  const label = ascii(registrable(domain).split(".")[0]).toLowerCase().replace(/[^a-z0-9]/g, "");
  const flat = ascii(companyKey).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!label || !flat) return false;
  if (flat.startsWith(label) || label.startsWith(flat)) return true;
  const first = words(companyKey)[0] ?? "";
  return first.length >= 4 && label.startsWith(first.slice(0, Math.min(first.length, 6)));
}
/** Two company keys that plainly name one company: one is a prefix of the other, or one typo apart. */
export function relatedNames(a: string, b: string) {
  if (!a || !b) return false;
  if (a === b) return true;
  const fa = a.replace(/ /g, ""), fb = b.replace(/ /g, "");
  if (fa.startsWith(fb) || fb.startsWith(fa)) return true;
  const wa = a.split(" ")[0], wb = b.split(" ")[0];
  if (wa.length >= 4 && wa === wb) return true;
  return editDistance(fa, fb) <= Math.max(1, Math.floor(Math.min(fa.length, fb.length) / 6));
}

/** Names of one person, allowing for a typo, a swapped order, or a missing part. */
export function samePerson(a: string, b: string) {
  const x = nameSet(a), y = nameSet(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return editDistance(x, y) <= 2 && Math.min(x.length, y.length) >= 6;
}

/** Normalized similarity from 0 to 1 over two company keys. */
export const similarity = (a: string, b: string) => {
  const m = Math.max(a.length, b.length);
  return m ? 1 - editDistance(a, b) / m : 1;
};

/* ----------------------------------------------------------------- one row */

export interface RawRow {
  company: string; first: string; last: string; full: string; title: string; email: string; linkedin: string; website: string; badge: string;
}
export interface CleanRow {
  company: string; first: string; last: string; full: string; title: string; email: string | null; linkedin: string; website_domain: string | null;
  issues: string[];
  /** Set when the row says the person is not at a company. */
  not_a_company: boolean;
}

const stripFiller = (v: string, tag: string, issues: string[], name = false) => { if (v && (name ? isNameFiller(v) : isFiller(v))) { issues.push(tag); return ""; } return v; };

/** Cleans one row on its own. Cross-row checks (shared emails and domains, duplicates) happen in normalize. */
export function cleanRow(r: RawRow): CleanRow {
  const issues: string[] = [];
  let company = r.company.replace(/\s+/g, " ").trim();
  let title = r.title.replace(/\s+/g, " ").trim();
  let first = r.first.trim(), last = r.last.trim(), full = r.full.trim();

  company = stripFiller(company, "company_filler", issues);
  title = stripFiller(title, "title_filler", issues);
  first = stripFiller(first, "name_filler", issues, true); last = stripFiller(last, "name_filler", issues, true); full = stripFiller(full, "name_filler", issues, true);

  // Keyboard mashing, only when certain.
  if (company && isMash(company)) { company = ""; issues.push("company_mash"); }
  for (const [k, v] of [["first", first], ["last", last], ["full", full]] as const) {
    if (v && isMash(v)) { issues.push("name_mash"); if (k === "first") first = ""; else if (k === "last") last = ""; else full = ""; }
  }
  if (title && isMash(title)) { title = ""; issues.push("title_mash"); }

  // Fields in the wrong column. Value shapes only; move when certain, otherwise flag.
  let rawEmail = r.email.trim();
  if (!rawEmail && EMAIL.test(company)) { rawEmail = company; company = ""; issues.push("email_in_company"); }
  else if (!rawEmail && EMAIL.test(title)) { rawEmail = title; title = ""; issues.push("email_in_title"); }
  let linkedin = r.linkedin.trim();
  if (!linkedin && /linkedin\.com\//i.test(company)) { linkedin = company; company = ""; issues.push("linkedin_in_company"); }

  if (company && looksLikeTitle(company)) {
    if (!title) { title = company; company = ""; issues.push("swapped_company_title"); }
    else if (!looksLikeTitle(title)) { [company, title] = [title, company]; issues.push("swapped_company_title"); if (isMash(company) || isFiller(company)) company = ""; }
    else issues.push("company_looks_like_title");
  }

  // First and last name in each other's columns. The badge name is the person's own first name, so it settles the order.
  if (first && last && !full) {
    const f = nameSet(first), l = nameSet(last), b = nameSet(r.badge);
    if (b && b === l && b !== f) { [first, last] = [last, first]; issues.push("swapped_names_moved"); }
    else if (EMAIL.test(rawEmail) && !(b && b === f)) {
      const local = ascii(rawEmail.split("@")[0]).toLowerCase().replace(/[^a-z]/g, "");
      const F = ascii(first).toLowerCase().replace(/[^a-z]/g, ""), L = ascii(last).toLowerCase().replace(/[^a-z]/g, "");
      // The address starts with the last-name column and carries the first-name column: either last.first, or the columns are swapped.
      if (F && L && F !== L && (local.startsWith(L) && local.includes(F)) && !local.startsWith(F)) issues.push("name_order_suspect");
    }
  }

  const personName = full || `${first} ${last}`.trim();
  // The person's own name in the company field is no company.
  if (company && personName && personName.split(/\s+/).length >= 2 && nameSet(company) === nameSet(personName)) { company = ""; issues.push("person_name_as_company"); }

  const { email, kind } = classifyEmail(rawEmail);
  if (kind === "filler") issues.push("email_filler");
  else if (kind === "invalid" && rawEmail) issues.push("email_invalid");
  else if (kind === "placeholder") issues.push("placeholder_email");
  else if (kind === "free_webmail") issues.push("free_webmail");
  else if (kind === "webmail_typo") issues.push("webmail_typo");
  if (email && kind === "ok" && fakeLocalPart(email)) issues.push("fake_local_part");

  const site = cleanWebsite(r.website);
  if (site.filler) issues.push("website_filler");

  // Not a company: a configured name, or a person who says so (student, journalist, freelancer) at an institution, a newsroom or on a personal address.
  let notCompany = false;
  const personSays = OUTSIDE_TITLE.test(title);
  if (company) {
    const key = words(company).join(" ");
    const exact = NOT_A_COMPANY.has(key) || NOT_A_COMPANY.has(key.replace(/ /g, ""));
    const named = words(company).some((t) => INSTITUTION.has(t) || PRESS.has(t));
    notCompany = exact || (personSays && (named || kind === "free_webmail"));
  } else notCompany = personSays && kind === "free_webmail";
  if (notCompany) issues.push("not_a_company");

  return { company, first, last, full, title, email, linkedin, website_domain: site.domain, issues, not_a_company: notCompany };
}
