/* Writes samples/world-titles.json: for every title in samples/world.json, its function and seniority, labeled by hand from the generator's own title
   lists (scripts/gen-world.ts). The world already says each title's TIER (the generator author's judgment of the real job); this adds what a parser
   should read: the function and the seniority. The simulated title model answers from this file, and tests/people-world.test.ts scores the code's
   parser against it. Labels were written without reading src/shared/titles.ts. Fails if any world title is not covered. */

import { readFileSync, writeFileSync } from "node:fs";

type L = [string, string, boolean?];
const ex = (fn: string, sen: string): [string, string] => [fn, sen];
const T: Record<string, [string, string] | [string, string, boolean]> = {
  // Top and revenue leadership
  "chief revenue officer": ex("sales", "c_level"), "cro": ex("sales", "c_level"), "vice president sales": ex("sales", "vp"), "vice president revenue": ex("sales", "vp"),
  "vice president revenue operations": ex("revenue_operations", "vp"), "head revenue operations": ex("revenue_operations", "vp"), "head sales": ex("sales", "vp"), "head growth": ex("sales", "vp"),
  "head revenue operations ": ex("revenue_operations", "vp"), "svp sales": ex("sales", "vp"), "senior vice president sales": ex("sales", "vp"), "chief commercial officer": ex("sales", "c_level"),
  "chief executive officer": ex("executive", "c_level"), "ceo": ex("executive", "c_level"), "founder & ceo": ex("executive", "owner"), "founder and ceo": ex("executive", "owner"), "cofounder": ex("executive", "owner"), "co-founder": ex("executive", "owner"),
  "founder": ex("executive", "owner"), "managing director": ex("executive", "c_level"), "owner": ex("executive", "owner"), "president": ex("executive", "c_level"), "general manager": ex("executive", "c_level"),
  "chief marketing officer": ex("marketing", "c_level"), "chief operating officer": ex("operations", "c_level"), "chief growth officer": ex("sales", "c_level"), "managing partner": ex("executive", "owner"),
  "chief financial officer": ex("finance", "c_level"), "vice president business development": ex("sales", "vp"), "vice president marketing": ex("marketing", "vp"), "vice president customer success": ex("customer_success", "vp"),
  "chief customer officer": ex("customer_success", "c_level"),
  // Go-to-market
  "account executive": ex("sales", "individual"), "sales development representative": ex("sales", "individual"), "business development representative": ex("sales", "individual"), "sales manager": ex("sales", "manager"),
  "regional sales manager": ex("sales", "manager"), "director sales": ex("sales", "director"), "sales director": ex("sales", "director"), "marketing manager": ex("marketing", "manager"), "director marketing": ex("marketing", "director"),
  "head marketing": ex("marketing", "vp"), "partnerships manager": ex("partnerships", "manager"), "customer success manager": ex("customer_success", "manager"), "solutions engineer": ex("sales", "individual"), "sales engineer": ex("sales", "individual"),
  "revenue operations manager": ex("revenue_operations", "manager"), "sales operations analyst": ex("revenue_operations", "individual"), "demand generation manager": ex("marketing", "manager"), "key account manager": ex("sales", "manager"),
  "channel manager": ex("partnerships", "manager"), "business development manager": ex("sales", "manager"), "growth marketing manager": ex("marketing", "manager"), "sales enablement manager": ex("sales", "manager"),
  "field marketing manager": ex("marketing", "manager"), "account manager": ex("sales", "manager"), "inside sales representative": ex("sales", "individual"), "commercial director": ex("sales", "director"), "regional director": ex("sales", "director"),
  "partnership lead": ex("partnerships", "senior"), "brand manager": ex("marketing", "manager"), "product marketing manager": ex("marketing", "manager"),
  // Everyone else
  "software engineer": ex("engineering", "individual"), "devops engineer": ex("engineering", "individual"), "qa engineer": ex("engineering", "individual"), "data engineer": ex("engineering", "individual"), "data scientist": ex("engineering", "individual"),
  "financial analyst": ex("finance", "individual"), "accountant": ex("finance", "individual"), "controller": ex("finance", "manager"), "hr manager": ex("hr", "manager"), "talent acquisition specialist": ex("hr", "individual"), "recruiter": ex("hr", "individual"),
  "office manager": ex("admin", "manager"), "executive assistant": ["admin", "individual", true], "administrative assistant": ["admin", "individual", true], "legal counsel": ex("legal", "individual"), "paralegal": ex("legal", "individual"),
  "procurement manager": ex("operations", "manager"), "supply chain analyst": ex("operations", "individual"), "warehouse supervisor": ex("operations", "manager"), "operations manager": ex("operations", "manager"), "logistics coordinator": ex("operations", "individual"),
  "it administrator": ex("it_security", "individual"), "security analyst": ex("it_security", "individual"), "product designer": ex("design", "individual"), "graphic designer": ex("design", "individual"), "ux researcher": ex("design", "individual"),
  "customer support agent": ex("support", "individual"), "support engineer": ex("support", "individual"), "compliance officer": ex("legal", "individual"), "project manager": ex("operations", "manager"), "production planner": ex("operations", "individual"),
  "quality manager": ex("operations", "manager"), "facilities manager": ex("operations", "manager"), "intern": ["other", "individual", true], "marketing intern": ["marketing", "individual", true], "receptionist": ["admin", "individual", true],
  "payroll specialist": ex("finance", "individual"), "research scientist": ex("engineering", "individual"), "mechanical engineer": ex("engineering", "individual"), "civil engineer": ex("engineering", "individual"),
  // Inflated and ambiguous
  "chief happiness officer": ex("hr", "c_level"), "growth ninja": ex("sales", "individual"), "sales rockstar": ex("sales", "individual"), "vice president everything": ex("other", "vp"), "global head strategic synergies": ex("other", "vp"),
  "chief evangelist": ex("marketing", "c_level"), "revenue wizard": ex("sales", "individual"), "dream weaver & head culture": ex("hr", "vp"), "director first impressions": ex("admin", "director"),
  "founder & chief everything officer": ex("executive", "owner"), "customer delight hero": ex("customer_success", "individual"), "chief vibes officer": ex("other", "c_level"), "principal disruptor": ex("other", "senior"),
  "partner": ex("executive", "owner"), "associate": ex("other", "individual"), "consultant": ex("other", "individual"), "manager": ex("other", "manager"), "executive": ex("other", "individual"), "lead": ex("other", "senior"),
  "specialist": ex("other", "individual"), "officer": ex("other", "individual"), "advisor": ex("other", "individual"), "analyst": ex("other", "individual"), "coordinator": ex("other", "individual"), "representative": ex("sales", "individual"),
  "principal": ex("other", "senior"), "director": ex("other", "director"),
  // Spanish, Portuguese, French, German
  "director general": ex("executive", "c_level"), "gerente general": ex("executive", "c_level"), "vicepresidente de ventas": ex("sales", "vp"), "fundador y ceo": ex("executive", "owner"), "socio director": ex("executive", "owner"),
  "presidente": ex("executive", "c_level"), "director ejecutivo": ex("executive", "c_level"), "director comercial": ex("sales", "director"), "gerente de ventas": ex("sales", "manager"), "ejecutivo de cuentas": ex("sales", "individual"),
  "representante de ventas": ex("sales", "individual"), "jefa de marketing": ex("marketing", "manager"), "responsable de cuentas clave": ex("sales", "manager"), "gerente de marketing": ex("marketing", "manager"),
  "directora de marketing": ex("marketing", "director"), "analista financiero": ex("finance", "individual"), "ingeniera de software": ex("engineering", "individual"), "asistente de dirección": ["admin", "individual", true],
  "coordinador de logística": ex("operations", "individual"), "directora de recursos humanos": ex("hr", "director"), "contador": ex("finance", "individual"), "jefe de almacén": ex("operations", "manager"),
  "asistente administrativa": ["admin", "individual", true], "técnico de soporte": ex("support", "individual"), "abogada corporativa": ex("legal", "individual"),
  "diretor executivo": ex("executive", "c_level"), "sócio-diretor": ex("executive", "owner"), "gerente geral": ex("executive", "c_level"), "diretor comercial": ex("sales", "director"), "gerente de contas": ex("sales", "manager"),
  "analista de vendas": ex("sales", "individual"), "engenheiro de software": ex("engineering", "individual"), "analista financeira": ex("finance", "individual"), "assistente administrativo": ["admin", "individual", true],
  "directrice générale": ex("executive", "c_level"), "président": ex("executive", "c_level"), "fondateur et pdg": ex("executive", "owner"), "directeur des ventes": ex("sales", "director"), "responsable marketing": ex("marketing", "manager"),
  "chargé de compte": ex("sales", "individual"), "ingénieur logiciel": ex("engineering", "individual"), "comptable": ex("finance", "individual"), "assistante de direction": ["admin", "individual", true],
  "geschäftsführer": ex("executive", "c_level"), "geschäftsführerin": ex("executive", "c_level"), "inhaber": ex("executive", "owner"), "vertriebsleiter": ex("sales", "director"), "leiter marketing": ex("marketing", "director"),
  "softwareentwickler": ex("engineering", "individual"), "buchhalterin": ex("finance", "individual"), "sachbearbeiter": ["admin", "individual", true],
  // Students, press, freelancers
  "phd candidate": ["other", "individual", true], "master's student": ["other", "individual", true], "student": ["other", "individual", true], "freelance writer": ["other", "individual", true], "journalist": ["other", "individual", true],
  "reporter": ["other", "individual", true], "editor": ["other", "individual", true], "freelance designer": ["other", "individual", true], "independent consultant": ["other", "individual", true],
};

const canon = (s: string) => s.toLowerCase().replace(/[.,]/g, " ").replace(/\bvp\b/g, "vice president").replace(/\bof\b/g, " ").replace(/\s+/g, " ").trim();
const table = new Map(Object.entries(T).map(([k, v]) => [canon(k), v] as const));
const world = JSON.parse(readFileSync("samples/world.json", "utf8")) as { titles: Record<string, number> };
const out: Record<string, { function: string; seniority: string; non_buyer: boolean }> = {};
const missing: string[] = [];
for (const title of Object.keys(world.titles)) {
  let c = canon(title), prefix: "senior" | "junior" | null = null;
  const m = c.match(/^(senior|sr|junior|jr) (.*)$/);
  if (m) { prefix = m[1] === "senior" || m[1] === "sr" ? "senior" : "junior"; c = m[2]; }
  const base = table.get(c);
  if (!base) { missing.push(title); continue; }
  let [fn, sen, nb] = base as [string, string, boolean?];
  if (prefix === "senior" && sen === "individual") sen = "senior";
  if (prefix === "junior" && (sen === "individual" || sen === "senior")) sen = "individual";
  out[title] = { function: fn, seniority: sen, non_buyer: nb === true };
}
if (missing.length) { console.error("Not labeled:", missing); process.exit(1); }
writeFileSync("samples/world-titles.json", `${JSON.stringify(out, null, 1)}\n`);
console.log(Object.keys(out).length, "titles labeled");
