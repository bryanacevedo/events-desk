/* Writes the title-tier eval sets: evals/title-tier.dev.json now, and evals/title-tier.holdout.json (see HOLDOUT below).

   Every item is a job title with its labels: the function, the seniority and the title tier under the demo ICP (samples/orrery-icp.md), assigned BY
   HAND from the rule "a primary persona or an owner or top executive is tier 1; a secondary persona or anyone in sales, revenue operations, marketing,
   customer success or partnerships is tier 2; everything else, and any intern, student or assistant, is tier 3". The parser in src/shared/titles.ts was
   written before the holdout and tuned on the development set only. The holdout is frozen: its hash is pinned in a test. */

import { writeFileSync } from "node:fs";

type Fn = string; type Sen = string;
export interface Item { id: string; title: string; set: "dev" | "holdout"; language: "en" | "es" | "pt" | "fr" | "de"; kind: "clean" | "messy" | "inflated" | "ambiguous"; function: Fn; seniority: Sen; non_buyer: boolean; tier: 1 | 2 | 3 }

const make = (set: "dev" | "holdout") => {
  const items: Item[] = [];
  const add = (title: string, fn: Fn, sen: Sen, tier: 1 | 2 | 3, o: { lang?: Item["language"]; kind?: Item["kind"]; nb?: boolean } = {}) =>
    items.push({ id: `${set === "dev" ? "dev" : "hold"}_t${String(items.length + 1).padStart(3, "0")}`, title, set, language: o.lang ?? "en", kind: o.kind ?? "clean", function: fn, seniority: sen, non_buyer: o.nb ?? false, tier });
  return { items, add };
};

/* ------------------------------------------------------------ development */
{
  const { items, add } = make("dev");
  const m = { kind: "messy" as const }, nb = { nb: true }, es = { lang: "es" as const }, pt = { lang: "pt" as const }, fr = { lang: "fr" as const }, de = { lang: "de" as const };
  add("Chief Revenue Officer", "sales", "c_level", 1); add("VP Sales", "sales", "vp", 1); add("VP of Sales", "sales", "vp", 1); add("Vice President, Revenue", "sales", "vp", 1);
  add("Head of Revenue Operations", "revenue_operations", "vp", 1); add("Head of Sales", "sales", "vp", 1); add("SVP Sales", "sales", "vp", 1);
  add("Chief Executive Officer", "executive", "c_level", 1); add("Founder & CEO", "executive", "owner", 1); add("Co-Founder", "executive", "owner", 1);
  add("Managing Director", "executive", "c_level", 1); add("Owner", "executive", "owner", 1); add("President", "executive", "c_level", 1);
  add("Chief Financial Officer", "finance", "c_level", 1); add("Chief Operating Officer", "operations", "c_level", 1); add("Chief Marketing Officer", "marketing", "c_level", 1);
  add("VP Marketing", "marketing", "vp", 2); add("VP Customer Success", "customer_success", "vp", 2); add("VP Engineering", "engineering", "vp", 3); add("VP Finance", "finance", "vp", 3);
  add("Director of Sales", "sales", "director", 2); add("Sales Director", "sales", "director", 2); add("Sales Manager", "sales", "manager", 2); add("Regional Sales Manager", "sales", "manager", 2);
  add("Account Executive", "sales", "individual", 2); add("Senior Account Executive", "sales", "senior", 2); add("Sales Development Representative", "sales", "individual", 2); add("SDR", "sales", "individual", 2, m);
  add("Business Development Manager", "sales", "manager", 2); add("Marketing Manager", "marketing", "manager", 2); add("Director of Marketing", "marketing", "director", 2); add("Head of Marketing", "marketing", "vp", 2);
  add("Customer Success Manager", "customer_success", "manager", 2); add("Partnerships Manager", "partnerships", "manager", 2); add("Solutions Engineer", "sales", "individual", 2); add("Sales Engineer", "sales", "individual", 2);
  add("Revenue Operations Manager", "revenue_operations", "manager", 2); add("Sales Operations Analyst", "revenue_operations", "individual", 2); add("Demand Generation Manager", "marketing", "manager", 2);
  add("Channel Manager", "partnerships", "manager", 2); add("Key Account Manager", "sales", "manager", 2); add("Product Marketing Manager", "marketing", "manager", 2);
  add("Software Engineer", "engineering", "individual", 3); add("Senior Software Engineer", "engineering", "senior", 3); add("Accountant", "finance", "individual", 3); add("Controller", "finance", "manager", 3);
  add("HR Manager", "hr", "manager", 3); add("Recruiter", "hr", "individual", 3); add("Executive Assistant", "admin", "individual", 3, nb); add("Office Manager", "admin", "manager", 3);
  add("Paralegal", "legal", "individual", 3); add("Data Scientist", "engineering", "individual", 3); add("Operations Manager", "operations", "manager", 3); add("Warehouse Supervisor", "operations", "manager", 3);
  add("Graphic Designer", "design", "individual", 3); add("Customer Support Agent", "support", "individual", 3); add("Support Engineer", "support", "individual", 3);
  add("Marketing Intern", "marketing", "individual", 3, nb); add("Student", "other", "individual", 3, nb); add("Intern", "other", "individual", 3, nb);
  // Messy English
  add("vp, sales emea", "sales", "vp", 1, m); add("SR. DIRECTOR OF BUSINESS DEVELOPMENT", "sales", "director", 2, m); add("Head - Revenue Operations", "revenue_operations", "vp", 1, m);
  add("Chief Revenue Officer (CRO)", "sales", "c_level", 1, m); add("Sales Mgr", "sales", "manager", 2, m); add("VP Biz Dev", "sales", "vp", 1, m); add("Account Exec II", "sales", "individual", 2, m);
  add("Assistant to the VP of Sales", "admin", "individual", 3, { kind: "messy", nb: true }); add("Former VP Sales", "sales", "vp", 1, m); add("Co-founder and CRO", "sales", "owner", 1, m);
  add("Director, Customer Success - North America", "customer_success", "director", 2, m); add("CMO", "marketing", "c_level", 1, m); add("Dir. of Sales Ops", "revenue_operations", "director", 2, m);
  add("Growth Marketing Lead", "marketing", "senior", 2, m); add("Sales Team Lead", "sales", "senior", 2, m); add("sr. software engineer", "engineering", "senior", 3, m); add("DIRECTOR OF PARTNERSHIPS & ALLIANCES", "partnerships", "director", 2, m);
  // Inflated and ambiguous
  add("Growth Ninja", "sales", "individual", 2, { kind: "inflated" }); add("Revenue Wizard", "sales", "individual", 2, { kind: "inflated" }); add("Chief Happiness Officer", "hr", "c_level", 3, { kind: "inflated" });
  add("Partner", "executive", "owner", 1, { kind: "ambiguous" }); add("Chief Evangelist", "marketing", "c_level", 2, { kind: "inflated" });
  // Spanish and the other languages the world speaks
  add("Director General", "executive", "c_level", 1, es); add("Gerente General", "executive", "c_level", 1, es); add("Vicepresidente de Ventas", "sales", "vp", 1, es); add("Fundador y CEO", "executive", "owner", 1, es);
  add("Socio Director", "executive", "owner", 1, es); add("Presidente", "executive", "c_level", 1, es); add("Director Comercial", "sales", "director", 2, es); add("Gerente de Ventas", "sales", "manager", 2, es);
  add("Ejecutivo de Cuentas", "sales", "individual", 2, es); add("Representante de Ventas", "sales", "individual", 2, es); add("Jefa de Marketing", "marketing", "manager", 2, es); add("Gerente de Marketing", "marketing", "manager", 2, es);
  add("Responsable de Cuentas Clave", "sales", "manager", 2, es); add("Analista Financiero", "finance", "individual", 3, es); add("Ingeniera de Software", "engineering", "individual", 3, es);
  add("Asistente de Dirección", "admin", "individual", 3, { lang: "es", nb: true }); add("Directora de Recursos Humanos", "hr", "director", 3, es); add("Contador", "finance", "individual", 3, es);
  add("Jefe de Almacén", "operations", "manager", 3, es); add("Abogada Corporativa", "legal", "individual", 3, es); add("Director de Operaciones", "operations", "director", 3, es);
  add("Responsable de Alianzas", "partnerships", "manager", 2, es); add("Jefe de Ventas", "sales", "manager", 2, es); add("Diretor Comercial", "sales", "director", 2, pt); add("Gerente de Contas", "sales", "manager", 2, pt);
  add("Engenheiro de Software", "engineering", "individual", 3, pt); add("Diretor Executivo", "executive", "c_level", 1, pt); add("Directeur des Ventes", "sales", "director", 2, fr);
  add("Responsable Marketing", "marketing", "manager", 2, fr); add("Fondateur et PDG", "executive", "owner", 1, fr); add("Comptable", "finance", "individual", 3, fr); add("Geschäftsführer", "executive", "c_level", 1, de);
  add("Vertriebsleiter", "sales", "director", 2, de); add("Leiter Marketing", "marketing", "director", 2, de); add("Softwareentwickler", "engineering", "individual", 3, de);
  writeFileSync("evals/title-tier.dev.json", `${JSON.stringify({ note: "Development set. The title parser was tuned on this. Hand labels under samples/orrery-icp.md.", items }, null, 1)}\n`);
  console.log("dev", items.length);
}

/* ---------------------------------------------------------------- HOLDOUT
   Written after the parser was frozen and not used to tune it. Frozen: do not edit it to make a score better. A pinned hash in
   tests/title-tier-evals.test.ts fails if the file changes. Spanish, other-language, messy and inflated titles are included on purpose. */
{
  const { items, add } = make("holdout");
  const m = { kind: "messy" as const }, nb = { nb: true }, es = { lang: "es" as const }, pt = { lang: "pt" as const }, fr = { lang: "fr" as const }, de = { lang: "de" as const }, inf = { kind: "inflated" as const };
  add("Chief Commercial Officer", "sales", "c_level", 1); add("Chief Growth Officer", "sales", "c_level", 1); add("Chief Customer Officer", "customer_success", "c_level", 1);
  add("Chief Technology Officer", "engineering", "c_level", 1); add("Chief Product Officer", "product", "c_level", 1); add("General Manager", "executive", "c_level", 1);
  add("Executive Vice President of Sales", "sales", "vp", 1); add("Vice President of Revenue Operations", "revenue_operations", "vp", 1); add("VP, Business Development", "sales", "vp", 1);
  add("Head of Growth", "sales", "vp", 1); add("Managing Partner", "executive", "owner", 1); add("Founder", "executive", "owner", 1);
  add("VP of Human Resources", "hr", "vp", 3); add("VP Product", "product", "vp", 3); add("Senior Vice President, Customer Success", "customer_success", "vp", 2);
  add("Director of Revenue Operations", "revenue_operations", "director", 2); add("Senior Director of Sales", "sales", "director", 2); add("Commercial Director", "sales", "director", 2);
  add("Director of Partnerships", "partnerships", "director", 2); add("Partnership Lead", "partnerships", "senior", 2); add("Inside Sales Representative", "sales", "individual", 2);
  add("Enterprise Account Executive", "sales", "individual", 2); add("Customer Success Specialist", "customer_success", "individual", 2); add("Sales Enablement Manager", "sales", "manager", 2);
  add("Field Marketing Manager", "marketing", "manager", 2); add("Brand Manager", "marketing", "manager", 2); add("Content Marketing Specialist", "marketing", "individual", 2);
  add("Growth Marketer", "marketing", "individual", 2); add("Account Strategist", "sales", "individual", 2); add("Pre-Sales Consultant", "sales", "individual", 2);
  add("Senior Financial Analyst", "finance", "senior", 3); add("DevOps Engineer", "engineering", "individual", 3); add("QA Tester", "engineering", "individual", 3);
  add("Talent Acquisition Specialist", "hr", "individual", 3); add("Legal Counsel", "legal", "individual", 3); add("Procurement Manager", "operations", "manager", 3);
  add("Logistics Coordinator", "operations", "individual", 3); add("Facilities Manager", "operations", "manager", 3); add("Product Designer", "design", "individual", 3);
  add("UX Researcher", "design", "individual", 3); add("IT Administrator", "it_security", "individual", 3); add("Receptionist", "admin", "individual", 3, nb);
  add("Payroll Specialist", "finance", "individual", 3); add("Administrative Assistant", "admin", "individual", 3, nb); add("Sales Intern", "sales", "individual", 3, nb);
  add("Summer Intern", "other", "individual", 3, nb); add("PhD Candidate", "other", "individual", 3, nb); add("Freelance Writer", "other", "individual", 3, nb); add("Journalist", "other", "individual", 3, nb);
  // Messy English
  add("Sr. VP, Global Sales", "sales", "vp", 1, m); add("Vice-President Sales (EMEA)", "sales", "vp", 1, m); add("HEAD OF SALES - LATAM", "sales", "vp", 1, m);
  add("Dir Sales Ops & Enablement", "revenue_operations", "director", 2, m); add("Sales & Marketing Manager", "sales", "manager", 2, m); add("Mgr, Customer Success", "customer_success", "manager", 2, m);
  add("BDR", "sales", "individual", 2, m); add("Account Mgr II", "sales", "manager", 2, m); add("Chief Exec Officer", "executive", "c_level", 1, m); add("CEO / Founder", "executive", "owner", 1, m);
  add("Ex-CRO at Brightwater", "sales", "c_level", 1, m); add("Retired VP Sales", "sales", "vp", 3, { kind: "messy", nb: true }); add("Assistant to the CEO", "admin", "individual", 3, { kind: "messy", nb: true });
  add("Executive Assistant to the President", "admin", "individual", 3, { kind: "messy", nb: true }); add("Head of Sales and Marketing", "sales", "vp", 1, m); add("Technical Account Manager", "customer_success", "manager", 2, m);
  // Inflated and ambiguous
  add("Chief Vibes Officer", "other", "c_level", 3, inf); add("Dream Weaver & Head of Culture", "hr", "vp", 3, inf); add("Sales Rockstar", "sales", "individual", 2, inf);
  add("Customer Delight Hero", "customer_success", "individual", 2, inf); add("Chief Strategy Officer", "executive", "c_level", 1, { kind: "ambiguous" });
  // Spanish
  add("Director Ejecutivo", "executive", "c_level", 1, es); add("Directora General", "executive", "c_level", 1, es); add("Vicepresidenta de Ventas", "sales", "vp", 1, es);
  add("Gerente Comercial", "sales", "manager", 2, es); add("Directora Comercial", "sales", "director", 2, es); add("Jefe de Marketing Digital", "marketing", "manager", 2, es);
  add("Directora de Marketing", "marketing", "director", 2, es); add("Coordinadora de Ventas", "sales", "individual", 2, es); add("Ejecutiva de Cuentas", "sales", "individual", 2, es);
  add("Representante de Desarrollo de Negocios", "sales", "individual", 2, es); add("Gerente de Éxito del Cliente", "customer_success", "manager", 2, es);
  add("Responsable de Partnerships", "partnerships", "manager", 2, es); add("Gerente de Alianzas Estratégicas", "partnerships", "manager", 2, es); add("Director de Finanzas", "finance", "director", 3, es);
  add("Gerente de Recursos Humanos", "hr", "manager", 3, es); add("Ingeniero de Datos", "engineering", "individual", 3, es); add("Desarrollador Full Stack", "engineering", "individual", 3, es);
  add("Asistente Administrativa", "admin", "individual", 3, { lang: "es", nb: true }); add("Practicante de Ventas", "sales", "individual", 3, { lang: "es", nb: true }); add("Estudiante", "other", "individual", 3, { lang: "es", nb: true });
  add("Analista de Marketing", "marketing", "individual", 2, es); add("Subdirector Comercial", "sales", "director", 2, es); add("Socia Fundadora", "executive", "owner", 1, es);
  add("Dueño", "executive", "owner", 1, es); add("Jefe de Operaciones", "operations", "manager", 3, es);
  // Portuguese, French, German
  add("Diretora Comercial", "sales", "director", 2, pt); add("Gerente de Vendas", "sales", "manager", 2, pt); add("Vice-presidente de Vendas", "sales", "vp", 1, pt); add("Sócio-Fundador", "executive", "owner", 1, pt);
  add("Estagiário de Vendas", "sales", "individual", 3, { lang: "pt", nb: true }); add("Engenheira de Software", "engineering", "individual", 3, pt);
  add("Directeur Commercial", "sales", "director", 2, fr); add("Responsable Ventes", "sales", "manager", 2, fr); add("Directrice Marketing", "marketing", "director", 2, fr); add("Directeur Général", "executive", "c_level", 1, fr);
  add("Stagiaire Marketing", "marketing", "individual", 3, { lang: "fr", nb: true }); add("Responsable Ressources Humaines", "hr", "manager", 3, fr);
  add("Vertriebsleiterin", "sales", "director", 2, de); add("Leiter Vertrieb", "sales", "director", 2, de); add("Marketingleiter", "marketing", "director", 2, de); add("Geschäftsführerin", "executive", "c_level", 1, de);
  add("Werkstudent Vertrieb", "sales", "individual", 3, { lang: "de", nb: true }); add("Buchhalter", "finance", "individual", 3, de); add("Kundenberater", "sales", "individual", 2, de);
  writeFileSync("evals/title-tier.holdout.json", `${JSON.stringify({ note: "FROZEN HOLDOUT. Do not tune on it. Hand labels under samples/orrery-icp.md. The test pins this file's hash.", items }, null, 1)}\n`);
  console.log("holdout", items.length);
}
