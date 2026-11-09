/* Job titles, in code (docs/TIERING-AND-ENRICHMENT.md, "Layer 4"):

   - `parseTitle` reads a title into a function and a seniority with rules: English, Spanish, Portuguese, French and German, abbreviations, region
     tails, ranks like "Sr." and "Jr.". A title the rules cannot place (a bare "Manager", an inflated "Chief Happiness Officer", words nobody listed)
     comes back `placed: false`, and only then does a model read it (prompt `title_parse`);
   - `personaTier` turns a parsed title into a title tier 1, 2 or 3 from the pinned ICP's personas;
   - `adjustTier` applies the ICP's title adjustments by company type and size;
   - `rankPeople` chooses who to keep within a quota: persona match, region, variety across functions, then freshness and whether the vendor says
     an email exists.

   Everything here is pure: no database, no model, no network. A rule is a claim about words, and the evals (src/evals/title-tier.ts) measure it. */

import { SENIORITIES, type Icp, type Persona, type Seniority, type TitleAdjustment } from "./icp.ts";
import type { Tier } from "./cost.ts";

export const FUNCTIONS = ["executive", "sales", "revenue_operations", "marketing", "customer_success", "partnerships", "finance", "engineering", "product", "design", "operations", "hr", "legal", "it_security", "support", "admin", "other"] as const;
export type Fn = (typeof FUNCTIONS)[number];
/** The functions a sales team sells through. A person in one of these is at least tier 2. */
export const GTM: readonly Fn[] = ["sales", "revenue_operations", "marketing", "customer_success", "partnerships"];

export interface ParsedTitle {
  function: Fn | null;
  seniority: Seniority | null;
  /** Intern, student, assistant, press, freelancer: nobody to sell to, whatever the function. */
  non_buyer: boolean;
  /** "Former", "ex-", "retired": the title may no longer be true. The review step reads this; the tier does not change. */
  former: boolean;
  /** Both a function and a seniority were found, so no model is needed. */
  placed: boolean;
  /** Set only by `parseTitle`: the rules read this title. A title built from a model's answer, or from a stored one, lacks it. */
  read_by_rules?: boolean;
}

/* --------------------------------------------------------------- normalizing */

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/ø/g, "o").replace(/ł/g, "l");
const ABBR: [RegExp, string][] = [
  [/\bsr\b\.?/g, "senior"], [/\bjr\b\.?/g, "junior"], [/\bsvp\b/g, "senior vice president"], [/\bevp\b/g, "executive vice president"], [/\bvp\b/g, "vice president"],
  [/\bdir\b\.?/g, "director"], [/\bmgr\b\.?/g, "manager"], [/\bmgmt\b/g, "management"], [/\bbiz dev\b/g, "business development"], [/\bbizdev\b/g, "business development"],
  [/\bsdr\b/g, "sales development representative"], [/\bbdr\b/g, "business development representative"], [/\bae\b/g, "account executive"],
  [/\bcsm\b/g, "customer success manager"], [/\brevops\b/g, "revenue operations"], [/\brev ops\b/g, "revenue operations"], [/\bexec\b\.?/g, "executive"],
  [/\bgm\b/g, "general manager"], [/\bmd\b/g, "managing director"], [/\bcmo\b/g, "chief marketing officer"], [/\bcro\b/g, "chief revenue officer"],
  [/\bcco\b/g, "chief commercial officer"], [/\bcgo\b/g, "chief growth officer"], [/\bcfo\b/g, "chief financial officer"], [/\bcoo\b/g, "chief operating officer"],
  [/\bcto\b/g, "chief technology officer"], [/\bcio\b/g, "chief information officer"], [/\bceo\b/g, "chief executive officer"], [/\bchro\b/g, "chief people officer"],
  [/\bpdg\b/g, "chief executive officer"], [/\bco-?founder\b/g, "cofounder"], [/\bcpo\b/g, "chief product officer"],
  [/\brrhh\b/g, "recursos humanos"],
];
/** Lowercase, accents folded, abbreviations spelled out, region tails and brackets dropped. */
export function normalizeTitle(raw: string, keepTail = false): string {
  let t = fold(raw).toLowerCase().replace(/&/g, " and ").replace(/[|/]/g, " , ");
  // A region or territory tail says where, not what: "VP Sales, EMEA", "Head of Sales - Latam", "Director (Iberia)".
  t = t.replace(/\(([^)]*)\)/g, (_, inner) => (/^(cro|ceo|cmo|cfo|coo|cco|cgo|vp|svp|evp)$/.test(inner.trim()) ? "" : ` ${inner} `));
  if (!keepTail) t = t.replace(/[,\-–—:]+\s*(emea|latam|apac|amer|americas|iberia|dach|nordics|benelux|global|international|worldwide|north america|europe|asia|spain|mexico|us|usa|uk|brazil|region|regional|emea\/\w+)\b.*$/i, " ");
  t = t.replace(/\b(emea|latam|apac|dach|nordics|benelux)\b/g, " ");
  for (const [re, to] of ABBR) t = t.replace(re, to);
  return t.replace(/[.,;:()\[\]"']/g, " ").replace(/\s+-\s+|\s*-\s*(?=\s)/g, " ").replace(/\s+/g, " ").trim();
}

/* --------------------------------------------------------------- seniority */

const has = (t: string, re: RegExp) => re.test(t);

function seniorityOf(t: string): Seniority | null {
  // Vice presidents before presidents.
  if (has(t, /\b(vice president|vicepresident|vicepresidente|vicepresidenta|vice-president|vizeprasident(in)?|vice presidente|vice presidenta|vicepresidencia)\b/)) return "vp";
  // An owner who is also a chief executive is an owner ("Founder & CEO").
  if (has(t, /\b(founder|cofounder|fundador|fundadora|cofundador|fondateur|fondatrice|grunder(in)?|owner|propietari[oa]|dueno|duena|inhaber(in)?|socio|socia|associe|managing partner|general partner|partner)\b/) && !has(t, /\b(partnerships?|partner manager|partner success|channel partner)\b/)) return "owner";
  if (has(t, /\b(chief)\b.*\bofficer\b|\bpresident\b|\bpresidente\b|\bpresidenta\b|\bgeschaftsfuhrer(in)?\b|\bdirector general\b|\bdirectora general\b|\bdirecteur general\b|\bdirectrice generale\b|\bgerente general\b|\bgerente geral\b|\bgeneral manager\b|\bmanaging director\b|\bdirector ejecutivo\b|\bdirectora ejecutiva\b|\bdiretor executivo\b|\bdiretora executiva\b|\bvorstand\b/)) return "c_level";
  if (has(t, /\b(head of|head|global head)\b/)) return "vp";
  if (has(t, /\b(director|directora|directeur|directrice|diretor|diretora|direktor(in)?|dirigente)\b|leiter(in)?\b|leitung\b/)) return "director";
  if (has(t, /\b(manager|gerente|jefe|jefa|chefe|responsable|responsavel|verantwortliche[rn]?|controller|lead|team lead|supervisor|supervisora|encargad[oa]|coordinador|coordinadora)\b/)) return has(t, /\b(lead|team lead)\b/) && !has(t, /\bmanager\b/) ? "senior" : "manager";
  if (has(t, /\b(senior|principal|staff)\b/)) return "senior";
  return null;
}

/* ---------------------------------------------------------------- function */

// Order matters: the more specific phrase first.
const FUNCTION_RULES: [Fn, RegExp][] = [
  ["revenue_operations", /\b(revenue operations|sales operations|sales ops|revenue ops|operaciones comerciales|operaciones de ventas|operacoes de vendas|operations commerciales)\b/],
  ["customer_success", /\b(customer success|exito del cliente|exito de clientes|sucesso do cliente|succes client|kundenerfolg|customer experience|customer delight|customer onboarding|client success)\b/],
  ["support", /\b(customer support|support engineer|technical support|help desk|helpdesk|service desk|soporte|suporte|support client|kundenservice|kundendienst|support agent|tecnico de soporte)\b/],
  ["marketing", /\b(marketing|mercadeo|mercadotecnia|mercadologia|brand|demand generation|demand gen|growth marketing|field marketing|product marketing|communications?|comunicacion|communication|content|seo|publicidad|werbung|relations publiques|public relations|pr manager|evangelist)\b/],
  ["partnerships", /\b(partnerships?|alliances?|alianzas?|aliancas?|alliances?|channel|channels|canal|canales|ecosystem|partner manager|partner success)\b/],
  ["sales", /\b(sales|ventas|vendas|vente|ventes|vertrieb\w*|verkauf\w*|commercial|comercial|kommerziell|account executive|account manager|account strategist|key account|cuentas|contas|compte|comptes|business development|desarrollo de negocio|desenvolvimento de negocios|developpement commercial|representante de ventas|sales representative|sales rep|sdr|bdr|solutions engineer|solution engineer|sales engineer|pre-?sales|preventa|inside sales|revenue|growth|account director|ejecutivo de cuentas|ejecutivo comercial|kundenberater|vertriebsmitarbeiter|rockstar|ninja|wizard)\b/],
  ["finance", /\b(financ\w*|accountant|accounting|accounts? payable|accounts? receivable|contador\w*|contab\w*|contable|comptable|buchhalter\w*|controller|controlling|treasur\w*|tesor\w*|payroll|nomina|fp&a|auditor\w*|tax)\b/],
  ["hr", /\b(human resources|recursos humanos|recursos humanos|ressources humaines|personalabteilung|personal|recruit\w*|talent|people operations|people and culture|culture|hr|reclutamiento|seleccion de personal)\b/],
  ["legal", /\b(legal|counsel|paralegal|abogad\w*|advogad\w*|avocat\w*|juridic\w*|juridique|rechtsanwalt\w*|lawyer|attorney|compliance|cumplimiento|conformite|general counsel)\b/],
  ["design", /\b(designer|design|diseno|diseñ\w*|disenador\w*|ux|ui|user experience|grafik\w*|graphic)\b/],
  ["product", /\b(product manager|product owner|product management|producto|produit|produktmanager)\b/],
  ["it_security", /\b(it administrator|it admin|system administrator|sysadmin|security analyst|information security|ciberseguridad|cybersecurity|ciso|infosec|it manager|network administrator|help desk|informatica)\b/],
  ["engineering", /\b(engineer\w*|ingenier\w*|engenheir\w*|ingenieur\w*|software\w*|developer|desarrollador\w*|desenvolvedor\w*|entwickler\w*|programmer|devops|qa|data scientist|data engineer|data analyst|analista de datos|architect|arquitect\w*|technology|tecnologia|technologie|technologie|technical|tecnico|technician|tecnico|scientist|cientifico|researcher|research|investigador\w*|mechanical|civil|chemical|electrical)\b/],
  ["operations", /\b(operations?|operaciones|operacoes|logistic\w*|warehouse|almacen|armazem|supply chain|cadena de suministro|procurement|compras|purchasing|facilities|production|produccion|producao|planner|planificacion|quality|calidad|qualite|project manager|project management|gestor de proyectos|fleet|transport\w*|despacho)\b/],
  ["admin", /\b(assistant|asistente|assistente|assistante|assistent|receptionist|recepcionista|secretar\w*|office manager|administrative|administrativ\w*|administrativo|administrativa|clerk|sachbearbeiter\w*|auxiliar|empleado de oficina|bureau)\b/],
  ["executive", /\b(chief executive officer|president|presidente|general manager|managing director|director general|directora general|directeur general|directrice generale|gerente general|gerente geral|geschaftsfuhrer\w*|director ejecutivo|directora ejecutiva|diretor executivo|diretora executiva|founder|cofounder|fundador\w*|cofundador\w*|fondateur\w*|owner|propietari\w*|dueno|inhaber\w*|socio|socia|socio\w* director\w*|managing partner|general partner|partner|executive director)\b/],
];

/** The function a "Chief X Officer" leads, by X. A chief officer of something nobody listed is unplaced: the model reads it. */
function chiefFunction(t: string): Fn | null | undefined {
  const m = t.match(/\bchief\s+([a-z ]+?)\s+officer\b/);
  if (!m) return undefined;
  const x = m[1];
  if (/^executive$/.test(x)) return "executive";
  if (/revenue|commercial|growth|sales|business|customer|client/.test(x)) return /customer|client/.test(x) ? "customer_success" : "sales";
  if (/marketing|brand|communications?/.test(x)) return "marketing";
  if (/financial|finance/.test(x)) return "finance";
  if (/operating|operations/.test(x)) return "operations";
  if (/technology|information|digital|data|product|security/.test(x)) return /product/.test(x) ? "product" : "engineering";
  if (/people|human|talent/.test(x)) return "hr";
  if (/legal|compliance|risk/.test(x)) return "legal";
  return null;
}

const NON_BUYER = /\b(intern|internship|trainee|apprentice|becari[oa]|practicante|pasante|estagiari[oa]|stagiaire|praktikant\w*|werkstudent|student|estudiante|estudante|etudiant\w*|studentin|phd candidate|master's student|masters student|freelance\w*|independent|autonomo|autónomo|journalist\w*|periodista|jornalista|reporter|editor|writer|self-employed|unemployed|retired|jubilad[oa]|aposentad[oa])\b/;
const ASSISTANT = /\b(assistant|asistente|assistente|assistante|assistent|secretar\w*|receptionist|recepcionista|auxiliar)\b/;
const FORMER = /\b(former|ex|ex-|past|previously|retired|antiguo|antigua|antes|ancien|ancienne|ehemalig\w*)\b/;

/** Reads a title into function and seniority with rules. Anything the rules cannot place is `placed: false`. */
export function parseTitle(raw: string): ParsedTitle {
  const t = normalizeTitle(raw);
  if (!t) return { function: null, seniority: null, non_buyer: false, former: false, placed: false };
  const former = has(t, /^(former|ex|ex-|past|previously)\b|\bformer\b|\bex-/) || /^ex\s/.test(t);
  // "Executive assistant to the CEO" is an assistant, not an executive.
  const assistant = has(t, ASSISTANT);
  const nonBuyer = has(t, NON_BUYER) || assistant;
  const chief = chiefFunction(t);
  const chiefOfNothing = chief === null;
  let fn: Fn | null = null;
  if (chief !== undefined) fn = chief;
  else {
    // An assistant's function is admin whatever follows ("assistant to the VP of Sales").
    if (assistant) fn = "admin";
    else for (const [f, re] of FUNCTION_RULES) if (re.test(t)) { fn = f; break; }
  }
  let sen = seniorityOf(t);
  // "Executive" means the whole company, which only an owner or a chief holds. A vice president or director whose function words sat in a region tail we dropped
  // ("Sr. VP, Global Sales") is read again with the tail kept; a bare "Vice President" has no function, so it is left for the model.
  if (chief === undefined && !assistant && (fn === null || (fn === "executive" && sen !== "owner" && sen !== "c_level"))) {
    const full = normalizeTitle(raw, true);
    let again: Fn | null = null;
    for (const [f, re] of FUNCTION_RULES) if (f !== "executive" && re.test(full)) { again = f; break; }
    fn = again ?? (fn === "executive" ? null : fn);
  }
  if (nonBuyer) sen = sen === "owner" && !has(t, /\b(founder|cofounder)\b/) ? "individual" : "individual";
  // "Founder" or "owner" with a function ("Founder & CEO") is an owner of the company.
  if (!sen && fn) sen = "individual";
  // Bare seniority words carry no function ("Manager", "Director", "Lead") and stay unplaced for the model, except company-level ranks.
  if (!fn && sen && (sen === "owner" || sen === "c_level") && !chiefOfNothing) fn = "executive";
  if (nonBuyer && !fn) fn = "other";
  // A title of only filler words, or a "Chief ... Officer" of nothing listed, is unplaced.
  const placed = fn !== null && sen !== null;
  return { function: fn, seniority: sen, non_buyer: nonBuyer, former, placed, read_by_rules: true };
}

/* ------------------------------------------------------- persona tiers */

const rank = (s: Seniority) => SENIORITIES.indexOf(s);
// SENIORITIES is ordered owner, c_level, vp, director, manager, senior, individual: lower index is more senior.
const within = (s: Seniority, p: Persona) => {
  const lo = Math.min(rank(p.seniority_min), rank(p.seniority_max)), hi = Math.max(rank(p.seniority_min), rank(p.seniority_max));
  return rank(s) >= lo && rank(s) <= hi;
};

/** The functions a persona covers: the function words it names, plus the function of every title it lists. A persona is written in the seller's words, so this reads them. */
export function personaFunctions(p: Persona): Set<Fn> {
  const out = new Set<Fn>();
  const text = normalizeTitle(p.function);
  if (/revenue|sales|commercial|growth|business development/.test(text)) { out.add("sales"); out.add("revenue_operations"); }
  if (/marketing/.test(text)) out.add("marketing");
  if (/customer success|success/.test(text)) out.add("customer_success");
  if (/partner|alliance|channel/.test(text)) out.add("partnerships");
  if (/finance/.test(text)) out.add("finance");
  if (/operations/.test(text) && !/revenue|sales/.test(text)) out.add("operations");
  for (const title of p.titles) { const f = parseTitle(title).function; if (f) out.add(f); }
  return out;
}

/** Every function some persona (for this segment, or any segment) covers. */
function buyerFunctions(personas: Persona[], segment?: string | null): Set<Fn> {
  const out = new Set<Fn>();
  for (const per of personas) if (per.segment === "*" || !segment || per.segment === segment) for (const f of personaFunctions(per)) out.add(f);
  return out;
}

export interface PersonaMatch { persona: Persona | null; priority: "primary" | "secondary" | null }
/** The best persona a title matches: a primary before a secondary. A persona for another segment is ignored when `segment` is given. */
export function matchPersona(p: ParsedTitle, personas: Persona[], segment?: string | null): PersonaMatch {
  if (!p.function || !p.seniority) return { persona: null, priority: null };
  let best: Persona | null = null;
  for (const per of personas) {
    if (per.segment !== "*" && segment && per.segment !== segment) continue;
    if (!personaFunctions(per).has(p.function) || !within(p.seniority, per)) continue;
    if (!best || (per.priority === "primary" && best.priority !== "primary")) best = per;
  }
  return { persona: best, priority: best?.priority ?? null };
}

/** Title tier before company adjustments, from the pinned ICP. Null means the rules could not place the title (the model reads it).
    1: a primary persona, an owner, a chief officer the rules read, or a chief officer the model read whose function a persona covers. 2: a secondary persona, or anyone in a go-to-market function.
    3: outside go-to-market, or an intern, student, assistant or press. */
export function personaTier(p: ParsedTitle, personas: Persona[], segment?: string | null): Tier | null {
  if (p.non_buyer) return 3;
  if (!p.placed) return null;
  const m = matchPersona(p, personas, segment);
  if (m.priority === "primary") return 1;
  // Rank alone is not a buyer. An owner owns the company whatever the title says. A chief officer the rules read ("Chief Financial Officer") has company-wide authority.
  // A chief officer only the model could read is an unlisted or inflated title ("Chief Vibes Officer" comes back as hr, c_level): its rank says nothing about
  // a job, so it is tier 1 only if the ICP's personas cover the function it was read as, or it is the whole company ("executive"). docs/DECISIONS.md, 25.
  if (p.seniority === "owner") return 1;
  if (p.seniority === "c_level" && (p.read_by_rules || p.function === "executive" || (p.function && buyerFunctions(personas, segment).has(p.function)))) return 1;
  if (m.priority === "secondary") return 2;
  if (p.function && (GTM as readonly string[]).includes(p.function)) return 2;
  return 3;
}

/* ---------------------------------------------------------- adjustments */

/** The seniority an adjustment's words are about: "A VP at a bank ..." is about vice presidents, "A founder at a company under 50 ..." about owners. */
function adjustmentSeniority(a: TitleAdjustment): Seniority | null {
  const t = normalizeTitle(a.text);
  if (/\b(founder|owner|cofounder)\b/.test(t)) return "owner";
  if (/\bvice president\b/.test(t)) return "vp";
  if (/\bdirector\b/.test(t)) return "director";
  if (/\bmanager\b/.test(t)) return "manager";
  return null;
}
const BANDS = (n: number) => (n < 50 ? "under 50" : n < 200 ? "50 to 199" : n < 1000 ? "200 to 999" : n < 5000 ? "1000 to 4999" : "5000 and over");
export const sizeBandOf = BANDS;

/** Applies the ICP's title adjustments for this company type and size. A positive delta raises the tier by one (towards 1), a negative lowers it. An adjustment applies only to the seniority its words name. */
export function adjustTier(tier: Tier, p: ParsedTitle, icp: Pick<Icp, "title_adjustments">, company: { company_type: string | null; employees: number | null }): Tier {
  let t: number = tier;
  for (const a of icp.title_adjustments) {
    const sen = adjustmentSeniority(a);
    if (!sen || p.seniority !== sen) continue;
    if (a.company_type !== "any" && a.company_type !== company.company_type) continue;
    if (a.size_band && (company.employees === null || BANDS(company.employees) !== a.size_band)) continue;
    t -= a.delta;
  }
  return Math.min(3, Math.max(1, t)) as Tier;
}

/* -------------------------------------------------------------- ranking */

export interface Candidate {
  id: string;
  tier: Tier;
  function: Fn | null;
  persona_priority: "primary" | "secondary" | null;
  country?: string | null;
  updated_at?: string | null;
  has_email?: boolean | null;
}
export interface RankOptions { country?: string | null; today: string; freshness_days: number }

const days = (from: string, to: string) => Math.floor((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Best first. Persona match, then title tier, then region relevance, then freshness (a record older than the limit ranks lower; a date is not proof of employment), then a vendor-reported email. */
export function rankKey(c: Candidate, o: RankOptions): number[] {
  const age = c.updated_at ? days(c.updated_at, o.today) : Infinity;
  return [
    c.persona_priority === "primary" ? 0 : c.persona_priority === "secondary" ? 1 : 2,
    c.tier,
    o.country && c.country ? (c.country.toLowerCase() === o.country.toLowerCase() ? 0 : 1) : 0,
    age > o.freshness_days ? 1 : 0,
    c.has_email === true ? 0 : c.has_email === false ? 2 : 1,
    Number.isFinite(age) ? age : 1e9,
  ];
}
const cmp = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

/** Keeps up to `quota` candidates. Variety across functions comes second only to the ranking: the best of each function is taken in rank order first, then the rest fill the quota. Ties break on id so a run repeats. */
export function rankPeople(cands: Candidate[], quota: number, o: RankOptions): Candidate[] {
  const sorted = [...cands].sort((a, b) => cmp(rankKey(a, o), rankKey(b, o)) || a.id.localeCompare(b.id));
  const picked: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of sorted) { const f = c.function ?? "other"; if (picked.length < quota && !seen.has(f)) { picked.push(c); seen.add(f); } }
  for (const c of sorted) if (picked.length < quota && !picked.includes(c)) picked.push(c);
  return picked.sort((a, b) => cmp(rankKey(a, o), rankKey(b, o)) || a.id.localeCompare(b.id));
}

/* ------------------------------------------------------ model answers */

/** What the title_parse prompt returns. Closed lists; anything else is unreadable and retried once. */
export function validTitleParse(v: unknown): { function: Fn; seniority: Seniority; non_buyer: boolean } | null {
  const x = v as { function?: unknown; seniority?: unknown; non_buyer?: unknown } | null;
  if (!x || typeof x !== "object") return null;
  if (!(FUNCTIONS as readonly unknown[]).includes(x.function) || !(SENIORITIES as readonly unknown[]).includes(x.seniority)) return null;
  return { function: x.function as Fn, seniority: x.seniority as Seniority, non_buyer: x.non_buyer === true };
}
